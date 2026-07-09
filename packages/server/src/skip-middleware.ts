/**
 * Skip server middleware.
 *
 * Registered via `@RegisterClass(BaseServerMiddleware, 'skip')` and discovered by
 * MJServer's serve() at boot (after the DB pool, Metadata, UserCache and APIKeyEngine
 * are ready, and before the GraphQL schema is built / any agent runs). Its Initialize()
 * verifies that the scoped-callback prerequisites this app deploys are actually present
 * on the instance — so a misconfigured install fails loud rather than silently degrading.
 *
 * Importing this module also pulls in skip-agent.js, triggering the
 * `@RegisterClass(BaseAgent, 'SkipProxyAgent')` registration.
 */
import { RegisterClass } from '@memberjunction/global';
import { BaseServerMiddleware } from '@memberjunction/server';
import { LogStatus, LogError, Metadata } from '@memberjunction/core';
import type { IMetadataProvider, UserInfo } from '@memberjunction/core';
import type { Application, Request, Response, RequestHandler } from 'express';
import { Router, json as jsonBodyParser } from 'express';
import { GetAPIKeyEngine } from '@memberjunction/api-keys';
import { UserCache } from '@memberjunction/sqlserver-dataprovider';
import { ensureSkipRecords, getSkipConfig, DEFAULT_SKIP_BASE_URL } from '@askskip/core';
import { SkipSDK } from './skip-sdk.js';

// Side-effect import: ensure SkipProxyAgent's @RegisterClass(BaseAgent, 'SkipProxyAgent') runs.
import './skip-agent.js';

/** Scopes the callback-key provisioner assigns; all must exist for provisioning to succeed. */
const REQUIRED_SCOPE_PATHS = [
    'view:run', 'view:batch', 'query:run', 'query:create', 'query:update', 'query:delete',
    'query:test', 'search:execute', 'prompt:execute', 'agent:execute', 'embedding:generate',
];
const SKIP_SERVICE_EMAIL = 'skip-service@skip.internal';

@RegisterClass(BaseServerMiddleware, 'skip')
export class SkipMiddleware extends BaseServerMiddleware {
    get Label(): string {
        return 'skip-client';
    }

    /**
     * Always on: the SDK ships a baked-in default Skip endpoint, so installing the app is
     * the opt-in. The API key may live only in the encrypted credential store (resolved
     * lazily per request), so its absence from env doesn't mean "not configured".
     */
    get Enabled(): boolean {
        return true;
    }

    /**
     * Verifies the scoped-callback prerequisites are present (Skip Service Account user +
     * the required API scopes) and warns loudly if not. Does not throw — a warning here
     * is preferable to aborting server boot; the provisioner re-checks on first request.
     */
    async Initialize(): Promise<void> {
        try {
            // Derive REGISTRY_URI_OVERRIDE_SKIP and REGISTRY_API_KEY_SKIP from the Skip
            // config so operators don't have to set them separately. MJ's ComponentRegistryResolver
            // reads these env vars to override the production registry URI and authenticate.
            // Only set if not already explicitly configured (env vars win over derived values).
            this.deriveRegistryEnvVars();

            const engine = GetAPIKeyEngine();
            const scopes = engine.Scopes ?? [];
            // Only run the scope check once the engine cache is populated; an empty cache
            // means scopes weren't loaded yet (not necessarily missing) — skip to avoid a false alarm.
            const missingScopes = scopes.length
                ? REQUIRED_SCOPE_PATHS.filter((p) => !scopes.some((s) => s.FullPath === p))
                : [];

            const serviceAccount = UserCache.Instance.Users.find(
                (u) => u.Email?.toLowerCase() === SKIP_SERVICE_EMAIL,
            );

            if (!serviceAccount) {
                LogError(
                    `[skip-client] Skip Service Account (${SKIP_SERVICE_EMAIL}) not found in the user cache. ` +
                    `The Skip Client app's install migration should have created it. ` +
                    `Scoped callback key provisioning will fail until this is resolved.`,
                );
            }
            if (missingScopes.length) {
                LogError(
                    `[skip-client] Missing required API scopes: ${missingScopes.join(', ')}. ` +
                    `These ship with the MJ core build that supports this app — ensure the host MJ version is up to date. ` +
                    `Scoped callback provisioning will fail until they exist.`,
                );
            }
            if (serviceAccount && !missingScopes.length) {
                LogStatus(
                    '[skip-client] Skip client ready: service account and required scopes present. ' +
                    'A scoped callback key will be provisioned on the first Skip request.',
                );
            }

            // Self-heal the app-owned Skip metadata records (the "Skip" agent + component registry).
            // Core metadata sync removes the legacy core-seeded copies via deleteRecord tombstones;
            // this app owns them on Skip instances. Idempotent, so this is a no-op once present —
            // but it guarantees @skip keeps working even after a core sync drops the legacy agent.
            const systemUser = UserCache.Instance.GetSystemUser();
            if (systemUser) {
                await ensureSkipRecords(new Metadata() as unknown as IMetadataProvider, systemUser, (m) => LogStatus(m));
            }
        } catch (e) {
            LogError(`[skip-client] Middleware Initialize() warning: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Register Skip eval proxy endpoints as post-auth middleware.
     *
     * Only enabled when `enableEval: true` is set in `skip.config.cjs`. This
     * ensures eval endpoints are not exposed on production client environments.
     * Only eval-target environments (e.g. More Cheese staging) opt in.
     *
     * Routes run AFTER the unified auth middleware so `req['mjUser']` is populated.
     */
    GetPostAuthMiddleware(): RequestHandler[] {
        const config = getSkipConfig();
        if (!config.enableEval) {
            return [];
        }

        const evalRouter = Router();
        evalRouter.use(jsonBodyParser({ limit: '50mb' }));

        evalRouter.post('/eval/run', async (req: Request, res: Response) => {
            try {
                const userRecord = (req as unknown as Record<string, unknown>)['mjUser'] as UserInfo | undefined;
                if (!userRecord) {
                    res.status(401).json({ success: false, error: 'Authentication required' });
                    return;
                }

                const { agentName, agentPayload, optimalOutput, scoring } = req.body;
                if (!agentName || !agentPayload || !optimalOutput || !scoring) {
                    res.status(400).json({ success: false, error: 'Missing required fields: agentName, agentPayload, optimalOutput, scoring' });
                    return;
                }

                const sdk = new SkipSDK();
                const dataSources = (req as unknown as Record<string, unknown>)['dataSources'] as Array<{ dataSource: unknown }> | undefined;
                const result = await sdk.evalRunAgent({
                    agentName,
                    agentPayload,
                    optimalOutput,
                    scoring,
                    contextUser: userRecord,
                    dataSource: dataSources?.[0]?.dataSource as import('mssql').ConnectionPool,
                });

                res.json(result);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                LogError(`[skip-client/eval] Error: ${msg}`);
                res.status(500).json({ success: false, error: msg });
            }
        });

        evalRouter.post('/eval/run-prompt', async (req: Request, res: Response) => {
            try {
                const userRecord = (req as unknown as Record<string, unknown>)['mjUser'] as UserInfo | undefined;
                if (!userRecord) {
                    res.status(401).json({ success: false, error: 'Authentication required' });
                    return;
                }

                const { promptName, promptData, optimalOutput, scoring } = req.body;
                if (!promptName || !promptData || !optimalOutput || !scoring) {
                    res.status(400).json({ success: false, error: 'Missing required fields: promptName, promptData, optimalOutput, scoring' });
                    return;
                }

                const sdk = new SkipSDK();
                const result = await sdk.evalRunPrompt({
                    promptName,
                    promptData,
                    optimalOutput,
                    scoring,
                    contextUser: userRecord,
                });

                res.json(result);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                LogError(`[skip-client/eval] Prompt eval error: ${msg}`);
                res.status(500).json({ success: false, error: msg });
            }
        });

        LogStatus('[skip-client] Registered /eval/run and /eval/run-prompt endpoints (post-auth).');
        return [evalRouter as unknown as RequestHandler];
    }

    /** No Skip-specific GraphQL resolvers today; reserved for future client-side Skip endpoints. */
    GetResolverPaths(): string[] {
        return [];
    }

    /**
     * Derive REGISTRY_URI_OVERRIDE_SKIP and REGISTRY_API_KEY_SKIP from the Skip config
     * so operators don't need separate env vars for the component registry. MJ's
     * ComponentRegistryResolver reads these to override the production registry URI
     * (stored in the DB as https://registry.askskip.ai/) and to authenticate.
     *
     * Only sets them when ASK_SKIP_URL points at a non-production Skip instance —
     * production uses the DB-stored URI directly and resolves the API key from the
     * credential store. Explicit env vars always win (not overwritten).
     */
    private deriveRegistryEnvVars(): void {
        const config = getSkipConfig();
        const skipURL = config.skipURL?.replace(/\/+$/, '');

        // Derive registry URI: only override when pointing at non-production Skip
        if (skipURL && skipURL !== DEFAULT_SKIP_BASE_URL && !process.env.REGISTRY_URI_OVERRIDE_SKIP) {
            process.env.REGISTRY_URI_OVERRIDE_SKIP = `${skipURL}/registry/api/v1`;
            LogStatus(`[skip-client] Derived REGISTRY_URI_OVERRIDE_SKIP from ASK_SKIP_URL: ${process.env.REGISTRY_URI_OVERRIDE_SKIP}`);
        }

        // Derive registry API key: reuse the Skip API key if no explicit registry key is set
        if (config.apiKey && !process.env.REGISTRY_API_KEY_SKIP) {
            process.env.REGISTRY_API_KEY_SKIP = config.apiKey;
            LogStatus('[skip-client] Derived REGISTRY_API_KEY_SKIP from ASK_SKIP_API_KEY.');
        }
    }
}
