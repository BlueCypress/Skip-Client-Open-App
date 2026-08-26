/**
 * Two-tier column typing for query profiling.
 *
 * Typing exists for one reason: `MIN(col)` is invalid SQL against a text column,
 * so the profile SQL builder must know a column is numeric *before* it writes
 * that expression. The sampled rows are used only to decide which aggregate
 * expressions are legal to emit — they never contribute a value to the output.
 * Every statistic that is emitted is computed over the full uncapped result set.
 *
 * **Tier 1 — MJ entity metadata, authoritative.** `EnrichFieldTypesFromEntityMetadata`
 * matches the parsed SELECT columns against entity field metadata and yields a
 * real `sqlBaseType` (`int`, `decimal`, `nvarchar`, …). This resolves the
 * `decimal` / `bigint` hazard outright for every column it covers, and it is the
 * only tier that can supply sensitivity metadata.
 *
 * **Tier 2 — sampled values, fallback.** Metadata cannot type expression columns
 * (`COUNT(cl.ID) AS CompletionCount` is an expression, and that is exactly the
 * column the motivating failure turned on), `SELECT *`, or columns sourced from
 * CTEs and derived tables. A column types as numeric here only when *every*
 * non-null sampled value is a JavaScript number.
 *
 * Misclassification therefore costs precision, never correctness and never an
 * exception. An unresolved column still gets `distinctCount` and `nullCount`,
 * which are type-independent and carry the motivating failure on their own.
 *
 * One residual gap survives both tiers: `SUM(SomeDecimalCol)` is an expression,
 * so metadata yields nothing, and the driver returns it as a string, so value
 * inspection rejects it. It degrades to count/distinct/null. Recorded here so it
 * is not rediscovered as a bug.
 */

import { IsNumericSQLType, IsStringSQLType } from '@memberjunction/sql-dialect';
import type { PrivacyPolicy } from './privacyPolicy.js';

/** How a column's type was established. Surfaced in `skippedColumns` reasons. */
export type ColumnTypeSource = 'metadata' | 'sampled' | 'unresolved';

/** A column the profile knows enough about to emit aggregates for. */
export interface ProfileColumn {
    /** The column name exactly as it appears in the executed result's row keys. */
    name: string;
    /** SQL base type when metadata resolved it, otherwise a JavaScript `typeof`. */
    type: string;
    /** Whether `MIN` / `MAX` / non-zero counts are legal to emit. */
    isNumeric: boolean;
    /** Whether the column holds character data — gates domain-value eligibility. */
    isString: boolean;
    typeSource: ColumnTypeSource;
}

/** Everything the pure classifier needs to know about one column from the metadata tier. */
export interface ColumnMetadataHint {
    sqlBaseType: string | null;
}

/**
 * Classifies every result column, metadata first and sampled values second.
 *
 * Pure: no database, no MJ metadata provider. `hints` carries whatever tier 1
 * managed to resolve; a column absent from `hints` (or present with a null
 * `sqlBaseType`) falls through to value inspection.
 */
export function classifyColumns(
    columnNames: string[],
    hints: Map<string, ColumnMetadataHint>,
    sampleRows: Record<string, unknown>[],
): ProfileColumn[] {
    return columnNames.map(name => {
        const hint = hints.get(name) ?? null;
        const sqlBaseType = hint?.sqlBaseType ?? null;

        if (sqlBaseType) {
            return {
                name,
                type: sqlBaseType,
                isNumeric: IsNumericSQLType(sqlBaseType),
                isString: IsStringSQLType(sqlBaseType),
                typeSource: 'metadata',
            };
        }

        const sampled = classifyFromSamples(name, sampleRows);
        return {
            name,
            type: sampled.type,
            isNumeric: sampled.isNumeric,
            isString: sampled.isString,
            typeSource: sampled.type === 'unknown' ? 'unresolved' : 'sampled',
        };
    });
}

/**
 * Types a column from the values that came back in the capped result.
 *
 * Numeric requires *every* non-null sampled value to be a JavaScript number —
 * one string is enough to disqualify the column, because emitting `MIN` against
 * it would fail the whole profile rather than just that column. A column whose
 * sampled values are all null stays unknown: nothing was observed, so nothing is
 * claimed.
 */
function classifyFromSamples(
    name: string,
    rows: Record<string, unknown>[],
): { type: string; isNumeric: boolean; isString: boolean } {
    const values = rows.map(r => r[name]).filter(v => v !== null && v !== undefined);
    if (values.length === 0) {
        return { type: 'unknown', isNumeric: false, isString: false };
    }

    if (values.every(v => typeof v === 'number' && Number.isFinite(v))) {
        return { type: 'number', isNumeric: true, isString: false };
    }
    if (values.every(v => typeof v === 'string')) {
        return { type: 'string', isNumeric: false, isString: true };
    }
    if (values.every(v => typeof v === 'boolean')) {
        return { type: 'boolean', isNumeric: false, isString: false };
    }
    if (values.every(v => v instanceof Date)) {
        return { type: 'date', isNumeric: false, isString: false };
    }

    return { type: typeof values[0], isNumeric: false, isString: false };
}

/**
 * Applies the width cap (D2), keeping numeric columns first.
 *
 * Numeric columns are prioritised because they carry the failure this whole
 * feature exists to fix — a per-row aggregate that looks like zero everywhere in
 * an unordered ten-row preview. Everything dropped is reported with a reason:
 * a silently truncated column list reads to a model as "these are all the
 * columns", which is a worse failure than not profiling at all.
 */
export function applyWidthCap(
    columns: ProfileColumn[],
    policy: PrivacyPolicy,
): { profiled: ProfileColumn[]; skipped: { name: string; reason: string }[] } {
    if (columns.length <= policy.MaxProfiledColumns) {
        return { profiled: columns, skipped: [] };
    }

    const ordered = [...columns].sort((a, b) => Number(b.isNumeric) - Number(a.isNumeric));
    const profiled = ordered.slice(0, policy.MaxProfiledColumns);
    const kept = new Set(profiled.map(c => c.name));

    const reason = `width cap: the result has ${columns.length} columns and profiling is limited to `
        + `${policy.MaxProfiledColumns} (numeric columns are kept first)`;

    // Report in the result's own column order, not the prioritised order — the
    // caller reads this alongside its own sample rows.
    const skipped = columns.filter(c => !kept.has(c.name)).map(c => ({ name: c.name, reason }));

    return { profiled, skipped };
}

