/**
 * @fileoverview Unit tests for SkipSDK.sendSSERequest transport failure handling.
 *
 * Covers two defects:
 * 1. A `close` without a preceding `end` used to resolve with whatever partial
 *    events had arrived, presenting a torn-down connection as a normal stream end.
 * 2. In the gzip branch only the gunzip stream had handlers, and pipe() does not
 *    forward source errors — a mid-stream reset on the response never settled the
 *    promise, hanging the caller forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import { gzipSync } from 'zlib';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockHttpRequest = vi.fn();

vi.mock('http', () => ({
    request: (...args: unknown[]) => mockHttpRequest(...args),
}));
vi.mock('https', () => ({
    request: (...args: unknown[]) => mockHttpRequest(...args),
}));

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

vi.mock('@memberjunction/core', () => ({
    LogStatus: vi.fn(),
    LogError: vi.fn(),
    Metadata: class MockMetadata {},
    RunView: class MockRunView {},
    RunQuery: class MockRunQuery {},
    EntityInfo: class MockEntityInfo {},
    EntityFieldInfo: class MockEntityFieldInfo {},
    EntityFieldValueInfo: class MockEntityFieldValueInfo {},
    DatabaseProviderBase: class MockDatabaseProviderBase {},
    UserInfo: class MockUserInfo {},
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

// ── Harness ─────────────────────────────────────────────────────────────────

type MockResponse = PassThrough & { statusCode: number; headers: Record<string, string> };

function createMockResponse(headers: Record<string, string> = {}): MockResponse {
    const res = new PassThrough() as MockResponse;
    res.statusCode = 200;
    res.headers = headers;
    return res;
}

interface SendSSERequestAccess {
    sendSSERequest(
        url: string,
        payload: Record<string, unknown>,
        headers: Record<string, string>
    ): Promise<Array<Record<string, unknown>>>;
}

/**
 * Starts a sendSSERequest call against the mocked http module and hands back
 * the pending promise plus the mock response once the request callback fires.
 */
async function startRequest(headers: Record<string, string> = {}): Promise<{
    promise: Promise<Array<Record<string, unknown>>>;
    res: MockResponse;
}> {
    const res = createMockResponse(headers);
    const req = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    mockHttpRequest.mockImplementation((_options: unknown, callback: (res: MockResponse) => void) => {
        // Deliver the response asynchronously like a real socket would
        setImmediate(() => callback(res));
        return req;
    });

    const sdk = new SkipSDK({ apiUrl: 'http://test.askskip.local', apiKey: 'k' });
    const promise = (sdk as unknown as SendSSERequestAccess)
        .sendSSERequest('http://test.askskip.local/chat', {}, {});

    // Wait for the (async) gzip of the request body + request dispatch
    await vi.waitFor(() => expect(mockHttpRequest).toHaveBeenCalled());
    await new Promise<void>((r) => setImmediate(r));

    return { promise, res };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SkipSDK.sendSSERequest transport handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('resolves with parsed events on a normal end', async () => {
        const { promise, res } = await startRequest();

        res.write('data: {"type":"status_update","value":{"responsePhase":"status_update"}}\n\n');
        res.write('data: {"type":"complete","value":{"success":true}}\n\n');
        res.end();

        const events = await promise;
        expect(events).toHaveLength(2);
        expect(events[1].type).toBe('complete');
    });

    it('rejects when the stream closes without a preceding end', async () => {
        const { promise, res } = await startRequest();

        res.write('data: {"type":"status_update","value":{"responsePhase":"status_update"}}\n\n');
        // destroy() emits `close` with no `end` — a torn-down connection
        res.destroy();

        await expect(promise).rejects.toThrow(/stream closed before completion/i);
    });

    it('resolves a gzip-encoded stream on a normal end', async () => {
        const { promise, res } = await startRequest({ 'content-encoding': 'gzip' });

        res.end(gzipSync('data: {"type":"complete","value":{"success":true}}\n\n'));

        const events = await promise;
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('complete');
    });

    it('rejects when the response errors mid-stream in the gzip branch', async () => {
        // pipe() does not forward source errors to the gunzip stream, so without
        // handlers on `res` itself this promise would never settle.
        const { promise, res } = await startRequest({ 'content-encoding': 'gzip' });

        res.emit('error', new Error('read ECONNRESET'));

        await expect(promise).rejects.toThrow(/read ECONNRESET/);
    });

    it('rejects when the response is aborted in the gzip branch', async () => {
        const { promise, res } = await startRequest({ 'content-encoding': 'gzip' });

        res.emit('aborted');

        await expect(promise).rejects.toThrow(/aborted/i);
    });
});
