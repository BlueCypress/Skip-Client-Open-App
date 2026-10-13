/**
 * @fileoverview Unit tests for the lifetime of SkipSDK's entity-metadata cache.
 *
 * The payload is an in-memory projection of MJ metadata, built once and reused. Schema changes
 * need CodeGen and an MJAPI restart, so the only runtime change that must reach Skip is a write
 * to entity or field `ScopeDefault`. These tests pin that: repeat traffic never rebuilds; a
 * scope write rebuilds only once MJ has refreshed its metadata (not before, or the old metadata
 * would be cached again); explicit invalidation and forced refresh rebuild; and an empty or
 * failed build is never kept.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** The BaseEntity event shape the SDK reads off the MJGlobal stream. */
interface FakeEntityEvent { type: string; entityName: string }
interface FakeMJEvent { event: string; eventCode: string; args: FakeEntityEvent }
type FakeListener = (event: FakeMJEvent) => void;

/** The global provider: `AllMetadata` is replaced wholesale whenever MJ refreshes. */
interface FakeProvider { Entities: { Name: string }[]; AllMetadata: object }

const fakes = vi.hoisted(() => {
    const listeners: FakeListener[] = [];
    const stream = {
        subscribe: (listener: FakeListener) => {
            listeners.push(listener);
            return { unsubscribe: () => listeners.splice(listeners.indexOf(listener), 1) };
        },
    };
    const provider: FakeProvider = { Entities: [{ Name: 'Accounts' }], AllMetadata: {} };
    const emit = (event: FakeMJEvent) => listeners.forEach((listener) => listener(event));
    return { stream, provider, emit };
});

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../src/skip-callback-key-provisioner.js', () => ({
    getSkipCallbackKey: vi.fn().mockResolvedValue(null),
    resetCallbackKeyProvisioning: vi.fn().mockResolvedValue(undefined),
    confirmCallbackKeyDelivered: vi.fn(),
    discardUnconfirmedCallbackKey: vi.fn().mockResolvedValue(false),
}));

vi.mock('@askskip/core', () => ({
    getSkipConfig: () => ({
        skipURL: 'https://test.askskip.ai',
        apiKey: 'test-api-key',
        baseUrl: 'http://localhost',
        graphqlPort: 4000,
        graphqlRootPath: '/',
        entitiesToSend: { excludeSchemas: [], includeEntitiesFromExcludedSchemas: [] },
    }),
    getDbType: () => 'sqlserver',
    resolveSkipApiKey: vi.fn().mockResolvedValue('test-api-key'),
}));

vi.mock('@memberjunction/core', () => ({
    LogStatus: vi.fn(),
    LogError: vi.fn(),
    // The SDK falls back to the static `Metadata.Provider` when no provider is configured.
    Metadata: Object.assign(vi.fn(), { Provider: fakes.provider }),
    BaseEntity: { BaseEventCode: 'BaseEntityEvent' },
    RunView: vi.fn(),
    RunQuery: vi.fn(),
    EntityInfo: class MockEntityInfo {
        constructor(init: object) { Object.assign(this, init); }
    },
}));

vi.mock('@memberjunction/core-entities', () => ({
    QueryEngine: { Instance: { Queries: [], Categories: [], QueryEntities: [], GetQueryFields: () => [], GetQueryParameters: () => [] } },
}));

vi.mock('@memberjunction/ai', () => ({
    GetAIAPIKey: vi.fn().mockReturnValue(''),
}));

vi.mock('@memberjunction/aiengine', () => ({
    AIEngine: { Instance: { Config: vi.fn(), GetAgentByName: vi.fn().mockReturnValue(null) } },
}));

vi.mock('@memberjunction/global', async (importOriginal) => ({
    CopyScalarsAndArrays: <T>(x: T) => x,
    UUIDsEqual: (a: string, b: string) => a === b,
    IsValidUUID: (await importOriginal<typeof import('@memberjunction/global')>()).IsValidUUID,
    MJGlobal: { Instance: { GetEventListener: () => fakes.stream } },
    MJEventType: { ComponentEvent: 'ComponentEvent' },
}));

vi.mock('@memberjunction/server', () => ({
    configInfo: { baseUrl: 'http://localhost', publicUrl: '', graphqlPort: 4000, graphqlRootPath: '/' },
}));

vi.mock('mssql', () => ({}));

import { SkipSDK } from '../../src/skip-sdk.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** What a stubbed build returns: a tag identifying which build produced the payload. */
interface FakeBuiltEntity { builtBy: number }
interface FakeBuildResult { entities: FakeBuiltEntity[]; cacheable: boolean }

/** A source entity, reduced to what `buildEntityForSkip` reads. */
interface FakeField { ScopeDefault: string | null; EntityFieldValues: { Value: string; Code: string }[]; toJSON(): object }
interface FakeSourceEntity { Fields: FakeField[]; OrganicKeys: { Status: string }[]; toJSON(): object }
interface FakeSkipEntity { Name: string; Fields: object[]; OrganicKeys: { Status: string }[] }

/** The private members these tests drive, typed against the fakes above. */
interface EntityCacheInternals {
    buildEntities(forceRefresh: boolean): FakeBuiltEntity[];
    refreshSkipEntities(provider: FakeProvider): FakeBuildResult;
    buildEntityForSkip(e: FakeSourceEntity): FakeSkipEntity | null;
}

/** How many full builds have run, across all instances. */
let buildCount = 0;

/** Whether the next builds report themselves safe to keep. */
let buildsCacheable = true;

function createSdk(): EntityCacheInternals {
    return new SkipSDK({ apiUrl: 'https://test.askskip.ai', apiKey: 'test-key' }) as unknown as EntityCacheInternals;
}

/**
 * One request's worth of entity building with the build stubbed out, reporting which build
 * served it. A fresh instance per call on purpose: the cache is static, so a second instance
 * reusing it is exactly the production behaviour under test.
 */
function request(force: boolean = false): number {
    const sdk = createSdk();
    sdk.refreshSkipEntities = vi.fn().mockImplementation((): FakeBuildResult => ({
        entities: [{ builtBy: ++buildCount }],
        cacheable: buildsCacheable,
    }));
    return sdk.buildEntities(force)[0].builtBy;
}

/** Raises a BaseEntity event on the MJGlobal stream, as BaseEntity does after a save. */
function emitWrite(entityName: string, type: string = 'save'): void {
    fakes.emit({ event: 'ComponentEvent', eventCode: 'BaseEntityEvent', args: { type, entityName } });
}

/** What MJ's provider does when it refreshes: swaps in a whole new AllMetadata. */
function refreshMJMetadata(): void {
    fakes.provider.AllMetadata = {};
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SkipSDK entity cache lifetime', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Dogfoods the public API as the test reset hook — the cache is static, so without this
        // each test would inherit the previous one's warm payload.
        SkipSDK.InvalidateEntitiesCache();
        refreshMJMetadata();
        buildCount = 0;
        buildsCacheable = true;
    });

    it('builds the payload once and reuses it for later requests', () => {
        request();
        request();
        request();

        expect(buildCount).toBe(1);
    });

    it('rebuilds after an explicit invalidation', () => {
        request();
        SkipSDK.InvalidateEntitiesCache();

        expect(request()).toBe(2);
    });

    it('rebuilds when a caller forces a refresh', () => {
        request();

        expect(request(true)).toBe(2);
    });

    it('does not keep a build that is not cacheable, and retries it', () => {
        buildsCacheable = false;
        expect(request()).toBe(1);
        expect(request()).toBe(2);

        buildsCacheable = true;
        expect(request()).toBe(3);
        expect(request()).toBe(3);
    });

    describe('runtime scope changes', () => {
        it('rebuilds after an entity write, but only once MJ has refreshed its metadata', () => {
            request();
            emitWrite('MJ: Entities');

            // MJ refreshes on a debounce after the write. Rebuilding now would read — and
            // cache — the old metadata.
            expect(request()).toBe(1);

            refreshMJMetadata();
            expect(request()).toBe(2);
            expect(request()).toBe(2);
        });

        it('rebuilds after an entity field write', () => {
            request();
            emitWrite('MJ: Entity Fields');
            refreshMJMetadata();

            expect(request()).toBe(2);
        });

        it('rebuilds after a write made on another server', () => {
            request();
            emitWrite('MJ: Entities', 'remote-invalidate');
            refreshMJMetadata();

            expect(request()).toBe(2);
        });

        it('ignores writes to entities that do not affect scope', () => {
            request();
            emitWrite('MJ: Users');
            refreshMJMetadata();

            expect(request()).toBe(1);
        });

        it('does not rebuild when MJ refreshes with no scope write', () => {
            // e.g. a periodic RefreshIfNeeded reload from local storage.
            request();
            refreshMJMetadata();

            expect(request()).toBe(1);
        });

        it("waits for the latest write's refresh when writes straddle a refresh", () => {
            request();
            emitWrite('MJ: Entities');
            refreshMJMetadata();
            emitWrite('MJ: Entities');

            expect(request()).toBe(1);
            refreshMJMetadata();
            expect(request()).toBe(2);
        });
    });
});

describe('SkipSDK entity projection', () => {
    it('keeps only AI-visible fields and active organic keys, passing field values through untouched', () => {
        const fieldValues = [{ Value: 'Open', Code: 'O' }];
        const entity: FakeSourceEntity = {
            toJSON: () => ({ Name: 'Accounts' }),
            Fields: [
                { ScopeDefault: null, EntityFieldValues: fieldValues, toJSON: () => ({ Name: 'Status' }) },
                { ScopeDefault: 'Users', EntityFieldValues: [], toJSON: () => ({ Name: 'Secret' }) },
            ],
            OrganicKeys: [{ Status: 'Active' }, { Status: 'Disabled' }],
        };

        const result = createSdk().buildEntityForSkip(entity);

        expect(result?.Name).toBe('Accounts');
        expect(result?.Fields).toEqual([{ Name: 'Status', EntityFieldValues: fieldValues }]);
        expect(result?.OrganicKeys).toEqual([{ Status: 'Active' }]);
    });
});
