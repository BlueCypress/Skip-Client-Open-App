---
"@askskip/server": patch
---

Fix component registry 401 errors when the Skip API key is stored only in the encrypted credential store (not in ASK_SKIP_API_KEY env var). The middleware now resolves the key from the credential store at boot, matching the SDK's chat path.
