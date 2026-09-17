---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Fix a broad sweep of defects found in a full code review:

- **Config**: a broken `skip.config.cjs` is now reported loudly (`LogError` with the path) and stops the directory walk instead of being silently treated as absent — a syntax error can no longer silently revert `enableEval`/`entitiesToSend` to defaults or load an ancestor directory's config. The loader also logs which file it loaded and probes the filesystem root.
- **Callback URL**: `callingServerURL` now honors MJServer's loaded `configInfo` (mj.config.cjs > env > defaults) instead of env vars only, and the advertised URL is logged at boot.
- **Callback keys**: a key whose scope assignment fails is deleted and the SDK falls back to the legacy key (previously a permanently-wedged zero-scope key was delivered to Skip); the middleware's boot scope check is derived from the provisioner's required-scope list (it had drifted, missing the `entity:*` scopes); the raw key is no longer re-sent on every request after delivery is confirmed; key labels are normalized against trailing-slash URL drift.
- **SSE transport**: a flat queue error as the final stream event no longer throws a TypeError or wrongly confirms callback-key delivery; premature stream close is a transport failure instead of a silent partial success; gzip streams can no longer hang forever on a mid-stream connection reset.
- **Eval endpoints**: `evalRunAgent`/`evalRunPrompt` now resolve the API key from the credential store like `chat()` does, instead of sending an empty `x-api-key` when `ASK_SKIP_API_KEY` is unset.
- **Agent**: `Error`-role conversation rows are excluded from transcripts sent to Skip (they corrupted retries and the truncation window); answers to clarifying questions are sent as `clarify_question_response` instead of `initial_request`; `SkipAgentContext.conversationId` is honored; component options are selected by best `AIRank`; `hiddenToUser` messages can no longer surface as completion text; ~1,100 lines of dead demo-spec code removed.
- **Hardening**: caller-supplied conversation/run IDs are validated as UUIDs before SQL filter interpolation; one failed entity no longer poisons the cached metadata payload with `null`; concurrent cold-start requests share one entity refresh instead of each launching a full sweep; entity field values are deduplicated by value.
- **Install lifecycle**: re-running setup updates the stored "Skip API Key" credential instead of failing on the unique constraint and discarding the operator's key; a blank entry keeps the existing key (and the prompt no longer displays it); teardown removes the credential.
