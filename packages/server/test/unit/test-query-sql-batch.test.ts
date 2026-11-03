/**
 * @fileoverview Unit tests for the `TestQuerySQLBatch` resolver.
 *
 * Tests cover:
 * 1. Every item is handed to MJ's own `TestQuerySQLResolver.TestQuerySQL`, unchanged,
 *    with the caller's request context — no second execution path
 * 2. Results come back in input order, and items run one at a time
 * 3. One item failing (reported or thrown) does not fail its neighbours
 * 4. The batch cap, the `query:test` scope and the read-only connection refuse the
 *    batch as a whole, before any item runs
 *
 * MJ's server package is mocked: `TestQuerySQLResolver` is the seam being asserted on,
 * and the TypeGraphQL decorators are reduced to no-ops so the class can be exercised
 * as plain TypeScript.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '@memberjunction/server';
import type { TestQuerySQLInput, TestQuerySQLResult } from '@askskip/types';

// ── Mutable fixture state (referenced lazily by the hoisted mock factories) ──

const state = {
    itemImpl: async (input: TestQuerySQLInput): Promise<TestQuerySQLResult> =>
        ({ Success: true, Results: JSON.stringify([{ sql: input.SQL }]), RowCount: 1, ExecutionTime: 1 }),
    itemCalls: [] as Array<{ input: TestQuerySQLInput; context: unknown }>,
    scopeError: null as Error | null,
    scopeChecks: [] as Array<{ scope: string; resource: string }>,
    readOnlyProvider: { name: 'read-only' } as object | null,
};

function resetState(): void {
    state.itemImpl = async (input) =>
        ({ Success: true, Results: JSON.stringify([{ sql: input.SQL }]), RowCount: 1, ExecutionTime: 1 });
    state.itemCalls = [];
    state.scopeError = null;
    state.scopeChecks = [];
    state.readOnlyProvider = { name: 'read-only' };
}

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('type-graphql', () => {
    const noop = () => () => undefined;
    return { Arg: noop, Ctx: noop, Field: noop, InputType: noop, ObjectType: noop, Query: noop, Resolver: noop, Int: Number };
});

vi.mock('graphql-type-json', () => ({ GraphQLJSONObject: {} }));

vi.mock('@memberjunction/core', () => ({ LogError: vi.fn(), LogStatus: vi.fn() }));

vi.mock('../../src/resolvers/TestAndProfileQuerySQLResolver.js', () => ({
    ProfileQueryDependencySpecInput: class {},
}));

vi.mock('@memberjunction/server', () => {
    class ResolverBase {
        async CheckAPIKeyScopeAuthorization(scope: string, resource: string): Promise<void> {
            state.scopeChecks.push({ scope, resource });
            if (state.scopeError) throw state.scopeError;
        }
    }
    class TestQuerySQLResolver extends ResolverBase {
        async TestQuerySQL(input: TestQuerySQLInput, context: unknown): Promise<TestQuerySQLResult> {
            state.itemCalls.push({ input, context });
            return state.itemImpl(input);
        }
    }
    return {
        ResolverBase,
        TestQuerySQLResolver,
        GetReadOnlyProvider: vi.fn(() => state.readOnlyProvider),
    };
});

const { TestQuerySQLBatchResolver } = await import('../../src/resolvers/TestQuerySQLBatchResolver.js');
const { TEST_QUERY_SQL_BATCH_MAX_ITEMS } = await import('@askskip/types');

// ── Helpers ──────────────────────────────────────────────────────────────────

const context = { userPayload: { apiKeyHash: 'hash' }, providers: [] } as unknown as AppContext;

function items(count: number): TestQuerySQLInput[] {
    return Array.from({ length: count }, (_, i) => ({ SQL: `SELECT ${i}`, MaxRows: 10 }));
}

async function runBatch(batchItems: TestQuerySQLInput[]) {
    return new TestQuerySQLBatchResolver().TestQuerySQLBatch({ Items: batchItems }, context);
}

beforeEach(resetState);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TestQuerySQLBatch', () => {
    it('hands every item, unchanged, to MJ TestQuerySQL with the caller context', async () => {
        const input: TestQuerySQLInput = {
            SQL: 'SELECT * FROM {{query:"Sales/Orders"}} WHERE Region = {{ region }}',
            Parameters: { region: 'West' },
            UsesTemplate: true,
            Dependencies: [{ Name: 'Orders', CategoryPath: '/Sales/', SQL: 'SELECT 1' }],
            MaxRows: 25,
        };

        const result = await runBatch([input, { SQL: 'SELECT 2' }]);

        expect(result.Success).toBe(true);
        expect(state.itemCalls).toHaveLength(2);
        expect(state.itemCalls[0].input).toBe(input);
        expect(state.itemCalls[0].context).toBe(context);
        expect(state.itemCalls[1].input).toEqual({ SQL: 'SELECT 2' });
    });

    it('returns one result per item, in input order, passing each result through unchanged', async () => {
        const mjResult: TestQuerySQLResult = {
            Success: true, Results: '[{"a":1}]', RowCount: 1, ExecutionTime: 7,
            AppliedParameters: '{"x":"1"}', RenderedSQL: 'SELECT TOP 10 1',
        };
        state.itemImpl = async (input) => (input.SQL === 'SELECT 1' ? mjResult : { Success: true, RowCount: 0, ExecutionTime: 1 });

        const result = await runBatch(items(5));

        expect(result.Results).toHaveLength(5);
        expect(state.itemCalls.map(c => c.input.SQL)).toEqual(['SELECT 0', 'SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4']);
        expect(result.Results[1]).toBe(mjResult);
    });

    it('runs items one at a time, never concurrently', async () => {
        let active = 0;
        let maxActive = 0;
        const finished: string[] = [];
        state.itemImpl = async (input) => {
            active++;
            maxActive = Math.max(maxActive, active);
            // Earlier items take longer: a concurrent run would finish them last.
            const index = Number(input.SQL.split(' ')[1]);
            await new Promise(resolve => setTimeout(resolve, (5 - index) * 5));
            active--;
            finished.push(input.SQL);
            return { Success: true, Results: JSON.stringify([{ sql: input.SQL }]), RowCount: 1, ExecutionTime: 1 };
        };

        const result = await runBatch(items(5));

        expect(maxActive).toBe(1);
        expect(finished).toEqual(['SELECT 0', 'SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4']);
        expect(result.Results.map(r => JSON.parse(r.Results ?? '[]')[0].sql)).toEqual(finished);
    });

    it('isolates an item that MJ reports as failed', async () => {
        state.itemImpl = async (input) => input.SQL === 'SELECT 1'
            ? { Success: false, RowCount: 0, ExecutionTime: 0, ErrorMessage: "Invalid column name 'Nope'." }
            : { Success: true, Results: '[]', RowCount: 0, ExecutionTime: 1 };

        const result = await runBatch(items(3));

        expect(result.Success).toBe(true);
        expect(result.Results.map(r => r.Success)).toEqual([true, false, true]);
        expect(result.Results[1].ErrorMessage).toBe("Invalid column name 'Nope'.");
    });

    it('isolates an item whose execution throws, reporting it on that item', async () => {
        state.itemImpl = async (input) => {
            if (input.SQL === 'SELECT 0') throw new Error('connection reset');
            return { Success: true, Results: '[]', RowCount: 0, ExecutionTime: 1 };
        };

        const result = await runBatch(items(3));

        expect(result.Success).toBe(true);
        expect(result.Results).toHaveLength(3);
        expect(result.Results[0]).toMatchObject({ Success: false, RowCount: 0, ExecutionTime: 0 });
        expect(result.Results[0].ErrorMessage).toContain('item 0');
        expect(result.Results[0].ErrorMessage).toContain('connection reset');
        expect(result.Results.slice(1).every(r => r.Success)).toBe(true);
    });

    it(`accepts exactly ${TEST_QUERY_SQL_BATCH_MAX_ITEMS} items`, async () => {
        const result = await runBatch(items(TEST_QUERY_SQL_BATCH_MAX_ITEMS));

        expect(result.Success).toBe(true);
        expect(result.Results).toHaveLength(TEST_QUERY_SQL_BATCH_MAX_ITEMS);
    });

    it('refuses a batch over the cap whole, before any item runs', async () => {
        const result = await runBatch(items(TEST_QUERY_SQL_BATCH_MAX_ITEMS + 1));

        expect(result.Success).toBe(false);
        expect(result.Results).toEqual([]);
        expect(result.ErrorMessage).toContain(`at most ${TEST_QUERY_SQL_BATCH_MAX_ITEMS} items`);
        expect(result.ErrorMessage).toContain(`received ${TEST_QUERY_SQL_BATCH_MAX_ITEMS + 1}`);
        expect(state.itemCalls).toHaveLength(0);
    });

    it('authorizes the batch against query:test, the scope TestQuerySQL checks', async () => {
        await runBatch(items(2));

        expect(state.scopeChecks[0]).toEqual({ scope: 'query:test', resource: '*' });
    });

    it('refuses the batch whole when the key lacks query:test', async () => {
        state.scopeError = new Error("Access denied. This API key requires the 'query:test' scope");

        const result = await runBatch(items(3));

        expect(result.Success).toBe(false);
        expect(result.Results).toEqual([]);
        expect(result.ErrorMessage).toContain('query:test');
        expect(state.itemCalls).toHaveLength(0);
    });

    it('refuses the batch whole when no read-only connection is available', async () => {
        state.readOnlyProvider = null;

        const result = await runBatch(items(3));

        expect(result.Success).toBe(false);
        expect(result.ErrorMessage).toContain('read-only connection');
        expect(state.itemCalls).toHaveLength(0);
    });

    it('returns an empty result list for an empty batch', async () => {
        const result = await runBatch([]);

        expect(result).toEqual({ Success: true, Results: [] });
    });
});
