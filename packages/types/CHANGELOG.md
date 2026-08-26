# @askskip/types

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
