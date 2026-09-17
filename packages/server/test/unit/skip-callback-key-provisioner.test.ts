/**
 * @fileoverview Unit tests for the Skip callback key provisioner.
 *
 * Tests cover:
 * 1. Scope-assignment failure deletes the just-created key and returns null
 *    (zero-scope / partially-scoped keys must never be delivered to Skip)
 * 2. Raw key resend semantics: resend until delivery is confirmed, then null
 * 3. Key label normalization: trailing slashes on skipURL don't cause
 *    duplicate key provisioning
 *
 * The provisioner keeps module-level state, so each test re-imports a fresh
 * copy via vi.resetModules() + dynamic import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mutable fixture state (referenced lazily by the hoisted mock factories) ──

interface ScopeRow {
    FullPath: string;
    ID: string;
}

const ALL_SCOPE_PATHS = [
    'view:run', 'view:batch', 'query:run', 'query:create', 'query:update', 'query:delete',
    'query:test', 'query:profile', 'search:execute', 'prompt:execute', 'agent:execute',
    'embedding:generate', 'entity:read', 'entity:create', 'entity:update', 'entity:delete',
];

function buildAllScopes(): ScopeRow[] {
    return ALL_SCOPE_PATHS.map((p, i) => ({ FullPath: p, ID: `scope-${i}` }));
}

const state = {
    skipURL: 'https://skip.example.com',
    scopes: buildAllScopes(),
    createResult: { Success: true, RawKey: 'raw-key-123', APIKeyId: 'key-1', Error: undefined as string | undefined },
    scopeSaveResult: true,
    existingKeyRows: [] as Array<{ ID: string; Label: string; Status: string }>,
    runViewFilters: [] as string[],
    savedScopes: [] as Array<Record<string, unknown>>,
    deletedKeyIDs: [] as string[],
};

function resetState(): void {
    state.skipURL = 'https://skip.example.com';
    state.scopes = buildAllScopes();
    state.createResult = { Success: true, RawKey: 'raw-key-123', APIKeyId: 'key-1', Error: undefined };
    state.scopeSaveResult = true;
    state.existingKeyRows = [];
    state.runViewFilters = [];
    state.savedScopes = [];
    state.deletedKeyIDs = [];
}

// ── Entity mocks ─────────────────────────────────────────────────────────────

function createKeyEntityMock() {
    let loadedID: string | null = null;
    return {
        Load: vi.fn(async (id: string) => { loadedID = id; return true; }),
        Delete: vi.fn(async () => {
            if (loadedID) state.deletedKeyIDs.push(loadedID);
            return true;
        }),
    };
}

function createScopeEntityMock() {
    const values: Record<string, unknown> = {};
    return {
        NewRecord: vi.fn(),
        Set: (field: string, value: unknown) => { values[field] = value; },
        Save: vi.fn(async () => {
            if (state.scopeSaveResult) state.savedScopes.push({ ...values });
            return state.scopeSaveResult;
        }),
        InnerLoad: vi.fn(async () => false),
        Delete: vi.fn(async () => true),
    };
}

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@memberjunction/core', () => ({
    LogStatus: vi.fn(),
    LogError: vi.fn(),
    CompositeKey: class {
        constructor(public parts: Array<{ FieldName: string; Value: unknown }>) {}
    },
    Metadata: class {
        GetEntityObject = vi.fn(async (entityName: string) =>
            entityName === 'MJ: API Keys' ? createKeyEntityMock() : createScopeEntityMock()
        );
    },
    RunView: class {
        RunView = vi.fn(async (params: { ExtraFilter: string }) => {
            state.runViewFilters.push(params.ExtraFilter);
            return { Success: true, Results: state.existingKeyRows };
        });
    },
}));

vi.mock('@memberjunction/api-keys', () => ({
    GetAPIKeyEngine: () => ({
        get Scopes() { return state.scopes; },
        CreateAPIKey: vi.fn(async () => state.createResult),
    }),
    APIKeysEngineBase: {
        get Instance() {
            return {
                get Scopes() { return state.scopes; },
                GetKeyScopesByKeyId: () => [],
                Config: vi.fn(async () => undefined),
            };
        },
    },
}));

vi.mock('@memberjunction/core-entities', () => ({
    MJAPIKeyEntity: class {},
}));

vi.mock('@memberjunction/sqlserver-dataprovider', () => ({
    UserCache: {
        get Instance() {
            return {
                GetSystemUser: () => ({ ID: 'sys-1', Email: 'system@mj.internal' }),
                Users: [{ ID: 'svc-1', Email: 'skip-service@skip.internal' }],
            };
        },
    },
}));

vi.mock('@askskip/core', () => ({
    getSkipConfig: () => ({ skipURL: state.skipURL }),
}));

type ProvisionerModule = typeof import('../../src/skip-callback-key-provisioner.js');

async function importFreshProvisioner(): Promise<ProvisionerModule> {
    vi.resetModules();
    return import('../../src/skip-callback-key-provisioner.js');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('skip-callback-key-provisioner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetState();
    });

    describe('scope assignment failure (fix: never deliver an unusable key)', () => {
        it('deletes the created key and returns null when a required MJ-core scope is missing', async () => {
            state.scopes = state.scopes.filter(s => s.FullPath !== 'view:run');
            const mod = await importFreshProvisioner();

            const key = await mod.getSkipCallbackKey();

            expect(key).toBeNull();
            expect(state.deletedKeyIDs).toContain('key-1');
            expect(mod.provisioningComplete).toBe(false);
        });

        it('deletes the created key and returns null when scope saves partially fail', async () => {
            state.scopeSaveResult = false;
            const mod = await importFreshProvisioner();

            const key = await mod.getSkipCallbackKey();

            expect(key).toBeNull();
            expect(state.deletedKeyIDs).toContain('key-1');
            expect(mod.provisioningComplete).toBe(false);
        });

        it('retries provisioning on the next call after a scope failure (no wedged state)', async () => {
            state.scopes = state.scopes.filter(s => s.FullPath !== 'query:run');
            const mod = await importFreshProvisioner();

            expect(await mod.getSkipCallbackKey()).toBeNull();

            // Operator deploys the missing scope; the next request self-heals.
            state.scopes = buildAllScopes();
            expect(await mod.getSkipCallbackKey()).toBe('raw-key-123');
        });

        it('does not abort when only the app-owned query:profile scope is missing', async () => {
            state.scopes = state.scopes.filter(s => s.FullPath !== 'query:profile');
            const mod = await importFreshProvisioner();

            const key = await mod.getSkipCallbackKey();

            expect(key).toBe('raw-key-123');
            expect(state.deletedKeyIDs).toHaveLength(0);
            expect(state.savedScopes).toHaveLength(ALL_SCOPE_PATHS.length - 1);
        });

        it('returns the raw key when all scopes assign successfully', async () => {
            const mod = await importFreshProvisioner();

            const key = await mod.getSkipCallbackKey();

            expect(key).toBe('raw-key-123');
            expect(state.deletedKeyIDs).toHaveLength(0);
            expect(state.savedScopes).toHaveLength(ALL_SCOPE_PATHS.length);
        });
    });

    describe('raw key resend semantics (fix: stop resending once delivered)', () => {
        it('resends the raw key until delivery is confirmed, then returns null', async () => {
            const mod = await importFreshProvisioner();

            // First call creates the key and returns the raw value.
            expect(await mod.getSkipCallbackKey()).toBe('raw-key-123');

            // Unconfirmed: concurrent/piggybacked requests still carry the key.
            expect(await mod.getSkipCallbackKey()).toBe('raw-key-123');

            mod.confirmCallbackKeyDelivered();

            // Confirmed: contract says subsequent calls return null.
            expect(await mod.getSkipCallbackKey()).toBeNull();
            expect(await mod.getSkipCallbackKey()).toBeNull();
        });

        it('returns null on every call when the key row already exists in the DB', async () => {
            state.existingKeyRows = [{ ID: 'existing-1', Label: 'Skip Callback: https://skip.example.com', Status: 'Active' }];
            const mod = await importFreshProvisioner();

            expect(await mod.getSkipCallbackKey()).toBeNull();
            expect(await mod.getSkipCallbackKey()).toBeNull();
            expect(mod.provisioningComplete).toBe(true);
        });
    });

    describe('key label normalization (fix: trailing slash must not fork key identity)', () => {
        it('strips trailing slashes from skipURL when looking up the existing key', async () => {
            state.skipURL = 'https://skip.example.com///';
            const mod = await importFreshProvisioner();

            await mod.getSkipCallbackKey();

            expect(state.runViewFilters.length).toBeGreaterThan(0);
            expect(state.runViewFilters[0]).toContain("Label='Skip Callback: https://skip.example.com'");
        });
    });
});
