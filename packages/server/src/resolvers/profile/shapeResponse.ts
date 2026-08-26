/**
 * Turns the raw aggregate rows into the {@link QueryProfile} the caller consumes.
 *
 * Key names here are load-bearing. They match the `FieldSummaryInfo` /
 * `ResultLevelStats` vocabulary that Skip's Query Writer prompt already teaches,
 * and the derived statistics reuse that implementation's exact rounding. A
 * rename would deliver statistics under names the prompt does not know to look
 * for, which is precisely the defect this whole feature exists to fix.
 *
 * Pure, so the derivations are unit-testable without a database.
 */

import type {
    ProfileFieldSummary,
    ProfileSkippedColumn,
    QueryProfile,
} from '@askskip/types';
import type { ProfileColumn } from './columnTypes.js';
import type { ProfileSQLPlan } from './buildProfileSQL.js';

/** Per-column statistics keyed by column name. */
type FieldMap = Record<string, ProfileFieldSummary>;

/**
 * Assembles the profile from the aggregate pass.
 *
 * One pass, one query. An earlier design ran a second pass to attach literal
 * `domainValues` for low-cardinality columns; it was removed once MJ's own
 * `EntityFieldValue` path proved to answer that question better and for free.
 */
export function shapeProfile(
    aggregateRow: Record<string, unknown>,
    plan: ProfileSQLPlan,
    columns: ProfileColumn[],
    skippedColumns: ProfileSkippedColumn[],
): QueryProfile {
    const totalRows = toInteger(aggregateRow[plan.totalRowsAlias]) ?? 0;
    const byColumn = groupAggregatesByColumn(aggregateRow, plan);
    const typeByColumn = new Map(columns.map(c => [c.name, c.type]));

    const fields: FieldMap = {};
    for (const [name, stats] of byColumn) {
        fields[name] = buildFieldSummary(typeByColumn.get(name) ?? 'unknown', stats, totalRows);
    }

    const allSkipped = [...skippedColumns, ...plan.skipped];

    return {
        fields,
        stats: buildResultStats(fields, totalRows),
        ...(allSkipped.length > 0 && { skippedColumns: allSkipped }),
    };
}

/** Raw per-column aggregate values, before derivation. */
interface RawColumnStats {
    distinct?: number;
    nulls?: number;
    min?: number;
    max?: number;
    nonZero?: number;
}

function groupAggregatesByColumn(
    row: Record<string, unknown>,
    plan: ProfileSQLPlan,
): Map<string, RawColumnStats> {
    const byColumn = new Map<string, RawColumnStats>();

    for (const aggregate of plan.aggregates) {
        const stats = byColumn.get(aggregate.column) ?? {};
        const value = aggregate.kind === 'min' || aggregate.kind === 'max'
            ? toNumber(row[aggregate.alias])
            : toInteger(row[aggregate.alias]);

        if (value != null) stats[aggregate.kind] = value;
        byColumn.set(aggregate.column, stats);
    }

    return byColumn;
}

function buildFieldSummary(type: string, stats: RawColumnStats, totalRows: number): ProfileFieldSummary {
    const distinctCount = stats.distinct ?? 0;
    const nullCount = stats.nulls ?? 0;

    const summary: ProfileFieldSummary = {
        type,
        distinctCount,
        nullCount,
        hasNulls: nullCount > 0,
        // Matches BaseClientAction.computeResultStats' rounding so the number the
        // model sees has the same shape it does on every other Skip path.
        duplicationRatio: totalRows > 0
            ? Math.round((1 - distinctCount / totalRows) * 100) / 100
            : 0,
    };

    // The numeric tier is emitted only when the aggregate pass actually returned
    // it — a numeric column over zero matching rows yields SQL NULL for MIN/MAX,
    // and claiming `min: 0` there would be a fabrication.
    if (stats.min != null) summary.min = stats.min;
    if (stats.max != null) summary.max = stats.max;
    if (stats.nonZero != null) summary.nonZero = stats.nonZero;

    return summary;
}

/**
 * Derives the result-level statistics, reusing the ID-column heuristic from
 * `BaseClientAction.computeResultStats` so `rowMultiplier` means the same thing
 * everywhere it appears.
 */
function buildResultStats(fields: FieldMap, totalRows: number): QueryProfile['stats'] {
    const idColumn = Object.keys(fields).find(name => /Id$/i.test(name));
    const estimatedEntityCount = idColumn ? fields[idColumn].distinctCount : totalRows;

    return {
        totalRows,
        estimatedEntityCount,
        rowMultiplier: estimatedEntityCount > 0
            ? Math.round((totalRows / estimatedEntityCount) * 10) / 10
            : 1,
    };
}


/**
 * Coerces a driver-returned value to a finite number.
 *
 * `decimal`, `bigint` and `money` columns come back from the SQL Server driver
 * as strings often enough that treating a string as "not a number" would silently
 * drop the numeric tier on exactly the columns it matters most for.
 */
function toNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toInteger(value: unknown): number | null {
    const parsed = toNumber(value);
    return parsed == null ? null : Math.trunc(parsed);
}
