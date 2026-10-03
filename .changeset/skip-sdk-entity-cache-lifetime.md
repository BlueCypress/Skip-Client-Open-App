---
"@askskip/server": minor
---

Hold the Skip entity-metadata cache for the life of the process instead of expiring it every 15 minutes.

Building the payload is not a cheap read of the global provider's metadata: `buildEntityForSkip`
reconstructs the whole graph (`toJSON()` per entity and per field, then `new EntityInfo(...)`) and
`packFieldValues` runs a `SELECT DISTINCT` per eligible field. On a large client (~1,750 entities /
~20,169 fields) that is a second full copy of the catalog plus a wide sweep of the database, and
the former wall-clock expiry made every hour of active traffic pay for it roughly four times.
Metadata changes rarely, and when it does the host normally restarts or refreshes deliberately, so
re-enrichment now belongs to that event rather than to a timer.

**Behaviour change for hosts.** A long-running server no longer picks up entity-metadata changes
on its own. To refresh without a restart, call the new `SkipSDK.InvalidateEntitiesCache()` from
wherever metadata is already refreshed — in MJAPI that is the deliberate `METADATA_REFRESH_SIGNAL`
handler. The per-call `forceEntityRefresh` option is unchanged.

Also hardened the in-flight path: a concurrent caller now awaits the running build directly rather
than reading it back out of the cache subject, which would otherwise hand back `null` to anyone
arriving between an invalidation and the next build.
