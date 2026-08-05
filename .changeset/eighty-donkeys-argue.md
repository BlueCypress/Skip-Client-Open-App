---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Persist the configured Skip component registry URI instead of the production default

- `ensureSkipComponentRegistry()` called `getSkipRegistryURI()` with no argument at both the create and update sites, so the tenant's Component Registry record was always stamped `https://brain-prod.askskip.ai/registry` — even when the environment pointed the whole install at a different brain. The update branch also re-stamped it on every `mj app upgrade` and every MJAPI boot, reverting any manual correction of the row.
- Add `getConfiguredSkipRegistryURI()`, which resolves in the order MJ honors at runtime: `REGISTRY_URI_OVERRIDE_SKIP` (registry may live somewhere other than the chat endpoint) → `ASK_SKIP_URL` (the configured brain serves its own registry) → the URI already stored on the record, which is the production default on any instance that never overrode it.
- Because the stored URI is the last tier, setup now leaves a manually corrected row untouched when no registry/brain env vars are set, rather than resetting it to production on every re-run.
- Document `REGISTRY_URI_OVERRIDE_SKIP` and `REGISTRY_API_KEY_SKIP` in CONFIGURATION.md, including why MemberJunction derives those names from the registry record's `Name`.
- Cover the resolution order with unit tests (`@askskip/core` now runs vitest).
