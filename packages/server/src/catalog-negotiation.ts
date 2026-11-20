/**
 * Sends a chat request's entity and query catalogs by reference, and resends items when Skip reports a
 * `catalog_miss` (Skip-Brain plan `client-metadata-catalog-cache.md`, §4.2):
 *
 * 1. the request carries one manifest hash per kind (`catalogRefs`) and empty `entities` / `queries`;
 * 2. on a miss for a kind, the retry adds that kind's manifest and every item whose hash isn't in the last
 *    manifest Skip accepted (every item after a restart);
 * 3. on a miss listing exact item IDs, the next retry sends exactly those;
 * 4. if Skip still misses after two retries, the full catalogs are sent the original way. That is logged as an
 *    error: in normal operation it means the hashes aren't stable.
 */
import type { EntityInfo } from '@memberjunction/core';
import { LogError } from '@memberjunction/core';
import {
    BuildCatalog,
    DiffCatalogItems,
    SkipCatalogKind,
    type BuiltCatalog,
    type SkipCatalogItem,
    type SkipCatalogItems,
    type SkipCatalogManifest,
    type SkipCatalogManifests,
    type SkipCatalogRefs,
} from '@askskip/types/catalog';
import { SkipErrorCode, type SkipAPIRequest, type SkipAPIResponse, type SkipErrorDetail, type SkipQueryInfo } from '@askskip/types';

/** How many retries after the first miss before the full catalogs are sent. */
const MAX_CATALOG_RESENDS = 2;

/** The catalogs of one request, by kind. */
export type RequestCatalogs = Map<SkipCatalogKind, BuiltCatalog>;

/** Sends one request; returns whatever the transport returns. */
export type CatalogRequestSender<TResult> = (request: SkipAPIRequest) => Promise<TResult>;

/** Finds the final Skip response in a transport result, if one arrived. */
export type FinalResponseReader<TResult> = (result: TResult) => SkipAPIResponse | undefined;

export class SkipCatalogNegotiator {
    /** Last manifest Skip accepted, per scope (Skip URL and organization) and kind. Per process: a restart resends every item once. */
    private static acceptedManifests = new Map<string, SkipCatalogManifest>();

    /** The entity catalog, rebuilt only when the SDK's entity payload (a new array) is rebuilt. */
    private static entityCatalogMemo: { Source: readonly EntityInfo[]; Catalog: BuiltCatalog } | null = null;

    constructor(private readonly scope: string) {}

    /** Forgets every accepted manifest and the memoized entity catalog (tests). */
    public static Reset(): void {
        SkipCatalogNegotiator.acceptedManifests.clear();
        SkipCatalogNegotiator.entityCatalogMemo = null;
    }

    /**
     * Canonicalizes and hashes the request's catalogs. A kind is left out when its array is empty (the request
     * didn't include it), so it keeps today's behavior. Returns null when hashing fails: the caller then sends the
     * full catalogs, since the cache must never fail a turn.
     */
    public static BuildRequestCatalogs(request: SkipAPIRequest): RequestCatalogs | null {
        try {
            const catalogs: RequestCatalogs = new Map();
            if (request.entities?.length) {
                catalogs.set(SkipCatalogKind.Entities, SkipCatalogNegotiator.entityCatalog(request.entities));
            }
            if (request.queries?.length) {
                catalogs.set(SkipCatalogKind.Queries, BuildCatalog<SkipQueryInfo>(request.queries, (q) => q.ID));
            }
            return catalogs;
        }
        catch (e) {
            LogError(`[SkipSDK] Could not hash the request catalogs; sending them in full: ${e}`);
            return null;
        }
    }

    private static entityCatalog(entities: readonly EntityInfo[]): BuiltCatalog {
        const memo = SkipCatalogNegotiator.entityCatalogMemo;
        if (memo?.Source === entities) {
            return memo.Catalog;
        }
        const catalog = BuildCatalog<EntityInfo>(entities, (e) => e.ID);
        SkipCatalogNegotiator.entityCatalogMemo = { Source: entities, Catalog: catalog };
        return catalog;
    }

    /** Runs the protocol in the file header and returns the result of the last request sent. */
    public async Send<TResult>(full: SkipAPIRequest, catalogs: RequestCatalogs, send: CatalogRequestSender<TResult>, finalOf: FinalResponseReader<TResult>): Promise<TResult> {
        if (catalogs.size === 0) {
            return send(full);
        }
        const byReference = this.byReference(full, catalogs);
        let request = byReference;
        for (let resends = 0; ; resends++) {
            const result = await send(request);
            const final = finalOf(result);
            const miss = SkipCatalogNegotiator.catalogMiss(final);
            if (!miss) {
                if (final) {
                    this.recordAccepted(catalogs);
                }
                return result;
            }
            if (resends >= MAX_CATALOG_RESENDS) {
                break;
            }
            request = this.withResend(byReference, catalogs, miss);
        }
        LogError(`[SkipSDK] Skip still reported a catalog miss after ${MAX_CATALOG_RESENDS} resends; sending the full catalogs`);
        return send(full);
    }

    private static catalogMiss(final: SkipAPIResponse | undefined): SkipErrorDetail | null {
        const detail = final?.success === false ? final.errorDetail : undefined;
        return detail?.code === SkipErrorCode.catalog_miss ? detail : null;
    }

    private byReference(full: SkipAPIRequest, catalogs: RequestCatalogs): SkipAPIRequest {
        const refs: SkipCatalogRefs = {};
        for (const [kind, catalog] of catalogs) {
            refs[kind] = catalog.Ref;
        }
        return {
            ...full,
            entities: catalogs.has(SkipCatalogKind.Entities) ? [] : full.entities,
            queries: catalogs.has(SkipCatalogKind.Queries) ? [] : full.queries,
            catalogRefs: refs,
        };
    }

    /** Adds manifests and items for what the miss reported. A kind Skip didn't name is sent by reference only. */
    private withResend(byReference: SkipAPIRequest, catalogs: RequestCatalogs, miss: SkipErrorDetail): SkipAPIRequest {
        const manifests: SkipCatalogManifests = {};
        const items: SkipCatalogItems = {};
        for (const kind of miss.missingKinds ?? []) {
            const catalog = catalogs.get(kind);
            if (catalog) {
                manifests[kind] = catalog.Manifest;
                items[kind] = DiffCatalogItems(catalog, this.accepted(kind));
            }
        }
        for (const missing of miss.missingItems ?? []) {
            const catalog = catalogs.get(missing.kind);
            if (catalog) {
                manifests[missing.kind] = catalog.Manifest;
                items[missing.kind] = SkipCatalogNegotiator.mergeItems(items[missing.kind], SkipCatalogNegotiator.pickItems(catalog, missing.ids));
            }
        }
        return { ...byReference, catalogManifests: manifests, catalogItems: items };
    }

    private static pickItems(catalog: BuiltCatalog, ids: readonly string[]): SkipCatalogItem[] {
        return ids.map((id) => catalog.Items.get(id.toLowerCase())).filter((i): i is SkipCatalogItem => i !== undefined);
    }

    private static mergeItems(a: SkipCatalogItem[] | undefined, b: SkipCatalogItem[]): SkipCatalogItem[] {
        const byHash = new Map<string, SkipCatalogItem>();
        for (const item of [...(a ?? []), ...b]) {
            byHash.set(item.hash, item);
        }
        return [...byHash.values()];
    }

    private accepted(kind: SkipCatalogKind): SkipCatalogManifest | null {
        return SkipCatalogNegotiator.acceptedManifests.get(`${this.scope}|${kind}`) ?? null;
    }

    private recordAccepted(catalogs: RequestCatalogs): void {
        for (const [kind, catalog] of catalogs) {
            SkipCatalogNegotiator.acceptedManifests.set(`${this.scope}|${kind}`, catalog.Manifest);
        }
    }
}
