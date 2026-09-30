---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Forward Skip's `artifactRequest` to MemberJunction as a per-step `artifactDirective` (Skip-Brain #529), and tell Skip which client features it can rely on.

- `@askskip/types`: `SkipAPIClarifyingQuestionResponse.artifactRequest` — a clarifying question (e.g. PRD review) now says whether its draft payload belongs to a new artifact or versions an existing one.
- `@askskip/types`: `SkipAPIRequest.clientCapabilities` and `SkipAPIRequest.skipSDKVersion`, plus the `SkipClientCapability` names. Skip treats an absent `clientCapabilities` as an older client and does not rely on any capability.
- `@askskip/server`: `SkipProxyAgent` maps `new_artifact` → `create-new` and `new_artifact_version` → `version-source` (+ `targetArtifactId`) on both `analysis_complete` and `clarifying_question`, so a same-conversation new component is no longer saved as version N of the previous artifact, and a retargeted modify versions the right artifact.
- `@askskip/server`: `SkipSDK` sends `clientCapabilities: ['artifactDirective']` and its own package version on every request.

**Requires MemberJunction 6.1.4 or later.** The `@memberjunction/*` peers of `@askskip/core` and `@askskip/server` are now `^6.1.4`, and `mjVersionRange` follows. Hosts on MJ 5.x stay on `@askskip/*` 0.3.3 and must upgrade MJ before taking this release.
