/**
 * @fileoverview Unit tests for the in-memory profile pass.
 *
 * A profiled test whose result fits under the in-memory limit is profiled from its own rows instead of a second run
 * of the candidate query. The statistics must be the ones the SQL aggregate pass would return: same aliases, and the
 * same comparison rules (SQL Server text compares case-insensitively and ignores trailing spaces; PostgreSQL compares
 * exactly).
 */

import { describe, it, expect } from 'vitest';
import { GetDialect } from '@memberjunction/sql-dialect';
import { buildProfileSQL, planProfileAggregates } from '../../src/resolvers/profile/buildProfileSQL.js';
import type { ProfileColumn } from '../../src/resolvers/profile/columnTypes.js';
import { computeProfileAggregatesInMemory } from '../../src/resolvers/profile/inMemoryProfile.js';
import { getPrivacyPolicy } from '../../src/resolvers/profile/privacyPolicy.js';
import { shapeProfile } from '../../src/resolvers/profile/shapeResponse.js';
import { capToRequestedRows } from '../../src/resolvers/profile/cappedRows.js';

const SQLSERVER = GetDialect('sqlserver');
const POSTGRES = GetDialect('postgresql');

function column(name: string, overrides: Partial<ProfileColumn> = {}): ProfileColumn {
    return { name, type: 'int', isNumeric: true, isString: false, isDate: false, textLength: null, typeSource: 'metadata', ...overrides };
}

const text = (name: string): ProfileColumn => column(name, { type: 'nvarchar', isNumeric: false, isString: true, textLength: 'bounded' });
const date = (name: string): ProfileColumn => column(name, { type: 'date', isNumeric: false, isDate: true });

const ROWS = [
    { Division: 'ACR', Members: 10, Amount: '12.50', EndDate: '2026-01-31T00:00:00.000Z' },
    { Division: 'acr ', Members: 0, Amount: null, EndDate: '1900-01-01T00:00:00.000Z' },
    { Division: 'ARP', Members: null, Amount: '7', EndDate: '2026-11-30T00:00:00.000Z' },
    { Division: '  ', Members: 3, Amount: '0', EndDate: null },
];
const COLUMNS = [text('Division'), column('Members'), column('Amount', { type: 'decimal' }), date('EndDate')];

describe('planProfileAggregates', () => {
    it('plans the same statistics, under the same aliases, as the SQL pass', () => {
        const plan = planProfileAggregates(COLUMNS, SQLSERVER)!;
        const sqlPlan = buildProfileSQL('SELECT 1 AS Members', COLUMNS, getPrivacyPolicy(), SQLSERVER)!;
        expect(plan.aggregates).toEqual(sqlPlan.aggregates);
        expect(plan.totalRowsAlias).toBe(sqlPlan.totalRowsAlias);
    });
});

describe('computeProfileAggregatesInMemory', () => {
    it('computes each statistic as the SQL Server pass would', () => {
        const plan = planProfileAggregates(COLUMNS, SQLSERVER)!;
        const profile = shapeProfile(computeProfileAggregatesInMemory(ROWS, plan, 'sqlserver'), plan, COLUMNS, []);

        expect(profile.stats.totalRows).toBe(4);
        // 'ACR' and 'acr ' are one value under SQL Server's default collation; '  ' is blank (`= ''` ignores trailing spaces).
        expect(profile.fields.Division).toMatchObject({ distinctCount: 3, nullCount: 0, blankCount: 1 });
        expect(profile.fields.Members).toMatchObject({ distinctCount: 3, nullCount: 1, min: 0, max: 10, nonZero: 2, zeroCount: 1 });
        // Decimals arrive from the driver as strings.
        expect(profile.fields.Amount).toMatchObject({ distinctCount: 3, nullCount: 1, min: 0, max: 12.5, nonZero: 2 });
        // 1900-01-01 is a placeholder date and stays out of the range.
        expect(profile.fields.EndDate).toMatchObject({ nullCount: 1, sentinelCount: 1, minDate: '2026-01-31', maxDate: '2026-11-30' });
    });

    it('compares text exactly on PostgreSQL, whose blank test trims both ends', () => {
        const plan = planProfileAggregates([text('Division')], POSTGRES)!;
        const profile = shapeProfile(computeProfileAggregatesInMemory(ROWS, plan, 'postgresql'), plan, [text('Division')], []);
        expect(profile.fields.Division).toMatchObject({ distinctCount: 4, blankCount: 1 });
    });

    it('reports no numeric range for a column with no values, as SQL returns NULL for MIN and MAX', () => {
        const plan = planProfileAggregates([column('Members')], SQLSERVER)!;
        const profile = shapeProfile(computeProfileAggregatesInMemory([{ Members: null }], plan, 'sqlserver'), plan, [column('Members')], []);
        expect(profile.fields.Members.min).toBeUndefined();
        expect(profile.fields.Members.max).toBeUndefined();
        expect(profile.fields.Members.nullCount).toBe(1);
    });

    it('keeps the time of a timestamp that is not midnight', () => {
        const columns = [date('ChangedAt')];
        const plan = planProfileAggregates(columns, SQLSERVER)!;
        const rows = [{ ChangedAt: '2026-11-05T03:41:51.123Z' }, { ChangedAt: '2026-11-04T00:00:00.000Z' }];
        const profile = shapeProfile(computeProfileAggregatesInMemory(rows, plan, 'sqlserver'), plan, columns, []);
        expect(profile.fields.ChangedAt).toMatchObject({ minDate: '2026-11-04', maxDate: '2026-11-05T03:41:51' });
    });
});

describe('capToRequestedRows', () => {
    it('returns only the requested rows to the caller, whatever the profile fetched', () => {
        const rows = Array.from({ length: 1002 }, (_, i) => ({ ID: i }));
        const fetched = { Success: true, Results: JSON.stringify(rows), RowCount: rows.length, ExecutionTime: 1 };
        const capped = capToRequestedRows(fetched, rows, 10);
        expect(capped.RowCount).toBe(10);
        expect(JSON.parse(capped.Results!)).toEqual(rows.slice(0, 10));
        expect(capToRequestedRows({ ...fetched, Results: JSON.stringify(rows.slice(0, 3)), RowCount: 3 }, rows.slice(0, 3), 10).RowCount).toBe(3);
    });
});
