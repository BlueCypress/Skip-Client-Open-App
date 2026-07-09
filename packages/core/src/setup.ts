/**
 * Skip Client — in-process post-install setup wizard.
 *
 * Referenced by the app manifest as `hooks.postInstallModule: "@askskip/core/setup"`.
 * The Open App engine imports this module and awaits its default export with the live
 * install payload (DB provider, context user, interactive prompt callbacks). Running
 * in-process means: no execSync 120s ceiling, no need to self-bootstrap a DB connection,
 * and real interactivity when launched from `mj app install` in a TTY.
 *
 * It gathers the Skip client configuration (prompting interactively, pre-filled from any
 * existing ASK_SKIP_* env vars; or using env values headlessly), stores the Skip API key
 * in the MJ encrypted credential store ("Skip API Key"), and reports the non-secret
 * settings for the operator to persist as MJAPI env vars. It never throws — config issues
 * are logged with guidance so a partial setup does not fail the whole install.
 */
import { LogStatus, LogError } from '@memberjunction/core';
import type { UserInfo, IMetadataProvider } from '@memberjunction/core';
import { CredentialEngine } from '@memberjunction/credentials';
import { getSkipConfig, DEFAULT_ENTITIES_TO_SEND } from './skip-config.js';
import { ensureSkipRecords } from './skip-records.js';
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Payload the Open App engine passes to in-process hook modules. Structurally matches
 * `AppHookPayload` from `@memberjunction/open-app-engine`; declared locally to avoid a
 * build-time dependency on the engine package.
 */
interface SkipHookPayload {
    App: { ID: string; Name: string; [k: string]: unknown };
    RepoRoot: string;
    Provider: unknown; // IMetadataProvider
    ContextUser: unknown; // UserInfo
    Callbacks?: {
        OnLog?: (message: string) => void;
        OnPromptInput?: (message: string, opts?: { default?: string }) => Promise<string>;
        OnPromptPassword?: (message: string) => Promise<string>;
        OnPromptConfirm?: (message: string, opts?: { default?: boolean }) => Promise<boolean>;
    };
    Manifest: unknown;
}

/** Recover the Skip base URL from a chat URL by stripping a trailing "/chat". */
function baseFromChatURL(chatURL: string | undefined): string | undefined {
    return chatURL ? chatURL.replace(/\/+$/, '').replace(/\/chat$/i, '') : undefined;
}

/** Join a base URL and a path segment with exactly one separating slash. */
function joinURL(base: string, segment: string): string {
    return `${base.replace(/\/+$/, '')}/${segment}`;
}

export default async function setup(payload: SkipHookPayload): Promise<void> {
    const cb = payload.Callbacks;
    const contextUser = payload.ContextUser as UserInfo;
    const log = (m: string) => (cb?.OnLog ? cb.OnLog(m) : LogStatus(m));
    const env = getSkipConfig();
    const interactive = !!cb?.OnPromptInput;

    log('Configuring the Skip Client app...');

    // The only interactive prompt is the API key — everything else uses defaults or env vars.
    // URL defaults to the production Skip API (baked into @askskip/core).
    const baseURL = process.env.ASK_SKIP_URL ?? baseFromChatURL(env.chatURL);
    const chatURL = baseURL ? joinURL(baseURL, 'chat') : env.chatURL;
    const apiKey = interactive
        ? cb!.OnPromptPassword
            ? await cb!.OnPromptPassword('Skip API key (ASK_SKIP_API_KEY)')
            : await cb!.OnPromptInput!('Skip API key (ASK_SKIP_API_KEY)', { default: env.apiKey })
        : env.apiKey;

    // Persist the secret (encrypted) via the MJ credential store. The SDK reads it back
    // via resolveSkipApiKey('Skip API Key'), falling back to ASK_SKIP_API_KEY env.
    if (apiKey) {
        if (!process.env.MJ_BASE_ENCRYPTION_KEY) {
            log(
                '⚠ MJ_BASE_ENCRYPTION_KEY is not set — cannot store the Skip API key encrypted. ' +
                'Set it (e.g. `openssl rand -base64 32`) and re-run setup, or keep ASK_SKIP_API_KEY ' +
                'in the MJAPI environment as a fallback.',
            );
        } else {
            try {
                await CredentialEngine.Instance.Config(false, contextUser);
                await CredentialEngine.Instance.storeCredential(
                    'API Key',
                    'Skip API Key',
                    { apiKey },
                    {
                        description: 'Outbound Skip API key used by the Skip Client app (x-api-key header to the Skip API).',
                    },
                    contextUser,
                );
                log('✓ Stored the Skip API key in the encrypted MJ credential store ("Skip API Key").');
            } catch (e) {
                LogError(
                    `[skip-client setup] Could not store the Skip API key credential: ` +
                    `${e instanceof Error ? e.message : String(e)}. The app will fall back to the ` +
                    `ASK_SKIP_API_KEY environment variable. (This usually means the "API Key" credential ` +
                    `type is not seeded on this instance — set ASK_SKIP_API_KEY in env instead.)`,
                );
            }
        }
    } else {
        log('No Skip API key provided; set ASK_SKIP_API_KEY in the MJAPI environment before first use.');
    }

    // Non-secret settings are read from the environment by the SDK (getSkipConfig). Report
    // them so the operator can persist them as MJAPI env vars.
    log('Skip Client configuration summary — set these as MJAPI environment variables, then restart MJAPI:');
    log(`  ASK_SKIP_URL=${baseURL ?? '(unset)'}`);
    log(`  ASK_SKIP_CHAT_URL=${chatURL ?? '(unset)'}`);
    log('  (Organization is identified automatically via your Skip API key.)');

    // Offer to create skip.config.cjs with entity-filtering defaults
    await maybeCreateSkipConfigFile(payload.RepoRoot, interactive, cb, log);

    // Create the "Skip" AI Agent + component registry records (the agent record is what
    // `@skip` resolves to). Done via the entity framework so the wide AIAgent table's
    // defaults are applied correctly. Idempotent and non-fatal.
    try {
        await ensureSkipRecords(payload.Provider as IMetadataProvider, contextUser, log);
    } catch (e) {
        LogError(`[skip-client setup] Could not create Skip metadata records: ${e instanceof Error ? e.message : String(e)}`);
    }

    log('Skip Client app setup complete. Restart MJAPI to activate the Skip proxy agent.');
}

/**
 * Generates the default skip.config.cjs file content from the baked-in defaults.
 */
function buildSkipConfigContent(): string {
    const indent = '            ';
    const entityList = DEFAULT_ENTITIES_TO_SEND.includeEntitiesFromExcludedSchemas
        .map(e => `${indent}'${e}',`)
        .join('\n');
    const schemaList = DEFAULT_ENTITIES_TO_SEND.excludeSchemas
        .map(s => `'${s}'`)
        .join(', ');

    return `/**
 * Skip Client configuration.
 *
 * Controls which MJ entity metadata is sent to the Skip Brain API.
 * Edit the lists below to include/exclude entities from the Skip payload.
 * See CONFIGURATION.md for full documentation.
 */
module.exports = {
    entitiesToSend: {
        // Schemas whose entities are excluded from the Skip metadata payload.
        excludeSchemas: [${schemaList}],
        // Specific entity names to include even when their schema is excluded above.
        includeEntitiesFromExcludedSchemas: [
${entityList}
        ],
    },
};
`;
}

/**
 * Prompts the operator to create a skip.config.cjs file if one does not already exist.
 * In headless mode, skips without prompting.
 */
async function maybeCreateSkipConfigFile(
    repoRoot: string,
    interactive: boolean,
    cb: SkipHookPayload['Callbacks'],
    log: (m: string) => void,
): Promise<void> {
    const configPath = resolve(repoRoot, 'skip.config.cjs');
    if (existsSync(configPath)) {
        log(`skip.config.cjs already exists at ${configPath} — skipping.`);
        return;
    }

    const shouldCreate = interactive && cb?.OnPromptConfirm
        ? await cb.OnPromptConfirm('Create a skip.config.cjs file with default entity-filtering settings?', { default: true })
        : false; // headless: don't create, defaults in code are fine

    if (!shouldCreate) {
        log('Skipped skip.config.cjs creation (built-in defaults will be used). You can create one later — see CONFIGURATION.md.');
        return;
    }

    try {
        writeFileSync(configPath, buildSkipConfigContent(), 'utf-8');
        log(`✓ Created ${configPath} with default entity-filtering settings. Edit it to customize which entities Skip can see.`);
    } catch (e) {
        LogError(`[skip-client setup] Could not write skip.config.cjs: ${e instanceof Error ? e.message : String(e)}`);
    }
}
