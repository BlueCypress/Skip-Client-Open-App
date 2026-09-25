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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RegisterClass } from '@memberjunction/global';
import { BaseServerMiddleware } from '@memberjunction/server';
import { LogStatus, LogError, Metadata } from '@memberjunction/core';
import type { UserInfo } from '@memberjunction/core';
import type { Application, Request, Response, RequestHandler } from 'express';
import { Router, json as jsonBodyParser } from 'express';
import { GetAPIKeyEngine } from '@memberjunction/api-keys';
import { UserCache } from '@memberjunction/sqlserver-dataprovider';
import {
    ensureSkipRecords,
    getSkipConfig,
    DEFAULT_SKIP_BASE_URL,
    DEFAULT_SKIP_REGISTRY_NAME,
    fetchSkipRegistryName,
    getRegistryAPIKeyEnvVar,
    getRegistryURIOverrideEnvVar,
    getSkipRegistryURI,
    resolveSkipApiKey,
} from '@askskip/core';
import { SkipSDK } from './skip-sdk.js';
import { APP_OWNED_SCOPE_PATHS, REQUIRED_SCOPE_PATHS } from './skip-callback-key-provisioner.js';
import { markRegistryReconciled } from './registry-reconciler.js';

// Side-effect import: ensure SkipProxyAgent's @RegisterClass(BaseAgent, 'SkipProxyAgent') runs.
import './skip-agent.js';

const SKIP_SERVICE_EMAIL = 'skip-service@skip.internal';

/** This package is ESM, so `__dirname` does not exist — derive it from the module URL. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

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
            // Ask the brain which registry it publishes under BEFORE deriving anything: both
            // env var names and the registry record's identity are functions of that name.
            // A null answer means "unknown" — derive and manage nothing rather than guess.
            const registryName = await this.resolveRegistryName();

            this.warnIfRegistryNameSetOnClient();

            if (registryName) {
                // Derive REGISTRY_URI_OVERRIDE_<NAME> and REGISTRY_API_KEY_<NAME> from the Skip
                // config so operators don't have to set them separately. MJ's ComponentRegistryResolver
                // reads these env vars to override the registry URI and authenticate.
                // Only set if not already explicitly configured (env vars win over derived values).
                await this.deriveRegistryEnvVars(registryName);
            }
            this.logAdvertisedCallbackURL();

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
                // The two kinds of missing scope have different fixes, and reporting
                // them under one message sends operators to the wrong one: an MJ
                // upgrade will never produce `query:profile`, and this app's
                // migrations will never produce `query:run`.
                const appOwned = missingScopes.filter((p) => APP_OWNED_SCOPE_PATHS.includes(p));
                const mjCore = missingScopes.filter((p) => !APP_OWNED_SCOPE_PATHS.includes(p));

                if (mjCore.length) {
                    LogError(
                        `[skip-client] Missing required MJ core API scopes: ${mjCore.join(', ')}. ` +
                        `These ship with the MJ core build that supports this app — ensure the host MJ version is up to date. ` +
                        `Scoped callback provisioning will fail until they exist.`,
                    );
                }
                if (appOwned.length) {
                    LogError(
                        `[skip-client] Missing Skip Client API scopes: ${appOwned.join(', ')}. ` +
                        `These are seeded by this app's own migrations, not by MJ — run the app install/upgrade so its migrations apply. ` +
                        `Until then the affected capability degrades: query profiling returns test results without statistics.`,
                    );
                }
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
                // Metadata.Provider, not `new Metadata()` — the instance only satisfies
                // IMetadataProvider through a cast, and happens to work here solely because
                // ensureSkipRecords sticks to GetEntityObject(). Passing the real provider
                // keeps that from silently breaking if it ever reaches for more.
                await ensureSkipRecords(Metadata.Provider, systemUser, (m) => LogStatus(m), registryName ?? undefined);
                if (registryName) {
                    // Startup got there first; the request path need not repeat this.
                    markRegistryReconciled(registryName);
                }
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

    /**
     * Skip-specific GraphQL resolvers, merged into the host MJServer schema by
     * `serve()`. Currently `TestAndProfileQuerySQL` — a superset of MJ's
     * `TestQuerySQL` that can additionally return statistics computed over the
     * full uncapped result set without row data leaving the client's database.
     *
     * Additive and inert: nothing calls it until Skip does, and Skip degrades
     * cleanly against deployments that predate it.
     */
    GetResolverPaths(): string[] {
        return [path.join(MODULE_DIR, 'resolvers', '*Resolver.{js,ts}')];
    }

    /**
     * Reports the callback URL the SDK will advertise to Skip as `callingServerURL`
     * (same derivation as skip-sdk's buildBaseRequest), so a misconfigured value —
     * e.g. `http://localhost:4000/` on a deployed instance — is visible in boot logs.
     */
    private logAdvertisedCallbackURL(): void {
        const config = getSkipConfig();
        const callbackURL = config.publicUrl || `${config.baseUrl}:${config.graphqlPort}${config.graphqlRootPath}`;
        LogStatus(`[skip-client] Callback URL advertised to Skip (callingServerURL): ${callbackURL}. ` +
            'Set MJAPI_PUBLIC_URL (or GRAPHQL_BASE_URL/GRAPHQL_PORT/GRAPHQL_ROOT_PATH) if Skip cannot reach this address.');
    }

    /**
     * Derive REGISTRY_URI_OVERRIDE_SKIP and REGISTRY_API_KEY_SKIP from the Skip config
     * so operators don't need separate env vars for the component registry. MJ's
     * ComponentRegistryResolver reads these to override the URI stored on the registry
     * record and to authenticate.
     *
     * Only sets the URI override when ASK_SKIP_URL points at a non-production Skip instance —
     * otherwise the DB-stored URI stands on its own. Runs before ensureSkipRecords() below,
     * so the URI this derives is also the one persisted on the record: env and DB agree
     * instead of the row quietly claiming production. Explicit env vars always win
     * (not overwritten).
     */
    private async deriveRegistryEnvVars(registryName: string): Promise<void> {
        const config = getSkipConfig();
        const skipURL = config.skipURL?.replace(/\/+$/, '');

        // Both variable names are derived from the registry name, because that is how MJ
        // reads them (ComponentRegistryResolver uppercases the Name and replaces every
        // non-alphanumeric character with '_'). Hardcoding the production spelling would
        // set variables MJ never looks at on a non-production instance.
        const uriOverrideVar = getRegistryURIOverrideEnvVar(registryName);
        const apiKeyVar = getRegistryAPIKeyEnvVar(registryName);

        // Derive registry URI: only override when pointing at non-production Skip
        if (skipURL && skipURL !== DEFAULT_SKIP_BASE_URL && !process.env[uriOverrideVar]) {
            process.env[uriOverrideVar] = getSkipRegistryURI(skipURL);
            LogStatus(`[skip-client] Derived ${uriOverrideVar} from ASK_SKIP_URL: ${process.env[uriOverrideVar]}`);
        }

        // Derive registry API key: reuse the Skip API key if no explicit registry key is set.
        // The key may live only in the encrypted credential store (not in ASK_SKIP_API_KEY env),
        // so fall back to resolveSkipApiKey() which checks the credential store.
        if (!process.env[apiKeyVar]) {
            let apiKey = config.apiKey;
            if (!apiKey) {
                const systemUser = UserCache.Instance.GetSystemUser();
                if (systemUser) {
                    apiKey = await resolveSkipApiKey(systemUser);
                }
            }
            if (apiKey) {
                process.env[apiKeyVar] = apiKey;
                LogStatus(`[skip-client] Derived ${apiKeyVar} from Skip API key.`);
            }
        }
    }

    /**
     * Warns when `SKIP_REGISTRY_NAME` is set in the *client's* environment.
     *
     * It is the brain's variable. Nothing on this side reads it — the client asks the brain
     * for its registry name precisely so the two cannot be configured into disagreement. A
     * developer who sets it here sees no error and no effect, and reasonably concludes the
     * feature is broken, so say so plainly rather than ignoring it.
     */
    private warnIfRegistryNameSetOnClient(): void {
        // Spelled out rather than imported. This variable belongs to the Skip brain (its
        // authoritative definition is SKIP_REGISTRY_NAME_ENV_VAR in Skip-Brain's
        // @skip-brain/core), and the client only ever observes it to report a misconfiguration.
        // Taking a package dependency for one diagnostic string would couple the two
        // repositories for less than it costs.
        const BRAIN_REGISTRY_NAME_ENV_VAR = 'SKIP_REGISTRY_NAME';
        const stray = process.env[BRAIN_REGISTRY_NAME_ENV_VAR]?.trim();
        if (!stray) {
            return;
        }
        LogError(
            `[skip-client] ${BRAIN_REGISTRY_NAME_ENV_VAR}="${stray}" is set in this MJAPI environment, where it ` +
            `has no effect — it configures the Skip brain, not the client. This client asks the brain which ` +
            `registry it publishes under. Set it in the brain's environment and restart the brain, then restart ` +
            `this server (or send one Skip request) to pick it up.`,
        );
    }

    /**
     * Asks the brain which registry name it publishes under. Returns `null` when the brain
     * does not answer.
     *
     * `null` means *unknown*, and must not be collapsed into the production default. A brain
     * that is merely slow to start would otherwise cause this client to manage the
     * production "Skip" record on a machine pointed at a local brain, rewriting production's
     * URI to `localhost` — the precise drift per-environment naming exists to eliminate, and
     * a transient outage at boot is an entirely ordinary way to hit it.
     *
     * A brain predating per-environment naming also returns `null`. That is equally
     * unknown: it might be production or it might not, and this client cannot tell.
     */
    private async resolveRegistryName(): Promise<string | null> {
        const config = getSkipConfig();
        let apiKey = config.apiKey;
        if (!apiKey) {
            const systemUser = UserCache.Instance.GetSystemUser();
            if (systemUser) {
                apiKey = await resolveSkipApiKey(systemUser);
            }
        }

        const reported = await fetchSkipRegistryName({ skipURL: config.skipURL, apiKey });
        if (!reported) {
            LogStatus(
                `[skip-client] Brain at ${config.skipURL} did not report a registry name (unreachable, or a ` +
                `build predating per-environment registries). Leaving all Component Registry records and ` +
                `REGISTRY_* variables untouched this boot — existing records keep serving components.`,
            );
            return null;
        }

        if (reported !== DEFAULT_SKIP_REGISTRY_NAME) {
            LogStatus(`[skip-client] Brain publishes components under the "${reported}" component registry.`);
        }
        return reported;
    }
}
