---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Make the agent eval timeout configurable, and stop it failing at 300 seconds.

- `@askskip/core`:
  - New `evalRunAgentTimeoutMs` in `skip.config.cjs`. It defaults to 10 minutes; a value that is not a positive number is logged and replaced with the default.
  - New exports: `DEFAULT_EVAL_RUN_AGENT_TIMEOUT_MS` and `resolveEvalRunAgentTimeoutMs()`.
- `@askskip/server`:
  - `SkipSDK.evalRunAgent()` sends its request with a dispatcher whose header and body timeouts match that value, plus an `AbortSignal` with the same limit.
  - Before this, Node's fetch gave up after its 300-second wait for response headers, and long agent evals were reported as `fetch failed` while Skip was still running them.
  - A timeout now returns an error that names the limit and the setting.
  - Adds `undici` as a dependency.
