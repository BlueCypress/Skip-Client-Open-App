# @askskip/server

## 0.0.8

### Patch Changes

- 4f79a46: Fix component registry URI: replace non-existent `registry.askskip.ai` with the actual production endpoint (`brain-prod.askskip.ai/registry/api/v1`). Existing installs self-heal the stale URI on next boot.
- Updated dependencies [4f79a46]
  - @askskip/types@0.0.8
  - @askskip/core@0.0.8

## 0.0.7

### Patch Changes

- 32a28ac: Add scope reconciliation for callback API keys and forward databasePlatform through the eval pipeline

  - Callback key provisioner now reconciles scopes on existing keys at startup, adding missing scopes and removing stale ones
  - Added narrowly-scoped entity CRUD scopes (entity:read/create/update/delete) restricted to query-family entities via resource patterns
  - Moved databasePlatform resolution into buildBaseRequest so it flows consistently through eval and all request builders

- Updated dependencies [32a28ac]
  - @askskip/types@0.0.7
  - @askskip/core@0.0.7

## 0.0.6

### Patch Changes

- b7ad610: Replace ASK_SKIP_CHAT_URL with ASK_SKIP_URL base URL — the /chat endpoint is now derived automatically. Remove env var summary from setup wizard and clean up documentation.
- Updated dependencies [b7ad610]
  - @askskip/types@0.0.6
  - @askskip/core@0.0.6

## 0.0.5

### Patch Changes

- 335782f: Remove legacy config (orgID, organizationInfo, legacyCallbackAPIKey, callingServerAccessToken), add skip.config.cjs entity-filtering support with setup wizard prompt, use strongly-typed MJ entity subclasses, auto-sync mjVersionRange in CI, and add CONFIGURATION.md docs
- Updated dependencies [335782f]
  - @askskip/types@0.0.5
  - @askskip/core@0.0.5
