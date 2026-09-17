/**
 * @fileoverview Unit tests for SkipProxyAgent bug fixes:
 *
 * 1. 'Error'-role conversation rows are failure records, never conversation content —
 *    they must not reach Skip (they used to be sent as user messages, corrupting the
 *    transcript on retries and shifting the last-user-message truncation boundary).
 * 2. A run chained after a prior run whose FinalStep was 'Chat' (the sole path is
 *    handleClarifyingQuestion) carries the user's answer to a clarifying question and
 *    must be sent as requestPhase 'clarify_question_response'.
 * 3. SkipAgentContext.conversationId is honored as a fallback when the framework
 *    didn't inject params.data.conversationId.
 * 4. conversationId is validated as a UUID before being interpolated into ExtraFilter.
 * 5. handleAnalysisComplete never surfaces hiddenToUser messages.
 * 6. Component option selection picks the best AIRank (lower is better), not blindly
 *    index 0.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SkipAPIAnalysisCompleteResponse, SkipMessage } from '@askskip/types';
import type { UserInfo } from '@memberjunction/core';
import type { ComponentOption, ComponentSpec } from '@memberjunction/interactive-component-types';

// ── Mocks ───────────────────────────────────────────────────────────────────

const { runViewMock } = vi.hoisted(() => ({ runViewMock: vi.fn() }));

vi.mock('@memberjunction/ai-agents', () => ({
    BaseAgent: class MockBaseAgent {},
}));

vi.mock('@memberjunction/global', async (importOriginal) => ({
    RegisterClass: () => (target: unknown) => target,
    IsValidUUID: (await importOriginal<typeof import('@memberjunction/global')>()).IsValidUUID,
}));

vi.mock('@memberjunction/core', () => ({
    LogStatus: vi.fn(),
    LogError: vi.fn(),
    RunView: class {
        RunView = runViewMock;
    },
    UserInfo: class {},
}));

vi.mock('@memberjunction/data-context', () => ({ DataContext: class {} }));

import { SkipProxyAgent } from '../../src/skip-agent.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const CONVERSATION_ID = '11111111-2222-3333-4444-555555555555';
const CONTEXT_CONVERSATION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LAST_RUN_ID = '99999999-8888-7777-6666-555555555555';
const USER = { ID: 'u-1' } as unknown as UserInfo;

interface DetailRow {
    ID: string;
    Role: 'AI' | 'Error' | 'User';
    Message: string;
    HiddenToUser: boolean;
    UserRating: number | null;
    UserFeedback: string | null;
    ReflectionInsights: string | null;
    SummaryOfEarlierConversation: string | null;
    __mj_CreatedAt: Date;
    __mj_UpdatedAt: Date;
}

function detailRow(id: string, role: DetailRow['Role'], message: string): DetailRow {
    return {
        ID: id,
        Role: role,
        Message: message,
        HiddenToUser: false,
        UserRating: null,
        UserFeedback: null,
        ReflectionInsights: null,
        SummaryOfEarlierConversation: null,
        __mj_CreatedAt: new Date('2026-01-01T00:00:00Z'),
        __mj_UpdatedAt: new Date('2026-01-01T00:00:00Z'),
    };
}

type PrivateAgent = {
    loadMessagesFromDatabase(conversationId: string, contextUser: UserInfo): Promise<SkipMessage[]>;
    resolveRequestPhase(lastRunId: string | null | undefined, contextUser: UserInfo): Promise<string>;
    handleAnalysisComplete(response: SkipAPIAnalysisCompleteResponse): {
        step: string;
        message?: string;
        newPayload?: ComponentSpec;
    };
};

function agent(): PrivateAgent {
    return new SkipProxyAgent() as unknown as PrivateAgent;
}

function spec(name: string): ComponentSpec {
    return { name } as unknown as ComponentSpec;
}

function option(name: string, rank: number | undefined): ComponentOption {
    return {
        option: spec(name),
        AIRank: rank,
        AIRankExplanation: undefined,
        UserRank: undefined,
        UserRankExplanation: undefined,
    };
}

function analysisResponse(overrides: Partial<SkipAPIAnalysisCompleteResponse>): SkipAPIAnalysisCompleteResponse {
    return {
        success: true,
        responsePhase: 'analysis_complete',
        messages: [],
        ...overrides,
    } as SkipAPIAnalysisCompleteResponse;
}

beforeEach(() => {
    runViewMock.mockReset();
});

// ── Fix 1 + 4: message loading ──────────────────────────────────────────────

describe('loadMessagesFromDatabase', () => {
    it('excludes Error-role rows entirely', async () => {
        runViewMock.mockResolvedValue({
            Success: true,
            Results: [
                detailRow('cd-1', 'User', 'build me a report'),
                detailRow('cd-2', 'AI', 'here is the report'),
                detailRow('cd-3', 'Error', 'Pipeline failed at step X'),
                detailRow('cd-4', 'User', 'try again'),
            ],
        });

        const messages = await agent().loadMessagesFromDatabase(CONVERSATION_ID, USER);

        expect(messages.map(m => m.role)).toEqual(['user', 'system', 'user']);
        expect(messages.some(m => m.content.includes('Pipeline failed'))).toBe(false);
    });

    it('keeps the truncation boundary at the last real user message after exclusion', async () => {
        // A trailing Error row must not extend the transcript past the last user turn.
        runViewMock.mockResolvedValue({
            Success: true,
            Results: [
                detailRow('cd-1', 'User', 'first question'),
                detailRow('cd-2', 'AI', 'first answer'),
                detailRow('cd-3', 'User', 'second question'),
                detailRow('cd-4', 'Error', 'boom'),
            ],
        });

        const messages = await agent().loadMessagesFromDatabase(CONVERSATION_ID, USER);

        expect(messages).toHaveLength(3);
        expect(messages[messages.length - 1].content).toBe('second question');
        expect(messages[messages.length - 1].role).toBe('user');
    });

    it('drops AI rows trailing the last user message (status/incomplete responses)', async () => {
        runViewMock.mockResolvedValue({
            Success: true,
            Results: [
                detailRow('cd-1', 'User', 'question'),
                detailRow('cd-2', 'AI', '⏳ Starting...'),
            ],
        });

        const messages = await agent().loadMessagesFromDatabase(CONVERSATION_ID, USER);

        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('user');
    });

    it('rejects a non-UUID conversation id before touching the database', async () => {
        await expect(
            agent().loadMessagesFromDatabase("abc' OR 1=1 --", USER)
        ).rejects.toThrow(/expected a UUID/);

        expect(runViewMock).not.toHaveBeenCalled();
    });

    it('interpolates only the validated UUID into the filter', async () => {
        runViewMock.mockResolvedValue({ Success: true, Results: [] });

        await agent().loadMessagesFromDatabase(CONVERSATION_ID, USER);

        expect(runViewMock).toHaveBeenCalledWith(
            expect.objectContaining({ ExtraFilter: `ConversationID='${CONVERSATION_ID}'` }),
            USER
        );
    });
});

// ── Fix 2: clarifying-question round trip ───────────────────────────────────

describe('resolveRequestPhase', () => {
    it('returns initial_request when there is no prior run', async () => {
        expect(await agent().resolveRequestPhase(undefined, USER)).toBe('initial_request');
        expect(await agent().resolveRequestPhase(null, USER)).toBe('initial_request');
        expect(runViewMock).not.toHaveBeenCalled();
    });

    it('never interpolates a non-UUID lastRunId', async () => {
        expect(await agent().resolveRequestPhase("x'; DROP TABLE --", USER)).toBe('initial_request');
        expect(runViewMock).not.toHaveBeenCalled();
    });

    it('returns clarify_question_response when the prior run ended in a Chat step', async () => {
        runViewMock.mockResolvedValue({
            Success: true,
            Results: [{ ID: LAST_RUN_ID, FinalStep: 'Chat' }],
        });

        expect(await agent().resolveRequestPhase(LAST_RUN_ID, USER)).toBe('clarify_question_response');
        expect(runViewMock).toHaveBeenCalledWith(
            expect.objectContaining({
                EntityName: 'MJ: AI Agent Runs',
                ExtraFilter: `ID='${LAST_RUN_ID}'`,
            }),
            USER
        );
    });

    it('returns initial_request when the prior run completed normally', async () => {
        runViewMock.mockResolvedValue({
            Success: true,
            Results: [{ ID: LAST_RUN_ID, FinalStep: 'Success' }],
        });

        expect(await agent().resolveRequestPhase(LAST_RUN_ID, USER)).toBe('initial_request');
    });

    it('falls back to initial_request when the prior run cannot be loaded', async () => {
        runViewMock.mockResolvedValue({ Success: false, ErrorMessage: 'nope', Results: [] });
        expect(await agent().resolveRequestPhase(LAST_RUN_ID, USER)).toBe('initial_request');

        runViewMock.mockRejectedValue(new Error('connection lost'));
        expect(await agent().resolveRequestPhase(LAST_RUN_ID, USER)).toBe('initial_request');
    });
});

// ── Fixes 2 + 3 wired through executeAgentInternal ──────────────────────────

type ChatOptions = { conversationId?: string; requestPhase?: string };

async function executeWithStub(params: Record<string, unknown>): Promise<ChatOptions> {
    const proxyAgent = new SkipProxyAgent();
    const chat = vi.fn().mockResolvedValue({
        success: true,
        responsePhase: 'analysis_complete',
        response: {
            success: true,
            responsePhase: 'analysis_complete',
            messages: [],
            analysis: 'done',
        },
    });
    (proxyAgent as unknown as { skipSDK: unknown }).skipSDK = {
        ensureConfig: vi.fn(),
        chat,
    };

    await (proxyAgent as unknown as {
        executeAgentInternal(params: unknown, config: unknown): Promise<unknown>;
    }).executeAgentInternal({ contextUser: USER, conversationMessages: [], ...params }, {});

    return chat.mock.calls[0][0] as ChatOptions;
}

describe('executeAgentInternal — conversationId and requestPhase resolution', () => {
    it('prefers the framework-injected data.conversationId over context', async () => {
        runViewMock.mockResolvedValue({ Success: true, Results: [] });

        const options = await executeWithStub({
            data: { conversationId: CONVERSATION_ID },
            context: { conversationId: CONTEXT_CONVERSATION_ID },
        });

        expect(options.conversationId).toBe(CONVERSATION_ID);
    });

    it('falls back to context.conversationId when data has none', async () => {
        runViewMock.mockResolvedValue({ Success: true, Results: [] });

        const options = await executeWithStub({
            data: {},
            context: { conversationId: CONTEXT_CONVERSATION_ID },
        });

        expect(options.conversationId).toBe(CONTEXT_CONVERSATION_ID);
        // The fallback id drives the DB message load too
        expect(runViewMock).toHaveBeenCalledWith(
            expect.objectContaining({ ExtraFilter: `ConversationID='${CONTEXT_CONVERSATION_ID}'` }),
            USER
        );
    });

    it('sends clarify_question_response when chained after a Chat-step run', async () => {
        runViewMock.mockResolvedValue({
            Success: true,
            Results: [{ ID: LAST_RUN_ID, FinalStep: 'Chat' }],
        });

        const options = await executeWithStub({ data: {}, lastRunId: LAST_RUN_ID });

        expect(options.requestPhase).toBe('clarify_question_response');
    });

    it('sends initial_request on a fresh run', async () => {
        const options = await executeWithStub({ data: {} });

        expect(options.requestPhase).toBe('initial_request');
        expect(runViewMock).not.toHaveBeenCalled();
    });
});

// ── Fixes 5 + 6: analysis_complete handling ─────────────────────────────────

describe('handleAnalysisComplete', () => {
    it('never surfaces hiddenToUser messages', () => {
        const result = agent().handleAnalysisComplete(analysisResponse({
            componentOptions: [option('OnlyOption', 1)],
            messages: [
                { role: 'system', content: 'Here is your dashboard', conversationDetailID: 'cd-1' },
                { role: 'system', content: 'internal trace', conversationDetailID: 'cd-2', hiddenToUser: true },
            ],
        }));

        expect(result.message).toBe('Here is your dashboard');
    });

    it('picks the option with the best (lowest) AIRank', () => {
        const result = agent().handleAnalysisComplete(analysisResponse({
            componentOptions: [option('SecondBest', 2), option('Best', 1), option('Worst', 3)],
        }));

        expect(result.step).toBe('Success');
        expect((result.newPayload as unknown as { name: string }).name).toBe('Best');
    });

    it('prefers a ranked option over unranked ones', () => {
        const result = agent().handleAnalysisComplete(analysisResponse({
            componentOptions: [option('Unranked', undefined), option('Ranked', 2)],
        }));

        expect((result.newPayload as unknown as { name: string }).name).toBe('Ranked');
    });

    it('falls back to the first option when no ranks are present', () => {
        const result = agent().handleAnalysisComplete(analysisResponse({
            componentOptions: [option('First', undefined), option('Second', undefined)],
        }));

        expect((result.newPayload as unknown as { name: string }).name).toBe('First');
    });
});
