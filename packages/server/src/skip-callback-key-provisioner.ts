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
 * FullPaths must match entries in MJ/metadata/api-scopes/.api-scopes.json, with
 * the single exception of `query:profile` — that scope describes this app's own
 * `TestAndProfileQuerySQL` resolver rather than an MJ resolver, so this app seeds
 * it (V202608172304__skip_client_query_profile_scope.sql) and removes it on
 * teardown.
 */
interface RequiredScope {
    path: string;
    resourcePattern?: string;
}

/**
 * The scopes this app seeds itself rather than inheriting from MJ core.
 *
 * Their absence means this app's migrations have not been applied — a different
 * problem with a different fix than a missing MJ-core scope, and one that must
 * degrade rather than abort. Kept here beside {@link REQUIRED_SCOPES} so the two
 * lists cannot drift; `skip-middleware.ts` imports it for its startup diagnostic.
 */
export const APP_OWNED_SCOPE_PATHS: readonly string[] = ['query:profile'];

const REQUIRED_SCOPES: RequiredScope[] = [
    { path: 'view:run' },
    { path: 'view:batch' },
    { path: 'query:run' },
    { path: 'query:create' },
    { path: 'query:update' },
    { path: 'query:delete' },
    { path: 'query:test' },
    // Seeded by this app, not by MJ core — it guards this app's own
    // TestAndProfileQuerySQL resolver. Revoking it disables query profiling
    // without affecting query:test, which is the point of it being separate.
    { path: 'query:profile' },
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
 * Whether Skip is known to hold the current key.
 *
 * True when we found a pre-existing key row (Skip received it in an earlier
 * lifetime), and set for a newly created key only once a request carrying it
 * actually reached Skip — see {@link confirmCallbackKeyDelivered}.
 *
 * While this is false the key row exists locally but Skip may have never seen
 * it. That gap is unrecoverable across a restart, because the raw value is
 * hashed on write: the row would make the next lifetime believe Skip already
 * holds a key it never received. {@link discardUnconfirmedCallbackKey} closes
 * the gap by deleting the row when delivery fails.
 */
let deliveryConfirmed = false;

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
    await deleteExistingCallbackKey('re-provisioning');

    // Reset in-memory state so provisionInner() runs fresh
    provisioningComplete = false;
    createdRawKey = null;
    deliveryConfirmed = false;
}

/**
 * Records that a request carrying the newly created raw key reached Skip, so the
 * key row is safe to keep across restarts.
 *
 * "Reached Skip" means Skip parsed the request body — a Skip-side workflow error
 * still counts, because `resolveCallbackCredential` runs before any workflow does.
 * What does not count is a failure at or before the edge (a 401 on the Skip API
 * key, a network error, an empty response), where the body was never read.
 *
 * No-op when there is nothing pending: either no key was created this lifetime,
 * or delivery was already confirmed.
 */
export function confirmCallbackKeyDelivered(): void {
    if (createdRawKey && !deliveryConfirmed) {
        deliveryConfirmed = true;
        LogStatus('[SkipCallbackKeyProvisioner] Skip acknowledged the new callback key — key retained');
    }
}

/**
 * Deletes a just-created key whose delivery to Skip was never confirmed, and
 * resets provisioning state so the next request provisions and sends a fresh one.
 *
 * Without this, a key created for a request that failed before Skip read the body
 * leaves a row that outlives the raw value. After a restart the client finds that
 * row, concludes "Skip already has it", sends nothing, and every subsequent
 * request fails with Skip reporting no callback key — unrecoverable without
 * deleting the row by hand.
 *
 * Deliberately narrow: does nothing when the key was created in an earlier
 * lifetime or delivery was already confirmed, so ordinary Skip errors never
 * destroy a working key.
 *
 * @returns true if an unconfirmed key was discarded.
 */
export async function discardUnconfirmedCallbackKey(): Promise<boolean> {
    if (!createdRawKey || deliveryConfirmed) {
        return false;
    }

    LogError('[SkipCallbackKeyProvisioner] Request carrying the new callback key did not reach Skip — ' +
        'discarding the unconfirmed key so the next request provisions a fresh one');
    await deleteExistingCallbackKey('unconfirmed delivery');

    provisioningComplete = false;
    createdRawKey = null;
    deliveryConfirmed = false;
    return true;
}

/**
 * Deletes the callback key row for this Skip host, if one exists. Child rows
 * (scopes, usage logs) are cleaned up by cascading FKs, so no orphaned data is
 * left behind. Never throws — callers reset in-memory state regardless, and a
 * stale row is recoverable on the next pass while a thrown error is not.
 *
 * @param reason - Included in log output to distinguish rotation from discard.
 */
async function deleteExistingCallbackKey(reason: string): Promise<void> {
    try {
        const systemUser = UserCache.Instance.GetSystemUser();
        if (!systemUser) {
            return;
        }

        const serviceAccount = UserCache.Instance.Users.find(
            u => u.Email.toLowerCase() === SKIP_SERVICE_EMAIL
        );
        if (!serviceAccount) {
            return;
        }

        const existingKey = await findExistingKey(serviceAccount.ID, buildKeyLabel(), systemUser);
        if (!existingKey) {
            return;
        }

        const md = new Metadata();
        const keyEntity = await md.GetEntityObject<MJAPIKeyEntity>('MJ: API Keys', systemUser);
        const loaded = await keyEntity.Load(existingKey.ID);
        if (loaded && await keyEntity.Delete()) {
            LogStatus(`[SkipCallbackKeyProvisioner] Deleted callback key (ID: ${existingKey.ID}) — ${reason}`);
        } else {
            LogError(`[SkipCallbackKeyProvisioner] Failed to delete callback key (ID: ${existingKey.ID}) — ${reason}`);
        }
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        LogError(`[SkipCallbackKeyProvisioner] Error deleting callback key (${reason}): ${msg}`);
    }
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
            deliveryConfirmed = true; // Row predates this lifetime, so Skip received it
            return null;
        }

        // No existing key — create one and return the raw value for SkipSDK to send once.
        // Delivery is unconfirmed until a request carrying it reaches Skip; the caller
        // must resolve that via confirmCallbackKeyDelivered()/discardUnconfirmedCallbackKey().
        const rawKey = await createKeyWithScopes(serviceAccount, label, systemUser);
        if (rawKey) {
            provisioningComplete = true;
            createdRawKey = rawKey;
            deliveryConfirmed = false;
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

    // A missing MJ-core scope still aborts: those are the scopes Skip cannot
    // operate without, and half-provisioning a key would fail later in a much
    // more confusing place.
    //
    // A missing app-owned scope must NOT abort. `query:profile` is seeded by this
    // app's own migration, so unlike the MJ-core scopes it can legitimately be
    // absent — a migration that has not run yet, or an instance where an operator
    // deleted it to disable profiling. Aborting would leave the callback key with
    // NO scopes at all, taking down every Skip operation to punish the absence of
    // an optional one.
    const missingCore = missing.filter(s => !APP_OWNED_SCOPE_PATHS.includes(s.path));
    if (missingCore.length > 0) {
        LogError(`[SkipCallbackKeyProvisioner] Missing MJ core scopes in engine cache: ${missingCore.map(s => s.path).join(', ')}. ` +
            'Run MJ metadata sync to deploy API scope definitions.');
        return false;
    }

    const missingAppOwned = missing.filter(s => APP_OWNED_SCOPE_PATHS.includes(s.path));
    if (missingAppOwned.length > 0) {
        LogStatus(`[SkipCallbackKeyProvisioner] Skipping Skip Client scopes absent from this instance: ${missingAppOwned.map(s => s.path).join(', ')}. ` +
            'Run the app install/upgrade to apply the migrations that seed them; the key is provisioned without them.');
    }

    let allSaved = true;
    for (const scope of REQUIRED_SCOPES) {
        const scopeID = scopeMap.get(scope.path);
        if (!scopeID) continue; // app-owned and absent — reported above

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
