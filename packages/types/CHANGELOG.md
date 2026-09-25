# @askskip/types

## 0.3.2

### Patch Changes

- 9a56d6e: Support per-environment Skip component registries, so components built against a non-production brain keep resolving to that brain.

  A component spec stores the _name_ of the registry it came from, and MJ resolves that name to a URI at render time (`ComponentRegistryResolver.getRegistryByName` matches on `Name`). Every brain previously published under the single name `Skip`, and the client's one `Skip` registry record had its URI rewritten on each boot to follow `ASK_SKIP_URL`. The name therefore denoted "whatever brain this client currently points at" rather than a specific server, so flipping `ASK_SKIP_URL` back to production silently invalidated every component generated against stage or a local brain — they resolved to production and 404'd.

  The brain now reports which registry name it publishes under via `GET /registry/api/v1/registry`, and the SDK reads it rather than deriving it. Deriving client-side would be guessing: a URL is not an identity, and independent derivation on both sides lets them disagree silently, producing `Registry not found: <name>` with no obvious cause. An unreachable brain, or one predating this field, yields the production default — the previous behavior.

  - `fetchSkipRegistryName()` asks the brain for its registry name, returning `null` on any failure so callers leave existing records alone rather than creating a wrongly-named one.
  - `REGISTRY_URI_OVERRIDE_<NAME>` and `REGISTRY_API_KEY_<NAME>` are now derived from the registry name via `deriveRegistryEnvVarSuffix()`, mirroring MJ's own derivation (uppercase, non-alphanumerics to `_`). Previously both were hardcoded to the production spelling, which MJ would never read on a non-production instance. Note that names must stay distinct _after_ this transformation — `Skip-Stage` and `Skip_Stage` both derive to `SKIP_STAGE`.
  - `DEFAULT_SKIP_REGISTRY_NAME` moves to `@askskip/types` (re-exported from `@askskip/core`, so importers are unaffected). The Skip brain repository already depends on that package and falls back to the same default independently — the brain when `SKIP_REGISTRY_NAME` is unset, the SDK when the brain reports no name. Two literals could drift, and they would only disagree visibly as `Registry not found` at render time. Nothing else about registry naming is shared: the `SKIP_REGISTRY_NAME` variable is read by the brain alone, and the env-var derivation is used by the SDK alone, so both stay where they are used.
  - `deriveSkipRegistryID()` gives each registry name a deterministic record ID, so setup is idempotent and a future promotion has a known target to repoint `__mj.Component.SourceRegistryID` at. Production resolves to the legacy pinned GUID (`B2F8C247-…`) — the same one MJ core seeded and still tombstones — so existing installs are untouched.
  - `ensureSkipComponentRegistry()` now looks up by exact name without capping at one row, and reports rather than repairs two shapes it cannot safely fix: duplicate names, and a record whose ID is not the expected one. `ComponentRegistry.Name` has no unique constraint at either the SQL or entity-metadata layer, and MJ's resolver picks the first `.find()` match, so duplicates resolve arbitrarily. A record's primary key is not rewritten because `FK_Component_SourceRegistry` references it.
  - The uninstall filter now covers the whole `Skip-*` family, so uninstalling from a stage- or local-pointed instance does not strand its registry record.

  - The production `Skip` registry record now self-heals. Once each environment publishes under its own name, `Skip` means production and nothing else, so its URI should always be the production one. Instances upgraded from the single-registry era will not have that: their `Skip` row was rewritten on every boot to follow `ASK_SKIP_URL`, so any client ever pointed at stage or a laptop still has that host stored, and name-scoped lookup means nothing revisits it. `healProductionRegistryIfUnused()` restores it on every boot where this instance publishes under a different name — the first boot after upgrading repairs the row, every later boot is a no-op. An explicit `REGISTRY_URI_OVERRIDE_SKIP` is always respected, and an instance genuinely using `Skip` is left to the normal resolution order.
  - Registry reconciliation is now driven by use rather than by startup alone. The registry name belongs to the brain, so the client must ask for it — and asking only at boot is not enough in practice: MJAPI and the Skip API are routinely started hours apart locally, and a brain can be down for a maintenance window. A retry with any fixed cap fails both, since the cap either expires before the brain returns or polls a dead host for the life of the process. Instead, every successful `SkipSDK.chat()` call — proof the brain is up _right now_ — triggers a fire-and-forget reconcile if startup did not already succeed, and re-checks the reported name at most every 5 minutes so a rename while the client is running is picked up without a restart. A client that never uses Skip never makes a call. Ordering works out on its own: a chat request does not need the registry record, and a component must be generated before it can be rendered.
  - The registry API key is now stored as a `Component Registry: <Name>` credential. MJ resolves a registry's key as `REGISTRY_API_KEY_<ID>` → `REGISTRY_API_KEY_<NAME>` → `mj.config.cjs` → credential store; the first two are process environment, set only when the client reached the brain at startup. Since every Skip registry route requires authentication, that made _rendering_ depend on boot order — a client started before the Skip API would 401 on every component fetch for the rest of the process, even after the brain came up. The credential is read at fetch time and survives restarts, removing the dependency. It reconciles rather than creates-once, so a corrected `ASK_SKIP_API_KEY` is not shadowed by a stale stored value; environment still outranks it at resolution time.
  - `SKIP_REGISTRY_NAME` set in the _client's_ environment is now reported. It configures the brain, and the client never reads it, so setting it here was previously a silent no-op that reads as the feature being broken.
  - Skip registry records this instance is not using are reported at boot and never deleted. A mistyped or since-corrected registry name leaves a record behind, and components generated while it was configured are stamped with that name permanently — they resolve only for as long as the record exists, so removing it silently breaks them.
  - An unreachable brain no longer causes registry changes. `resolveRegistryName()` now returns `null` for "unknown" instead of collapsing to the production default, and the client then derives no `REGISTRY_*` variables and touches no registry records for that boot. Previously a brain that was merely slow to start would make a client pointed at a local brain manage the _production_ `Skip` record and rewrite its URI to `localhost` — the exact drift this release exists to eliminate, reachable through an ordinary transient outage.

  No migration ships with this change and none is needed: the production GUID is already canonical in every install, and the per-environment registries do not exist yet, so they are created correctly from the start.

  Production behavior is unchanged end to end — an unset registry name resolves to `Skip`, the legacy GUID, and the existing env var spellings.

- 9ac7382: Declare `express`, `type-graphql` and `graphql-type-json` in `@askskip/server`.

  The package imported all three without declaring any of them. npm's flat `node_modules` hid
  that — the host's copies were visible to us by accident — but pnpm gives a package only what it
  declares, so `tsc` failed with TS2307 on all three and the package could not build as a member
  of a pnpm workspace (how MJ 6.x and `mj dev workspace` install it).

  They are declared as `peerDependencies`, alongside the `@memberjunction/*` entries, because they
  must be the MJ host's own copies: the Router we mount belongs to the host's express app, our
  resolver's decorators must write into the type-graphql metadata storage the host's schema is
  built from, and `GraphQLJSONObject` must come from the host's graphql realm. `@types/express`
  is added as a devDependency for the type-only import. No new package enters the dependency tree.

## 0.3.1

### Patch Changes

- 44067ad: Fix a broad sweep of defects found in a full code review:

  - **Config**: a broken `skip.config.cjs` is now reported loudly (`LogError` with the path) and stops the directory walk instead of being silently treated as absent — a syntax error can no longer silently revert `enableEval`/`entitiesToSend` to defaults or load an ancestor directory's config. The loader also logs which file it loaded and probes the filesystem root.
  - **Callback URL**: `callingServerURL` now honors MJServer's loaded `configInfo` (mj.config.cjs > env > defaults) instead of env vars only, and the advertised URL is logged at boot.
  - **Callback keys**: a key whose scope assignment fails is deleted and the SDK falls back to the legacy key (previously a permanently-wedged zero-scope key was delivered to Skip); the middleware's boot scope check is derived from the provisioner's required-scope list (it had drifted, missing the `entity:*` scopes); the raw key is no longer re-sent on every request after delivery is confirmed; key labels are normalized against trailing-slash URL drift.
  - **SSE transport**: a flat queue error as the final stream event no longer throws a TypeError or wrongly confirms callback-key delivery; premature stream close is a transport failure instead of a silent partial success; gzip streams can no longer hang forever on a mid-stream connection reset.
  - **Eval endpoints**: `evalRunAgent`/`evalRunPrompt` now resolve the API key from the credential store like `chat()` does, instead of sending an empty `x-api-key` when `ASK_SKIP_API_KEY` is unset.
  - **Agent**: `Error`-role conversation rows are excluded from transcripts sent to Skip (they corrupted retries and the truncation window); answers to clarifying questions are sent as `clarify_question_response` instead of `initial_request`; `SkipAgentContext.conversationId` is honored; component options are selected by best `AIRank`; `hiddenToUser` messages can no longer surface as completion text; ~1,100 lines of dead demo-spec code removed.
  - **Hardening**: caller-supplied conversation/run IDs are validated as UUIDs before SQL filter interpolation; one failed entity no longer poisons the cached metadata payload with `null`; concurrent cold-start requests share one entity refresh instead of each launching a full sweep; entity field values are deduplicated by value.
  - **Install lifecycle**: re-running setup updates the stored "Skip API Key" credential instead of failing on the unique constraint and discarding the operator's key; a blank entry keeps the existing key (and the prompt no longer displays it); teardown removes the credential.

## 0.3.0

### Minor Changes

- f3512d3: Support MemberJunction 6.1 **in addition to** 5.51 — this is an additive compatibility widening, not a migration.

  PR #21 widened `mj-app.json` `mjVersionRange` to `>=5.51.0 <7.0.0` so the manifest would accept a 6.x host, but no release was cut afterwards — the `v0.1.0` tag still carries `>=5.51.0 <6.0.0`, and `mj app install` resolves an app's manifest at its release tag, not at `next`. It was also only half the fix: all 25 `@memberjunction/*` specifiers still demanded 5.x, so on a 6.1 host `npm ci` failed with ERESOLVE regardless of what the manifest claimed.

  Every consumer-facing `@memberjunction/*` range becomes `^5.51.0 || ^6.1.0-edge.4`. A single span such as `>=5.51.0 <7.0.0` cannot work here: node-semver only matches a prerelease when the range carries a comparator with that same `major.minor.patch`, so `6.1.0-edge.4` fails every plain span. The union is the narrowest expression that admits 5.51.x, 6.1.0-edge.4, and stable 6.x alike. `devDependencies` stay pinned at `^6.1.0-edge.4` — build toolchain only, invisible to consumers.

  `mjVersionRange` stays at `>=5.51.0 <7.0.0` (as #21 set it). The Open App engine coerces a prerelease host version to its base before testing the range, so `6.1.0-edge.4` is evaluated as `6.1.0` and satisfies it.

  Verified by building the whole workspace twice from one source tree: once resolved against `@memberjunction/core@6.1.0-edge.4` and once forced down to `5.51.0`. Both green, no source changes — which is what makes the dual range honest rather than aspirational.

  Keeping 5.51 support is deliberate: `BlueCypress/more-cheese` runs MJ 5.51.0 on stage and prod and depends on `@askskip/server`. Dropping the 5.x floor would have stranded a production environment on 0.1.x.

## 0.2.0

### Minor Changes

- MemberJunction 6.1 compatibility.

  PR #21 already widened `mj-app.json` `mjVersionRange` to `>=5.51.0 <7.0.0` so the manifest would accept a 6.x host, but that fix was never released — the `v0.1.0` tag still carries `>=5.51.0 <6.0.0`, and `mj app install` reads the manifest at the tag, not at `next`. More importantly the fix was only half the problem: all 25 `@memberjunction/*` pins across the three packages were still `^5.51.0`/`^5.45.1`, so on an MJ 6.1 host `npm ci` fails with ERESOLVE on the peer conflict regardless of what the manifest says.

  This raises every `@memberjunction/*` pin to `^6.1.0-edge.4` and lifts the manifest floor to `>=6.1.0-edge.4 <7.0.0`. The floor moves up rather than staying at 5.51 because the packages now genuinely require 6.1 — leaving it at `>=5.51.0` would advertise a compatibility the peers no longer allow.

  No source changes; all three packages compile unmodified against 6.1.0-edge.4.

## 0.1.0

### Minor Changes

- 6808109: **Minimum MemberJunction version is now 5.51.0** (`mjVersionRange` and every
  `@memberjunction/*` peer range). 5.45–5.47 lacked `RenderedSQL` on
  `TestQuerySQLResult` and `RunQueryResult`, which the new profiling contract
  returns; supporting versions that cannot supply it meant either dropping the
  field or reading it structurally, and neither is worth carrying now that every
  client runs 5.51.0.

  Add `TestAndProfileQuerySQL`, a Skip-owned GraphQL resolver that returns MJ's
  `TestQuerySQL` result plus, on request, aggregate statistics computed over the
  **full uncapped** result set inside the client's own database.

  `TestQuerySQL` caps its result with a real SQL `TOP N`, so `RowCount` is a cap
  rather than a count and the true cardinality of a result is unknowable from the
  response. A caller shown three unordered rows of a needle-in-haystack aggregate
  sees zeros everywhere and concludes its join is broken. Profiling answers that
  with per-column distinct/null counts, numeric min/max/non-zero counts, and a real
  `totalRows` — none of which requires a row to leave the database.

  Disclosure is strictly narrower than the call it supersedes. The aggregate SQL is
  generated deterministically from the executed result's own columns, so the caller
  never selects what is profiled and cannot influence the projection. Literal values
  appear only as `domainValues`, behind a cardinality ceiling, a k-anonymity floor
  enforced in the `HAVING` clause, and a default-deny sensitivity check — all
  evaluated on the client's server.

  - New shared contract in `@askskip/types` (`profile-types.ts`). The resolver's
    TypeGraphQL classes `implement` those interfaces, so the wire types cannot drift
    from the shared definition without failing the build.
  - `SkipMiddleware.GetResolverPaths()` now registers `resolvers/*Resolver.{js,ts}`.
  - Adds `@memberjunction/generic-database-provider`, `sql-parser`, `sql-dialect`
    and `core-entities-server` to `peerDependencies`.

  **New `query:profile` API scope**, seeded by
  `V202608172304__skip_client_query_profile_scope.sql` and removed on teardown.
  The migration seeds **two** records: the `__mj.APIScope` catalog entry and an
  `__mj.APIApplicationScope` ceiling grant for the MJAPI application. Authorization
  is evaluated at both levels — a key holding the scope is still denied
  ("Application does not allow this scope/resource combination") without the ceiling
  row, and MJ core only ships ceiling rows for scopes MJ itself ships.
  MJ core's scope catalog describes MJ's own resolvers, so it has no reason to ship
  a scope for one that exists only where this app is installed — the app seeds it,
  the callback-key provisioner reconciles it onto the Skip key, and the teardown
  hook removes it.

  Granting it separately from `query:test` is what makes profiling independently
  revocable: profiling runs the candidate query uncapped, which is a different cost
  profile than a capped test, and an operator may reasonably permit one and not the
  other. Revoking it degrades rather than breaks — the call still authorizes and
  returns its test result, with `ProfileUnavailableReason: 'not-authorized'` in
  place of statistics.

  Additive and inert: nothing calls the resolver until Skip does, and Skip degrades
  to `TestQuerySQL` against deployments that predate it.

## 0.0.12

### Patch Changes

- c7c024d: Persist the configured Skip component registry URI instead of the production default

  - `ensureSkipComponentRegistry()` called `getSkipRegistryURI()` with no argument at both the create and update sites, so the tenant's Component Registry record was always stamped `https://brain-prod.askskip.ai/registry` — even when the environment pointed the whole install at a different brain. The update branch also re-stamped it on every `mj app upgrade` and every MJAPI boot, reverting any manual correction of the row.
  - Add `getConfiguredSkipRegistryURI()`, which resolves in the order MJ honors at runtime: `REGISTRY_URI_OVERRIDE_SKIP` (registry may live somewhere other than the chat endpoint) → `ASK_SKIP_URL` (the configured brain serves its own registry) → the URI already stored on the record, which is the production default on any instance that never overrode it.
  - Because the stored URI is the last tier, setup now leaves a manually corrected row untouched when no registry/brain env vars are set, rather than resetting it to production on every re-run. Setup warns when that stored value stands and is not the production default — the case it cannot verify, and how a database restored from another environment would otherwise keep serving components from that environment's brain in silence.
  - Document `REGISTRY_URI_OVERRIDE_SKIP` and `REGISTRY_API_KEY_SKIP` in CONFIGURATION.md, including why MemberJunction derives those names from the registry record's `Name`.
  - Cover the resolution order with unit tests (`@askskip/core` now runs vitest).

- b102f36: Recover from orphaned Skip callback keys and restore entity field value enrichment

  - Track callback key delivery separately from creation. A key minted for a request that never reached Skip is now discarded instead of leaving a row that outlives its unrecoverable raw value and wedges every request after the next restart.
  - Fail fast in `chat()` when no Skip API key resolves, before `buildSkipRequest()` mints a scoped callback key for a request the edge will reject. `chat()` now calls `ensureConfig()` itself, so the eval entry points also consult the credential store.
  - Return `Metadata.Provider` rather than a `Metadata` instance from the SDK's provider getter. Every `getFieldDistinctValues()` call was failing with "provider.ExecuteSQL is not a function", so Skip received entity metadata with no database-derived possible values — which it needs to write functional queries and populate component spec filters.
  - Cap distinct value queries at 500 rows per field with platform-aware syntax (`TOP` for SQL Server, `LIMIT` for PostgreSQL) and quoted identifiers, now that these queries actually execute on every entity cache refresh.

## 0.0.11

## 0.0.10

### Patch Changes

- eaed166: Add structured error contract (SkipErrorDetail) to SkipAPIResponse, replacing the flat error string with machine-actionable error codes, retry guidance, and automatic callback key re-provisioning on invalid_callback_key errors.

## 0.0.9

### Patch Changes

- fa69105: Fix component registry URI: use `/registry` (not `/registry/api/v1`) as the base URI — MJ's ComponentRegistryClient already appends `/api/v1/...` paths, so the previous value doubled the prefix. Centralizes URI construction in `getSkipRegistryURI()` to prevent future divergence. Existing installs self-heal the stale URI on next boot.

## 0.0.8

### Patch Changes

- 4f79a46: Fix component registry URI: replace non-existent `registry.askskip.ai` with the actual production endpoint (`brain-prod.askskip.ai/registry/api/v1`). Existing installs self-heal the stale URI on next boot.

## 0.0.7

### Patch Changes

- 32a28ac: Add scope reconciliation for callback API keys and forward databasePlatform through the eval pipeline

  - Callback key provisioner now reconciles scopes on existing keys at startup, adding missing scopes and removing stale ones
  - Added narrowly-scoped entity CRUD scopes (entity:read/create/update/delete) restricted to query-family entities via resource patterns
  - Moved databasePlatform resolution into buildBaseRequest so it flows consistently through eval and all request builders

## 0.0.6

### Patch Changes

- b7ad610: Replace ASK_SKIP_CHAT_URL with ASK_SKIP_URL base URL — the /chat endpoint is now derived automatically. Remove env var summary from setup wizard and clean up documentation.

## 0.0.5

### Patch Changes

- 335782f: Remove legacy config (orgID, organizationInfo, legacyCallbackAPIKey, callingServerAccessToken), add skip.config.cjs entity-filtering support with setup wizard prompt, use strongly-typed MJ entity subclasses, auto-sync mjVersionRange in CI, and add CONFIGURATION.md docs
