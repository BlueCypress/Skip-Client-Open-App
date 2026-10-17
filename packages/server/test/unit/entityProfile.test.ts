/**
 * @fileoverview Unit tests for `ProfileEntityFields`' pure parts.
 *
 * What is defended:
 * - **Column choice comes from metadata, and no text value can leave the
 *   database**: text gets counts and lengths, never bounds.
 * - **The pass reads the BaseView with base columns only**, and samples through
 *   it by key hash or by a semi-join on the base table (`TABLESAMPLE` cannot
 *   apply to a view), in SQL both engines accept through MJ.
 * - **The cost model decides sampling**, SQL Server samples only from 2M rows,
 *   and a timeout cuts the sample 4× down to a floor.
 * - **Timeouts are told apart from other errors** for both drivers' shapes.
 * - **"Empty" and "all zero" are never rounding artifacts.**
 * - **An all-NULL column is never reported as full**, and a change signal alone
 *   does not trigger a refresh.
 */

import { describe, it, expect } from 'vitest';
import { AutoQuotePostgreSQLIdentifiers, GetDialect } from '@memberjunction/sql-dialect';
import type { EntityInfo } from '@memberjunction/core';
import { ColumnKindFor, ProfiledColumns, SchemaSignature, type ProfiledColumn } from '../../src/resolvers/entity-profile/entityColumns.js';
import {
    BuildCardinalityStatements, BuildExtremesStatement, BuildMainStatements, FromClause, HashBucket, MAX_AGGREGATES_PER_STATEMENT, SampleFraction,
    type ProfileSource,
} from '../../src/resolvers/entity-profile/profileSQL.js';
import {
    ChooseSample, EstimatePassMs, FloorPercent, SampleAfterTimeout,
} from '../../src/resolvers/entity-profile/samplingPolicy.js';
import { BackoffMs, ClassifyFailure } from '../../src/resolvers/entity-profile/failurePolicy.js';
import {
    ApplyCardinalityRow, ApplyExtremesRow, AssembleProfile, CardinalityOf, DateBoundsOf, FormatDate, ReadMainRow, SafeShare, type ExactColumn, type ProfileState,
} from '../../src/resolvers/entity-profile/readProfile.js';
import { ReadColumnStatistics, ReadTableStatistics, TableStatisticsSQL } from '../../src/resolvers/entity-profile/dbStatistics.js';
import {
    CHANGED_SHARE, MAX_AGE_MS, MIN_AGE_FOR_ROW_CHANGE_MS, RefreshReasonFor, type FreshnessSample,
} from '../../src/resolvers/entity-profile/refreshPolicy.js';

const SQLSERVER = GetDialect('sqlserver');
const POSTGRES = GetDialect('postgresql');

function entity(fields: { Name: string; Type: string; Length?: number; IsVirtual?: boolean }[]): EntityInfo {
    return { Fields: fields.map(f => ({ IsVirtual: false, Length: 0, ...f })) } as unknown as EntityInfo;
}

const SOURCE: ProfileSource = { Schema: 'AssociationDemo', View: 'vwInvoices', BaseTable: 'Invoice', PrimaryKeys: ['ID'] };
const COLUMNS: ProfiledColumn[] = [
    { Name: 'ID', Type: 'uniqueidentifier', Kind: 'other' },
    { Name: 'Amount', Type: 'decimal', Kind: 'numeric' },
    { Name: 'InvoiceDate', Type: 'datetime2', Kind: 'date' },
    { Name: 'Status', Type: 'nvarchar', Kind: 'text' },
    { Name: 'Notes', Type: 'nvarchar', Kind: 'other' },
];

describe('ProfiledColumns', () => {
    const info = entity([
        { Name: 'ID', Type: 'uniqueidentifier' },
        { Name: 'Amount', Type: 'decimal' },
        { Name: 'InvoiceDate', Type: 'datetime2' },
        { Name: 'Status', Type: 'nvarchar', Length: 100 },
        { Name: 'Notes', Type: 'nvarchar', Length: -1 },
        { Name: 'Member', Type: 'nvarchar', Length: 200, IsVirtual: true },
        { Name: '__mj_UpdatedAt', Type: 'datetimeoffset' },
    ]);

    it('keeps base columns and drops virtual and __mj plumbing columns', () => {
        expect(ProfiledColumns(info).map(c => c.Name)).toEqual(['ID', 'Amount', 'InvoiceDate', 'Status', 'Notes']);
    });

    it('gives long text coverage only, and bounded text its text statistics', () => {
        expect(ProfiledColumns(info).map(c => c.Kind)).toEqual(['other', 'numeric', 'date', 'text', 'other']);
        expect(ColumnKindFor('text', 0)).toBe('other');
        expect(ColumnKindFor('jsonb', null)).toBe('other');
        expect(ColumnKindFor('character varying', 40)).toBe('text');
        expect(ColumnKindFor('timestamp with time zone', null)).toBe('date');
        expect(ColumnKindFor('bit', null)).toBe('other');
    });

    it('changes the schema signature when a column is retyped', () => {
        const before = SchemaSignature(ProfiledColumns(info));
        const after = SchemaSignature(ProfiledColumns(entity([{ Name: 'ID', Type: 'int' }])));
        expect(after).not.toBe(before);
    });
});

describe('BuildMainStatements', () => {
    it('reads the BaseView, never the table, and never counts distinct values', () => {
        const [statement] = BuildMainStatements(SOURCE, COLUMNS, COLUMNS, SQLSERVER, 'sqlserver', null);
        expect(statement.SQL).toContain('FROM [AssociationDemo].[vwInvoices]');
        expect(statement.SQL).not.toContain('[Invoice]');
        expect(statement.SQL).not.toMatch(/DISTINCT/i);
    });

    it('emits each kind\'s statistics and nothing that returns a text value', () => {
        const [statement] = BuildMainStatements(SOURCE, COLUMNS, COLUMNS, SQLSERVER, 'sqlserver', null);
        expect(statement.SQL).toContain('MIN([Amount])');
        expect(statement.SQL).toContain('SUM(CASE WHEN [Amount] = 0 THEN 1 ELSE 0 END)');
        expect(statement.SQL).toContain('SUM(CASE WHEN [Status] = \'\' THEN 1 ELSE 0 END)');
        expect(statement.SQL).toContain('MAX(LEN([Status]))');
        expect(statement.SQL).toMatch(/CONVERT\(NVARCHAR\(40\), MIN\(CASE WHEN NOT \(\[InvoiceDate\] < CAST\('1901-01-01' AS DATETIME2\)/);
        expect(statement.SQL).not.toMatch(/M(IN|AX)\(\[(Status|Notes|ID)\]\)/);
        expect(statement.SQL).not.toContain('LEN([Notes])');
    });

    it('writes PostgreSQL-only words in lower case, which MJ\'s auto-quoting leaves alone', () => {
        const [statement] = BuildMainStatements(SOURCE, COLUMNS, COLUMNS, POSTGRES, 'postgresql', { Percent: 1, Method: 'semi' });
        expect(statement.SQL).toContain('btrim("Status") = \'\'');
        expect(statement.SQL).toContain('date \'1901-01-01\'');
        expect(statement.SQL).toContain('tablesample system (1) repeatable (7)');
        expect(statement.SQL).not.toMatch(/REPEATABLE|TABLESAMPLE/);
    });

    it('survives MJ\'s PostgreSQL auto-quoting unchanged, for every statement shape', () => {
        const composite = { ...SOURCE, PrimaryKeys: ['OrderID', 'Line'] };
        const statements = [
            ...BuildMainStatements(SOURCE, COLUMNS, COLUMNS, POSTGRES, 'postgresql', null),
            ...BuildMainStatements(SOURCE, COLUMNS, COLUMNS, POSTGRES, 'postgresql', { Percent: 1, Method: 'semi' }),
            ...BuildMainStatements(composite, COLUMNS, COLUMNS, POSTGRES, 'postgresql', { Percent: 10, Method: 'hash' }),
        ].map(s => s.SQL);
        const bounds = [{ Column: COLUMNS[2], RawMin: '2013-01-15 00:00:00', RawMax: '2030-06-30 13:45:00+00' }];
        statements.push(BuildExtremesStatement(SOURCE, bounds, COLUMNS, POSTGRES, 'postgresql', null)!.SQL);
        for (const sql of statements) expect(AutoQuotePostgreSQLIdentifiers(sql)).toBe(sql);
    });

    it('splits wide entities so no statement exceeds the aggregate limit, with aliases unique across chunks', () => {
        const wide: ProfiledColumn[] = Array.from({ length: 1_029 }, (_, i) => ({ Name: `c${i}`, Type: 'int', Kind: 'numeric' }));
        const statements = BuildMainStatements(SOURCE, wide, wide, POSTGRES, 'postgresql', null);
        expect(statements.length).toBeGreaterThan(1);
        const aliases = statements.flatMap(s => [...s.SQL.matchAll(/ AS "([^"]+)"/g)].map(m => m[1]).filter(a => a !== '__rows'));
        for (const statement of statements) {
            expect((statement.SQL.match(/ AS "/g) ?? []).length).toBeLessThanOrEqual(MAX_AGGREGATES_PER_STATEMENT);
        }
        expect(new Set(aliases).size).toBe(aliases.length);
        expect(statements.flatMap(s => s.Columns)).toHaveLength(1_029);
    });
});

describe('BuildCardinalityStatements', () => {
    it('counts keys and bounded text first, never long text, at most 50 per statement, on SQL Server only', () => {
        const [statement] = BuildCardinalityStatements(SOURCE, COLUMNS, COLUMNS, SQLSERVER, 'sqlserver', { Percent: 5, Method: 'hash' });
        expect(statement.Columns.map(c => c.Name)).toEqual(['ID', 'Status', 'Amount', 'InvoiceDate']);
        expect(statement.SQL).toContain('APPROX_COUNT_DISTINCT([ID])');
        expect(statement.SQL).not.toContain('[Notes]');
        expect(statement.SQL).toMatch(/% 10000 < 500 OPTION \(MAXDOP 2\)$/);
        const wide: ProfiledColumn[] = Array.from({ length: 120 }, (_, i) => ({ Name: `c${i}`, Type: 'int', Kind: 'numeric' }));
        expect(BuildCardinalityStatements(SOURCE, wide, wide, SQLSERVER, 'sqlserver', null).map(s => s.Columns.length)).toEqual([50, 50, 20]);
        expect(BuildCardinalityStatements(SOURCE, COLUMNS, COLUMNS, POSTGRES, 'postgresql', null)).toEqual([]);
    });

    it('classes a sample by its own ratios and scales only unique and high estimates', () => {
        const exact = new Map(ReadMainRow({ __rows: 1_000, c0: 1_000, c1: 1_000 }, COLUMNS.slice(0, 2), COLUMNS, { Percent: 10, Method: 'hash' })
            .map(e => [e.Column.Name, e]));
        ApplyCardinalityRow({ __rows: 1_000, c0: 1_000, ad0: 1_000, c1: 1_000, ad1: 12 }, COLUMNS.slice(0, 2), COLUMNS, exact, { Percent: 10, Method: 'hash' }, 0.1);
        expect(exact.get('ID')?.Column.Cardinality).toEqual({ Estimate: 10_000, Source: 'sample', Class: 'unique' });
        expect(exact.get('Amount')?.Column.Cardinality).toEqual({ Estimate: 12, Source: 'sample', Class: 'low' });
    });
});

describe('sampling through the view', () => {
    it('hash-samples by primary key on both engines', () => {
        expect(FromClause(SOURCE, SQLSERVER, 'sqlserver', { Percent: 12.5, Method: 'hash' }))
            .toBe('[AssociationDemo].[vwInvoices] WHERE (CHECKSUM([ID]) & 2147483647) % 10000 < 1250');
        expect(FromClause(SOURCE, POSTGRES, 'postgresql', { Percent: 12.5, Method: 'hash' }))
            .toBe('"AssociationDemo"."vwInvoices" WHERE (hashtext(cast("ID" as text)) & 2147483647) % 10000 < 1250');
    });

    it('hashes every column of a composite key', () => {
        const composite = { ...SOURCE, PrimaryKeys: ['OrderID', 'Line'] };
        expect(FromClause(composite, SQLSERVER, 'sqlserver', { Percent: 10, Method: 'hash' })).toContain('CHECKSUM([OrderID], [Line])');
        expect(FromClause(composite, POSTGRES, 'postgresql', { Percent: 10, Method: 'hash' }))
            .toContain('concat_ws(\'|\', cast("OrderID" as text), cast("Line" as text))');
    });

    it('semi-joins the view to a block sample of the base table', () => {
        expect(FromClause(SOURCE, SQLSERVER, 'sqlserver', { Percent: 0.6, Method: 'semi' }))
            .toBe('[AssociationDemo].[vwInvoices] WHERE [ID] IN (SELECT [ID] FROM [AssociationDemo].[Invoice] TABLESAMPLE (0.6 PERCENT) REPEATABLE (7))');
    });

    it('scales counts by the share of rows each method keeps', () => {
        expect(HashBucket(0.001)).toBe(1);
        expect(SampleFraction({ Percent: 12.5, Method: 'hash' })).toBe(0.125);
        expect(SampleFraction({ Percent: 0.6, Method: 'semi' })).toBe(0.006);
    });
});

describe('ChooseSample', () => {
    const ext: ProfiledColumn[] = Array.from({ length: 129 }, (_, i) => ({ Name: `c${i}`, Type: 'int', Kind: 'numeric' }));

    it('scans in full when the estimate is cheap, or when there is no estimate or key', () => {
        expect(ChooseSample(170_000, ext, ['ID'], 'postgresql')).toBeNull();
        expect(ChooseSample(null, ext, ['ID'], 'postgresql')).toBeNull();
        expect(ChooseSample(50_000_000, ext, [], 'postgresql')).toBeNull();
    });

    it('lands a large pass near the target with a hash sample, and a very large one with a semi-join', () => {
        // PLUS CustomerMessagingActivity: 8.4M rows × 129 columns measured 37.6 s with these statistics.
        expect(EstimatePassMs(8_400_000, ext)).toBeCloseTo(39_009, -1);
        expect(ChooseSample(8_400_000, ext, ['ID'], 'postgresql')).toEqual({ Percent: 12.817, Method: 'hash' });
        expect(ChooseSample(200_000_000, ext, ['ID'], 'postgresql')?.Method).toBe('semi');
        expect(ChooseSample(200_000_000, ext, ['A', 'B'], 'postgresql')?.Method).toBe('hash');
    });

    it('prices a wide-row table by the bytes a scan reads, twice when dates add the extremes scan', () => {
        // PLUS RecordChange: 7.9M rows, 19 columns, a 5.8 GB heap; estimated 3.5 s per cell, measured 23 s.
        const recordChange: ProfiledColumn[] = [
            ...Array.from({ length: 3 }, (_, i) => ({ Name: `d${i}`, Type: 'timestamp', Kind: 'date' as const })),
            ...Array.from({ length: 4 }, (_, i) => ({ Name: `t${i}`, Type: 'varchar', Kind: 'text' as const })),
            ...Array.from({ length: 12 }, (_, i) => ({ Name: `o${i}`, Type: 'text', Kind: 'other' as const })),
        ];
        expect(EstimatePassMs(7_900_000, recordChange)).toBeCloseTo(3_508, -1);
        expect(EstimatePassMs(7_900_000, recordChange, 5.8e9, 'postgresql')).toBe(46_400);
        expect(ChooseSample(7_900_000, recordChange, ['ID'], 'postgresql', 5.8e9)).toEqual({ Percent: 10.776, Method: 'hash' });
        // CASE RecordChange: 16.6 GB in-row, full pass measured 8.8 s on SQL Server's parallel scan: stays a full scan.
        expect(ChooseSample(5_800_000, recordChange, ['ID'], 'sqlserver', 16.6e9)).toBeNull();
    });

    it('never samples SQL Server below 2M rows, where TABLESAMPLE lost to the parallel full scan', () => {
        const wide = Array.from({ length: 1_000 }, (_, i) => ({ Name: `c${i}`, Type: 'int', Kind: 'numeric' as const }));
        expect(ChooseSample(1_999_999, wide, ['ID'], 'sqlserver')).toBeNull();
        expect(ChooseSample(2_000_000, wide, ['ID'], 'sqlserver')).not.toBeNull();
    });
});

describe('SampleAfterTimeout', () => {
    it('cuts the sample 4× from a full scan down to the floor, then gives up', () => {
        let sample = SampleAfterTimeout(null, 8_000_000, ['ID']);
        expect(sample).toEqual({ Percent: 25, Method: 'hash' });
        sample = SampleAfterTimeout(sample, 8_000_000, ['ID']);
        expect(sample).toEqual({ Percent: 6.25, Method: 'hash' });
        sample = SampleAfterTimeout(sample, 8_000_000, ['ID']);
        expect(sample).toEqual({ Percent: 1.563, Method: 'semi' });
        sample = SampleAfterTimeout(sample, 8_000_000, ['ID']);
        expect(sample).toEqual({ Percent: 0.5, Method: 'semi' });
        expect(SampleAfterTimeout(sample, 8_000_000, ['ID'])).toBeNull();
    });

    it('floors at 20k rows on smaller tables, and cannot sample without a key', () => {
        expect(FloorPercent(100_000)).toBe(20);
        expect(FloorPercent(10_000)).toBe(100);
        expect(SampleAfterTimeout(null, 10_000, ['ID'])).toBeNull();
        expect(SampleAfterTimeout(null, 8_000_000, [])).toBeNull();
    });
});

describe('ClassifyFailure', () => {
    it('recognizes every timeout shape', () => {
        expect(ClassifyFailure(new Error('Query timeout exceeded'))).toBe('timeout');
        expect(ClassifyFailure(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).toBe('timeout');
        expect(ClassifyFailure(Object.assign(new Error('Timeout: Request failed to complete in 30000ms'), { code: 'ETIMEOUT' }))).toBe('timeout');
        expect(ClassifyFailure(Object.assign(new Error('wrapped'), { originalError: { code: 'ECANCEL' } }))).toBe('timeout');
    });

    it('treats permissions, missing objects and bad SQL as errors, not timeouts', () => {
        expect(ClassifyFailure(new Error("The SELECT permission was denied on the object 'Invoice'"))).toBe('error');
        expect(ClassifyFailure(Object.assign(new Error('permission denied for table invoice'), { code: '42501' }))).toBe('error');
        expect(ClassifyFailure(new Error("Invalid column name 'Status'."))).toBe('error');
    });

    it('backs off 5 min → 30 min → 2 h → 12 h → 24 h, capped', () => {
        expect([1, 2, 3, 4, 5, 9].map(BackoffMs)).toEqual([300_000, 1_800_000, 7_200_000, 43_200_000, 86_400_000, 86_400_000]);
    });
});

describe('reading the aggregates', () => {
    const row = {
        __rows: 10_000,
        c0: 10_000,
        c1: 9_000, n1: '0', x1: '1', z1: 8_996, g1: 0,
        c2: 10_000, n2: '2013-01-15 00:00:00.0000000', x2: '2030-06-30 13:45:00.0000000', s2: 8_500,
        c3: 10_000, b3: 7_500, lx3: 12, la3: 4.26,
        c4: 0,
    };

    it('never rounds a share to exactly 0 or 1 unless it is', () => {
        expect(SafeShare(4, 10_000)).toBe(0.001);
        expect(SafeShare(9_996, 10_000)).toBe(0.999);
        expect(SafeShare(0, 10_000)).toBe(0);
        expect(SafeShare(10_000, 10_000)).toBe(1);
    });

    it('reads shares of non-null values, effective coverage of rows, and dates without fractions', () => {
        const [id, amount, date, status, notes] = ReadMainRow(row, COLUMNS, COLUMNS, null).map(e => e.Column);
        expect(id).toMatchObject({ Coverage: 1, CoverageSource: 'scan' });
        expect(amount).toMatchObject({ Coverage: 0.9, Min: 0, Max: 1, ZeroShare: 0.999, NegativeShare: 0 });
        expect(date).toMatchObject({ Min: '2013-01-15', Max: '2030-06-30T13:45:00', SentinelShare: 0.85 });
        expect(status).toMatchObject({ Coverage: 1, EffectiveCoverage: 0.25, BlankShare: 0.75, Length: { Max: 12, Avg: 4.3 } });
        expect(notes).toEqual({ Name: 'Notes', Type: 'nvarchar', Coverage: 0, CoverageSource: 'scan' });
    });

    it('labels sampled statistics as such', () => {
        expect(ReadMainRow(row, COLUMNS, COLUMNS, { Percent: 5, Method: 'hash' })[0].Column.CoverageSource).toBe('sample');
    });

    it('counts rows at each date column\'s own bounds with an exact, format-independent comparison', () => {
        const exact = ReadMainRow(row, COLUMNS, COLUMNS, null);
        const bounds = DateBoundsOf(exact, COLUMNS);
        const statement = BuildExtremesStatement(SOURCE, bounds, COLUMNS, SQLSERVER, 'sqlserver', null);
        expect(statement?.SQL).toContain("[InvoiceDate] = CONVERT(DATETIME2, '2013-01-15 00:00:00.0000000', 121)");
        const byName = new Map<string, ExactColumn>(exact.map(e => [e.Column.Name, e]));
        ApplyExtremesRow({ __rows: 10_000, em2: 9_000, ex2: 1 }, bounds, COLUMNS, byName);
        expect(byName.get('InvoiceDate')?.Column.ExtremeShare).toEqual({ AtMin: 0.9, AtMax: 0.001 });
    });

    it('formats every date shape the engines print', () => {
        expect(FormatDate('2020-10-31')).toBe('2020-10-31');
        expect(FormatDate('2020-10-31 00:00:00.000')).toBe('2020-10-31');
        expect(FormatDate('2020-10-31 08:15:00+00')).toBe('2020-10-31T08:15:00');
        expect(FormatDate('0001-01-01 00:00:00')).toBe('0001-01-01');
    });
});

describe('AssembleProfile', () => {
    const table = { Rows: 10_000, RowsExact: false, ChangeCounter: 5, Bytes: null };
    const base: ProfileState = {
        EntityName: 'Invoices', Columns: COLUMNS, Exact: new Map(), DbStatistics: new Map([['Notes', { Coverage: 0.4567, NDistinct: -1 }]]),
        Table: table, RowCount: null, ComputedAtMs: Date.parse('2026-10-16T00:00:00Z'),
        ExactStatus: 'failed-error', NextAttemptAtMs: Date.parse('2026-10-16T00:30:00Z'), Stale: false,
    };

    it('serves database statistics with the exact pass\'s status while it is missing', () => {
        const profile = AssembleProfile(base);
        expect(profile).toMatchObject({
            Partial: true, ExactStatus: 'failed-error', RetryAfter: '2026-10-16T00:30:00.000Z', RowCount: 10_000, RowCountSource: 'estimate',
        });
        expect(profile.Columns.find(c => c.Name === 'Notes')).toMatchObject({ Coverage: 0.457, CoverageSource: 'dbstats', Cardinality: { Class: 'unique' } });
        expect(profile.Columns.find(c => c.Name === 'ID')).toMatchObject({ Coverage: null, CoverageSource: null });
    });

    it('reports complete, with the sample used, once every column has exact statistics', () => {
        const row = { __rows: 500, c0: 500, c1: 500, c2: 500, c3: 500, c4: 500 };
        const exact = new Map(ReadMainRow(row, COLUMNS, COLUMNS, { Percent: 5, Method: 'hash' }).map(e => [e.Column.Name, e]));
        const profile = AssembleProfile({ ...base, Exact: exact, RowCount: { Count: 10_000, Source: 'estimate' } });
        expect(profile).toMatchObject({ Partial: false, ExactStatus: 'complete', Sampled: true, SamplePercent: 5 });
        expect(profile.RetryAfter).toBeUndefined();
    });

    it('classes cardinality from n_distinct', () => {
        expect(CardinalityOf(1, 1_000, 1)?.Class).toBe('constant');
        expect(CardinalityOf(12, 1_000, 1)?.Class).toBe('low');
        expect(CardinalityOf(-0.5, 1_000, 1)).toMatchObject({ Estimate: 500, Class: 'high' });
        expect(CardinalityOf(-0.99, 1_000, 1)?.Class).toBe('unique');
        expect(CardinalityOf(50, 1_000, 1)?.Class).toBe('medium');
        expect(CardinalityOf(undefined, 1_000, 1)).toBeNull();
    });
});

describe('database statistics', () => {
    it('reads an all-NULL SQL Server column (no histogram steps) as empty, not full', () => {
        const statistics = ReadColumnStatistics([
            { name: 'Empty', stat_rows: 5_000, steps: 0, null_rows: null },
            { name: 'Half', stat_rows: 1_000, steps: 12, null_rows: 500 },
            { name: 'Full', stat_rows: 1_000, steps: 40, null_rows: null },
        ], 'sqlserver');
        expect(statistics.get('Empty')?.Coverage).toBe(0);
        expect(statistics.get('Half')?.Coverage).toBe(0.5);
        expect(statistics.get('Full')?.Coverage).toBe(1);
    });

    it('prefers the newest of several SQL Server statistics on one column', () => {
        const statistics = ReadColumnStatistics([
            { name: 'C', stat_rows: 100, steps: 3, null_rows: 90, last_updated: '2026-01-01T00:00:00Z' },
            { name: 'C', stat_rows: 100, steps: 3, null_rows: 10, last_updated: '2026-10-01T00:00:00Z' },
        ], 'sqlserver');
        expect(statistics.get('C')?.Coverage).toBe(0.9);
    });

    it('reads PostgreSQL coverage as 1 − null_frac, with n_distinct', () => {
        expect(ReadColumnStatistics([{ name: 'x', null_frac: 0.25, n_distinct: -0.5 }], 'postgresql').get('x')).toEqual({ Coverage: 0.75, NDistinct: -0.5 });
    });

    it('treats a never-analyzed PostgreSQL table as unknown, and SQL Server counts as exact', () => {
        expect(ReadTableStatistics({ rows: -1, change_counter: 3 }, 'postgresql')).toEqual({ Rows: null, RowsExact: false, ChangeCounter: 3, Bytes: null });
        expect(ReadTableStatistics({ rows: '42', bytes: '8192' }, 'sqlserver')).toEqual({ Rows: 42, RowsExact: true, ChangeCounter: null, Bytes: 8192 });
    });

    it('reads SQL Server row counts from sys.partitions, which a read-only login can see', () => {
        expect(TableStatisticsSQL('dbo', 'T', SQLSERVER, 'sqlserver')).toContain('sys.partitions');
        expect(TableStatisticsSQL('dbo', 'T', SQLSERVER, 'sqlserver')).not.toContain('dm_db_partition_stats');
    });
});

describe('RefreshReasonFor', () => {
    const base: FreshnessSample = { Rows: 1_000, ChangeCounter: 5_000 };
    const hours = (h: number) => h * 60 * 60 * 1000;

    it('does not refresh for the trickle of changes an integration sync makes', () => {
        const current = { ...base, ChangeCounter: 5_003 };
        expect(RefreshReasonFor({ AgeMs: hours(30), SchemaChanged: false, Baseline: base, Current: current })).toBeNull();
    });

    it('waits a week before refreshing on age alone', () => {
        expect(RefreshReasonFor({ AgeMs: hours(24 * 6), SchemaChanged: false, Baseline: base, Current: base })).toBeNull();
    });

    it('refreshes after enough rows changed, once the entry is old enough', () => {
        const current = { ...base, ChangeCounter: 5_000 + 1_000 * CHANGED_SHARE };
        expect(RefreshReasonFor({ AgeMs: MIN_AGE_FOR_ROW_CHANGE_MS - 1, SchemaChanged: false, Baseline: base, Current: current })).toBeNull();
        expect(RefreshReasonFor({ AgeMs: MIN_AGE_FOR_ROW_CHANGE_MS, SchemaChanged: false, Baseline: base, Current: current })).toBe('rows-changed');
    });

    it('refreshes a SQL Server entry when its row count moves enough', () => {
        const ss = { Rows: 1_000, ChangeCounter: null };
        expect(RefreshReasonFor({ AgeMs: MIN_AGE_FOR_ROW_CHANGE_MS, SchemaChanged: false, Baseline: ss, Current: { ...ss, Rows: 1_060 } })).toBe('rows-changed');
    });

    it('refreshes on age, a schema change, or a counter reset', () => {
        expect(RefreshReasonFor({ AgeMs: MAX_AGE_MS, SchemaChanged: false, Baseline: base, Current: base })).toBe('age');
        expect(RefreshReasonFor({ AgeMs: 0, SchemaChanged: true, Baseline: base, Current: base })).toBe('schema');
        expect(RefreshReasonFor({ AgeMs: 0, SchemaChanged: false, Baseline: base, Current: { ...base, ChangeCounter: 10 } })).toBe('counter-reset');
    });
});
