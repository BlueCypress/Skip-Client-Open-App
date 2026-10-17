---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Add `ProfileEntityFields`: per-entity row counts and column statistics (coverage, blank text, zero numbers, placeholder dates, lengths, bounds; PostgreSQL cardinality), computed through the BaseView, sampled on large tables, bounded at the database and cached in memory with weekly refresh and failure backoff. `TestAndProfileQuerySQL` gains `zeroCount`, `blankCount`, `sentinelCount` and placeholder-free `minDate`/`maxDate`, leaves long text out of `COUNT(DISTINCT)`, and bounds its statement. Requires MemberJunction 6.1.5 or later.
