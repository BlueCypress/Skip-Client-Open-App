# @askskip/server

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
