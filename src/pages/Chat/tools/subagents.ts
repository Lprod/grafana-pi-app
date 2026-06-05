import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from 'typebox';
import { runSpecialistAgent, type AgentSpecialistKind } from './subagentRunner';
import type { GrafanaToolRuntime } from './types';

type SpecialistToolParams = {
  task: string;
  datasourceUid?: string;
  metricPrefix?: string;
  existingDashboardUid?: string;
  intent?: 'create' | 'update' | 'review';
  timeRange?: string;
  destinationHint?: string;
  audience?: string;
};

type SpecialistToolOptions = {
  runtime: GrafanaToolRuntime;
  metricsTools: AgentTool[];
  rqliteTools?: AgentTool[];
  dashboardReadTools?: AgentTool[];
  jsonnetFileTools?: AgentTool[];
  managedDashboardTools?: AgentTool[];
  investigationTools?: AgentTool[];
  navigationTools?: AgentTool[];
  artifactTools?: AgentTool[];
  skillTools?: AgentTool[];
};

export function createSubagentTools(options: SpecialistToolOptions): AgentTool[] {
  return [
    makeSpecialistTool({
      name: 'run_query_agent',
      label: 'Run query agent',
      description:
        'Delegate Prometheus metric discovery, PromQL validation, and read-only rqlite SQL analysis to a focused query specialist.',
      kind: 'query',
      runtime: options.runtime,
      tools: dedupeTools([
        ...(options.metricsTools ?? []),
        ...(options.rqliteTools ?? []),
        ...(options.artifactTools ?? []),
      ]),
      systemPrompt: QUERY_AGENT_PROMPT,
      params: queryAgentParameters(),
      taskPrefix: queryTaskPrefix,
    }),
    makeSpecialistTool({
      name: 'run_dashboard_agent',
      label: 'Run dashboard agent',
      description:
        'Delegate Grafana dashboard create, update, review, managed Jsonnet, and panel planning work to a dashboard specialist.',
      kind: 'dashboard',
      runtime: options.runtime,
      tools: dedupeTools([
        ...(options.metricsTools ?? []),
        ...(options.dashboardReadTools ?? []),
        ...(options.jsonnetFileTools ?? []),
        ...(options.managedDashboardTools ?? []),
        ...(options.artifactTools ?? []),
        ...(options.skillTools ?? []),
      ]),
      systemPrompt: DASHBOARD_AGENT_PROMPT,
      params: dashboardAgentParameters(),
      taskPrefix: dashboardTaskPrefix,
    }),
    makeSpecialistTool({
      name: 'run_investigation_agent',
      label: 'Run investigation agent',
      description:
        'Delegate incident, degradation, latency, failure, and root-cause analysis to an investigation specialist that maintains the structured report.',
      kind: 'investigation',
      runtime: options.runtime,
      tools: dedupeTools([
        ...(options.metricsTools ?? []),
        ...(options.rqliteTools ?? []),
        ...(options.investigationTools ?? []),
        ...(options.artifactTools ?? []),
        ...(options.skillTools ?? []),
      ]),
      systemPrompt: INVESTIGATION_AGENT_PROMPT,
      params: investigationAgentParameters(),
      taskPrefix: investigationTaskPrefix,
    }),
    makeSpecialistTool({
      name: 'run_support_agent',
      label: 'Run support agent',
      description:
        'Delegate Grafana and observability explanation, best-practice, and skill-reference questions to a support specialist.',
      kind: 'support',
      runtime: options.runtime,
      tools: dedupeTools([...(options.skillTools ?? []), ...(options.artifactTools ?? [])]),
      systemPrompt: SUPPORT_AGENT_PROMPT,
      params: supportAgentParameters(),
      taskPrefix: supportTaskPrefix,
    }),
    makeSpecialistTool({
      name: 'run_navigation_agent',
      label: 'Run navigation agent',
      description:
        'Delegate Grafana navigation and link-building tasks to a navigation specialist that can open safe Grafana-relative destinations.',
      kind: 'navigation',
      runtime: options.runtime,
      tools: dedupeTools([...(options.navigationTools ?? []), ...(options.artifactTools ?? [])]),
      systemPrompt: NAVIGATION_AGENT_PROMPT,
      params: navigationAgentParameters(),
      taskPrefix: navigationTaskPrefix,
    }),
  ];
}

function makeSpecialistTool(options: {
  name: string;
  label: string;
  description: string;
  kind: AgentSpecialistKind;
  runtime: GrafanaToolRuntime;
  tools: AgentTool[];
  systemPrompt: string;
  params: TSchema;
  taskPrefix: (params: SpecialistToolParams) => string[];
}): AgentTool {
  return {
    name: options.name,
    label: options.label,
    description: options.description,
    executionMode: 'sequential',
    parameters: options.params,
    async execute(_toolCallId, params, signal, onUpdate) {
      const args = params as SpecialistToolParams;
      const task = [...options.taskPrefix(args), args.task].filter(Boolean).join('\n');

      return runSpecialistAgent({
        kind: options.kind,
        task,
        systemPrompt: options.systemPrompt,
        tools: options.tools,
        runtime: options.runtime,
        signal,
        onUpdate,
      });
    },
  };
}

function queryAgentParameters() {
  return Type.Object({
    task: Type.String({ description: 'Specific query or metric/SQL exploration task and expected output.' }),
    datasourceUid: Type.Optional(
      Type.String({ description: 'Optional Prometheus or rqlite datasource UID to prefer.' })
    ),
    metricPrefix: Type.Optional(
      Type.String({ description: 'Optional Prometheus metric-name prefix to investigate first.' })
    ),
  });
}

function dashboardAgentParameters() {
  return Type.Object({
    task: Type.String({ description: 'Specific dashboard task and expected output.' }),
    datasourceUid: Type.Optional(Type.String({ description: 'Optional Prometheus datasource UID to prefer.' })),
    existingDashboardUid: Type.Optional(
      Type.String({ description: 'Existing dashboard UID to inspect for update or review requests.' })
    ),
    intent: Type.Optional(
      Type.Union([Type.Literal('create'), Type.Literal('update'), Type.Literal('review')], {
        description: 'Dashboard task intent. Defaults to create when omitted.',
      })
    ),
  });
}

function investigationAgentParameters() {
  return Type.Object({
    task: Type.String({ description: 'Specific investigation task, symptom, and expected output.' }),
    datasourceUid: Type.Optional(Type.String({ description: 'Optional datasource UID to prefer.' })),
    timeRange: Type.Optional(Type.String({ description: 'Optional incident time range such as now-2h to now.' })),
  });
}

function supportAgentParameters() {
  return Type.Object({
    task: Type.String({ description: 'Specific Grafana or observability support question.' }),
    audience: Type.Optional(
      Type.String({ description: 'Optional audience or experience level to tailor the answer.' })
    ),
  });
}

function navigationAgentParameters() {
  return Type.Object({
    task: Type.String({ description: 'Navigation request and destination details.' }),
    destinationHint: Type.Optional(
      Type.String({ description: 'Optional dashboard UID, Explore query, plugin route, or relative Grafana path.' })
    ),
  });
}

function queryTaskPrefix(args: SpecialistToolParams) {
  return [
    args.datasourceUid ? `Prefer datasource UID: ${args.datasourceUid}.` : '',
    args.metricPrefix ? `Start metric discovery with prefix: ${args.metricPrefix}.` : '',
  ];
}

function dashboardTaskPrefix(args: SpecialistToolParams) {
  return [
    `Intent: ${args.intent ?? 'create'}.`,
    args.datasourceUid ? `Prefer datasource UID: ${args.datasourceUid}.` : '',
    args.existingDashboardUid ? `Inspect existing dashboard UID: ${args.existingDashboardUid}.` : '',
  ];
}

function investigationTaskPrefix(args: SpecialistToolParams) {
  return [
    args.datasourceUid ? `Prefer datasource UID: ${args.datasourceUid}.` : '',
    args.timeRange ? `Incident time range: ${args.timeRange}.` : '',
  ];
}

function supportTaskPrefix(args: SpecialistToolParams) {
  return [args.audience ? `Audience: ${args.audience}.` : ''];
}

function navigationTaskPrefix(args: SpecialistToolParams) {
  return [args.destinationHint ? `Destination hint: ${args.destinationHint}.` : ''];
}

function dedupeTools(tools: readonly AgentTool[]) {
  const seen = new Set<string>();
  const deduped: AgentTool[] = [];

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    deduped.push(tool);
  }

  return deduped;
}

const TOOL_EXECUTION_PROTOCOL = `
Tool execution protocol:
- Batch related Prometheus discovery in one call: use list_metrics.prefixes, inspect_metric_series.matches, and query_prometheus.queries when checking multiple metrics or PromQL expressions.
- When multiple tool calls are independent, request them in the same assistant turn so the runtime can execute them concurrently.
- Use sequential calls only when one result determines the exact arguments for the next call.
- Bulky tool results may be stored as [artifact: id]; use read_artifact with field, slice, or jq mode to inspect only the needed part.
- Never repeat identical tool calls with the same parameters.
- Keep tool output focused on the evidence needed for the requested answer.`;

const QUERY_AGENT_PROMPT = `You are the query-agent for a Grafana observability assistant.

Scope:
- Discover Prometheus datasources, metric names, labels, and label values.
- Inspect metric series before naming label selectors; do not infer names like status/status_code/path/route from convention.
- Validate PromQL with query_prometheus before recommending it.
- Query rqlite only with read-only SQL tools when the user asks for SQL/database analysis.
- Do not create, update, delete, upload, render, or sync dashboards.
- Do not update investigation reports or navigate the user.
- For multi-metric exploration, list all known prefixes in one list_metrics call, inspect all candidate metric selectors in one inspect_metric_series call, then validate related PromQL in one query_prometheus call.

Output:
- Datasource UID used.
- Relevant metrics, labels, tables, or columns.
- Validated PromQL or SQL snippets with what each answers.
- Data-shape, truncation, or cardinality caveats.
- Open questions if available data is insufficient.

Keep the final answer compact and directly usable by the supervisor.
${TOOL_EXECUTION_PROTOCOL}`;

const DASHBOARD_AGENT_PROMPT = `You are the dashboard-agent for a Grafana observability assistant.

Scope:
- Create, update, review, render, and sync Grafana dashboards when the user explicitly asks for dashboard or persistent artifact work.
- Discover Prometheus datasources, metric names, labels, and label values before selecting panel queries.
- Inspect existing dashboards when a dashboard UID is provided or the task is an update or review.
- Use inspect_dashboard_context for existing-dashboard review/update work because it returns typed panel/layout context and validates current-variable-substituted PromQL.
- Validate PromQL with query_prometheus before using panel queries.
- Prefer managed Jsonnet dashboards for durable changes.
- Read active skill resources when examples or detailed dashboard workflow notes are needed.
- Do not use datasource variables or unlisted datasource UIDs.
- Do not call screenshot_dashboard unless the user explicitly asks for a screenshot or visual preview.
- Batch metric discovery and PromQL validation before writing panels.

Workflow:
1. Identify the dashboard goal: service health, infrastructure capacity, debugging, status overview, or exploratory analysis.
2. Gather the minimum metric and dashboard context needed for the task.
3. Choose panels by data shape: time series for trends, stat or gauge for reduced values, table for label-rich summaries, heatmap for distributions.
4. Prefer query-side shaping when it is semantically clear; use Grafana transformations only when they materially simplify presentation.
5. Write a plain Jsonnet dashboard object for new dashboards; do not import Grafonnet or use g.dashboard.new, g.panel.new, row.new, or with_* constructor chains.
6. Render before syncing. Sync only when the user requested create/update/apply, not for draft or preview-only requests.
7. For create/update requests, call sync_dashboard immediately after render_dashboard succeeds. Screenshots are optional after sync only.

Output:
- Datasource UID used.
- Verified metrics and labels.
- Dashboard or panel changes made.
- Render/sync status and dashboard UID/URL when applicable.
- Caveats for missing metrics, high cardinality, or unvalidated assumptions.
${TOOL_EXECUTION_PROTOCOL}`;

const INVESTIGATION_AGENT_PROMPT = `You are the investigation-agent for a Grafana observability assistant.

Scope:
- Investigate incidents, failures, latency spikes, error spikes, degradations, and root-cause questions.
- Define the scope: service, host, route, symptom, datasource UID, and time range when available.
- Gather evidence with metric discovery, PromQL validation, and read-only SQL when relevant.
- Use update_report early and at the final material summary for longer investigations. When the task or benchmark has a tight call budget, consolidate findings instead of updating after every minor check.
- Keep hypotheses separate from evidence. Evidence must come from tool results or user-provided context.
- Do not create dashboards or navigate unless the supervisor explicitly delegates that to another specialist.
- For Prometheus-only incidents, prefer this compact sequence: list datasources if needed, one batched list_metrics call, one batched inspect_metric_series call, one batched query_prometheus call, then answer from the evidence.

Output:
- Current finding and confidence.
- Evidence chain with tool-backed facts.
- Ruled-out causes.
- Remaining gaps.
- Next checks or remediation.
- Keep the final response concise. If the task requests bullets or a short summary, follow that exact shape; do not write a full report, tables, or long prose. The structured report is maintained with update_report and does not need to be repeated in chat.
${TOOL_EXECUTION_PROTOCOL}`;

const SUPPORT_AGENT_PROMPT = `You are the support-agent for a Grafana observability assistant.

Scope:
- Explain Grafana concepts, observability concepts, monitoring best practices, and the assistant's available workflow.
- Use active skill resources when they are relevant.
- Do not claim live documentation search, product features, or datasource evidence unless a tool result or user context provides it.
- Do not run data queries, mutate dashboards, update investigation reports, or navigate.

Output:
- Clear, accurate guidance.
- Concrete examples when useful.
- Note when a query, dashboard, investigation, or navigation specialist would be needed for verification or action.
${TOOL_EXECUTION_PROTOCOL}`;

const NAVIGATION_AGENT_PROMPT = `You are the navigation-agent for a Grafana observability assistant.

Scope:
- Open safe Grafana-relative destinations using the navigate tool.
- Support dashboard URLs, Prometheus Explore URLs, the Observability Analyst chat route, and explicitly supplied relative Grafana paths.
- Do not run data queries, mutate dashboards, or update investigation reports.
- If the destination is missing required identifiers, return the exact missing field instead of guessing.

Output:
- The destination opened or the link built.
- Any required missing information.
${TOOL_EXECUTION_PROTOCOL}`;
