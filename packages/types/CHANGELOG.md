# @askskip/types

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
