---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Add structured errors for requests that reach an organization's Skip spending limits.

- `@askskip/types`: `SkipErrorType.spend_limit`, with `SkipErrorCode.request_cost_cap_reached` (Skip stopped the request at the organization's cost cap for one request) and `SkipErrorCode.monthly_spend_limit_reached` (Skip refused the request before running it because the organization has spent its monthly limit). Skip sends these instead of `component` / `execution_failed` and `validation` / `rate_limit_exceeded`, so clients can recognize a spending limit without parsing the message.
- `@askskip/server`: `SkipSDK` recognizes `spend_limit`, logs it, and does not retry it automatically, since a retry would reach the same limit. The user-facing explanation still comes from the response's system message.
