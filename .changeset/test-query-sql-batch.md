---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Add `TestQuerySQLBatch`: up to 50 transient `TestQuerySQL` requests in one GraphQL call, run in order on the caller's request context and returned one result per item in the same order. Each item goes through MJ's own `TestQuerySQL` resolver, so it is authorized (`query:test`), executed on the read-only connection and capped by `MaxRows` exactly as a standalone call, and an item that fails reports its own error without failing the others. A batch over the limit, a key without `query:test`, or a missing read-only connection refuses the batch as a whole. New exports in `@askskip/types`: `TestQuerySQLInput`, `TestQuerySQLResult`, `TestQuerySQLBatchInput`, `TestQuerySQLBatchResult` and `TEST_QUERY_SQL_BATCH_MAX_ITEMS`. No new scope and no migration.
