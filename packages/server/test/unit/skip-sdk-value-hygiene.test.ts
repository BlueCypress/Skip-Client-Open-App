/**
 * @fileoverview Unit tests for SkipSDK conversation ID validation.
 *
 * buildInputArtifacts interpolated the caller-supplied conversation ID straight
 * into a RunView ExtraFilter, allowing SQL filter injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserInfo } from '@memberjunction/core';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockRunView = vi.fn();

vi.mock('@memberjunction/core', () => {
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

import { SkipSDK } from '../../src/skip-sdk.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface PrivateAccess {
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
