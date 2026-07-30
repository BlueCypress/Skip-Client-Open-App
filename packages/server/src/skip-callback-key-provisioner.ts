/**
 * Skip Callback Key Provisioner
 *
 * Auto-provisions a scoped API key for Skip callbacks on the client MJAPI.
 * On first request to a Skip host, creates a key and returns the raw value
 * so SkipSDK can send it once. Skip persists it in its credential store.
 *
 * On subsequent requests (including after MJ restart), the key record exists
 * in the DB but the raw value is irrecoverable (hashed). Returns null to
 * signal "key exists, don't send it — Skip already has it."
 *
 * Thread safety: uses a promise-based mutex so concurrent first requests
 * don't create duplicate keys.
 *
 * @see MJ/plans/skip-callback-scoped-api-keys.md Section 3.2
 */

import { CompositeKey, LogError, LogStatus, Metadata, RunView, UserInfo } from '@memberjunction/core';
import { APIKeysEngineBase, GetAPIKeyEngine } from '@memberjunction/api-keys';
import { MJAPIKeyEntity } from '@memberjunction/core-entities';
import { UserCache } from '@memberjunction/sqlserver-dataprovider';
import { getSkipConfig } from '@askskip/core';

/** The email used for the Skip service account (deployed via MJ metadata). */
const SKIP_SERVICE_EMAIL = 'skip-service@skip.internal';

/**
 * Scope requirements for the Skip callback API key.
 * Each entry specifies a scope FullPath and an optional ResourcePattern.
 * When resourcePattern is omitted, defaults to '*' (all resources).
 * Narrowly scoped entries (e.g. entity:delete with 'MJ: Quer*') limit
 * the key to only the entities Skip needs, following least-privilege.
 *
 * FullPaths must match entries in MJ/metadata/api-scopes/.api-scopes.json.
 */
interface RequiredScope {
    path: string;
    resourcePattern?: string;
}

const REQUIRED_SCOPES: RequiredScope[] = [
    { path: 'view:run' },
    { path: 'view:batch' },
    { path: 'query:run' },
    { path: 'query:create' },
    { path: 'query:update' },
    { path: 'query:delete' },
    { path: 'query:test' },
    { path: 'search:execute' },
    { path: 'prompt:execute' },
    { path: 'agent:execute' },
    { path: 'embedding:generate' },
    // Narrowly scoped entity CRUD — only for query-family entities that
    // the CreateClientQuery/UpdateClientQuery/DeleteClientQuery actions need.
    { path: 'entity:read',   resourcePattern: 'MJ: Quer*' },
    { path: 'entity:create', resourcePattern: 'MJ: Quer*' },
    { path: 'entity:update', resourcePattern: 'MJ: Quer*' },
    { path: 'entity:delete', resourcePattern: 'MJ: Quer*' },
];

/** Promise-based mutex: if provisioning is in-flight, subsequent callers await it. */
let provisioningPromise: Promise<string | null> | null = null;

/**
 * Whether provisioning completed successfully this server lifetime (key exists
 * or was just created). Exported so SkipSDK can distinguish "key exists, Skip
 * has it" (don't send anything) from "provisioning failed" (fall back to legacy).
 */
export let provisioningComplete = false;

/** Raw key from creation — only non-null during the server lifetime that created the key. */
let createdRawKey: string | null = null;

/**
 * Builds the label for a Skip callback key scoped to a specific Skip host.
 * Example: "Skip Callback: https://skip.example.com"
 */
function buildKeyLabel(): string {
    return `Skip Callback: ${getSkipConfig().skipURL}`;
}

/**
 * Deletes the existing callback key and resets provisioning state so the next
 * call to `getSkipCallbackKey()` creates a fresh key and returns its raw value
 * for Skip to store.
 *
 * Called by SkipSDK when the Skip server reports the callback key is invalid
 * (`invalid_callback_key` error code). The old key is deleted via the entity
 * framework — all child rows (scopes, usage logs) are cleaned up by cascading
 * FKs in the database, so no orphaned data is left behind.
 */
export async function resetCallbackKeyProvisioning(): Promise<void> {
    try {
        const systemUser = UserCache.Instance.GetSystemUser();
        if (systemUser) {
            const label = buildKeyLabel();
            const serviceAccount = UserCache.Instance.Users.find(
                u => u.Email.toLowerCase() === SKIP_SERVICE_EMAIL
            );
            if (serviceAccount) {
                const existingKey = await findExistingKey(serviceAccount.ID, label, systemUser);
                if (existingKey) {
                    const md = new Metadata();
                    const keyEntity = await md.GetEntityObject<MJAPIKeyEntity>('MJ: API Keys', systemUser);
                    const loaded = await keyEntity.Load(existingKey.ID);
                    if (loaded && await keyEntity.Delete()) {
                        LogStatus(`[SkipCallbackKeyProvisioner] Deleted old callback key (ID: ${existingKey.ID}) for re-provisioning`);
                    } else {
                        LogError(`[SkipCallbackKeyProvisioner] Failed to delete old callback key (ID: ${existingKey.ID})`);
                    }
                }
            }
        }
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        LogError(`[SkipCallbackKeyProvisioner] Error deleting old key during reset: ${msg}`);
    }

    // Reset in-memory state so provisionInner() runs fresh
    provisioningComplete = false;
    createdRawKey = null;
}

/**
 * Returns the raw API key for Skip callbacks if one was just created,
 * or null if the key already exists (Skip already has it stored).
 *
 * - First call ever (no key in DB): creates key, returns raw key (send to Skip once)
 * - Subsequent calls (same server lifetime): returns null (key exists, Skip has it)
 * - After restart (key in DB, raw lost): returns null (key exists, Skip has it)
 *
 * Returns null on provisioning failure — caller should fall back to legacy MJ_API_KEY.
 */
export async function getSkipCallbackKey(): Promise<string | null> {
    // Fast path: we've already checked this lifetime
    if (provisioningComplete) {
        return createdRawKey;
    }

    // Mutex: if provisioning is in-flight, piggyback on that promise
    if (provisioningPromise) {
        return provisioningPromise;
    }

    provisioningPromise = provisionInner();
    try {
        return await provisioningPromise;
    } finally {
        provisioningPromise = null;
    }
}

/**
 * The actual provisioning logic. Runs at most once per server lifetime.
 */
async function provisionInner(): Promise<string | null> {
    try {
        const systemUser = UserCache.Instance.GetSystemUser();
        if (!systemUser) {
            LogError('[SkipCallbackKeyProvisioner] System user not found in UserCache');
            return null;
        }

        const serviceAccount = UserCache.Instance.Users.find(
            u => u.Email.toLowerCase() === SKIP_SERVICE_EMAIL
        );
        if (!serviceAccount) {
            LogError(`[SkipCallbackKeyProvisioner] Skip service account (${SKIP_SERVICE_EMAIL}) not found in UserCache. ` +
                'Run MJ metadata sync to deploy the Skip Service Account user.');
            return null;
        }

        const label = buildKeyLabel();

        // Check if a key already exists for this service account + Skip host.
        const existingKey = await findExistingKey(serviceAccount.ID, label, systemUser);
        if (existingKey) {
            // Key exists — Skip already received the raw key when it was first created.
            // We can't recover the raw value (it's hashed), but we don't need to.
            LogStatus(`[SkipCallbackKeyProvisioner] Found existing Skip callback key (ID: ${existingKey.ID})`);

            // Reconcile scopes: add any new entries from REQUIRED_SCOPE_PATHS that
            // the key doesn't have yet. This runs once per server lifetime so the
            // overhead is negligible.
            await reconcileScopes(existingKey.ID, systemUser);

            provisioningComplete = true;
            createdRawKey = null; // Signal: don't send key, Skip already has it
            return null;
        }

        // No existing key — create one and return the raw value for SkipSDK to send once
        const rawKey = await createKeyWithScopes(serviceAccount, label, systemUser);
        if (rawKey) {
            provisioningComplete = true;
            createdRawKey = rawKey;
            LogStatus('[SkipCallbackKeyProvisioner] Auto-provisioned new Skip callback key — will send to Skip on this request');
        }
        return rawKey;
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        LogError(`[SkipCallbackKeyProvisioner] Provisioning failed: ${msg}`);
        return null;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ExistingKeyRow {
    ID: string;
    Label: string;
    Status: string;
}

async function findExistingKey(serviceAccountUserID: string, label: string, contextUser: UserInfo): Promise<ExistingKeyRow | null> {
    const rv = new RunView();
    const result = await rv.RunView<ExistingKeyRow>({
        EntityName: 'MJ: API Keys',
        ExtraFilter: `UserID='${serviceAccountUserID}' AND Label='${label.replace(/'/g, "''")}' AND Status='Active'`,
    }, contextUser);

    if (result.Success && result.Results.length > 0) {
        return result.Results[0];
    }
    return null;
}

/**
 * Creates a new API key for the Skip service account and assigns all required scopes.
 */
async function createKeyWithScopes(serviceAccount: UserInfo, label: string, systemUser: UserInfo): Promise<string | null> {
    const engine = GetAPIKeyEngine();

    const createResult = await engine.CreateAPIKey({
        UserId: serviceAccount.ID,
        Label: label,
        Description: 'Auto-provisioned by SkipSDK for scoped Skip→client callbacks. ' +
            'Do not delete — Skip will re-provision on next request if missing.',
    }, systemUser);

    if (!createResult.Success || !createResult.RawKey || !createResult.APIKeyId) {
        LogError(`[SkipCallbackKeyProvisioner] Failed to create API key: ${createResult.Error}`);
        return null;
    }

    const scopesAssigned = await assignScopes(createResult.APIKeyId, systemUser, engine);
    if (!scopesAssigned) {
        LogError('[SkipCallbackKeyProvisioner] Key created but scope assignment failed. ' +
            `Key ID: ${createResult.APIKeyId}. Manual scope assignment may be needed.`);
    }

    return createResult.RawKey;
}

/**
 * Reconciles the scopes on an existing key against REQUIRED_SCOPES.
 * Adds missing scopes and removes scopes no longer in the required list.
 * Uses the APIKeysEngineBase cache — no RunView needed.
 * Runs once per server lifetime (called from provisionInner on key-found path).
 */
async function reconcileScopes(apiKeyID: string, contextUser: UserInfo): Promise<void> {
    const base = APIKeysEngineBase.Instance;
    const scopeMap = new Map(base.Scopes.map(s => [s.FullPath, s.ID]));

    // Build the set of required "scopeID|pattern" keys
    const requiredKeys = new Map<string, RequiredScope>();
    for (const scope of REQUIRED_SCOPES) {
        const scopeID = scopeMap.get(scope.path);
        if (!scopeID) continue;
        requiredKeys.set(`${scopeID}|${scope.resourcePattern ?? '*'}`, scope);
    }

    // Read existing key scopes from cache (no DB round-trip)
    const existingScopes = base.GetKeyScopesByKeyId(apiKeyID);
    const existingKeys = new Map(
        existingScopes.map(ks => [`${ks.ScopeID}|${ks.ResourcePattern ?? '*'}`, ks])
    );

    const md = new Metadata();
    let added = 0;
    let removed = 0;

    // Add missing scopes
    for (const [key, scope] of requiredKeys) {
        if (existingKeys.has(key)) continue;

        const scopeID = scopeMap.get(scope.path)!;
        const pattern = scope.resourcePattern ?? '*';
        const entity = await md.GetEntityObject('MJ: API Key Scopes', contextUser);
        entity.NewRecord();
        entity.Set('APIKeyID', apiKeyID);
        entity.Set('ScopeID', scopeID);
        entity.Set('ResourcePattern', pattern);
        entity.Set('PatternType', 'Include');
        entity.Set('IsDeny', false);
        entity.Set('Priority', 0);

        if (await entity.Save()) {
            added++;
        } else {
            LogError(`[SkipCallbackKeyProvisioner] Failed to add scope ${scope.path} (${pattern}) on key ${apiKeyID}`);
        }
    }

    // Remove scopes that are no longer required
    for (const [key, existingScope] of existingKeys) {
        if (requiredKeys.has(key)) continue;

        const entity = await md.GetEntityObject('MJ: API Key Scopes', contextUser);
        const compositeKey = new CompositeKey([{ FieldName: 'ID', Value: existingScope.ID }]);
        if (await entity.InnerLoad(compositeKey)) {
            if (await entity.Delete()) {
                removed++;
            } else {
                LogError(`[SkipCallbackKeyProvisioner] Failed to remove stale scope ${key} from key ${apiKeyID}`);
            }
        }
    }

    if (added > 0 || removed > 0) {
        LogStatus(`[SkipCallbackKeyProvisioner] Reconciled scopes on callback key: ${added} added, ${removed} removed`);
        // Refresh the engine cache so the scope evaluator sees the changes immediately
        await base.Config(true, contextUser);
    }
}

/**
 * Resolves scope IDs from the APIKeyEngine's in-memory cache (no DB round-trip)
 * and creates APIKeyScope records for each.
 */
async function assignScopes(apiKeyID: string, contextUser: UserInfo, engine: ReturnType<typeof GetAPIKeyEngine>): Promise<boolean> {
    const md = new Metadata();

    const cachedScopes = engine.Scopes;
    const scopeMap = new Map(cachedScopes.map(s => [s.FullPath, s.ID]));

    const missing = REQUIRED_SCOPES.filter(s => !scopeMap.has(s.path));
    if (missing.length > 0) {
        LogError(`[SkipCallbackKeyProvisioner] Missing scopes in engine cache: ${missing.map(s => s.path).join(', ')}. ` +
            'Run MJ metadata sync to deploy API scope definitions.');
        return false;
    }

    let allSaved = true;
    for (const scope of REQUIRED_SCOPES) {
        const scopeID = scopeMap.get(scope.path)!;
        const keyScopeEntity = await md.GetEntityObject('MJ: API Key Scopes', contextUser);
        keyScopeEntity.NewRecord();
        keyScopeEntity.Set('APIKeyID', apiKeyID);
        keyScopeEntity.Set('ScopeID', scopeID);
        keyScopeEntity.Set('ResourcePattern', scope.resourcePattern ?? '*');
        keyScopeEntity.Set('PatternType', 'Include');
        keyScopeEntity.Set('IsDeny', false);
        keyScopeEntity.Set('Priority', 0);

        const saved = await keyScopeEntity.Save();
        if (!saved) {
            LogError(`[SkipCallbackKeyProvisioner] Failed to assign scope ${scope.path} to key ${apiKeyID}`);
            allSaved = false;
        }
    }

    if (allSaved) {
        LogStatus(`[SkipCallbackKeyProvisioner] Assigned ${REQUIRED_SCOPES.length} scopes to callback key`);
    }

    return allSaved;
}
