---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Add structured error contract (SkipErrorDetail) to SkipAPIResponse, replacing the flat error string with machine-actionable error codes, retry guidance, and automatic callback key re-provisioning on invalid_callback_key errors.
