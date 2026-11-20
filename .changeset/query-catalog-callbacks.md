---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Two callbacks Skip uses for queries its catalog doesn't carry. `GetSkipCatalogItems` returns queries by ID or by name and category path, in any status, as catalog items (the same canonical content and hash as the query catalog); a query that isn't found is reported, not thrown. `GetSkipQueryCategoryTree` returns every category at or under a path with how many queries each holds, for naming a new query; no query names are returned. Both need `entity:read` on `MJ: Queries`, which the Skip callback key already has, so no new scope or migration.
