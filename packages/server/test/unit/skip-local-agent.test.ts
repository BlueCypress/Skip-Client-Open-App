/**
 * @fileoverview Unit tests for Piece 2C:
 * - ID-based `ensureSkipAgent` self-heal and the 5 sub-agents (`skip-records.ts`)
 * - `SkipLocalAgent` state block computation (`SkipRouterState`)
 * - `SkipLocalAgent` deterministic fast-paths, Loop router execution, and fallback to `Skip: Component Builder`
 * - `SkipProxyAgent.resolveRequestPhase` conversation-scoped fallback when `lastRunId` is absent
 * - `SkipSDK.buildArtifacts` filtering of local sub-agent output artifacts (`Data`, `SVG`, `Markdown`)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserInfo, IMetadataProvider } from '@memberjunction/core';
import type { ExecuteAgentParams, AgentConfiguration, BaseAgentNextStep } from '@memberjunction/ai-core-plus';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const {
    runViewMock,
    runQueryMock,
    baseExecuteInternalMock,
    executeNextStepMock,
    resolveSubAgentByNameMock,
    getAgentByNameMock,
} = vi.hoisted(() => ({
    runViewMock: vi.fn(),
    runQueryMock: vi.fn(),
    baseExecuteInternalMock: vi.fn(),
    executeNextStepMock: vi.fn(),
    resolveSubAgentByNameMock: vi.fn(),
    getAgentByNameMock: vi.fn(),
}));

vi.mock('@memberjunction/ai-agents', () => ({
    BaseAgent: class MockBaseAgent {
        AgentRun: { ID?: string; LastRunID?: string } | null = null;
        protected async executeAgentInternal(params: ExecuteAgentParams, config: AgentConfiguration) {
            return await baseExecuteInternalMock(params, config);
        }
        protected async executeNextStep(
            params: ExecuteAgentParams,
            config: AgentConfiguration,
            previousDecision: BaseAgentNextStep,
            stepCount?: number,
        ) {
            return await executeNextStepMock(params, config, previousDecision, stepCount);
        }
        protected resolveSubAgentByName(params: ExecuteAgentParams, name: string) {
            return resolveSubAgentByNameMock(params, name);
        }
    },
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
    RunQuery: class {
        RunQuery = runQueryMock;
    },
    UserInfo: class {},
    Metadata: class {},
}));

vi.mock('@memberjunction/aiengine', () => ({
    AIEngine: {
        Instance: {
            Config: vi.fn().mockResolvedValue(undefined),
            GetAgentByName: getAgentByNameMock,
        },
    },
}));

vi.mock('@memberjunction/data-context', () => ({ DataContext: class {} }));

import {
    SKIP_AGENT_ID,
    SKIP_COMPONENT_BUILDER_AGENT_ID,
    SKIP_DATA_ANSWERER_AGENT_ID,
    SKIP_ANALYST_AGENT_ID,
    SKIP_SCHEMA_GUIDE_AGENT_ID,
    SKIP_VISUALIZER_AGENT_ID,
    SKIP_SUB_AGENTS,
    SKIP_AGENT_PROMPT_SPECS,
    BUILD_REUSABLE_COMPONENT_LABEL,
    ensureSkipRecords,
    removeSkipRecords,
} from '@askskip/core';
import {
    SkipLocalAgent,
    SKIP_COMPONENT_BUILDER_NAME,
    SKIP_DATA_ANSWERER_NAME,
    detectPayloadStage,
    isExplicitComponentEscalation,
    isExplicitBuildCancellation,
    parseCompactRouterEnvelope,
    extractPromotionContext,
    buildComponentPromotionResponseForm,
} from '../../src/skip-local-agent.js';
import { SkipProxyAgent } from '../../src/skip-agent.js';
import { SkipSDK } from '../../src/skip-sdk.js';

const USER = { ID: '00000000-0000-0000-0000-000000000001' } as unknown as UserInfo;
const CONVERSATION_ID = '11111111-2222-3333-4444-555555555555';
const DETAIL_ID = '22222222-3333-4444-5555-666666666666';
const ARTIFACT_COMP_ID = '33333333-4444-5555-6666-777777777777';
const ARTIFACT_DATA_ID = '44444444-5555-6666-7777-888888888888';
const ARTIFACT_SVG_ID = '55555555-6666-7777-8888-999999999999';
const SNAPSHOT_VERSION_ID = '66666666-7777-8888-9999-aaaaaaaaaaaa';

beforeEach(() => {
    runViewMock.mockReset();
    runQueryMock.mockReset();
    baseExecuteInternalMock.mockReset();
    executeNextStepMock.mockReset();
    resolveSubAgentByNameMock.mockReset();
    getAgentByNameMock.mockReset();
    getAgentByNameMock.mockReturnValue({ ID: SKIP_AGENT_ID, Name: 'Skip' });
});

// ── 1. ensureSkipRecords / ensureSkipAgent self-heal & sub-agents ───────────

describe('ensureSkipRecords & removeSkipRecords (SkipLocalAgent + 5 sub-agents)', () => {
    it('exports stable deterministic IDs for Skip and all 5 sub-agents', () => {
        expect(SKIP_AGENT_ID).toBe('A829FAAC-9E64-440C-B650-83F92A37E990');
        expect(SKIP_COMPONENT_BUILDER_AGENT_ID).toBe('B930FBBD-AF75-451D-A761-94FA3B48FA01');
        expect(SKIP_DATA_ANSWERER_AGENT_ID).toBe('C1410CCE-B086-462E-B872-A50B4C590B12');
        expect(SKIP_ANALYST_AGENT_ID).toBe('D2521DDF-C197-473F-C983-B61C5D6A1C23');
        expect(SKIP_SCHEMA_GUIDE_AGENT_ID).toBe('E3632EE0-D2A8-4840-DA94-C72D6E7B2D34');
        expect(SKIP_VISUALIZER_AGENT_ID).toBe('F4743FF1-E3B9-4951-EB05-D83E7F8C3E45');
        expect(SKIP_SUB_AGENTS).toHaveLength(5);
    });

    it('reconciles an existing SkipProxyAgent row in-place to SkipLocalAgent and creates the 5 sub-agents', async () => {
        const existingSkipSave = vi.fn().mockResolvedValue(true);
        const existingSkipRecord: Record<string, unknown> = {
            ID: SKIP_AGENT_ID,
            Name: 'Skip',
            Status: 'Disabled',
            DriverClass: 'SkipProxyAgent',
            TypeID: 'old-type-id',
            DefaultArtifactTypeID: null,
            Save: existingSkipSave,
        };

        const createdAgents: Array<Record<string, unknown>> = [];
        const provider = {
            GetEntityObject: vi.fn().mockImplementation(async () => {
                const entity: Record<string, unknown> = {
                    NewRecord: vi.fn(),
                    Save: vi.fn().mockResolvedValue(true),
                };
                createdAgents.push(entity);
                return entity;
            }),
        } as unknown as IMetadataProvider;

        runViewMock.mockImplementation(async (params: { EntityName: string; ExtraFilter: string }) => {
            if (params.EntityName === 'MJ: AI Agents' && params.ExtraFilter.includes(SKIP_AGENT_ID) && params.ExtraFilter.includes("Name='Skip'")) {
                return { Success: true, Results: [existingSkipRecord] };
            }
            if (params.EntityName === 'MJ: AI Agent Types') {
                return { Success: true, Results: [{ ID: 'loop-type-id' }] };
            }
            if (params.EntityName === 'MJ: AI Agent Categories') {
                return { Success: true, Results: [{ ID: 'assistant-cat-id' }] };
            }
            if (params.EntityName === 'MJ: Artifact Types') {
                const match = params.ExtraFilter.match(/Name='([^']+)'/);
                const typeName = match?.[1] ?? 'Component';
                return { Success: true, Results: [{ ID: `artifact-type-${typeName.toLowerCase()}` }] };
            }
            // Sub-agents do not exist yet
            return { Success: true, Results: [] };
        });

        const logs: string[] = [];
        await ensureSkipRecords(provider, USER, (m) => logs.push(m), undefined);

        // Existing Skip record was reconciled in-place (NOT re-inserted)
        expect(existingSkipSave).toHaveBeenCalledTimes(1);
        expect(existingSkipRecord.Status).toBe('Active');
        expect(existingSkipRecord.DriverClass).toBe('SkipLocalAgent');
        expect(existingSkipRecord.TypeID).toBe('loop-type-id');
        expect(existingSkipRecord.DefaultArtifactTypeID).toBe('artifact-type-component');

        // 5 sub-agents were created with ParentID = SKIP_AGENT_ID, ExposeAsAction = false, InvocationMode = 'Sub-Agent'
        expect(createdAgents).toHaveLength(5);
        expect(createdAgents.map((a) => a.Name)).toEqual([
            'Skip: Component Builder',
            'Skip: Data Answerer',
            'Skip: Analyst',
            'Skip: Schema Guide',
            'Skip: Visualizer',
        ]);
        for (const sub of createdAgents) {
            expect(sub.ParentID).toBe(SKIP_AGENT_ID);
            expect(sub.ExposeAsAction).toBe(false);
            expect(sub.InvocationMode).toBe('Sub-Agent');
            expect(sub.MessageMode).toBe('All');
            expect(sub.ModelSelectionMode).toBe('Agent');
            expect(sub.ChatHandlingOption).toBeNull();
            expect(sub.InjectNotes).toBe(true);
            expect(sub.MaxNotesToInject).toBe(10);
            expect(sub.NoteInjectionStrategy).toBe('Recent');
            expect(sub.Status).toBe('Active');
        }
        expect(createdAgents[0].DriverClass).toBe('SkipProxyAgent');
        expect(createdAgents[0].DefaultArtifactTypeID).toBe('artifact-type-component');
        expect(createdAgents[1].DriverClass).toBeNull();
        expect(createdAgents[1].DefaultArtifactTypeID).toBe('artifact-type-data');
        expect(createdAgents[4].DefaultArtifactTypeID).toBe('artifact-type-svg');
    });

    it('seeds prompts, templates, model bindings, and action bindings when MJ: AI Prompt Types is present', async () => {
        const createdByEntity = new Map<string, Array<Record<string, unknown>>>();
        const provider = {
            GetEntityObject: vi.fn().mockImplementation(async (entityName: string) => {
                const entity: Record<string, unknown> = {
                    NewRecord: vi.fn(),
                    Save: vi.fn().mockResolvedValue(true),
                };
                const list = createdByEntity.get(entityName) ?? [];
                list.push(entity);
                createdByEntity.set(entityName, list);
                return entity;
            }),
        } as unknown as IMetadataProvider;

        runViewMock.mockImplementation(async (params: { EntityName: string; ExtraFilter: string }) => {
            if (params.EntityName === 'MJ: AI Agent Types') {
                return { Success: true, Results: [{ ID: 'loop-type-id' }] };
            }
            if (params.EntityName === 'MJ: AI Agent Categories') {
                return { Success: true, Results: [{ ID: 'assistant-cat-id' }] };
            }
            if (params.EntityName === 'MJ: Artifact Types') {
                return { Success: true, Results: [{ ID: 'art-type-id' }] };
            }
            if (params.EntityName === 'MJ: AI Prompt Types') {
                return { Success: true, Results: [{ ID: 'chat-prompt-type-id' }] };
            }
            if (params.EntityName === 'MJ: AI Prompt Categories') {
                return { Success: true, Results: [{ ID: 'sys-prompt-cat-id' }] };
            }
            if (params.EntityName === 'MJ: Template Content Types') {
                return { Success: true, Results: [{ ID: 'text-content-type-id' }] };
            }
            if (params.EntityName === 'MJ: AI Models') {
                return { Success: true, Results: [{ ID: 'model-id' }] };
            }
            if (params.EntityName === 'MJ: AI Vendors') {
                return { Success: true, Results: [{ ID: 'vendor-id' }] };
            }
            if (params.EntityName === 'MJ: Actions') {
                return { Success: true, Results: [{ ID: 'action-id' }] };
            }
            return { Success: true, Results: [] };
        });

        await ensureSkipRecords(provider, USER, () => {}, undefined);

        expect(createdByEntity.get('MJ: Templates')).toHaveLength(5);
        expect(createdByEntity.get('MJ: Template Contents')).toHaveLength(5);
        expect(createdByEntity.get('MJ: AI Prompts')).toHaveLength(5);
        expect(createdByEntity.get('MJ: AI Agent Prompts')).toHaveLength(5);
        expect((createdByEntity.get('MJ: AI Prompt Models') ?? []).length).toBeGreaterThanOrEqual(20);
        // 6 actions (Data Answerer) + 4 (Analyst) + 5 (Schema Guide) + 3 (Visualizer) = 18
        expect(createdByEntity.get('MJ: AI Agent Actions')).toHaveLength(18);

        // Verify all prompt templates include safety or escalation guidance
        for (const spec of SKIP_AGENT_PROMPT_SPECS) {
            expect(spec.templateText.length).toBeGreaterThan(200);
        }
        const dataAnswererSpec = SKIP_AGENT_PROMPT_SPECS.find((s) => s.agentName === 'Skip: Data Answerer')!;
        expect(dataAnswererSpec.templateText).toContain('MaxRows');
        expect(dataAnswererSpec.templateText).toContain(BUILD_REUSABLE_COMPONENT_LABEL);
        expect(dataAnswererSpec.actions.map((a) => a.actionName)).toContain('Get Graph Context');
    });

    it('deletes prompt/action links and sub-agents before deleting the parent Skip agent in removeSkipRecords', async () => {
        const filtersCalled: string[] = [];
        runViewMock.mockImplementation(async (params: { EntityName: string; ExtraFilter: string }) => {
            filtersCalled.push(`${params.EntityName}: ${params.ExtraFilter}`);
            return { Success: true, Results: [] };
        });

        await removeSkipRecords(USER, () => {});

        const subAgentDeleteIdx = filtersCalled.findIndex((f) => f.includes(`ParentID='${SKIP_AGENT_ID}'`));
        const parentDeleteIdx = filtersCalled.findIndex((f) => f.includes('DriverClass IN'));
        expect(subAgentDeleteIdx).toBeGreaterThanOrEqual(0);
        expect(parentDeleteIdx).toBeGreaterThan(subAgentDeleteIdx);
    });
});

// ── 2. Payload stage & message trigger helpers ──────────────────────────────

describe('SkipLocalAgent helper functions', () => {
    it('detects payloadStage accurately across none, prd, tdd, and complete', () => {
        expect(detectPayloadStage(null)).toBe('none');
        expect(detectPayloadStage({})).toBe('none');
        expect(detectPayloadStage({ name: 'SalesDashboard', functionalRequirements: 'Show sales' })).toBe('prd');
        expect(detectPayloadStage({ name: 'SalesDashboard', technicalDesign: 'Use Sales query' })).toBe('tdd');
        expect(detectPayloadStage({ name: 'SalesDashboard', code: 'export function App() {}' })).toBe('complete');
    });

    it('detects explicit component escalation triggers and build cancellation', () => {
        expect(isExplicitComponentEscalation('Build a reusable component for this')).toBe(true);
        expect(isExplicitComponentEscalation('Please [component] build a dashboard')).toBe(true);
        expect(isExplicitComponentEscalation('How many members do we have?')).toBe(false);

        expect(isExplicitBuildCancellation('cancel')).toBe(true);
        expect(isExplicitBuildCancellation('never mind, how many members?')).toBe(true);
        expect(isExplicitBuildCancellation('approve the PRD')).toBe(false);
    });

    it('parses compact router JSON envelopes and builds promotion context / response form', () => {
        const envelope = parseCompactRouterEnvelope(
            '```json\n{"route":"data_answerer","confidence":"high","reasoning":"Count question","reply":null}\n```',
        );
        expect(envelope).toEqual({
            route: 'data_answerer',
            confidence: 'high',
            reasoning: 'Count question',
            reply: null,
        });

        const params: ExecuteAgentParams = {
            agent: { ID: SKIP_AGENT_ID, Name: 'Skip' } as never,
            contextUser: USER,
            payload: {
                title: 'Active Members by Tier',
                queryName: 'GetActiveMembersByTier',
                sql: 'SELECT Tier, COUNT(*) FROM vwMembers GROUP BY Tier',
                interpretation: 'Gold tier accounts for 62% of active members.',
            },
            conversationMessages: [{ role: 'user', content: BUILD_REUSABLE_COMPONENT_LABEL }],
        };
        const promotion = extractPromotionContext(params, {
            attachedComponent: null,
            componentRoster: [],
            hasDataSnapshot: false,
            pendingBrainQuestion: null,
            payloadStage: 'none',
            lastDelegate: SKIP_DATA_ANSWERER_NAME,
        });
        expect(promotion).toEqual({
            title: 'Active Members by Tier',
            queryName: 'GetActiveMembersByTier',
            sql: 'SELECT Tier, COUNT(*) FROM vwMembers GROUP BY Tier',
            summary: 'Gold tier accounts for 62% of active members.',
            sourceSubAgent: SKIP_DATA_ANSWERER_NAME,
        });

        const form = buildComponentPromotionResponseForm();
        expect(form.questions[0].type).toMatchObject({
            type: 'buttongroup',
            options: [{ value: BUILD_REUSABLE_COMPONENT_LABEL, label: BUILD_REUSABLE_COMPONENT_LABEL }],
        });
    });

    it('sanitizes Sub-Agent decisions: strips templateParameters (V7), rescues taskComplete=true, and converts compact route JSON', () => {
        const localAgent = new SkipLocalAgent();
        const params: ExecuteAgentParams = {
            agent: { ID: SKIP_AGENT_ID, Name: 'Skip' } as never,
            contextUser: USER,
            conversationMessages: [{ role: 'user', content: 'How many active members?' }],
        };

        // 1. V7 + taskComplete=true rescue
        const rawDecision = {
            step: 'Success',
            terminate: true,
            subAgent: {
                name: SKIP_DATA_ANSWERER_NAME,
                message: '',
                terminateAfter: false,
                templateParameters: {
                    conversationId: '00000000-0000-0000-0000-000000000000',
                },
            },
        } as unknown as BaseAgentNextStep;

        const sanitized = localAgent.sanitizeRouterDecision(params, rawDecision);
        expect(sanitized.step).toBe('Sub-Agent');
        expect(sanitized.terminate).toBe(false);
        expect(sanitized.subAgent?.name).toBe(SKIP_DATA_ANSWERER_NAME);
        expect(sanitized.subAgent?.terminateAfter).toBe(true);
        expect(sanitized.subAgent?.message).toBe('How many active members?');
        expect('templateParameters' in (sanitized.subAgent as Record<string, unknown>)).toBe(false);

        // 2. Compact router JSON -> Sub-Agent step
        const compactSubAgentDecision = localAgent.sanitizeRouterDecision(params, {
            step: 'Success',
            terminate: true,
            message: JSON.stringify({
                route: 'data_answerer',
                confidence: 'high',
                reasoning: 'Population count question',
                reply: null,
            }),
        } as BaseAgentNextStep);
        expect(compactSubAgentDecision.step).toBe('Sub-Agent');
        expect(compactSubAgentDecision.terminate).toBe(false);
        expect(compactSubAgentDecision.subAgent?.name).toBe(SKIP_DATA_ANSWERER_NAME);
        expect(compactSubAgentDecision.subAgent?.terminateAfter).toBe(true);

        // 3. Compact router JSON -> direct_reply Success step
        const compactDirectDecision = localAgent.sanitizeRouterDecision(params, {
            step: 'Success',
            terminate: true,
            message: JSON.stringify({
                route: 'direct_reply',
                confidence: 'high',
                reasoning: 'User said thanks',
                reply: 'You are welcome!',
            }),
        } as BaseAgentNextStep);
        expect(compactDirectDecision.step).toBe('Success');
        expect(compactDirectDecision.terminate).toBe(true);
        expect(compactDirectDecision.message).toBe('You are welcome!');
    });
});

// ── 3. SkipLocalAgent.buildRouterState ──────────────────────────────────────

describe('SkipLocalAgent.buildRouterState', () => {
    it('computes pendingBrainQuestion, lastDelegate, componentRoster (excluding Data/SVG), and hasDataSnapshot', async () => {
        runViewMock.mockImplementation(async (params: { EntityName: string; ExtraFilter: string }) => {
            if (params.EntityName === 'MJ: AI Agent Runs') {
                return {
                    Success: true,
                    Results: [
                        {
                            ID: 'run-2',
                            Agent: 'Skip: Component Builder',
                            FinalStep: 'Chat',
                            Message: 'Please review the PRD for Member Retention Dashboard.',
                        },
                        {
                            ID: 'run-1',
                            Agent: 'Skip: Data Answerer',
                            FinalStep: 'Success',
                            Message: 'There are 420 active members.',
                        },
                    ],
                };
            }
            if (params.EntityName === 'MJ: Conversation Detail Artifacts') {
                return {
                    Success: true,
                    Results: [
                        {
                            ConversationDetailID: DETAIL_ID,
                            ArtifactVersionID: SNAPSHOT_VERSION_ID,
                            Direction: 'Input',
                        },
                    ],
                };
            }
            if (params.EntityName === 'MJ: Artifact Versions') {
                return {
                    Success: true,
                    Results: [
                        {
                            ID: SNAPSHOT_VERSION_ID,
                            ArtifactID: 'snap-art-1',
                            Artifact: 'Captured Snapshot',
                            VersionNumber: 1,
                            ArtifactType: 'Data Snapshot',
                        },
                    ],
                };
            }
            return { Success: true, Results: [] };
        });

        runQueryMock.mockResolvedValue({
            Success: true,
            Results: [
                {
                    ArtifactID: ARTIFACT_COMP_ID,
                    ArtifactName: 'Revenue Dashboard',
                    ArtifactTypeName: 'Component',
                    Version: 1,
                },
                {
                    ArtifactID: ARTIFACT_COMP_ID,
                    ArtifactName: 'Revenue Dashboard',
                    ArtifactTypeName: 'Component',
                    Version: 2,
                },
                {
                    ArtifactID: ARTIFACT_DATA_ID,
                    ArtifactName: 'Active Members Table',
                    ArtifactTypeName: 'Data',
                    Version: 1,
                },
                {
                    ArtifactID: ARTIFACT_SVG_ID,
                    ArtifactName: 'Members By Region Chart',
                    ArtifactTypeName: 'SVG',
                    Version: 1,
                },
            ],
        });

        const localAgent = new SkipLocalAgent();
        const params: ExecuteAgentParams = {
            agent: { ID: SKIP_AGENT_ID, Name: 'Skip' } as never,
            contextUser: USER,
            conversationId: CONVERSATION_ID,
            payload: { name: 'RetentionDashboard', functionalRequirements: 'Track churn' },
            conversationMessages: [
                {
                    role: 'user',
                    content: 'Looks good, proceed',
                    metadata: { conversationDetailID: DETAIL_ID },
                } as never,
            ],
        };

        const state = await localAgent.buildRouterState(CONVERSATION_ID, params);

        expect(state.pendingBrainQuestion).toBe('Please review the PRD for Member Retention Dashboard.');
        expect(state.lastDelegate).toBe('Skip: Component Builder');
        expect(state.payloadStage).toBe('prd');
        expect(state.hasDataSnapshot).toBe(true);
        // Only Component artifacts appear in componentRoster (Data and SVG are excluded)
        expect(state.componentRoster).toEqual([
            {
                id: ARTIFACT_COMP_ID,
                name: 'Revenue Dashboard',
                latestVersion: 2,
                turnIndex: 2,
            },
        ]);
        expect(state.attachedComponent).toBeNull();
    });
});

// ── 4. SkipLocalAgent routing & fallback behavior ───────────────────────────

describe('SkipLocalAgent.executeAgentInternal routing & fallback', () => {
    it('fast-paths to Skip: Component Builder when pendingBrainQuestion is active', async () => {
        runViewMock.mockImplementation(async (params: { EntityName: string }) => {
            if (params.EntityName === 'MJ: AI Agent Runs') {
                return {
                    Success: true,
                    Results: [
                        {
                            ID: 'run-prev',
                            Agent: 'Skip: Component Builder',
                            FinalStep: 'Chat',
                            Message: 'Approve the PRD?',
                        },
                    ],
                };
            }
            return { Success: true, Results: [] };
        });
        runQueryMock.mockResolvedValue({ Success: true, Results: [] });
        resolveSubAgentByNameMock.mockReturnValue({
            subAgentEntity: { ID: SKIP_COMPONENT_BUILDER_AGENT_ID, Name: SKIP_COMPONENT_BUILDER_NAME },
        });
        executeNextStepMock.mockResolvedValue({
            step: 'Chat',
            terminate: true,
            message: 'Here is the TDD',
        });

        const localAgent = new SkipLocalAgent() as unknown as {
            executeAgentInternal(p: ExecuteAgentParams, c: AgentConfiguration): Promise<{
                finalStep: BaseAgentNextStep;
                stepCount: number;
            }>;
        };

        const params: ExecuteAgentParams = {
            agent: { ID: SKIP_AGENT_ID, Name: 'Skip' } as never,
            contextUser: USER,
            conversationId: CONVERSATION_ID,
            conversationMessages: [{ role: 'user', content: 'Approved, continue' }],
        };
        const config = { childPrompt: { ID: 'router-prompt' } } as unknown as AgentConfiguration;

        const result = await localAgent.executeAgentInternal(params, config);

        // Did NOT invoke the LLM router prompt — routed deterministically to Skip: Component Builder
        expect(baseExecuteInternalMock).not.toHaveBeenCalled();
        expect(executeNextStepMock).toHaveBeenCalledTimes(1);
        const subAgentDecision = executeNextStepMock.mock.calls[0][2] as BaseAgentNextStep;
        expect(subAgentDecision.step).toBe('Sub-Agent');
        expect(subAgentDecision.subAgent?.name).toBe(SKIP_COMPONENT_BUILDER_NAME);
        expect(subAgentDecision.subAgent?.terminateAfter).toBe(true);
        expect(result.finalStep.message).toBe('Here is the TDD');
    });

    it('fast-paths to Skip: Component Builder on "Build a reusable component for this" escalation trigger', async () => {
        runViewMock.mockResolvedValue({ Success: true, Results: [] });
        runQueryMock.mockResolvedValue({ Success: true, Results: [] });
        resolveSubAgentByNameMock.mockReturnValue({
            subAgentEntity: { ID: SKIP_COMPONENT_BUILDER_AGENT_ID, Name: SKIP_COMPONENT_BUILDER_NAME },
        });
        executeNextStepMock.mockResolvedValue({
            step: 'Success',
            terminate: true,
            message: 'Built interactive component',
        });

        const localAgent = new SkipLocalAgent() as unknown as {
            executeAgentInternal(p: ExecuteAgentParams, c: AgentConfiguration): Promise<{
                finalStep: BaseAgentNextStep;
                stepCount: number;
            }>;
        };

        const params: ExecuteAgentParams = {
            agent: { ID: SKIP_AGENT_ID, Name: 'Skip' } as never,
            contextUser: USER,
            conversationId: CONVERSATION_ID,
            payload: {
                title: 'Active Members by Tier',
                queryName: 'GetActiveMembersByTier',
                categoryPath: 'Golden-Queries/Membership',
                sql: 'SELECT Tier, COUNT(*) FROM vwMembers GROUP BY Tier',
                interpretation: 'Gold tier accounts for 62% of active members.',
            },
            conversationMessages: [{ role: 'user', content: 'Build a reusable component for this' }],
        };
        const config = { childPrompt: { ID: 'router-prompt' } } as unknown as AgentConfiguration;

        const result = await localAgent.executeAgentInternal(params, config);

        expect(baseExecuteInternalMock).not.toHaveBeenCalled();
        expect(executeNextStepMock).toHaveBeenCalledTimes(1);
        expect(result.finalStep.message).toBe('Built interactive component');
        expect((params.data as Record<string, unknown>).routingHint).toEqual({
            intent: 'build',
            confidence: 'high',
        });
        expect((params.data as Record<string, unknown>).promotionContext).toEqual({
            title: 'Active Members by Tier',
            queryName: 'GetActiveMembersByTier',
            categoryPath: 'Golden-Queries/Membership',
            sql: 'SELECT Tier, COUNT(*) FROM vwMembers GROUP BY Tier',
            summary: 'Gold tier accounts for 62% of active members.',
            sourceSubAgent: null,
        });
    });

    it('runs the Loop router prompt when configured and returns its delegated sub-agent result', async () => {
        runViewMock.mockResolvedValue({ Success: true, Results: [] });
        runQueryMock.mockResolvedValue({ Success: true, Results: [] });
        baseExecuteInternalMock.mockResolvedValue({
            finalStep: {
                step: 'Success',
                terminate: true,
                message: 'There are 1,250 active members.',
                payloadArtifactTypeID: 'data-artifact-type-id',
            },
            stepCount: 2,
        });

        const localAgent = new SkipLocalAgent() as unknown as {
            executeAgentInternal(p: ExecuteAgentParams, c: AgentConfiguration): Promise<{
                finalStep: BaseAgentNextStep;
                stepCount: number;
            }>;
        };

        const params: ExecuteAgentParams = {
            agent: { ID: SKIP_AGENT_ID, Name: 'Skip' } as never,
            contextUser: USER,
            conversationId: CONVERSATION_ID,
            conversationMessages: [{ role: 'user', content: 'How many active members do we have?' }],
        };
        const config = { childPrompt: { ID: 'router-prompt' } } as unknown as AgentConfiguration;

        const result = await localAgent.executeAgentInternal(params, config);

        expect(baseExecuteInternalMock).toHaveBeenCalledTimes(1);
        expect((params.data as Record<string, unknown>).skipRouterState).toBeDefined();
        expect(result.finalStep.message).toBe('There are 1,250 active members.');
        expect(result.finalStep.payloadArtifactTypeID).toBe('data-artifact-type-id');
    });

    it('falls back to Skip: Component Builder when the router prompt throws or fails', async () => {
        runViewMock.mockResolvedValue({ Success: true, Results: [] });
        runQueryMock.mockResolvedValue({ Success: true, Results: [] });
        baseExecuteInternalMock.mockRejectedValue(new Error('Router LLM timeout'));
        resolveSubAgentByNameMock.mockReturnValue({
            subAgentEntity: { ID: SKIP_COMPONENT_BUILDER_AGENT_ID, Name: SKIP_COMPONENT_BUILDER_NAME },
        });
        executeNextStepMock.mockResolvedValue({
            step: 'Success',
            terminate: true,
            message: 'Handled by Skip: Component Builder fallback',
        });

        const localAgent = new SkipLocalAgent() as unknown as {
            executeAgentInternal(p: ExecuteAgentParams, c: AgentConfiguration): Promise<{
                finalStep: BaseAgentNextStep;
                stepCount: number;
            }>;
        };

        const params: ExecuteAgentParams = {
            agent: { ID: SKIP_AGENT_ID, Name: 'Skip' } as never,
            contextUser: USER,
            conversationId: CONVERSATION_ID,
            conversationMessages: [{ role: 'user', content: 'Build an executive dashboard' }],
        };
        const config = { childPrompt: { ID: 'router-prompt' } } as unknown as AgentConfiguration;

        const result = await localAgent.executeAgentInternal(params, config);

        expect(baseExecuteInternalMock).toHaveBeenCalledTimes(1);
        expect(executeNextStepMock).toHaveBeenCalledTimes(1);
        expect(result.finalStep.message).toBe('Handled by Skip: Component Builder fallback');
    });
});

// ── 5. SkipProxyAgent.resolveRequestPhase conversation-scoped fallback ──────

describe('SkipProxyAgent.resolveRequestPhase sub-agent conversation fallback', () => {
    it('resolves clarify_question_response from conversationId when lastRunId is absent', async () => {
        runViewMock.mockResolvedValue({
            Success: true,
            Results: [{ ID: 'prior-builder-run', FinalStep: 'Chat' }],
        });

        const proxy = new SkipProxyAgent() as unknown as {
            resolveRequestPhase(
                lastRunId: string | null | undefined,
                contextUser: UserInfo,
                conversationId?: string,
            ): Promise<string>;
        };

        const phase = await proxy.resolveRequestPhase(undefined, USER, CONVERSATION_ID);

        expect(phase).toBe('clarify_question_response');
        expect(runViewMock).toHaveBeenCalledWith(
            expect.objectContaining({
                EntityName: 'MJ: AI Agent Runs',
                ExtraFilter: expect.stringContaining(`ConversationID='${CONVERSATION_ID}'`),
            }),
            USER,
        );
    });
});

// ── 6. SkipSDK.buildArtifacts filtering of local sub-agent artifacts ────────

describe('SkipSDK.buildArtifacts output artifact filtering', () => {
    it('excludes Data, SVG, and Markdown output artifacts while preserving Component artifacts', async () => {
        runQueryMock.mockResolvedValue({
            Success: true,
            Results: [
                {
                    ArtifactID: ARTIFACT_COMP_ID,
                    ArtifactName: 'Sales Pipeline Dashboard',
                    ArtifactDescription: 'Interactive pipeline view',
                    SharingScope: 'None',
                    ArtifactComments: '',
                    ArtifactCreatedAt: '2026-01-01T00:00:00Z',
                    ArtifactUpdatedAt: '2026-01-01T00:00:00Z',
                    ArtifactTypeID: 'type-comp',
                    ArtifactTypeName: 'Component',
                    ArtifactTypeDescription: 'Component',
                    ArtifactTypeContentType: 'application/vnd.mj.component',
                    ArtifactTypeCreatedAt: '2026-01-01T00:00:00Z',
                    ArtifactTypeUpdatedAt: '2026-01-01T00:00:00Z',
                    VersionID: 'ver-comp-1',
                    ConversationDetailID: DETAIL_ID,
                    Version: 1,
                    Configuration: '{}',
                    Content: '{"name":"SalesPipelineDashboard"}',
                    VersionComments: '',
                    VersionCreatedAt: '2026-01-01T00:00:00Z',
                    VersionUpdatedAt: '2026-01-01T00:00:00Z',
                },
                {
                    ArtifactID: ARTIFACT_DATA_ID,
                    ArtifactName: 'Top Deals Table',
                    ArtifactTypeName: 'Data',
                    VersionID: 'ver-data-1',
                    Version: 1,
                    Content: '{"rows":[]}',
                },
                {
                    ArtifactID: ARTIFACT_SVG_ID,
                    ArtifactName: 'Deals Bar Chart',
                    ArtifactTypeName: 'SVG',
                    VersionID: 'ver-svg-1',
                    Version: 1,
                    Content: '<svg></svg>',
                },
            ],
        });
        // No input artifacts in this test
        runViewMock.mockResolvedValue({ Success: true, Results: [] });

        const sdk = new SkipSDK({ baseUrl: 'https://api.askskip.ai', apiKey: 'test-key' }) as unknown as {
            buildArtifacts(contextUser: UserInfo, conversationId?: string): Promise<Array<{ id: string; name: string; artifactType: { name: string } }>>;
        };

        const artifacts = await sdk.buildArtifacts(USER, CONVERSATION_ID);

        expect(artifacts).toHaveLength(1);
        expect(artifacts[0].id).toBe(ARTIFACT_COMP_ID);
        expect(artifacts[0].artifactType.name).toBe('Component');
    });
});
