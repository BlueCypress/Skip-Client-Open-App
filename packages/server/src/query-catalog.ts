/**
 * The query side of the catalog Skip receives: one projection of an MJ query (`SkipQueryInfo`), used both for the
 * query catalog the SDK sends and for the queries `GetSkipCatalogItems` returns on demand, so the same query always
 * becomes the same catalog item. And the exposed set: the queries the catalog carries.
 */
import type { MJQueryEntityExtended, QueryEngine } from '@memberjunction/core-entities';
import { UUIDsEqual } from '@memberjunction/global';
import { getDbType } from '@askskip/core';
import { IsExposedQueryCategory, type SkipCatalogItemRequest, type SkipQueryCategoryTreeEntry, type SkipQueryInfo } from '@askskip/types';
import { CanonicalizeCatalogItem, HashCatalogItemContent, type SkipCatalogItem } from '@askskip/types/catalog';

/** The query's category path, from the root down (`Golden-Queries/Sales`). Empty when the category is unknown. */
export function QueryCategoryPath(qe: QueryEngine, categoryID: string | null): string {
    const cat = categoryID ? qe.Categories.find((c) => UUIDsEqual(c.ID, categoryID)) : undefined;
    if (!cat) return '';
    if (!cat.ParentID) return cat.Name;
    const parentPath = QueryCategoryPath(qe, cat.ParentID);
    return parentPath ? `${parentPath}/${cat.Name}` : cat.Name;
}

/** One MJ query as Skip receives it. */
export function BuildSkipQueryInfo(qe: QueryEngine, q: MJQueryEntityExtended): SkipQueryInfo {
    return {
        ID: q.ID,
        Name: q.Name,
        Description: q.Description,
        Category: q.Category,
        CategoryPath: QueryCategoryPath(qe, q.CategoryID),
        CategoryID: q.CategoryID,
        SQL: q.GetPlatformSQL(getDbType()),
        Status: q.Status,
        Reusable: q.Reusable,
        TechnicalDescription: q.TechnicalDescription,
        Fields: qe.GetQueryFields(q.ID).map((f) => ({
            ID: f.ID,
            QueryID: f.QueryID,
            Name: f.Name,
            Description: f.Description,
            Sequence: f.Sequence,
            SQLBaseType: f.SQLBaseType,
            SQLFullType: f.SQLFullType,
            SourceEntityID: f.SourceEntityID,
            SourceEntity: f.SourceEntity,
            SourceFieldName: f.SourceFieldName,
            IsComputed: f.IsComputed,
            ComputationDescription: f.ComputationDescription,
            IsSummary: f.IsSummary,
            SummaryDescription: f.SummaryDescription
        })),
        Parameters: qe.GetQueryParameters(q.ID).map((p) => ({
            ID: p.ID,
            QueryID: p.QueryID,
            Name: p.Name,
            Description: p.Description,
            Type: p.Type,
            IsRequired: p.IsRequired,
            DefaultValue: p.DefaultValue,
            SampleValue: p.SampleValue,
            ValidationFilters: p.ValidationFilters
        })),
        Entities: qe.QueryEntities.filter(e => UUIDsEqual(e.QueryID, q.ID)).map((e) => ({
            ID: e.ID,
            QueryID: e.QueryID,
            EntityID: e.EntityID,
            Entity: e.Entity
        })),
        IsApproved: q.IsApproved,
    };
}

/** The queries the catalog carries: Approved queries in the exposed category roots. */
export function BuildExposedQueries(qe: QueryEngine, exposedRoots: readonly string[]): SkipQueryInfo[] {
    return qe.Queries
        .filter((q) => q.Status === 'Approved')
        .map((q) => ({ q, path: QueryCategoryPath(qe, q.CategoryID) }))
        .filter(({ path }) => IsExposedQueryCategory(path, exposedRoots))
        .map(({ q }) => BuildSkipQueryInfo(qe, q));
}

/** Most lookups one GetSkipCatalogItems call answers. */
export const MAX_CATALOG_ITEM_REQUESTS = 200;

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
    return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/** The query a request names: by ID when it has one, else by name and category path. */
function findQuery(qe: QueryEngine, request: SkipCatalogItemRequest): MJQueryEntityExtended | undefined {
    if (request.ID) {
        return qe.Queries.find((q) => UUIDsEqual(q.ID, request.ID));
    }
    if (!request.Name) {
        return undefined;
    }
    return qe.Queries.find((q) => sameText(q.Name, request.Name) && sameText(QueryCategoryPath(qe, q.CategoryID), request.CategoryPath));
}

/**
 * Catalog items for the requested queries, in any status, in the same canonical form as the query catalog. A request
 * nothing matches is returned in `NotFound`; one query requested twice is returned once.
 */
export function FindCatalogItems(qe: QueryEngine, requests: readonly SkipCatalogItemRequest[]): { Items: SkipCatalogItem[]; NotFound: SkipCatalogItemRequest[] } {
    const items = new Map<string, SkipCatalogItem>();
    const notFound: SkipCatalogItemRequest[] = [];
    for (const request of requests) {
        const query = findQuery(qe, request);
        if (!query) {
            notFound.push(request);
            continue;
        }
        const content = CanonicalizeCatalogItem(BuildSkipQueryInfo(qe, query));
        items.set(query.ID.toLowerCase(), { id: query.ID, hash: HashCatalogItemContent(content), content });
    }
    return { Items: [...items.values()], NotFound: notFound };
}

/**
 * Every category at or under the path, with how many queries (in any status) it holds directly, sorted by path. Empty
 * categories are included: they are still places a new query can go.
 */
export function CategoriesUnderPath(qe: QueryEngine, rootPath: string): SkipQueryCategoryTreeEntry[] {
    const counts = new Map<string, number>();
    for (const q of qe.Queries) {
        const id = (q.CategoryID ?? '').toLowerCase();
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return qe.Categories
        .map((c) => ({ CategoryPath: QueryCategoryPath(qe, c.ID), QueryCount: counts.get(c.ID.toLowerCase()) ?? 0 }))
        .filter((c) => IsExposedQueryCategory(c.CategoryPath, [rootPath]))
        .sort((a, b) => a.CategoryPath.localeCompare(b.CategoryPath));
}
