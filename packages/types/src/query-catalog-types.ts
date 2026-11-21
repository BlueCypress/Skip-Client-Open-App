/**
 * Queries in the client metadata catalog (Skip-Brain plan `client-metadata-catalog-cache.md`, §9):
 * which queries the SDK exposes to Skip in its catalog, and the callbacks Skip uses for the rest.
 *
 * - The catalog carries only the exposed set: ground truth queries and the MJ feature categories
 *   ({@link SKIP_EXPOSED_QUERY_CATEGORIES}).
 * - `GetSkipCatalogItems` returns other queries on demand (for example one Skip created in an earlier
 *   conversation), as catalog items in the same canonical form.
 * - `GetSkipQueryCategoryTree` returns the categories under a category path with how many queries each holds
 *   (every status), which Skip uses when it names a new query. No query names cross over: a name clash is
 *   settled when the query is saved.
 */

/**
 * Category roots whose queries the SDK sends in its query catalog. A query is exposed when its category
 * path equals a root or sits under it. Mirrors the Skip Brain's composable categories: ground truth
 * queries and the MJ feature categories.
 */
export const SKIP_EXPOSED_QUERY_CATEGORIES: readonly string[] = ['Golden-Queries', 'MJ/Lists', 'MJ/Tags'];

/** True when the category path equals one of the roots or sits under it (case-insensitive). */
export function IsExposedQueryCategory(categoryPath: string | null | undefined, roots: readonly string[] = SKIP_EXPOSED_QUERY_CATEGORIES): boolean {
    const path = (categoryPath ?? '').trim().replace(/\/+$/, '').toLowerCase();
    if (!path) {
        return false;
    }
    return roots.some((root) => {
        const r = root.trim().replace(/\/+$/, '').toLowerCase();
        return r.length > 0 && (path === r || path.startsWith(`${r}/`));
    });
}

// ── GetSkipCatalogItems ────────────────────────────────────────────────────────────────────────

/** One query to look up: by ID, or by name and category path. */
export interface SkipCatalogItemRequest {
    ID?: string;
    Name?: string;
    CategoryPath?: string;
}

/** Input of the `GetSkipCatalogItems` callback. Queries only for now. */
export interface GetSkipCatalogItemsInput {
    Requests: SkipCatalogItemRequest[];
}

/** Result of the `GetSkipCatalogItems` callback. Unknown or out-of-reach queries are reported, never thrown. */
export interface GetSkipCatalogItemsResult {
    Success: boolean;
    /** JSON-stringified `SkipCatalogItem[]` (canonical content and hash, as in the query catalog) */
    Items?: string;
    /** JSON-stringified `SkipCatalogItemRequest[]`: the requests no query matched */
    NotFound?: string;
    ErrorMessage?: string;
}

// ── GetSkipQueryCategoryTree ───────────────────────────────────────────────────────────────────

/** One category at or under the requested path, with how many queries (in any status) it holds directly. */
export interface SkipQueryCategoryTreeEntry {
    CategoryPath: string;
    QueryCount: number;
}

/** Input of the `GetSkipQueryCategoryTree` callback. */
export interface GetSkipQueryCategoryTreeInput {
    /** The category path to list, for example `Skip`; every category at or under it is returned */
    RootPath: string;
}

/** Result of the `GetSkipQueryCategoryTree` callback. */
export interface GetSkipQueryCategoryTreeResult {
    Success: boolean;
    /** JSON-stringified `SkipQueryCategoryTreeEntry[]` */
    Categories?: string;
    ErrorMessage?: string;
}
