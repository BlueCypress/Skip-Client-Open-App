---
"@askskip/server": patch
---

Show Skip's own explanation when a Skip run fails, instead of pipeline internals.

A failed run put `Pipeline failed at step 'Execute Sub-Agent: Skip: Data Expert':
Failed to process one or more query requirements` into the conversation — a
sentence naming steps nobody outside the pipeline has heard of. Skip had already
composed something written for the user and sent it in the same response.

`SkipSDK.chat` reports a Skip-side failure as `success: false` **with the response
attached**, and sets `error` to the internal `errorDetail.message`. `executeAgentInternal`
treated any `success: false` as a transport failure and returned `result.error` for
both the shown message and the recorded one, so the response — and the only
user-readable account of the failure — was discarded before `handleSkipError` could
route it. That made `handleSkipError` unreachable on every real Skip failure, which
is why routing the two accounts to their proper fields there had no visible effect.

Only a call that produced no response body at all is a transport failure. A response
body means Skip ran and reported its own outcome, so it now goes through
`mapSkipResponseToNextStep` regardless of the `success` flag, and `handleSkipError`
puts the prose on `message` and the diagnostic on `errorMessage`. MJ writes `message`
to `AIAgentRun.Message`, which `AgentRunner` shows as the conversation reply; the
run still terminates as `Failed`, so the message the user reads changes and the
recorded outcome does not.
