import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { runGrafanaSubagent } from './subagentRunner';
import type { GrafanaToolRuntime } from './types';

type MetricsSubagentParams = {
  task: string;
  datasourceUid?: string;
  metricPrefix?: string;
};

type JsonnetSubagentParams = {
  task: string;
  uid?: string;
};

type SubagentToolOptions = {
  runtime: GrafanaToolRuntime;
  metricsTools: AgentTool[];
  jsonnetTools: AgentTool[];
};

export function createSubagentTools(options: SubagentToolOptions): AgentTool[] {
  return [makeMetricsExplorerTool(options.runtime, options.metricsTools), makeJsonnetExplorerTool(options.runtime, options.jsonnetTools)];
}

function makeMetricsExplorerTool(runtime: GrafanaToolRuntime, tools: AgentTool[]): AgentTool {
  return {
    name: 'explore_metrics',
    label: 'Explore metrics',
    description: 'Delegate metric and PromQL reconnaissance to an isolated Grafana metrics subagent. It can only discover datasources, list metadata, and validate PromQL.',
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

function makeJsonnetExplorerTool(runtime: GrafanaToolRuntime, tools: AgentTool[]): AgentTool {
  return {
    name: 'explore_jsonnet',
    label: 'Explore Jsonnet',
    description: 'Delegate vendored Jsonnet/Grafonnet and managed-dashboard source reconnaissance to an isolated subagent. It cannot write dashboards.',
    executionMode: 'sequential',
    parameters: Type.Object({
      task: Type.String({ description: 'Specific Jsonnet/Grafonnet exploration task and expected output.' }),
      uid: Type.Optional(Type.String({ description: 'Optional app-managed dashboard UID whose stored Jsonnet source should be inspected.' })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const args = params as JsonnetSubagentParams;
      const task = [args.task, args.uid ? `Inspect managed dashboard UID: ${args.uid}.` : ''].filter(Boolean).join('\n');

      return runGrafanaSubagent({
        kind: 'jsonnet',
        task,
        systemPrompt: JSONNET_SUBAGENT_PROMPT,
        tools,
        runtime,
        signal,
        onUpdate,
      });
    },
  };
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

const JSONNET_SUBAGENT_PROMPT = `You are a Grafana Jsonnet/Grafonnet exploration subagent.

Scope:
- Inspect stored Jsonnet source for app-managed dashboards and vendored Grafonnet/Jsonnet libraries.
- Use list/search/read tools to find APIs and examples.
- Render managed dashboards only when it helps validate Jsonnet output.
- Do not create, update, delete, upload, or sync dashboards.
- Do not request managerAllowsEdits.

Output:
- Managed dashboard source or library files inspected.
- Grafonnet APIs or Jsonnet patterns to use.
- Concrete source edits or Jsonnet patterns to use.
- Render validation findings if you rendered a dashboard.
- Risks or missing inputs for the parent assistant.

Keep the final answer compact and directly usable by the parent assistant.`;
