import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { pluginResourceFetch } from './client';
import { DEFAULT_JSONNET_FILE_PATH, ensureVirtualJsonnetFileHydrated, normalizeJsonnetPath } from './jsonnetFiles';
import { textResult, throwIfAborted } from './result';
import type {
  CreateGrafanaToolsOptions,
  DashboardSaveFolderSelection,
  JsonnetDashboardParams,
  JsonnetDashboardToolSet,
} from './types';

type JsonnetFileInfo = {
  path: string;
  version: number;
  checksum: string;
  lineCount: number;
  dashboardJsonnetSize: number;
};

type JsonnetDashboardValidation = {
  warnings?: Array<{ code: string; message: string; panelId?: number; panelTitle?: string }>;
  layoutFixes?: Array<{ message: string; panelId?: number; panelTitle?: string }>;
};

type JsonnetDashboardRenderResult = {
  dashboard?: Record<string, unknown>;
  sourceChecksum?: string;
  validation?: JsonnetDashboardValidation;
  autoRepaired?: boolean;
  repairs?: string[];
  jsonnetFile?: JsonnetFileInfo;
  dashboard_jsonnet?: string;
};

type JsonnetDashboardSaveResult = {
  uid: string;
  url: string;
  status: string;
  sourceChecksum: string;
  validation?: JsonnetDashboardValidation;
  autoRepaired?: boolean;
  repairs?: string[];
  jsonnetFile?: JsonnetFileInfo;
  dashboard_jsonnet?: string;
  saveResponse?: Record<string, unknown>;
};

export function createJsonnetDashboardTools(toolConfig: CreateGrafanaToolsOptions): JsonnetDashboardToolSet {
  const render = makeGrafanaRenderJsonnetDashboardTool(toolConfig);
  const save = makeGrafanaSaveJsonnetDashboardTool(toolConfig);

  return {
    all: [render, save],
    render,
    save,
  };
}

function makeGrafanaRenderJsonnetDashboardTool(toolConfig: CreateGrafanaToolsOptions): AgentTool {
  return {
    name: 'render_dashboard',
    label: 'Render Jsonnet dashboard',
    description:
      'Compile the current virtual Jsonnet file into an editable Grafana dashboard JSON preview without saving it. Defaults to dashboard.jsonnet unless dashboard_jsonnet is supplied explicitly.',
    parameters: jsonnetDashboardParameters(),
    async execute(_toolCallId, params, signal) {
      const args = await prepareJsonnetDashboardParams(params as JsonnetDashboardParams, toolConfig, signal);
      throwIfAborted(signal);
      const result = await pluginResourceFetch<JsonnetDashboardRenderResult>('/jsonnet-dashboards/render', {
        method: 'POST',
        data: args,
      });
      hydrateAutoRepairedJsonnetFile(result, toolConfig);
      const summary = compactJsonnetDashboardRenderResult(result, args, toolConfig);
      return textResult(JSON.stringify(summary, null, 2), summary);
    },
  };
}

function makeGrafanaSaveJsonnetDashboardTool(toolConfig: CreateGrafanaToolsOptions): AgentTool {
  return {
    name: 'save_dashboard',
    label: 'Save Jsonnet dashboard',
    description:
      'Create or update an editable Grafana dashboard from the current virtual Jsonnet file. This saves the rendered dashboard through Grafana without blocking manual edits.',
    parameters: jsonnetDashboardParameters(),
    async execute(toolCallId, params, signal) {
      const rawArgs = params as JsonnetDashboardParams;
      const folderOverride = saveFolderOverrideForCall(toolConfig, toolCallId, rawArgs);

      try {
        const args = await prepareJsonnetDashboardParams(
          applySaveFolderOverride(rawArgs, folderOverride),
          toolConfig,
          signal
        );
        throwIfAborted(signal);
        const result = await pluginResourceFetch<JsonnetDashboardSaveResult>('/jsonnet-dashboards/save', {
          method: 'POST',
          data: args,
        });
        hydrateAutoRepairedJsonnetFile(result, toolConfig);
        const details = {
          uid: result.uid,
          url: result.url,
          status: result.status,
          sourceChecksum: result.sourceChecksum,
          path: args.path,
          sourceBytes: sourceBytes(args, toolConfig),
          folderUid: args.folderUid,
          folderTitle: folderOverride?.title,
          validation: result.validation,
          autoRepaired: result.autoRepaired,
          repairs: result.repairs,
          jsonnetFile: result.jsonnetFile,
        };
        return textResult(
          `Dashboard ${dashboardSaveStatusLabel(result.status)}: ${result.url}\nUID: ${result.uid}\nSource: ${result.sourceChecksum}`,
          details
        );
      } finally {
        toolConfig.dashboardSaveFolders?.clearFolderOverride(toolCallId);
      }
    },
  };
}

function dashboardSaveStatusLabel(status: string) {
  return status === 'success' ? 'saved' : status;
}

function saveFolderOverrideForCall(
  toolConfig: CreateGrafanaToolsOptions,
  toolCallId: string,
  args: JsonnetDashboardParams
): DashboardSaveFolderSelection | undefined {
  if (args.folderUid) {
    return undefined;
  }
  return toolConfig.dashboardSaveFolders?.getFolderOverride(toolCallId);
}

function applySaveFolderOverride(
  args: JsonnetDashboardParams,
  folderOverride: DashboardSaveFolderSelection | undefined
): JsonnetDashboardParams {
  if (!folderOverride || args.folderUid) {
    return args;
  }

  return {
    ...args,
    folderUid: folderOverride.uid,
  };
}

function jsonnetDashboardParameters() {
  return Type.Object({
    dashboard_jsonnet: Type.Optional(
      Type.String({
        description:
          'Optional self-contained Jsonnet source. Prefer writing dashboard.jsonnet with write_jsonnet and omit this field for render/save.',
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

async function prepareJsonnetDashboardParams(
  params: JsonnetDashboardParams,
  toolConfig: CreateGrafanaToolsOptions,
  signal?: AbortSignal
): Promise<JsonnetDashboardParams> {
  const args = { ...params };
  if (typeof args.dashboard_jsonnet === 'string' && args.dashboard_jsonnet.trim()) {
    return args;
  }

  const runtime = toolConfig.virtualJsonnetFiles;
  const path = normalizeJsonnetPath(args.path);
  await ensureVirtualJsonnetFileHydrated(runtime, path, signal);
  const sessionId = runtime?.getSessionId();
  if (!sessionId) {
    throw new Error('A chat session is required before rendering or saving a virtual Jsonnet file.');
  }

  return {
    ...args,
    path,
    sessionId,
  };
}

function sourceBytes(args: JsonnetDashboardParams, toolConfig: CreateGrafanaToolsOptions): number | undefined {
  if (typeof args.dashboard_jsonnet === 'string') {
    return args.dashboard_jsonnet.length;
  }
  const runtime = toolConfig.virtualJsonnetFiles;
  const path = normalizeJsonnetPath(args.path);
  return runtime?.getFile(path)?.dashboardJsonnetSize;
}

function compactJsonnetDashboardRenderResult(
  result: JsonnetDashboardRenderResult,
  args: JsonnetDashboardParams,
  toolConfig: CreateGrafanaToolsOptions
) {
  const dashboard = result.dashboard ?? {};
  const panels = recordsField(dashboard, 'panels');
  const uid = stringField(dashboard, 'uid') ?? args.uid;
  const path = result.jsonnetFile?.path ?? args.path;
  const sourceByteCount = result.jsonnetFile?.dashboardJsonnetSize ?? sourceBytes(args, toolConfig);

  return {
    dashboard: {
      title: stringField(dashboard, 'title'),
      uid,
      tags: stringArrayField(dashboard, 'tags'),
      panelCount: panels.length,
      panels: panels.map(compactDashboardPanel),
    },
    sourceChecksum: result.sourceChecksum,
    path,
    sourceBytes: sourceByteCount,
    autoRepaired: result.autoRepaired,
    repairs: result.repairs,
    validation: result.validation,
    jsonnetFile: result.jsonnetFile,
  };
}

function hydrateAutoRepairedJsonnetFile(
  result: { jsonnetFile?: JsonnetFileInfo; dashboard_jsonnet?: string },
  toolConfig: CreateGrafanaToolsOptions
) {
  if (!result.jsonnetFile || typeof result.dashboard_jsonnet !== 'string') {
    return;
  }
  toolConfig.virtualJsonnetFiles?.setFile(
    {
      ...result.jsonnetFile,
      content: result.dashboard_jsonnet,
    },
    { hydrated: true }
  );
}

function compactDashboardPanel(panel: Record<string, unknown>, index: number) {
  return {
    id: panel.id,
    title: stringField(panel, 'title') ?? `Panel ${index + 1}`,
    type: stringField(panel, 'type') ?? 'unknown',
    gridPos: recordField(panel, 'gridPos'),
    datasourceUid: datasourceUid(panel.datasource),
    targets: recordsField(panel, 'targets').map((target) => ({
      refId: target.refId,
      expr: target.expr,
      legendFormat: target.legendFormat,
      datasourceUid: datasourceUid(target.datasource),
    })),
  };
}

function datasourceUid(value: unknown) {
  const record = asRecord(value);
  return record ? stringField(record, 'uid') : undefined;
}

function recordsField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function recordField(record: Record<string, unknown> | undefined, field: string) {
  return asRecord(record?.[field]);
}

function stringField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

function stringArrayField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
