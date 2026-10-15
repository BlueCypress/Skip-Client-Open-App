/**
 * Skip TypeScript SDK
 *
 * A general-purpose SDK for calling the Skip SaaS API.
 * This module provides a clean, reusable interface for integrating with Skip
 * that can eventually be extracted into a standalone npm package.
 */

import {
    SkipAPIRequest,
    SkipAPIResponse,
    SkipMessage,
    SkipAPIAnalysisCompleteResponse,
    SkipAPIClarifyingQuestionResponse,
    SkipRequestPhase,
    SkipResponsePhase,
    SkipAPIRequestAPIKey,
    SkipQueryInfo,
    SkipQueryCatalogEntry,
    SkipAPIAgentNote,
    SkipAPIAgentNoteType,
    SkipAPIArtifact,
    SkipAPIArtifactVersion,
    SkipAPIArtifactType,
    SkipErrorCode,
    SkipRetryAction,
    SkipErrorDetail,
    SkipClientCapability,
    SkipFormContext,
} from '@askskip/types';
import { createRequire } from 'node:module';
import { isValidUUID, requireValidUUID } from './uuid-guard.js';
import { noteBrainContact } from './registry-reconciler.js';
import { DataContext } from '@memberjunction/data-context';
import { IMetadataProvider, UserInfo, LogStatus, LogError, Metadata, RunQuery, RunView, EntityInfo, BaseEntity, BaseEntityEvent, AllMetadata } from '@memberjunction/core';
import { MJConversationDetailEntity, QueryEngine } from '@memberjunction/core-entities';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { gzip as gzipCompress, createGunzip } from 'zlib';
import { getSkipConfig, getDbType, resolveSkipApiKey, DEFAULT_EVAL_RUN_AGENT_TIMEOUT_MS } from '@askskip/core';
import type { Agent } from 'undici';
import { getEvalDispatcher, describeEvalError } from './eval-transport.js';
import {
    getSkipCallbackKey,
    resetCallbackKeyProvisioning,
    confirmCallbackKeyDelivered,
    discardUnconfirmedCallbackKey,
} from './skip-callback-key-provisioner.js';
import { GetAIAPIKey } from '@memberjunction/ai';
import { AIEngine } from '@memberjunction/aiengine';
import { CopyScalarsAndArrays, UUIDsEqual, MJGlobal, MJEvent, MJEventType } from '@memberjunction/global';
import mssql from 'mssql';

/** What one entity build produced, and whether it is safe to keep. */
interface EntityBuildResult {
    entities: EntityInfo[];
    /** False when the build threw or the provider had no metadata loaded yet. */
    cacheable: boolean;
}

/** The MJGlobal event stream, as returned by `MJGlobal.Instance.GetEventListener()`. */
type MJEventStream = ReturnType<MJGlobal['GetEventListener']>;

/** This package's version, sent to Skip as `skipSDKVersion`. */
const SKIP_SDK_VERSION: string = createRequire(import.meta.url)('../package.json').version;

/** Features this SDK acts on, sent to Skip as `clientCapabilities`. */
const CLIENT_CAPABILITIES: string[] = [SkipClientCapability.ArtifactDirective];

/**
 * Configuration options for Skip SDK
 */
export interface SkipSDKConfig {
    /**
     * Skip API base URL (e.g., 'https://skip.memberjunction.com')
     */
    apiUrl?: string;

    /**
     * Skip API key for authentication
     */
    apiKey?: string;

    /**
     * Optional metadata provider this SDK instance binds to. When set, every metadata
     * lookup (entities, queries, schema) and direct SQL call is routed through this
     * provider — multi-tenant servers should pass the per-request provider here.
     * When omitted, the SDK falls back to the global `Metadata.Provider` (single-server
     * mode, legacy callers).
     */
    provider?: IMetadataProvider;
}

/**
 * Options for making a Skip API call
 */
export interface SkipCallOptions {
    /**
     * Conversation messages (user/assistant)
     */
    messages: SkipMessage[];

    /**
     * Conversation ID for tracking
     */
    conversationId: string;

    /**
     * Data context to provide to Skip
     */
    dataContext?: DataContext;

    /**
     * Request phase (initial_request, clarify_question_response, etc.)
     */
    requestPhase?: SkipRequestPhase;

    /**
     * Context user for permissions and metadata
     */
    contextUser: UserInfo;

    /**
     * Composition of the MJ entity form the caller is viewing, when there is one.
     * Forwarded verbatim to Skip so an agent asked to build a panel knows what the
     * form already shows.
     */
    formContext?: SkipFormContext;

    /**
     * Database connection for metadata queries
     */
    dataSource: mssql.ConnectionPool;

    /**
     * Include entity metadata in request
     */
    includeEntities?: boolean;

    /**
     * Include saved queries in request
     */
    includeQueries?: boolean;

    /**
     * Include agent notes in request
     */
    includeNotes?: boolean;

    /**
     * Include agent requests in request
     */
    includeRequests?: boolean;

    /**
     * Force refresh of entity metadata cache
     */
    forceEntityRefresh?: boolean;

    /**
     * Include callback API key and access token for Skip to call back to MJ
     */
    includeCallbackAuth?: boolean;

    /**
     * Callback for streaming status updates during execution
     */
    onStatusUpdate?: (message: string, responsePhase?: string) => void;

    /**
     * Optional payload data from a previous response (e.g., PRD in progress).
     * This enables incremental artifact building where structured data accumulates
     * throughout the conversation. When Skip returns a response with a payload,
     * the client should pass that payload back in the next request.
     */
    payload?: Record<string, any>;

    /**
     * Optional reference ID from the calling system. When the MJ API proxies a request
     * to Skip via SkipProxyAgent, this contains the MJ-side Agent Run ID for cross-system
     * correlation and debugging.
     */
    externalReferenceID?: string;

    /**
     * Internal flag to prevent infinite retry loops during callback key re-provisioning.
     * Set automatically by the SDK — callers should not set this.
     * @internal
     */
    _isCallbackKeyRetry?: boolean;
}

/**
 * Result from a Skip API call
 */
export interface SkipCallResult {
    /**
     * Whether the call was successful
     */
    success: boolean;

    /**
     * The final Skip API response
     */
    response?: SkipAPIResponse;

    /**
     * Response phase (analysis_complete, clarifying_question, status_update)
     */
    responsePhase?: string;

    /**
     * Error message if failed
     */
    error?: string;

    /**
     * Structured error detail from the Skip API response, if available.
     * Provides machine-actionable error codes and retry guidance.
     * Prefer this over parsing the `error` string for programmatic handling.
     */
    errorDetail?: SkipErrorDetail;

    /**
     * All streaming responses received (including intermediate status updates)
     */
    allResponses?: any[];
}

/**
 * Options for triggering an eval run on the Skip API.
 */
export interface SkipEvalOptions {
    agentName: string;
    agentPayload: Record<string, unknown>;
    optimalOutput: Record<string, unknown>;
    scoring: Record<string, unknown>;
    contextUser: UserInfo;
    dataSource: mssql.ConnectionPool;
    provider?: IMetadataProvider;
}

/**
 * Options for running a standalone prompt eval (no agent execution).
 */
export interface SkipEvalPromptOptions {
    promptName: string;
    promptData: Record<string, unknown>;
    optimalOutput: Record<string, unknown>;
    scoring: Record<string, unknown>;
    contextUser: UserInfo;
    provider?: IMetadataProvider;
}

/**
 * Result from an eval run.
 */
export interface SkipEvalResult {
    success: boolean;
    agentRunID?: string;
    executionTimeMs?: number;
    payload?: Record<string, unknown>;
    evidence?: Record<string, unknown>;
    scores?: {
        dimensions: Record<string, { score: number | string; justification: string }>;
        weightedScore: number;
    };
    error?: string;
}

/**
 * Shape of a single SSE event received from the Skip API stream.
 * Skip sends two formats:
 * - Wrapped: `{type: 'status_update'|'streaming'|'complete', value: SkipAPIResponse}`
 * - Flat (queue): `{responsePhase: 'queued'|'error', message: '...', error: '...'}`
 */
interface SkipStreamMessage {
    type?: string;
    value?: SkipAPIResponse;
    responsePhase?: string;
    message?: string;
    error?: string;
}

/**
 * Skip TypeScript SDK
 * Provides a clean interface for calling the Skip SaaS API
 */
export class SkipSDK {
    private config: SkipSDKConfig;

    /**
     * The metadata provider this SDK instance is bound to. Set via the constructor
     * config or the `Provider` setter. Falls back to the global `Metadata.Provider`
     * when not set — multi-tenant servers should always supply an explicit provider
     * so each request reaches its own database connection.
     */
    public get Provider(): IMetadataProvider {
        // NOTE: `Metadata.Provider` (static) is the provider. A `Metadata` *instance*
        // is only a facade over it and has no ExecuteSQL/RunView surface — returning
        // one here (behind an `as unknown as` cast) once made every direct SQL call
        // fail with "provider.ExecuteSQL is not a function".
        return this.config.provider ?? Metadata.Provider;
    }
    public set Provider(value: IMetadataProvider | null) {
        this.config.provider = value ?? undefined;
    }

    /**
     * The entity payload sent to Skip, shared across all instances and built from the process's
     * metadata. There is NO wall-clock expiry — see {@link buildEntities} for what retires it.
     */
    private static __entityCache: EntityInfo[] | null = null;

    /**
     * When the payload was last built. Read only to report the gap between builds in the build
     * log, which is how an unexpected rebuild gets spotted in a host's log.
     */
    private static __lastRefreshTime: number = 0;

    /**
     * Metadata entities (lowercased) whose runtime writes change what {@link buildEntities}
     * produces: entity and field `ScopeDefault` decide which entities and fields Skip sees.
     * Everything else in the payload — descriptions, organic keys, value lists — comes from
     * CodeGen, which means a schema change and an MJAPI restart, and the restart clears this cache.
     */
    private static readonly SCOPE_METADATA_ENTITIES: ReadonlySet<string> = new Set(['mj: entities', 'mj: entity fields']);

    /**
     * The MJGlobal event stream currently subscribed to. Compared by identity, not a boolean,
     * because `MJGlobal.Reset()` replaces the stream — the same pattern MJ's ProviderBase uses.
     */
    private static __wiredEventStream: MJEventStream | null = null;

    /** The live subscription, kept so a stream swap can unsubscribe the stale one. */
    private static __eventSubscription: ReturnType<MJEventStream['subscribe']> | null = null;

    /**
     * Set when a write to a {@link SCOPE_METADATA_ENTITIES} row is seen, holding the global
     * provider's `AllMetadata` at that moment. MJ refreshes its metadata on a debounce AFTER the
     * write, so clearing the cache on the event itself would let a request in between rebuild
     * from — and keep — the old metadata. The cache is cleared once the provider has swapped in a
     * new `AllMetadata` (see {@link applyPendingScopeChange}).
     */
    private static __pendingScopeChange: { metadataAtWrite: AllMetadata | undefined } | null = null;

    /** Ensures the resolved callback URL is logged only once per process. */
    private static __callbackURLLogged = false;

    constructor(config?: SkipSDKConfig) {
        // Use provided config or fall back to Skip client env config
        const skipConfig = getSkipConfig();
        this.config = {
            apiUrl: config?.apiUrl || skipConfig.skipURL,
            apiKey: config?.apiKey || skipConfig.apiKey,
        };
    }

    /**
     * Ensures the Skip API key is resolved before use. When no key was supplied
     * at construction (or via env), resolves it lazily from the encrypted
     * credential store using the provided context user.
     */
    public async ensureConfig(contextUser: UserInfo): Promise<void> {
        if (!this.config.apiKey) {
            this.config.apiKey = await resolveSkipApiKey(contextUser);
        }
    }

    /**
     * Call the Skip chat API
     */
    async chat(options: SkipCallOptions): Promise<SkipCallResult> {
        LogStatus(`[SkipSDK] Sending request to Skip API: ${this.config.apiUrl}`);

        // Resolve the Skip API key before anything else. Callers that go through
        // SkipProxyAgent already do this, but the eval entry points construct a bare
        // SkipSDK and would otherwise never consult the credential store.
        await this.ensureConfig(options.contextUser);

        // Fail before building the request, not after. buildSkipRequest() provisions the
        // scoped callback key as a side effect, and a request with no Skip API key is
        // rejected at the edge before Skip reads the body — which used to create a key
        // Skip never received, wedging every later request. Refusing here keeps that
        // key from being minted at all, and reports the real problem instead of a 401.
        if (!this.config.apiKey) {
            const error = 'No Skip API key is configured. Set ASK_SKIP_API_KEY in the MJAPI environment, ' +
                'or store a "Skip API Key" credential, then restart MJAPI.';
            LogError(`[SkipSDK] ${error}`);
            return { success: false, error };
        }

        try {
            // Build the Skip API request
            const skipRequest = await this.buildSkipRequest(options);

            // Call Skip API with SSE streaming support
            const chatUrl = `${(this.config.apiUrl || '').replace(/\/+$/, '')}/chat`;
            const responses = await this.sendSSERequest(
                chatUrl,
                skipRequest,
                this.buildHeaders(),
                (streamMessage: SkipStreamMessage) => {
                    // Handle streaming status updates
                    // Queue messages come as flat objects: {responsePhase: 'queued'|'error', message: '...', error: '...'}
                    // Skip API messages come wrapped: {type: 'status_update', value: {responsePhase: '...', messages: [...]}}
                    if (streamMessage.type === 'status_update' && options.onStatusUpdate) {
                        const statusContent = streamMessage.value?.messages?.[0]?.content;
                        const responsePhase = streamMessage.value?.responsePhase;
                        if (statusContent) {
                            options.onStatusUpdate(statusContent, responsePhase);
                        }
                    } else if (streamMessage.responsePhase === SkipResponsePhase.queued && options.onStatusUpdate) {
                        // Handle queue progress messages
                        const statusContent = streamMessage.message;
                        const responsePhase = streamMessage.responsePhase;
                        if (statusContent) {
                            options.onStatusUpdate(statusContent, responsePhase);
                        }
                    } else if (streamMessage.responsePhase === 'error') {
                        // Queue error messages - log but don't throw (final response will handle error)
                        // Note: 'error' is not in SkipResponsePhase enum - it's a queue-specific error state
                        LogError(`[SkipSDK] Queue error: ${streamMessage.error || 'Unknown error'}`);
                        if (options.onStatusUpdate) {
                            options.onStatusUpdate(`Error: ${streamMessage.error || 'Request failed'}`, 'error');
                        }
                    }
                }
            );

            if (!responses || responses.length === 0) {
                // Nothing came back, so there is no evidence Skip read the request.
                await discardUnconfirmedCallbackKey();
                return {
                    success: false,
                    error: 'No response received from Skip API'
                };
            }

            // Queue events arrive flat ({responsePhase, message, error} — no `.value`),
            // so the last event is not necessarily the wrapped final Skip response.
            const finalResponse = this.findFinalResponse(responses);
            if (!finalResponse) {
                // The stream ended on a flat queue error or with only queued/status
                // events — either way Skip never proved it read the request body, so
                // a newly provisioned callback key cannot be trusted as delivered.
                await discardUnconfirmedCallbackKey();
                const error = this.describeMissingFinalResponse(responses[responses.length - 1]);
                LogError(`[SkipSDK] ${error}`);
                return {
                    success: false,
                    error,
                    allResponses: responses
                };
            }

            // A parsed final response means Skip read the request body, so any newly
            // provisioned callback key in it was stored — Skip resolves the callback
            // credential before running any workflow, so a Skip-side error still
            // implies receipt. Confirming here is what makes the key safe to keep
            // across a restart; anything short of this leaves it discardable.
            confirmCallbackKeyDelivered();

            // A parsed final response is also proof the brain is up right now — the only
            // moment the client can learn which component registry it publishes under.
            // Startup may have missed it (MJAPI and the Skip API are routinely started
            // hours apart locally, and a brain can be down for maintenance), so catch up
            // here. Fire-and-forget: never delays or fails this request.
            noteBrainContact(options.contextUser);

            // Check if Skip itself reported an error (success: false in the response body)
            if (finalResponse.success === false) {
                const detail = finalResponse.errorDetail;
                const skipError = detail?.message || 'Skip API returned an error response';
                LogError(`[SkipSDK] Skip API error: ${skipError}` +
                    (detail ? ` [${detail.type}/${detail.code}]` : ''));

                // Skip stopped the request at its time limit. Never retried automatically: the
                // same request would very likely run out of time again. The user-facing
                // explanation is in the response's system message.
                if (detail?.code === SkipErrorCode.request_timeout) {
                    LogStatus('[SkipSDK] Skip request timed out; not retrying');
                }

                // Handle callback key re-provisioning: if Skip reports the callback
                // key is invalid and suggests re-provisioning, reset the provisioner
                // state and retry exactly once. The retry flag on options prevents
                // infinite loops.
                if (detail?.code === SkipErrorCode.invalid_callback_key
                    && detail.retryAction === SkipRetryAction.reprovision_and_retry
                    && !options._isCallbackKeyRetry) {
                    LogStatus('[SkipSDK] Callback key invalid — revoking old key and re-provisioning');
                    await resetCallbackKeyProvisioning();
                    return this.chat({ ...options, _isCallbackKeyRetry: true });
                }

                return {
                    success: false,
                    response: finalResponse,
                    responsePhase: finalResponse.responsePhase,
                    error: skipError,
                    errorDetail: detail,
                    allResponses: responses
                };
            }

            return {
                success: true,
                response: finalResponse,
                responsePhase: finalResponse.responsePhase,
                allResponses: responses
            };

        } catch (error) {
            LogError(`[SkipSDK] Error calling Skip API: ${error}`);

            // The request failed at or before the edge (HTTP error, socket failure,
            // malformed stream), so Skip never read the body. If this request was
            // carrying a brand-new callback key, drop it — keeping the row would
            // outlive the raw value and wedge every request after the next restart.
            await discardUnconfirmedCallbackKey();

            // Provide user-friendly error messages for common failures
            const rawError = error instanceof Error ? error.message : String(error);
            let userFriendlyError = rawError;
            const errorStr = rawError.toLowerCase();

            if (errorStr.includes('stream error') || errorStr.includes('stream closed') || errorStr.includes('aborted') || errorStr.includes('econnreset')) {
                userFriendlyError = 'The Skip analysis service became unavailable during processing. Please try again.';
            } else if (errorStr.includes('econnrefused') || errorStr.includes('enotfound')) {
                userFriendlyError = 'Unable to connect to the Skip analysis service. The service may be temporarily unavailable.';
            } else if (errorStr.includes('timeout')) {
                userFriendlyError = 'The Skip analysis service took too long to respond. Please try again.';
            }

            return {
                success: false,
                error: userFriendlyError
            };
        }
    }

    /**
     * Locates the final wrapped Skip response in the event stream, scanning
     * backwards for the last `{type: 'complete', value: {...}}` event. Flat queue
     * events carry no `.value` and wrapped status updates are interim, so neither
     * qualifies. Returns undefined when no final response arrived.
     */
    private findFinalResponse(responses: SkipStreamMessage[]): SkipAPIResponse | undefined {
        for (let i = responses.length - 1; i >= 0; i--) {
            const event = responses[i];
            if (event.type === 'complete' && event.value && typeof event.value === 'object') {
                return event.value;
            }
        }
        return undefined;
    }

    /**
     * Builds the failure message for a stream that ended without a wrapped final
     * response: a flat queue error surfaces the queue's own error text, anything
     * else (only queued/status events) is reported as a transport failure.
     */
    private describeMissingFinalResponse(lastEvent: SkipStreamMessage): string {
        if (lastEvent.responsePhase === 'error') {
            const queueError = lastEvent.error || lastEvent.message;
            return queueError
                ? `Skip request failed in the processing queue: ${queueError}`
                : 'Skip request failed in the processing queue';
        }
        return 'The Skip API stream ended before a final response was received. Please try again.';
    }

    /**
     * Build the Skip API request object
     */
    private async buildSkipRequest(options: SkipCallOptions): Promise<SkipAPIRequest> {
        const {
            messages,
            conversationId,
            dataContext,
            requestPhase = 'initial_request',
            contextUser,
            dataSource,
            includeEntities = true,
            includeQueries = true,
            includeNotes = true,
            includeRequests = false,
            forceEntityRefresh = false,
            includeCallbackAuth = true,
            payload,
            externalReferenceID
        } = options;

        // Build base request with metadata
        const baseRequest = await this.buildBaseRequest(
            contextUser,
            dataSource,
            includeEntities,
            includeQueries,
            includeNotes,
            includeRequests,
            forceEntityRefresh,
            includeCallbackAuth,
            { conversationId, requestPhase }
        );

        // Build artifacts for this conversation
        const artifacts = await this.buildArtifacts(contextUser, dataSource, conversationId);

        // Process messages: filter delegation messages and enrich with metadata
        const processedMessages = this.processMessages(messages);

        // Construct the full Skip API request
        const request: SkipAPIRequest = {
            messages: processedMessages,
            conversationID: conversationId,
            dataContext: dataContext ? CopyScalarsAndArrays(dataContext) as DataContext : undefined,
            requestPhase,
            artifacts,
            payload, // Pass through payload for incremental artifact building (e.g., PRD in progress)
            entities: baseRequest.entities || [],
            queries: baseRequest.queries || [],
            queryCatalog: baseRequest.queryCatalog,
            notes: baseRequest.notes,
            noteTypes: baseRequest.noteTypes,
            userEmail: baseRequest.userEmail,
            apiKeys: baseRequest.apiKeys,
            callingServerURL: baseRequest.callingServerURL,
            callingServerAPIKey: baseRequest.callingServerAPIKey,
            externalReferenceID,
            databasePlatform: baseRequest.databasePlatform,
            clientCapabilities: [...CLIENT_CAPABILITIES],
            skipSDKVersion: SKIP_SDK_VERSION,
            formContext: options.formContext
        };

        return request;
    }

    /**
     * Build base request with metadata, API keys, and callback auth
     */
    private async buildBaseRequest(
        contextUser: UserInfo,
        dataSource: mssql.ConnectionPool,
        includeEntities: boolean,
        includeQueries: boolean,
        includeNotes: boolean,
        includeRequests: boolean,
        forceEntityRefresh: boolean,
        includeCallbackAuth: boolean,
        additionalTokenInfo: any = {}
    ): Promise<Partial<SkipAPIRequest>> {
        const entities = includeEntities ? this.buildEntities(forceEntityRefresh) : [];
        const queries = includeQueries ? this.buildQueries() : [];
        // Always build the lightweight query catalog for collision detection,
        // regardless of whether full queries are included
        const queryCatalog = this.buildQueryCatalog();
        const { notes, noteTypes } = includeNotes ? await this.buildAgentNotes(contextUser) : { notes: [], noteTypes: [] };
        // Note: requests would be built here if includeRequests is true

        // Setup callback auth for Skip→client callbacks if needed
        let callingServerURL: string | undefined;
        let callingServerAPIKey: string | undefined;
        if (includeCallbackAuth) {
            callingServerURL = await this.resolveCallbackServerURL();

            // Auto-provisioned scoped API key. Returns the raw key ONLY when
            // a new key was just created (first time connecting to this Skip host).
            // Returns null when key already exists — Skip already has it stored
            // in its credential store from the initial request.
            const newlyCreatedKey = await getSkipCallbackKey();
            if (newlyCreatedKey) {
                // First time: send raw key so Skip can persist it
                callingServerAPIKey = newlyCreatedKey;
            }
            // else: provisioningComplete=true, key exists in DB, Skip already has it — omit callingServerAPIKey
        }

        return {
            entities,
            queries,
            queryCatalog,
            notes,
            noteTypes,
            userEmail: contextUser.Email,
            apiKeys: this.buildAPIKeys(),
            callingServerURL,
            callingServerAPIKey,
            databasePlatform: getDbType(),
        };
    }

    /**
     * Resolves the URL Skip uses to call back into this MJAPI. MJServer's
     * `configInfo` already encodes the mj.config.cjs > env > defaults precedence,
     * so its values win over the env-only getSkipConfig() ones. The import is
     * lazy: unit tests and non-MJAPI contexts cannot load that heavy module, and
     * for them the env-derived values remain authoritative.
     */
    private async resolveCallbackServerURL(): Promise<string> {
        const skipConfig = getSkipConfig();
        let { baseUrl, publicUrl, graphqlPort, graphqlRootPath } = skipConfig;
        try {
            const { configInfo } = await import('@memberjunction/server');
            baseUrl = configInfo.baseUrl || baseUrl;
            publicUrl = configInfo.publicUrl || publicUrl;
            graphqlPort = configInfo.graphqlPort ?? graphqlPort;
            graphqlRootPath = configInfo.graphqlRootPath || graphqlRootPath;
        } catch {
            // Not running inside MJAPI — fall back to getSkipConfig() env values.
        }
        const url = publicUrl || `${baseUrl}:${graphqlPort}${graphqlRootPath}`;
        if (!SkipSDK.__callbackURLLogged) {
            SkipSDK.__callbackURLLogged = true;
            LogStatus(`[SkipSDK] Resolved Skip callback URL: ${url}`);
        }
        return url;
    }

    /**
     * Returns the entity metadata payload Skip receives, built once and reused.
     *
     * The build is a synchronous, in-memory projection of the provider's metadata — scope
     * filtering plus a clone — with no database access, so concurrent callers can never observe a
     * half-finished build. It is still not free on a large schema (a `toJSON()` copy per entity
     * and per field), which is why it is not repeated on a timer.
     *
     * What retires the cached payload:
     * - a runtime write to entity or field `ScopeDefault`, picked up from the MJGlobal event
     *   stream once MJ has refreshed its metadata (see {@link handleMetadataEvent});
     * - {@link InvalidateEntitiesCache};
     * - a per-call `forceRefresh`.
     * Schema changes need no handling here: they require CodeGen and an MJAPI restart.
     *
     * Originally copied from AskSkipResolver.BuildSkipEntities.
     */
    private buildEntities(forceRefresh: boolean): EntityInfo[] {
        SkipSDK.ensureMetadataEventSubscription();
        SkipSDK.applyPendingScopeChange();

        const cached = SkipSDK.__entityCache;
        if (cached && !forceRefresh) {
            return cached;
        }
        const provider = this.Provider;
        if (!provider) {
            LogError('[SkipSDK] No metadata provider is available — sending Skip no entities');
            return [];
        }

        const sinceLast = SkipSDK.__lastRefreshTime === 0
            ? 'first build this process'
            : `${Math.round((Date.now() - SkipSDK.__lastRefreshTime) / 1000)}s since last build`;
        LogStatus(`[SkipSDK] Building Skip entities cache (${cached ? 'forced refresh' : 'no cached payload'}, ${sinceLast})`);

        const result = this.refreshSkipEntities(provider);
        SkipSDK.__lastRefreshTime = Date.now();
        SkipSDK.__entityCache = result.cacheable ? result.entities : null;
        return result.entities;
    }

    /**
     * Subscribes once per MJGlobal event stream to BaseEntity events, so runtime scope changes
     * reach Skip without a restart. A failure here is logged, never thrown: losing automatic
     * rebuilds must not fail the Skip request that happened to trigger the wiring.
     */
    private static ensureMetadataEventSubscription(): void {
        try {
            const stream = MJGlobal.Instance.GetEventListener(false);
            if (SkipSDK.__wiredEventStream === stream) {
                return;
            }
            // Assign before subscribing so a re-entrant call cannot double-subscribe.
            SkipSDK.__eventSubscription?.unsubscribe();
            SkipSDK.__wiredEventStream = stream;
            SkipSDK.__eventSubscription = stream.subscribe((event) => SkipSDK.handleMetadataEvent(event));
        }
        catch (e) {
            LogError(`[SkipSDK] Could not subscribe to MJGlobal events — scope changes will need an invalidation or restart to reach Skip: ${e}`);
        }
    }

    /**
     * Records a save, delete or remote invalidation (a write on another server) of an entity or
     * entity field row. Mirrors the filter MJ's ProviderBase applies to the same stream when it
     * schedules its own metadata refresh.
     */
    private static handleMetadataEvent(event: MJEvent): void {
        if (event.event !== MJEventType.ComponentEvent || event.eventCode !== BaseEntity.BaseEventCode) {
            return;
        }
        const entityEvent: BaseEntityEvent | undefined = event.args;
        if (!entityEvent || (entityEvent.type !== 'save' && entityEvent.type !== 'delete' && entityEvent.type !== 'remote-invalidate')) {
            return;
        }
        const entityName = (entityEvent.baseEntity?.EntityInfo?.Name ?? entityEvent.entityName)?.trim().toLowerCase();
        if (!entityName || !SkipSDK.SCOPE_METADATA_ENTITIES.has(entityName)) {
            return;
        }
        // Always the latest write: if MJ already refreshed after an earlier write, the next
        // request must wait for THIS write's refresh too.
        SkipSDK.__pendingScopeChange = { metadataAtWrite: Metadata.Provider?.AllMetadata };
        LogStatus(`[SkipSDK] ${entityEvent.type} on ${entityName} — Skip entities will rebuild once MJ refreshes its metadata`);
    }

    /**
     * Clears the cached payload if a scope write is pending and MJ has since swapped in new
     * metadata. Until then the old payload keeps matching what the provider itself is serving.
     */
    private static applyPendingScopeChange(): void {
        const pending = SkipSDK.__pendingScopeChange;
        if (!pending || Metadata.Provider?.AllMetadata === pending.metadataAtWrite) {
            return;
        }
        SkipSDK.__pendingScopeChange = null;
        SkipSDK.__entityCache = null;
        LogStatus('[SkipSDK] MJ metadata refreshed after a scope change — rebuilding Skip entities');
    }

    /**
     * Discards the cached entity payload so the next request rebuilds it. Runtime scope changes
     * are already picked up from the MJGlobal event stream; this is the manual lever for anything
     * else a host knows has changed.
     */
    public static InvalidateEntitiesCache(): void {
        SkipSDK.__entityCache = null;
        LogStatus('[SkipSDK] Skip entities cache invalidated — the next request will rebuild it');
    }

    /**
     * Build saved queries for Skip
     */
    private buildQueries(status: "Pending" | "In-Review" | "Approved" | "Rejected" | "Obsolete" = 'Approved'): SkipQueryInfo[] {
        const qe = QueryEngine.Instance;
        const approvedQueries = qe.Queries.filter((q) => q.Status === status);

        return approvedQueries.map((q) => ({
            ID: q.ID,
            Name: q.Name,
            Description: q.Description,
            Category: q.Category,
            CategoryPath: this.buildQueryCategoryPath(qe, q.CategoryID),
            CategoryID: q.CategoryID,
            SQL: q.GetPlatformSQL(getDbType()),
            Status: q.Status,
            QualityRank: q.QualityRank,
            Reusable: q.Reusable,
            EmbeddingVector: q.EmbeddingVector,
            EmbeddingModelID: q.EmbeddingModelID,
            EmbeddingModelName: q.EmbeddingModel,
            TechnicalDescription: q.TechnicalDescription,
            Fields: qe.GetQueryFields(q.ID).map((f) => ({
                ID: f.ID,
                QueryID: f.QueryID,
                Name: f.Name,
                Description: f.Description,
                Sequence: f.Sequence,
                SQLBaseType: f.SQLBaseType,
                SQLFullType: f.SQLFullType,
                SourceEntityID: f.SourceEntityID,
                SourceEntity: f.SourceEntity,
                SourceFieldName: f.SourceFieldName,
                IsComputed: f.IsComputed,
                ComputationDescription: f.ComputationDescription,
                IsSummary: f.IsSummary,
                SummaryDescription: f.SummaryDescription
            })),
            Parameters: qe.GetQueryParameters(q.ID).map((p) => ({
                ID: p.ID,
                QueryID: p.QueryID,
                Name: p.Name,
                Description: p.Description,
                Type: p.Type,
                IsRequired: p.IsRequired,
                DefaultValue: p.DefaultValue,
                SampleValue: p.SampleValue,
                ValidationFilters: p.ValidationFilters
            })),
            Entities: qe.QueryEntities.filter(e => UUIDsEqual(e.QueryID, q.ID)).map((e) => ({
                ID: e.ID,
                QueryID: e.QueryID,
                EntityID: e.EntityID,
                Entity: e.Entity
            })),
            SQLDialectID: q.SQLDialectID,
            UsesTemplate: q.UsesTemplate,
            IsApproved: q.IsApproved,
            CacheEnabled: q.CacheEnabled,
            CacheMaxSize: q.CacheMaxSize,
            CacheTTLMinutes: q.CacheTTLMinutes,
            CacheValidationSQL: q.CacheValidationSQL
        }));
    }

    /**
     * Recursively build category path for a query
     */
    private buildQueryCategoryPath(qe: QueryEngine, categoryID: string): string {
        const cat = qe.Categories.find((c) => UUIDsEqual(c.ID, categoryID));
        if (!cat) return '';
        if (!cat.ParentID) return cat.Name;
        const parentPath = this.buildQueryCategoryPath(qe, cat.ParentID);
        return parentPath ? `${parentPath}/${cat.Name}` : cat.Name;
    }

    /**
     * Build a lightweight catalog of ALL query names and category paths (regardless of status).
     * Always called regardless of includeQueries, so collision detection
     * has accurate data even when full query metadata is not transmitted.
     * Includes all statuses because the database enforces name+category uniqueness
     * across all queries, not just approved ones.
     */
    private buildQueryCatalog(): SkipQueryCatalogEntry[] {
        const qe = QueryEngine.Instance;

        return qe.Queries.map((q) => ({
            Name: q.Name,
            CategoryPath: this.buildQueryCategoryPath(qe, q.CategoryID)
        }));
    }

    /**
     * Build agent notes for Skip
     */
    private async buildAgentNotes(contextUser: UserInfo): Promise<{ notes: SkipAPIAgentNote[], noteTypes: SkipAPIAgentNoteType[] }> {
        // TODO: Implement agent notes building
        // This would query AIAgentNote entities and convert to SkipAPIAgentNote format
        // For now, returning empty arrays
        return { notes: [], noteTypes: [] };
    }

    /**
     * Build artifacts for a conversation using optimized query
     * Uses GetConversationArtifactsForAgent query which joins through ConversationDetailArtifact
     * to get artifacts that were outputs from Skip agent's conversation details
     */
    private async buildArtifacts(contextUser: UserInfo, dataSource: mssql.ConnectionPool, conversationId: string): Promise<SkipAPIArtifact[]> {
        try {
            const rq = new RunQuery();

            // Ensure AIEngine is configured and get Skip agent ID
            await AIEngine.Instance.Config(false, contextUser);
            const skipAgent = AIEngine.Instance.GetAgentByName('Skip');
            const skipAgentId = skipAgent?.ID;

            if (!skipAgentId) {
                LogError('[SkipSDK] Skip agent not found in AIEngine');
            }

            // Use optimized query that replaces 4 RunView calls with 1 query
            // This query includes Configuration field needed for component spec extraction
            // Filter by Skip agent ID to only get artifacts created by Skip (not delegation agents)
            const result = await rq.RunQuery({
                QueryName: 'GetConversationArtifactsForAgent',
                CategoryPath: 'MJ/Conversations',
                Parameters: {
                    ConversationID: conversationId,
                    AgentID: skipAgentId // Filter to only artifacts created by Skip agent
                }
            }, contextUser);

            if (!result.Success || !result.Results || result.Results.length === 0) {
                return [];
            }

            // Query returns flat result set: one row per artifact version
            // Group by ArtifactID to build SkipAPIArtifact objects with their versions
            const artifactMap = new Map<string, {
                artifact: any,
                artifactType: SkipAPIArtifactType,
                versions: SkipAPIArtifactVersion[]
            }>();

            // Process each row (represents one version)
            for (const row of result.Results) {
                const artifactId = row.ArtifactID;

                // Initialize artifact entry if not exists
                if (!artifactMap.has(artifactId)) {
                    // Map database sharingScope values to SkipAPIArtifact expected values
                    let sharingScope: 'None' | 'SpecificUsers' | 'Everyone' | 'Public' = 'None';
                    const dbSharingScope = (row.SharingScope || '').toLowerCase();
                    if (dbSharingScope === 'always' || dbSharingScope === 'everyone') {
                        sharingScope = 'Everyone';
                    } else if (dbSharingScope === 'public') {
                        sharingScope = 'Public';
                    } else if (dbSharingScope === 'specific users' || dbSharingScope === 'specificusers') {
                        sharingScope = 'SpecificUsers';
                    }

                    artifactMap.set(artifactId, {
                        artifact: {
                            id: artifactId,
                            conversationId: conversationId,
                            name: row.ArtifactName,
                            description: row.ArtifactDescription || '',
                            sharingScope: sharingScope,
                            comments: row.ArtifactComments || '',
                            createdAt: new Date(row.ArtifactCreatedAt),
                            updatedAt: new Date(row.ArtifactUpdatedAt)
                        },
                        artifactType: {
                            id: row.ArtifactTypeID,
                            name: row.ArtifactTypeName,
                            description: row.ArtifactTypeDescription,
                            contentType: row.ArtifactTypeContentType,
                            enabled: true,
                            createdAt: new Date(row.ArtifactTypeCreatedAt),
                            updatedAt: new Date(row.ArtifactTypeUpdatedAt)
                        },
                        versions: []
                    });
                }

                // Add this version to the artifact
                const entry = artifactMap.get(artifactId)!;
                entry.versions.push({
                    id: row.VersionID,
                    artifactId: artifactId,
                    conversationDetailID: row.ConversationDetailID, // Direct from join table!
                    version: row.Version,
                    configuration: row.Configuration || '',
                    content: row.Content || '',
                    comments: row.VersionComments || '',
                    createdAt: new Date(row.VersionCreatedAt),
                    updatedAt: new Date(row.VersionUpdatedAt)
                });
            }

            // Convert map to SkipAPIArtifact array
            const artifacts: SkipAPIArtifact[] = Array.from(artifactMap.values()).map(entry => ({
                ...entry.artifact,
                artifactType: entry.artifactType,
                versions: entry.versions
            }));

            // Also include INPUT artifacts (e.g., user-captured Data Snapshots
            // attached to messages via the Analyze button or
            // client:capture-data-snapshot actionable command). The query above
            // only returns Direction='Output' artifacts produced BY Skip — but
            // Skip also needs to see artifacts the user gave it as input.
            const inputArtifacts = await this.buildInputArtifacts(contextUser, conversationId, artifactMap);
            if (inputArtifacts.length > 0) {
                artifacts.push(...inputArtifacts);
            }

            return artifacts;
        } catch (error) {
            LogError(`Failed to build artifacts for conversation ${conversationId}: ${error}`);
            return [];
        }
    }

    /**
     * Fetch INPUT artifacts attached to user messages in this conversation
     * (Direction='Input' on ConversationDetailArtifact). Skip should see these
     * so it can use captured Data Snapshots, user-uploaded files, etc., in
     * its analysis.
     *
     * Deduplicates against `alreadyLoaded` (the Output artifacts) so the same
     * artifact ID doesn't appear twice if it was both produced and re-attached.
     */
    private async buildInputArtifacts(
        contextUser: UserInfo,
        conversationId: string,
        alreadyLoaded: Map<string, { artifact: any; artifactType: SkipAPIArtifactType; versions: SkipAPIArtifactVersion[] }>
    ): Promise<SkipAPIArtifact[]> {
        try {
            // Caller-supplied value interpolated into an ExtraFilter — reject anything
            // that is not a canonical UUID before it can carry an injection payload.
            requireValidUUID(conversationId, 'conversationId');

            const rv = new RunView();
            // Pull conversation detail IDs in this conversation
            const detailsResult = await rv.RunView<MJConversationDetailEntity>({
                EntityName: 'MJ: Conversation Details',
                ExtraFilter: `ConversationID='${conversationId}'`,
                Fields: ['ID'],
                ResultType: 'simple',
            }, contextUser);
            const detailIds = detailsResult.Success && detailsResult.Results
                ? (detailsResult.Results as { ID: string }[]).map(r => r.ID).filter(isValidUUID)
                : [];
            if (detailIds.length === 0) return [];

            // Junction rows where Direction='Input' for those details
            const junctionResult = await rv.RunView({
                EntityName: 'MJ: Conversation Detail Artifacts',
                ExtraFilter: `ConversationDetailID IN ('${detailIds.join("','")}') AND Direction='Input'`,
                Fields: ['ArtifactVersionID', 'ConversationDetailID'],
                ResultType: 'simple',
            }, contextUser);
            const junctions = junctionResult.Success && junctionResult.Results
                ? (junctionResult.Results as { ArtifactVersionID: string; ConversationDetailID: string }[])
                : [];
            if (junctions.length === 0) return [];

            // Load each ArtifactVersion + its parent Artifact + ArtifactType.
            // These IDs were read back from the DB, but they still land in
            // ExtraFilter strings — filter to canonical UUIDs as defense in depth.
            const versionIds = [...new Set(junctions.map(j => j.ArtifactVersionID))].filter(isValidUUID);
            const versionsResult = await rv.RunView({
                EntityName: 'MJ: Artifact Versions',
                ExtraFilter: `ID IN ('${versionIds.join("','")}')`,
                ResultType: 'simple',
            }, contextUser);
            const versions = versionsResult.Success && versionsResult.Results
                ? (versionsResult.Results as Record<string, any>[])
                : [];
            if (versions.length === 0) return [];

            const artifactIds = [...new Set(versions.map(v => v.ArtifactID as string))].filter(isValidUUID);
            const artifactsResult = await rv.RunView({
                EntityName: 'MJ: Artifacts',
                ExtraFilter: `ID IN ('${artifactIds.join("','")}')`,
                ResultType: 'simple',
            }, contextUser);
            const artifactRows = artifactsResult.Success && artifactsResult.Results
                ? (artifactsResult.Results as Record<string, any>[])
                : [];

            const typeIds = [...new Set(artifactRows.map(a => a.TypeID as string))].filter(isValidUUID);
            const typesResult = await rv.RunView({
                EntityName: 'MJ: Artifact Types',
                ExtraFilter: `ID IN ('${typeIds.join("','")}')`,
                ResultType: 'simple',
            }, contextUser);
            const typeRows = typesResult.Success && typesResult.Results
                ? (typesResult.Results as Record<string, any>[])
                : [];
            const typeMap = new Map<string, Record<string, any>>(typeRows.map(t => [t.ID as string, t]));

            // Build a junction lookup: artifactVersionId -> conversationDetailId
            const versionToDetail = new Map(junctions.map(j => [j.ArtifactVersionID, j.ConversationDetailID]));

            // Build SkipAPIArtifact entries
            const inputArtifactMap = new Map<string, { artifact: any; artifactType: SkipAPIArtifactType; versions: SkipAPIArtifactVersion[] }>();
            for (const v of versions) {
                const aRow = artifactRows.find(a => UUIDsEqual(a.ID, v.ArtifactID));
                if (!aRow) continue;
                if (alreadyLoaded.has(aRow.ID as string)) continue; // dedup

                const typeRow = typeMap.get(aRow.TypeID as string);
                if (!typeRow) continue;

                let entry = inputArtifactMap.get(aRow.ID as string);
                if (!entry) {
                    entry = {
                        artifact: {
                            id: aRow.ID,
                            conversationId,
                            name: aRow.Name,
                            description: aRow.Description || '',
                            sharingScope: 'None',
                            comments: aRow.Comments || '',
                            createdAt: new Date(aRow.__mj_CreatedAt),
                            updatedAt: new Date(aRow.__mj_UpdatedAt),
                        },
                        artifactType: {
                            id: typeRow.ID,
                            name: typeRow.Name,
                            description: typeRow.Description,
                            contentType: typeRow.ContentType,
                            enabled: true,
                            createdAt: new Date(typeRow.__mj_CreatedAt),
                            updatedAt: new Date(typeRow.__mj_UpdatedAt),
                        },
                        versions: [],
                    };
                    inputArtifactMap.set(aRow.ID as string, entry);
                }
                entry.versions.push({
                    id: v.ID,
                    artifactId: v.ArtifactID,
                    conversationDetailID: versionToDetail.get(v.ID) ?? '',
                    version: v.VersionNumber,
                    configuration: v.Configuration || '',
                    content: v.Content || '',
                    comments: v.Comments || '',
                    createdAt: new Date(v.__mj_CreatedAt),
                    updatedAt: new Date(v.__mj_UpdatedAt),
                });
            }

            return Array.from(inputArtifactMap.values()).map(entry => ({
                ...entry.artifact,
                artifactType: entry.artifactType,
                versions: entry.versions,
            }));
        } catch (error) {
            LogError(`Failed to load input artifacts for conversation ${conversationId}: ${error}`);
            return [];
        }
    }

    /**
     * Build API keys for AI services
     */
    private buildAPIKeys(): SkipAPIRequestAPIKey[] {
        return [
            {
                vendorDriverName: 'OpenAILLM',
                apiKey: GetAIAPIKey('OpenAILLM')
            },
            {
                vendorDriverName: 'AnthropicLLM',
                apiKey: GetAIAPIKey('AnthropicLLM')
            },
            {
                vendorDriverName: 'GeminiLLM',
                apiKey: GetAIAPIKey('GeminiLLM')
            },
            {
                vendorDriverName: 'GroqLLM',
                apiKey: GetAIAPIKey('GroqLLM')
            },
            {
                vendorDriverName: 'MistralLLM',
                apiKey: GetAIAPIKey('MistralLLM')
            },
            {
                vendorDriverName: 'CerebrasLLM',
                apiKey: GetAIAPIKey('CerebrasLLM')
            }
        ];
    }

    /**
     * Build HTTP headers for Skip API requests
     */
    private buildHeaders(): Record<string, string> {
        return {
            'x-api-key': this.config.apiKey || '',
            'Content-Type': 'application/json'
        };
    }

    /**
     * Send an SSE-aware POST request to the Skip API.
     * Replaces sendPostRequest for SSE format: parses `data: {json}\n\n` events
     * instead of NDJSON `{json}\n` lines. This is required because Azure Container
     * Apps' Envoy proxy buffers NDJSON responses but streams SSE responses.
     */
    private async sendSSERequest(
        url: string,
        payload: SkipAPIRequest,
        headers: Record<string, string>,
        streamCallback?: (event: SkipStreamMessage) => void
    ): Promise<SkipStreamMessage[]> {
        // Gzip the request body
        const compressed = await new Promise<Buffer>((resolve, reject) => {
            gzipCompress(JSON.stringify(payload), (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });

        return new Promise((resolve, reject) => {
            try {
                const parsedUrl = new URL(url);
                const options = {
                    hostname: parsedUrl.hostname,
                    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                    path: parsedUrl.pathname,
                    method: 'POST' as const,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Encoding': 'gzip',
                        ...headers
                    }
                };

                const requestFn = parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest;
                const events: SkipStreamMessage[] = [];
                let buffer = '';
                let settled = false;
                let endFired = false;

                const settleReject = (error: Error): void => {
                    if (settled) return;
                    settled = true;
                    reject(error);
                };

                const parseSSELine = (line: string): void => {
                    if (line.trim() === '') return;           // Skip empty lines (SSE event delimiters)
                    if (!line.startsWith('data: ')) return;   // Skip non-data SSE fields
                    const jsonStr = line.slice(6);
                    if (!jsonStr.trim()) return;

                    try {
                        const event = JSON.parse(jsonStr) as SkipStreamMessage;
                        events.push(event);
                        streamCallback?.(event);
                    } catch (e) {
                        LogError(`[SkipSDK] SSE parse error: ${e}`);
                    }
                };

                const handleStreamEnd = (): void => {
                    if (settled) return;
                    settled = true;
                    // Try to parse any remaining data in buffer
                    if (buffer.trim()) {
                        parseSSELine(buffer);
                    }
                    resolve(events);
                };

                const req = requestFn(options, (res) => {
                    // Check for non-2xx HTTP status codes before attempting SSE parsing.
                    // The Skip API returns JSON error bodies for auth/validation failures (401, 403, etc.)
                    // which won't contain SSE `data:` lines, resulting in an empty events array
                    // and the misleading "No response received from Skip API" error.
                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                        let errorBody = '';
                        res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
                        res.on('end', () => {
                            let errorMessage = `Skip API returned HTTP ${res.statusCode}`;
                            try {
                                const parsed = JSON.parse(errorBody);
                                if (parsed.message) {
                                    errorMessage = parsed.message;
                                } else if (parsed.error) {
                                    errorMessage = parsed.error;
                                }
                            } catch {
                                // Non-JSON body — use raw text if available
                                if (errorBody.trim()) {
                                    errorMessage += `: ${errorBody.trim().substring(0, 200)}`;
                                }
                            }
                            LogError(`[SkipSDK] HTTP ${res.statusCode} from ${url}: ${errorMessage}`);
                            reject(new Error(errorMessage));
                        });
                        return;
                    }

                    const isGzip = res.headers['content-encoding'] === 'gzip';
                    const stream = isGzip ? res.pipe(createGunzip()) : res;

                    if (isGzip) {
                        // pipe() does not forward source errors to the gunzip stream,
                        // so a mid-stream connection reset on `res` would otherwise
                        // never settle this promise. Listen on the source directly.
                        res.on('error', (e: Error) => {
                            LogError(`[SkipSDK] SSE response error for ${url}: ${e.message}`);
                            settleReject(new Error(`SSE stream error: ${e.message}`));
                        });
                        res.on('aborted', () => {
                            LogError(`[SkipSDK] SSE response aborted for ${url}`);
                            settleReject(new Error('SSE stream aborted before completion'));
                        });
                    }

                    stream.on('data', (chunk: Buffer) => {
                        buffer += chunk.toString();
                        let boundary: number;
                        while ((boundary = buffer.indexOf('\n')) !== -1) {
                            const line = buffer.substring(0, boundary);
                            buffer = buffer.substring(boundary + 1);
                            parseSSELine(line);
                        }
                    });

                    stream.on('end', () => {
                        endFired = true;
                        handleStreamEnd();
                    });

                    stream.on('close', () => {
                        // `close` without a preceding `end` means the connection was
                        // torn down mid-stream — a transport failure, not a normal
                        // end with whatever partial events happened to arrive.
                        if (!endFired && !settled) {
                            LogError(`[SkipSDK] SSE stream closed prematurely for ${url}`);
                            settleReject(new Error('SSE stream closed before completion'));
                        }
                    });

                    stream.on('error', (e: Error) => {
                        LogError(`[SkipSDK] SSE stream error for ${url}: ${e.message}`);
                        settleReject(new Error(`SSE stream error: ${e.message}`));
                    });
                });

                req.on('error', (e: Error) => {
                    LogError(`[SkipSDK] SSE request error for ${url}: ${e.message}`);
                    settleReject(new Error(`HTTP request failed to ${url}: ${e.message}`));
                });

                req.write(compressed);
                req.end();
            } catch (e) {
                LogError(`[SkipSDK] sendSSERequest error: ${e}`);
                reject(e);
            }
        });
    }

    /**
     * Rebuilds the entity information that is provided to Skip. Filters entities by schema/scope
     * config and fields by AI scope. Returns EntityInfo objects directly — no intermediate
     * Skip-specific types needed.
     *
     * Never throws. A result is not cacheable when the build threw, or when the provider has no
     * entity metadata yet (a request racing server boot) — keeping either would freeze an empty
     * payload in place. An entity that fails to build is dropped and logged; that failure is
     * deterministic, so retrying it on every request would only repeat the work.
     */
    private refreshSkipEntities(provider: IMetadataProvider): EntityBuildResult {
        try {
            if (provider.Entities.length === 0) {
                LogError('[SkipSDK.refreshSkipEntities] The provider has no entity metadata loaded yet — not caching the empty result');
                return { entities: [], cacheable: false };
            }
            const entities = this.selectEntitiesForSkip(provider);

            // buildEntityForSkip returns null on failure — those must not reach the
            // cached payload, where they would serialize as literal nulls for Skip.
            const built = entities.map((e) => this.buildEntityForSkip(e));
            const result = built.filter((entity): entity is EntityInfo => entity !== null);
            const droppedNames = entities.filter((_, i) => built[i] === null).map((e) => e.Name);
            if (droppedNames.length > 0) {
                LogError(`[SkipSDK.refreshSkipEntities] Dropped ${droppedNames.length} entities that failed to build: ${droppedNames.join(', ')}`);
            }

            LogStatus(`[SkipSDK.refreshSkipEntities] Successfully packed ${result.length} entities for Skip`);
            return { entities: result, cacheable: true };
        }
        catch (e) {
            LogError(`[SkipSDK] refreshSkipEntities error: ${e}`);
            return { entities: [], cacheable: false };
        }
    }

    /**
     * Picks the entities Skip should see: those outside the configured excluded schemas (or
     * explicitly re-included from them) whose scope includes AI.
     */
    private selectEntitiesForSkip(md: IMetadataProvider): EntityInfo[] {
        const skipConfig = getSkipConfig();

        // Diagnostic logging
        LogStatus(`[SkipSDK.refreshSkipEntities] Total entities in metadata: ${md.Entities.length}`);
        LogStatus(`[SkipSDK.refreshSkipEntities] Config excludeSchemas: ${JSON.stringify(skipConfig.entitiesToSend?.excludeSchemas)}`);
        LogStatus(`[SkipSDK.refreshSkipEntities] Config includeEntitiesFromExcludedSchemas: ${JSON.stringify(skipConfig.entitiesToSend?.includeEntitiesFromExcludedSchemas)}`);

        const skipSpecialIncludeEntities = (skipConfig.entitiesToSend?.includeEntitiesFromExcludedSchemas ?? [])
            .map((e) => e.trim().toLowerCase());

        // Get the list of entities
        const entities = md.Entities.filter((e) => {
            if (!(skipConfig.entitiesToSend?.excludeSchemas ?? []).includes(e.SchemaName) ||
                skipSpecialIncludeEntities.includes(e.Name.trim().toLowerCase())) {
                const sd = e.ScopeDefault?.trim();
                if (sd && sd.length > 0) {
                    const scopes = sd.split(',').map((s) => s.trim().toLowerCase()) ?? ['all'];
                    return !scopes || scopes.length === 0 || scopes.includes('all') || scopes.includes('ai') || skipSpecialIncludeEntities.includes(e.Name.trim().toLowerCase());
                }
                else {
                    return true; // no scope, so include it
                }
            }
            return false;
        });

        LogStatus(`[SkipSDK.refreshSkipEntities] Filtered entities count: ${entities.length}`);
        if (entities.length === 0) {
            LogError(`[SkipSDK.refreshSkipEntities] WARNING: No entities passed filtering! This will result in empty Skip entities list.`);
        }
        return entities;
    }

    /**
     * Builds an EntityInfo object for Skip with only the fields visible to AI. Returns a new
     * EntityInfo constructed from a plain object so it serializes cleanly via toJSON().
     *
     * Field values are the `EntityFieldValues` metadata as CodeGen maintains it — parsed from
     * CHECK constraints, or from value lists in additionalSchemaInfo — and are passed through
     * untouched. The SDK does not query the database for possible values.
     */
    private buildEntityForSkip(e: EntityInfo): EntityInfo | null {
        try {
            // Filter fields by scope (only include fields visible to AI)
            const fields = e.Fields
                .filter((f) => {
                    const scopes = f.ScopeDefault?.split(',').map((s) => s.trim().toLowerCase());
                    return !scopes || scopes.length === 0 || scopes.includes('all') || scopes.includes('ai');
                })
                .map((f) => ({ ...f.toJSON(), EntityFieldValues: f.EntityFieldValues }));

            // Clone the entity via toJSON, then swap in the filtered fields and Skip-specific
            // Active-only organic keys. Any future EntityInfo properties flow through automatically.
            return new EntityInfo({
                ...e.toJSON(),
                Fields: fields,
                OrganicKeys: e.OrganicKeys.filter(ok => ok.Status === 'Active'),
            });
        }
        catch (err) {
            LogError(`[SkipSDK] buildEntityForSkip error: ${err}`);
            return null;
        }
    }

    /**
     * Process messages: filter delegation messages and add metadata fields
     * Messages coming in should already have conversationDetailID if they exist in the database
     */
    private processMessages(messages: SkipMessage[]): SkipMessage[] {
        // Filter out delegation messages (administrative messages that shouldn't go to Skip)
        const filteredMessages = messages.filter(msg => !this.isDelegationMessage(msg.content));

        // Enrich messages with default metadata if not already present
        return filteredMessages.map(msg => ({
            ...msg,
            // Add default metadata fields if not already present
            // Messages from DB already have conversationDetailID, temp messages get temp-X
            hiddenToUser: msg.hiddenToUser ?? false,
            userRating: msg.userRating ?? null,
            userFeedback: msg.userFeedback ?? null,
            reflectionInsights: msg.reflectionInsights ?? null,
            summaryOfEarlierConveration: msg.summaryOfEarlierConveration ?? null
        }));
    }

    /**
     * Trigger an eval run on the Skip API.
     *
     * Builds the same entity/query/auth context as chat(), but sends to the
     * /eval/run-agent endpoint with eval-specific fields (fixture, optimal, scoring).
     * Uses a standard JSON request/response (no SSE streaming). The request may wait up to
     * `evalRunAgentTimeoutMs` (skip.config.cjs) for the response.
     */
    async evalRunAgent(options: SkipEvalOptions): Promise<SkipEvalResult> {
        const evalUrl = this.getEvalUrl('run-agent');
        const timeoutMs = getSkipConfig().evalRunAgentTimeoutMs ?? DEFAULT_EVAL_RUN_AGENT_TIMEOUT_MS;
        LogStatus(`[SkipSDK] Sending eval run to: ${evalUrl} (timeout ${Math.round(timeoutMs / 1000)} s)`);

        try {
            if (options.provider) {
                this.Provider = options.provider;
            }

            // Resolve the Skip API key from the credential store when ASK_SKIP_API_KEY
            // is unset — same path chat() takes, otherwise x-api-key is sent empty.
            await this.ensureConfig(options.contextUser);

            const baseRequest = await this.buildBaseRequest(
                options.contextUser,
                options.dataSource,
                true,   // includeEntities
                true,   // includeQueries
                false,  // includeNotes
                false,  // includeRequests
                false,  // forceEntityRefresh
                true,   // includeCallbackAuth
            );

            const evalRequest = {
                agentName: options.agentName,
                agentPayload: options.agentPayload,
                optimalOutput: options.optimalOutput,
                scoring: options.scoring,
                entityCatalog: baseRequest.entities || [],
                queryCatalog: baseRequest.queries || [],
                connection: {
                    callingServerURL: baseRequest.callingServerURL,
                    callingServerAPIKey: baseRequest.callingServerAPIKey,
                },
                databasePlatform: baseRequest.databasePlatform,
            };

            const response = await fetch(evalUrl, {
                method: 'POST',
                headers: this.buildHeaders(),
                body: JSON.stringify(evalRequest),
                signal: AbortSignal.timeout(timeoutMs),
                dispatcher: getEvalDispatcher(timeoutMs),
            } as RequestInit & { dispatcher: Agent });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Skip eval API returned ${response.status}: ${text.slice(0, 500)}`);
            }

            return await response.json() as SkipEvalResult;
        } catch (error) {
            const message = describeEvalError(error, timeoutMs);
            LogError(`[SkipSDK] Eval run error: ${message}`, null, error);
            return {
                success: false,
                error: message,
            };
        }
    }

    /**
     * Trigger a standalone prompt eval on the Skip API.
     *
     * Unlike evalRunAgent(), this doesn't need entity/query catalogs or agent execution.
     * Sends prompt data directly to the /eval/run-prompt endpoint for execution and scoring.
     */
    async evalRunPrompt(options: SkipEvalPromptOptions): Promise<SkipEvalResult> {
        const evalUrl = this.getEvalUrl('run-prompt');
        LogStatus(`[SkipSDK] Sending prompt eval to: ${evalUrl}`);

        try {
            if (options.provider) {
                this.Provider = options.provider;
            }

            // Resolve the Skip API key from the credential store when ASK_SKIP_API_KEY
            // is unset — same path chat() takes, otherwise x-api-key is sent empty.
            await this.ensureConfig(options.contextUser);

            const evalRequest = {
                promptName: options.promptName,
                promptData: options.promptData,
                optimalOutput: options.optimalOutput,
                scoring: options.scoring,
            };

            const response = await fetch(evalUrl, {
                method: 'POST',
                headers: this.buildHeaders(),
                body: JSON.stringify(evalRequest),
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Skip prompt eval API returned ${response.status}: ${text.slice(0, 500)}`);
            }

            return await response.json() as SkipEvalResult;
        } catch (error) {
            LogError(`[SkipSDK] Prompt eval error: ${error}`);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Derive an eval endpoint URL from the base URL.
     * e.g. "https://brain-prod.askskip.ai" → "https://brain-prod.askskip.ai/eval/run-agent"
     */
    private getEvalUrl(path: string): string {
        const baseUrl = (this.config.apiUrl || '').replace(/\/+$/, '');
        return `${baseUrl}/eval/${path}`;
    }

    /**
     * Check if a message is a delegation message that should be filtered out
     * Uses flexible pattern matching to detect variations of delegation messages
     */
    private isDelegationMessage(content: string): boolean {
        if (!content) return false;

        const lowerContent = content.toLowerCase();

        // Check for both "delegating" or "delegate" AND "skip" in any order
        const hasDelegatingOrDelegate = lowerContent.includes('delegating') || lowerContent.includes('delegate');
        const hasSkip = lowerContent.includes('skip');

        return hasDelegatingOrDelegate && hasSkip;
    }
}
