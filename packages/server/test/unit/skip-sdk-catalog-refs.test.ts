/**
 * @fileoverview SkipSDK.chat() sends its catalogs by reference by default, sends them in full when
 * `catalogByReference` is off, and no longer sends query embedding vectors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkipAPIRequest, SkipResponsePhase } from '@askskip/types';

const state = vi.hoisted(() => ({ catalogByReference: true as boolean | undefined }));

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
        catalogByReference: state.catalogByReference,
    }),
    getDbType: () => 'sqlserver',
    resolveSkipApiKey: vi.fn().mockResolvedValue('test-api-key'),
    buildSkipCallbackURL: () => 'http://localhost:4000/',
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
    QueryEngine: { Instance: {
        Queries: [{ ID: 'Q-1', Name: 'Sales', Status: 'Approved', IsApproved: true, CategoryID: 'C-1', QualityRank: 3, SQLDialectID: 'D-1', UsesTemplate: true, CacheEnabled: true, CacheMaxSize: 10, CacheTTLMinutes: 5, CacheValidationSQL: 'SELECT 1', EmbeddingVector: '[0.1,0.2]', EmbeddingModelID: 'M-1', EmbeddingModel: 'gte', GetPlatformSQL: () => 'SELECT 1' }],
        Categories: [], QueryEntities: [], GetQueryFields: () => [], GetQueryParameters: () => [],
    } },
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
        pipe() { return { toPromise: () => Promise.resolve([]) }; }
    }
    return { BehaviorSubject: MockBehaviorSubject };
});
vi.mock('rxjs/operators', () => ({
    take: () => (x: unknown) => x,
}));

import { SkipSDK } from '../../src/skip-sdk.js';
import { SkipCatalogNegotiator } from '../../src/catalog-negotiation.js';

async function sendOneRequest(): Promise<SkipAPIRequest> {
    const sdk = new SkipSDK({ apiUrl: 'https://test.askskip.ai', apiKey: 'test-key' });
    const sendSSERequest = vi.fn().mockResolvedValue([{
        type: 'complete',
        value: { success: true, responsePhase: SkipResponsePhase.analysis_complete, messages: [] },
    }]);
    (sdk as unknown as Record<string, unknown>)['sendSSERequest'] = sendSSERequest;
    await sdk.chat({
        messages: [{ role: 'user' as const, content: 'test', conversationDetailID: 'cd-1' }],
        conversationId: 'conv-1',
        contextUser: { ID: 'user-1', Email: 'test@test.com' } as never,
        dataSource: {} as never,
        includeEntities: false,
    });
    expect(sendSSERequest).toHaveBeenCalledTimes(1);
    return sendSSERequest.mock.calls[0][1] as SkipAPIRequest;
}

describe('SkipSDK catalogs on the wire', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        SkipCatalogNegotiator.Reset();
        state.catalogByReference = true;
    });

    it('sends queries by reference by default', async () => {
        const request = await sendOneRequest();
        expect(request.queries).toEqual([]);
        expect(request.catalogRefs?.queries?.itemCount).toBe(1);
    });

    it('sends the full catalogs when catalogByReference is off', async () => {
        state.catalogByReference = false;
        const request = await sendOneRequest();
        expect(request.catalogRefs).toBeUndefined();
        expect(request.queries.map((q) => q.ID)).toEqual(['Q-1']);
    });

    it('leaves out the query properties Skip never reads, and keeps IsApproved and CategoryID', async () => {
        state.catalogByReference = false;
        const [query] = (await sendOneRequest()).queries as unknown as Record<string, unknown>[];
        for (const dropped of ['EmbeddingVector', 'EmbeddingModelID', 'EmbeddingModelName', 'QualityRank', 'SQLDialectID',
            'UsesTemplate', 'CacheEnabled', 'CacheMaxSize', 'CacheTTLMinutes', 'CacheValidationSQL']) {
            expect(dropped in query, dropped).toBe(false);
        }
        expect(query.IsApproved).toBe(true);
        expect(query.CategoryID).toBe('C-1');
    });
});
