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
import type { MJCredentialEntity } from '@memberjunction/core-entities';
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

export default async function setup(payload: SkipHookPayload): Promise<void> {
    const cb = payload.Callbacks;
    const contextUser = payload.ContextUser as UserInfo;
    const log = (m: string) => (cb?.OnLog ? cb.OnLog(m) : LogStatus(m));
    const env = getSkipConfig();
    const interactive = !!cb?.OnPromptInput;

    log('Configuring the Skip Client app...');

    // Look up any credential a previous install stored, so re-runs rotate it instead of
    // colliding with the UNIQUE (CredentialTypeID, Name) constraint, and so a blank entry
    // means "keep what I have" rather than "no key".
    const existingCredential = await findSkipApiKeyCredential(contextUser);

    // The only interactive prompt is the API key — everything else uses defaults or env vars.
    // The Skip base URL defaults to production (baked into @askskip/core); override via ASK_SKIP_URL.
    // The current key is a secret: never pass it as a visible prompt default.
    const promptMessage = existingCredential
        ? 'Skip API key (ASK_SKIP_API_KEY) — leave blank to keep the existing stored key'
        : 'Skip API key (ASK_SKIP_API_KEY)';
    const apiKey = interactive
        ? cb!.OnPromptPassword
            ? await cb!.OnPromptPassword(promptMessage)
            : await cb!.OnPromptInput!(promptMessage)
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
            await storeOrUpdateSkipApiKey(apiKey, existingCredential, contextUser, log);
        }
    } else if (existingCredential) {
        log('✓ Kept the existing "Skip API Key" credential (no new key entered).');
    } else {
        log('No Skip API key provided; set ASK_SKIP_API_KEY in the MJAPI environment before first use.');
    }

    // Offer to create skip.config.cjs with entity-filtering defaults
    await maybeCreateSkipConfigFile(payload.RepoRoot, interactive, cb, log);

    // Create the "Skip" AI Agent + component registry records (the agent record is what
    // `@skip` resolves to). Done via the entity framework so the wide AIAgent table's
    // defaults are applied correctly. Idempotent and non-fatal.
    try {
        await ensureSkipRecords(payload.Provider as IMetadataProvider, contextUser, log);
    } catch (e) {
        LogError(`[skip-client setup] Could not create Skip metadata records: ${errorText(e)}`);
    }

    log('Skip Client app setup complete. Restart MJAPI to activate the Skip proxy agent.');
}

const API_KEY_CREDENTIAL_TYPE = 'API Key';
const SKIP_API_KEY_CREDENTIAL_NAME = 'Skip API Key';

/** Extracts a meaningful message from an unknown caught error. */
function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Returns the stored "Skip API Key" credential if one exists. Best-effort: any engine
 * failure (e.g. credentials entities not available yet) reads as "no credential".
 */
async function findSkipApiKeyCredential(contextUser: UserInfo): Promise<MJCredentialEntity | undefined> {
    try {
        await CredentialEngine.Instance.Config(false, contextUser);
        return CredentialEngine.Instance.getCredentialByName(API_KEY_CREDENTIAL_TYPE, SKIP_API_KEY_CREDENTIAL_NAME);
    } catch {
        return undefined;
    }
}

/**
 * Persists the Skip API key: rotates the existing credential when one is present
 * (storeCredential always INSERTs and would violate the UNIQUE (CredentialTypeID, Name)
 * constraint on a re-run), otherwise stores a fresh one. Never throws — setup must
 * survive a partial install.
 */
async function storeOrUpdateSkipApiKey(
    apiKey: string,
    existingCredential: MJCredentialEntity | undefined,
    contextUser: UserInfo,
    log: (m: string) => void,
): Promise<void> {
    try {
        await CredentialEngine.Instance.Config(false, contextUser);
        if (existingCredential) {
            await CredentialEngine.Instance.updateCredential(existingCredential.ID, { apiKey }, contextUser);
            log('✓ Updated the Skip API key in the encrypted MJ credential store ("Skip API Key").');
        } else {
            await CredentialEngine.Instance.storeCredential(
                API_KEY_CREDENTIAL_TYPE,
                SKIP_API_KEY_CREDENTIAL_NAME,
                { apiKey },
                {
                    description: 'Outbound Skip API key used by the Skip Client app (x-api-key header to the Skip API).',
                },
                contextUser,
            );
            log('✓ Stored the Skip API key in the encrypted MJ credential store ("Skip API Key").');
        }
    } catch (e: unknown) {
        LogError(
            `[skip-client setup] Could not persist the Skip API key credential: ${errorText(e)}. ` +
            `The key you entered was NOT saved — the app will fall back to the ASK_SKIP_API_KEY ` +
            `environment variable, so set it there or fix the underlying issue and re-run setup.`,
        );
    }
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
        LogError(`[skip-client setup] Could not write skip.config.cjs: ${errorText(e)}`);
    }
}
