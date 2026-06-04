import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { runGrafanaSubagent } from './subagentRunner';
import type { GrafanaToolRuntime } from './types';

type MetricsSubagentParams = {
  task: string;
  datasourceUid?: string;
  metricPrefix?: string;
};

type DashboardDesignSubagentParams = {
  task: string;
  datasourceUid?: string;
  existingDashboardUid?: string;
  intent?: 'create' | 'update' | 'review';
};

type SubagentToolOptions = {
  runtime: GrafanaToolRuntime;
  metricsTools: AgentTool[];
  dashboardReadTools?: AgentTool[];
  skillTools?: AgentTool[];
  includeMetrics?: boolean;
  includeDashboardDesign?: boolean;
};

export function createSubagentTools(options: SubagentToolOptions): AgentTool[] {
  const tools: AgentTool[] = [];
  if (options.includeMetrics !== false) {
    tools.push(makeMetricsExplorerTool(options.runtime, options.metricsTools));
  }
  if (options.includeDashboardDesign !== false) {
    tools.push(
      makeDashboardDesignerTool(
        options.runtime,
        dedupeTools([...options.metricsTools, ...(options.dashboardReadTools ?? []), ...(options.skillTools ?? [])])
      )
    );
  }
  return tools;
}

function makeMetricsExplorerTool(runtime: GrafanaToolRuntime, tools: AgentTool[]): AgentTool {
  return {
    name: 'explore_metrics',
    label: 'Explore metrics',
    description:
      'Delegate metric and PromQL reconnaissance to an isolated Grafana metrics subagent. It can only discover datasources, list metadata, and validate PromQL.',
    executionMode: 'sequential',
    parameters: Type.Object({
      task: Type.String({ description: 'Specific metrics exploration task and expected output.' }),
      datasourceUid: Type.Optional(Type.String({ description: 'Optional Prometheus datasource UID to prefer.' })),
      metricPrefix: Type.Optional(Type.String({ description: 'Optional metric-name prefix to investigate first.' })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const args = params as MetricsSubagentParams;
      const task = [
        args.task,
        args.datasourceUid ? `Prefer datasource UID: ${args.datasourceUid}.` : '',
        args.metricPrefix ? `Start metric discovery with prefix: ${args.metricPrefix}.` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return runGrafanaSubagent({
        kind: 'metrics',
        task,
        systemPrompt: METRICS_SUBAGENT_PROMPT,
        tools,
        runtime,
        signal,
        onUpdate,
      });
    },
  };
}

function makeDashboardDesignerTool(runtime: GrafanaToolRuntime, tools: AgentTool[]): AgentTool {
  return {
    name: 'design_dashboard',
    label: 'Design dashboard',
    description:
      'Delegate Grafana dashboard planning to an isolated design-only subagent. Use this before writing, rendering, or syncing non-trivial dashboard create, update, or review work. The subagent can inspect metrics and dashboards but cannot mutate persistent artifacts.',
    executionMode: 'sequential',
    parameters: Type.Object({
      task: Type.String({ description: 'Specific dashboard design task and expected output.' }),
      datasourceUid: Type.Optional(Type.String({ description: 'Optional Prometheus datasource UID to prefer.' })),
      existingDashboardUid: Type.Optional(
        Type.String({ description: 'Existing dashboard UID to inspect for update or review requests.' })
      ),
      intent: Type.Optional(
        Type.Union([Type.Literal('create'), Type.Literal('update'), Type.Literal('review')], {
          description: 'Dashboard task intent. Defaults to create when omitted.',
        })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const args = params as DashboardDesignSubagentParams;
      const task = [
        `Intent: ${args.intent ?? 'create'}.`,
        args.datasourceUid ? `Prefer datasource UID: ${args.datasourceUid}.` : '',
        args.existingDashboardUid ? `Inspect existing dashboard UID: ${args.existingDashboardUid}.` : '',
        args.task,
      ]
        .filter(Boolean)
        .join('\n');

      return runGrafanaSubagent({
        kind: 'dashboard-design',
        task,
        systemPrompt: DASHBOARD_DESIGNER_PROMPT,
        tools,
        runtime,
        signal,
        onUpdate,
      });
    },
  };
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

const METRICS_SUBAGENT_PROMPT = `You are a Grafana metrics exploration subagent.

Scope:
- Discover Prometheus datasources, metric names, labels, and label values.
- Inspect metric series before naming label selectors; do not infer names like status/status_code/path/route from convention.
- Validate PromQL with query_prometheus before recommending it.
- Do not create, update, delete, upload, or sync dashboards.
- Do not use datasource variables. Only use datasource UIDs returned by list_datasources.

Output:
- Datasource UID used.
- Relevant metrics and labels.
- Validated PromQL snippets, with what each answers.
- Data-shape or cardinality caveats.
- Open questions if the available metrics are insufficient.

Keep the final answer compact and directly usable by the parent assistant.`;

const DASHBOARD_DESIGNER_PROMPT = `You are a Grafana dashboard design subagent.

Scope:
- Design Grafana dashboards, panels, variables, layout, and PromQL for dashboard create, update, or review tasks.
- Discover Prometheus datasources, metric names, labels, and label values before selecting queries.
- Inspect existing dashboards when a dashboard UID is provided or the task is an update or review.
- Validate PromQL with query_prometheus before recommending panel queries.
- Read active skill resources when examples or detailed dashboard workflow notes are needed.
- Do not create, update, delete, upload, compile managed dashboard previews, sync, or persist dashboards. Screenshots of existing dashboards are allowed for review when useful. Return a design for the parent assistant to apply.
- Do not use datasource variables or unlisted datasource UIDs. Use datasource UIDs returned by list_datasources or supplied by the parent only after verification.

Workflow:
1. Identify the dashboard goal: service health, infrastructure capacity, debugging, status overview, or exploratory analysis.
2. Gather the minimum metric and dashboard context needed for the task.
3. Choose panels by data shape: time series for trends, stat or gauge for reduced values, table for label-rich summaries, heatmap for distributions.
4. Prefer query-side shaping when it is semantically clear; use Grafana transformations only when they materially simplify presentation.
5. Propose a 24-column grid layout with stable panel IDs, clear titles, units, legends, thresholds, and descriptions where useful.
6. For create or update tasks, draft plain Jsonnet that evaluates to a dashboard object. Do not import Grafonnet or use constructor chains such as g.dashboard.new, g.panel.new, row.new, or with_* methods.

Output:
- Datasource UID used.
- Verified metrics and labels.
- Panel plan with title, type, purpose, query, unit, legend, and grid position.
- Variables and links, if useful; otherwise say none.
- Plain Jsonnet draft or exact Jsonnet sections for the parent assistant to write.
- Caveats for missing metrics, high cardinality, or unvalidated assumptions.

Keep the final answer compact, specific, and directly usable by the parent assistant.`;
