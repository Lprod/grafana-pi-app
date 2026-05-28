import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { pluginResourceFetch } from './client';
import { textResult, throwIfAborted, truncateText } from './result';
import type { GrafanaToolConfig, ManagedDashboardParams, ManagedDashboardSourceParams, ManagedDashboardToolSet } from './types';

export function createManagedDashboardTools(_toolConfig: GrafanaToolConfig): ManagedDashboardToolSet {
  const listManaged = makeGrafanaListManagedDashboardsTool();
  const getSource = makeGrafanaGetManagedDashboardSourceTool();
  const render = makeGrafanaRenderManagedDashboardTool();
  const sync = makeGrafanaSyncManagedDashboardTool();

  return {
    all: [listManaged, getSource, render, sync],
    listManaged,
    getSource,
    render,
    sync,
  };
}

function makeGrafanaListManagedDashboardsTool(): AgentTool {
  return {
    name: 'grafana_list_managed_dashboards',
    label: 'List managed dashboards',
    description: 'List dashboards currently managed by this app plugin, including Jsonnet source metadata.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      throwIfAborted(signal);
      const result = await pluginResourceFetch<{ dashboards: unknown[] }>('/managed-dashboards');
      return textResult(JSON.stringify(result.dashboards, null, 2), { count: result.dashboards.length });
    },
  };
}

function makeGrafanaGetManagedDashboardSourceTool(): AgentTool {
  return {
    name: 'grafana_get_managed_dashboard_source',
    label: 'Get managed dashboard source',
    description: 'Fetch the stored Jsonnet/Grafonnet source for an app-managed dashboard so it can be edited and re-synced.',
    parameters: Type.Object({
      uid: Type.String({ description: 'Managed dashboard UID.' }),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as ManagedDashboardSourceParams;
      throwIfAborted(signal);
      const result = await pluginResourceFetch<unknown>('/managed-dashboards/source', { method: 'POST', data: args });
      return textResult(truncateText(JSON.stringify(result, null, 2), 120000), { uid: args.uid });
    },
  };
}

function makeGrafanaRenderManagedDashboardTool(): AgentTool {
  return {
    name: 'grafana_render_managed_dashboard',
    label: 'Render managed dashboard',
    description: 'Compile Jsonnet/Grafonnet source into an app-managed Grafana dashboard resource without saving it.',
    parameters: managedDashboardParameters(),
    async execute(_toolCallId, params, signal) {
      const args = params as ManagedDashboardParams;
      throwIfAborted(signal);
      const result = await pluginResourceFetch<unknown>('/managed-dashboards/render', { method: 'POST', data: args });
      return textResult(truncateText(JSON.stringify(omitStoredJsonnetSource(result), null, 2), 120000), {
        uid: args.uid,
        sourceBytes: args.dashboard_jsonnet.length,
      });
    },
  };
}

function makeGrafanaSyncManagedDashboardTool(): AgentTool {
  return {
    name: 'grafana_sync_managed_dashboard',
    label: 'Sync managed dashboard',
    description:
      'Create or update an app-managed dashboard from Jsonnet/Grafonnet source. The source is stored with the dashboard so future edits can fetch, modify, and re-sync it.',
    parameters: managedDashboardParameters(),
    async execute(_toolCallId, params, signal) {
      const args = params as ManagedDashboardParams;
      throwIfAborted(signal);
      const result = await pluginResourceFetch<{ uid: string; url: string; status: string; sourceChecksum: string }>('/managed-dashboards/sync', {
        method: 'POST',
        data: args,
      });
      const details = {
        uid: result.uid,
        url: result.url,
        status: result.status,
        sourceChecksum: result.sourceChecksum,
      };
      return textResult(`Managed dashboard ${result.status}: ${result.url}\nUID: ${result.uid}\nSource: ${result.sourceChecksum}`, details);
    },
  };
}

function managedDashboardParameters() {
  return Type.Object({
    dashboard_jsonnet: Type.String({
      description:
        "Self-contained Grafonnet/Jsonnet source that evaluates to a Grafana dashboard object. Import grafonnet with: local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';",
    }),
    uid: Type.Optional(Type.String({ description: 'Optional UID override. Defaults to the compiled dashboard uid or a normalized title.' })),
    folderUid: Type.Optional(Type.String({ description: 'Optional folder UID.' })),
    tags: Type.Optional(Type.Array(Type.String(), { description: 'Optional extra dashboard tags.' })),
    overwrite: Type.Optional(Type.Boolean({ description: 'Whether to update an existing dashboard with the same UID. Defaults to true.' })),
  });
}

function omitStoredJsonnetSource(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitStoredJsonnetSource);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      key === 'elohmeier.grafanapiapp/jsonnetSource' ? '[omitted: stored Jsonnet source]' : omitStoredJsonnetSource(entry),
    ])
  );
}
