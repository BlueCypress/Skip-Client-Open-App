/**
 * Shared contract for the `ProfileEntityFields` GraphQL operation.
 *
 * `ProfileEntityFields` returns statistics about one entity, read through its
 * BaseView: its row count and, per column, the share of rows that hold a value
 * ("coverage"), plus the few cheap facts that catch populated-but-useless
 * columns — blank text, all-zero numbers, placeholder dates — and bounds for
 * date and numeric columns. Skip's Data Expert uses them to stop choosing
 * columns that hold nothing and to stop spending Query Writer turns
 * rediscovering row counts and date ranges.
 *
 * Every figure is a count, a ratio, a length or a date/numeric bound computed by
 * the server from MJ metadata. The caller names an entity, never a column or
 * SQL, and no text value, histogram value or most-common value is ever returned.
 *
 * Shares named `…Share` are of the column's **non-null** values; `Coverage` and
 * `EffectiveCoverage` are of all rows. Shares and coverage are rounded to 3
 * decimals, but never to exactly 0 or 1 unless the count is exactly 0 or all.
 */

/** Where a row count came from. `estimate` is a planner statistic or a scaled sample and can be several percent off. */
export type EntityRowCountSource = 'exact' | 'estimate';

/**
 * Where a column's statistics came from.
 * - `scan`: a full aggregate over the BaseView.
 * - `sample`: the same aggregate over a sample of the rows.
 * - `dbstats`: the database's own statistics (PostgreSQL `pg_stats`, a SQL Server histogram); coverage only.
 */
export type EntityCoverageSource = 'scan' | 'sample' | 'dbstats';

/** Why a profile could not be produced. */
export type EntityProfileUnavailableReason = 'not-found' | 'not-authorized' | 'no-base-table' | 'error';

/**
 * State of the exact pass.
 * - `pending`: running, or scheduled to run again (see `RetryAfter`); database statistics are shown meanwhile.
 * - `complete`: every column has exact or sampled statistics.
 * - `gave-up-timeout`: the pass timed out even at the smallest sample; it will not be retried before `RetryAfter`.
 * - `failed-error`: the pass failed for a reason other than time (permissions, a dropped column); retried after `RetryAfter`.
 */
export type EntityProfileExactStatus = 'pending' | 'complete' | 'gave-up-timeout' | 'failed-error';

/** Order-of-magnitude distinct-value class; `unique` marks a likely key. */
export type EntityCardinalityClass = 'constant' | 'low' | 'medium' | 'high' | 'unique';

export interface EntityColumnCardinality {
    /** Estimated distinct non-null values. For the record; agents should read `Class`. */
    Estimate: number;
    Source: 'dbstats' | 'approx' | 'sample';
    /** `low` ≤ 20 values, `high` ≥ 10% of rows, `unique` ≥ 98% of the non-null count. */
    Class: EntityCardinalityClass;
}

export interface EntityColumnLength {
    /** Longest value, in characters. */
    Max: number;
    /** Mean length of the non-null values, in characters, rounded to one decimal. */
    Avg: number;
}

export interface EntityColumnExtremeShare {
    /** Share of non-null values equal to `Min`. */
    AtMin: number;
    /** Share of non-null values equal to `Max`. */
    AtMax: number;
}

export interface EntityProfileColumn {
    Name: string;
    /** The column's SQL base type from MJ metadata. */
    Type: string;
    /**
     * Share of rows holding a value, 0–1. `null` when no statistic covers the
     * column yet. A sampled or `dbstats` zero means "under 0.1% of rows", not
     * "empty".
     */
    Coverage: number | null;
    CoverageSource: EntityCoverageSource | null;
    /** Bounded text only: share of rows holding a non-blank value. */
    EffectiveCoverage?: number;
    /** Bounded text only: share of values that are empty or whitespace. */
    BlankShare?: number;
    /** Bounded text only. */
    Length?: EntityColumnLength;
    /** Numeric only: share of values equal to 0. With `Min` 0 and `Max` 1 this reads a 0/1 flag. */
    ZeroShare?: number;
    /** Numeric only: share of values below 0. */
    NegativeShare?: number;
    /** Date only: share of values that are placeholders (before 1901, from 2100, or 1970-01-01). */
    SentinelShare?: number;
    /** Date only: share of values at the column's own `Min` and `Max`; a large share marks a placeholder of any value. */
    ExtremeShare?: EntityColumnExtremeShare;
    Cardinality?: EntityColumnCardinality;
    /**
     * Smallest value — date and numeric columns only, and only from a scan or
     * sample. Dates exclude placeholders and read `YYYY-MM-DD` (with `THH:MM:SS`
     * when not midnight).
     */
    Min?: number | string;
    /** Largest value; as `Min`. */
    Max?: number | string;
}

export interface EntityProfile {
    EntityName: string;
    RowCount: number | null;
    RowCountSource: EntityRowCountSource | null;
    /** ISO 8601 time the statistics were computed. */
    ComputedAt: string;
    /** True when any column's statistics came from a sample of the rows. */
    Sampled: boolean;
    /** The smallest sample percentage used, when `Sampled`. */
    SamplePercent?: number;
    /** True when some columns have only database statistics; see `ExactStatus`. */
    Partial: boolean;
    /** True when the entry is past its refresh rule and a refresh has been started. */
    Stale: boolean;
    /** Absent from servers that predate it; treat absence as `complete` when `Partial` is false, else `pending`. */
    ExactStatus?: EntityProfileExactStatus;
    /** ISO 8601 time of the next exact attempt, when `ExactStatus` is not `complete`. */
    RetryAfter?: string;
    Columns: EntityProfileColumn[];
}

export interface ProfileEntityFieldsInput {
    EntityName: string;
    /**
     * How long to wait for the exact pass when nothing exact is cached yet, in
     * milliseconds. Default 2,000; capped at 10,000. When it runs longer, the
     * database-statistics tier is returned and the exact pass fills the cache for
     * the next caller.
     */
    WaitMs?: number;
}

export interface ProfileEntityFieldsResult {
    Success: boolean;
    /** JSON-stringified {@link EntityProfile}. */
    Profile?: string;
    ErrorMessage?: string;
    UnavailableReason?: EntityProfileUnavailableReason;
}
