/**
 * `TestAndProfileQuerySQL` — MJ's `TestQuerySQL`, plus optional statistics
 * computed over the **full, uncapped** result set inside the client's own
 * database.
 *
 * ## Why this exists
 *
 * `TestQuerySQL` returns at most `MaxRows` rows, and `MaxRows` becomes a real
 * SQL `TOP N` — so `RowCount: 10` means "at least 10" and the true cardinality
 * is unknowable from the response. A caller shown three unordered rows of a
 * needle-in-haystack aggregate sees every value as zero and concludes its join
 * is broken, when the query was correct all along. No amount of client-side
 * arithmetic can fix that: `TOP N` is not a random sample.
 *
 * Profiling answers the question where the data is. A single `nonZero > 0`, or a
 * single `distinctCount > 1`, settles it — and neither one requires a row to
 * leave the database.
 *
 * ## Why it lives here rather than in MJ
 *
 * Every client would otherwise have to upgrade MJ before seeing any benefit, and
 * the shape of what is wanted here is Skip-specific in a way that does not belong
 * in MJ core. `BaseServerMiddleware.GetResolverPaths()` is MJ's documented
 * extension point for exactly this, and it works on 5.51.0 today with no MJ
 * change.
 *
 * ## Disclosure
 *
 * This resolver is *more* restrictive than the call it supersedes, not less.
 * `TestQuerySQL` already returns raw rows; the profile leg structurally cannot.
 * The aggregate SQL is generated deterministically from the column list, the
 * caller has no influence over the projection, and every projection it emits is
 * a count, a ratio or a numeric bound. There is no path by which a row value
 * leaves the database through a profile.
 *
 * An earlier design added a `domainValues` pass that emitted literal values for
 * low-cardinality columns, fenced by a k-anonymity floor and a sensitivity
 * deny-list. It was removed: MJ already answers that question better via
 * `__mj.EntityFieldValue` (CHECK constraints + DBAutoDoc enum detection), which
 * `SkipSDK.packFieldValues` ships in every request payload. Deleting it removed
 * the feature's entire disclosure surface along with its cost.
 *
 * The caller never sends a column list. The resolver derives it from the result
 * it just executed, which removes column choice as a disclosure surface.
 */

import { Arg, Ctx, Field, InputType, Int, ObjectType, Query, Resolver } from 'type-graphql';
import { GraphQLJSONObject } from 'graphql-type-json';
import {
    RunQuery,
    LogError,
    LogStatus,
    type DatabasePlatform,
    type IRunQueryProvider,
    type IMetadataProvider,
    type QueryExecutionSpec,
    type UserInfo,
} from '@memberjunction/core';
import type { DatabaseProviderBase } from '@memberjunction/core';
import { RenderPipeline } from '@memberjunction/generic-database-provider';
import { GetDialect, type SQLDialect } from '@memberjunction/sql-dialect';
import { AppContext } from '@memberjunction/server';
import { GetReadOnlyProvider } from '@memberjunction/server';
import { ResolverBase } from '@memberjunction/server';
import type {
    ProfileSkippedColumn,
    ProfileUnavailableReason,
    QueryProfile,
    QueryDependencySpecInput as QueryDependencySpecContract,
    TestAndProfileQuerySQLInput as TestAndProfileQuerySQLInputContract,
    TestAndProfileQuerySQLResult as TestAndProfileQuerySQLResultContract,
} from '@askskip/types';
import { applyWidthCap, classifyColumns, type ProfileColumn } from './profile/columnTypes.js';
import { buildProfileSQL } from './profile/buildProfileSQL.js';
import { resolveMetadataHints } from './profile/metadataHints.js';
import { getPrivacyPolicy } from './profile/privacyPolicy.js';
import { shapeProfile } from './profile/shapeResponse.js';

// ════════════════════════════════════════════════════════════════════
// GraphQL types
//
// Each class `implements` its plain-interface counterpart in `@askskip/types`.
// The decorators cannot live in that package — it must not take a `type-graphql`
// dependency — but the `implements` clause makes TypeScript fail the build the
// moment the wire contract and the shared definition drift apart, which is the
// guarantee a hand-maintained mirror never gives.
// ════════════════════════════════════════════════════════════════════

@InputType()
export class ProfileQueryDependencySpecInput implements QueryDependencySpecContract {
    @Field(() => String, { description: 'Query name as referenced in the composition token' })
    Name: string;

    @Field(() => String, { description: 'Category path as referenced in the composition token' })
    CategoryPath: string;

    @Field(() => String, { description: 'The raw SQL for this dependency' })
    SQL: string;

    @Field(() => Boolean, { nullable: true, description: 'Whether this dependency uses Nunjucks template syntax' })
    UsesTemplate?: boolean;

    @Field(() => GraphQLJSONObject, { nullable: true, description: 'Parameters for this dependency\'s Nunjucks templates' })
    Parameters?: Record<string, string>;

    @Field(() => [ProfileQueryDependencySpecInput], { nullable: true, description: 'Nested dependencies (recursive)' })
    Dependencies?: ProfileQueryDependencySpecInput[];
}

@InputType()
export class TestAndProfileQuerySQLInput implements TestAndProfileQuerySQLInputContract {
    @Field(() => String, { description: 'The raw SQL — may contain {{query:"..."}} and {{ param }} tokens' })
    SQL: string;

    @Field(() => GraphQLJSONObject, { nullable: true, description: 'Parameter values for Nunjucks template substitution' })
    Parameters?: Record<string, string>;

    @Field(() => Boolean, { nullable: true, description: 'Whether this query uses Nunjucks template syntax' })
    UsesTemplate?: boolean;

    @Field(() => [ProfileQueryDependencySpecInput], { nullable: true, description: 'Inline dependency queries for composition resolution' })
    Dependencies?: ProfileQueryDependencySpecInput[];

    @Field(() => Int, { nullable: true, defaultValue: 100, description: 'Max rows to return (default: 100). Caps Results only; the profile is computed uncapped.' })
    MaxRows?: number;

    @Field(() => Boolean, { nullable: true, description: 'Opt in to profiling. Absent or false behaves identically to TestQuerySQL.' })
    Profile?: boolean;
}

@ObjectType()
export class TestAndProfileQuerySQLResult implements TestAndProfileQuerySQLResultContract {
    @Field(() => Boolean, { description: 'Whether the query executed successfully' })
    Success: boolean;

    @Field(() => String, { nullable: true, description: 'JSON-stringified result rows' })
    Results?: string;

    @Field(() => Int, { description: 'Number of rows returned, after the MaxRows cap' })
    RowCount: number;

    @Field(() => Int, { description: 'Execution time in milliseconds' })
    ExecutionTime: number;

    @Field(() => String, { nullable: true, description: 'Error message if execution failed' })
    ErrorMessage?: string;

    @Field(() => String, { nullable: true, description: 'JSON-stringified applied parameters including defaults' })
    AppliedParameters?: string;

    @Field(() => String, { nullable: true, description: 'The fully rendered SQL that was executed against the database' })
    RenderedSQL?: string;

    @Field(() => String, { nullable: true, description: 'JSON-stringified QueryProfile. Absent when not requested or not obtainable.' })
    Profile?: string;

    @Field(() => String, { nullable: true, description: "Why the profile is absent: 'timeout' | 'zero-rows' | 'unparseable' | 'error'" })
    ProfileUnavailableReason?: ProfileUnavailableReason;
}


// ════════════════════════════════════════════════════════════════════
// Resolver
// ════════════════════════════════════════════════════════════════════

@Resolver()
export class TestAndProfileQuerySQLResolver extends ResolverBase {
    @Query(() => TestAndProfileQuerySQLResult, {
        description: 'Test transient SQL with full composition + Nunjucks processing, optionally returning '
            + 'aggregate statistics computed over the full uncapped result set without any row data leaving the database',
    })
    async TestAndProfileQuerySQL(
        @Arg('input', () => TestAndProfileQuerySQLInput) input: TestAndProfileQuerySQLInput,
        @Ctx() context: AppContext,
    ): Promise<TestAndProfileQuerySQLResult> {
        try {
            // The call itself authorizes against `query:test`, exactly as MJ's
            // TestQuerySQL does — this operation is a superset of it.
            await this.CheckAPIKeyScopeAuthorization('query:test', '*', context.userPayload);

            const provider = GetReadOnlyProvider(context.providers, { allowFallbackToReadWrite: false });
            if (!provider) {
                return failure('Read-only data source is not available. TestAndProfileQuerySQL requires a read-only connection for security.');
            }

            const spec = buildSpec(input);
            const testResult = await this.runTestLeg(provider, spec, context.userPayload.userRecord);

            if (!input.Profile || !testResult.Success) return testResult;

            const refusal = await this.reasonProfilingCannotRun(testResult, context);
            if (refusal) return { ...testResult, ProfileUnavailableReason: refusal };

            return await this.attachProfile(provider, spec, testResult, context.userPayload.userRecord);
        } catch (error: unknown) {
            LogError(error);
            return failure(`TestAndProfileQuerySQL failed: ${describe(error)}`);
        }
    }

    /**
     * Returns why profiling will not be attempted, or `null` to proceed.
     *
     * The scope check lives here, separate from the `query:test` gate above, and
     * its failure is reported rather than thrown. Profiling is scoped
     * independently so an operator can permit capped SQL testing while refusing
     * the uncapped scans profiling requires — and a refusal must therefore cost
     * the caller its statistics, never its test result. Throwing here would turn
     * a deliberate configuration choice into a broken query test.
     */
    private async reasonProfilingCannotRun(
        testResult: TestAndProfileQuerySQLResult,
        context: AppContext,
    ): Promise<ProfileUnavailableReason | null> {
        // Zero rows carry no column metadata, and the row count already says
        // everything a profile could.
        if (testResult.RowCount === 0) return 'zero-rows';

        try {
            await this.CheckAPIKeyScopeAuthorization('query:profile', '*', context.userPayload);
            return null;
        } catch {
            LogStatus('TestAndProfileQuerySQL: profiling requested but the key lacks the query:profile scope — returning the test result without statistics.');
            return 'not-authorized';
        }
    }

    /**
     * Runs the test leg through `RunQuery.ExecuteFromSpec`, exactly as MJ's own
     * `TestQuerySQLResolver` does.
     *
     * Deliberately delegated rather than reimplemented from `RenderPipeline` +
     * `ExecuteSQL`. Whatever this resolver does when `Profile` is absent must be
     * indistinguishable from `TestQuerySQL`, and the only way to guarantee that
     * is to run the same code.
     */
    private async runTestLeg(
        provider: DatabaseProviderBase,
        spec: QueryExecutionSpec,
        contextUser: UserInfo,
    ): Promise<TestAndProfileQuerySQLResult> {
        const rq = new RunQuery(provider as unknown as IRunQueryProvider);
        const result = await rq.ExecuteFromSpec(spec, contextUser);

        return {
            Success: result.Success,
            Results: result.Results ? JSON.stringify(result.Results) : undefined,
            RowCount: result.RowCount,
            ExecutionTime: result.ExecutionTime,
            ErrorMessage: result.ErrorMessage || undefined,
            AppliedParameters: result.AppliedParameters ? JSON.stringify(result.AppliedParameters) : undefined,
            RenderedSQL: result.RenderedSQL || undefined,
        };
    }

    /**
     * Computes the profile and attaches it to an already-successful test result.
     *
     * The test result is produced before this runs and is never invalidated by
     * it. Every failure path here returns that result intact with a
     * `ProfileUnavailableReason` — a caller that asked for statistics and got
     * none must be told so, because silence reads as "no problems found".
     */
    private async attachProfile(
        provider: DatabaseProviderBase,
        spec: QueryExecutionSpec,
        testResult: TestAndProfileQuerySQLResult,
        contextUser: UserInfo,
    ): Promise<TestAndProfileQuerySQLResult> {
        try {
            const profile = await this.computeProfile(provider, spec, testResult, contextUser);
            if (!profile) {
                LogStatus('TestAndProfileQuerySQL: candidate SQL could not be rewritten into a profile query — returning the test result without statistics.');
                return { ...testResult, ProfileUnavailableReason: 'unparseable' };
            }

            // Deliberately silent on success. A per-call log here was carried
            // through development to answer two questions — whether profiling ran
            // at all, and which phase a slow profile spent its time in — and both
            // are now settled: the domain pass that caused the outlier is gone,
            // and the aggregate pass costs what the inner query costs. Keeping it
            // would add a line per Test SQL call to every client's server log for
            // no remaining diagnostic value.
            //
            // Coverage is still auditable without it: `__mj.APIKeyUsageLog`
            // records every `query:profile` authorization, success included.
            return { ...testResult, Profile: JSON.stringify(profile) };
        } catch (error: unknown) {
            const message = describe(error);
            LogError(`TestAndProfileQuerySQL: profiling failed — ${message}`);
            return {
                ...testResult,
                ProfileUnavailableReason: /timeout|timed out/i.test(message) ? 'timeout' : 'error',
            };
        }
    }

    /**
     * The profile itself, in six steps.
     *
     * Returns `null` when the candidate SQL cannot be safely rewritten into a
     * profile CTE — a refusal, not an error.
     */
    private async computeProfile(
        provider: DatabaseProviderBase,
        spec: QueryExecutionSpec,
        testResult: TestAndProfileQuerySQLResult,
        contextUser: UserInfo,
    ): Promise<QueryProfile | null> {
        const platform = provider.PlatformKey as DatabasePlatform;
        const dialect = GetDialect(platform);
        const policy = getPrivacyPolicy();

        // 1. Re-render without MaxRows. This yields the uncapped base SQL and
        //    runs `assertSafeToExecute` internally — load-bearing here, because
        //    removing the row cap removes a backstop and the dangerous-keyword
        //    validation must not be lost with it.
        const baseSQL = renderUncapped(spec, platform, contextUser);

        // 2. Column names come from the executed result's own rows: exact, and
        //    free of the `SELECT *` / expression ambiguity that parsing the
        //    SELECT list would carry.
        const rows = parseRows(testResult.Results);
        const columnNames = rows[0] ? Object.keys(rows[0]) : [];
        if (columnNames.length === 0) return null;

        // 3. Type every column: metadata first, sampled values second.
        const hints = resolveMetadataHints(baseSQL, columnNames, dialect, provider as unknown as IMetadataProvider);
        const classified = classifyColumns(columnNames, hints, rows);
        const { profiled, skipped } = applyWidthCap(classified, policy);

        // 4. Generate and run the aggregate pass.
        const plan = buildProfileSQL(baseSQL, profiled, policy, dialect);
        if (!plan) return null;

        const aggregateRows = await provider.ExecuteSQL<Record<string, unknown>>(
            plan.sql, undefined, { description: 'TestAndProfileQuerySQL: profile aggregates' }, contextUser,
        );
        if (!aggregateRows?.[0]) return null;

        const profile = shapeProfile(aggregateRows[0], plan, profiled, skipped as ProfileSkippedColumn[]);


        // 6. Statistics only. No row ever left the database.
        return profile;
    }

}

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════

function buildSpec(input: TestAndProfileQuerySQLInput): QueryExecutionSpec {
    return {
        SQL: input.SQL,
        Parameters: input.Parameters,
        UsesTemplate: input.UsesTemplate,
        Dependencies: input.Dependencies,
        MaxRows: input.MaxRows ?? 100,
    };
}

/**
 * Renders composition tokens and Nunjucks templates without applying `MaxRows`,
 * yielding the base SQL the profile aggregates over.
 *
 * Mirrors `GenericDatabaseProvider.resolveSpecParameters` field for field, minus
 * `MaxRows`. Rendering twice costs CPU and no database work, and it buys exact
 * parity on the test leg — which is worth more than saving one pass through a
 * string pipeline.
 *
 * `ParameterDefinitions` is deliberately not forwarded: the GraphQL input has no
 * such field, so `buildSpec` never populates it and there is nothing to pass.
 */
function renderUncapped(spec: QueryExecutionSpec, platform: DatabasePlatform, contextUser: UserInfo): string {
    return RenderPipeline.Run(spec.SQL, {
        Platform: platform,
        ContextUser: contextUser,
        Parameters: spec.Parameters,
        UsesTemplate: spec.UsesTemplate,
        Dependencies: spec.Dependencies,
        OriginalSQL: spec.SQL,
    }).FinalSQL;
}

function parseRows(serialized: string | undefined): Record<string, unknown>[] {
    if (!serialized) return [];
    try {
        const parsed: unknown = JSON.parse(serialized);
        return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
    } catch {
        return [];
    }
}

function failure(message: string): TestAndProfileQuerySQLResult {
    return { Success: false, RowCount: 0, ExecutionTime: 0, ErrorMessage: message };
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
