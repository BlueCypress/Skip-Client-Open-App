/**
 * Shared contract for the `TestAndProfileQuerySQL` GraphQL operation.
 *
 * `TestAndProfileQuerySQL` is a Skip-owned resolver that lives in this app's
 * server package and is merged into the host MJServer schema via
 * `SkipMiddleware.GetResolverPaths()`. It executes a transient query spec exactly
 * as MJ's own `TestQuerySQL` does, and — when `Profile` is set — additionally
 * runs a deterministically-generated aggregate query over the **uncapped** result
 * set inside the client's own database.
 *
 * The point of profiling is that only integers cross the wire. The caller learns
 * the true cardinality, per-column distinct/null counts, and numeric ranges of a
 * result set it is otherwise only allowed to see ten capped rows of.
 *
 * These are plain interfaces on purpose. The resolver's TypeGraphQL classes
 * `implement` them, so the two definitions cannot drift without failing the
 * build — the guarantee that a hand-maintained mirror does not give. TypeGraphQL
 * decorators cannot live here: this package must not take a `type-graphql`
 * dependency, since MJ Explorer and the Skip API both consume it.
 */

/**
 * Inline dependency query used to resolve a `{{query:"..."}}` composition token
 * without the dependency having been saved. Mirrors MJ's
 * `QueryDependencySpecInput`; self-referencing to support dependency trees.
 */
export interface QueryDependencySpecInput {
    /** Query name as referenced in the composition token. */
    Name: string;
    /** Category path as referenced in the composition token (e.g. "/Analytics/Sales/"). */
    CategoryPath: string;
    /** The raw SQL for this dependency. */
    SQL: string;
    /** Whether this dependency uses Nunjucks template syntax. */
    UsesTemplate?: boolean;
    /** Parameters for this dependency's Nunjucks templates. */
    Parameters?: Record<string, string>;
    /** Nested dependencies (recursive). */
    Dependencies?: QueryDependencySpecInput[];
}

/**
 * Per-column statistics computed over the FULL, uncapped result set.
 *
 * Key names deliberately match the `FieldSummaryInfo` vocabulary that Skip's
 * Query Writer prompt already teaches. Renaming any of them silently restores
 * the defect this operation exists to fix: statistics arriving under names the
 * prompt does not know to look for.
 *
 * `maxFrequency` is intentionally absent. It requires a grouped aggregation per
 * column and was measured at ~8.4x the cost of the equivalent distinct counts,
 * enough on its own to reach the statement timeout on an ordinary rollup.
 *
 * Literal column values are absent too, and deliberately: MJ already supplies a
 * column's possible values through `__mj.EntityFieldValue` (CHECK constraints
 * plus DBAutoDoc enum detection), which `SkipSDK.packFieldValues` ships in every
 * Skip request payload. Every field below is a count, a ratio or a numeric
 * bound, so a profile cannot disclose a row value.
 */
export interface ProfileFieldSummary {
    /**
     * The column's resolved type. A SQL base type (`int`, `decimal`, `nvarchar`)
     * when MJ entity metadata resolved the column, otherwise a JavaScript typeof
     * inferred from the sampled rows.
     */
    type: string;
    /** `COUNT(DISTINCT col)` over the full result set. */
    distinctCount: number;
    /** `SUM(CASE WHEN col IS NULL THEN 1 ELSE 0 END)` over the full result set. */
    nullCount: number;
    /** Derived from `nullCount`; retained because existing prompt guidance uses it. */
    hasNulls: boolean;
    /** `1 - distinctCount / totalRows`. 0 = all unique, 1 = all one value. */
    duplicationRatio: number;
    /** Mean character length. Present only for columns typed as strings. */
    avgLength?: number;
    /** Numeric tier — present only when the column typed as numeric. */
    min?: number;
    /** Numeric tier — present only when the column typed as numeric. */
    max?: number;
    /**
     * Numeric tier — how many rows have a non-zero, non-null value.
     * This is the statistic that distinguishes "the join is broken" from
     * "most rows legitimately aggregate to zero".
     */
    nonZero?: number;
}

/** Result-level statistics computed over the FULL, uncapped result set. */
export interface ProfileResultStats {
    /** True row count. Not the `MaxRows` cap. */
    totalRows: number;
    /** Distinct count of the first ID-shaped column, or `totalRows` if there is none. */
    estimatedEntityCount: number;
    /** `totalRows / estimatedEntityCount`. Above ~2.0 suggests JOIN row multiplication. */
    rowMultiplier: number;
}

/** A column the profile deliberately did not describe, and why. */
export interface ProfileSkippedColumn {
    name: string;
    reason: string;
}

/**
 * The full profile. Crosses the wire as a JSON string on
 * {@link TestAndProfileQuerySQLResult.Profile}, matching how `Results` and
 * `AppliedParameters` are already handled.
 */
export interface QueryProfile {
    fields: Record<string, ProfileFieldSummary>;
    stats: ProfileResultStats;
    /**
     * Columns omitted by the width cap or otherwise not profiled, each with a
     * reason. Never silent: a truncated column list with no explanation reads to
     * a model as "these are all the columns".
     */
    skippedColumns?: ProfileSkippedColumn[];
}

/**
 * Why a requested profile did not arrive. Reported instead of silence so a
 * caller can tell "statistics were attempted and failed" from "statistics were
 * never requested" — the latter reads as "no problems found".
 *
 * - `not-authorized` — the API key lacks the `query:profile` scope. Profiling is
 *   scoped separately from `query:test` precisely so it can be revoked on its
 *   own, so this is a configuration answer rather than a failure.
 * - `zero-rows` — the result was empty, so there is no column metadata to
 *   profile and nothing a profile could say that the row count does not.
 * - `unparseable` — the candidate SQL could not be safely rewritten into an
 *   aggregate query. A refusal, not an error.
 * - `timeout` / `error` — the profile query itself did not complete.
 */
export type ProfileUnavailableReason =
    | 'not-authorized'
    | 'timeout'
    | 'zero-rows'
    | 'unparseable'
    | 'error';

/**
 * Input to `TestAndProfileQuerySQL`. A superset of MJ's `TestQuerySQLInput`:
 * every field but `Profile` has identical meaning and identical defaults.
 */
export interface TestAndProfileQuerySQLInput {
    /** The raw SQL — may contain `{{query:"..."}}` and `{{ param }}` tokens. */
    SQL: string;
    /** Parameter values for Nunjucks template substitution. */
    Parameters?: Record<string, string>;
    /** Whether this query uses Nunjucks template syntax. */
    UsesTemplate?: boolean;
    /** Inline dependency queries for composition resolution. */
    Dependencies?: QueryDependencySpecInput[];
    /** Max rows to return. Caps `Results` only; the profile is computed uncapped. */
    MaxRows?: number;
    /**
     * Opt in to profiling. Absent or false behaves byte-identically to
     * `TestQuerySQL` — no uncapped scan, no extra scope check, no `Profile` field
     * on the response.
     */
    Profile?: boolean;
}

/**
 * Result of `TestAndProfileQuerySQL`.
 *
 * The test leg's fields mirror MJ's `TestQuerySQLResult` exactly, including
 * `RenderedSQL` — which MJ returns and Skip's hand-written client type has
 * historically dropped. Sharing one definition is what stops that recurring.
 */
export interface TestAndProfileQuerySQLResult {
    Success: boolean;
    /** JSON-stringified result rows, capped at `MaxRows`. */
    Results?: string;
    /** Number of rows returned, i.e. after the cap. See `Profile.stats.totalRows` for the true count. */
    RowCount: number;
    ExecutionTime: number;
    ErrorMessage?: string;
    /** JSON-stringified applied parameters, including defaults. */
    AppliedParameters?: string;
    /** The fully rendered SQL that was executed. */
    RenderedSQL?: string;
    /** JSON-stringified {@link QueryProfile}. Absent when not requested or not obtainable. */
    Profile?: string;
    /** Set instead of `Profile` when profiling was requested but could not run. */
    ProfileUnavailableReason?: ProfileUnavailableReason;
}
