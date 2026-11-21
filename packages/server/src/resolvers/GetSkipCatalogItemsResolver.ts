/**
 * `GetSkipCatalogItems`: queries Skip needs that its query catalog doesn't carry, returned on demand.
 *
 * The SDK's catalog holds only the exposed set (ground truth and the MJ feature categories). When a component Skip
 * built in an earlier conversation uses another query, Skip asks for it here, by ID or by name and category path,
 * and gets it in the same canonical form and hash as a catalog item (Skip-Brain plan
 * `client-metadata-catalog-cache.md`, §9 item 2). A query that isn't found is reported, never thrown.
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
    GetSkipCatalogItemsInput as GetSkipCatalogItemsInputContract,
    GetSkipCatalogItemsResult as GetSkipCatalogItemsResultContract,
    SkipCatalogItemRequest as SkipCatalogItemRequestContract,
} from '@askskip/types';
import { FindCatalogItems, MAX_CATALOG_ITEM_REQUESTS } from '../query-catalog.js';

@InputType()
export class SkipCatalogItemRequestInput implements SkipCatalogItemRequestContract {
    @Field(() => String, { nullable: true, description: 'The query ID; when set, Name and CategoryPath are ignored' })
    ID?: string;

    @Field(() => String, { nullable: true })
    Name?: string;

    @Field(() => String, { nullable: true, description: 'Full category path, for example Skip/Sales' })
    CategoryPath?: string;
}

@InputType()
export class GetSkipCatalogItemsInput implements GetSkipCatalogItemsInputContract {
    @Field(() => [SkipCatalogItemRequestInput])
    Requests: SkipCatalogItemRequestInput[];
}

@ObjectType()
export class GetSkipCatalogItemsResult implements GetSkipCatalogItemsResultContract {
    @Field(() => Boolean)
    Success: boolean;

    @Field(() => String, { nullable: true, description: 'JSON-stringified SkipCatalogItem[] (canonical content and hash)' })
    Items?: string;

    @Field(() => String, { nullable: true, description: 'JSON-stringified SkipCatalogItemRequest[]: requests no query matched' })
    NotFound?: string;

    @Field(() => String, { nullable: true })
    ErrorMessage?: string;
}

@Resolver()
export class GetSkipCatalogItemsResolver extends ResolverBase {
    @Query(() => GetSkipCatalogItemsResult, {
        description: 'Queries by ID or by name and category path, in any status, as Skip catalog items (canonical content and hash)',
    })
    async GetSkipCatalogItems(
        @Arg('input', () => GetSkipCatalogItemsInput) input: GetSkipCatalogItemsInput,
        @Ctx() context: AppContext,
    ): Promise<GetSkipCatalogItemsResult> {
        const count = input.Requests?.length ?? 0;
        if (count > MAX_CATALOG_ITEM_REQUESTS) {
            return { Success: false, ErrorMessage: `GetSkipCatalogItems accepts at most ${MAX_CATALOG_ITEM_REQUESTS} requests per call; received ${count}.` };
        }
        try {
            await this.CheckAPIKeyScopeAuthorization('entity:read', 'MJ: Queries', context.userPayload);
            await QueryEngine.Instance.Config(false, context.userPayload.userRecord);
            const { Items, NotFound } = FindCatalogItems(QueryEngine.Instance, input.Requests ?? []);
            return { Success: true, Items: JSON.stringify(Items), NotFound: JSON.stringify(NotFound) };
        } catch (error: unknown) {
            LogError(error);
            return { Success: false, ErrorMessage: `GetSkipCatalogItems failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
}
