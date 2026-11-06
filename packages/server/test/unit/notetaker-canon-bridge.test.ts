/**
 * @fileoverview Unit tests for the Notetaker → `"MJ Canon"` Bridge (`notetaker-canon-bridge.ts`)
 * and `SkipSDK` agent note building, Canon enrichment, and `MJ: AI Agent Notes` cache invalidation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IMetadataProvider, UserInfo } from '@memberjunction/core';
import {
    SkipAPIAgentNote,
    SkipAPIRequest,
    SkipResponsePhase,
    SkipServerCapability,
} from '@askskip/types';

// ── Fakes & Mocks ───────────────────────────────────────────────────────────

const fakeAIState = vi.hoisted(() => ({
    agentNotes: [] as Array<Record<string, unknown>>,
    agentNoteTypes: [] as Array<Record<string, unknown>>,
    eventSubscribers: [] as Array<(event: unknown) => void>,
}));

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
                        ID: 'ENT-INV',
                        Name: 'Invoice',
                        SchemaName: 'crm',
                        BaseView: 'vwRecognizedInvoices',
                        BaseTable: 'Invoice',
                        ScopeDefault: 'all',
                        Fields: [],
                        OrganicKeys: [],
                        toJSON: () => ({ ID: 'ENT-INV', Name: 'Invoice', SchemaName: 'crm', BaseView: 'vwRecognizedInvoices' }),
                    },
                    {
                        ID: 'ENT-STG',
                        Name: 'Invoice_Staging',
                        SchemaName: 'crm',
                        BaseView: 'vwInvoice_Staging',
                        BaseTable: 'Invoice_Staging',
                        ScopeDefault: 'all',
                        Fields: [],
                        OrganicKeys: [],
                        toJSON: () => ({ ID: 'ENT-STG', Name: 'Invoice_Staging', SchemaName: 'crm' }),
                    },
                    {
                        ID: 'ENT-ACC',
                        Name: 'Account',
                        SchemaName: 'crm',
                        BaseView: 'vwAccounts',
                        BaseTable: 'Account',
                        ScopeDefault: 'all',
                        Fields: [],
                        OrganicKeys: [],
                        toJSON: () => ({ ID: 'ENT-ACC', Name: 'Account', SchemaName: 'crm' }),
                    },
                    {
                        ID: 'ENT-LEG',
                        Name: 'Legacy_Account_2022',
                        SchemaName: 'crm',
                        BaseView: 'vwLegacy_Account_2022',
                        BaseTable: 'Legacy_Account_2022',
                        ScopeDefault: 'all',
                        Fields: [],
                        OrganicKeys: [],
                        toJSON: () => ({ ID: 'ENT-LEG', Name: 'Legacy_Account_2022', SchemaName: 'crm' }),
                    },
                ],
                AllMetadata: {},
            },
        },
    ),
    RunView: vi.fn().mockImplementation(() => ({
        RunView: vi.fn().mockResolvedValue({ Success: true, Results: [] }),
        RunViews: vi.fn().mockResolvedValue([]),
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
                    ID: 'Q-REV-SEG',
                    Name: 'RecognizedRevenueBySegment',
                    Description: 'Official recognized revenue by segment',
                    Category: 'Finance',
                    CategoryID: 'CAT-FIN',
                    Status: 'Approved',
                    GetPlatformSQL: () => 'SELECT Segment, SUM(TotalAmount) FROM crm.vwRecognizedInvoices GROUP BY Segment',
                },
            ],
            Categories: [{ ID: 'CAT-FIN', Name: 'Finance', ParentID: null }],
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
            GetAliasesForConcept: () => [],
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
    AIEngine: {
        Instance: {
            Config: vi.fn().mockResolvedValue(undefined),
            GetAgentByName: vi.fn().mockReturnValue({ ID: 'SKIP-AGENT-ID', Name: 'Skip' }),
            get AgentNotes() {
                return fakeAIState.agentNotes;
            },
            get AgentNoteTypes() {
                return fakeAIState.agentNoteTypes;
            },
        },
    },
}));

vi.mock('@memberjunction/global', async (importOriginal) => ({
    CopyScalarsAndArrays: <T>(x: T) => x,
    UUIDsEqual: (a: string, b: string) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase(),
    IsValidUUID: (await importOriginal<typeof import('@memberjunction/global')>()).IsValidUUID,
    MJGlobal: {
        Instance: {
            GetEventListener: () => ({
                subscribe: (cb: (event: unknown) => void) => {
                    fakeAIState.eventSubscribers.push(cb);
                    return { unsubscribe: () => {} };
                },
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
    classifyNoteForCanon,
    enrichCanonWithAgentNotes,
    parseMarkdownNotesToCanon,
    promoteNoteToCanon,
    type NoteCanonCatalogContext,
} from '../../src/notetaker-canon-bridge.js';
import {
    clearBrainCapabilities,
    recordBrainCapabilities,
} from '../../src/metadata-canonicalizer.js';
import { SkipSDK } from '../../src/skip-sdk.js';

const CATALOG: NoteCanonCatalogContext = {
    entities: [
        { ID: 'ENT-INV', Name: 'Invoice', SchemaName: 'crm', BaseView: 'vwRecognizedInvoices', BaseTable: 'Invoice' },
        { ID: 'ENT-STG', Name: 'Invoice_Staging', SchemaName: 'crm', BaseView: 'vwInvoice_Staging', BaseTable: 'Invoice_Staging' },
        { ID: 'ENT-ACC', Name: 'Account', SchemaName: 'crm', BaseView: 'vwAccounts', BaseTable: 'Account' },
        { ID: 'ENT-LEG', Name: 'Legacy_Account_2022', SchemaName: 'crm', BaseView: 'vwLegacy_Account_2022', BaseTable: 'Legacy_Account_2022' },
    ],
    queries: [
        { ID: 'Q-REV-SEG', Name: 'RecognizedRevenueBySegment', CategoryPath: 'Finance' },
    ],
};

function makeNote(overrides: Partial<SkipAPIAgentNote>): SkipAPIAgentNote {
    return {
        id: overrides.id ?? 'NOTE-111',
        agentNoteTypeId: overrides.agentNoteTypeId ?? 'TYPE-PREF',
        agentNoteType: overrides.agentNoteType ?? 'Preference',
        createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
        note: overrides.note ?? '',
        type: overrides.type ?? 'Global',
        userId: overrides.userId ?? null,
        user: overrides.user ?? null,
    };
}

describe('SkipNotetakerCanonBridge — classifyNoteForCanon', () => {
    it('classifies a metric & policy threshold note as canon_candidate with Metric concept and SourcedFrom edge', () => {
        const note = makeNote({
            id: 'NOTE-CFO-1',
            note: 'Board At-Risk Revenue Threshold: Any segment where At-Risk Revenue exceeds 25% of Net Recognized Revenue is flagged RED. Never include Draft or Void invoices.',
        });

        const result = classifyNoteForCanon(note, CATALOG);
        expect(result.disposition).toBe('canon_candidate');
        expect(result.extraction?.concept).toBeDefined();
        expect(result.extraction?.concept?.conceptType).toBe('Metric');
        expect(result.extraction?.concept?.name).toBe('Board At-Risk Revenue Threshold');
        expect(result.extraction?.concept?.antiDefinition).toContain('Draft or Void invoices');
        expect(result.extraction?.concept?.precedenceRank).toBe(95);

        const sourcedFrom = result.extraction?.edges.find((e) => e.edgeType === 'SourcedFrom');
        expect(sourcedFrom).toBeDefined();
        expect(sourcedFrom?.sourceEntityName).toBe('MJ: Graph Concepts');
        expect(sourcedFrom?.targetEntityName).toBe('MJ: AI Agent Notes');
        expect(sourcedFrom?.targetRecordID).toBe('NOTE-CFO-1');
        expect(sourcedFrom?.origin).toBe('Notetaker');
    });

    it('classifies a cohort/segment note as canon_candidate with Segment concept', () => {
        const note = makeNote({
            id: 'NOTE-SEG-1',
            note: "Expansion Ready Account: Active Account on crm.vwAccounts with HealthScore >= 85 and SupportRiskTier = 'Low'.",
        });

        const result = classifyNoteForCanon(note, CATALOG);
        expect(result.disposition).toBe('canon_candidate');
        expect(result.extraction?.concept?.conceptType).toBe('Segment');
        expect(result.extraction?.concept?.name).toBe('Expansion Ready Account');
        expect(result.extraction?.concept?.ownerEntityName).toBe('Account');
    });

    it('extracts Preferred Over and Measures edges and resolves entity/query IDs from the catalog', () => {
        const note = makeNote({
            id: 'NOTE-GOV-1',
            note: 'Net Recognized Revenue: Always use crm.vwRecognizedInvoices instead of crm.Invoice_Staging. Never use crm.Legacy_Account_2022; prefer Account. Stored query RecognizedRevenueBySegment measures Net Recognized Revenue.',
        });

        const result = classifyNoteForCanon(note, CATALOG);
        expect(result.disposition).toBe('canon_candidate');
        const edges = result.extraction?.edges ?? [];

        const prefEdges = edges.filter((e) => e.edgeType === 'Preferred Over');
        expect(prefEdges).toHaveLength(2);
        expect(prefEdges[0]).toMatchObject({
            sourceEntityName: 'MJ: Entities',
            sourceRecordID: 'ENT-INV',
            targetEntityName: 'MJ: Entities',
            targetRecordID: 'ENT-STG',
            origin: 'Notetaker',
        });
        expect(prefEdges[1]).toMatchObject({
            sourceEntityName: 'MJ: Entities',
            sourceRecordID: 'ENT-ACC',
            targetEntityName: 'MJ: Entities',
            targetRecordID: 'ENT-LEG',
            origin: 'Notetaker',
        });

        const measuresEdge = edges.find((e) => e.edgeType === 'Measures');
        expect(measuresEdge).toBeDefined();
        expect(measuresEdge?.sourceEntityName).toBe('MJ: Queries');
        expect(measuresEdge?.sourceRecordID).toBe('Q-REV-SEG');
        expect(measuresEdge?.targetEntityName).toBe('MJ: Graph Concepts');
    });

    it('classifies purely tactical formatting notes as tactical_only', () => {
        const note = makeNote({
            id: 'NOTE-UI-1',
            note: 'Always format executive tables with bold headers and assign action items to Elena Rostova.',
        });

        const result = classifyNoteForCanon(note, CATALOG);
        expect(result.disposition).toBe('tactical_only');
        expect(result.extraction).toBeUndefined();
    });
});

describe('SkipNotetakerCanonBridge — enrichCanonWithAgentNotes & parseMarkdownNotesToCanon', () => {
    it('enriches existing SkipCanonMetadata without overwriting governed concepts of the same name', () => {
        const baseCanon = {
            concepts: [
                {
                    id: 'GOV-1',
                    name: 'Net Recognized Revenue',
                    displayName: 'Net Recognized Revenue',
                    conceptType: 'Metric',
                    status: 'Active',
                    definition: 'Official governed definition',
                    precedenceRank: 100,
                },
            ],
            edges: [],
            domainDocument: '# MJ Canon — Domain Knowledge Summary',
        };

        const notes = [
            makeNote({
                id: 'NOTE-DUP',
                note: 'Net Recognized Revenue: SUM(TotalAmount) from Recognized invoices.',
            }),
            makeNote({
                id: 'NOTE-NEW',
                note: 'Board At-Risk Revenue Threshold: 25% of Net Recognized Revenue. Always use crm.vwRecognizedInvoices instead of crm.Invoice_Staging.',
            }),
            makeNote({
                id: 'NOTE-TACTICAL',
                note: 'Use dark blue bars in executive charts.',
            }),
        ];

        const enriched = enrichCanonWithAgentNotes(baseCanon, notes, CATALOG);
        expect(enriched).toBeDefined();
        // Net Recognized Revenue stays the governed concept (GOV-1), and Board At-Risk Revenue Threshold is added
        expect(enriched!.concepts).toHaveLength(2);
        expect(enriched!.concepts[0].id).toBe('GOV-1');
        expect(enriched!.concepts[1].name).toBe('Board At-Risk Revenue Threshold');

        // Preferred Over edge + SourcedFrom edges added
        expect(enriched!.edges.some((e) => e.edgeType === 'Preferred Over' && e.sourceRecordID === 'ENT-INV')).toBe(true);
        expect(enriched!.edges.some((e) => e.edgeType === 'SourcedFrom' && e.targetRecordID === 'NOTE-NEW')).toBe(true);

        // Domain document includes the Notetaker-Derived Canon Rules section
        expect(enriched!.domainDocument).toContain('## Notetaker-Derived Canon Rules (MJ: AI Agent Notes)');
        expect(enriched!.domainDocument).toContain('Board At-Risk Revenue Threshold');
        expect(enriched!.domainDocument).not.toContain('dark blue bars');
    });

    it('parses legacy Markdown note files (headings + request-pattern tables) into Canon candidates', () => {
        const markdown = `
# Data Expert Notes

## Revenue & Invoicing Rules
Net Recognized Revenue is SUM(TotalAmount) where Status = 'Recognized'. Never include Draft or Void invoices.

| Request Pattern | Preferred Table/View | Avoid | Rationale |
| --- | --- | --- | --- |
| Recognized Revenue | crm.vwRecognizedInvoices | crm.Invoice_Staging | Staging includes unverified webhook payloads |
| Customer Accounts | Account | crm.Legacy_Account_2022 | Legacy snapshot from 2022 ERP migration |
`;

        const extractions = parseMarkdownNotesToCanon(markdown, {
            sourceName: 'Demo_DataExpert.md',
            catalog: CATALOG,
        });

        expect(extractions.length).toBeGreaterThanOrEqual(1);
        const first = extractions[0];
        expect(first.concept?.conceptType).toBe('Metric');
        const prefEdges = first.edges.filter((e) => e.edgeType === 'Preferred Over');
        expect(prefEdges.length).toBeGreaterThanOrEqual(2);
        expect(prefEdges.some((e) => e.sourceRecordID === 'ENT-INV' && e.targetRecordID === 'ENT-STG')).toBe(true);
        expect(prefEdges.some((e) => e.sourceRecordID === 'ENT-ACC' && e.targetRecordID === 'ENT-LEG')).toBe(true);
    });

    it('persists promoted note concepts and SourcedFrom edges via promoteNoteToCanon', async () => {
        const savedRecords: Array<{ entityName: string; record: Record<string, unknown> }> = [];
        let idCounter = 1;
        const mockProvider = {
            GetEntityObject: vi.fn().mockImplementation(async (entityName: string) => {
                const record: Record<string, unknown> = {
                    ID: `SAVED-${idCounter++}`,
                    NewRecord: vi.fn(),
                    Save: vi.fn().mockResolvedValue(true),
                };
                savedRecords.push({ entityName, record });
                return record;
            }),
        } as unknown as IMetadataProvider;

        const invalidated = vi.fn();
        const note = makeNote({
            id: 'NOTE-PROMOTE-1',
            note: 'Board At-Risk Revenue Threshold: 25% of Net Recognized Revenue. Always use crm.vwRecognizedInvoices instead of crm.Invoice_Staging.',
        });

        const result = await promoteNoteToCanon(note, mockProvider, { ID: 'U-1' } as unknown as UserInfo, {
            graphId: 'GRAPH-CANON-1',
            catalog: CATALOG,
            onInvalidateCache: invalidated,
        });

        expect(result.promoted).toBe(true);
        expect(result.disposition).toBe('canon_candidate');
        expect(result.conceptId).toBe('SAVED-1');
        expect(result.edgeIds).toEqual(['SAVED-2', 'SAVED-3']);
        expect(invalidated).toHaveBeenCalledTimes(1);

        const conceptRec = savedRecords.find((r) => r.entityName === 'MJ: Graph Concepts')!.record;
        expect(conceptRec.Name).toBe('Board At-Risk Revenue Threshold');
        expect(conceptRec.GraphID).toBe('GRAPH-CANON-1');

        const sourcedFromRec = savedRecords.find(
            (r) => r.entityName === 'MJ: Graph Edges' && r.record.EdgeType === 'SourcedFrom',
        )!.record;
        expect(sourcedFromRec.SourceEntity).toBe('MJ: Graph Concepts');
        expect(sourcedFromRec.SourceRecordID).toBe('SAVED-1');
        expect(sourcedFromRec.TargetEntity).toBe('MJ: AI Agent Notes');
        expect(sourcedFromRec.TargetRecordID).toBe('NOTE-PROMOTE-1');
    });
});

describe('SkipSDK — buildAgentNotes, Canon Enrichment & Event Invalidation', () => {
    const apiUrl = 'https://test.askskip.ai';

    beforeEach(() => {
        vi.clearAllMocks();
        clearBrainCapabilities();
        SkipSDK.InvalidateEntitiesCache();
        SkipSDK.InvalidateQueriesCache();
        SkipSDK.InvalidateCanonCache();
        SkipSDK.InvalidateNotesCache();

        fakeCanonState.concepts = [
            {
                ID: 'CONCEPT-1',
                Name: 'Net Recognized Revenue',
                DisplayName: 'Net Recognized Revenue',
                ConceptType: 'Metric',
                Status: 'Active',
                PrecedenceRank: 100,
                Definition: 'SUM(TotalAmount) where Status = Recognized',
            },
        ];
        fakeCanonState.edges = [];
        fakeCanonState.renderedMarkdown = '# MJ Canon — Domain Knowledge Summary';

        fakeAIState.agentNoteTypes = [
            { ID: 'NT-PREF', Name: 'Preference', Description: 'User or org preference' },
        ];
        fakeAIState.agentNotes = [
            {
                ID: 'NOTE-DOMAIN-1',
                AgentNoteTypeID: 'NT-PREF',
                AgentNoteType: 'Preference',
                Type: 'Preference',
                Status: 'Active',
                AgentID: null,
                UserID: null,
                Note: 'Board At-Risk Revenue Threshold: 25% of Net Recognized Revenue. Always use crm.vwRecognizedInvoices instead of crm.Invoice_Staging.',
                __mj_CreatedAt: new Date('2026-01-01T00:00:00Z'),
                __mj_UpdatedAt: new Date('2026-01-01T00:00:00Z'),
            },
            {
                ID: 'NOTE-TACTICAL-1',
                AgentNoteTypeID: 'NT-PREF',
                AgentNoteType: 'Preference',
                Type: 'Preference',
                Status: 'Active',
                AgentID: 'SKIP-AGENT-ID',
                UserID: 'USER-1',
                User: 'Test User',
                Note: 'Assign Enterprise action items to Elena Rostova.',
                __mj_CreatedAt: new Date('2026-01-01T00:00:00Z'),
                __mj_UpdatedAt: new Date('2026-01-01T00:00:00Z'),
            },
            {
                ID: 'NOTE-OTHER-USER',
                AgentNoteTypeID: 'NT-PREF',
                Status: 'Active',
                AgentID: null,
                UserID: 'OTHER-USER-999',
                Note: 'Private note for another user',
            },
        ];
    });

    it('packs active Global and User-scoped notes into request.notes and bridges domain notes into request.canon', async () => {
        const sdk = new SkipSDK({ apiUrl, apiKey: 'test-api-key' });
        const sentRequests: SkipAPIRequest[] = [];

        vi.spyOn(sdk as unknown as { sendSSERequest: (...args: unknown[]) => Promise<unknown[]> }, 'sendSSERequest')
            .mockImplementation(async (_url: unknown, req: unknown) => {
                sentRequests.push(req as SkipAPIRequest);
                return [
                    {
                        type: 'complete',
                        value: {
                            success: true,
                            responsePhase: SkipResponsePhase.analysis_complete,
                            messages: [],
                            serverCapabilities: [SkipServerCapability.MetadataCache],
                        },
                    },
                ];
            });

        await sdk.chat({
            messages: [{ role: 'user', content: 'Analyze revenue risk' }],
            conversationId: 'conv-notes-1',
            contextUser: { ID: 'USER-1', Email: 'test@example.com' } as unknown as UserInfo,
            dataSource: {} as never,
        });

        expect(sentRequests).toHaveLength(1);
        const req = sentRequests[0];

        // 2 notes included (Global + USER-1; OTHER-USER-999 excluded)
        expect(req.notes).toHaveLength(2);
        expect(req.notes?.map((n) => n.id)).toEqual(['NOTE-DOMAIN-1', 'NOTE-TACTICAL-1']);
        expect(req.noteTypes).toHaveLength(1);

        // Domain-bearing note was bridged into request.canon!
        expect(req.canon?.concepts.map((c) => c.name)).toContain('Board At-Risk Revenue Threshold');
        expect(req.canon?.edges.some((e) => e.edgeType === 'Preferred Over' && e.origin === 'Notetaker')).toBe(true);
        expect(req.canon?.edges.some((e) => e.edgeType === 'SourcedFrom' && e.targetRecordID === 'NOTE-DOMAIN-1')).toBe(true);
        expect(req.canon?.domainDocument).toContain('## Notetaker-Derived Canon Rules (MJ: AI Agent Notes)');

        // Next turn uses metadataRefs and invalidates both notes and canon hashes when a new note is saved
        recordBrainCapabilities(apiUrl, [SkipServerCapability.MetadataCache]);
        await sdk.chat({
            messages: [{ role: 'user', content: 'Turn 2' }],
            conversationId: 'conv-notes-1',
            contextUser: { ID: 'USER-1', Email: 'test@example.com' } as unknown as UserInfo,
            dataSource: {} as never,
        });

        const turn2NotesHash = sentRequests[1].metadataRefs?.notes?.hash;
        const turn2CanonHash = sentRequests[1].metadataRefs?.canon?.hash;
        expect(turn2NotesHash).toBeDefined();
        expect(turn2CanonHash).toBeDefined();

        // Simulate MemoryManagerAgent saving a new AIAgentNote and firing MJGlobal event
        fakeAIState.agentNotes.push({
            ID: 'NOTE-DOMAIN-2',
            AgentNoteTypeID: 'NT-PREF',
            AgentNoteType: 'Preference',
            Status: 'Active',
            AgentID: null,
            UserID: null,
            Note: "Expansion Ready Account: Active Account with HealthScore >= 85 and SupportRiskTier = 'Low'.",
            __mj_CreatedAt: new Date('2026-01-02T00:00:00Z'),
            __mj_UpdatedAt: new Date('2026-01-02T00:00:00Z'),
        });
        for (const sub of fakeAIState.eventSubscribers) {
            sub({
                event: 'ComponentEvent',
                eventCode: 'BaseEntityEvent',
                args: { type: 'save', entityName: 'MJ: AI Agent Notes' },
            });
        }

        await sdk.chat({
            messages: [{ role: 'user', content: 'Turn 3' }],
            conversationId: 'conv-notes-1',
            contextUser: { ID: 'USER-1', Email: 'test@example.com' } as unknown as UserInfo,
            dataSource: {} as never,
        });

        const turn3NotesHash = sentRequests[2].metadataRefs?.notes?.hash;
        const turn3CanonHash = sentRequests[2].metadataRefs?.canon?.hash;
        expect(turn3NotesHash).not.toBe(turn2NotesHash);
        expect(turn3CanonHash).not.toBe(turn2CanonHash);
    });
});
