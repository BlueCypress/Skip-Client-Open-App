---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

`TestAndProfileQuerySQL` profiles a small result from the rows the test already fetched instead of running the candidate query a second time. With `Profile` set, the test leg fetches up to 1,002 rows; when the result has 1,001 rows or fewer, the same statistics the SQL aggregate pass computes (distinct, null, blank, numeric range, non-zero, placeholder and date range counts, with SQL Server's case- and trailing-space-insensitive text comparison) are computed in memory, and the profile query is not run. Larger results keep the SQL profile pass. The caller still receives at most the `MaxRows` rows it asked for; the extra rows never leave the client's server. On ACR, a profiled Test SQL over a composed ground truth query paid ~20 s for the test plus a 15 s profile timeout and got no statistics; it now runs the query once. No new scope and no migration.
