/**
 * Skip Client Configuration
 *
 * Centralizes configuration the Skip client SDK needs, decoupled from the host
 * MJServer. Reads from environment variables, and resolves the Skip API key from
 * the MJ-core encrypted credential store when available (falling back to env).
 */

import { CredentialEngine } from '@memberjunction/credentials';
import type { UserInfo } from '@memberjunction/core';

/**
 * Configuration shape consumed by the Skip client SDK.
 */
export interface SkipClientConfig {
    chatURL?: string;
    apiKey?: string;
    orgID?: string;
    organizationInfo?: string;
    baseUrl?: string;
    publicUrl?: string;
    graphqlPort?: number;
    graphqlRootPath?: string;
    entitiesToSend?: {
        excludeSchemas: string[];
        includeEntitiesFromExcludedSchemas: string[];
    };
    legacyCallbackAPIKey?: string;
}

/**
 * Reads Skip client configuration from environment variables.
 */
export function getSkipConfig(): SkipClientConfig {
    return {
        chatURL: process.env.ASK_SKIP_CHAT_URL,
        apiKey: process.env.ASK_SKIP_API_KEY,
        orgID: process.env.ASK_SKIP_ORGANIZATION_ID,
        organizationInfo: process.env.ASK_SKIP_ORGANIZATION_INFO,
        // Defaults mirror MJServer's config.ts (baseUrl/publicUrl/graphqlPort/graphqlRootPath)
        // so the callback URL `${baseUrl}:${graphqlPort}${graphqlRootPath}` is well-formed even
        // when the env vars are unset (otherwise graphqlRootPath -> "undefined" in the URL).
        baseUrl: process.env.GRAPHQL_BASE_URL ?? 'http://localhost',
        publicUrl: process.env.MJAPI_PUBLIC_URL, // empty/undefined -> SDK falls back to baseUrl:port+rootPath
        graphqlPort: process.env.GRAPHQL_PORT ? parseInt(process.env.GRAPHQL_PORT, 10) : 4000,
        graphqlRootPath: process.env.GRAPHQL_ROOT_PATH ?? '/',
        entitiesToSend: {
            excludeSchemas: [],
            includeEntitiesFromExcludedSchemas: []
        },
        legacyCallbackAPIKey: process.env.MJ_API_KEY
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
