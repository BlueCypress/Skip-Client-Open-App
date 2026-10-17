/**
 * Turns aggregate rows into {@link EntityProfileColumn}s, and cached state into
 * the {@link EntityProfile} the resolver returns. Pure, so every derivation is
 * unit-testable without a database.
 */

import type {
    EntityCardinalityClass, EntityColumnCardinality, EntityCoverageSource, EntityProfile, EntityProfileColumn,
    EntityProfileExactStatus, EntityRowCountSource,
} from '@askskip/types';
import type { ProfiledColumn } from './entityColumns.js';
import { ROWS_ALIAS, StatisticAlias, type DateBounds, type StatisticKey } from './profileSQL.js';
import type { SampleSpec } from './samplingPolicy.js';
import { FormatDate } from '../shared/dialectSQL.js';

export { FormatDate };
import type { ColumnStatistic, TableStatistics } from './dbStatistics.js';

/** One column's statistics from the exact tier, with what is needed to merge and extend them. */
export interface ExactColumn {
    Column: EntityProfileColumn;
    NonNull: number;
    /** Rows counted by the statement that produced it. */
    Rows: number;
    Sample: SampleSpec | null;
    /** Date bounds as the database printed them, for the extremes statement. */
    RawMin?: string;
    RawMax?: string;
}

export interface ExactRowCount {
    Count: number;
    Source: EntityRowCountSource;
}

/** Reads one main-pass statement's row. */
export function ReadMainRow(row: Record<string, unknown>, chunk: ProfiledColumn[], all: ProfiledColumn[],
    sample: SampleSpec | null): ExactColumn[] {
    const rows = ToNumber(row[ROWS_ALIAS]) ?? 0;
    const source: EntityCoverageSource = sample ? 'sample' : 'scan';
    return chunk.map(column => {
        const value = (key: StatisticKey): unknown => row[StatisticAlias(key, all.indexOf(column))];
        const nonNull = ToNumber(value('nonNull')) ?? 0;
        const result: ExactColumn = {
            Column: {
                Name: column.Name, Type: column.Type,
                Coverage: rows > 0 ? SafeShare(nonNull, rows) : null,
                CoverageSource: rows > 0 ? source : null,
            },
            NonNull: nonNull, Rows: rows, Sample: sample,
        };
        if (nonNull > 0) addKindStatistics(result, column, value);
        return result;
    });
}

function addKindStatistics(result: ExactColumn, column: ProfiledColumn, value: (key: StatisticKey) => unknown): void {
    const out = result.Column;
    const nonNull = result.NonNull;
    const count = (key: StatisticKey): number => ToNumber(value(key)) ?? 0;
    switch (column.Kind) {
        case 'numeric':
            setIfDefined(out, 'Min', ToNumber(value('min')));
            setIfDefined(out, 'Max', ToNumber(value('max')));
            out.ZeroShare = SafeShare(count('zero'), nonNull);
            out.NegativeShare = SafeShare(count('negative'), nonNull);
            break;
        case 'date': {
            const rawMin = asText(value('min'));
            const rawMax = asText(value('max'));
            if (rawMin && rawMax) {
                out.Min = FormatDate(rawMin);
                out.Max = FormatDate(rawMax);
                result.RawMin = rawMin;
                result.RawMax = rawMax;
            }
            out.SentinelShare = SafeShare(count('sentinel'), nonNull);
            break;
        }
        case 'text': {
            const blank = count('blank');
            out.EffectiveCoverage = SafeShare(nonNull - blank, result.Rows);
            out.BlankShare = SafeShare(blank, nonNull);
            out.Length = { Max: count('maxLength'), Avg: Math.round((ToNumber(value('avgLength')) ?? 0) * 10) / 10 };
            break;
        }
        case 'other':
            break;
    }
}

/** Date columns whose bounds the extremes statement should count. */
export function DateBoundsOf(exact: Iterable<ExactColumn>, all: ProfiledColumn[]): DateBounds[] {
    const byName = new Map(all.map(c => [c.Name, c]));
    const bounds: DateBounds[] = [];
    for (const e of exact) {
        const column = byName.get(e.Column.Name);
        if (column?.Kind === 'date' && e.RawMin && e.RawMax) bounds.push({ Column: column, RawMin: e.RawMin, RawMax: e.RawMax });
    }
    return bounds;
}

/** Adds `ExtremeShare` from the extremes statement's row. */
export function ApplyExtremesRow(row: Record<string, unknown>, bounds: DateBounds[], all: ProfiledColumn[],
    exact: Map<string, ExactColumn>): void {
    const rows = ToNumber(row[ROWS_ALIAS]) ?? 0;
    for (const b of bounds) {
        const entry = exact.get(b.Column.Name);
        if (!entry || rows <= 0) continue;
        // The extremes statement may run at a different sample than the main pass; scale to its own rows.
        const nonNull = entry.Rows > 0 ? entry.NonNull * rows / entry.Rows : 0;
        if (nonNull <= 0) continue;
        const index = all.indexOf(b.Column);
        entry.Column.ExtremeShare = {
            AtMin: SafeShare(Math.min(ToNumber(row[StatisticAlias('atMin', index)]) ?? 0, nonNull), nonNull),
            AtMax: SafeShare(Math.min(ToNumber(row[StatisticAlias('atMax', index)]) ?? 0, nonNull), nonNull),
        };
    }
}

/**
 * Adds `Cardinality` from one approximate-distinct statement's row. Over a sample, the class
 * is judged from the sample's own ratios (a key is still ~100% distinct in a sample), and the
 * estimate is scaled only for unique and high-cardinality columns; for the rest the sample's
 * count is kept, a lower bound.
 */
export function ApplyCardinalityRow(row: Record<string, unknown>, chunk: ProfiledColumn[], all: ProfiledColumn[],
    exact: Map<string, ExactColumn>, sample: SampleSpec | null, fraction: number): void {
    const rows = ToNumber(row[ROWS_ALIAS]) ?? 0;
    for (const column of chunk) {
        const entry = exact.get(column.Name);
        const index = all.indexOf(column);
        const distinct = ToNumber(row[StatisticAlias('approxDistinct', index)]);
        const nonNull = ToNumber(row[StatisticAlias('nonNull', index)]) ?? 0;
        if (!entry || distinct === null || nonNull <= 0) continue;
        const sampleClass = CardinalityClassFor(distinct, nonNull, rows);
        const scale = sample && (sampleClass === 'unique' || sampleClass === 'high') && fraction > 0 ? 1 / fraction : 1;
        entry.Column.Cardinality = { Estimate: Math.round(distinct * scale), Source: sample ? 'sample' : 'approx', Class: sampleClass };
    }
}

export interface ProfileState {
    EntityName: string;
    Columns: ProfiledColumn[];
    Exact: Map<string, ExactColumn>;
    DbStatistics: Map<string, ColumnStatistic>;
    Table: TableStatistics;
    RowCount: ExactRowCount | null;
    ComputedAtMs: number;
    ExactStatus: EntityProfileExactStatus;
    NextAttemptAtMs: number | null;
    Stale: boolean;
}

/** The profile the resolver returns, from whatever the cache holds now. */
export function AssembleProfile(state: ProfileState): EntityProfile {
    const rowCount = state.RowCount
        ?? (state.Table.Rows === null ? null : { Count: state.Table.Rows, Source: state.Table.RowsExact ? 'exact' as const : 'estimate' as const });
    const columns = state.Columns.map(c => assembleColumn(c, state, rowCount?.Count ?? null));
    const samples = [...state.Exact.values()].map(e => e.Sample).filter((s): s is SampleSpec => s !== null);
    const partial = state.Columns.some(c => !state.Exact.has(c.Name));
    const status: EntityProfileExactStatus = partial ? state.ExactStatus : 'complete';
    return {
        EntityName: state.EntityName,
        RowCount: rowCount?.Count ?? null,
        RowCountSource: rowCount?.Source ?? null,
        ComputedAt: new Date(state.ComputedAtMs).toISOString(),
        Sampled: samples.length > 0,
        ...(samples.length > 0 && { SamplePercent: Math.min(...samples.map(s => s.Percent)) }),
        Partial: partial,
        Stale: state.Stale,
        ExactStatus: status,
        ...(status !== 'complete' && state.NextAttemptAtMs !== null && { RetryAfter: new Date(state.NextAttemptAtMs).toISOString() }),
        Columns: columns,
    };
}

function assembleColumn(column: ProfiledColumn, state: ProfileState, rows: number | null): EntityProfileColumn {
    const exact = state.Exact.get(column.Name);
    const statistic = state.DbStatistics.get(column.Name);
    const result: EntityProfileColumn = exact
        ? { ...exact.Column }
        : {
            Name: column.Name, Type: column.Type,
            Coverage: statistic?.Coverage === undefined ? null : Math.round(statistic.Coverage * 1000) / 1000,
            CoverageSource: statistic?.Coverage === undefined ? null : 'dbstats',
        };
    const cardinality = result.Cardinality ? null : CardinalityOf(statistic?.NDistinct, rows, result.Coverage);
    if (cardinality) result.Cardinality = cardinality;
    return result;
}

/**
 * Cardinality from PostgreSQL's `n_distinct`: positive is a count, negative a
 * fraction of rows (-1 = every row distinct).
 */
export function CardinalityOf(nDistinct: number | undefined, rows: number | null, coverage: number | null): EntityColumnCardinality | null {
    if (nDistinct === undefined || nDistinct === 0) return null;
    if (nDistinct < 0 && (rows === null || rows <= 0)) return null;
    const estimate = nDistinct > 0 ? nDistinct : Math.round(-nDistinct * (rows ?? 0));
    const nonNull = rows !== null && coverage !== null ? rows * coverage : null;
    return { Estimate: estimate, Source: 'dbstats', Class: CardinalityClassFor(estimate, nonNull, rows, nDistinct === -1) };
}

export function CardinalityClassFor(estimate: number, nonNull: number | null, rows: number | null, allDistinct = false): EntityCardinalityClass {
    if (allDistinct) return 'unique';
    if (estimate <= 1) return 'constant';
    if (estimate <= 20) return 'low';
    if (nonNull !== null && nonNull > 0 && estimate >= 0.98 * nonNull) return 'unique';
    if (rows !== null && rows > 0 && estimate >= 0.1 * rows) return 'high';
    return 'medium';
}

/**
 * `part / whole` to 3 decimals, never rounded to exactly 0 or 1 unless it is:
 * "all zero" and "empty" are claims an agent acts on, so 4 non-zero rows in
 * 10,000 must not read as none.
 */
export function SafeShare(part: number, whole: number): number {
    if (whole <= 0) return 0;
    const share = Math.min(1, Math.max(0, part / whole));
    const rounded = Math.round(share * 1000) / 1000;
    if (rounded === 0 && part > 0) return 0.001;
    if (rounded === 1 && part < whole) return 0.999;
    return rounded;
}

export function ToNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return Number(value);
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function asText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

function setIfDefined(target: EntityProfileColumn, key: 'Min' | 'Max', value: number | null): void {
    if (value !== null) target[key] = value;
}
