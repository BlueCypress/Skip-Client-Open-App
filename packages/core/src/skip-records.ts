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
import {
    MJAIAgentEntity,
    MJAIAgentActionEntity,
    MJAIAgentPromptEntity,
    MJAIPromptEntity,
    MJAIPromptModelEntity,
    MJComponentRegistryEntity,
    MJTemplateContentEntity,
    MJTemplateEntity,
} from '@memberjunction/core-entities';
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
import {
    SKIP_AGENT_ID,
    SKIP_COMPONENT_BUILDER_AGENT_ID,
    SKIP_DATA_ANSWERER_AGENT_ID,
    SKIP_ANALYST_AGENT_ID,
    SKIP_SCHEMA_GUIDE_AGENT_ID,
    SKIP_VISUALIZER_AGENT_ID,
    SKIP_AGENT_PROMPT_SPECS,
} from './skip-local-prompts.js';

export {
    SKIP_AGENT_ID,
    SKIP_COMPONENT_BUILDER_AGENT_ID,
    SKIP_DATA_ANSWERER_AGENT_ID,
    SKIP_ANALYST_AGENT_ID,
    SKIP_SCHEMA_GUIDE_AGENT_ID,
    SKIP_VISUALIZER_AGENT_ID,
};

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
const SKIP_REGISTRY_ID = 'B2F8C247-D22E-4991-9A69-0F73954A68D6';

export interface SkipSubAgentSpec {
    id: string;
    name: string;
    description: string;
    driverClass: string | null;
    defaultArtifactType: 'Component' | 'Data' | 'Markdown' | 'SVG';
    executionOrder: number;
}

export const SKIP_SUB_AGENTS: readonly SkipSubAgentSpec[] = [
    {
        id: SKIP_COMPONENT_BUILDER_AGENT_ID,
        name: 'Skip: Component Builder',
        description: 'Builds and refines interactive components, dashboards, reports, and multi-panel applications via Skip Brain.',
        driverClass: 'SkipProxyAgent',
        defaultArtifactType: 'Component',
        executionOrder: 1,
    },
    {
        id: SKIP_DATA_ANSWERER_AGENT_ID,
        name: 'Skip: Data Answerer',
        description: 'Answers factual data questions with governed SQL queries and tabular data artifacts.',
        driverClass: null,
        defaultArtifactType: 'Data',
        executionOrder: 2,
    },
    {
        id: SKIP_ANALYST_AGENT_ID,
        name: 'Skip: Analyst',
        description: 'Performs multi-step analytical investigations and root-cause analysis over governed entity data.',
        driverClass: null,
        defaultArtifactType: 'Markdown',
        executionOrder: 3,
    },
    {
        id: SKIP_SCHEMA_GUIDE_AGENT_ID,
        name: 'Skip: Schema Guide',
        description: 'Explains entity schemas, relationships, canonical views, and governed queries.',
        driverClass: null,
        defaultArtifactType: 'Markdown',
        executionOrder: 4,
    },
    {
        id: SKIP_VISUALIZER_AGENT_ID,
        name: 'Skip: Visualizer',
        description: 'Generates quick single-chart SVG visualizations for immediate data exploration.',
        driverClass: null,
        defaultArtifactType: 'SVG',
        executionOrder: 5,
    },
] as const;

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

/** What a `REGISTRY_URI_OVERRIDE_SKIP` value means on an instance publishing under another name. */
export type ProductionRegistryOverrideKind = 'absent' | 'legacy' | 'deliberate';

/**
 * Decides whether `REGISTRY_URI_OVERRIDE_SKIP` expresses intent about the *production*
 * registry, or is simply left over from before per-environment names existed.
 *
 * The distinction matters because "is it set at all" is the wrong test. Before
 * per-environment registries, pointing a client at stage or a laptop **was** setting this
 * variable — so on exactly the clients whose production row is wrong, the variable is set,
 * and treating that as intent means the repair never runs where it is needed. Not
 * hypothetical: More Cheese Stage carried it from the single-registry era, and its `Skip`
 * row kept pointing at the stage brain straight through the upgrade.
 *
 * So the test is *where it points*. A value aimed at this instance's own brain cannot be a
 * statement about production — production is, by definition, somewhere else. A value aimed
 * anywhere else (a mirror, a proxy) is taken at face value and left alone.
 *
 * @param override           Raw `REGISTRY_URI_OVERRIDE_SKIP`, if set.
 * @param thisEnvironmentURI Registry URI this instance actually resolves to.
 */
export function classifyProductionRegistryOverride(
    override: string | undefined,
    thisEnvironmentURI: string,
): ProductionRegistryOverrideKind {
    const normalize = (v: string) => v.trim().replace(/\/+$/, '').toLowerCase();
    const value = override?.trim();
    if (!value) {
        return 'absent';
    }
    return normalize(value) === normalize(thisEnvironmentURI) ? 'legacy' : 'deliberate';
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
 * - **A `REGISTRY_URI_OVERRIDE_SKIP` aimed somewhere other than this instance's own brain.**
 *   That is an operator pointing production's registry somewhere on purpose (a mirror, a
 *   proxy), and MJ honors it at runtime anyway. See
 *   {@link classifyProductionRegistryOverride} for why "somewhere other than" is the test
 *   rather than merely "set".
 * - **This instance actually using `Skip`.** Then `ensureSkipComponentRegistry` owns the
 *   row and its resolution order — including following `ASK_SKIP_URL` for a developer who
 *   has not adopted per-environment names — applies unchanged.
 *
 * Every path that declines to act says so. Returning silently meant the only way to find
 * out nothing had happened was to go and read the table.
 */
async function healProductionRegistryIfUnused(
    contextUser: UserInfo,
    log: (m: string) => void,
    registryName: string,
): Promise<void> {
    if (registryName === DEFAULT_SKIP_REGISTRY_NAME) {
        return;
    }

    const overrideVar = getRegistryURIOverrideEnvVar(DEFAULT_SKIP_REGISTRY_NAME);
    const override = process.env[overrideVar]?.trim();
    const classification = classifyProductionRegistryOverride(
        override,
        resolveSkipRegistryURI(null, registryName).uri,
    );

    if (classification === 'deliberate') {
        log(
            `  ℹ Leaving the production "${DEFAULT_SKIP_REGISTRY_NAME}" component registry alone: ` +
            `${overrideVar}=${override} points somewhere that is neither production nor this ` +
            `instance's own brain, so it is treated as a deliberate override.`,
        );
        return;
    }

    if (classification === 'legacy') {
        log(
            `  ℹ ${overrideVar}=${override} points at this instance's own brain, so it is leftover ` +
            `wiring from before per-environment registries rather than a statement about production. ` +
            `Restoring the production record anyway — remove the variable, it is superseded by ` +
            `${getRegistryURIOverrideEnvVar(registryName)}.`,
        );
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
    if (records.length > 1) {
        // The duplicate-name hazard again, on the production row this time. Do not guess
        // which one to repair — reportUnsafeRegistryRecords only inspects the registry this
        // instance publishes under, so nothing else would mention these.
        LogError(
            `[skip-client] Found ${records.length} Component Registry records matching the production ` +
            `"${DEFAULT_SKIP_REGISTRY_NAME}" registry: ${records.map((r) => `${r.ID} (${r.URI ?? 'no URI'})`).join(', ')}. ` +
            `Not restoring any of them — remove the duplicates, keeping ID ${SKIP_REGISTRY_ID}.`,
        );
        return;
    }
    if (records.length === 0) {
        // Normal on an instance that has only ever used a named registry.
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
    const subAgentIds = SKIP_SUB_AGENTS.map((s) => `'${s.id}'`).join(', ');
    const allAgentIds = [`'${SKIP_AGENT_ID}'`, ...SKIP_SUB_AGENTS.map((s) => `'${s.id}'`)].join(', ');
    const promptIds = SKIP_AGENT_PROMPT_SPECS.map((p) => `'${p.promptId}'`).join(', ');
    const templateIds = SKIP_AGENT_PROMPT_SPECS.map((p) => `'${p.templateId}'`).join(', ');

    await deleteMatching('MJ: AI Agent Actions', `AgentID IN (${allAgentIds})`, contextUser, log);
    await deleteMatching('MJ: AI Agent Prompts', `AgentID IN (${allAgentIds}) OR PromptID IN (${promptIds})`, contextUser, log);
    await deleteMatching('MJ: AI Prompt Models', `PromptID IN (${promptIds})`, contextUser, log);
    await deleteMatching('MJ: AI Prompts', `ID IN (${promptIds})`, contextUser, log);
    await deleteMatching('MJ: Template Contents', `TemplateID IN (${templateIds})`, contextUser, log);
    await deleteMatching('MJ: Templates', `ID IN (${templateIds})`, contextUser, log);

    await deleteMatching(
        'MJ: AI Agents',
        `ParentID='${SKIP_AGENT_ID}' OR ID IN (${subAgentIds})`,
        contextUser,
        log,
    );
    await deleteMatching(
        'MJ: AI Agents',
        `(Name='Skip' AND DriverClass IN ('SkipProxyAgent', 'SkipLocalAgent')) OR ID='${SKIP_AGENT_ID}'`,
        contextUser,
        log,
    );
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
        {
            EntityName: 'MJ: AI Agents',
            ExtraFilter: `ID='${SKIP_AGENT_ID}' OR (Name='Skip' AND DriverClass IN ('SkipProxyAgent', 'SkipLocalAgent'))`,
            MaxRows: 1,
            ResultType: 'entity_object',
        },
        contextUser,
    );

    const typeID = await lookupId('MJ: AI Agent Types', 'Loop', contextUser);
    const categoryID = await lookupId('MJ: AI Agent Categories', 'Assistant', contextUser);
    const componentArtifactTypeID = await lookupId('MJ: Artifact Types', 'Component', contextUser);

    if (existing.Success && existing.Results?.length) {
        const agent = existing.Results[0];
        let changed = false;

        if (agent.Status !== 'Active') {
            agent.Status = 'Active';
            changed = true;
        }
        if (agent.DriverClass !== 'SkipLocalAgent') {
            agent.DriverClass = 'SkipLocalAgent';
            changed = true;
        }
        if (typeID && agent.TypeID !== typeID) {
            agent.TypeID = typeID;
            changed = true;
        }
        if (componentArtifactTypeID && !agent.DefaultArtifactTypeID) {
            agent.DefaultArtifactTypeID = componentArtifactTypeID;
            changed = true;
        }
        if (agent.ModelSelectionMode !== 'Agent') {
            agent.ModelSelectionMode = 'Agent';
            changed = true;
        }
        if (agent.ChatHandlingOption != null) {
            agent.ChatHandlingOption = null;
            changed = true;
        }
        if (agent.InjectNotes !== true) {
            agent.InjectNotes = true;
            changed = true;
        }
        if (agent.MaxNotesToInject !== 10) {
            agent.MaxNotesToInject = 10;
            changed = true;
        }
        if (agent.NoteInjectionStrategy !== 'Recent') {
            agent.NoteInjectionStrategy = 'Recent';
            changed = true;
        }

        if (changed) {
            if (await agent.Save()) {
                log('✓ Reconciled the "Skip" AI Agent (Status=Active, DriverClass=SkipLocalAgent).');
            } else {
                LogError(`[skip-client] Failed to reconcile the Skip AI Agent: ${agent.LatestResult?.Message ?? 'unknown error'}`);
            }
        } else {
            log('Skip AI Agent already present and active — skipping.');
        }

        await ensureSkipSubAgents(provider, contextUser, log, typeID, categoryID, componentArtifactTypeID);
        await ensureSkipPromptsAndActions(provider, contextUser, log);
        return;
    }

    const agent = await provider.GetEntityObject<MJAIAgentEntity>('MJ: AI Agents', contextUser);
    agent.NewRecord();
    // Reuse the stable legacy ID so existing conversation details and agent run history
    // (which reference this ID via FK) continue to resolve after migration.
    agent.ID = SKIP_AGENT_ID;
    agent.Name = 'Skip';
    agent.Description = 'Data analytics and reporting expert that can create charts, graphs, dashboards and provide insights on data';
    agent.Status = 'Active';
    agent.DriverClass = 'SkipLocalAgent';
    agent.ExecutionOrder = 0;
    agent.ExposeAsAction = true;
    agent.ModelSelectionMode = 'Agent';
    agent.ChatHandlingOption = null;
    agent.InjectNotes = true;
    agent.MaxNotesToInject = 10;
    agent.NoteInjectionStrategy = 'Recent';
    agent.IconClass = 'mj-icon-skip';
    if (typeID) agent.TypeID = typeID;
    if (categoryID) agent.CategoryID = categoryID;
    if (componentArtifactTypeID) agent.DefaultArtifactTypeID = componentArtifactTypeID;

    if (await agent.Save()) {
        log('✓ Created the "Skip" AI Agent (DriverClass=SkipLocalAgent) — @skip is now available on this instance.');
    } else {
        LogError(`[skip-client] Failed to create the Skip AI Agent: ${agent.LatestResult?.Message ?? 'unknown error'}`);
        return;
    }

    await ensureSkipSubAgents(provider, contextUser, log, typeID, categoryID, componentArtifactTypeID);
    await ensureSkipPromptsAndActions(provider, contextUser, log);
}

async function ensureSkipSubAgents(
    provider: IMetadataProvider,
    contextUser: UserInfo,
    log: (m: string) => void,
    typeID: string | undefined,
    categoryID: string | undefined,
    componentArtifactTypeID: string | undefined,
): Promise<void> {
    const rv = new RunView();
    const artifactTypeCache = new Map<string, string | undefined>();
    if (componentArtifactTypeID) {
        artifactTypeCache.set('Component', componentArtifactTypeID);
    }

    const resolveArtifactTypeID = async (artifactTypeName: string): Promise<string | undefined> => {
        if (artifactTypeCache.has(artifactTypeName)) {
            return artifactTypeCache.get(artifactTypeName);
        }
        const id = await lookupId('MJ: Artifact Types', artifactTypeName, contextUser);
        artifactTypeCache.set(artifactTypeName, id);
        return id;
    };

    for (const spec of SKIP_SUB_AGENTS) {
        const escapedName = spec.name.replace(/'/g, "''");
        const existing = await rv.RunView<MJAIAgentEntity>(
            {
                EntityName: 'MJ: AI Agents',
                ExtraFilter: `ID='${spec.id}' OR (Name='${escapedName}' AND ParentID='${SKIP_AGENT_ID}')`,
                MaxRows: 1,
                ResultType: 'entity_object',
            },
            contextUser,
        );

        const defaultArtifactTypeID = await resolveArtifactTypeID(spec.defaultArtifactType);

        if (existing.Success && existing.Results?.length) {
            const subAgent = existing.Results[0];
            let changed = false;

            if (subAgent.Status !== 'Active') {
                subAgent.Status = 'Active';
                changed = true;
            }
            if (subAgent.ParentID?.toUpperCase() !== SKIP_AGENT_ID.toUpperCase()) {
                subAgent.ParentID = SKIP_AGENT_ID;
                changed = true;
            }
            if (subAgent.ExposeAsAction !== false) {
                subAgent.ExposeAsAction = false;
                changed = true;
            }
            if (subAgent.InvocationMode !== 'Sub-Agent') {
                subAgent.InvocationMode = 'Sub-Agent';
                changed = true;
            }
            if (subAgent.MessageMode !== 'All') {
                subAgent.MessageMode = 'All';
                changed = true;
            }
            if (subAgent.ModelSelectionMode !== 'Agent') {
                subAgent.ModelSelectionMode = 'Agent';
                changed = true;
            }
            if (subAgent.ChatHandlingOption != null) {
                subAgent.ChatHandlingOption = null;
                changed = true;
            }
            if ((subAgent.DriverClass ?? null) !== spec.driverClass) {
                subAgent.DriverClass = spec.driverClass;
                changed = true;
            }
            if (typeID && subAgent.TypeID !== typeID) {
                subAgent.TypeID = typeID;
                changed = true;
            }
            if (defaultArtifactTypeID && subAgent.DefaultArtifactTypeID !== defaultArtifactTypeID) {
                subAgent.DefaultArtifactTypeID = defaultArtifactTypeID;
                changed = true;
            }
            if (subAgent.InjectNotes !== true) {
                subAgent.InjectNotes = true;
                changed = true;
            }
            if (subAgent.MaxNotesToInject !== 10) {
                subAgent.MaxNotesToInject = 10;
                changed = true;
            }
            if (subAgent.NoteInjectionStrategy !== 'Recent') {
                subAgent.NoteInjectionStrategy = 'Recent';
                changed = true;
            }

            if (changed) {
                if (await subAgent.Save()) {
                    log(`✓ Reconciled sub-agent "${spec.name}".`);
                } else {
                    LogError(`[skip-client] Failed to reconcile sub-agent "${spec.name}": ${subAgent.LatestResult?.Message ?? 'unknown error'}`);
                }
            }
            continue;
        }

        const subAgent = await provider.GetEntityObject<MJAIAgentEntity>('MJ: AI Agents', contextUser);
        subAgent.NewRecord();
        subAgent.ID = spec.id;
        subAgent.Name = spec.name;
        subAgent.Description = spec.description;
        subAgent.ParentID = SKIP_AGENT_ID;
        subAgent.Status = 'Active';
        subAgent.DriverClass = spec.driverClass;
        subAgent.ExecutionOrder = spec.executionOrder;
        subAgent.ExposeAsAction = false;
        subAgent.InvocationMode = 'Sub-Agent';
        subAgent.MessageMode = 'All';
        subAgent.ModelSelectionMode = 'Agent';
        subAgent.ChatHandlingOption = null;
        subAgent.InjectNotes = true;
        subAgent.MaxNotesToInject = 10;
        subAgent.NoteInjectionStrategy = 'Recent';
        subAgent.IconClass = 'mj-icon-skip';
        if (typeID) subAgent.TypeID = typeID;
        if (categoryID) subAgent.CategoryID = categoryID;
        if (defaultArtifactTypeID) subAgent.DefaultArtifactTypeID = defaultArtifactTypeID;

        if (await subAgent.Save()) {
            log(`✓ Created sub-agent "${spec.name}".`);
        } else {
            LogError(`[skip-client] Failed to create sub-agent "${spec.name}": ${subAgent.LatestResult?.Message ?? 'unknown error'}`);
        }
    }
}

async function ensureSkipPromptsAndActions(
    provider: IMetadataProvider,
    contextUser: UserInfo,
    log: (m: string) => void,
): Promise<void> {
    const rv = new RunView();
    const promptTypeID = await lookupId('MJ: AI Prompt Types', 'Chat', contextUser);
    const promptCategoryID = await lookupId('MJ: AI Prompt Categories', 'MJ: System', contextUser);
    const templateContentTypeID =
        (await lookupId('MJ: Template Content Types', 'Text', contextUser)) ??
        (await lookupId('MJ: Template Content Types', 'Markdown', contextUser));

    // If core prompt/template lookup metadata is absent (e.g. minimal unit test mocks),
    // skip prompt seeding gracefully without failing agent creation.
    if (!promptTypeID) {
        return;
    }

    const modelCache = new Map<string, string | undefined>();
    const vendorCache = new Map<string, string | undefined>();
    const actionCache = new Map<string, string | undefined>();

    const resolveCachedId = async (
        cache: Map<string, string | undefined>,
        entityName: string,
        name: string,
    ): Promise<string | undefined> => {
        if (cache.has(name)) {
            return cache.get(name);
        }
        const id = await lookupId(entityName, name, contextUser);
        cache.set(name, id);
        return id;
    };

    for (const spec of SKIP_AGENT_PROMPT_SPECS) {
        // 1. Template
        const existingTemplate = await rv.RunView<MJTemplateEntity>(
            {
                EntityName: 'MJ: Templates',
                ExtraFilter: `ID='${spec.templateId}'`,
                MaxRows: 1,
                ResultType: 'entity_object',
            },
            contextUser,
        );
        if (!existingTemplate.Success || !existingTemplate.Results?.length) {
            const tpl = await provider.GetEntityObject<MJTemplateEntity>('MJ: Templates', contextUser);
            tpl.NewRecord();
            tpl.ID = spec.templateId;
            tpl.Name = spec.promptName;
            tpl.Description = spec.promptDescription;
            tpl.UserID = contextUser.ID;
            tpl.IsActive = true;
            if (!(await tpl.Save())) {
                LogError(`[skip-client] Failed to create Template "${spec.promptName}": ${tpl.LatestResult?.Message ?? 'unknown error'}`);
                continue;
            }
        }

        // 2. Template Content
        if (templateContentTypeID) {
            const existingContent = await rv.RunView<MJTemplateContentEntity>(
                {
                    EntityName: 'MJ: Template Contents',
                    ExtraFilter: `ID='${spec.templateContentId}' OR TemplateID='${spec.templateId}'`,
                    MaxRows: 1,
                    ResultType: 'entity_object',
                },
                contextUser,
            );
            if (existingContent.Success && existingContent.Results?.length) {
                const contentEntity = existingContent.Results[0];
                if (contentEntity.TemplateText !== spec.templateText || !contentEntity.IsActive) {
                    contentEntity.TemplateText = spec.templateText;
                    contentEntity.IsActive = true;
                    await contentEntity.Save();
                }
            } else {
                const contentEntity = await provider.GetEntityObject<MJTemplateContentEntity>('MJ: Template Contents', contextUser);
                contentEntity.NewRecord();
                contentEntity.ID = spec.templateContentId;
                contentEntity.TemplateID = spec.templateId;
                contentEntity.TypeID = templateContentTypeID;
                contentEntity.TemplateText = spec.templateText;
                contentEntity.Priority = 1;
                contentEntity.IsActive = true;
                await contentEntity.Save();
            }
        }

        // 3. AI Prompt
        const existingPrompt = await rv.RunView<MJAIPromptEntity>(
            {
                EntityName: 'MJ: AI Prompts',
                ExtraFilter: `ID='${spec.promptId}'`,
                MaxRows: 1,
                ResultType: 'entity_object',
            },
            contextUser,
        );
        if (existingPrompt.Success && existingPrompt.Results?.length) {
            const promptEntity = existingPrompt.Results[0];
            let promptChanged = false;
            if (promptEntity.Status !== 'Active') {
                promptEntity.Status = 'Active';
                promptChanged = true;
            }
            if (promptEntity.TemplateID?.toUpperCase() !== spec.templateId.toUpperCase()) {
                promptEntity.TemplateID = spec.templateId;
                promptChanged = true;
            }
            if (promptChanged) {
                await promptEntity.Save();
            }
        } else {
            const promptEntity = await provider.GetEntityObject<MJAIPromptEntity>('MJ: AI Prompts', contextUser);
            promptEntity.NewRecord();
            promptEntity.ID = spec.promptId;
            promptEntity.Name = spec.promptName;
            promptEntity.Description = spec.promptDescription;
            promptEntity.TemplateID = spec.templateId;
            promptEntity.TypeID = promptTypeID;
            if (promptCategoryID) {
                promptEntity.CategoryID = promptCategoryID;
            }
            promptEntity.Status = 'Active';
            promptEntity.PromptRole = 'System';
            promptEntity.PromptPosition = 'First';
            promptEntity.ResponseFormat = 'Any';
            promptEntity.OutputType = 'string';
            if (await promptEntity.Save()) {
                log(`✓ Created AI Prompt "${spec.promptName}".`);
            } else {
                LogError(`[skip-client] Failed to create AI Prompt "${spec.promptName}": ${promptEntity.LatestResult?.Message ?? 'unknown error'}`);
                continue;
            }
        }

        // 4. AI Agent Prompt link
        const existingAgentPrompt = await rv.RunView<MJAIAgentPromptEntity>(
            {
                EntityName: 'MJ: AI Agent Prompts',
                ExtraFilter: `ID='${spec.agentPromptId}' OR (AgentID='${spec.agentId}' AND PromptID='${spec.promptId}')`,
                MaxRows: 1,
                ResultType: 'entity_object',
            },
            contextUser,
        );
        if (existingAgentPrompt.Success && existingAgentPrompt.Results?.length) {
            const ap = existingAgentPrompt.Results[0];
            if (ap.Status !== 'Active') {
                ap.Status = 'Active';
                await ap.Save();
            }
        } else {
            const ap = await provider.GetEntityObject<MJAIAgentPromptEntity>('MJ: AI Agent Prompts', contextUser);
            ap.NewRecord();
            ap.ID = spec.agentPromptId;
            ap.AgentID = spec.agentId;
            ap.PromptID = spec.promptId;
            ap.ExecutionOrder = 0;
            ap.Status = 'Active';
            await ap.Save();
        }

        // 5. AI Prompt Models (with fallback priorities)
        for (const modelSpec of spec.models) {
            const modelID = await resolveCachedId(modelCache, 'MJ: AI Models', modelSpec.modelName);
            if (!modelID) {
                continue;
            }
            const vendorID = await resolveCachedId(vendorCache, 'MJ: AI Vendors', modelSpec.vendorName);
            const existingPM = await rv.RunView<MJAIPromptModelEntity>(
                {
                    EntityName: 'MJ: AI Prompt Models',
                    ExtraFilter: `ID='${modelSpec.id}' OR (PromptID='${spec.promptId}' AND ModelID='${modelID}')`,
                    MaxRows: 1,
                    ResultType: 'entity_object',
                },
                contextUser,
            );
            if (!existingPM.Success || !existingPM.Results?.length) {
                const pm = await provider.GetEntityObject<MJAIPromptModelEntity>('MJ: AI Prompt Models', contextUser);
                pm.NewRecord();
                pm.ID = modelSpec.id;
                pm.PromptID = spec.promptId;
                pm.ModelID = modelID;
                if (vendorID) {
                    pm.VendorID = vendorID;
                }
                pm.Priority = modelSpec.priority;
                pm.Status = 'Active';
                await pm.Save();
            }
        }

        // 6. AI Agent Actions
        for (const actionSpec of spec.actions) {
            const actionID = await resolveCachedId(actionCache, 'MJ: Actions', actionSpec.actionName);
            if (!actionID) {
                continue;
            }
            const existingAA = await rv.RunView<MJAIAgentActionEntity>(
                {
                    EntityName: 'MJ: AI Agent Actions',
                    ExtraFilter: `ID='${actionSpec.id}' OR (AgentID='${spec.agentId}' AND ActionID='${actionID}')`,
                    MaxRows: 1,
                    ResultType: 'entity_object',
                },
                contextUser,
            );
            if (existingAA.Success && existingAA.Results?.length) {
                const aa = existingAA.Results[0];
                if (aa.Status !== 'Active') {
                    aa.Status = 'Active';
                    await aa.Save();
                }
            } else {
                const aa = await provider.GetEntityObject<MJAIAgentActionEntity>('MJ: AI Agent Actions', contextUser);
                aa.NewRecord();
                aa.ID = actionSpec.id;
                aa.AgentID = spec.agentId;
                aa.ActionID = actionID;
                aa.Status = 'Active';
                await aa.Save();
            }
        }
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
