/**
 * Skip server middleware.
 *
 * Registered via `@RegisterClass(BaseServerMiddleware, 'skip')` and discovered by
 * MJServer's serve() at boot (after the DB pool, Metadata, UserCache and APIKeyEngine
 * are ready, and before the GraphQL schema is built / any agent runs). Its Initialize()
 * verifies that the scoped-callback prerequisites this app deploys are actually present
 * on the instance — so a misconfigured install fails loud rather than silently falling
 * back to the unrestricted MJ_API_KEY callback path.
 *
 * Importing this module also pulls in skip-agent.js, triggering the
 * `@RegisterClass(BaseAgent, 'SkipProxyAgent')` registration.
 */
import { RegisterClass } from '@memberjunction/global';
import { BaseServerMiddleware } from '@memberjunction/server';
import { LogStatus, LogError, Metadata } from '@memberjunction/core';
import type { IMetadataProvider } from '@memberjunction/core';
import { GetAPIKeyEngine } from '@memberjunction/api-keys';
import { UserCache } from '@memberjunction/sqlserver-dataprovider';
import { getSkipConfig } from './skip-config.js';
import { ensureSkipRecords } from './skip-records.js';

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

    /** Active only when this instance is configured to talk to Skip. */
    get Enabled(): boolean {
        const cfg = getSkipConfig();
        return !!(cfg.apiKey || cfg.chatURL);
    }

    /**
     * Verifies the scoped-callback prerequisites are present (Skip Service Account user +
     * the required API scopes) and warns loudly if not. Does not throw — a warning here
     * is preferable to aborting server boot; the provisioner re-checks on first request.
     */
    async Initialize(): Promise<void> {
        try {
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
                    `The Skip Client app's install migration should have created it. Skip callbacks will fall back ` +
                    `to the legacy MJ_API_KEY until this is resolved.`,
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

    /** No Skip-specific GraphQL resolvers today; reserved for future client-side Skip endpoints. */
    GetResolverPaths(): string[] {
        return [];
    }
}
