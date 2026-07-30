# @askskip/types

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
