---
"@askskip/server": patch
---

Build the Skip entity payload once per process, refresh it when entity scope changes at runtime, and stop querying the database for field values.

**No more 15-minute rebuild.** The entity payload is a projection of MJ metadata. Everything in it
except scope comes from CodeGen: descriptions, organic keys and value lists. A schema change means
CodeGen and an MJAPI restart, and the restart clears the cache. The old wall-clock expiry made a
busy server rebuild a full copy of the catalog roughly four times an hour, for changes that cannot
happen without a restart.

**Runtime scope changes still reach Skip.** The SDK subscribes to the MJGlobal event stream for
saves, deletes and remote invalidations of `MJ: Entities` and `MJ: Entity Fields` rows, the
records that hold entity and field `ScopeDefault`. MJ refreshes its own metadata on a debounce
after such a write. The SDK therefore rebuilds once the provider has swapped in its refreshed
metadata, not on the event itself, which would rebuild from the old metadata. Hosts need no
wiring. `SkipSDK.InvalidateEntitiesCache()` and the per-call `forceEntityRefresh` remain as manual
levers.

**Field values come from metadata only.** The SDK no longer runs a `SELECT DISTINCT` per field or
reads the legacy `ValuesToPackWithSchema` setting. Each field's `EntityFieldValues` are sent as
CodeGen maintains them, parsed from CHECK constraints or taken from value lists in
`additionalSchemaInfo`. This removes the database sweep from every build. Each value's own `Code`
is now sent instead of a copy of its `Value`. Fields that previously got data-sampled values (`All`
or `ListOrUserEntry`) now carry only their declared values.

The build is now synchronous and in memory. A build that throws, or that runs before the provider
has loaded any metadata, is not cached and is retried on the next request.
