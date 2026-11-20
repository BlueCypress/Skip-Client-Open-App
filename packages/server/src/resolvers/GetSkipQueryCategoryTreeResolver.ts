/**
 * `GetSkipQueryCategoryTree`: every category at or under a category path, with how many queries it holds.
 *
 * Skip names a new query against the categories it already keeps under `Skip/`, so related queries land together.
 * Most queries there are Pending, which the SDK's catalog doesn't carry, so Skip asks here when it names a query
 * (Skip-Brain plan `client-metadata-catalog-cache.md`, §9 item 4). Only category paths and counts are returned: a
 * name clash is settled by the create itself (AutoResolveCollision), so the names stay on the client.
 *
 * ## Authorization
 *
 * The key needs `entity:read` on `MJ: Queries`, which the Skip callback key already has.
 */

import { Arg, Ctx, Field, InputType, ObjectType, Query, Resolver } from 'type-graphql';
import { LogError } from '@memberjunction/core';
import { QueryEngine } from '@memberjunction/core-entities';
import { AppContext, ResolverBase } from '@memberjunction/server';
import type {
    GetSkipQueryCategoryTreeInput as GetSkipQueryCategoryTreeInputContract,
    GetSkipQueryCategoryTreeResult as GetSkipQueryCategoryTreeResultContract,
} from '@askskip/types';
import { CategoriesUnderPath } from '../query-catalog.js';

@InputType()
export class GetSkipQueryCategoryTreeInput implements GetSkipQueryCategoryTreeInputContract {
    @Field(() => String, { description: 'The category path to list, for example Skip' })
    RootPath: string;
}

@ObjectType()
export class GetSkipQueryCategoryTreeResult implements GetSkipQueryCategoryTreeResultContract {
    @Field(() => Boolean)
    Success: boolean;

    @Field(() => String, { nullable: true, description: 'JSON-stringified SkipQueryCategoryTreeEntry[] (category path and query count)' })
    Categories?: string;

    @Field(() => String, { nullable: true })
    ErrorMessage?: string;
}

@Resolver()
export class GetSkipQueryCategoryTreeResolver extends ResolverBase {
    @Query(() => GetSkipQueryCategoryTreeResult, {
        description: 'Every category at or under a category path, with how many queries (any status) each holds directly',
    })
    async GetSkipQueryCategoryTree(
        @Arg('input', () => GetSkipQueryCategoryTreeInput) input: GetSkipQueryCategoryTreeInput,
        @Ctx() context: AppContext,
    ): Promise<GetSkipQueryCategoryTreeResult> {
        if (!input.RootPath?.trim()) {
            return { Success: false, ErrorMessage: 'GetSkipQueryCategoryTree needs a RootPath, for example Skip.' };
        }
        try {
            await this.CheckAPIKeyScopeAuthorization('entity:read', 'MJ: Queries', context.userPayload);
            await QueryEngine.Instance.Config(false, context.userPayload.userRecord);
            return { Success: true, Categories: JSON.stringify(CategoriesUnderPath(QueryEngine.Instance, input.RootPath)) };
        } catch (error: unknown) {
            LogError(error);
            return { Success: false, ErrorMessage: `GetSkipQueryCategoryTree failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
}
