---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Forward Skip's `artifactRequest` to MemberJunction as a per-step `artifactDirective` (Skip-Brain #529).

- `@askskip/types`: `SkipAPIClarifyingQuestionResponse.artifactRequest` — a clarifying question (e.g. PRD review) now says whether its draft payload belongs to a new artifact or versions an existing one.
- `@askskip/server`: `SkipProxyAgent` maps `new_artifact` → `create-new` and `new_artifact_version` → `version-source` (+ `targetArtifactId`) on both `analysis_complete` and `clarifying_question`, so a same-conversation new component is no longer saved as version N of the previous artifact, and a retargeted modify versions the right artifact.

Both behaviors depend on the host: the directive is honored only on MJ releases carrying `BaseAgentNextStep.artifactDirective` (6.1.0+; the change ships on the 6.x line only, and is not being backported to 5.x) and only once Skip-Brain emits `artifactRequest` on the relevant responses — on older hosts it is inert and behavior is unchanged.
