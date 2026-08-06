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
import { LogError, RunView } from '@memberjunction/core';
import type { IMetadataProvider, UserInfo, BaseEntity } from '@memberjunction/core';
import { MJAIAgentEntity, MJComponentRegistryEntity } from '@memberjunction/core-entities';
import {
    getConfiguredSkipRegistryURI,
    getSkipRegistryURI,
    resolveSkipRegistryURI,
    SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR,
} from './skip-config.js';
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

/** Idempotently create the Skip AI Agent + component registry records. */
export async function ensureSkipRecords(
    provider: IMetadataProvider,
    contextUser: UserInfo,
    log: (m: string) => void,
): Promise<void> {
    await ensureSkipAgent(provider, contextUser, log);
    await ensureSkipComponentRegistry(provider, contextUser, log);
}

/** Remove the Skip AI Agent + component registry records (best-effort). */
export async function removeSkipRecords(contextUser: UserInfo, log: (m: string) => void): Promise<void> {
    await deleteMatching('MJ: AI Agents', `(Name='Skip' AND DriverClass='SkipProxyAgent') OR ID='${SKIP_AGENT_ID}'`, contextUser, log);
    await deleteMatching(
        'MJ: Component Registries',
        `ID='${SKIP_REGISTRY_ID}' OR (Name='Skip' AND URI LIKE '%askskip%')`,
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
function warnIfStoredRegistryURIIsUnverified(resolved: ResolvedSkipRegistryURI, log: (m: string) => void): void {
    if (resolved.source !== 'stored' || resolved.uri === getSkipRegistryURI()) {
        return;
    }

    log(
        `  ⚠ Skip component registry URI is ${resolved.uri}, not the production default ` +
        `(${getSkipRegistryURI()}). Neither ${SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR} nor ASK_SKIP_URL is set, ` +
        `so this stored value stands and Skip components will load from that host. If this instance was ` +
        `restored from another environment's database, set ASK_SKIP_URL (or ${SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR}) ` +
        `to the correct brain and re-run setup, or correct the record directly.`,
    );
}

async function ensureSkipComponentRegistry(
    provider: IMetadataProvider,
    contextUser: UserInfo,
    log: (m: string) => void,
): Promise<void> {
    const rv = new RunView();
    const existing = await rv.RunView(
        { EntityName: 'MJ: Component Registries', ExtraFilter: `ID='${SKIP_REGISTRY_ID}' OR Name='Skip'`, MaxRows: 1, ResultType: 'entity_object' },
        contextUser,
    );
    if (existing.Success && existing.Results?.length) {
        const record = existing.Results[0] as MJComponentRegistryEntity;
        // Pass the stored URI as the fallback: with no registry/brain env vars set, the row is
        // left exactly as it is. Setup runs again on every upgrade and on every MJAPI boot
        // (SkipMiddleware self-heal), so resolving to a bare default here would revert an
        // operator's manual correction each time.
        const resolved = resolveSkipRegistryURI(record.URI);
        warnIfStoredRegistryURIIsUnverified(resolved, log);

        const expectedURI = resolved.uri;
        if (record.URI !== expectedURI) {
            record.URI = expectedURI;
            if (await record.Save()) {
                log(`✓ Updated Skip component registry URI: ${record.URI}`);
            } else {
                LogError(`[skip-client] Failed to update Skip component registry URI: ${record.LatestResult?.Message ?? 'unknown error'}`);
            }
        } else {
            log('Skip component registry already present — skipping.');
        }
        return;
    }

    const reg = await provider.GetEntityObject<MJComponentRegistryEntity>('MJ: Component Registries', contextUser);
    reg.NewRecord();
    reg.ID = SKIP_REGISTRY_ID;
    reg.Name = 'Skip';
    reg.Description = 'Skip SaaS AI Agent - Remote Registry for Component Retrieval';
    reg.URI = getConfiguredSkipRegistryURI();
    reg.Type = 'Public';
    reg.APIVersion = '1.0.0';
    reg.Status = 'Active';

    if (await reg.Save()) {
        log(`✓ Created the "Skip" component registry (${reg.URI}).`);
    } else {
        LogError(`[skip-client] Failed to create the Skip component registry: ${reg.LatestResult?.Message ?? 'unknown error'}`);
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
