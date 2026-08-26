/**
 * @fileoverview Unit tests for SkipProxyAgent.handleSkipError message routing.
 *
 * A Skip failure response carries two accounts of what went wrong: prose written for
 * the user (the last system message) and a diagnostic naming the failing pipeline step
 * (`errorDetail.message`). These tests pin down that each lands in the right field —
 * `message` is shown to the user, `errorMessage` is recorded for debugging.
 */

import { describe, it, expect, vi } from 'vitest';
import { SkipResponsePhase } from '@askskip/types';
import type { SkipAPIResponse } from '@askskip/types';

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@memberjunction/ai-agents', () => ({
    BaseAgent: class MockBaseAgent {},
}));

vi.mock('@memberjunction/global', () => ({
    RegisterClass: () => (target: unknown) => target,
}));

vi.mock('@memberjunction/core', () => ({
    LogStatus: vi.fn(),
    LogError: vi.fn(),
    RunView: class {},
    UserInfo: class {},
}));

vi.mock('@memberjunction/data-context', () => ({ DataContext: class {} }));
vi.mock('./skip-sdk.js', () => ({ SkipSDK: class {} }));

import { SkipProxyAgent } from '../../src/skip-agent.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Verbatim from a real Skip failure — internal pipeline language. */
const DIAGNOSTIC =
    "Pipeline failed at step 'Execute Sub-Agent: Skip: Data Expert': " +
    'Failed to process one or more query requirements';

/** Verbatim from the same run's Failure Finalization step — written for the user. */
const USER_MESSAGE =
    'I had some trouble automatically connecting your claims and training data. ' +
    'To help me build the report correctly, please confirm which data sources I should use.';

type ErrorHandler = {
    handleSkipError(response: SkipAPIResponse): { message?: string; errorMessage?: string; step: string };
};

function handle(response: Partial<SkipAPIResponse>) {
    const agent = new SkipProxyAgent() as unknown as ErrorHandler;
    return agent['handleSkipError']({
        success: false,
        responsePhase: SkipResponsePhase.analysis_complete,
        ...response,
    } as SkipAPIResponse);
}

function systemMessage(content: string, extra: Record<string, unknown> = {}) {
    return { role: 'system' as const, content, conversationDetailID: 'cd-1', ...extra };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('handleSkipError', () => {
    it('shows the user-facing message when both accounts are present', () => {
        // The regression: reading errorDetail into both fields put pipeline jargon in
        // front of users on every ordinary failure, because Skip populates both.
        const result = handle({
            errorDetail: { message: DIAGNOSTIC } as SkipAPIResponse['errorDetail'],
            messages: [systemMessage(USER_MESSAGE, { error: DIAGNOSTIC })],
        });

        expect(result.message).toBe(USER_MESSAGE);
        expect(result.message).not.toContain('Execute Sub-Agent');
    });

    it('records the diagnostic for debugging', () => {
        const result = handle({
            errorDetail: { message: DIAGNOSTIC } as SkipAPIResponse['errorDetail'],
            messages: [systemMessage(USER_MESSAGE, { error: DIAGNOSTIC })],
        });

        expect(result.errorMessage).toBe(DIAGNOSTIC);
    });

    it('always terminates as Failed', () => {
        expect(handle({}).step).toBe('Failed');
    });

    it('takes the last system message, not the first', () => {
        const result = handle({
            messages: [
                { role: 'user' as const, content: 'build me a report', conversationDetailID: 'cd-0' },
                systemMessage('an earlier note'),
                systemMessage(USER_MESSAGE),
            ],
        });

        expect(result.message).toBe(USER_MESSAGE);
    });

    it('ignores messages hidden from the user', () => {
        // hiddenToUser messages are internal bookkeeping and were never written to be read.
        const result = handle({
            errorDetail: { message: DIAGNOSTIC } as SkipAPIResponse['errorDetail'],
            messages: [
                systemMessage(USER_MESSAGE),
                systemMessage('internal trace nobody should see', { hiddenToUser: true }),
            ],
        });

        expect(result.message).toBe(USER_MESSAGE);
    });

    it('falls back to the diagnostic when Skip sent no prose', () => {
        // Failures before finalization — preflight, timeouts, aborts — have no
        // composed message. Jargon beats silence.
        const result = handle({
            errorDetail: { message: DIAGNOSTIC } as SkipAPIResponse['errorDetail'],
            messages: [],
        });

        expect(result.message).toBe(DIAGNOSTIC);
        expect(result.errorMessage).toBe(DIAGNOSTIC);
    });

    it('falls back to the system message error field when errorDetail is absent', () => {
        const result = handle({
            messages: [systemMessage(USER_MESSAGE, { error: DIAGNOSTIC })],
        });

        expect(result.message).toBe(USER_MESSAGE);
        expect(result.errorMessage).toBe(DIAGNOSTIC);
    });

    it('uses the user message as the diagnostic when nothing else is available', () => {
        const result = handle({ messages: [systemMessage(USER_MESSAGE)] });

        expect(result.message).toBe(USER_MESSAGE);
        expect(result.errorMessage).toBe(USER_MESSAGE);
    });

    it('falls back cleanly when the response carries nothing', () => {
        const result = handle({});

        expect(result.message).toBe('Skip returned an error with no details');
        expect(result.errorMessage).toBe('Skip returned an error with no details');
    });

    it('treats a blank system message as absent', () => {
        const result = handle({
            errorDetail: { message: DIAGNOSTIC } as SkipAPIResponse['errorDetail'],
            messages: [systemMessage('   ')],
        });

        expect(result.message).toBe(DIAGNOSTIC);
    });
});

// ── Dispatch ────────────────────────────────────────────────────────────────
//
// handleSkipError only matters if execution actually reaches it. `SkipSDK.chat`
// reports a Skip-side failure as `success: false` WITH the response attached and
// `error` set to the internal errorDetail.message. Short-circuiting on
// `result.success` therefore skipped handleSkipError entirely on every real Skip
// failure and echoed the diagnostic straight at the user — the tests above passed
// against a function nothing called. Only the absence of a response body is a
// transport failure.

type SkipCallStub = {
    success: boolean;
    response?: SkipAPIResponse;
    responsePhase?: string;
    error?: string;
};

/** Drives executeAgentInternal with a stubbed SDK and returns the finalStep. */
async function execute(chatResult: SkipCallStub) {
    const agent = new SkipProxyAgent();
    (agent as unknown as { skipSDK: unknown }).skipSDK = {
        ensureConfig: vi.fn(),
        chat: vi.fn().mockResolvedValue(chatResult),
    };

    const { finalStep } = await (agent as unknown as {
        executeAgentInternal(params: unknown, config: unknown): Promise<{
            finalStep: { message?: string; errorMessage?: string; step: string };
        }>;
    }).executeAgentInternal(
        { contextUser: { ID: 'u-1' }, conversationMessages: [], data: {} },
        {}
    );
    return finalStep;
}

/** A Skip failure exactly as SkipSDK.chat surfaces it. */
const skipReportedFailure: SkipCallStub = {
    success: false,
    error: DIAGNOSTIC,
    responsePhase: SkipResponsePhase.analysis_complete,
    response: {
        success: false,
        responsePhase: SkipResponsePhase.analysis_complete,
        errorDetail: { message: DIAGNOSTIC } as SkipAPIResponse['errorDetail'],
        messages: [systemMessage(USER_MESSAGE, { error: DIAGNOSTIC })],
    } as SkipAPIResponse,
};

describe('executeAgentInternal — routing a Skip-reported failure', () => {
    it('shows the user Skip’s own explanation, not the pipeline diagnostic', async () => {
        const finalStep = await execute(skipReportedFailure);

        expect(finalStep.message).toBe(USER_MESSAGE);
        expect(finalStep.message).not.toContain('Execute Sub-Agent');
    });

    it('still records the diagnostic and fails the run', async () => {
        const finalStep = await execute(skipReportedFailure);

        expect(finalStep.errorMessage).toBe(DIAGNOSTIC);
        expect(finalStep.step).toBe('Failed');
    });

    it('reports the SDK error directly when no response came back', async () => {
        // Transport failure — nothing to route, and nothing better to say.
        const finalStep = await execute({
            success: false,
            error: 'Unable to connect to the Skip analysis service.',
        });

        expect(finalStep.step).toBe('Failed');
        expect(finalStep.message).toBe('Unable to connect to the Skip analysis service.');
        expect(finalStep.errorMessage).toBe('Unable to connect to the Skip analysis service.');
    });

    it('falls back when the SDK reports neither a response nor an error', async () => {
        const finalStep = await execute({ success: false });

        expect(finalStep.message).toBe('No response received from Skip API');
    });
});
