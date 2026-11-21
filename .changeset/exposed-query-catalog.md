---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

The query catalog sent to Skip now carries only the exposed queries: Approved queries under `Golden-Queries`, `MJ/Lists` and `MJ/Tags`, configurable with `exposedQueryCategories` in `skip.config.cjs`. Skip fetches any other query it needs with `GetSkipCatalogItems`. The `queryCatalog` request field (every query's name and category path) is no longer sent; Skip no longer reads it. Requires the Skip Brain release with the query catalog callbacks.
