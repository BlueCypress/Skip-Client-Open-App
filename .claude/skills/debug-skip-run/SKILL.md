---
name: debug-skip-run
description: Debug a Skip-Brain agent run by analyzing execution logs, tracing the agent hierarchy, identifying linter false positives vs real errors, and recommending fixes. Use when given an agent run ID to investigate.
disable-model-invocation: true
arguments: agentRunId context
argument-hint: <agent-run-id> [optional context]
---

# Debug Skip-Brain Agent Run

Analyze agent run **$agentRunId** to identify what went wrong and recommend fixes.

$context

## Quick Start

1. **Get the summary**: `Get_Agent_Run_Summary(runId=$agentRunId)`
2. **Determine run type**: Controller, Conductor, or direct UCG run?
3. **Trace to UCG** if needed (see [tracing guide](reference.md#tracing-pattern))
4. **Analyze test failures** against the [error catalog](reference.md#error-catalog)
5. **Extract component code** to verify errors
6. **Classify each error**: true positive, false positive, or design issue?

## Agent Hierarchy

```
Controller -> Conductor -> Requirements Expert
                        -> Data Expert
                        -> TPM -> Software Architect
                              -> UCG (generates + tests + fixes code)
```

Each sub-agent step has a `TargetLogID` pointing to the child run. Trace via `Get_Agent_Run_Step_Full_Data` -> read `TargetLogID` -> `Get_Agent_Run_Summary` on child.

## UCG Step Pattern

| Step | Type | What It Does |
|------|------|--------------|
| 1001 | Prompt | Initial code generation |
| 1002 | Validation | Test Integrated Components (linter + browser) |
| 1003 | Prompt | Fix Iteration 2 |
| 1004 | Validation | Test again |
| ...  | ... | Up to 4 fix cycles |
| Final | Prompt | Visual Component Evaluation |

## What to Check

For **each failed test step**, classify every error:

- **True positive**: LLM made a real mistake, linter correctly caught it
- **False positive**: Linter bug -- code is correct but rule flagged it
- **Design issue**: Upstream agent (RE, DE, SA) made a wrong design decision that cascaded

See [reference.md](reference.md) for the complete error catalog, common LLM mistakes, false positive patterns, MJ component issues, and the full tracing procedure.

## Output Format

1. **Summary**: What was Skip trying to do? What went wrong?
2. **Root Cause**: Linter bug, prompt gap, generated code mistake, component spec mismatch, or design issue?
3. **Verdict for Each Error**: True positive or false positive?
4. **Recommended Fixes**: Specific files to modify and what to change
5. **Prevention**: How to prevent this class of error in future runs
