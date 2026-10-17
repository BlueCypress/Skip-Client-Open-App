/**
 * `ProfileEntityFields` — statistics about one entity, read through its
 * BaseView: row count, per-column coverage (the share of rows holding a value),
 * blank, zero and placeholder shares, text lengths, and bounds for date and
 * numeric columns.
 *
 * Skip's Data Expert asks for these when it reads an entity's details, so the
 * strategist and the Query Writers stop choosing columns that hold nothing and
 * stop spending turns rediscovering row counts and date ranges (#596).
 *
 * ## Disclosure
 *
 * The caller names an entity and nothing else. Columns come from MJ metadata,
 * the SQL is generated here, and every figure returned is a count, a ratio or a
 * length or a date/numeric bound. No text value is returned, and nothing is read
 * from histogram or most-common-value arrays, which hold real values.
 *
 * ## Cost
 *
 * Statistics are nice to have: every statement is cancelled by the database
 * after 20 s, a pass stops after 60 s, large entities are sampled, and a failed
 * pass backs off for hours (see `entity-profile/`). The resolver returns what is
 * cached, or the database's own statistics, and never throws.
 *
 * ## Authorization
 *
 * The key needs the `query:profile` scope, which the Skip callback key already
 * has, and the key's user must be able to read the entity.
 */

import { Arg, Ctx, Field, InputType, Int, ObjectType, Query, Resolver } from 'type-graphql';
import { LogError, Metadata, type EntityInfo } from '@memberjunction/core';
import { AppContext, GetReadOnlyProvider, ResolverBase } from '@memberjunction/server';
import type {
    EntityProfileUnavailableReason,
    ProfileEntityFieldsInput as ProfileEntityFieldsInputContract,
    ProfileEntityFieldsResult as ProfileEntityFieldsResultContract,
} from '@askskip/types';
import { EntityProfileService } from './entity-profile/entityProfileService.js';

const DEFAULT_WAIT_MS = 2_000;
const MAX_WAIT_MS = 10_000;

@InputType()
export class ProfileEntityFieldsInput implements ProfileEntityFieldsInputContract {
    @Field(() => String, { description: 'The MJ entity name' })
    EntityName: string;

    @Field(() => Int, { nullable: true, description: 'How long to wait for exact statistics when none are cached, in ms (default 2000, max 10000)' })
    WaitMs?: number;
}

@ObjectType()
export class ProfileEntityFieldsResult implements ProfileEntityFieldsResultContract {
    @Field(() => Boolean)
    Success: boolean;

    @Field(() => String, { nullable: true, description: 'JSON-stringified EntityProfile' })
    Profile?: string;

    @Field(() => String, { nullable: true })
    ErrorMessage?: string;

    @Field(() => String, { nullable: true, description: "'not-found' | 'not-authorized' | 'no-base-table' | 'error'" })
    UnavailableReason?: EntityProfileUnavailableReason;
}

@Resolver()
export class ProfileEntityFieldsResolver extends ResolverBase {
    @Query(() => ProfileEntityFieldsResult, {
        description: 'Row count and per-column coverage, blank/zero/placeholder shares and bounds for one entity, computed in the client database; no row values are returned',
    })
    async ProfileEntityFields(
        @Arg('input', () => ProfileEntityFieldsInput) input: ProfileEntityFieldsInput,
        @Ctx() context: AppContext,
    ): Promise<ProfileEntityFieldsResult> {
        try {
            await this.CheckAPIKeyScopeAuthorization('query:profile', '*', context.userPayload);
        } catch {
            return unavailable('not-authorized', 'The API key lacks the query:profile scope.');
        }
        try {
            const user = context.userPayload.userRecord;
            const entity = new Metadata().EntityByName(input.EntityName);
            const refusal = refusalFor(entity, input.EntityName, user);
            if (refusal) return refusal;

            const provider = GetReadOnlyProvider(context.providers, { allowFallbackToReadWrite: false });
            if (!provider) {
                return unavailable('error', 'Read-only data source is not available. ProfileEntityFields requires a read-only connection.');
            }
            const waitMs = Math.min(Math.max(input.WaitMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);
            const profile = await EntityProfileService.GetProfile(entity!, provider, user, waitMs);
            return { Success: true, Profile: JSON.stringify(profile) };
        } catch (error: unknown) {
            LogError(error);
            return unavailable('error', `ProfileEntityFields failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

function refusalFor(entity: EntityInfo | undefined, name: string, user: AppContext['userPayload']['userRecord']): ProfileEntityFieldsResult | null {
    if (!entity) return unavailable('not-found', `Entity "${name}" was not found.`);
    if (!entity.GetUserPermisions(user).CanRead) return unavailable('not-authorized', `The key's user cannot read "${name}".`);
    if (entity.VirtualEntity || !entity.BaseTable || !entity.BaseView) return unavailable('no-base-table', `"${name}" has no base table and view to profile.`);
    return null;
}

function unavailable(reason: EntityProfileUnavailableReason, message: string): ProfileEntityFieldsResult {
    return { Success: false, UnavailableReason: reason, ErrorMessage: message };
}
