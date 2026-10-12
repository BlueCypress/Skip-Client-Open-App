---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Add a structured error for requests Skip stops at its time limit.

- `@askskip/types`: `SkipErrorType.timeout` and `SkipErrorCode.request_timeout`. Skip sends these when a request exceeds its processing time limit or its maximum age, instead of `unknown` / `execution_failed`, so clients can recognize a timeout without parsing the message.
- `@askskip/server`: `SkipSDK` recognizes `request_timeout`, logs it as a timeout, and does not retry it automatically — the same request would very likely run out of time again. The user-facing explanation still comes from the response's system message.
