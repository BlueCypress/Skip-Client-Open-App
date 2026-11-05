/**
 * @fileoverview SkipLocalAgent — Local orchestrator and router for `@skip`.
 *
 * Registered via `@RegisterClass(BaseAgent, 'SkipLocalAgent')`. When a user invokes
 * `@skip`, `SkipLocalAgent`:
 * 1. Computes a deterministic `SkipRouterState` block summarizing conversation artifacts,
 *    active ComponentSpec payload stage, pending Skip Brain clarifying questions, and
 *    recent sub-agent delegations, and injects it into `params.data.skipRouterState`.
 * 2. Applies deterministic fast-path routing when an active Brain clarifying question,
 *    attached component refinement, or explicit component escalation trigger is present.
 * 3. Runs the configured Loop router prompt (when seeded) to dispatch to one of the 5
 *    sub-agents (`Skip: Component Builder`, `Skip: Data Answerer`, `Skip: Analyst`,
 *    `Skip: Schema Guide`, `Skip: Visualizer`) with `terminateAfter: true`.
 * 4. Automatically falls back to `Skip: Component Builder` (`SkipProxyAgent`) if no
 *    router prompt is configured yet or if the router prompt execution fails.
 */

import { BaseAgent } from '@memberjunction/ai-agents';
import {
    ExecuteAgentParams,
    AgentConfiguration,
    BaseAgentNextStep,
} from '@memberjunction/ai-core-plus';
import { RegisterClass, IsValidUUID } from '@memberjunction/global';
import { LogStatus, LogError, RunView, RunQuery, UserInfo } from '@memberjunction/core';
import { AIEngine } from '@memberjunction/aiengine';
import { SKIP_AGENT_ID, SKIP_COMPONENT_BUILDER_AGENT_ID } from '@askskip/core';
import { SkipProxyAgent, SkipAgentContext } from './skip-agent.js';

export const SKIP_COMPONENT_BUILDER_NAME = 'Skip: Component Builder';
export const SKIP_DATA_ANSWERER_NAME = 'Skip: Data Answerer';
export const SKIP_ANALYST_NAME = 'Skip: Analyst';
export const SKIP_SCHEMA_GUIDE_NAME = 'Skip: Schema Guide';
export const SKIP_VISUALIZER_NAME = 'Skip: Visualizer';

/**
 * Compact deterministic state block injected into the router prompt as
 * `params.data.skipRouterState`.
 */
export interface SkipRouterState {
    /** Present when the user explicitly attached or referenced a specific Component artifact on this turn. */
    attachedComponent: { id: string; name: string; version: number } | null;
    /** Compact roster of Component artifacts produced earlier in this conversation (not automatically active). */
    componentRoster: Array<{ id: string; name: string; latestVersion: number; turnIndex: number }>;
    /** True when the current turn includes a captured Data Snapshot input artifact (`Analyze` button). */
    hasDataSnapshot: boolean;
    /** Non-null when the immediately preceding turn parked on a Brain clarifying question / PRD / TDD checkpoint. */
    pendingBrainQuestion: string | null;
    /** Stage of the active ComponentSpec draft in the conversation payload, if any. */
    payloadStage: 'none' | 'prd' | 'tdd' | 'complete';
    /** Name of the sub-agent that handled the previous turn, if any. */
    lastDelegate: string | null;
}

interface AgentRunSummaryRow {
    ID: string;
    Agent: string | null;
    FinalStep: string | null;
    Message: string | null;
}

interface ConversationArtifactRow {
    ArtifactID: string;
    ArtifactName: string;
    ArtifactTypeName?: string;
    Version: number;
    ConversationDetailID?: string;
}

interface InputArtifactLinkRow {
    ConversationDetailID: string;
    ArtifactVersionID: string;
    Direction: string;
}

interface ArtifactVersionLookupRow {
    ID: string;
    ArtifactID: string;
    Artifact: string | null;
    VersionNumber: number;
    ArtifactType: string | null;
}

function isValidUUID(value: unknown): value is string {
    return typeof value === 'string' && IsValidUUID(value);
}

/**
 * Determine the stage of a ComponentSpec payload object, if any.
 */
export function detectPayloadStage(payload: unknown): 'none' | 'prd' | 'tdd' | 'complete' {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return 'none';
    }
    const record = payload as Record<string, unknown>;

    const hasCode = typeof record.code === 'string' && record.code.trim().length > 0;
    const hasComponents = Array.isArray(record.components) && record.components.length > 0;
    if (hasCode || hasComponents) {
        return 'complete';
    }

    const hasTechnicalDesign =
        typeof record.technicalDesign === 'string' && record.technicalDesign.trim().length > 0;
    const hasDataRequirements =
        record.dataRequirements !== null &&
        typeof record.dataRequirements === 'object' &&
        Object.keys(record.dataRequirements as Record<string, unknown>).length > 0;
    if (hasTechnicalDesign || hasDataRequirements) {
        return 'tdd';
    }

    const hasFunctionalRequirements =
        typeof record.functionalRequirements === 'string' &&
        record.functionalRequirements.trim().length > 0;
    const hasNameOrTitle =
        (typeof record.name === 'string' && record.name.trim().length > 0) ||
        (typeof record.title === 'string' && record.title.trim().length > 0);
    if (hasFunctionalRequirements || hasNameOrTitle) {
        return 'prd';
    }

    return 'none';
}

/**
 * Check whether user message text contains an explicit escalation trigger for
 * `Skip: Component Builder` (e.g. clicking the `"Build a reusable component for this"`
 * actionable command button or `[component]` tag).
 */
export function isExplicitComponentEscalation(messageText: string | null | undefined): boolean {
    if (!messageText) {
        return false;
    }
    return (
        /\bbuild a reusable component for this\b/i.test(messageText) ||
        /\[component\]/i.test(messageText)
    );
}

/**
 * Check whether user message text explicitly cancels or abandons an in-progress
 * component build checkpoint.
 */
export function isExplicitBuildCancellation(messageText: string | null | undefined): boolean {
    if (!messageText) {
        return false;
    }
    return /^\s*(cancel|stop|never\s*mind|nevermind|forget\s+it|abandon)\b/i.test(messageText);
}

@RegisterClass(BaseAgent, 'SkipLocalAgent')
export class SkipLocalAgent extends BaseAgent {
    /**
     * Execute the Skip local orchestrator/router agent.
     */
    protected override async executeAgentInternal<P = any>(
        params: ExecuteAgentParams,
        config: AgentConfiguration,
    ): Promise<{
        finalStep: BaseAgentNextStep<P>;
        stepCount: number;
    }> {
        const context = (params.data || {}) as SkipAgentContext & {
            skipRouterState?: SkipRouterState;
            attachedComponent?: { id: string; name: string; version: number } | null;
            hasDataSnapshot?: boolean;
        };
        const conversationId = params.conversationId || context.conversationId;

        if (!params.contextUser) {
            const errorMsg = 'ContextUser is required for Skip agent execution';
            LogError(`[SkipLocalAgent] ${errorMsg}`);
            return {
                finalStep: {
                    terminate: true,
                    step: 'Failed',
                    message: errorMsg,
                    errorMessage: errorMsg,
                } as BaseAgentNextStep<P>,
                stepCount: 0,
            };
        }

        // Ensure conversationId is propagated on both params and params.data so any
        // child sub-agent (including Skip: Component Builder) can read it.
        if (conversationId) {
            params.conversationId = conversationId;
        }

        const routerState = await this.buildRouterState(conversationId, params);
        params.data = {
            ...(params.data || {}),
            ...(conversationId ? { conversationId } : {}),
            skipRouterState: routerState,
        };

        const latestUserText = this.getLatestUserMessageText(params);

        // Fast-path 1: Active Brain clarifying question / PRD / TDD checkpoint continuation
        if (routerState.pendingBrainQuestion && !isExplicitBuildCancellation(latestUserText)) {
            LogStatus(
                `[SkipLocalAgent] Fast-path routing to "${SKIP_COMPONENT_BUILDER_NAME}" (pendingBrainQuestion continuation).`,
            );
            return await this.delegateToComponentBuilder(
                params,
                config,
                'Continuing active Skip: Component Builder clarifying question / specification checkpoint.',
            );
        }

        // Fast-path 2: Explicit escalation trigger ("Build a reusable component for this" or [component])
        if (isExplicitComponentEscalation(latestUserText)) {
            LogStatus(
                `[SkipLocalAgent] Fast-path routing to "${SKIP_COMPONENT_BUILDER_NAME}" (explicit component escalation trigger).`,
            );
            return await this.delegateToComponentBuilder(
                params,
                config,
                'User explicitly requested building a reusable interactive component.',
            );
        }

        // Fast-path 3: User explicitly attached a Component artifact to refine on this turn
        if (routerState.attachedComponent) {
            LogStatus(
                `[SkipLocalAgent] Fast-path routing to "${SKIP_COMPONENT_BUILDER_NAME}" (attached component "${routerState.attachedComponent.name}" v${routerState.attachedComponent.version}).`,
            );
            return await this.delegateToComponentBuilder(
                params,
                config,
                `User attached component "${routerState.attachedComponent.name}" (v${routerState.attachedComponent.version}) for modification.`,
            );
        }

        // Standard path: Run the Loop router prompt when configured on the Skip agent
        if (config?.childPrompt) {
            try {
                const result = await super.executeAgentInternal<P>(params, config);
                if (result?.finalStep && result.finalStep.step !== 'Failed') {
                    return result;
                }
                LogError(
                    `[SkipLocalAgent] Router prompt execution returned Failed (${result?.finalStep?.errorMessage ?? 'unknown error'}); falling back to "${SKIP_COMPONENT_BUILDER_NAME}".`,
                );
            } catch (error) {
                LogError(
                    `[SkipLocalAgent] Router execution threw an error (${error instanceof Error ? error.message : String(error)}); falling back to "${SKIP_COMPONENT_BUILDER_NAME}".`,
                );
            }
        } else {
            LogStatus(
                `[SkipLocalAgent] No router prompt configured on Skip agent; falling back directly to "${SKIP_COMPONENT_BUILDER_NAME}".`,
            );
        }

        return await this.delegateToComponentBuilder(
            params,
            config,
            'Fallback delegation to Skip: Component Builder.',
        );
    }

    /**
     * Build the deterministic `SkipRouterState` for the current conversation turn.
     */
    public async buildRouterState(
        conversationId: string | undefined,
        params: ExecuteAgentParams,
    ): Promise<SkipRouterState> {
        const context = (params.data || {}) as {
            attachedComponent?: { id: string; name: string; version: number } | null;
            hasDataSnapshot?: boolean;
        };

        const state: SkipRouterState = {
            attachedComponent: context.attachedComponent ?? null,
            componentRoster: [],
            hasDataSnapshot: Boolean(context.hasDataSnapshot),
            pendingBrainQuestion: null,
            payloadStage: detectPayloadStage(params.payload),
            lastDelegate: null,
        };

        if (!params.contextUser) {
            return state;
        }

        // 1. Resolve prior run state (pendingBrainQuestion & lastDelegate)
        await this.populatePriorRunState(conversationId, params, state);

        // 2. Resolve conversation component roster, attached component, and data snapshot flag
        if (isValidUUID(conversationId)) {
            await this.populateArtifactState(conversationId, params, state);
        }

        return state;
    }

    /**
     * Populate `pendingBrainQuestion` and `lastDelegate` from prior agent runs in the conversation.
     */
    private async populatePriorRunState(
        conversationId: string | undefined,
        params: ExecuteAgentParams,
        state: SkipRouterState,
    ): Promise<void> {
        const contextUser = params.contextUser;
        if (!contextUser) {
            return;
        }

        try {
            const rv = new RunView();

            if (isValidUUID(conversationId)) {
                const currentRunId = this.AgentRun?.ID;
                const excludeCurrent = isValidUUID(currentRunId) ? ` AND ID<>'${currentRunId}'` : '';
                const runsResult = await rv.RunView<AgentRunSummaryRow>(
                    {
                        EntityName: 'MJ: AI Agent Runs',
                        ExtraFilter: `ConversationID='${conversationId}' AND Status='Completed'${excludeCurrent}`,
                        OrderBy: 'CompletedAt DESC, __mj_CreatedAt DESC',
                        MaxRows: 10,
                        Fields: ['ID', 'Agent', 'FinalStep', 'Message'],
                        ResultType: 'simple',
                    },
                    contextUser,
                );

                const runs = runsResult.Success ? (runsResult.Results ?? []) : [];

                // Find most recent sub-agent delegate
                const lastSubAgentRun = runs.find(
                    (r) => typeof r.Agent === 'string' && r.Agent.startsWith('Skip: '),
                );
                if (lastSubAgentRun?.Agent) {
                    state.lastDelegate = lastSubAgentRun.Agent;
                }

                // Check most recent Skip / Skip: Component Builder run for FinalStep === 'Chat'
                const latestSkipOrBuilderRun = runs.find(
                    (r) => r.Agent === SKIP_COMPONENT_BUILDER_NAME || r.Agent === 'Skip',
                );
                if (latestSkipOrBuilderRun?.FinalStep === 'Chat') {
                    state.pendingBrainQuestion =
                        latestSkipOrBuilderRun.Message?.trim() ||
                        this.getLatestAssistantMessageText(params) ||
                        'Pending clarifying question from Skip: Component Builder';
                    return;
                }
            }

            // Fallback: check explicit lastRunId if provided
            const lastRunId = params.lastRunId ?? this.AgentRun?.LastRunID;
            if (isValidUUID(lastRunId)) {
                const lastRunResult = await rv.RunView<AgentRunSummaryRow>(
                    {
                        EntityName: 'MJ: AI Agent Runs',
                        ExtraFilter: `ID='${lastRunId}'`,
                        MaxRows: 1,
                        Fields: ['ID', 'Agent', 'FinalStep', 'Message'],
                        ResultType: 'simple',
                    },
                    contextUser,
                );
                const lastRun = lastRunResult.Success ? lastRunResult.Results?.[0] : undefined;
                if (lastRun?.FinalStep === 'Chat') {
                    state.pendingBrainQuestion =
                        lastRun.Message?.trim() ||
                        this.getLatestAssistantMessageText(params) ||
                        'Pending clarifying question from Skip: Component Builder';
                }
            }
        } catch (error) {
            LogError(`[SkipLocalAgent] Could not populate prior run state: ${error}`);
        }
    }

    /**
     * Populate `componentRoster`, `attachedComponent`, and `hasDataSnapshot` from conversation artifacts.
     */
    private async populateArtifactState(
        conversationId: string,
        params: ExecuteAgentParams,
        state: SkipRouterState,
    ): Promise<void> {
        const contextUser = params.contextUser;
        if (!contextUser) {
            return;
        }

        try {
            let skipAgentId = SKIP_AGENT_ID;
            try {
                await AIEngine.Instance.Config(false, contextUser);
                skipAgentId = AIEngine.Instance.GetAgentByName('Skip')?.ID || SKIP_AGENT_ID;
            } catch {
                // Keep default SKIP_AGENT_ID if AIEngine is unavailable in unit tests
            }

            const rq = new RunQuery();
            const queryResult = await rq.RunQuery(
                {
                    QueryName: 'GetConversationArtifactsForAgent',
                    CategoryPath: 'MJ/Conversations',
                    Parameters: {
                        ConversationID: conversationId,
                        AgentID: skipAgentId,
                    },
                },
                contextUser,
            );

            if (queryResult.Success && Array.isArray(queryResult.Results)) {
                const rosterMap = new Map<
                    string,
                    { id: string; name: string; latestVersion: number; turnIndex: number }
                >();
                let turnCounter = 0;

                for (const row of queryResult.Results as ConversationArtifactRow[]) {
                    if (row.ArtifactTypeName && row.ArtifactTypeName.trim().toLowerCase() !== 'component') {
                        continue;
                    }
                    const artifactId = row.ArtifactID;
                    if (!artifactId) {
                        continue;
                    }
                    turnCounter++;
                    const existing = rosterMap.get(artifactId);
                    const version = typeof row.Version === 'number' ? row.Version : 1;
                    if (!existing) {
                        rosterMap.set(artifactId, {
                            id: artifactId,
                            name: row.ArtifactName || 'Component',
                            latestVersion: version,
                            turnIndex: turnCounter,
                        });
                    } else if (version >= existing.latestVersion) {
                        existing.latestVersion = version;
                        existing.turnIndex = turnCounter;
                        if (row.ArtifactName) {
                            existing.name = row.ArtifactName;
                        }
                    }
                }

                state.componentRoster = Array.from(rosterMap.values());

                // If caller explicitly passed sourceArtifactId matching a Component artifact on this turn
                const sourceArtifactId =
                    (params as ExecuteAgentParams & { sourceArtifactId?: string }).sourceArtifactId ??
                    (params.data as { sourceArtifactId?: string } | undefined)?.sourceArtifactId;
                if (!state.attachedComponent && isValidUUID(sourceArtifactId)) {
                    const matched = rosterMap.get(sourceArtifactId);
                    if (matched) {
                        state.attachedComponent = {
                            id: matched.id,
                            name: matched.name,
                            version: matched.latestVersion,
                        };
                    }
                }
            }

            // Check latest user turn's input artifacts for Data Snapshot or attached Component
            const latestUserDetailId = this.getLatestUserConversationDetailId(params);
            if (isValidUUID(latestUserDetailId)) {
                const rv = new RunView();
                const linksResult = await rv.RunView<InputArtifactLinkRow>(
                    {
                        EntityName: 'MJ: Conversation Detail Artifacts',
                        ExtraFilter: `ConversationDetailID='${latestUserDetailId}' AND Direction='Input'`,
                        Fields: ['ConversationDetailID', 'ArtifactVersionID', 'Direction'],
                        ResultType: 'simple',
                    },
                    contextUser,
                );

                const links = linksResult.Success ? (linksResult.Results ?? []) : [];
                const versionIds = links
                    .map((l) => l.ArtifactVersionID)
                    .filter((id): id is string => isValidUUID(id));

                if (versionIds.length > 0) {
                    const versionsResult = await rv.RunView<ArtifactVersionLookupRow>(
                        {
                            EntityName: 'MJ: Artifact Versions',
                            ExtraFilter: `ID IN (${versionIds.map((id) => `'${id}'`).join(',')})`,
                            Fields: ['ID', 'ArtifactID', 'Artifact', 'VersionNumber', 'ArtifactType'],
                            ResultType: 'simple',
                        },
                        contextUser,
                    );
                    const versions = versionsResult.Success ? (versionsResult.Results ?? []) : [];
                    for (const v of versions) {
                        const typeName = (v.ArtifactType || '').trim().toLowerCase();
                        if (typeName === 'data snapshot') {
                            state.hasDataSnapshot = true;
                        } else if (typeName === 'component' && !state.attachedComponent) {
                            state.attachedComponent = {
                                id: v.ArtifactID,
                                name: v.Artifact || 'Component',
                                version: v.VersionNumber || 1,
                            };
                        }
                    }
                }
            }
        } catch (error) {
            LogError(`[SkipLocalAgent] Could not populate artifact state: ${error}`);
        }
    }

    /**
     * Delegate execution to `Skip: Component Builder` (`SkipProxyAgent`).
     *
     * Uses standard MJ sub-agent dispatch (`executeNextStep` with `step: 'Sub-Agent'` and
     * `terminateAfter: true`) when `Skip: Component Builder` is resolvable as a sub-agent,
     * and falls back to invoking `SkipProxyAgent` directly if sub-agent metadata is not yet
     * loaded in `AIEngine`.
     */
    protected async delegateToComponentBuilder<P = any>(
        params: ExecuteAgentParams,
        config: AgentConfiguration,
        reasoning: string,
    ): Promise<{
        finalStep: BaseAgentNextStep<P>;
        stepCount: number;
    }> {
        const resolved =
            typeof this.resolveSubAgentByName === 'function'
                ? this.resolveSubAgentByName(params, SKIP_COMPONENT_BUILDER_NAME)
                : undefined;

        if (resolved && typeof this.executeNextStep === 'function') {
            const subAgentDecision: BaseAgentNextStep<P> = {
                step: 'Sub-Agent',
                terminate: false,
                reasoning,
                subAgent: {
                    name: SKIP_COMPONENT_BUILDER_NAME,
                    message: this.getLatestUserMessageText(params) || reasoning,
                    terminateAfter: true,
                },
                previousPayload: params.payload,
                newPayload: params.payload,
            };

            const finalStep = await this.executeNextStep<P>(params, config, subAgentDecision, 1);
            return {
                finalStep,
                stepCount: 1,
            };
        }

        // Direct fallback when Skip: Component Builder is not yet in AIEngine's sub-agent cache
        const proxy = new SkipProxyAgent();
        const proxyInternal = proxy as unknown as {
            executeAgentInternal(
                p: ExecuteAgentParams,
                c: AgentConfiguration,
            ): Promise<{ finalStep: BaseAgentNextStep<P>; stepCount: number }>;
        };
        const result = await proxyInternal.executeAgentInternal(params, config);
        const stepWithArtifactType = result?.finalStep as
            | (BaseAgentNextStep<P> & { payloadArtifactTypeID?: string })
            | undefined;
        if (stepWithArtifactType && !stepWithArtifactType.payloadArtifactTypeID) {
            const componentBuilderAgent = resolved?.subAgentEntity;
            if (componentBuilderAgent?.DefaultArtifactTypeID) {
                stepWithArtifactType.payloadArtifactTypeID = componentBuilderAgent.DefaultArtifactTypeID;
            }
        }
        return result;
    }

    private getLatestUserMessageText(params: ExecuteAgentParams): string | null {
        const messages = params.conversationMessages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                const content = messages[i].content;
                return typeof content === 'string' ? content : JSON.stringify(content);
            }
        }
        return null;
    }

    private getLatestAssistantMessageText(params: ExecuteAgentParams): string | null {
        const messages = params.conversationMessages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant' || messages[i].role === 'system') {
                const content = messages[i].content;
                return typeof content === 'string' ? content : JSON.stringify(content);
            }
        }
        return null;
    }

    private getLatestUserConversationDetailId(params: ExecuteAgentParams): string | null {
        const messages = params.conversationMessages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                const detailId = messages[i].metadata?.conversationDetailID;
                return typeof detailId === 'string' ? detailId : null;
            }
        }
        return null;
    }
}

export { SKIP_COMPONENT_BUILDER_AGENT_ID };
