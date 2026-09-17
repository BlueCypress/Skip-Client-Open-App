/**
 * Skip Proxy Agent
 *
 * A proxy agent that integrates Skip SaaS API into the MemberJunction agent framework.
 * This agent acts as a bridge, allowing Skip to be invoked like any other MJ agent
 * while maintaining compatibility with the existing Skip infrastructure.
 */

import { BaseAgent } from "@memberjunction/ai-agents";
import {
    ExecuteAgentParams,
    AgentConfiguration,
    BaseAgentNextStep
} from "@memberjunction/ai-core-plus";
import {
    SkipAPIResponse,
    SkipAPIAnalysisCompleteResponse,
    SkipAPIClarifyingQuestionResponse,
    SkipMessage,
    SkipRequestPhase
} from "@askskip/types";
import { isValidUUID, requireValidUUID } from "./uuid-guard.js";
import { SkipSDK, SkipCallOptions } from "./skip-sdk.js";
import { DataContext } from "@memberjunction/data-context";
import { LogStatus, LogError, RunView, UserInfo } from "@memberjunction/core";
import { ChatMessage } from "@memberjunction/ai";
import { RegisterClass } from "@memberjunction/global";
import { ComponentOption, ComponentSpec } from "@memberjunction/interactive-component-types";
import type { MJConversationDetailEntity } from "@memberjunction/core-entities";
import type mssql from "mssql";

/**
 * Context type for Skip agent execution
 */
export interface SkipAgentContext {
    /**
     * Optional data context ID to load
     */
    dataContextId?: string;

    /**
     * Optional pre-loaded data context
     */
    dataContext?: DataContext;

    /**
     * Conversation ID for tracking Skip conversations. On conversation-driven runs the
     * MJ framework injects the authoritative ID into `params.data.conversationId`, which
     * takes precedence; this field is the fallback for programmatic callers that invoke
     * the agent outside a conversation context.
     */
    conversationId?: string;

    /**
     * Force entity metadata refresh
     */
    forceEntityRefresh?: boolean;

    /**
     * Database connection (injected by caller)
     */
    dataSource?: mssql.ConnectionPool;
}

/**
 * Payload returned from Skip agent execution
 * Contains the full Skip API response for downstream consumers
 */
export interface SkipAgentPayload {
    /**
     * The full Skip API response
     */
    skipResponse: SkipAPIResponse;

    /**
     * Response phase from Skip
     */
    responsePhase: string;

    /**
     * Conversation ID
     */
    conversationId: string;

    /**
     * User-facing message (title or clarifying question)
     */
    message?: string;
}

/**
 * Skip Proxy Agent
 *
 * This agent provides a simple proxy to the Skip SaaS API, allowing Skip to be
 * invoked through the standard MJ agent framework. It handles:
 * - Converting MJ conversation messages to Skip format
 * - Streaming progress updates from Skip
 * - Mapping Skip responses to MJ agent next steps
 * - Returning full Skip responses in the payload
 */
@RegisterClass(BaseAgent, 'SkipProxyAgent')
export class SkipProxyAgent extends BaseAgent {
    private skipSDK: SkipSDK;

    constructor() {
        super();
        this.skipSDK = new SkipSDK();
    }

    /**
     * Execute the Skip agent - proxies to Skip SaaS API
     */
    protected override async executeAgentInternal<P = SkipAgentPayload>(
        params: ExecuteAgentParams<SkipAgentContext, P>,
        config: AgentConfiguration
    ): Promise<{ finalStep: BaseAgentNextStep<P>; stepCount: number; }> {

        LogStatus(`[SkipProxyAgent] Starting Skip agent execution`);

        // Extract context
        const context = params.context || {} as SkipAgentContext;
        // Framework-injected data.conversationId is authoritative on conversation-driven
        // runs; context.conversationId covers programmatic callers (see SkipAgentContext).
        const conversationId: string | undefined = params.data?.conversationId ?? context.conversationId;

        if (!params.contextUser) {
            LogError('[SkipProxyAgent] contextUser is required');
            return {
                finalStep: {
                    terminate: true,
                    step: 'Failed',
                    message: 'Missing required contextUser',
                    errorMessage: 'Missing required contextUser'
                } as BaseAgentNextStep<P>,
                stepCount: 1
            };
        }

        // Lazily resolve the Skip API key (e.g. from the encrypted credential store)
        // now that we have a context user, before any Skip call is made.
        await this.skipSDK.ensureConfig(params.contextUser);

        // Load conversation messages from database if conversationId is provided
        // This ensures we get real UUIDs from MJConversationDetailEntity records
        let skipMessages: SkipMessage[];
        if (conversationId && params.contextUser) {
            skipMessages = await this.loadMessagesFromDatabase(conversationId, params.contextUser);
        } else {
            // Fallback to converting provided conversation messages
            skipMessages = this.convertMessagesToSkipFormat(params.conversationMessages || []);
        }

        const requestPhase = await this.resolveRequestPhase(
            params.lastRunId ?? this.AgentRun?.LastRunID,
            params.contextUser
        );

        // Prepare Skip SDK call options
        const skipOptions: SkipCallOptions = {
            payload: params.payload,
            messages: skipMessages,
            conversationId,
            dataContext: context.dataContext,
            requestPhase,
            contextUser: params.contextUser,
            dataSource: context.dataSource,
            includeEntities: true,
            includeQueries: true,
            includeNotes: true,
            includeRequests: false,
            forceEntityRefresh: context.forceEntityRefresh || false,
            includeCallbackAuth: true,
            externalReferenceID: this.AgentRun?.ID ?? undefined,
            onStatusUpdate: (message: string, responsePhase?: string) => {
                // Forward Skip status updates to MJ progress callback
                if (params.onProgress) {
                    params.onProgress({
                        step: 'prompt_execution', // Skip execution is essentially a prompt to an external service
                        message,
                        percentage: 0, // Skip doesn't provide percentage
                        metadata: {
                            conversationId,
                            responsePhase
                        }
                    });
                }
            }
        };

        // Call Skip API
        const result = await this.skipSDK.chat(skipOptions);

        // Only a call that produced NO response body is a transport failure — HTTP error,
        // socket drop, malformed stream, nothing came back at all. Those have nothing to
        // say to the user beyond the SDK's own message, so they short-circuit here.
        //
        // A Skip-reported failure is not one of those. It arrives as a complete response
        // whose messages carry the prose Skip composed for this request in its Failure
        // Finalization step; only `success` is false. `SkipSDK.chat` flattens that case to
        // `success: false` with `error` set to the internal `errorDetail.message`, so
        // gating on `result.success` here discarded the response — and with it the only
        // user-readable account of the failure — before `handleSkipError` could route it,
        // leaving the user to read "Pipeline failed at step 'Execute Sub-Agent: …'".
        if (!result.response) {
            const errorMsg = result.error || 'No response received from Skip API';
            LogError(`[SkipProxyAgent] Skip API call failed: ${errorMsg}`);
            return {
                finalStep: {
                    terminate: true,
                    step: 'Failed',
                    message: errorMsg,
                    errorMessage: errorMsg
                } as BaseAgentNextStep<P>,
                stepCount: 1
            };
        }

        // Map Skip response to MJ agent next step
        const nextStep = this.mapSkipResponseToNextStep(result.response, conversationId);

        LogStatus(`[SkipProxyAgent] Skip execution completed with phase: ${result.responsePhase}`);

        return {
            finalStep: nextStep as BaseAgentNextStep<P>,
            stepCount: 1 // Skip is a single-step proxy
        };
    }

    /**
     * Determine the request phase for this run. The previous run in the chain records
     * FinalStep='Chat' only when handleClarifyingQuestion terminated it — the sole
     * 'Chat' path in this agent — so a run chained after one carries the user's answer
     * to Skip's clarifying question and must be sent as 'clarify_question_response'.
     */
    private async resolveRequestPhase(
        lastRunId: string | null | undefined,
        contextUser: UserInfo
    ): Promise<SkipRequestPhase> {
        if (!isValidUUID(lastRunId)) {
            return 'initial_request';
        }

        try {
            const rv = new RunView();
            const result = await rv.RunView<{ FinalStep: string | null }>({
                EntityName: 'MJ: AI Agent Runs',
                ExtraFilter: `ID='${lastRunId}'`,
                Fields: ['ID', 'FinalStep'],
                ResultType: 'simple'
            }, contextUser);

            const lastRun = result.Success ? result.Results?.[0] : undefined;
            return lastRun?.FinalStep === 'Chat' ? 'clarify_question_response' : 'initial_request';
        } catch (error) {
            LogError(`[SkipProxyAgent] Could not resolve prior run ${lastRunId} for request phase: ${error}`);
            return 'initial_request';
        }
    }

    /**
     * Load conversation messages from database with real UUIDs using MemberJunction's RunView pattern
     * This is the preferred method as it ensures all messages have proper conversationDetailIDs
     */
    private async loadMessagesFromDatabase(conversationId: string, contextUser: UserInfo): Promise<SkipMessage[]> {
        try {
            // conversationId is caller-supplied — a validated UUID cannot carry SQL injection payloads
            const safeConversationId = requireValidUUID(conversationId, 'SkipProxyAgent conversationId');

            const rv = new RunView();
            const result = await rv.RunView<MJConversationDetailEntity>({
                EntityName: 'MJ: Conversation Details',
                ExtraFilter: `ConversationID='${safeConversationId}'`,
                OrderBy: '__mj_CreatedAt ASC'
            }, contextUser);

            if (!result.Success) {
                throw new Error(`Failed to load conversation details: ${result.ErrorMessage}`);
            }

            const allMessages = (result.Results || [])
                // 'Error'-role rows are failure records, not conversation content — they
                // must never reach Skip (they used to be sent as user messages).
                .filter((r) => (r.Role || '').trim().toLowerCase() !== 'error')
                .map((r) => this.mapConversationDetailToSkipMessage(r));

            // Find the index of the last user message
            // We only want to include messages up to and including the most recent user message
            // This filters out status messages and incomplete AI responses
            const lastUserMessageIndex = allMessages.reduce((lastIndex, msg, currentIndex) => {
                return msg.role === 'user' ? currentIndex : lastIndex;
            }, -1);

            if (lastUserMessageIndex === -1) {
                // No user messages found, return all messages (shouldn't happen in practice)
                return allMessages;
            }

            // Return messages up to and including the last user message
            return allMessages.slice(0, lastUserMessageIndex + 1);
        } catch (error) {
            LogError(`[SkipProxyAgent] Error loading messages from database: ${error}`);
            throw error;
        }
    }

    /**
     * Map a conversation detail row to a Skip message. System messages carry the raw
     * stored Message — Skip Brain needs the full content to extract component specs
     * for modification.
     */
    private mapConversationDetailToSkipMessage(r: MJConversationDetailEntity): SkipMessage {
        const dbRole = (r.Role || '').trim().toLowerCase();
        const skipRole: 'user' | 'system' =
            (dbRole === 'ai' || dbRole === 'system' || dbRole === 'assistant') ? 'system' : 'user';

        return {
            content: r.Message,
            role: skipRole,
            conversationDetailID: r.ID,
            hiddenToUser: r.HiddenToUser,
            userRating: r.UserRating ?? undefined,
            userFeedback: r.UserFeedback ?? undefined,
            reflectionInsights: r.ReflectionInsights ?? undefined,
            summaryOfEarlierConveration: r.SummaryOfEarlierConversation ?? undefined,
            createdAt: r.__mj_CreatedAt,
            updatedAt: r.__mj_UpdatedAt,
        };
    }

    /**
     * Convert MJ ChatMessage format to Skip SkipMessage format
     * This is a fallback method when database loading is not available
     */
    private convertMessagesToSkipFormat(messages: ChatMessage[]): SkipMessage[] {
        return messages.map((msg, index) => {
            // Extract conversationDetailID from metadata if available
            const conversationDetailID = msg.metadata?.conversationDetailID || `temp-${index}`;

            return {
                // Skip only accepts 'user' or 'system' roles, map 'assistant' to 'system'
                role: (msg.role === 'assistant' ? 'system' : msg.role) as 'user' | 'system',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                conversationDetailID,
                // Include other SkipMessage fields from metadata if available
                hiddenToUser: msg.metadata?.hiddenToUser,
                userRating: msg.metadata?.userRating,
                userFeedback: msg.metadata?.userFeedback,
                reflectionInsights: msg.metadata?.reflectionInsights,
                summaryOfEarlierConveration: msg.metadata?.summaryOfEarlierConversation,
                createdAt: msg.metadata?.createdAt,
                updatedAt: msg.metadata?.updatedAt
            };
        });
    }

    /**
     * Map Skip API response to MJ agent next step.
     *
     * Checks for Skip-level errors first, then delegates to phase-specific handlers.
     */
    private mapSkipResponseToNextStep(
        apiResponse: SkipAPIResponse,
        conversationId: string
    ): BaseAgentNextStep<ComponentSpec> {
      // Check if Skip reported an error (success: false with any responsePhase)
      if (!apiResponse.success) {
          return this.handleSkipError(apiResponse);
      }

      switch (apiResponse.responsePhase) {
        case 'analysis_complete':
            return this.handleAnalysisComplete(apiResponse as SkipAPIAnalysisCompleteResponse);

        case 'clarifying_question':
            return this.handleClarifyingQuestion(apiResponse as SkipAPIClarifyingQuestionResponse);

        default: {
            const msg = `Unexpected Skip response phase: ${apiResponse.responsePhase}`;
            LogError(`[SkipProxyAgent] ${msg}`);
            return {
                terminate: true,
                step: 'Failed',
                message: msg,
                errorMessage: msg,
                newPayload: undefined
            };
        }
      }
    }

    /**
     * Handle Skip error responses.
     *
     * A failure response carries two different accounts of what went wrong, and they
     * are not interchangeable:
     *
     *   - the **last system message** is prose Skip composed for this specific request
     *     — what it was attempting, and what the user might try instead
     *   - **`errorDetail.message`** is the diagnostic: internal pipeline language such
     *     as `Pipeline failed at step 'Execute Sub-Agent: Skip: Data Expert'`, which
     *     names steps no user has heard of
     *
     * These map cleanly onto the two fields of the returned step — `message` is shown,
     * `errorMessage` is recorded — so each is routed to the one it belongs in. Reading
     * `errorDetail.message` into both put internal jargon in front of end users on
     * every ordinary failure, since both fields are populated whenever Skip reaches
     * its failure-finalization step.
     *
     * `hiddenToUser` messages are skipped: they exist for internal bookkeeping and are
     * not written to be read by anyone.
     */
    private handleSkipError(apiResponse: SkipAPIResponse): BaseAgentNextStep<ComponentSpec> {
        const lastSystemMessage = apiResponse.messages
            ?.filter(m => m.role === 'system' && !m.hiddenToUser)
            .pop();

        const userMessage = lastSystemMessage?.content?.trim();
        // Skip mirrors the raw failure onto the system message's `error` field, so it
        // remains available for the log even when errorDetail is absent.
        const diagnostic = apiResponse.errorDetail?.message?.trim()
            || lastSystemMessage?.error?.trim();
        const fallback = 'Skip returned an error with no details';

        LogError(
            `[SkipProxyAgent] Skip error (phase: ${apiResponse.responsePhase}): ` +
            `${diagnostic || userMessage || fallback}`
        );

        return {
            terminate: true,
            step: 'Failed',
            // Shown to the user — prefer the explanation written for them.
            message: userMessage || diagnostic || fallback,
            // Recorded for debugging — prefer the one that names the failing step.
            errorMessage: diagnostic || userMessage || fallback,
            newPayload: undefined
        };
    }

    /**
     * Handle analysis_complete phase — supports both component-bearing responses
     * (componentOptions populated) and analysis-only responses (markdown in `analysis`
     * with no component, produced by Skip's Analysis Agent path).
     */
    private handleAnalysisComplete(
        response: SkipAPIAnalysisCompleteResponse
    ): BaseAgentNextStep<ComponentSpec> {
        const hasComponentOptions = response.componentOptions && response.componentOptions.length > 0;
        // hiddenToUser messages are internal bookkeeping — never surface them (same rule as handleSkipError)
        const skipMessage = response.messages?.filter(msg => msg.role === 'system' && !msg.hiddenToUser).pop();
        const analysisText = response.analysis?.trim();

        // Skip-Brain attaches actionableCommands as an extension field on the
        // analysis_complete response (e.g. `client:capture-data-snapshot` when
        // the Analysis Agent needs the user's current view). Forward to the
        // next step so AgentRunner persists them to ConversationDetail.ActionableCommands
        // — which the chat UI's actionable-commands.component reads to render buttons.
        const responseExt = response as unknown as { actionableCommands?: unknown[] };
        const actionableCommands = Array.isArray(responseExt.actionableCommands) && responseExt.actionableCommands.length > 0
            ? (responseExt.actionableCommands as BaseAgentNextStep<ComponentSpec>['actionableCommands'])
            : undefined;
        LogStatus(`[SkipProxyAgent DEBUG] handleAnalysisComplete actionableCommands from response: ${JSON.stringify(responseExt.actionableCommands)}`);

        if (!hasComponentOptions) {
            if (analysisText || skipMessage?.content) {
                return {
                    terminate: true,
                    step: 'Success',
                    message: analysisText || skipMessage!.content,
                    newPayload: undefined,
                    actionableCommands
                };
            }

            const msg = 'Skip completed analysis but returned no component options. '
                + `Title: "${response.title || 'none'}". `
                + `Result type: "${response.resultType || 'none'}"`;
            LogError(`[SkipProxyAgent] ${msg}`);
            return {
                terminate: true,
                step: 'Failed',
                message: msg,
                errorMessage: msg,
                newPayload: undefined
            };
        }

        const componentSpec = this.selectBestComponentOption(response.componentOptions!).option;

        return {
            terminate: true,
            step: 'Success',
            message: skipMessage?.content || response.title || 'Analysis complete',
            newPayload: componentSpec,
            actionableCommands
        };
    }

    /**
     * Pick the best component option. Lower AIRank wins: Skip's judge rank-orders
     * options starting at 1 for the best (Skip-Brain emits AIRank = index + 1 over
     * its pre-sorted specs). Unranked options lose to ranked ones; when nothing is
     * ranked, the original order (index 0 first) is preserved.
     */
    private selectBestComponentOption(options: ComponentOption[]): ComponentOption {
        return options.reduce((best, candidate) => {
            const bestRank = typeof best.AIRank === 'number' ? best.AIRank : Number.POSITIVE_INFINITY;
            const candidateRank = typeof candidate.AIRank === 'number' ? candidate.AIRank : Number.POSITIVE_INFINITY;
            return candidateRank < bestRank ? candidate : best;
        });
    }

    /**
     * Handle clarifying_question phase
     */
    private handleClarifyingQuestion(
        response: SkipAPIClarifyingQuestionResponse
    ): BaseAgentNextStep<ComponentSpec> {
        return {
            terminate: true,
            step: 'Chat',
            message: response.clarifyingQuestion,
            responseForm: response.responseForm,
            newPayload: response.payload as ComponentSpec
        };
    }
}
