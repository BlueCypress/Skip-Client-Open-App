/**
 * @fileoverview Unit tests for SkipSDK field-value dedup and conversation ID validation.
 *
 * Covers two defects:
 * 1. packFieldValues merged declared and database-derived field values through
 *    `new Set([...])` over freshly constructed objects — reference equality never
 *    collides, so every duplicate value was sent to Skip twice.
 * 2. buildInputArtifacts interpolated the caller-supplied conversation ID straight
 *    into a RunView ExtraFilter, allowing SQL filter injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityFieldInfo, UserInfo } from '@memberjunction/core';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockRunView = vi.fn();

vi.mock('@memberjunction/core', () => {
    class MockEntityFieldValueInfo {
        Value: string;
        Code: string;
        constructor(init: { Value: string; Code: string }) {
            this.Value = init.Value;
            this.Code = init.Code;
        }
    }
    return {
        LogStatus: vi.fn(),
        LogError: vi.fn(),
        Metadata: class MockMetadata {},
        RunView: class MockRunView {
            RunView = (...args: unknown[]) => mockRunView(...args);
        },
        RunQuery: class MockRunQuery {},
        EntityInfo: class MockEntityInfo {},
        EntityFieldInfo: class MockEntityFieldInfo {},
        EntityFieldValueInfo: MockEntityFieldValueInfo,
        DatabaseProviderBase: class MockDatabaseProviderBase {},
        UserInfo: class MockUserInfo {},
    };
});

vi.mock('../../src/skip-callback-key-provisioner.js', () => ({
    getSkipCallbackKey: vi.fn().mockResolvedValue(null),
    resetCallbackKeyProvisioning: vi.fn().mockResolvedValue(undefined),
    confirmCallbackKeyDelivered: vi.fn(),
    discardUnconfirmedCallbackKey: vi.fn().mockResolvedValue(false),
}));

vi.mock('@askskip/core', () => ({
    getSkipConfig: () => ({
        skipURL: 'http://test.askskip.local',
        apiKey: 'test-api-key',
        baseUrl: 'http://localhost',
        graphqlPort: 4000,
        graphqlRootPath: '/',
        entitiesToSend: { excludeSchemas: [], includeEntitiesFromExcludedSchemas: [] },
    }),
    getDbType: () => 'sqlserver',
    resolveSkipApiKey: vi.fn().mockResolvedValue('test-api-key'),
}));

vi.mock('@memberjunction/core-entities', () => ({
    QueryEngine: { Instance: { Queries: [], Categories: [], QueryEntities: [], GetQueryFields: () => [], GetQueryParameters: () => [] } },
}));

vi.mock('@memberjunction/ai', () => ({ GetAIAPIKey: vi.fn().mockReturnValue('') }));
vi.mock('@memberjunction/aiengine', () => ({
    AIEngine: { Instance: { Config: vi.fn(), GetAgentByName: vi.fn().mockReturnValue(null) } },
}));
vi.mock('@memberjunction/global', async (importOriginal) => ({
    CopyScalarsAndArrays: (x: unknown) => x,
    UUIDsEqual: (a: string, b: string) => a === b,
    // Real validator: the UUID-guard tests depend on its actual accept/reject behavior.
    IsValidUUID: (await importOriginal<typeof import('@memberjunction/global')>()).IsValidUUID,
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
vi.mock('rxjs/operators', () => ({ take: () => (x: unknown) => x }));

import { SkipSDK } from '../../src/skip-sdk.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface FieldValue {
    Value: string;
    Code: string;
}

interface PrivateAccess {
    packFieldValues(f: EntityFieldInfo): Promise<FieldValue[]>;
    dedupeFieldValues(values: FieldValue[]): FieldValue[];
    buildInputArtifacts(
        contextUser: UserInfo,
        conversationId: string,
        alreadyLoaded: Map<string, unknown>
    ): Promise<unknown[]>;
}

function createSdk(): PrivateAccess {
    return new SkipSDK({ apiUrl: 'http://test.askskip.local', apiKey: 'k' }) as unknown as PrivateAccess;
}

const VALID_UUID = '0b3c1a4e-9f2d-4c6b-8a1e-5d7f3b2c9e10';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SkipSDK field value dedup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('dedupeFieldValues collapses entries with the same Value, keeping the first', () => {
        const sdk = createSdk();
        const first = { Value: 'Active', Code: 'declared' };
        const result = sdk.dedupeFieldValues([
            first,
            { Value: 'Inactive', Code: 'declared' },
            { Value: 'Active', Code: 'from-db' },
        ]);

        expect(result.map((v) => v.Value)).toEqual(['Active', 'Inactive']);
        expect(result[0]).toBe(first);
    });

    it('packFieldValues merges declared and database values without duplicates', async () => {
        const sdk = createSdk();
        (sdk as unknown as Record<string, unknown>)['getFieldDistinctValues'] = vi.fn().mockResolvedValue([
            { Value: 'Active', Code: 'Active' },
            { Value: 'Pending', Code: 'Pending' },
        ]);

        const field = {
            ValuesToPackWithSchema: 'Auto',
            ValueListTypeEnum: 'ListOrUserEntry',
            EntityFieldValues: [{ Value: 'Active' }, { Value: 'Inactive' }],
        } as unknown as EntityFieldInfo;

        const result = await sdk.packFieldValues(field);

        expect(result.map((v) => v.Value).sort()).toEqual(['Active', 'Inactive', 'Pending']);
    });

    it('packFieldValues falls back to declared values when the database has none', async () => {
        const sdk = createSdk();
        (sdk as unknown as Record<string, unknown>)['getFieldDistinctValues'] = vi.fn().mockResolvedValue([]);

        const field = {
            ValuesToPackWithSchema: 'Auto',
            ValueListTypeEnum: 'ListOrUserEntry',
            EntityFieldValues: [{ Value: 'Active' }, { Value: 'Inactive' }],
        } as unknown as EntityFieldInfo;

        const result = await sdk.packFieldValues(field);

        expect(result.map((v) => v.Value)).toEqual(['Active', 'Inactive']);
    });
});

describe('SkipSDK conversation ID validation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a non-UUID conversation ID before running any view', async () => {
        const sdk = createSdk();

        const result = await sdk.buildInputArtifacts(
            {} as UserInfo,
            "x' OR 1=1; DROP TABLE Users; --",
            new Map()
        );

        expect(result).toEqual([]);
        expect(mockRunView).not.toHaveBeenCalled();
    });

    it('accepts a canonical UUID and queries conversation details with it', async () => {
        const sdk = createSdk();
        mockRunView.mockResolvedValue({ Success: true, Results: [] });

        const result = await sdk.buildInputArtifacts({} as UserInfo, VALID_UUID, new Map());

        expect(result).toEqual([]);
        expect(mockRunView).toHaveBeenCalledTimes(1);
        const firstCallParams = mockRunView.mock.calls[0][0] as { ExtraFilter: string };
        expect(firstCallParams.ExtraFilter).toContain(VALID_UUID);
    });
});
