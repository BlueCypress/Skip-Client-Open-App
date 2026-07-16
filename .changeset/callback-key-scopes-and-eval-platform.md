---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Add scope reconciliation for callback API keys and forward databasePlatform through the eval pipeline

- Callback key provisioner now reconciles scopes on existing keys at startup, adding missing scopes and removing stale ones
- Added narrowly-scoped entity CRUD scopes (entity:read/create/update/delete) restricted to query-family entities via resource patterns
- Moved databasePlatform resolution into buildBaseRequest so it flows consistently through eval and all request builders
