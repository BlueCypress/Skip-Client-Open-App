/**
 * @fileoverview Unit tests for the exact pass and the profile cache, against a
 * fake provider.
 *
 * What is defended:
 * - **Every statement is bounded at the database** (`timeoutMs`, read-only).
 * - **A timeout resamples smaller; a failed semi-join falls back to the key
 *   hash; any other error ends the attempt** — and finished chunks are kept.
 * - **A failed entity backs off** instead of rescanning on every request, and
 *   says so through `ExactStatus` / `RetryAfter`.
 * - **The weekly sweep recomputes old entries**, and the resolver's caller gets
 *   database statistics at once when the exact pass is slow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetDialect } from '@memberjunction/sql-dialect';
import type { DatabaseProviderBase, EntityInfo, ExecuteSQLOptions, UserInfo } from '@memberjunction/core';
import { RunExactPass, STATEMENT_TIMEOUT_MS, type PassTarget } from '../../src/resolvers/entity-profile/exactPass.js';
import { EntityProfileService } from '../../src/resolvers/entity-profile/entityProfileService.js';
import type { ProfiledColumn } from '../../src/resolvers/entity-profile/entityColumns.js';

interface Call { SQL: string; Options: ExecuteSQLOptions | undefined }
type Responder = (sql: string, callIndex: number) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>;

/** Answers catalog queries, and fills every main-pass alias from the SQL: 100 rows, all non-null. */
function defaultResponder(sql: string): Record<string, unknown>[] {
    if (sql.includes('sys.partitions')) return [{ rows: 8_000_000 }];
    if (sql.includes('sys.stats')) return [];
    const row: Record<string, unknown> = {};
    for (const [, alias] of sql.matchAll(/ AS \[?([a-z_]+\d*)\]?(?=[,\s])/g)) {
        row[alias] = alias === '__rows' || /^c\d/.test(alias) ? 100 : 0;
    }
    return [row];
}

function fakeProvider(responder: Responder = defaultResponder): { Provider: DatabaseProviderBase; Calls: Call[] } {
    const calls: Call[] = [];
    const provider = {
        PlatformKey: 'sqlserver',
        ExecuteSQL: vi.fn(async (sql: string, _params: unknown, options?: ExecuteSQLOptions) => {
            calls.push({ SQL: sql, Options: options });
            return responder(sql, calls.length - 1);
        }),
    };
    return { Provider: provider as unknown as DatabaseProviderBase, Calls: calls };
}

const USER = {} as UserInfo;
const numeric = (count: number): ProfiledColumn[] => Array.from({ length: count }, (_, i) => ({ Name: `c${i}`, Type: 'int', Kind: 'numeric' }));

function passTarget(provider: DatabaseProviderBase, columns: ProfiledColumn[], keys = ['ID']): PassTarget {
    return {
        EntityName: 'Invoices', Source: { Schema: 'dbo', View: 'vwInvoices', BaseTable: 'Invoice', PrimaryKeys: keys },
        Columns: columns, Dialect: GetDialect('sqlserver'), DialectName: 'sqlserver', Provider: provider, User: USER,
    };
}

const mainCalls = (calls: Call[]) => calls.filter(c => c.SQL.includes('[vwInvoices]') && !c.SQL.includes('APPROX_COUNT_DISTINCT'));

describe('RunExactPass', () => {
    it('adds approximate cardinality in statements of at most 50, and survives their failure', async () => {
        const wide = numeric(120);
        const { Provider, Calls } = fakeProvider((sql) => {
            if (sql.includes('APPROX_COUNT_DISTINCT') && Calls.filter(c => c.SQL.includes('APPROX')).length > 2) throw new Error('Query timeout exceeded');
            if (!sql.includes('APPROX_COUNT_DISTINCT')) return defaultResponder(sql);
            const row: Record<string, unknown> = { __rows: 100 };
            for (const [, alias] of sql.matchAll(/ AS \[?([a-z_]+\d*)\]?(?=[,\s])/g)) row[alias] = alias.startsWith('ad') ? 100 : 100;
            return [row];
        });
        const outcome = await RunExactPass(passTarget(Provider, wide), { Pending: wide, Sample: null, Rows: 100 });
        const approx = Calls.filter(c => c.SQL.includes('APPROX_COUNT_DISTINCT'));
        expect(approx).toHaveLength(3);
        expect(approx[0].SQL).toContain('OPTION (MAXDOP 2)');
        expect((approx[0].SQL.match(/APPROX_COUNT_DISTINCT/g) ?? []).length).toBe(50);
        expect(outcome.Failure).toBeNull();
        expect(outcome.Exact[0].Column.Cardinality).toEqual({ Estimate: 100, Source: 'approx', Class: 'unique' });
        expect(outcome.Exact[119].Column.Cardinality).toBeUndefined();
    });

    it('bounds every statement at the database and keeps it read-only', async () => {
        const { Provider, Calls } = fakeProvider();
        const outcome = await RunExactPass(passTarget(Provider, numeric(3)), { Pending: numeric(3), Sample: null, Rows: 100 });
        expect(outcome.Failure).toBeNull();
        expect(outcome.RowCount).toEqual({ Count: 100, Source: 'exact' });
        expect(Calls[0].Options).toMatchObject({ readOnlyTransaction: true, ignoreLogging: true });
        expect(Calls[0].Options?.timeoutMs).toBeLessThanOrEqual(STATEMENT_TIMEOUT_MS);
    });

    it('retries a timed-out scan with a 4× smaller sample and scales the row count', async () => {
        const { Provider, Calls } = fakeProvider((sql, i) => {
            if (i === 0) throw new Error('Query timeout exceeded');
            return defaultResponder(sql);
        });
        const outcome = await RunExactPass(passTarget(Provider, numeric(2)), { Pending: numeric(2), Sample: null, Rows: 8_000_000 });
        expect(Calls[1].SQL).toContain('% 10000 < 2500');
        expect(outcome.Failure).toBeNull();
        expect(outcome.RowCount).toEqual({ Count: 400, Source: 'estimate' });
        expect(outcome.Exact[0].Column.CoverageSource).toBe('sample');
    });

    it('gives up after a timeout at the floor sample', async () => {
        const { Provider } = fakeProvider(() => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); });
        const outcome = await RunExactPass(passTarget(Provider, numeric(2)), { Pending: numeric(2), Sample: { Percent: 0.5, Method: 'semi' }, Rows: 8_000_000 });
        expect(outcome).toMatchObject({ GaveUp: true, Failure: { Kind: 'timeout' } });
    });

    it('falls back from a semi-join to the key hash when the base table cannot be read', async () => {
        const { Provider, Calls } = fakeProvider((sql) => {
            if (sql.includes('TABLESAMPLE')) throw new Error("The SELECT permission was denied on the object 'Invoice'");
            return defaultResponder(sql);
        });
        const outcome = await RunExactPass(passTarget(Provider, numeric(2)), { Pending: numeric(2), Sample: { Percent: 1, Method: 'semi' }, Rows: 8_000_000 });
        expect(Calls[1].SQL).toContain('CHECKSUM([ID])');
        expect(outcome.Failure).toBeNull();
        expect(outcome.NextSample).toEqual({ Percent: 1, Method: 'hash' });
    });

    it('ends the attempt on any other error, keeping the chunks that finished', async () => {
        const wide = numeric(400);
        const { Provider, Calls } = fakeProvider((sql, i) => {
            if (i === 1) throw new Error("Invalid column name 'c399'.");
            return defaultResponder(sql);
        });
        const outcome = await RunExactPass(passTarget(Provider, wide), { Pending: wide, Sample: null, Rows: 100 });
        expect(Calls).toHaveLength(2);
        expect(outcome).toMatchObject({ GaveUp: false, Failure: { Kind: 'error' } });
        expect(outcome.Exact.length).toBeGreaterThan(0);
        expect(outcome.Exact.length).toBeLessThan(400);
    });

    it('starts no statement once the pass budget is spent', async () => {
        const { Provider, Calls } = fakeProvider();
        const outcome = await RunExactPass(passTarget(Provider, numeric(2)), { Pending: numeric(2), Sample: null, Rows: 100, BudgetMs: 10 });
        expect(Calls).toHaveLength(0);
        expect(outcome.Failure?.Kind).toBe('budget');
    });

    it('counts rows at date bounds in a second statement, and survives its failure', async () => {
        const dates: ProfiledColumn[] = [{ Name: 'Expires', Type: 'datetime', Kind: 'date' }];
        const { Provider, Calls } = fakeProvider((sql, i) => {
            if (i === 0) return [{ __rows: 100, c0: 100, n0: '2013-01-01 00:00:00.000', x0: '2099-12-31 00:00:00.000', s0: 0 }];
            throw new Error('Query timeout exceeded');
        });
        const outcome = await RunExactPass(passTarget(Provider, dates), { Pending: dates, Sample: null, Rows: 100 });
        expect(Calls[1].SQL).toContain("CONVERT(DATETIME, '2099-12-31 00:00:00.000', 121)");
        expect(outcome.Failure).toBeNull();
        expect(outcome.Exact[0].Column).toMatchObject({ Min: '2013-01-01', Max: '2099-12-31' });
        expect(outcome.Exact[0].Column.ExtremeShare).toBeUndefined();
    });
});

function entityInfo(): EntityInfo {
    const fields = [
        { Name: 'ID', Type: 'uniqueidentifier', Length: 16, IsVirtual: false, IsPrimaryKey: true },
        { Name: 'Amount', Type: 'decimal', Length: 9, IsVirtual: false, IsPrimaryKey: false },
    ];
    return {
        Name: 'Invoices', SchemaName: 'dbo', BaseTable: 'Invoice', BaseView: 'vwInvoices',
        Fields: fields, PrimaryKeys: fields.filter(f => f.IsPrimaryKey),
    } as unknown as EntityInfo;
}

describe('EntityProfileService', () => {
    beforeEach(() => {
        EntityProfileService.ClearCache();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
    });
    afterEach(() => {
        EntityProfileService.ClearCache();
        vi.useRealTimers();
    });

    it('returns exact statistics when the pass finishes within the wait', async () => {
        const { Provider } = fakeProvider();
        const profile = await EntityProfileService.GetProfile(entityInfo(), Provider, USER, 5_000);
        expect(profile).toMatchObject({ Partial: false, ExactStatus: 'complete', Stale: false });
        expect(profile.Columns.map(c => c.CoverageSource)).toEqual(['scan', 'scan']);
    });

    it('answers at once from database statistics when the pass is slow, and fills the cache for the next caller', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const { Provider } = fakeProvider(async (sql) => {
            if (sql.includes('[vwInvoices]')) await gate;
            return defaultResponder(sql);
        });
        const first = await EntityProfileService.GetProfile(entityInfo(), Provider, USER, 10);
        expect(first).toMatchObject({ Partial: true, ExactStatus: 'pending', RowCount: 8_000_000, RowCountSource: 'exact' });
        release();
        const second = await EntityProfileService.GetProfile(entityInfo(), Provider, USER, 5_000);
        expect(second).toMatchObject({ Partial: false, ExactStatus: 'complete' });
    });

    it('does not hold a first caller past its wait when the catalog reads are blocked', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const { Provider, Calls } = fakeProvider(async (sql) => {
            if (sql.includes('sys.partitions')) await gate;
            return defaultResponder(sql);
        });
        const started = Date.now();
        const [first, concurrent] = await Promise.all([
            EntityProfileService.GetProfile(entityInfo(), Provider, USER, 600),
            EntityProfileService.GetProfile(entityInfo(), Provider, USER, 600),
        ]);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(first).toMatchObject({ Partial: true, ExactStatus: 'pending', RowCount: null });
        expect(concurrent.Partial).toBe(true);
        expect(Calls.filter(c => c.SQL.includes('sys.partitions'))).toHaveLength(1);
        release();
        const later = await EntityProfileService.GetProfile(entityInfo(), Provider, USER, 5_000);
        expect(later).toMatchObject({ Partial: false, ExactStatus: 'complete' });
    });

    it('backs off after a failed pass instead of rescanning on every request', async () => {
        const { Provider, Calls } = fakeProvider((sql) => {
            if (sql.includes('[vwInvoices]')) throw new Error("Invalid object name 'dbo.vwInvoices'.");
            return defaultResponder(sql);
        });
        const failed = await EntityProfileService.GetProfile(entityInfo(), Provider, USER, 5_000);
        expect(failed).toMatchObject({ Partial: true, ExactStatus: 'failed-error', RetryAfter: '2026-10-16T12:05:00.000Z' });

        await EntityProfileService.GetProfile(entityInfo(), Provider, USER, 5_000);
        expect(mainCalls(Calls)).toHaveLength(1);

        vi.setSystemTime(new Date('2026-10-16T12:06:00Z'));
        const retried = await EntityProfileService.GetProfile(entityInfo(), Provider, USER, 5_000);
        expect(mainCalls(Calls)).toHaveLength(2);
        expect(retried.RetryAfter).toBe('2026-10-16T12:36:00.000Z');
    });

    it('recomputes entries a week old in the sweep, and leaves younger ones alone', async () => {
        const { Provider, Calls } = fakeProvider();
        await EntityProfileService.GetProfile(entityInfo(), Provider, USER, 5_000);
        await EntityProfileService.RunRefreshSweep(0);
        expect(mainCalls(Calls)).toHaveLength(1);

        vi.setSystemTime(new Date('2026-10-23T12:00:01Z'));
        await EntityProfileService.RunRefreshSweep(0);
        expect(mainCalls(Calls)).toHaveLength(2);
        const refreshed = await EntityProfileService.GetProfile(entityInfo(), Provider, USER, 0);
        expect(refreshed).toMatchObject({ Stale: false, ExactStatus: 'complete', ComputedAt: '2026-10-23T12:00:01.000Z' });
    });
});
