/**
 * `TestQuerySQLBatch` — several of MJ's `TestQuerySQL` calls in one GraphQL request.
 *
 * ## Why this exists
 *
 * Skip tests transient SQL against the client many times per run, one HTTP round
 * trip per query. Most of each call's cost is the trip — TLS, auth, API-key
 * authorization, GraphQL parsing — not the query. Batching keeps the queries and
 * drops the trips.
 *
 * ## What it guarantees
 *
 * Every item runs through MJ's own `TestQuerySQLResolver.TestQuerySQL`, the
 * resolver a standalone call reaches. Nothing about SQL execution is
 * reimplemented here, so each item is authorized (`query:test`), executed
 * (read-only connection, composition + Nunjucks pipeline, `MaxRows` defaulting to
 * 100) and reported exactly as it would be on its own, and it stays that way
 * when MJ changes the resolver.
 *
 * Items run **sequentially**, on the caller's request context, in input order.
 * Running them concurrently would let one Skip request hold several pooled
 * connections on the client's read-only pool at once, which a run of separate
 * calls never did.
 *
 * One item failing never fails the batch: MJ's resolver reports its own errors
 * as a result, and anything it throws is caught and reported on that item.
 *
 * ## Scope
 *
 * `query:test`, the scope `TestQuerySQL` itself checks. A batch is that operation
 * repeated, so it discloses nothing a sequence of `TestQuerySQL` calls under the
 * same key could not; a separate scope would let an operator permit N calls but
 * not the same N calls in one request, which protects nothing. The batch checks it
 * once up front so an unauthorized key gets one clear refusal instead of fifty
 * identical item failures, and every item is then checked again by MJ's resolver.
 */

import { Arg, Ctx, Field, InputType, Int, ObjectType, Query, Resolver } from 'type-graphql';
import { GraphQLJSONObject } from 'graphql-type-json';
import { LogError } from '@memberjunction/core';
import { GetReadOnlyProvider, ResolverBase, TestQuerySQLResolver, type AppContext } from '@memberjunction/server';
import {
    TEST_QUERY_SQL_BATCH_MAX_ITEMS,
    type TestQuerySQLInput as TestQuerySQLInputContract,
    type TestQuerySQLResult as TestQuerySQLResultContract,
    type TestQuerySQLBatchInput as TestQuerySQLBatchInputContract,
    type TestQuerySQLBatchResult as TestQuerySQLBatchResultContract,
} from '@askskip/types';
import { ProfileQueryDependencySpecInput } from './TestAndProfileQuerySQLResolver.js';

// ════════════════════════════════════════════════════════════════════
// GraphQL types
//
// Field for field MJ's TestQuerySQLInput / TestQuerySQLResult. They are not MJ's
// classes reused, because GraphQL type names are global to the host schema and a
// second copy of @memberjunction/server would register a second class under the
// same name and fail the host at boot. Each class `implements` its contract in
// `@askskip/types`, so drift fails the build.
// ════════════════════════════════════════════════════════════════════

@InputType()
export class TestQuerySQLBatchItemInput implements TestQuerySQLInputContract {
    @Field(() => String, { description: 'The raw SQL — may contain {{query:"..."}} and {{ param }} tokens' })
    SQL: string;

    @Field(() => GraphQLJSONObject, { nullable: true, description: 'Parameter values for Nunjucks template substitution' })
    Parameters?: Record<string, string>;

    @Field(() => Boolean, { nullable: true, description: 'Whether this query uses Nunjucks template syntax' })
    UsesTemplate?: boolean;

    @Field(() => [ProfileQueryDependencySpecInput], { nullable: true, description: 'Inline dependency queries for composition resolution' })
    Dependencies?: ProfileQueryDependencySpecInput[];

    @Field(() => Int, { nullable: true, defaultValue: 100, description: 'Max rows to return (default: 100)' })
    MaxRows?: number;
}

@InputType()
export class TestQuerySQLBatchInput implements TestQuerySQLBatchInputContract {
    @Field(() => [TestQuerySQLBatchItemInput], {
        description: `The queries to run, in order. At most ${TEST_QUERY_SQL_BATCH_MAX_ITEMS}.`,
    })
    Items: TestQuerySQLBatchItemInput[];
}

@ObjectType()
export class TestQuerySQLBatchItemResult implements TestQuerySQLResultContract {
    @Field(() => Boolean, { description: 'Whether the query executed successfully' })
    Success: boolean;

    @Field(() => String, { nullable: true, description: 'JSON-stringified result rows' })
    Results?: string;

    @Field(() => Int, { description: 'Number of rows returned' })
    RowCount: number;

    @Field(() => Int, { description: 'Execution time in milliseconds' })
    ExecutionTime: number;

    @Field(() => String, { nullable: true, description: 'Error message if execution failed' })
    ErrorMessage?: string;

    @Field(() => String, { nullable: true, description: 'JSON-stringified applied parameters including defaults' })
    AppliedParameters?: string;

    @Field(() => String, { nullable: true, description: 'The fully rendered SQL that was executed against the database' })
    RenderedSQL?: string;
}

@ObjectType()
export class TestQuerySQLBatchResult implements TestQuerySQLBatchResultContract {
    @Field(() => Boolean, { description: 'Whether the batch was accepted and every item attempted. Item outcomes are on each result.' })
    Success: boolean;

    @Field(() => String, { nullable: true, description: 'Why the batch was refused, when Success is false' })
    ErrorMessage?: string;

    @Field(() => [TestQuerySQLBatchItemResult], { description: 'One result per input item, in input order' })
    Results: TestQuerySQLBatchItemResult[];
}

// ════════════════════════════════════════════════════════════════════
// Resolver
// ════════════════════════════════════════════════════════════════════

@Resolver()
export class TestQuerySQLBatchResolver extends ResolverBase {
    /** MJ's own resolver; every item is handed to it unchanged. */
    private readonly testQuerySQL = new TestQuerySQLResolver();

    @Query(() => TestQuerySQLBatchResult, {
        description: 'Run several transient TestQuerySQL requests in order in one call, returning one result per item. '
            + 'Each item is authorized, executed and capped exactly as a standalone TestQuerySQL call.',
    })
    async TestQuerySQLBatch(
        @Arg('input', () => TestQuerySQLBatchInput) input: TestQuerySQLBatchInput,
        @Ctx() context: AppContext,
    ): Promise<TestQuerySQLBatchResult> {
        try {
            const refusal = await this.reasonBatchCannotRun(input, context);
            if (refusal) return { Success: false, ErrorMessage: refusal, Results: [] };

            const results: TestQuerySQLBatchItemResult[] = [];
            for (const [index, item] of input.Items.entries()) {
                results.push(await this.runItem(item, index, context));
            }
            return { Success: true, Results: results };
        } catch (error: unknown) {
            LogError(error);
            return { Success: false, ErrorMessage: `TestQuerySQLBatch failed: ${describe(error)}`, Results: [] };
        }
    }

    /**
     * Returns why the batch is refused as a whole, or `null` to run it.
     *
     * Each of these would otherwise fail every item identically, so refusing up
     * front is both cheaper and clearer. None of them is the security boundary:
     * MJ's resolver repeats the scope and read-only checks on every item.
     */
    private async reasonBatchCannotRun(input: TestQuerySQLBatchInput, context: AppContext): Promise<string | null> {
        const count = input.Items?.length ?? 0;
        if (count > TEST_QUERY_SQL_BATCH_MAX_ITEMS) {
            return `TestQuerySQLBatch accepts at most ${TEST_QUERY_SQL_BATCH_MAX_ITEMS} items per call; received ${count}. `
                + 'Split the batch into smaller calls.';
        }

        try {
            await this.CheckAPIKeyScopeAuthorization('query:test', '*', context.userPayload);
        } catch (error: unknown) {
            return describe(error);
        }

        if (!GetReadOnlyProvider(context.providers, { allowFallbackToReadWrite: false })) {
            return 'Read-only data source is not available. TestQuerySQLBatch requires a read-only connection for security.';
        }
        return null;
    }

    /** Runs one item through MJ's TestQuerySQL; never throws. */
    private async runItem(item: TestQuerySQLBatchItemInput, index: number, context: AppContext): Promise<TestQuerySQLBatchItemResult> {
        try {
            return await this.testQuerySQL.TestQuerySQL(item, context);
        } catch (error: unknown) {
            LogError(error);
            return {
                Success: false,
                RowCount: 0,
                ExecutionTime: 0,
                ErrorMessage: `TestQuerySQLBatch item ${index} failed: ${describe(error)}`,
            };
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
