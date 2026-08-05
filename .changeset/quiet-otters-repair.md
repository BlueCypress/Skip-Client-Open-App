---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Recover from orphaned Skip callback keys and restore entity field value enrichment

- Track callback key delivery separately from creation. A key minted for a request that never reached Skip is now discarded instead of leaving a row that outlives its unrecoverable raw value and wedges every request after the next restart.
- Fail fast in `chat()` when no Skip API key resolves, before `buildSkipRequest()` mints a scoped callback key for a request the edge will reject. `chat()` now calls `ensureConfig()` itself, so the eval entry points also consult the credential store.
- Return `Metadata.Provider` rather than a `Metadata` instance from the SDK's provider getter. Every `getFieldDistinctValues()` call was failing with "provider.ExecuteSQL is not a function", so Skip received entity metadata with no database-derived possible values — which it needs to write functional queries and populate component spec filters.
- Cap distinct value queries at 500 rows per field with platform-aware syntax (`TOP` for SQL Server, `LIMIT` for PostgreSQL) and quoted identifiers, now that these queries actually execute on every entity cache refresh.
