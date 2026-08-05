/**
 * Skip Client Configuration
 *
 * Centralizes configuration the Skip client SDK needs, decoupled from the host
 * MJServer. Reads from environment variables, and resolves the Skip API key from
 * the MJ-core encrypted credential store when available (falling back to env).
 */

import { createRequire } from 'module';
import { resolve, dirname, parse } from 'path';
import { CredentialEngine } from '@memberjunction/credentials';
import type { UserInfo } from '@memberjunction/core';

/** Default Skip API base URL. Override with ASK_SKIP_URL env var for non-production environments. */
export const DEFAULT_SKIP_BASE_URL = 'https://brain-prod.askskip.ai';

/** Removes any trailing slashes so URIs concatenate predictably. */
function stripTrailingSlashes(url: string): string {
    return url.replace(/\/+$/, '');
}

/**
 * Builds the component registry base URI for a given Skip API base URL.
 * MJ's ComponentRegistryClient appends `/api/v1/...` paths itself, so the
 * base URI must end at `/registry` — NOT `/registry/api/v1`.
 */
export function getSkipRegistryURI(skipBaseURL: string = DEFAULT_SKIP_BASE_URL): string {
    return `${stripTrailingSlashes(skipBaseURL)}/registry`;
}

/**
 * Environment variable MJ reads to override the "Skip" component registry's URI.
 *
 * The name is not ours to choose: `ComponentRegistryResolver.getRegistryUri()` derives it
 * from the registry record's `Name` — uppercased with every non-alphanumeric character
 * replaced by an underscore. Our record is named `Skip` (see `SKIP_REGISTRY_ID` in
 * skip-records.ts), so the variable is `REGISTRY_URI_OVERRIDE_SKIP`. Renaming the record
 * would rename this variable.
 */
export const SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR = 'REGISTRY_URI_OVERRIDE_SKIP';

/**
 * Resolves the component registry URI this instance is actually configured for — the value
 * setup should persist on the Component Registry record. Layered so a developer can point the
 * registry somewhere other than the brain, without that being the common case:
 *
 *  1. `REGISTRY_URI_OVERRIDE_SKIP` — an explicit registry override wins outright, letting the
 *     registry live at a different host than the chat endpoint.
 *  2. `ASK_SKIP_URL` — with no explicit override, the configured brain serves its own registry,
 *     so the same URL backs both chat and components.
 *  3. `fallbackURI` — the value already on the Component Registry record, which is the
 *     production default on any instance that has never overridden it.
 *
 * This mirrors what MJ honors at runtime (`REGISTRY_URI_OVERRIDE_SKIP`, then the stored `URI`);
 * `ASK_SKIP_URL` slots in between because {@link SkipMiddleware} derives the override from it
 * at boot when it points off production.
 *
 * @param fallbackURI URI currently stored on the registry record, if any. Omit when creating a
 *                    record from scratch — the production default is used instead.
 */
export function getConfiguredSkipRegistryURI(fallbackURI?: string | null): string {
    const override = process.env[SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR]?.trim();
    if (override) {
        return stripTrailingSlashes(override);
    }

    // Read ASK_SKIP_URL directly rather than through getSkipConfig(): only the URL matters here,
    // and getSkipConfig() also walks the filesystem for skip.config.cjs — a require() that would
    // let a malformed config file break registry resolution.
    const skipURL = process.env.ASK_SKIP_URL?.trim();
    if (skipURL) {
        return getSkipRegistryURI(skipURL);
    }

    const existing = fallbackURI?.trim();
    return existing ? stripTrailingSlashes(existing) : getSkipRegistryURI();
}

/**
 * Entity-filtering configuration loaded from `skip.config.cjs` (or defaults).
 * Controls which MJ entities are included in the metadata payload sent to the
 * Skip Brain API on each request.
 */
export interface SkipEntitiesToSendConfig {
    /** Schemas whose entities are excluded from the Skip payload (e.g. `['__mj']`). */
    excludeSchemas: string[];
    /** Specific entity names to include even when their schema is in `excludeSchemas`. */
    includeEntitiesFromExcludedSchemas: string[];
}

/**
 * Configuration shape consumed by the Skip client SDK.
 */
export interface SkipClientConfig {
    /** Skip API base URL (e.g. `https://brain-prod.askskip.ai`). Endpoints like `/chat` are derived from this. */
    skipURL?: string;
    apiKey?: string;
    baseUrl?: string;
    publicUrl?: string;
    graphqlPort?: number;
    graphqlRootPath?: string;
    entitiesToSend?: SkipEntitiesToSendConfig;
    /**
     * When true, the `/eval/run` and `/eval/run-prompt` proxy endpoints are
     * registered on the client MJAPI server. Only enable on environments that
     * serve as eval targets (e.g. More Cheese staging).
     *
     * Set in `skip.config.cjs`:
     * ```js
     * module.exports = { enableEval: true, entitiesToSend: { ... } };
     * ```
     *
     * @default false
     */
    enableEval?: boolean;
}

/**
 * Default entity-filtering config. Excludes internal MJ metadata schemas while
 * explicitly including a handful of __mj entities that Skip needs for context.
 * Exported so the setup wizard can generate a skip.config.cjs with these defaults.
 */
export const DEFAULT_ENTITIES_TO_SEND: SkipEntitiesToSendConfig = {
    excludeSchemas: ['__mj'],
    includeEntitiesFromExcludedSchemas: [
        'MJ: Tags',
        'MJ: Tagged Items',
        'MJ: Lists',
        'MJ: List Details',
        'MJ: Content Items',
        'MJ: Content Item Tags',
        'MJ: Content Item Attributes',
        'MJ: Content Sources',
        'MJ: Content Types',
        'MJ: Content Process Runs',
    ],
};

/**
 * Loads the `skip.config.cjs` file, searching from the MJAPI working directory
 * up to the repository root. This handles mono-repo layouts where `skip.config.cjs`
 * lives at the repo root but the MJAPI process CWD is a nested `apps/MJAPI` directory.
 *
 * Uses `createRequire` for ESM compatibility — the config file is CommonJS (.cjs)
 * so it must be loaded via require(), not import().
 */
function loadSkipConfigFile(): Record<string, unknown> | null {
    let dir = process.cwd();
    const root = parse(dir).root;

    while (dir !== root) {
        try {
            const req = createRequire(resolve(dir, '__placeholder.js'));
            return req('./skip.config.cjs');
        } catch {
            // Not found at this level — walk up
        }
        dir = dirname(dir);
    }

    return null;
}

/**
 * Extracts the `entitiesToSend` section from the loaded config,
 * falling back to {@link DEFAULT_ENTITIES_TO_SEND}.
 */
function resolveEntitiesToSend(cfg: Record<string, unknown> | null): SkipEntitiesToSendConfig {
    const section = cfg?.entitiesToSend as Partial<SkipEntitiesToSendConfig> | undefined;
    if (section) {
        return {
            excludeSchemas: section.excludeSchemas ?? DEFAULT_ENTITIES_TO_SEND.excludeSchemas,
            includeEntitiesFromExcludedSchemas:
                section.includeEntitiesFromExcludedSchemas ?? DEFAULT_ENTITIES_TO_SEND.includeEntitiesFromExcludedSchemas,
        };
    }
    return DEFAULT_ENTITIES_TO_SEND;
}

/**
 * Reads Skip client configuration from environment variables and skip.config.cjs.
 */
export function getSkipConfig(): SkipClientConfig {
    const fileCfg = loadSkipConfigFile();
    return {
        skipURL: process.env.ASK_SKIP_URL ?? DEFAULT_SKIP_BASE_URL,
        apiKey: process.env.ASK_SKIP_API_KEY,
        // Defaults mirror MJServer's config.ts (baseUrl/publicUrl/graphqlPort/graphqlRootPath)
        // so the callback URL `${baseUrl}:${graphqlPort}${graphqlRootPath}` is well-formed even
        // when the env vars are unset (otherwise graphqlRootPath -> "undefined" in the URL).
        baseUrl: process.env.GRAPHQL_BASE_URL ?? 'http://localhost',
        publicUrl: process.env.MJAPI_PUBLIC_URL, // empty/undefined -> SDK falls back to baseUrl:port+rootPath
        graphqlPort: process.env.GRAPHQL_PORT ? parseInt(process.env.GRAPHQL_PORT, 10) : 4000,
        graphqlRootPath: process.env.GRAPHQL_ROOT_PATH ?? '/',
        entitiesToSend: resolveEntitiesToSend(fileCfg),
        enableEval: fileCfg?.enableEval === true,
    };
}

/**
 * Resolves the Skip API key, preferring the MJ-core encrypted credential store
 * (credential name 'Skip API Key') and falling back to the ASK_SKIP_API_KEY env
 * var when the credential is not seeded yet or any error occurs.
 */
export async function resolveSkipApiKey(contextUser: UserInfo): Promise<string | undefined> {
    try {
        await CredentialEngine.Instance.Config(false, contextUser);
        const resolved = await CredentialEngine.Instance.getCredential<{ apiKey: string }>('Skip API Key', {
            contextUser,
            subsystem: 'SkipClient'
        });
        return resolved?.values?.apiKey ?? process.env.ASK_SKIP_API_KEY;
    } catch {
        return process.env.ASK_SKIP_API_KEY;
    }
}

/**
 * Returns the database platform Skip should target, derived from DB_PLATFORM.
 * Uses the same env var as MJ's resolveDbPlatformFromEnv() for consistency.
 * Falls back to DB_PROVIDER for backward compatibility.
 */
export function getDbType(): 'sqlserver' | 'postgresql' {
    const raw = (process.env.DB_PLATFORM ?? process.env.DB_PROVIDER ?? '').trim().toLowerCase();
    if (raw === 'postgresql' || raw === 'pg') {
        return 'postgresql';
    }
    return 'sqlserver';
}
