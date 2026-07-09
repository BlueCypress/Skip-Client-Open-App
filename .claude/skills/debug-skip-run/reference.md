# Debug Skip Run — Reference Guide

## Tracing Pattern

### Controller -> UCG Trace

```
# 1. Start with Controller summary
Get_Agent_Run_Summary(runId=CONTROLLER_ID)
# Find step 2 (Execute Skip: Conductor)

# 2. Get Conductor run ID
Get_Agent_Run_Step_Full_Data(runId=CONTROLLER_ID, stepNumber=2)
# Read TargetLogID from the step data

# 3. Get Conductor summary, find TPM step (usually step 4)
Get_Agent_Run_Summary(runId=CONDUCTOR_ID)
Get_Agent_Run_Step_Full_Data(runId=CONDUCTOR_ID, stepNumber=4)
# Read TargetLogID for TPM run

# 4. Get TPM summary, find UCG step (usually step 3)
Get_Agent_Run_Summary(runId=TPM_ID)
Get_Agent_Run_Step_Full_Data(runId=TPM_ID, stepNumber=3)
# Read TargetLogID for UCG run

# 5. Now analyze the UCG run
Get_Agent_Run_Summary(runId=UCG_ID)
```

### Extracting Component Code

1. Get the UCG generation/fix step full data -> read `TargetLogID`
2. Call `Get_AI_Prompt_Run_Detail` with that TargetLogID (maxChars 15000)
3. The result's `data` field contains JSON: `{"components": [{"name", "path", "code"}]}`

## Error Catalog

### Component Linter Errors (Static Analysis)

| Rule | Severity | Description | False Positive Risk |
|------|----------|-------------|---------------------|
| `no-react-destructuring` | critical | LLM destructured hooks from React object | Low -- always a real mistake |
| `no-window-access` | critical | Component references `window` object | Low |
| `no-import-statements` | critical | Module imports not allowed in runtime | Low |
| `runquery-parameters-validation` | critical | RunQuery params wrong format | Medium -- may fire on variable references like `Parameters: params` |
| `runquery-runview-validation` | critical | SQL keywords detected in query name | **High** -- query names containing "Join", "From", "Select", "Update" trigger false positives |
| `child-component-prop-validation` | high | Wrong prop on registry component | Low -- but check if prop was recently added to spec |
| `chart-field-validation` | high | Chart groupBy/valueField references wrong field | **High** -- fires on client-side transformed data (`{category, amount}` from `.map()`) |
| `datagrid-field-validation` | high | DataGrid column field doesn't exist on entity | **High** -- fires on computed fields (`Rank`, `MemberName` from `.map()`) and when no `entityName` is set |
| `required-queries-not-called` | critical | Queries in spec but RunQuery not called | **High** -- fires when queries are called in child components, not root |
| `unused-libraries` | critical | Libraries declared but not used | **High** -- fires when libraries are used in child components, not root |
| `useeffect-unstable-dependencies` | high | Props like `utilities.rq` in useEffect deps array | Low -- always a real mistake |
| `entity-field-access-validation` | high | Entity field access issues | Medium |
| `runquery-missing-categorypath` | high | RunQuery call missing CategoryPath | Low |
| `event-parameter-validation` | high | Wrong property access on event callback (e.g., `e.data` instead of `e.record`) | Low |

### Runtime Errors (Browser Execution)

| Error | Description | Notes |
|-------|-------------|-------|
| `render-loop` | Excessive createElement calls | Threshold: 50K hard ceiling or sustained >1000/100ms after 3s. False positive for complex components with EntityDataGrid + SimpleChart. |
| `Invalid JSX element type` | Component resolved to undefined/object | **Currently suppressed** -- not reported as violations. Check console for `JSX element error detected but not reported`. |
| `TypeError: fetch failed` | Network issue to MJAPI | Not a code issue -- check MJAPI connectivity |
| `EventID = 'undefined'` in SQL | Wrong event parameter access | LLM used `e.data` instead of `e.record` on DataGrid onRowClick |

### Common LLM Mistakes

| Mistake | Correct Pattern | Where to Fix |
|---------|-----------------|--------------|
| `const { useState } = React` | Hooks are globals -- just use `useState` directly | UCG critical reminders |
| `e.data` for DataGrid row click | `e.record` -- DataGrid passes `{record, cancel}` | DataGrid spec exampleUsage |
| `OpenEntityRecord` for filtered lists | Inline EntityDataGrid/DataGrid with filtered data | Requirements Expert prompt (NAV section) |
| `Parameters: { Status: ['Active'] }` for scalar | `Parameters: { Status: 'Active' }` -- match query spec type | UCG critical rules #7 |
| `entityPrimaryKeys` on EntityDataGrid | Auto-detected internally -- not a user prop | EntityDataGrid spec/TDD |
| `dataPointClick` instead of `onDataPointClick` | Add `on` prefix for event props | UCG critical rules #6 |
| `<div style={{height: '300px'}}><SimpleChart />` | Pass `height={300}` prop directly -- don't use wrapper | SimpleChart description and height prop docs |
| `window.antd` | Just `antd` -- libraries are globals | UCG critical reminders #1 |

## MJ Generic Component Reference

### Spec vs Code Locations

| Component | Spec | Code | Description |
|-----------|------|------|-------------|
| DataGrid | `metadata/components/spec/generic/data-grid.spec.json` | `metadata/components/code/generic/data-grid.js` | Data-agnostic grid, you pass data via props |
| EntityDataGrid | `entity-data-grid.spec.json` | `entity-data-grid.js` | Auto-loads entity data via RunView |
| SimpleChart | `simple-chart.spec.json` | `simple-chart.js` | Chart.js wrapper, single series |
| SimpleDrilldownChart | `simple-drilldown-chart.spec.json` | `simple-drilldown-chart.js` | Chart with built-in drill-down |
| SingleRecordView | `single-record-view.spec.json` | `single-record-view.js` | Displays one record's fields |
| OpenRecordButton | `open-record-button.spec.json` | `open-record-button.js` | Button that opens entity record |
| DataExportPanel | `data-export-panel.spec.json` | `data-export-panel.js` | CSV/Excel/PDF export |
| AIInsightsPanel | `ai-insights-panel.spec.json` | `ai-insights-panel.js` | AI-generated insights display |
| SimpleMap | `simple-map.spec.json` | `simple-map.js` | Leaflet map with markers |

All specs are in `/MJ/metadata/components/spec/generic/` and code in `/MJ/metadata/components/code/generic/`.

### DataGrid Event Shapes (Source of Truth)

These are the actual event parameter shapes from the DataGrid code:

```javascript
// onRowClick -> { record: object, cancel: boolean }
onRowClick={(e) => {
  const row = e.record;  // NOT e.data
  e.cancel = true;       // prevent default OpenEntityRecord
}}

// onSelectionChanged -> { selectedRows: Array<object> }
// onPageChanged -> { pageNumber: number, pageSize: number, visibleRows: Array<object> }
// onSortChanged -> { sortState: { column: string, direction: 'asc' | 'desc' } }
// onFilterChanged -> { filterValue: string, matchingData: Array<object> }
```

### Known Database Issues

- **Component code corruption**: The database version may differ from the metadata files on disk. If a component fails to compile with unexpected syntax errors, check the database with `sqlcmd` and re-sync with metadata push.
- **DataExportPanel**: Has had historical corruption where template literals got spliced into object literals. Verify with: `SELECT CASE WHEN Specification LIKE '%corrupted_pattern%' THEN 'CORRUPTED' ELSE 'CLEAN' END FROM __mj.vwComponents WHERE Name = 'DataExportPanel'`

## Agent Metadata Locations

| What | Where |
|------|-------|
| Agent definitions | `metadata/agents/.new-path-agents.json` |
| Prompt templates | `metadata/prompts/templates/` (`.md` files) |
| UCG partials | `metadata/prompts/templates/code-generation/unified-code-partials/` |
| Component specs | `/MJ/metadata/components/spec/generic/` |
| Component code | `/MJ/metadata/components/code/generic/` |
| Library metadata | `/MJ/metadata/component-libraries/.component-libraries.json` |
| Library lint rules | `/MJ/metadata/component-libraries/lint-rules/` |
| Linter runtime rules | `/MJ/packages/React/test-harness/src/lib/runtime-rules/` |
| Test harness | `/MJ/packages/React/test-harness/src/lib/component-runner.ts` |

## MCP Tools Quick Reference

| Tool | Use When |
|------|----------|
| `Get_Agent_Run_Summary` | First step -- overview of all steps and errors |
| `Get_Agent_Run_Step_Detail` | Drill into a specific step (truncated I/O, default 5000 chars) |
| `Get_Agent_Run_Step_Full_Data` | Full step data to file (use for extracting TargetLogID) |
| `Get_AI_Prompt_Run_Detail` | See actual prompt messages and model response (use TargetLogID from step) |
| `Get_AI_Prompt_Run_Full_Data` | Full prompt data to file (for large code generation prompts) |
| `List_Recent_Agent_Runs` | Browse recent runs by agent name, status, date range |
