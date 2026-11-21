---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

The SDK no longer sends query properties Skip never reads: `QualityRank`, `EmbeddingModelID`, `EmbeddingModelName`, `SQLDialectID`, `UsesTemplate`, `CacheEnabled`, `CacheMaxSize`, `CacheTTLMinutes` and `CacheValidationSQL`. `IsApproved` and `CategoryID` are still sent. On `SkipQueryInfo` those members are now optional and deprecated, so `SkipQueryInfo` no longer implements MJ's `IQueryInfoBase`, which requires some of them.
