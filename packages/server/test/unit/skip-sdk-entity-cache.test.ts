/**
 * @fileoverview Unit tests for the lifetime of SkipSDK's entity-metadata cache.
 *
 * The payload is expensive to build — `buildEntityForSkip` reconstructs the whole metadata
 * graph and `packFieldValues` runs a SELECT DISTINCT per eligible field — so it is memoised for
 * the life of the process rather than expiring on a clock. These tests pin that: repeat traffic
 * must not rebuild, and the only ways to rebuild are an explicit invalidation or a per-call
 * force.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkipResponsePhase } from '@askskip/types';

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
    Metadata: vi.fn().mockImplementation(() => ({
        Entities: [],
        Provider: { Entities: [] },
    })),
    RunView: vi.fn().mockImplementation(() => ({
        RunView: vi.fn().mockResolvedValue({ Success: true, Results: [] }),
    })),
    RunQuery: vi.fn().mockImplementation(() => ({
        RunQuery: vi.fn().mockResolvedValue({ Success: true, Results: [] }),
    })),
    EntityInfo: vi.fn(),
    EntityFieldInfo: vi.fn(),
    EntityFieldValueInfo: vi.fn(),
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
    CopyScalarsAndArrays: (x: unknown) => x,
    UUIDsEqual: (a: string, b: string) => a === b,
    IsValidUUID: (await importOriginal<typeof import('@memberjunction/global')>()).IsValidUUID,
}));

vi.mock('@memberjunction/server', () => ({
    configInfo: { baseUrl: 'http://localhost', publicUrl: '', graphqlPort: 4000, graphqlRootPath: '/' },
}));

vi.mock('mssql', () => ({}));
vi.mock('rxjs', () => {
    class MockBehaviorSubject {
        value: unknown;
        constructor(initial: unknown) { this.value = initial; }
        next(val: unknown) { this.value = val; }
    }
    return { BehaviorSubject: MockBehaviorSubject };
});

import { SkipSDK } from '../../src/skip-sdk.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Tracks how many times a full entity build was performed across all instances. */
let buildCount = 0;

/**
 * Sends one chat call with the expensive build stubbed out and counted.
 *
 * A fresh SkipSDK per call on purpose: the cache is static, so a second instance reusing it is
 * exactly the production behaviour under test.
 */
async function sendOneRequest(options: { forceEntityRefresh?: boolean } = {}): Promise<void> {
    const sdk = new SkipSDK({ apiUrl: 'https://test.askskip.ai', apiKey: 'test-key' });
    const internals = sdk as unknown as Record<string, unknown>;

    internals['refreshSkipEntities'] = vi.fn().mockImplementation(async () => {
        buildCount++;
        return [];
    });
    internals['sendSSERequest'] = vi.fn().mockResolvedValue([{
        type: 'complete',
        value: { success: true, responsePhase: SkipResponsePhase.analysis_complete, messages: [] },
    }]);

    await sdk.chat({
        messages: [{ role: 'user' as const, content: 'test', conversationDetailID: 'cd-1' }],
        conversationId: 'conv-1',
        contextUser: { ID: 'user-1', Email: 'test@test.com' } as never,
        dataSource: {} as never,
        ...options,
    } as never);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SkipSDK entity cache lifetime', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Dogfoods the public API as the test reset hook — the cache is static, so without this
        // each test would inherit the previous one's warm payload.
        SkipSDK.InvalidateEntitiesCache();
        buildCount = 0;
    });

    it('builds the payload once and reuses it for later requests', async () => {
        await sendOneRequest();
        expect(buildCount).toBe(1);

        await sendOneRequest();
        await sendOneRequest();

        // The point of removing the 15-minute expiry: repeat traffic is free.
        expect(buildCount).toBe(1);
    });

    it('rebuilds after an explicit invalidation', async () => {
        await sendOneRequest();
        expect(buildCount).toBe(1);

        SkipSDK.InvalidateEntitiesCache();
        await sendOneRequest();

        expect(buildCount).toBe(2);
    });

    it('rebuilds when a caller forces a refresh', async () => {
        await sendOneRequest();
        expect(buildCount).toBe(1);

        await sendOneRequest({ forceEntityRefresh: true });

        expect(buildCount).toBe(2);
    });
});
