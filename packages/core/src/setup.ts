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
import { getSkipConfig } from './skip-config.js';
import { ensureSkipRecords } from './skip-records.js';

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

    // Gather configuration — prompt interactively (pre-filled from env), else use env values.
    const chatURL = interactive
        ? await cb!.OnPromptInput!('Skip API chat URL (ASK_SKIP_CHAT_URL)', { default: env.chatURL })
        : env.chatURL;
    const orgID = interactive
        ? await cb!.OnPromptInput!('Skip organization ID (ASK_SKIP_ORGANIZATION_ID)', { default: env.orgID })
        : env.orgID;
    const orgInfo = interactive
        ? await cb!.OnPromptInput!('Skip organization info (optional)', { default: env.organizationInfo ?? '' })
        : env.organizationInfo;
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
    log(`  ASK_SKIP_CHAT_URL=${chatURL ?? '(unset)'}`);
    log(`  ASK_SKIP_ORGANIZATION_ID=${orgID ?? '(unset)'}`);
    if (orgInfo) {
        log(`  ASK_SKIP_ORGANIZATION_INFO=${orgInfo}`);
    }

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
