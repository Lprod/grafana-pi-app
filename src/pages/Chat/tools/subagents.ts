import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from 'typebox';
import { runSpecialistAgent, type AgentSpecialistKind } from './subagentRunner';
import type { GrafanaToolRuntime } from './types';

type SpecialistToolParams = {
  task: string;
  datasourceUid?: string;
  metricPrefix?: string;
  existingDashboardUid?: string;
  dashboardUid?: string;
  panelId?: string;
  intent?: 'create' | 'update' | 'review';
  timeRange?: string;
  destinationHint?: string;
  audience?: string;
};

type SpecialistToolOptions = {
  runtime: GrafanaToolRuntime;
  metricsTools: AgentTool[];
  alertTools?: AgentTool[];
  dashboardMetricContextTools?: AgentTool[];
  dashboardReadTools?: AgentTool[];
  liveDashboardTools?: AgentTool[];
  jsonnetFileTools?: AgentTool[];
  jsonnetDashboardTools?: AgentTool[];
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
      description: 'Delegate Prometheus metric discovery and PromQL validation to a focused query specialist.',
      kind: 'query',
      runtime: options.runtime,
      tools: dedupeTools([
        ...(options.metricsTools ?? []),
        ...(options.dashboardMetricContextTools ?? []),
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
        'Delegate Grafana dashboard create, update, review, Jsonnet authoring, and panel planning work to a dashboard specialist.',
      kind: 'dashboard',
      runtime: options.runtime,
      tools: dedupeTools([
        ...(options.metricsTools ?? []),
        ...(options.dashboardMetricContextTools ?? []),
        ...(options.dashboardReadTools ?? []),
        ...(options.liveDashboardTools ?? []),
        ...(options.jsonnetFileTools ?? []),
        ...(options.jsonnetDashboardTools ?? []),
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
        ...(options.dashboardMetricContextTools ?? []),
        ...(options.investigationTools ?? []),
        ...(options.artifactTools ?? []),
        ...(options.skillTools ?? []),
      ]),
      systemPrompt: INVESTIGATION_AGENT_PROMPT,
      params: investigationAgentParameters(),
      taskPrefix: investigationTaskPrefix,
    }),
    makeSpecialistTool({
      name: 'run_alert_agent',
      label: 'Run alert agent',
      description:
        'Delegate read-only Grafana Alerting and panel-linked alert troubleshooting to a focused specialist.',
      kind: 'alerts',
      runtime: options.runtime,
      tools: dedupeTools([
        ...(options.alertTools ?? []),
        ...(options.dashboardReadTools ?? []),
        ...(options.dashboardMetricContextTools ?? []),
        ...(options.metricsTools ?? []),
        ...(options.artifactTools ?? []),
        ...(options.skillTools ?? []),
      ]),
      systemPrompt: ALERT_AGENT_PROMPT,
      params: alertAgentParameters(),
      taskPrefix: alertTaskPrefix,
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
    async execute(toolCallId, params, signal, onUpdate) {
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
        parentTool: {
          id: toolCallId,
          name: options.name,
          args,
        },
      });
    },
  };
}

function queryAgentParameters() {
  return Type.Object({
    task: Type.String({ description: 'Specific query or metric exploration task and expected output.' }),
    datasourceUid: Type.Optional(Type.String({ description: 'Optional Prometheus datasource UID to prefer.' })),
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

function alertAgentParameters() {
  return Type.Object({
    task: Type.String({ description: 'Specific alert troubleshooting task and expected output.' }),
    datasourceUid: Type.Optional(Type.String({ description: 'Optional Prometheus datasource UID to prefer.' })),
    dashboardUid: Type.Optional(Type.String({ description: 'Dashboard UID when troubleshooting a linked panel.' })),
    panelId: Type.Optional(Type.String({ description: 'Panel ID when troubleshooting a linked panel.' })),
    timeRange: Type.Optional(Type.String({ description: 'Optional comparison range such as now-1h to now.' })),
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

function alertTaskPrefix(args: SpecialistToolParams) {
  return [
    args.datasourceUid ? `Prefer datasource UID: ${args.datasourceUid}.` : '',
    args.dashboardUid ? `Dashboard UID: ${args.dashboardUid}.` : '',
    args.panelId ? `Panel ID: ${args.panelId}.` : '',
    args.timeRange ? `Comparison time range: ${args.timeRange}.` : '',
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
- When a tool result says [artifact: artifact_N], the full data is stored outside the context window. Use read_artifact with summary, field, slice, or jq mode to inspect only the fields needed; avoid reading full large artifacts unless the user explicitly needs the raw data.
- Never repeat identical tool calls with the same parameters.
- Keep tool output focused on the evidence needed for the requested answer.`;

const QUERY_AGENT_PROMPT = `You are the query-agent for a Grafana observability assistant.

Scope:
- Discover Prometheus datasources, metric names, labels, and label values.
- Use inspect_dashboard_metric_usage, search_dashboard_metric_usage, or get_metric_neighborhood before broad metric scans when existing dashboards may encode relevant PromQL, labels, or related metrics.
- Inspect metric series before naming label selectors; do not infer names like status/status_code/path/route from convention.
- Validate PromQL with query_prometheus before recommending it.
- Do not create, update, delete, upload, render, or save dashboards.
- Do not update investigation reports or navigate the user.
- For multi-metric exploration, list all known prefixes in one list_metrics call, inspect all candidate metric selectors in one inspect_metric_series call, then validate related PromQL in one query_prometheus call.

Output:
- Datasource UID used.
- Relevant metrics and labels.
- Validated PromQL snippets with what each answers.
- Data-shape, truncation, or cardinality caveats.
- Open questions if available data is insufficient.

Keep the final answer compact and directly usable by the supervisor.
${TOOL_EXECUTION_PROTOCOL}`;

const DASHBOARD_AGENT_PROMPT = `You are the dashboard-agent for a Grafana observability assistant.

Scope:
- Create, update, review, render, and save Grafana dashboards when the user explicitly asks for dashboard or persistent artifact work.
- Discover Prometheus datasources, metric names, labels, and label values before selecting panel queries.
- Use dashboard-derived metric usage tools to find existing PromQL, label conventions, and related metrics before inventing new dashboard queries.
- Inspect existing dashboards when a dashboard UID is provided or the task is an update or review.
- Use inspect_dashboard_context for existing-dashboard review/update work because it returns typed panel/layout context and validates current-variable-substituted PromQL.
- When live dashboard editing tools are available and the task is an on-the-fly edit to the currently open dashboard, prefer typed live tools such as rename_live_dashboard_panel, update_live_dashboard_panel_query, add_live_dashboard_panel, move_or_resize_live_dashboard_panel, update_live_dashboard_settings, add_live_dashboard_variable, and update_live_dashboard_variable over Jsonnet dashboard save.
- Validate PromQL with query_prometheus before using panel queries.
- Prefer Jsonnet dashboards for durable generated changes.
- Read active skill resources when examples or detailed dashboard workflow notes are needed.
- Do not use datasource variables or unlisted datasource UIDs.
- For layout-affecting live edits, use the screenshot attached by add_live_dashboard_panel or move_or_resize_live_dashboard_panel when available; otherwise call screenshot_dashboard after the edit if you know the dashboard UID.
- Batch metric discovery and PromQL validation before writing panels.

Workflow:
1. Identify the dashboard goal: service health, infrastructure capacity, debugging, status overview, or exploratory analysis.
2. Gather the minimum metric and dashboard context needed for the task.
3. Choose panels by data shape: time series for trends, stat or gauge for reduced values, table for label-rich summaries, heatmap for distributions.
4. Prefer query-side shaping when it is semantically clear; use Grafana transformations only when they materially simplify presentation.
5. For new Jsonnet dashboards, prefer the bundled helper import github.com/g42/pi-dashboard/main.libsonnet for rows, layouts, Prometheus targets, and tables; do not import Grafonnet or use g.dashboard.new, g.panel.new, row.new, or with_* constructor chains.
6. For live current-dashboard edits, keep an internal checklist of all requested edits, apply one small typed live edit at a time, continue until every requested edit is complete, then verify with list_live_dashboard_panels, get_live_dashboard_layout, get_live_dashboard_info, list_live_dashboard_variables, or the attached screenshot for layout changes.
7. For durable Jsonnet dashboard create/update work, render before saving. Save only when the user requested create/update/apply, not for draft or preview-only requests.
8. For Jsonnet create/update requests, repair material render validation warnings or layout fixes, rerender, then call save_dashboard. Screenshots are optional after save only.

Jsonnet helper shape:
- Prefer this exact structure for new durable dashboards:
  local d = import 'github.com/g42/pi-dashboard/main.libsonnet';
  d.dashboard.new(
    title='Service Overview',
    uid='service-overview',
    tags=['service'],
    rows=[
      d.row('Overview', [
        d.layout.twoUp([
          d.panel.timeseries(
            title='Request rate',
            datasourceUid='prometheus',
            targets=[d.prom.query('sum(rate(http_requests_total[$__rate_interval]))', 'prometheus', legend='requests')],
            unit='reqps',
          ),
          d.panel.stat(
            title='5xx errors',
            datasourceUid='prometheus',
            targets=[d.prom.query('sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))', 'prometheus')],
          ),
        ]),
      ]),
    ],
  )
- Use d.dashboard.new(title=..., uid=..., rows=[...]); do not call it with only a title.
- Do not use pi.dashboard.withtemplating, with_template, withTimezone, pi.panel.new, pi.row.new, pi.variable.new, or chained .with_* methods for new dashboards.
- If variables are required, read references/dashboard-jsonnet-workflow.md and use the shown plain templating object pattern.

Output:
- Datasource UID used.
- Verified metrics and labels.
- Dashboard or panel changes made.
- Render/save status and dashboard UID/URL when applicable.
- Caveats for missing metrics, high cardinality, or unvalidated assumptions.
${TOOL_EXECUTION_PROTOCOL}`;

const INVESTIGATION_AGENT_PROMPT = `You are the investigation-agent for a Grafana observability assistant.

Scope:
- Investigate incidents, failures, latency spikes, error spikes, degradations, and root-cause questions.
- Define the scope: service, host, route, symptom, datasource UID, and time range when available.
- Gather evidence with metric discovery and PromQL validation.
- Use dashboard-derived metric usage tools when existing dashboards may identify relevant metrics, labels, or neighbor signals.
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

const ALERT_AGENT_PROMPT = `You are the alert-agent for a Grafana observability assistant.

Scope:
- Troubleshoot Grafana-managed alert rules and their relationship to dashboard panels.
- Use only read-only tools. Never create, update, pause, silence, delete, or persist alerting or dashboard resources.
- Use find_panel_alert_rules and get_alert_rule for Grafana AlertRule resources. These tools use the App Platform AlertRule API only.
- Use inspect_dashboard_context when a dashboard UID is known to compare panel queries, field thresholds, transformations, and time range with the alert rule.
- Run the alert rule's prometheusChecks with query_prometheus before explaining whether the current data appears above or below the alert condition.
- If the panel and alert disagree, compare query text, datasource UID, label grouping, reducer, threshold evaluator, alert relativeTimeRange, noDataState, execErrState, pending period, and panel thresholds.

Output:
- The linked or related alert rule name/title and dashboard panel evidence.
- The alert query, reducer, threshold, evaluation interval, pending period, and no-data/error behavior.
- The Prometheus evidence you ran and what it implies.
- A concise explanation of likely mismatch causes and what the user should manually edit in Grafana if the rule is wrong.

Keep the final answer compact and evidence-based.
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
- Support dashboard URLs, Prometheus Explore URLs, the Assistant chat route, and explicitly supplied relative Grafana paths.
- Do not run data queries, mutate dashboards, or update investigation reports.
- If the destination is missing required identifiers, return the exact missing field instead of guessing.

Output:
- The destination opened or the link built.
- Any required missing information.
${TOOL_EXECUTION_PROTOCOL}`;
