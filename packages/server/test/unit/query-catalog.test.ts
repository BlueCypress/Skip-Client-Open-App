/**
 * @fileoverview The query catalog's exposed set and the on-demand lookups behind GetSkipCatalogItems and
 * GetSkipQueryCategoryTree: a query fetched on demand must be the same catalog item the catalog would carry.
 */
import { describe, it, expect, vi } from 'vitest';
import { IsExposedQueryCategory } from '@askskip/types';
import { BuildCatalog } from '@askskip/types/catalog';

vi.mock('@askskip/core', () => ({ getDbType: () => 'sqlserver' }));
vi.mock('@memberjunction/global', () => ({ UUIDsEqual: (a: string, b: string) => a?.toLowerCase() === b?.toLowerCase() }));

import { BuildExposedQueries, CategoriesUnderPath, FindCatalogItems, QueryCategoryPath } from '../../src/query-catalog.js';

function query(ID: string, Name: string, CategoryID: string, Status = 'Approved') {
    return { ID, Name, CategoryID, Status, Description: `${Name} description`, IsApproved: Status === 'Approved', GetPlatformSQL: () => `SELECT '${Name}'` };
}

const qe = {
    Categories: [
        { ID: 'C-GT', Name: 'Golden-Queries', ParentID: null },
        { ID: 'C-GT-SALES', Name: 'Sales', ParentID: 'C-GT' },
        { ID: 'C-MJ', Name: 'MJ', ParentID: null },
        { ID: 'C-LISTS', Name: 'Lists', ParentID: 'C-MJ' },
        { ID: 'C-SKIP', Name: 'Skip', ParentID: null },
        { ID: 'C-SKIP-FIN', Name: 'Finance', ParentID: 'C-SKIP' },
        { ID: 'C-OTHER', Name: 'Reports', ParentID: null },
    ],
    Queries: [
        query('Q-GT', 'Revenue', 'C-GT-SALES'),
        query('Q-LIST', 'List Members', 'C-LISTS'),
        query('Q-SKIP', 'Monthly Revenue', 'C-SKIP-FIN', 'Pending'),
        query('Q-SKIP-OK', 'Old Revenue', 'C-SKIP', 'Approved'),
        query('Q-OTHER', 'Board Report', 'C-OTHER'),
    ],
    QueryEntities: [],
    GetQueryFields: () => [],
    GetQueryParameters: () => [],
} as never;

describe('exposed query categories', () => {
    it('matches a root and anything under it, case-insensitively, and nothing that merely shares a prefix', () => {
        expect(IsExposedQueryCategory('Golden-Queries/Sales')).toBe(true);
        expect(IsExposedQueryCategory('golden-queries')).toBe(true);
        expect(IsExposedQueryCategory('MJ/Lists')).toBe(true);
        expect(IsExposedQueryCategory('MJ/ListsArchive')).toBe(false);
        expect(IsExposedQueryCategory('Skip/Finance')).toBe(false);
        expect(IsExposedQueryCategory('')).toBe(false);
    });

    it('builds the catalog from Approved queries in the exposed roots only', () => {
        expect(BuildExposedQueries(qe, ['Golden-Queries', 'MJ/Lists', 'MJ/Tags']).map((q) => q.ID)).toEqual(['Q-GT', 'Q-LIST']);
        expect(QueryCategoryPath(qe, 'C-SKIP-FIN')).toBe('Skip/Finance');
    });
});

describe('FindCatalogItems', () => {
    it('finds queries in any status by ID or by name and path, as the same item the catalog would carry', () => {
        const { Items, NotFound } = FindCatalogItems(qe, [
            { ID: 'q-skip' },
            { Name: 'revenue', CategoryPath: 'golden-queries/sales' },
        ]);
        expect(NotFound).toEqual([]);
        expect(Items.map((i) => i.id)).toEqual(['Q-SKIP', 'Q-GT']);

        const fromCatalog = BuildCatalog(BuildExposedQueries(qe, ['Golden-Queries']), (q) => q.ID).Items.get('q-gt');
        expect(Items[1]).toEqual(fromCatalog);
    });

    it('reports what it cannot find, needs a name with a path, and returns a query requested twice once', () => {
        const { Items, NotFound } = FindCatalogItems(qe, [
            { ID: 'missing' },
            { Name: 'Revenue', CategoryPath: 'Skip' },
            { Name: 'Revenue' },
            { ID: 'Q-GT' },
            { Name: 'Revenue', CategoryPath: 'Golden-Queries/Sales' },
        ]);
        expect(Items.map((i) => i.id)).toEqual(['Q-GT']);
        expect(NotFound).toEqual([{ ID: 'missing' }, { Name: 'Revenue', CategoryPath: 'Skip' }, { Name: 'Revenue' }]);
    });
});

describe('CategoriesUnderPath', () => {
    it('lists every category at or under the path with its direct query count in any status, empty ones included', () => {
        expect(CategoriesUnderPath(qe, 'Skip')).toEqual([
            { CategoryPath: 'Skip', QueryCount: 1 },
            { CategoryPath: 'Skip/Finance', QueryCount: 1 },
        ]);
        expect(CategoriesUnderPath(qe, 'Reports')).toEqual([{ CategoryPath: 'Reports', QueryCount: 1 }]);
        expect(CategoriesUnderPath(qe, 'MJ')).toEqual([{ CategoryPath: 'MJ', QueryCount: 0 }, { CategoryPath: 'MJ/Lists', QueryCount: 1 }]);
    });
});
