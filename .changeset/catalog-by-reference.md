---
"@askskip/types": minor
"@askskip/core": minor
"@askskip/server": minor
---

Chat requests send the entity and query catalogs by reference: one manifest hash per kind (`catalogRefs`) instead of the full catalogs. When Skip doesn't hold a manifest it answers `catalog_miss`, and the SDK resends the manifest plus only the items that changed since the last manifest Skip accepted (every item once per MJAPI process). If Skip still lacks items it lists them, and the SDK sends exactly those; after two resends it falls back to the full catalogs. On More Cheese an unchanged turn drops from about 680 KB (gzipped) to about 8 KB.

**Requires a Skip Brain that understands `catalogRefs`.** Upgrade only after Skip has released it. `catalogByReference: false` in `skip.config.cjs` sends the full catalogs as before. Eval runs (`/eval/run`) always send the full catalogs.

New: `@askskip/types/catalog` (canonical form, hashing, verification), `SkipErrorCode.catalog_miss`, `SkipRetryAction.resend_catalog`.
