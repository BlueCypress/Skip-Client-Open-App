/**
 * @fileoverview Unit tests for column typing, the width cap, and the disclosure gates.
 *
 * Two properties are defended:
 *
 * **Typing is two-tier, and misclassification costs precision, never an exception.**
 * A `decimal` column that MJ metadata resolves keeps its numeric aggregates; a
 * `SUM(decimalCol)` expression — which metadata cannot reach and which the driver
 * returns as a string — degrades to count/distinct/null rather than emitting a
 * `MIN` that would fail the whole profile.
 *
 * **The width cap is never silent.** A truncated column list with no explanation
 * reads to a model as "these are all the columns", which is a worse failure than
 * not profiling at all.
 *
 * **No profile can disclose a row value.** Every statistic is a count, a ratio or
 * a numeric bound. The domain-value pass that once emitted literals was removed
 * once MJ's own `EntityFieldValue` / DBAutoDoc path was found to answer the same
 * question better, taking the whole disclosure surface with it.
 */

import { describe, it, expect } from 'vitest';
import {
    applyWidthCap,
    classifyColumns,
    type ColumnMetadataHint,
    type ProfileColumn,
} from '../../src/resolvers/profile/columnTypes.js';
import { getPrivacyPolicy } from '../../src/resolvers/profile/privacyPolicy.js';

const POLICY = getPrivacyPolicy();

function hints(entries: Record<string, ColumnMetadataHint>): Map<string, ColumnMetadataHint> {
    return new Map(Object.entries(entries));
}

describe('classifyColumns — tier 1, MJ entity metadata', () => {
    it('keeps numeric aggregates for a passthrough decimal column', () => {
        const [amount] = classifyColumns(
            ['Amount'],
            hints({ Amount: { sqlBaseType: 'decimal' } }),
            // The driver hands decimals back as strings often enough that value
            // inspection alone would reject this column. Metadata is what saves it.
            [{ Amount: '1234.56' }],
        );

        expect(amount.typeSource).toBe('metadata');
        expect(amount.type).toBe('decimal');
        expect(amount.isNumeric).toBe(true);
    });

    it('types bigint as numeric', () => {
        const [id] = classifyColumns(['RowID'], hints({ RowID: { sqlBaseType: 'bigint' } }), []);
        expect(id.isNumeric).toBe(true);
    });
});

describe('classifyColumns — tier 2, sampled values', () => {
    it('types an aggregate expression column as numeric from its values', () => {
        // COUNT(cl.ID) AS CompletionCount is an expression, so metadata resolves
        // nothing — and this is the exact column the motivating failure turned on.
        const [count] = classifyColumns(
            ['CompletionCount'],
            hints({}),
            [{ CompletionCount: 0 }, { CompletionCount: 0 }, { CompletionCount: 18 }],
        );

        expect(count.typeSource).toBe('sampled');
        expect(count.isNumeric).toBe(true);
    });

    it('degrades SUM(decimalCol) to count/distinct/null rather than throwing', () => {
        // Metadata yields nothing (expression) and the driver returns a string,
        // so both tiers decline. The residual gap is real and is documented —
        // what matters is that it costs the numeric tier, not the profile.
        const [total] = classifyColumns(['TotalAmount'], hints({}), [{ TotalAmount: '9999.00' }]);

        expect(total.isNumeric).toBe(false);
        expect(total.type).toBe('string');
        // The type-independent statistics survive, and they are the ones that
        // carry the motivating failure.
        expect(total.typeSource).toBe('sampled');
    });

    it('refuses numeric when any non-null sampled value is not a number', () => {
        const [mixed] = classifyColumns(['Mixed'], hints({}), [{ Mixed: 1 }, { Mixed: 'n/a' }]);
        expect(mixed.isNumeric).toBe(false);
    });

    it('claims nothing about a column whose sampled values are all null', () => {
        const [empty] = classifyColumns(['Unknowable'], hints({}), [{ Unknowable: null }, { Unknowable: null }]);
        expect(empty.typeSource).toBe('unresolved');
        expect(empty.isNumeric).toBe(false);
        expect(empty.isString).toBe(false);
    });
});

describe('applyWidthCap', () => {
    function numbered(count: number, isNumeric: boolean): ProfileColumn[] {
        return Array.from({ length: count }, (_, i) => ({
            name: `${isNumeric ? 'Num' : 'Str'}${i}`,
            type: isNumeric ? 'int' : 'nvarchar',
            isNumeric,
            isString: !isNumeric,
            typeSource: 'metadata' as const,
            domainDeniedReason: null,
        }));
    }

    it('passes narrow results through untouched', () => {
        const columns = numbered(5, true);
        const { profiled, skipped } = applyWidthCap(columns, POLICY);
        expect(profiled).toEqual(columns);
        expect(skipped).toEqual([]);
    });

    it('reports every dropped column with a reason', () => {
        const columns = [...numbered(3, true), ...numbered(20, false)];
        const { profiled, skipped } = applyWidthCap(columns, POLICY);

        expect(profiled).toHaveLength(POLICY.MaxProfiledColumns);
        expect(skipped).toHaveLength(columns.length - POLICY.MaxProfiledColumns);
        expect(skipped.every(s => s.reason.includes('width cap'))).toBe(true);
        expect(skipped.every(s => s.reason.includes(String(POLICY.MaxProfiledColumns)))).toBe(true);
    });

    it('keeps numeric columns first — they carry the failure this feature exists to fix', () => {
        const columns = [...numbered(20, false), ...numbered(3, true)];
        const { profiled } = applyWidthCap(columns, POLICY);
        expect(profiled.filter(c => c.isNumeric)).toHaveLength(3);
    });
});
