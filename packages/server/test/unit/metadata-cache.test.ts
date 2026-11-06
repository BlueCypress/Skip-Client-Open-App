/**
 * @fileoverview Unit tests for the content-addressed Metadata Cache protocol
 * (`metadata-canonicalizer.ts` and `SkipSDK` metadata cache negotiation, miss-and-resend,
 * double-miss fallback, and `canon` section support).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    SkipAPIRequest,
    SkipErrorCode,
    SkipResponsePhase,
    SkipRetryAction,
    SkipServerCapability,
} from '@askskip/types';

// ── Fakes & Mocks ───────────────────────────────────────────────────────────

const fakeCanonState = vi.hoisted(() => ({
    concepts: [] as Array<Record<string, unknown>>,
    edges: [] as Array<Record<string, unknown>>,
    renderedMarkdown: '',
}));

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
    buildSkipCallbackURL: () => 'http://localhost:4000/',
    fetchSkipRegistryName: vi.fn().mockResolvedValue('Skip'),
}));

vi.mock('@memberjunction/core', () => ({
    LogStatus: vi.fn(),
    LogError: vi.fn(),
    BaseEntity: { BaseEventCode: 'BaseEntityEvent' },
    Metadata: Object.assign(
        vi.fn().mockImplementation(() => ({
            Entities: [],
            Provider: { Entities: [] },
        })),
        {
            Provider: {
                Entities: [
                    {
                        ID: 'ENT-2',
                        Name: 'Invoices',
                        SchemaName: 'dbo',
                        ScopeDefault: 'all',
                        Fields: [
                            { ID: 'FLD-2', Name: 'Total', Sequence: 2, ScopeDefault: 'all', EntityFieldValues: [], toJSON: () => ({ ID: 'FLD-2', Name: 'Total', Sequence: 2 }) },
                            { ID: 'FLD-1', Name: 'ID', Sequence: 1, ScopeDefault: 'all', EntityFieldValues: [], toJSON: () => ({ ID: 'FLD-1', Name: 'ID', Sequence: 1 }) },
                        ],
                        OrganicKeys: [],
                        toJSON: () => ({ ID: 'ENT-2', Name: 'Invoices', SchemaName: 'dbo' }),
                    },
                    {
                        ID: 'ENT-1',
                        Name: 'Members',
                        SchemaName: 'dbo',
                        ScopeDefault: 'all',
                        Fields: [
                            { ID: 'FLD-10', Name: 'Email', Sequence: 1, ScopeDefault: 'all', EntityFieldValues: [], toJSON: () => ({ ID: 'FLD-10', Name: 'Email', Sequence: 1 }) },
                        ],
                        OrganicKeys: [],
                        toJSON: () => ({ ID: 'ENT-1', Name: 'Members', SchemaName: 'dbo' }),
                    },
                ],
                AllMetadata: {},
            },
        },
    ),
    RunView: vi.fn().mockImplementation(() => ({
        RunView: vi.fn().mockResolvedValue({ Success: true, Results: [] }),
    })),
    RunQuery: vi.fn().mockImplementation(() => ({
        RunQuery: vi.fn().mockResolvedValue({ Success: true, Results: [] }),
    })),
    EntityInfo: class MockEntityInfo {
        constructor(init: object) {
            Object.assign(this, init);
        }
        toJSON(): object {
            return { ...this };
        }
    },
}));

vi.mock('@memberjunction/core-entities', () => ({
    QueryEngine: {
        Instance: {
            Queries: [
                {
                    ID: 'Q-1',
                    Name: 'ActiveMembers',
                    Description: 'Active members',
                    Category: 'Membership',
                    CategoryID: 'CAT-1',
                    Status: 'Approved',
                    GetPlatformSQL: () => 'SELECT * FROM vwActiveMembers',
                },
            ],
            Categories: [{ ID: 'CAT-1', Name: 'Membership', ParentID: null }],
            QueryEntities: [],
            GetQueryFields: () => [],
            GetQueryParameters: () => [],
        },
    },
    CanonGraphEngine: {
        Instance: {
            Config: vi.fn().mockResolvedValue(undefined),
            get Concepts() {
                return fakeCanonState.concepts;
            },
            get ApprovedCanonEdges() {
                return fakeCanonState.edges;
            },
            Scopes: [{ ID: 'SCOPE-1', Name: 'MJ Canon' }],
            GetAliasesForConcept: () => [{ Alias: 'Active Member' }],
            RenderCanonDocument: vi.fn().mockImplementation(async () => ({
                Markdown: fakeCanonState.renderedMarkdown,
            })),
        },
    },
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
    MJGlobal: {
        Instance: {
            GetEventListener: () => ({
                subscribe: () => ({ unsubscribe: () => {} }),
            }),
        },
    },
    MJEventType: { ComponentEvent: 'ComponentEvent' },
}));

vi.mock('@memberjunction/server', () => ({
    configInfo: { baseUrl: 'http://localhost', publicUrl: '', graphqlPort: 4000, graphqlRootPath: '/' },
}));

vi.mock('mssql', () => ({}));

import {
    canonicalizeMetadataSection,
    computeMetadataSectionHash,
    METADATA_CACHE_FORMAT_VERSION,
    recordBrainCapabilities,
    brainSupportsMetadataCache,
    clearBrainCapabilities,
} from '../../src/metadata-canonicalizer.js';
import { SkipSDK } from '../../src/skip-sdk.js';

describe('metadata-canonicalizer', () => {
    it('produces identical canonicalJson and SHA-256 hash when entities and fields are shuffled', () => {
        const entitiesOrderA = [
            {
                ID: 'BBB-222',
                Name: 'Orders',
                Fields: [
                    { ID: 'F-2', Sequence: 2, Name: 'Total', EntityFieldValues: [{ ID: 'V-2', Value: 'Paid' }, { ID: 'V-1', Value: 'Draft' }] },
                    { ID: 'F-1', Sequence: 1, Name: 'ID', EntityFieldValues: [] },
                ],
                RelatedEntities: [{ ID: 'REL-2' }, { ID: 'REL-1' }],
                OrganicKeys: [{ ID: 'OK-2' }, { ID: 'OK-1' }],
            },
            {
                Name: 'Accounts',
                ID: 'AAA-111',
                Fields: [{ Name: 'ID', Sequence: 1, ID: 'F-0' }],
                RelatedEntities: [],
                OrganicKeys: [],
            },
        ];

        const entitiesOrderB = [
            {
                ID: 'aaa-111', // same ID, different object order
                Name: 'Accounts',
                OrganicKeys: [],
                RelatedEntities: [],
                Fields: [{ ID: 'F-0', Sequence: 1, Name: 'ID' }],
            },
            {
                Name: 'Orders',
                ID: 'BBB-222',
                OrganicKeys: [{ ID: 'OK-1' }, { ID: 'OK-2' }],
                RelatedEntities: [{ ID: 'REL-1' }, { ID: 'REL-2' }],
                Fields: [
                    { Name: 'ID', ID: 'F-1', Sequence: 1, EntityFieldValues: [] },
                    { EntityFieldValues: [{ Value: 'Draft', ID: 'V-1' }, { Value: 'Paid', ID: 'V-2' }], Name: 'Total', Sequence: 2, ID: 'F-2' },
                ],
            },
        ];

        // Keep casing identical for IDs to verify ordering + key order invariance
        entitiesOrderB[0].ID = 'AAA-111';

        const canonA = canonicalizeMetadataSection('entities', entitiesOrderA);
        const canonB = canonicalizeMetadataSection('entities', entitiesOrderB);

        expect(canonA.canonicalJson).toBe(canonB.canonicalJson);
        expect(canonA.ref.hash).toBe(canonB.ref.hash);
        expect(canonA.ref.itemCount).toBe(2);
        expect(canonA.ref.formatVersion).toBe(METADATA_CACHE_FORMAT_VERSION);
        expect(canonA.ref. hash).toBe(computeMetadataSectionHash(canonA.canonicalJson, METADATA_CACHE_FORMAT_VERSION));
    });

    it('canonicalizes canon concepts by precedenceRank descending then id', () => {
        const canonA = canonicalizeMetadataSection('canon', {
            concepts: [
                { id: 'c-low', name: 'Low', conceptType: 'Metric', scopeName: 'MJ Canon', precedenceRank: 10, aliases: ['B', 'A'] },
                { id: 'c-high', name: 'High', conceptType: 'Definition', scopeName: 'MJ Canon', precedenceRank: 100, aliases: ['Z'] },
            ],
            edges: [
                { id: 'e-2', edgeType: 'SUPERSEDES', sourceEntity: 'A', sourceRecordID: '1', targetEntity: 'B', targetRecordID: '2' },
                { id: 'e-1', edgeType: 'DEFINES', sourceEntity: 'C', sourceRecordID: '3', targetEntity: 'D', targetRecordID: '4' },
            ],
            renderedDocument: '# MJ Canon\nRule 1',
        });

        const canonB = canonicalizeMetadataSection('canon', {
            renderedDocument: '# MJ Canon\nRule 1',
            edges: [
                { targetRecordID: '4', targetEntity: 'D', sourceRecordID: '3', sourceEntity: 'C', edgeType: 'DEFINES', id: 'e-1' },
                { id: 'e-2', edgeType: 'SUPERSEDES', sourceEntity: 'A', sourceRecordID: '1', targetEntity: 'B', targetRecordID: '2' },
            ],
            concepts: [
                { precedenceRank: 100, scopeName: 'MJ Canon', conceptType: 'Definition', name: 'High', id: 'c-high', aliases: ['Z'] },
                { id: 'c-low', name: 'Low', conceptType: 'Metric', scopeName: 'MJ Canon', precedenceRank: 10, aliases: ['A', 'B'] },
            ],
        });

        expect(canonA.canonicalJson).toBe(canonB.canonicalJson);
        expect(canonA.ref.hash).toBe(canonB.ref.hash);
        expect(canonA.ref.itemCount).toBe(4); // 2 concepts + 2 edges
    });
});

describe('SkipSDK metadata cache protocol', () => {
    const apiUrl = 'https://test.askskip.ai';

    beforeEach(() => {
        vi.clearAllMocks();
        clearBrainCapabilities();
        SkipSDK.InvalidateEntitiesCache();
        SkipSDK.InvalidateQueriesCache();
        SkipSDK.InvalidateCanonCache();
        fakeCanonState.concepts = [
            {
                ID: 'CONCEPT-1',
                Name: 'ActiveMember',
                DisplayName: 'Active Member',
                ConceptType: 'Definition',
                ScopeID: 'SCOPE-1',
                PrecedenceRank: 100,
                Definition: 'Member with Status = Active',
                GroundingEntityID: 'ENT-1',
            },
        ];
        fakeCanonState.edges = [
            {
                ID: 'EDGE-1',
                EdgeType: 'HAS_ALTERNATE_VIEW',
                SourceEntity: 'MJ: Entities',
                SourceRecordID: 'ENT-1',
                TargetEntity: 'MJ: Entities',
                TargetRecordID: 'ENT-1',
                Weight: 1,
                MetadataJSON: JSON.stringify({ viewName: 'vwActiveMembers' }),
            },
        ];
        fakeCanonState.renderedMarkdown = '# MJ Canon — Domain Knowledge Summary';
    });

    it('sends legacy inline metadata when Brain has not advertised metadataCache capability', async () => {
        const sdk = new SkipSDK({ apiUrl, apiKey: 'test-key' });
        const sendSSERequest = vi.fn().mockResolvedValue([
            {
                type: 'complete',
                value: {
                    success: true,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                    serverCapabilities: [SkipServerCapability.MetadataCache],
                },
            },
        ]);
        (sdk as unknown as Record<string, unknown>)['sendSSERequest'] = sendSSERequest;

        await sdk.chat({
            messages: [{ role: 'user', content: 'Hello', conversationDetailID: 'cd-1' }],
            conversationId: 'conv-1',
            contextUser: { ID: 'user-1', Email: 'user@example.com' } as never,
            dataSource: {} as never,
        });

        expect(sendSSERequest).toHaveBeenCalledTimes(1);
        const firstReq = sendSSERequest.mock.calls[0][1] as SkipAPIRequest;
        expect(firstReq.metadataRefs).toBeUndefined();
        expect(firstReq.entities.length).toBe(2);
        expect(firstReq.queries.length).toBe(1);
        expect(firstReq.canon?.concepts.length).toBe(1);

        // Because the response advertised serverCapabilities: ['metadataCache'],
        // the capability is now recorded for the next request!
        expect(brainSupportsMetadataCache(apiUrl)).toBe(true);
    });

    it('sends metadataRefs and omits inline catalog arrays when Brain supports metadataCache', async () => {
        recordBrainCapabilities(apiUrl, [SkipServerCapability.MetadataCache]);

        const sdk = new SkipSDK({ apiUrl, apiKey: 'test-key' });
        const sendSSERequest = vi.fn().mockResolvedValue([
            {
                type: 'complete',
                value: {
                    success: true,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                },
            },
        ]);
        (sdk as unknown as Record<string, unknown>)['sendSSERequest'] = sendSSERequest;

        const result = await sdk.chat({
            messages: [{ role: 'user', content: 'How many active members?', conversationDetailID: 'cd-1' }],
            conversationId: 'conv-1',
            contextUser: { ID: 'user-1', Email: 'user@example.com' } as never,
            dataSource: {} as never,
        });

        expect(result.success).toBe(true);
        expect(sendSSERequest).toHaveBeenCalledTimes(1);
        const sentReq = sendSSERequest.mock.calls[0][1] as SkipAPIRequest;

        expect(sentReq.entities).toEqual([]);
        expect(sentReq.queries).toEqual([]);
        expect(sentReq.queryCatalog).toBeUndefined();
        expect(sentReq.canon).toBeUndefined();
        expect(sentReq.metadataContent).toBeUndefined();

        expect(sentReq.metadataRefs).toBeDefined();
        expect(sentReq.metadataRefs?.entities?.itemCount).toBe(2);
        expect(sentReq.metadataRefs?.queries?.itemCount).toBe(1);
        expect(sentReq.metadataRefs?.queryCatalog?.itemCount).toBe(1);
        expect(sentReq.metadataRefs?.canon?.itemCount).toBe(2); // 1 concept + 1 edge
    });

    it('retries once with only missingSections in metadataContent on metadata_cache_miss', async () => {
        recordBrainCapabilities(apiUrl, [SkipServerCapability.MetadataCache]);

        const sdk = new SkipSDK({ apiUrl, apiKey: 'test-key' });
        const sendSSERequest = vi
            .fn()
            .mockResolvedValueOnce([
                {
                    type: 'complete',
                    value: {
                        success: false,
                        responsePhase: SkipResponsePhase.analysis_complete,
                        messages: [],
                        errorDetail: {
                            type: 'validation',
                            code: SkipErrorCode.metadata_cache_miss,
                            message: 'Missing metadata sections: entities, canon',
                            retryable: true,
                            retryAction: SkipRetryAction.resend_with_metadata,
                            missingSections: ['entities', 'canon'],
                        },
                    },
                },
            ])
            .mockResolvedValueOnce([
                {
                    type: 'complete',
                    value: {
                        success: true,
                        responsePhase: SkipResponsePhase.analysis_complete,
                        messages: [{ role: 'assistant', content: '42 active members' }],
                    },
                },
            ]);
        (sdk as unknown as Record<string, unknown>)['sendSSERequest'] = sendSSERequest;

        const result = await sdk.chat({
            messages: [{ role: 'user', content: 'How many active members?', conversationDetailID: 'cd-1' }],
            conversationId: 'conv-1',
            contextUser: { ID: 'user-1', Email: 'user@example.com' } as never,
            dataSource: {} as never,
        });

        expect(result.success).toBe(true);
        expect(sendSSERequest).toHaveBeenCalledTimes(2);

        const retryReq = sendSSERequest.mock.calls[1][1] as SkipAPIRequest;
        expect(retryReq.metadataRefs).toBeDefined();
        expect(retryReq.metadataContent).toBeDefined();
        expect(Object.keys(retryReq.metadataContent!).sort()).toEqual(['canon', 'entities']);
        expect(retryReq.metadataContent?.queries).toBeUndefined();
    });

    it('falls back to full inline legacy metadata payload if a second metadata_cache_miss occurs', async () => {
        recordBrainCapabilities(apiUrl, [SkipServerCapability.MetadataCache]);

        const sdk = new SkipSDK({ apiUrl, apiKey: 'test-key' });
        const missResponse = [
            {
                type: 'complete',
                value: {
                    success: false,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                    errorDetail: {
                        type: 'validation_error',
                        code: SkipErrorCode.metadata_cache_miss,
                        message: 'Missing metadata sections: entities',
                        retryable: true,
                        retryAction: SkipRetryAction.resend_with_metadata,
                        missingSections: ['entities'],
                    },
                },
            },
        ];

        const sendSSERequest = vi
            .fn()
            .mockResolvedValueOnce(missResponse)
            .mockResolvedValueOnce(missResponse)
            .mockResolvedValueOnce([
                {
                    type: 'complete',
                    value: {
                        success: true,
                        responsePhase: SkipResponsePhase.analysis_complete,
                        messages: [{ role: 'assistant', content: 'Recovered via legacy payload' }],
                    },
                },
            ]);
        (sdk as unknown as Record<string, unknown>)['sendSSERequest'] = sendSSERequest;

        const result = await sdk.chat({
            messages: [{ role: 'user', content: 'Test double miss fallback', conversationDetailID: 'cd-1' }],
            conversationId: 'conv-1',
            contextUser: { ID: 'user-1', Email: 'user@example.com' } as never,
            dataSource: {} as never,
        });

        expect(result.success).toBe(true);
        expect(sendSSERequest).toHaveBeenCalledTimes(3);

        const fallbackReq = sendSSERequest.mock.calls[2][1] as SkipAPIRequest;
        expect(fallbackReq.metadataRefs).toBeUndefined();
        expect(fallbackReq.metadataContent).toBeUndefined();
        expect(fallbackReq.entities.length).toBe(2);
        expect(fallbackReq.queries.length).toBe(1);
        expect(fallbackReq.canon?.concepts.length).toBe(1);
    });
});
