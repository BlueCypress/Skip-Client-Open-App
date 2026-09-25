/**
 * Skip metadata records that previously lived in MJ core metadata and now ship with
 * this app: the "Skip" AI Agent (DriverClass=SkipProxyAgent — this is what `@skip`
 * resolves to) and the "Skip" component registry (the Skip Brain API's /registry endpoint, for rendering
 * Skip's component artifacts).
 *
 * They are created via the entity framework in the in-process install hook rather than
 * raw SQL: `NewRecord()` applies the (wide) AIAgent table's many column defaults and
 * `Save()` fills the owner/audit fields, which a hand-written INSERT could not safely do.
 * Removed by the uninstall hook (best-effort — leaving them if history rows reference them).
 *
 * Effect: the "Skip" agent exists — and `@skip` works — ONLY on instances that install
 * this app, instead of every vanilla MJ instance advertising a Skip agent it cannot run.
 */
import { createHash } from 'crypto';
import { LogError, RunView } from '@memberjunction/core';
import type { IMetadataProvider, UserInfo, BaseEntity } from '@memberjunction/core';
import { MJAIAgentEntity, MJComponentRegistryEntity } from '@memberjunction/core-entities';
import { CredentialEngine } from '@memberjunction/credentials';
import {
    DEFAULT_SKIP_REGISTRY_NAME,
    getConfiguredSkipRegistryURI,
    getRegistryAPIKeyEnvVar,
    getRegistryURIOverrideEnvVar,
    getSkipRegistryURI,
    resolveSkipApiKey,
    resolveSkipRegistryURI,
} from './skip-config.js';

/** Credential type used for the per-registry API keys stored below. */
const API_KEY_CREDENTIAL_TYPE = 'API Key';
import type { ResolvedSkipRegistryURI } from './skip-config.js';

/**
 * Stable IDs for the Skip agent and component registry records. These are the same IDs
 * that MJ core originally seeded, and they MUST be reused so that existing conversation
 * details, agent runs, and other FK references continue to resolve correctly after the
 * migration from core-seeded records to the Open App.
 *
 * MJ core ships `deleteRecord` tombstones for these IDs, but on instances where the Open
 * App is installed the DELETE is a no-op (FK references from agent run history block it).
 */
const SKIP_AGENT_ID = 'A829FAAC-9E64-440C-B650-83F92A37E990';
const SKIP_REGISTRY_ID = 'B2F8C247-D22E-4991-9A69-0F73954A68D6';

/**
 * Namespace for deriving IDs of non-production registry records (`Skip-Stage`,
 * `Skip-Local`, …). Arbitrary but fixed — changing it renames every derived registry.
 */
const SKIP_REGISTRY_ID_NAMESPACE = '9F1C8E2A-47B6-4D53-9C10-6E8A2B4D7F31';

/**
 * The stable record ID for a given registry name.
 *
 * Deterministic so that the create path is idempotent across reboots and environments: a
 * registry cannot be duplicated by running setup twice, and a promotion has a known target
 * ID to repoint `__mj.Component.SourceRegistryID` at.
 *
 * Production resolves to the legacy pinned GUID — the same one MJ core originally seeded
 * and still carries in its `deleteRecord` tombstone — so existing installs are untouched.
 * Everything else is a UUIDv5 over the namespace above.
 */
export function deriveSkipRegistryID(registryName: string): string {
    if (registryName.trim().toLowerCase() === 'skip') {
        return SKIP_REGISTRY_ID;
    }
    return uuidV5(registryName.trim().toLowerCase(), SKIP_REGISTRY_ID_NAMESPACE);
}

/** RFC 4122 §4.3 name-based UUID (SHA-1), uppercased to match MJ's stored casing. */
function uuidV5(name: string, namespaceUUID: string): string {
    const namespaceBytes = Buffer.from(namespaceUUID.replace(/-/g, ''), 'hex');
    const hash = createHash('sha1').update(Buffer.concat([namespaceBytes, Buffer.from(name, 'utf8')])).digest();

    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

    const hex = bytes.toString('hex').toUpperCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Idempotently create the Skip AI Agent + component registry records.
 *
 * @param registryName Registry name this instance's brain publishes under, as reported by
 *                     the brain itself (`fetchSkipRegistryName`). Defaults to production.
 *                     Never derive this on the client — see that function's docs.
 */
export async function ensureSkipRecords(
    provider: IMetadataProvider,
    contextUser: UserInfo,
    log: (m: string) => void,
    registryName?: string,
): Promise<void> {
    await ensureSkipAgent(provider, contextUser, log);

    // Undefined means the brain did not tell us which registry it publishes under. Managing
    // registry records on a guess is how the production record gets pointed at a developer's
    // laptop, so this does nothing at all — the Skip agent record above is unaffected.
    if (!registryName) {
        log('Registry name unknown this boot — leaving Component Registry records untouched.');
        return;
    }

    await ensureSkipComponentRegistry(provider, contextUser, log, registryName);
    await healProductionRegistryIfUnused(contextUser, log, registryName);
    await ensureRegistryAPIKeyCredential(contextUser, log, registryName);
    await reportOrphanedSkipRegistries(contextUser, log, registryName);
}

/**
 * Stores this registry's API key in the encrypted credential store, so component fetches
 * authenticate regardless of what happened at boot.
 *
 * MJ resolves a registry's key as `REGISTRY_API_KEY_<ID>` → `REGISTRY_API_KEY_<NAME>` →
 * mj.config.cjs → the credential named `Component Registry: <Name>`. The first two are
 * process environment, set only when this client successfully reached the brain at
 * startup. That makes rendering depend on boot order: a client started before the Skip API
 * derives no key, and since every registry route requires authentication, every component
 * fetch 401s for the rest of the process — even after the brain comes up.
 *
 * The credential is read at fetch time and survives restarts, which removes that
 * dependency entirely.
 *
 * Reconciles rather than creates-once: a developer who fixes a wrong `ASK_SKIP_API_KEY`
 * would otherwise be shadowed by the stale value forever on any boot where env derivation
 * does not run. Environment still outranks this at resolution time, so an explicit
 * override is never fought.
 */
async function ensureRegistryAPIKeyCredential(
    contextUser: UserInfo,
    log: (m: string) => void,
    registryName: string,
): Promise<void> {
    const apiKey = await resolveSkipApiKey(contextUser);
    if (!apiKey) {
        return; // Nothing to store; the missing-key path reports itself elsewhere.
    }

    const credentialName = `Component Registry: ${registryName}`;
    try {
        await CredentialEngine.Instance.Config(false, contextUser);
        const existing = CredentialEngine.Instance.getCredentialByName(API_KEY_CREDENTIAL_TYPE, credentialName);

        if (!existing) {
            await CredentialEngine.Instance.storeCredential(
                API_KEY_CREDENTIAL_TYPE,
                credentialName,
                { apiKey },
                {
                    description:
                        `API key MemberJunction uses to fetch Skip components from the "${registryName}" ` +
                        `component registry. Read at fetch time, so component rendering does not depend on ` +
                        `the Skip API being reachable when this server started.`,
                },
                contextUser,
            );
            log(`✓ Stored the "${credentialName}" credential so component fetches authenticate after any restart.`);
            return;
        }

        const current = await CredentialEngine.Instance.getCredential<{ apiKey: string }>(credentialName, {
            contextUser,
            subsystem: 'SkipClient',
        });
        if (current?.values?.apiKey !== apiKey) {
            await CredentialEngine.Instance.updateCredential(existing.ID, { apiKey }, contextUser);
            log(`✓ Updated the "${credentialName}" credential to match the current Skip API key.`);
        }
    } catch (e) {
        // Never fatal: the env-derived variables still cover the common case, and a
        // credential-store outage must not stop the server from booting.
        LogError(
            `[skip-client] Could not store the "${credentialName}" credential: ` +
            `${e instanceof Error ? e.message : String(e)}. Component fetches will rely on ` +
            `${getRegistryAPIKeyEnvVar(registryName)} instead, which is only set when the brain ` +
            `is reachable at startup.`,
        );
    }
}

/**
 * Reports Skip registry records this instance is no longer using.
 *
 * A mistyped or since-corrected registry name leaves a record behind. These are reported
 * and never deleted: components generated while the wrong name was configured are stamped
 * with it permanently, and they keep resolving only for as long as the record exists.
 * Deleting it silently breaks them, which is strictly worse than some clutter.
 */
async function reportOrphanedSkipRegistries(
    contextUser: UserInfo,
    log: (m: string) => void,
    registryName: string,
): Promise<void> {
    const rv = new RunView();
    const found = await rv.RunView<MJComponentRegistryEntity>(
        {
            EntityName: 'MJ: Component Registries',
            ExtraFilter: `Name LIKE 'Skip-%' AND Name <> '${registryName.replace(/'/g, "''")}'`,
            ResultType: 'entity_object',
        },
        contextUser,
    );

    const orphans = found.Success ? (found.Results ?? []) : [];
    if (!orphans.length) {
        return;
    }

    const detail = orphans.map((r) => `"${r.Name}" (${r.URI ?? 'no URI'})`).join(', ');
    log(
        `  ℹ ${orphans.length} other Skip component registr${orphans.length === 1 ? 'y' : 'ies'} present: ${detail}. ` +
        `Left in place — components generated under those names still resolve through them, and deleting a ` +
        `record breaks every component stamped with it. Remove only once nothing references them.`,
    );
}

/**
 * Restores the production "Skip" registry's URI when this instance demonstrably uses a
 * different one.
 *
 * Once each environment publishes under its own name, the name `Skip` means production and
 * nothing else — so its record should carry the production URI, full stop. Instances
 * upgraded from the single-registry era will not: their `Skip` row was rewritten on every
 * boot to follow `ASK_SKIP_URL`, so any client ever pointed at stage or a laptop still has
 * that host stored. Left alone it never self-corrects, because lookup is now name-scoped
 * and nothing revisits `Skip`.
 *
 * Running this on every boot is the one-time repair for every such client, without a
 * migration: the first boot after upgrading fixes the row, and every later boot is a no-op.
 *
 * Two cases are deliberately left alone:
 *
 * - **An explicit `REGISTRY_URI_OVERRIDE_SKIP`.** That is an operator pointing production's
 *   registry somewhere on purpose (a mirror, a proxy), and MJ honors it at runtime anyway.
 * - **This instance actually using `Skip`.** Then `ensureSkipComponentRegistry` owns the
 *   row and its resolution order — including following `ASK_SKIP_URL` for a developer who
 *   has not adopted per-environment names — applies unchanged.
 */
async function healProductionRegistryIfUnused(
    contextUser: UserInfo,
    log: (m: string) => void,
    registryName: string,
): Promise<void> {
    if (registryName === DEFAULT_SKIP_REGISTRY_NAME) {
        return;
    }
    if (process.env[getRegistryURIOverrideEnvVar(DEFAULT_SKIP_REGISTRY_NAME)]?.trim()) {
        return;
    }

    const productionURI = getSkipRegistryURI();
    const rv = new RunView();
    const found = await rv.RunView<MJComponentRegistryEntity>(
        {
            EntityName: 'MJ: Component Registries',
            ExtraFilter: `ID='${SKIP_REGISTRY_ID}' OR Name='${DEFAULT_SKIP_REGISTRY_NAME}'`,
            ResultType: 'entity_object',
        },
        contextUser,
    );

    const records = found.Success ? (found.Results ?? []) : [];
    if (records.length !== 1) {
        // Zero is normal on an instance that has only ever used a named registry. More than
        // one is the duplicate-name hazard reported elsewhere, and is not repaired blindly.
        return;
    }

    const record = records[0];
    if (record.URI === productionURI) {
        return;
    }

    const previous = record.URI;
    record.URI = productionURI;
    if (await record.Save()) {
        log(
            `✓ Restored the production "Skip" component registry URI to ${productionURI} ` +
            `(was ${previous}; this instance publishes under "${registryName}").`,
        );
    } else {
        LogError(
            `[skip-client] Could not restore the production "Skip" component registry URI from ${previous} ` +
            `to ${productionURI}: ${record.LatestResult?.Message ?? 'unknown error'}`,
        );
    }
}

/**
 * Remove the Skip AI Agent + component registry records (best-effort).
 *
 * The registry filter covers the whole per-environment family rather than just the
 * production name, so uninstalling from an instance that was pointed at stage or a local
 * brain does not strand its registry record.
 */
export async function removeSkipRecords(contextUser: UserInfo, log: (m: string) => void): Promise<void> {
    await deleteMatching('MJ: AI Agents', `(Name='Skip' AND DriverClass='SkipProxyAgent') OR ID='${SKIP_AGENT_ID}'`, contextUser, log);
    await deleteMatching(
        'MJ: Component Registries',
        `ID='${SKIP_REGISTRY_ID}' OR ((Name='Skip' OR Name LIKE 'Skip-%') AND (URI LIKE '%askskip%' OR URI LIKE '%/registry'))`,
        contextUser,
        log,
    );
}

async function lookupId(entityName: string, name: string, contextUser: UserInfo): Promise<string | undefined> {
    const rv = new RunView();
    const res = await rv.RunView(
        { EntityName: entityName, ExtraFilter: `Name='${name.replace(/'/g, "''")}'`, MaxRows: 1 },
        contextUser,
    );
    return res.Success && res.Results?.length ? (res.Results[0] as { ID: string }).ID : undefined;
}

async function ensureSkipAgent(provider: IMetadataProvider, contextUser: UserInfo, log: (m: string) => void): Promise<void> {
    const rv = new RunView();
    const existing = await rv.RunView<MJAIAgentEntity>(
        { EntityName: 'MJ: AI Agents', ExtraFilter: `Name='Skip' AND DriverClass='SkipProxyAgent'`, MaxRows: 1, ResultType: 'entity_object' },
        contextUser,
    );
    if (existing.Success && existing.Results?.length) {
        const agent = existing.Results[0];
        if (agent.Status !== 'Active') {
            agent.Status = 'Active';
            if (await agent.Save()) {
                log('✓ Reactivated the "Skip" AI Agent (was deactivated by MJ core sync).');
            } else {
                LogError(`[skip-client] Failed to reactivate the Skip AI Agent: ${agent.LatestResult?.Message ?? 'unknown error'}`);
            }
        } else {
            log('Skip AI Agent already present and active — skipping.');
        }
        return;
    }

    const typeID = await lookupId('MJ: AI Agent Types', 'Loop', contextUser);
    const categoryID = await lookupId('MJ: AI Agent Categories', 'Assistant', contextUser);
    const artifactTypeID = await lookupId('MJ: Artifact Types', 'Component', contextUser);

    const agent = await provider.GetEntityObject<MJAIAgentEntity>('MJ: AI Agents', contextUser);
    agent.NewRecord();
    // Reuse the stable legacy ID so existing conversation details and agent run history
    // (which reference this ID via FK) continue to resolve after migration.
    agent.ID = SKIP_AGENT_ID;
    agent.Name = 'Skip';
    agent.Description = 'Data analytics and reporting expert that can create charts, graphs, dashboards and provide insights on data';
    agent.Status = 'Active';
    agent.DriverClass = 'SkipProxyAgent';
    agent.ExecutionOrder = 0;
    agent.ExposeAsAction = true;
    agent.IconClass = 'mj-icon-skip';
    if (typeID) agent.TypeID = typeID;
    if (categoryID) agent.CategoryID = categoryID;
    if (artifactTypeID) agent.DefaultArtifactTypeID = artifactTypeID;

    if (await agent.Save()) {
        log('✓ Created the "Skip" AI Agent (DriverClass=SkipProxyAgent) — @skip is now available on this instance.');
    } else {
        LogError(`[skip-client] Failed to create the Skip AI Agent: ${agent.LatestResult?.Message ?? 'unknown error'}`);
    }
}

/**
 * Warns when the registry URI comes from the stored record and points somewhere other than
 * production — the one case this resolution order cannot verify.
 *
 * No environment variable had an opinion, so whatever the row says is what MJ's
 * ComponentRegistryResolver will use. On an instance that was deliberately pointed at another
 * brain and had its env vars removed, that is correct. On a database restored or cloned from
 * another environment, it silently keeps serving Skip components from that environment's brain.
 * Setup can't tell those apart, so it says so at every install, upgrade, and boot rather than
 * resolving without comment.
 */
function warnIfStoredRegistryURIIsUnverified(
    resolved: ResolvedSkipRegistryURI,
    registryName: string,
    log: (m: string) => void,
): void {
    if (resolved.source !== 'stored' || resolved.uri === getSkipRegistryURI()) {
        return;
    }

    const overrideVar = getRegistryURIOverrideEnvVar(registryName);
    log(
        `  ⚠ "${registryName}" component registry URI is ${resolved.uri}, not the production default ` +
        `(${getSkipRegistryURI()}). Neither ${overrideVar} nor ASK_SKIP_URL is set, ` +
        `so this stored value stands and Skip components will load from that host. If this instance was ` +
        `restored from another environment's database, set ASK_SKIP_URL (or ${overrideVar}) ` +
        `to the correct brain and re-run setup, or correct the record directly.`,
    );
}

/**
 * Reports registry records that this code cannot safely act on, and returns whether the
 * caller should stop.
 *
 * Two shapes are dangerous, and neither is repaired automatically:
 *
 * - **Duplicates.** `ComponentRegistry.Name` carries no unique constraint at either the SQL
 *   or entity-metadata layer, and MJ's `ComponentRegistryResolver.getRegistryByName` uses
 *   `.find()` over a cached array. Two records sharing a name therefore resolve to whichever
 *   sits first in the cache — silently, and potentially differently after a reload.
 * - **An unexpected ID.** A hand-created registry gets `newsequentialid()`. Rewriting a
 *   record's primary key is not safe from here: `FK_Component_SourceRegistry` references it,
 *   so replicated `__mj.Component` rows would have to be repointed first.
 *
 * Reporting beats guessing. A wrong automatic repair corrupts component resolution for a
 * whole tenant, while a loud message costs one boot log line and tells an operator exactly
 * which rows to look at.
 */
function reportUnsafeRegistryRecords(
    records: MJComponentRegistryEntity[],
    registryName: string,
    expectedID: string,
    log: (m: string) => void,
): boolean {
    if (records.length > 1) {
        const ids = records.map((r) => `${r.ID} (URI: ${r.URI ?? 'none'})`).join(', ');
        LogError(
            `[skip-client] Found ${records.length} Component Registry records named "${registryName}": ${ids}. ` +
            `MJ resolves registries by name and picks the first match arbitrarily, so Skip components may load ` +
            `from the wrong host. Leaving all of them untouched — remove the duplicates, keeping ID ${expectedID}.`,
        );
        return true;
    }

    const record = records[0];
    if (record && record.ID?.toUpperCase() !== expectedID.toUpperCase()) {
        LogError(
            `[skip-client] The Component Registry named "${registryName}" has ID ${record.ID}, not the expected ` +
            `${expectedID}. This record was probably created by hand rather than by Skip setup. Its ID is not ` +
            `rewritten automatically because __mj.Component.SourceRegistryID references it. Leaving it untouched — ` +
            `its URI will NOT be kept in sync with ASK_SKIP_URL until the ID is corrected.`,
        );
        return true;
    }

    return false;
}

async function ensureSkipComponentRegistry(
    provider: IMetadataProvider,
    contextUser: UserInfo,
    log: (m: string) => void,
    registryName: string,
): Promise<void> {
    const expectedID = deriveSkipRegistryID(registryName);
    const escapedName = registryName.replace(/'/g, "''");

    // Scoped to the exact name, and deliberately NOT capped at one row: a MaxRows: 1 lookup
    // would hide duplicates, which is the one failure mode this cannot resolve on its own.
    const rv = new RunView();
    const existing = await rv.RunView<MJComponentRegistryEntity>(
        {
            EntityName: 'MJ: Component Registries',
            ExtraFilter: `ID='${expectedID}' OR Name='${escapedName}'`,
            ResultType: 'entity_object',
        },
        contextUser,
    );

    const records = existing.Success ? (existing.Results ?? []) : [];
    if (records.length) {
        if (reportUnsafeRegistryRecords(records, registryName, expectedID, log)) {
            return;
        }

        const record = records[0];
        // Pass the stored URI as the fallback: with no registry/brain env vars set, the row is
        // left exactly as it is. Setup runs again on every upgrade and on every MJAPI boot
        // (SkipMiddleware self-heal), so resolving to a bare default here would revert an
        // operator's manual correction each time.
        const resolved = resolveSkipRegistryURI(record.URI, registryName);
        warnIfStoredRegistryURIIsUnverified(resolved, registryName, log);

        const expectedURI = resolved.uri;
        if (record.URI !== expectedURI) {
            record.URI = expectedURI;
            if (await record.Save()) {
                log(`✓ Updated "${registryName}" component registry URI: ${record.URI}`);
            } else {
                LogError(
                    `[skip-client] Failed to update "${registryName}" component registry URI: ` +
                    `${record.LatestResult?.Message ?? 'unknown error'}`,
                );
            }
        } else {
            log(`"${registryName}" component registry already present — skipping.`);
        }
        return;
    }

    const reg = await provider.GetEntityObject<MJComponentRegistryEntity>('MJ: Component Registries', contextUser);
    reg.NewRecord();
    reg.ID = expectedID;
    reg.Name = registryName;
    reg.Description = 'Skip SaaS AI Agent - Remote Registry for Component Retrieval';
    reg.URI = getConfiguredSkipRegistryURI(null, registryName);
    reg.Type = 'Public';
    reg.APIVersion = '1.0.0';
    reg.Status = 'Active';

    if (await reg.Save()) {
        log(`✓ Created the "${registryName}" component registry (${reg.URI}).`);
    } else {
        LogError(
            `[skip-client] Failed to create the "${registryName}" component registry: ` +
            `${reg.LatestResult?.Message ?? 'unknown error'}`,
        );
    }
}

async function deleteMatching(
    entityName: string,
    filter: string,
    contextUser: UserInfo,
    log: (m: string) => void,
): Promise<void> {
    try {
        const rv = new RunView();
        const res = await rv.RunView<BaseEntity>(
            { EntityName: entityName, ExtraFilter: filter, ResultType: 'entity_object' },
            contextUser,
        );
        for (const rec of res.Results ?? []) {
            const ok = await rec.Delete();
            if (ok) {
                log(`✓ Removed ${entityName} record.`);
            } else {
                log(`  ⚠ Could not delete a ${entityName} record (it may be referenced by history, e.g. agent runs) — leaving it in place.`);
            }
        }
    } catch (e) {
        log(`  ⚠ Error removing ${entityName}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
