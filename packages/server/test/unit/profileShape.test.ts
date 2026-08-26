/**
 * @fileoverview Unit tests for turning raw aggregate rows into a QueryProfile.
 *
 * Two things are being pinned down.
 *
 * **Vocabulary.** The response keys must match the `FieldSummaryInfo` /
 * `ResultLevelStats` names the Query Writer prompt already teaches. A silent
 * rename would deliver statistics under names nothing looks for, which is the
 * exact defect this feature exists to fix — so it gets an explicit assertion
 * rather than being left to review.
 *
 * **The motivating case.** Test 23's Query Writer spent seven iterations
 * "fixing" a correct query because every row it could see showed
 * `CompletionCount: 0`. The fixture below is that result set, and the assertion
 * is that a single number — `nonZero` — settles it.
 */

import { describe, it, expect } from 'vitest';
import { shapeProfile } from '../../src/resolvers/profile/shapeResponse.js';
import type { ProfileSQLPlan } from '../../src/resolvers/profile/buildProfileSQL.js';
import type { ProfileColumn } from '../../src/resolvers/profile/columnTypes.js';

const COLUMNS: ProfileColumn[] = [
    { name: 'EmployeeID', type: 'int', isNumeric: true, isString: false, typeSource: 'metadata' },
    { name: 'CompletionCount', type: 'number', isNumeric: true, isString: false, typeSource: 'sampled' },
    { name: 'Occupation', type: 'nvarchar', isNumeric: false, isString: true, typeSource: 'metadata' },
];

const PLAN: ProfileSQLPlan = {
    sql: '-- not executed in these tests',
    totalRowsAlias: 'skip_total_rows',
    aggregates: [
        { alias: 'skip_c0_distinct', column: 'EmployeeID', kind: 'distinct' },
        { alias: 'skip_c0_nulls', column: 'EmployeeID', kind: 'nulls' },
        { alias: 'skip_c1_distinct', column: 'CompletionCount', kind: 'distinct' },
        { alias: 'skip_c1_nulls', column: 'CompletionCount', kind: 'nulls' },
        { alias: 'skip_c1_min', column: 'CompletionCount', kind: 'min' },
        { alias: 'skip_c1_max', column: 'CompletionCount', kind: 'max' },
        { alias: 'skip_c1_nonzero', column: 'CompletionCount', kind: 'nonZero' },
        { alias: 'skip_c2_distinct', column: 'Occupation', kind: 'distinct' },
        { alias: 'skip_c2_nulls', column: 'Occupation', kind: 'nulls' },
    ],
    skipped: [],
};

/** Test 23's actual result set, as the profile would report it. */
const AGGREGATE_ROW: Record<string, unknown> = {
    skip_total_rows: 312,
    skip_c0_distinct: 312, skip_c0_nulls: 0,
    skip_c1_distinct: 9, skip_c1_nulls: 0, skip_c1_min: 0, skip_c1_max: 18, skip_c1_nonzero: 47,
    skip_c2_distinct: 22, skip_c2_nulls: 140,
};

describe('shapeProfile', () => {
    it('uses the FieldSummaryInfo / ResultLevelStats vocabulary exactly', () => {
        const profile = shapeProfile(AGGREGATE_ROW, PLAN, COLUMNS, []);

        expect(Object.keys(profile.stats).sort()).toEqual(['estimatedEntityCount', 'rowMultiplier', 'totalRows']);
        expect(Object.keys(profile.fields.CompletionCount).sort()).toEqual(
            ['distinctCount', 'duplicationRatio', 'hasNulls', 'max', 'min', 'nonZero', 'nullCount', 'type'],
        );
    });

    it('answers the question that cost test 23 seven iterations', () => {
        const profile = shapeProfile(AGGREGATE_ROW, PLAN, COLUMNS, []);

        // The Query Writer saw three unordered rows, all zero, and concluded the
        // join was broken. Either of these numbers refutes that on iteration 1.
        expect(profile.fields.CompletionCount.nonZero).toBe(47);
        expect(profile.fields.CompletionCount.distinctCount).toBeGreaterThan(1);
        expect(profile.fields.CompletionCount.max).toBe(18);

        // And the true cardinality is 312, not the cap of 10.
        expect(profile.stats.totalRows).toBe(312);
    });

    it('derives duplicationRatio and rowMultiplier with the same rounding as every other Skip path', () => {
        const profile = shapeProfile(AGGREGATE_ROW, PLAN, COLUMNS, []);

        expect(profile.fields.EmployeeID.duplicationRatio).toBe(0);
        expect(profile.fields.CompletionCount.duplicationRatio).toBe(0.97);
        expect(profile.stats.estimatedEntityCount).toBe(312);
        expect(profile.stats.rowMultiplier).toBe(1);
    });

    it('derives hasNulls from the real null count', () => {
        const profile = shapeProfile(AGGREGATE_ROW, PLAN, COLUMNS, []);
        expect(profile.fields.Occupation.nullCount).toBe(140);
        expect(profile.fields.Occupation.hasNulls).toBe(true);
        expect(profile.fields.EmployeeID.hasNulls).toBe(false);
    });

    it('omits the numeric tier rather than fabricating a zero when the aggregate returned NULL', () => {
        const row = { ...AGGREGATE_ROW, skip_c1_min: null, skip_c1_max: null, skip_c1_nonzero: null };
        const profile = shapeProfile(row, PLAN, COLUMNS, []);

        expect(profile.fields.CompletionCount).not.toHaveProperty('min');
        expect(profile.fields.CompletionCount).not.toHaveProperty('nonZero');
        // The type-independent statistics are unaffected.
        expect(profile.fields.CompletionCount.distinctCount).toBe(9);
    });

    it('reads decimal aggregates the driver returned as strings', () => {
        const row = { ...AGGREGATE_ROW, skip_c1_min: '0.00', skip_c1_max: '1234.56' };
        const profile = shapeProfile(row, PLAN, COLUMNS, []);

        expect(profile.fields.CompletionCount.min).toBe(0);
        expect(profile.fields.CompletionCount.max).toBe(1234.56);
    });

    it('merges skipped columns from both the width cap and the aggregate pass', () => {
        const plan: ProfileSQLPlan = { ...PLAN, skipped: [{ name: 'Notes', reason: "SQL type 'ntext' cannot be aggregated" }] };
        const profile = shapeProfile(AGGREGATE_ROW, plan, COLUMNS, [{ name: 'Extra', reason: 'width cap' }]);

        expect(profile.skippedColumns?.map(s => s.name).sort()).toEqual(['Extra', 'Notes']);
    });

    it('omits skippedColumns entirely when nothing was skipped', () => {
        expect(shapeProfile(AGGREGATE_ROW, PLAN, COLUMNS, [])).not.toHaveProperty('skippedColumns');
    });
});

