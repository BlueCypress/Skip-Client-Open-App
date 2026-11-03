/**
 * Shared contract for the `TestQuerySQLBatch` GraphQL operation.
 *
 * `TestQuerySQLBatch` is a Skip-owned resolver that lives in this app's server
 * package and is merged into the host MJServer schema via
 * `SkipMiddleware.GetResolverPaths()`. It runs several transient query specs in
 * one GraphQL call, in order, each one through MJ's own `TestQuerySQL` resolver,
 * and returns one result per item in the same order.
 *
 * Every item is authorized, executed and capped exactly as a standalone
 * `TestQuerySQL` call would be: `query:test` scope, read-only connection,
 * `MaxRows` defaulting to 100. The batch only removes the per-call round trip.
 *
 * A host whose Skip Client Open App predates this operation rejects the whole
 * request at GraphQL validation with `Cannot query field "TestQuerySQLBatch" on
 * type "Query"` (extension code `GRAPHQL_VALIDATION_FAILED`). Callers fall back
 * to one `TestQuerySQL` call per item when they see that.
 *
 * Plain interfaces on purpose; see `profile-types.ts` for why the TypeGraphQL
 * classes `implement` these rather than living here.
 */

import type { QueryDependencySpecInput } from './profile-types.js';

/**
 * The most items one `TestQuerySQLBatch` call accepts. A larger batch is
 * rejected whole, before any item runs; callers split it into chunks of this size.
 */
export const TEST_QUERY_SQL_BATCH_MAX_ITEMS = 50;

/**
 * One transient query. Exactly MJ's `TestQuerySQLInput`: the same fields with
 * the same meaning and the same defaults.
 */
export interface TestQuerySQLInput {
    /** The raw SQL — may contain `{{query:"..."}}` and `{{ param }}` tokens. */
    SQL: string;
    /** Parameter values for Nunjucks template substitution. */
    Parameters?: Record<string, string>;
    /** Whether this query uses Nunjucks template syntax. */
    UsesTemplate?: boolean;
    /** Inline dependency queries for composition resolution. */
    Dependencies?: QueryDependencySpecInput[];
    /** Max rows to return (default 100). */
    MaxRows?: number;
}

/** One transient query's result. Exactly MJ's `TestQuerySQLResult`. */
export interface TestQuerySQLResult {
    Success: boolean;
    /** JSON-stringified result rows, capped at `MaxRows`. */
    Results?: string;
    /** Number of rows returned, i.e. after the cap. */
    RowCount: number;
    /** Execution time in milliseconds. */
    ExecutionTime: number;
    ErrorMessage?: string;
    /** JSON-stringified applied parameters, including defaults. */
    AppliedParameters?: string;
    /** The fully rendered SQL that was executed. */
    RenderedSQL?: string;
}

/** Input to `TestQuerySQLBatch`. */
export interface TestQuerySQLBatchInput {
    /** The queries to run, in order. At most {@link TEST_QUERY_SQL_BATCH_MAX_ITEMS}. */
    Items: TestQuerySQLInput[];
}

/** Result of `TestQuerySQLBatch`. */
export interface TestQuerySQLBatchResult {
    /**
     * Whether the batch was accepted and every item was attempted. It says
     * nothing about the items themselves: an item that fails reports it in its
     * own entry of {@link Results}, and its neighbours still run. `false` only
     * when the batch as a whole was refused (too many items, missing scope,
     * no read-only connection), in which case `Results` is empty.
     */
    Success: boolean;
    /** Why the batch was refused. Absent when `Success` is true. */
    ErrorMessage?: string;
    /** One result per input item, in input order. */
    Results: TestQuerySQLResult[];
}
