---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Fix component registry URI: replace non-existent `registry.askskip.ai` with the actual production endpoint (`brain-prod.askskip.ai/registry/api/v1`). Existing installs self-heal the stale URI on next boot.
