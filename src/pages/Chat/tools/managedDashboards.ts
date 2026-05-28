import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { pluginResourceFetch } from './client';
import { DEFAULT_JSONNET_FILE_PATH, ensureVirtualJsonnetFileHydrated, normalizeJsonnetPath } from './jsonnetFiles';
import { textResult, throwIfAborted, truncateText } from './result';
import type {
  CreateGrafanaToolsOptions,
  ManagedDashboardParams,
  ManagedDashboardSourceParams,
  ManagedDashboardToolSet,
} from './types';

export function createManagedDashboardTools(toolConfig: CreateGrafanaToolsOptions): ManagedDashboardToolSet {
  const listManaged = makeGrafanaListManagedDashboardsTool();
  const getSource = makeGrafanaGetManagedDashboardSourceTool();
  const render = makeGrafanaRenderManagedDashboardTool(toolConfig);
  const sync = makeGrafanaSyncManagedDashboardTool(toolConfig);

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
    name: 'list_managed_dashboards',
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
    name: 'get_dashboard_source',
    label: 'Get managed dashboard source',
    description:
      'Fetch the stored Jsonnet source for an app-managed dashboard so it can be edited and re-synced.',
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

function makeGrafanaRenderManagedDashboardTool(toolConfig: CreateGrafanaToolsOptions): AgentTool {
  return {
    name: 'render_dashboard',
    label: 'Render managed dashboard',
    description:
      'Compile the current virtual Jsonnet file into an app-managed Grafana dashboard resource without saving it. Defaults to dashboard.jsonnet unless dashboard_jsonnet is supplied explicitly.',
    parameters: managedDashboardParameters(),
    async execute(_toolCallId, params, signal) {
      const args = await prepareManagedDashboardParams(params as ManagedDashboardParams, toolConfig, signal);
      throwIfAborted(signal);
      const result = await pluginResourceFetch<unknown>('/managed-dashboards/render', { method: 'POST', data: args });
      return textResult(truncateText(JSON.stringify(omitStoredJsonnetSource(result), null, 2), 120000), {
        uid: args.uid,
        path: args.path,
        sourceBytes: sourceBytes(args, toolConfig),
      });
    },
  };
}

function makeGrafanaSyncManagedDashboardTool(toolConfig: CreateGrafanaToolsOptions): AgentTool {
  return {
    name: 'sync_dashboard',
    label: 'Sync managed dashboard',
    description:
      'Create or update an app-managed dashboard from the current virtual Jsonnet file. The resolved source is stored with the dashboard so future edits can fetch, modify, and re-sync it.',
    parameters: managedDashboardParameters(),
    async execute(_toolCallId, params, signal) {
      const args = await prepareManagedDashboardParams(params as ManagedDashboardParams, toolConfig, signal);
      throwIfAborted(signal);
      const result = await pluginResourceFetch<{ uid: string; url: string; status: string; sourceChecksum: string }>(
        '/managed-dashboards/sync',
        {
          method: 'POST',
          data: args,
        }
      );
      const details = {
        uid: result.uid,
        url: result.url,
        status: result.status,
        sourceChecksum: result.sourceChecksum,
        path: args.path,
        sourceBytes: sourceBytes(args, toolConfig),
      };
      return textResult(
        `Managed dashboard ${result.status}: ${result.url}\nUID: ${result.uid}\nSource: ${result.sourceChecksum}`,
        details
      );
    },
  };
}

function managedDashboardParameters() {
  return Type.Object({
    dashboard_jsonnet: Type.Optional(
      Type.String({
        description:
          'Optional self-contained Jsonnet source. Prefer writing dashboard.jsonnet with write_jsonnet and omit this field for render/sync.',
      })
    ),
    path: Type.Optional(
      Type.String({ description: `Virtual Jsonnet file path. Defaults to ${DEFAULT_JSONNET_FILE_PATH}.` })
    ),
    uid: Type.Optional(
      Type.String({
        description: 'Optional UID override. Defaults to the compiled dashboard uid or a normalized title.',
      })
    ),
    folderUid: Type.Optional(Type.String({ description: 'Optional folder UID.' })),
    tags: Type.Optional(Type.Array(Type.String(), { description: 'Optional extra dashboard tags.' })),
    overwrite: Type.Optional(
      Type.Boolean({ description: 'Whether to update an existing dashboard with the same UID. Defaults to true.' })
    ),
  });
}

async function prepareManagedDashboardParams(
  params: ManagedDashboardParams,
  toolConfig: CreateGrafanaToolsOptions,
  signal?: AbortSignal
): Promise<ManagedDashboardParams> {
  const args = { ...params };
  if (typeof args.dashboard_jsonnet === 'string' && args.dashboard_jsonnet.trim()) {
    return args;
  }

  const runtime = toolConfig.virtualJsonnetFiles;
  const path = normalizeJsonnetPath(args.path);
  await ensureVirtualJsonnetFileHydrated(runtime, path, signal);
  const sessionId = runtime?.getSessionId();
  if (!sessionId) {
    throw new Error('A chat session is required before rendering or syncing a virtual Jsonnet file.');
  }

  return {
    ...args,
    path,
    sessionId,
  };
}

function sourceBytes(args: ManagedDashboardParams, toolConfig: CreateGrafanaToolsOptions): number | undefined {
  if (typeof args.dashboard_jsonnet === 'string') {
    return args.dashboard_jsonnet.length;
  }
  const runtime = toolConfig.virtualJsonnetFiles;
  const path = normalizeJsonnetPath(args.path);
  return runtime?.getFile(path)?.dashboardJsonnetSize;
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
      key === 'elohmeier.grafanapiapp/jsonnetSource'
        ? '[omitted: stored Jsonnet source]'
        : omitStoredJsonnetSource(entry),
    ])
  );
}
