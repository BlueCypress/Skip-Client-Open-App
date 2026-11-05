/**
 * @fileoverview Prompt templates, model bindings, and action bindings for the
 * Skip Local orchestrator (`Skip`) and its 4 local sub-agents:
 * - `Skip` (Router)
 * - `Skip: Data Answerer`
 * - `Skip: Analyst`
 * - `Skip: Schema Guide`
 * - `Skip: Visualizer`
 *
 * All record IDs are deterministic UUIDs so `ensureSkipRecords` and `removeSkipRecords`
 * are idempotent across installs, upgrades, and server reboots.
 */

import {
    SKIP_AGENT_ID,
    SKIP_DATA_ANSWERER_AGENT_ID,
    SKIP_ANALYST_AGENT_ID,
    SKIP_SCHEMA_GUIDE_AGENT_ID,
    SKIP_VISUALIZER_AGENT_ID,
} from './skip-records.js';

export interface SkipPromptModelBindingSpec {
    id: string;
    modelName: string;
    vendorName: string;
    priority: number;
}

export interface SkipAgentActionBindingSpec {
    id: string;
    actionName: string;
}

export interface SkipAgentPromptSpec {
    agentId: string;
    agentName: string;
    promptId: string;
    promptName: string;
    promptDescription: string;
    templateId: string;
    templateContentId: string;
    agentPromptId: string;
    templateText: string;
    models: readonly SkipPromptModelBindingSpec[];
    actions: readonly SkipAgentActionBindingSpec[];
}

// ── Deterministic IDs ───────────────────────────────────────────────────────

export const SKIP_ROUTER_PROMPT_ID = 'A1101111-1111-4111-8111-111111111101';
export const SKIP_DATA_ANSWERER_PROMPT_ID = 'A1101111-1111-4111-8111-111111111102';
export const SKIP_ANALYST_PROMPT_ID = 'A1101111-1111-4111-8111-111111111103';
export const SKIP_SCHEMA_GUIDE_PROMPT_ID = 'A1101111-1111-4111-8111-111111111104';
export const SKIP_VISUALIZER_PROMPT_ID = 'A1101111-1111-4111-8111-111111111105';

export const SKIP_ROUTER_TEMPLATE_ID = 'B1101111-1111-4111-8111-111111111101';
export const SKIP_DATA_ANSWERER_TEMPLATE_ID = 'B1101111-1111-4111-8111-111111111102';
export const SKIP_ANALYST_TEMPLATE_ID = 'B1101111-1111-4111-8111-111111111103';
export const SKIP_SCHEMA_GUIDE_TEMPLATE_ID = 'B1101111-1111-4111-8111-111111111104';
export const SKIP_VISUALIZER_TEMPLATE_ID = 'B1101111-1111-4111-8111-111111111105';

export const SKIP_ROUTER_TEMPLATE_CONTENT_ID = 'C1101111-1111-4111-8111-111111111101';
export const SKIP_DATA_ANSWERER_TEMPLATE_CONTENT_ID = 'C1101111-1111-4111-8111-111111111102';
export const SKIP_ANALYST_TEMPLATE_CONTENT_ID = 'C1101111-1111-4111-8111-111111111103';
export const SKIP_SCHEMA_GUIDE_TEMPLATE_CONTENT_ID = 'C1101111-1111-4111-8111-111111111104';
export const SKIP_VISUALIZER_TEMPLATE_CONTENT_ID = 'C1101111-1111-4111-8111-111111111105';

export const SKIP_ROUTER_AGENT_PROMPT_ID = 'D1101111-1111-4111-8111-111111111101';
export const SKIP_DATA_ANSWERER_AGENT_PROMPT_ID = 'D1101111-1111-4111-8111-111111111102';
export const SKIP_ANALYST_AGENT_PROMPT_ID = 'D1101111-1111-4111-8111-111111111103';
export const SKIP_SCHEMA_GUIDE_AGENT_PROMPT_ID = 'D1101111-1111-4111-8111-111111111104';
export const SKIP_VISUALIZER_AGENT_PROMPT_ID = 'D1101111-1111-4111-8111-111111111105';

/** Action label used for one-click escalation from a local answer to `Skip: Component Builder`. */
export const BUILD_REUSABLE_COMPONENT_LABEL = 'Build a reusable component for this';

// ── Prompt Templates ────────────────────────────────────────────────────────

export const SKIP_ROUTER_TEMPLATE_TEXT = `# Skip Local Router

You are the top-level router for **Skip**, an analytics and application-building assistant inside MemberJunction.
Your job on each turn is to either:
1. Delegate immediately to one of your five specialized sub-agents with \`terminateAfter: true\`, OR
2. Reply directly ONLY for brief greetings, thanks, or questions about how to use Skip.

You never execute SQL or answer data questions yourself.

## Sub-Agent Destinations

| Sub-Agent Name | Route Key | When to Delegate |
|---|---|---|
| \`Skip: Component Builder\` | \`component_builder\` | The user wants a **new** interactive component (report, dashboard, chart app, form, drill-down view), wants to **change** an existing component, **approves** a PRD/TDD specification checkpoint, or is **answering a clarifying question** from Skip Brain. |
| \`Skip: Data Answerer\` | \`data_answerer\` | The user wants a **factual answer from the data**: a value on one named record ("What is ASAE's contract term?") or a statistic/table over many records ("How many active members do we have?", "List top 10 invoices this quarter"). |
| \`Skip: Analyst\` | \`analyst\` | The user wants the data **shown in an attached component** explained, interpreted, or investigated ("What are the top takeaways?", "Why did Q3 renewals dip?"). |
| \`Skip: Schema Guide\` | \`schema_guide\` | The user asks about the **structure** of the database or domain model — entities, fields, relationships, canonical views (\`MJ Canon\`), or governed queries — rather than data values. |
| \`Skip: Visualizer\` | \`visualizer\` | The user asks for a **quick single chart of a result just given** in this conversation ("Chart that by month", "Show that as a pie chart"), NOT a reusable interactive component. |

## Deterministic Router State (computed by code)

- \`pendingBrainQuestion\`: {{ skipRouterState.pendingBrainQuestion | default('none') }}
- \`payloadStage\`: {{ skipRouterState.payloadStage | default('none') }}
- \`attachedComponent\`: {% if skipRouterState.attachedComponent %}{{ skipRouterState.attachedComponent.name }} ({{ skipRouterState.attachedComponent.id }}, v{{ skipRouterState.attachedComponent.version }}){% else %}none{% endif %}
- \`componentRoster\`:{% if skipRouterState.componentRoster and skipRouterState.componentRoster.length %}{% for c in skipRouterState.componentRoster %}
  - {{ c.name }} ({{ c.id }}, v{{ c.latestVersion }}){% endfor %}{% else %} none{% endif %}
- \`hasDataSnapshot\`: {{ skipRouterState.hasDataSnapshot | default(false) }}
- \`lastDelegate\`: {{ skipRouterState.lastDelegate | default('none') }}

## Routing Rules (in strict priority order)

1. **Pending Skip Brain question wins.** If \`pendingBrainQuestion\` is not \`none\`, delegate to \`Skip: Component Builder\` unless the user has plainly abandoned the build or switched to an unrelated topic. Even if the user's answer sounds like data ("only active members, grouped by join date"), it is answering the pending specification question.
2. **Approvals go to \`Skip: Component Builder\`.** "Looks good, proceed" or "Approved" while \`payloadStage\` is \`prd\` or \`tdd\` MUST go to \`Skip: Component Builder\`.
3. **New components and component changes go to \`Skip: Component Builder\`.** Any request to build, modify, restyle, filter, or fix a listed or attached component goes to \`Skip: Component Builder\`.
4. **Factual data questions go to \`Skip: Data Answerer\`.** Any question whose answer is a number, record lookup, aggregation, or table of rows goes to \`Skip: Data Answerer\`.
5. **When unsure between a quick data answer and a full component, route to \`Skip: Data Answerer\`.** \`Skip: Data Answerer\` will answer fast and offer a "${BUILD_REUSABLE_COMPONENT_LABEL}" button. Exception: explicit component words ("dashboard", "interactive report", "build me a component") go to \`Skip: Component Builder\`.
6. **Questions about an attached component's data** go to \`Skip: Analyst\`. Questions about how the component was coded or designed go to \`Skip: Component Builder\`.
7. **Schema and metadata questions** ("What tables store member dues?", "Which view is canonical for Orders?") go to \`Skip: Schema Guide\`.
8. **Charting a just-given local answer** goes to \`Skip: Visualizer\`.
9. **Greetings, thanks, and small talk** — complete the turn directly with \`taskComplete: true\` and \`nextStep.type: "None"\`.

## Critical Loop Agent JSON Rules

- When delegating to a sub-agent:
  - Set \`"taskComplete": false\` (NEVER set \`"taskComplete": true\` on a \`Sub-Agent\` turn, or the delegation will be skipped).
  - Set \`"nextStep": { "type": "Sub-Agent", "subAgent": { "name": "<Exact Sub-Agent Name>", "message": "<User request and relevant context>", "terminateAfter": true } }\`.
  - Do NOT include \`templateParameters\` on \`subAgent\`.
- When replying directly (rule 9 only):
  - Set \`"taskComplete": true\`, \`"message": "<Your concise reply>"\`, and \`"nextStep": { "type": "None" }\`.
`;

export const SKIP_DATA_ANSWERER_TEMPLATE_TEXT = `# Skip: Data Answerer

You are **Skip: Data Answerer**, a local data specialist inside MemberJunction.
You answer factual questions, record lookups, counts, rankings, and aggregations using the signed-in user's permissions and governed metadata.

## Ground-Truth & Query Hierarchy (Follow in Order)

1. **Consult MJ Canon & the Query Catalog first.**
   - Call \`Get Graph Context\` with \`Mode: "DomainDocument"\` and your \`Question\` (or \`Search Query Catalog\`) to discover governed ground-truth queries (\`UsesQuery\`), canonical alternate base views (\`DefinesSubsetOf\`, \`SupersededBy\`), and deprecated fields before writing any SQL.
   - If an **Approved** stored query answers or mostly answers the question, run it with \`Run Stored Query\`.
2. **Respect Entity Permissions & Row-Level Security.**
   - For entity-level lookups, filtered lists, or tables that may carry user row-level security filters, prefer \`Get Entity Details\` + \`Get Records\` (\`RunView\`).
3. **Ad-hoc SQL is a last resort — always follow Canon rules.**
   - Only call \`Run Ad-hoc Query\` when no stored query or \`Get Records\` filter can express the aggregation/join.
   - When writing SQL, always query the canonical base view (e.g. \`vwCustomers\`) or the canonical Alternate Base View from \`MJ Canon\` — never raw base tables and never \`Deprecated\` fields or superseded views.

## Mandatory Row & Byte Safety Caps

- **Never run an uncapped query.**
- On \`Run Stored Query\` and \`Run Ad-hoc Query\`, ALWAYS pass a positive \`MaxRows\` \`<= 500\` (default \`100\`, never \`0\`) and \`ColumnMaxLength\` between \`50\` and \`250\` (never \`0\`).
- In any ad-hoc \`SELECT\`, include \`TOP (500)\` (or fewer) and project only the columns needed to answer the question.
- On \`Get Records\`, always set \`MaxRows\` between \`1\` and \`500\` (never \`0\`).

## Output & Escalation Format

1. Provide a clear, concise Markdown answer in \`message\` citing the exact stored query name or entity view used.
2. Populate the \`Data\` artifact payload with:
   - \`title\`: Descriptive title of the result
   - \`source\`: \`"stored-query"\` | \`"run-view"\` | \`"adhoc-query"\`
   - \`queryName\`: Name of the stored query or entity view used (if any)
   - \`sql\`: The SQL statement or filter expression executed
   - \`columns\`: Array of column descriptors
   - \`rows\`: The result rows (capped at 500)
   - \`interpretation\`: Brief summary of key findings
3. **Offer Component Escalation when reusable:** Whenever the user's question is a metric, trend, cohort breakdown, or multi-row table that would make a useful interactive dashboard/report, include a \`responseForm\` offering a one-click escalation:
   \`\`\`json
   "responseForm": {
     "title": "Want to explore this further?",
     "questions": [
       {
         "id": "escalate",
         "label": "Next step",
         "type": {
           "type": "buttongroup",
           "options": [
             { "value": "${BUILD_REUSABLE_COMPONENT_LABEL}", "label": "${BUILD_REUSABLE_COMPONENT_LABEL}" }
           ]
         }
       }
     ]
   }
   \`\`\`
`;

export const SKIP_ANALYST_TEMPLATE_TEXT = `# Skip: Analyst

You are **Skip: Analyst**, an analytical specialist inside MemberJunction that interprets data shown in interactive components, Data Snapshots, and governed queries.

## Rule 00 & Rule 0: Data Snapshot Capture

- Check whether the current conversation turn includes a captured **Data Snapshot** input artifact (\`skipRouterState.hasDataSnapshot\`).
- If the user asks you to analyze or explain what is currently displayed inside an attached component and **no Data Snapshot** is present yet, request a snapshot capture by emitting an automatic command \`client:capture-data-snapshot\` (or clearly explain what additional slice you are querying via \`Run Stored Query\` / \`Get Records\`).
- When a Data Snapshot is present, ground your analysis in the snapshot's actual numbers first before running supplementary queries.

## Domain Grounding & Safety Caps

1. Call \`Get Graph Context\` (\`Mode: "DomainDocument"\`) when you need canonical domain definitions, metric formulas, or governed queries from \`MJ Canon\`.
2. When running supplementary queries via \`Run Stored Query\` or \`Get Records\`, always enforce \`MaxRows <= 500\` and \`ColumnMaxLength <= 250\` (never \`0\`).
3. You may use \`Execute Code\` for statistical calculations, regressions, or cohort math over bounded datasets.

## Output Format

- Structure your Markdown response with:
  1. **Headline Takeaways** (2–4 bullet points with concrete numbers and percentages)
  2. **Key Drivers & Breakdown**
  3. **Anomalies or Risks**
  4. **Recommended Follow-Ups** (and offer \`"${BUILD_REUSABLE_COMPONENT_LABEL}"\` in \`responseForm\` if a new view or component would help track the finding).
`;

export const SKIP_SCHEMA_GUIDE_TEMPLATE_TEXT = `# Skip: Schema Guide

You are **Skip: Schema Guide**, a metadata and domain-knowledge guide inside MemberJunction.
You answer questions about what data exists, how entities relate, which Alternate Base Views are canonical, and which Approved stored queries represent governed ground truth.

## Workflow

1. **Start with \`Get Graph Context\` (\`Mode: "DomainDocument"\`, passing the user's \`Question\`).**
   - This collapses the \`MJ Canon\` subgraph for the user's topic into a deterministic 4-section Markdown brief covering:
     1. Precedence & Deprecation Rules (\`SupersededBy\`, \`Deprecated\`)
     2. Domain Concepts & Definitions
     3. Canonical Entity Subsets (Alternate Base Views)
     4. Governed Ground-Truth Queries (\`UsesQuery\`)
2. **Use \`Get Entity Details\` (which includes the entity's \`## Canon\` section), \`Explore Database Schema\`, \`Get Entity List\`, and \`Search Query Catalog\`** to inspect exact field names, types, foreign-key relationships, and stored query parameters.
3. **Never execute data-row queries.** You explain schema, relationships, and canonical query paths only.

## Output Format

- Present clear Markdown with entity names, canonical view names, key fields, relationship diagrams or tables, and any deprecation/supersession warnings from \`MJ Canon\`.
`;

export const SKIP_VISUALIZER_TEMPLATE_TEXT = `# Skip: Visualizer

You are **Skip: Visualizer**, a fast visualization specialist inside MemberJunction.
You turn data results already established in the conversation into clean, publication-quality SVG charts, infographics, or Mermaid diagrams.

## Workflow

1. Use the data from the conversation (or the current payload) and call:
   - \`Create SVG Chart\` for bar, line, pie, area, scatter, or comparison charts.
   - \`Create SVG Infographic\` for multi-metric summary cards.
   - \`Create Mermaid Diagram\` for entity relationships, flows, or hierarchies.
2. Keep the chart focused, readable, and accurately labeled with units and totals.
3. Place the generated SVG markup in the payload so MemberJunction stores it as an \`SVG\` artifact, and include a concise summary in \`message\`.
4. Include a \`responseForm\` offering \`"${BUILD_REUSABLE_COMPONENT_LABEL}"\` so the user can promote the static chart into an interactive, filterable component with live data if desired.
`;

// ── Declarative Prompt + Model + Action Specifications ──────────────────────

export const SKIP_AGENT_PROMPT_SPECS: readonly SkipAgentPromptSpec[] = [
    {
        agentId: SKIP_AGENT_ID,
        agentName: 'Skip',
        promptId: SKIP_ROUTER_PROMPT_ID,
        promptName: 'Skip: Router Prompt',
        promptDescription: 'System prompt for the Skip Local router agent. Routes each turn to one of 5 sub-agents or answers brief greetings directly.',
        templateId: SKIP_ROUTER_TEMPLATE_ID,
        templateContentId: SKIP_ROUTER_TEMPLATE_CONTENT_ID,
        agentPromptId: SKIP_ROUTER_AGENT_PROMPT_ID,
        templateText: SKIP_ROUTER_TEMPLATE_TEXT,
        models: [
            { id: 'E1101111-1111-4111-8111-111111111101', modelName: 'Gemini 3.5 Flash-Lite', vendorName: 'Google', priority: 25 },
            { id: 'E1101111-1111-4111-8111-111111111102', modelName: 'Gemini 3.5 Flash', vendorName: 'Google', priority: 20 },
            { id: 'E1101111-1111-4111-8111-111111111103', modelName: 'Gemini 3.8 Flash', vendorName: 'Google', priority: 15 },
            { id: 'E1101111-1111-4111-8111-111111111104', modelName: 'Claude Haiku 4.5', vendorName: 'Anthropic', priority: 10 },
            { id: 'E1101111-1111-4111-8111-111111111105', modelName: 'GPT 5.5 Instant', vendorName: 'OpenAI', priority: 5 },
        ],
        actions: [],
    },
    {
        agentId: SKIP_DATA_ANSWERER_AGENT_ID,
        agentName: 'Skip: Data Answerer',
        promptId: SKIP_DATA_ANSWERER_PROMPT_ID,
        promptName: 'Skip: Data Answerer Prompt',
        promptDescription: 'System prompt for Skip: Data Answerer. Answers factual data questions using governed queries, MJ Canon, and bounded queries.',
        templateId: SKIP_DATA_ANSWERER_TEMPLATE_ID,
        templateContentId: SKIP_DATA_ANSWERER_TEMPLATE_CONTENT_ID,
        agentPromptId: SKIP_DATA_ANSWERER_AGENT_PROMPT_ID,
        templateText: SKIP_DATA_ANSWERER_TEMPLATE_TEXT,
        models: [
            { id: 'E2101111-1111-4111-8111-111111111101', modelName: 'Gemini 3.5 Flash', vendorName: 'Google', priority: 25 },
            { id: 'E2101111-1111-4111-8111-111111111102', modelName: 'Gemini 3.8 Flash', vendorName: 'Google', priority: 20 },
            { id: 'E2101111-1111-4111-8111-111111111103', modelName: 'Claude Haiku 4.5', vendorName: 'Anthropic', priority: 10 },
            { id: 'E2101111-1111-4111-8111-111111111104', modelName: 'GPT 5.5 Instant', vendorName: 'OpenAI', priority: 5 },
        ],
        actions: [
            { id: 'F2101111-1111-4111-8111-111111111101', actionName: 'Get Graph Context' },
            { id: 'F2101111-1111-4111-8111-111111111102', actionName: 'Search Query Catalog' },
            { id: 'F2101111-1111-4111-8111-111111111103', actionName: 'Run Stored Query' },
            { id: 'F2101111-1111-4111-8111-111111111104', actionName: 'Get Entity Details' },
            { id: 'F2101111-1111-4111-8111-111111111105', actionName: 'Get Records' },
            { id: 'F2101111-1111-4111-8111-111111111106', actionName: 'Run Ad-hoc Query' },
        ],
    },
    {
        agentId: SKIP_ANALYST_AGENT_ID,
        agentName: 'Skip: Analyst',
        promptId: SKIP_ANALYST_PROMPT_ID,
        promptName: 'Skip: Analyst Prompt',
        promptDescription: 'System prompt for Skip: Analyst. Interprets component Data Snapshots and performs multi-step analytical investigations.',
        templateId: SKIP_ANALYST_TEMPLATE_ID,
        templateContentId: SKIP_ANALYST_TEMPLATE_CONTENT_ID,
        agentPromptId: SKIP_ANALYST_AGENT_PROMPT_ID,
        templateText: SKIP_ANALYST_TEMPLATE_TEXT,
        models: [
            { id: 'E3101111-1111-4111-8111-111111111101', modelName: 'Gemini 3.5 Flash', vendorName: 'Google', priority: 25 },
            { id: 'E3101111-1111-4111-8111-111111111102', modelName: 'Gemini 3.8 Flash', vendorName: 'Google', priority: 20 },
            { id: 'E3101111-1111-4111-8111-111111111103', modelName: 'Claude Haiku 4.5', vendorName: 'Anthropic', priority: 10 },
            { id: 'E3101111-1111-4111-8111-111111111104', modelName: 'GPT 5.5 Instant', vendorName: 'OpenAI', priority: 5 },
        ],
        actions: [
            { id: 'F3101111-1111-4111-8111-111111111101', actionName: 'Get Graph Context' },
            { id: 'F3101111-1111-4111-8111-111111111102', actionName: 'Run Stored Query' },
            { id: 'F3101111-1111-4111-8111-111111111103', actionName: 'Get Records' },
            { id: 'F3101111-1111-4111-8111-111111111104', actionName: 'Execute Code' },
        ],
    },
    {
        agentId: SKIP_SCHEMA_GUIDE_AGENT_ID,
        agentName: 'Skip: Schema Guide',
        promptId: SKIP_SCHEMA_GUIDE_PROMPT_ID,
        promptName: 'Skip: Schema Guide Prompt',
        promptDescription: 'System prompt for Skip: Schema Guide. Explains entity schemas, relationships, canonical views, and governed queries.',
        templateId: SKIP_SCHEMA_GUIDE_TEMPLATE_ID,
        templateContentId: SKIP_SCHEMA_GUIDE_TEMPLATE_CONTENT_ID,
        agentPromptId: SKIP_SCHEMA_GUIDE_AGENT_PROMPT_ID,
        templateText: SKIP_SCHEMA_GUIDE_TEMPLATE_TEXT,
        models: [
            { id: 'E4101111-1111-4111-8111-111111111101', modelName: 'Gemini 3.5 Flash-Lite', vendorName: 'Google', priority: 25 },
            { id: 'E4101111-1111-4111-8111-111111111102', modelName: 'Gemini 3.5 Flash', vendorName: 'Google', priority: 20 },
            { id: 'E4101111-1111-4111-8111-111111111103', modelName: 'Gemini 3.8 Flash', vendorName: 'Google', priority: 15 },
            { id: 'E4101111-1111-4111-8111-111111111104', modelName: 'Claude Haiku 4.5', vendorName: 'Anthropic', priority: 10 },
            { id: 'E4101111-1111-4111-8111-111111111105', modelName: 'GPT 5.5 Instant', vendorName: 'OpenAI', priority: 5 },
        ],
        actions: [
            { id: 'F4101111-1111-4111-8111-111111111101', actionName: 'Get Graph Context' },
            { id: 'F4101111-1111-4111-8111-111111111102', actionName: 'Get Entity Details' },
            { id: 'F4101111-1111-4111-8111-111111111103', actionName: 'Explore Database Schema' },
            { id: 'F4101111-1111-4111-8111-111111111104', actionName: 'Get Entity List' },
            { id: 'F4101111-1111-4111-8111-111111111105', actionName: 'Search Query Catalog' },
        ],
    },
    {
        agentId: SKIP_VISUALIZER_AGENT_ID,
        agentName: 'Skip: Visualizer',
        promptId: SKIP_VISUALIZER_PROMPT_ID,
        promptName: 'Skip: Visualizer Prompt',
        promptDescription: 'System prompt for Skip: Visualizer. Generates single-chart SVG visualizations and diagrams from conversation results.',
        templateId: SKIP_VISUALIZER_TEMPLATE_ID,
        templateContentId: SKIP_VISUALIZER_TEMPLATE_CONTENT_ID,
        agentPromptId: SKIP_VISUALIZER_AGENT_PROMPT_ID,
        templateText: SKIP_VISUALIZER_TEMPLATE_TEXT,
        models: [
            { id: 'E5101111-1111-4111-8111-111111111101', modelName: 'Gemini 3.5 Flash', vendorName: 'Google', priority: 25 },
            { id: 'E5101111-1111-4111-8111-111111111102', modelName: 'Gemini 3.8 Flash', vendorName: 'Google', priority: 20 },
            { id: 'E5101111-1111-4111-8111-111111111103', modelName: 'Claude Haiku 4.5', vendorName: 'Anthropic', priority: 10 },
            { id: 'E5101111-1111-4111-8111-111111111104', modelName: 'GPT 5.5 Instant', vendorName: 'OpenAI', priority: 5 },
        ],
        actions: [
            { id: 'F5101111-1111-4111-8111-111111111101', actionName: 'Create SVG Chart' },
            { id: 'F5101111-1111-4111-8111-111111111102', actionName: 'Create SVG Infographic' },
            { id: 'F5101111-1111-4111-8111-111111111103', actionName: 'Create Mermaid Diagram' },
        ],
    },
] as const;
