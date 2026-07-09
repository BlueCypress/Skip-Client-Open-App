/**
 * Skip Client Configuration
 *
 * Centralizes configuration the Skip client SDK needs, decoupled from the host
 * MJServer. Reads from environment variables, and resolves the Skip API key from
 * the MJ-core encrypted credential store when available (falling back to env).
 */

import { CredentialEngine } from '@memberjunction/credentials';
import type { UserInfo } from '@memberjunction/core';

/** Default Skip API base URL. Override with ASK_SKIP_CHAT_URL env var for non-production environments. */
export const DEFAULT_SKIP_BASE_URL = 'https://brain-prod.askskip.ai';

/** Default Skip chat endpoint derived from the base URL. */
export const DEFAULT_SKIP_CHAT_URL = `${DEFAULT_SKIP_BASE_URL}/chat`;

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
    chatURL?: string;
    apiKey?: string;
    baseUrl?: string;
    publicUrl?: string;
    graphqlPort?: number;
    graphqlRootPath?: string;
    entitiesToSend?: SkipEntitiesToSendConfig;
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
 * Attempts to load a `skip.config.cjs` file from the MJAPI working directory.
 * Returns the `entitiesToSend` section if present, otherwise falls back to
 * {@link DEFAULT_ENTITIES_TO_SEND}.
 *
 * The file is expected to export an object like:
 * ```js
 * module.exports = {
 *     entitiesToSend: {
 *         excludeSchemas: ['__mj'],
 *         includeEntitiesFromExcludedSchemas: ['Entities', 'Entity Fields'],
 *     },
 * };
 * ```
 */
function loadEntitiesToSend(): SkipEntitiesToSendConfig {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cfg = require(require('path').resolve(process.cwd(), 'skip.config.cjs'));
        if (cfg?.entitiesToSend) {
            return {
                excludeSchemas: cfg.entitiesToSend.excludeSchemas ?? DEFAULT_ENTITIES_TO_SEND.excludeSchemas,
                includeEntitiesFromExcludedSchemas:
                    cfg.entitiesToSend.includeEntitiesFromExcludedSchemas ?? DEFAULT_ENTITIES_TO_SEND.includeEntitiesFromExcludedSchemas,
            };
        }
    } catch {
        // No skip.config.cjs found — use defaults (this is normal for most installs)
    }
    return DEFAULT_ENTITIES_TO_SEND;
}

/**
 * Reads Skip client configuration from environment variables and skip.config.cjs.
 */
export function getSkipConfig(): SkipClientConfig {
    return {
        chatURL: process.env.ASK_SKIP_CHAT_URL ?? DEFAULT_SKIP_CHAT_URL,
        apiKey: process.env.ASK_SKIP_API_KEY,
        // Defaults mirror MJServer's config.ts (baseUrl/publicUrl/graphqlPort/graphqlRootPath)
        // so the callback URL `${baseUrl}:${graphqlPort}${graphqlRootPath}` is well-formed even
        // when the env vars are unset (otherwise graphqlRootPath -> "undefined" in the URL).
        baseUrl: process.env.GRAPHQL_BASE_URL ?? 'http://localhost',
        publicUrl: process.env.MJAPI_PUBLIC_URL, // empty/undefined -> SDK falls back to baseUrl:port+rootPath
        graphqlPort: process.env.GRAPHQL_PORT ? parseInt(process.env.GRAPHQL_PORT, 10) : 4000,
        graphqlRootPath: process.env.GRAPHQL_ROOT_PATH ?? '/',
        entitiesToSend: loadEntitiesToSend(),
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
 * Returns the database platform Skip should target, derived from DB_PROVIDER.
 * Replacement for MJServer's getDbType.
 */
export function getDbType(): 'sqlserver' | 'postgresql' {
    return process.env.DB_PROVIDER?.toLowerCase().includes('pg') || process.env.DB_PROVIDER?.toLowerCase() === 'postgresql'
        ? 'postgresql'
        : 'sqlserver';
}
