import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  CoreApp,
  dateTime,
  dataFrameToJSON,
  getDefaultTimeRange,
  LoadingState,
  type DataFrame,
  type DataQueryResponse,
  type DataQueryRequest,
  type DataSourceApi,
  type DataSourceInstanceSettings,
  type TimeRange,
} from '@grafana/data';
import { config, getBackendSrv, getDataSourceSrv } from '@grafana/runtime';
import { lastValueFrom, type Observable } from 'rxjs';
import { Type } from 'typebox';
import { PLUGIN_ID } from '../../constants';
import type { PiAppJsonData } from '../../types';

type TextToolResult<TDetails = Record<string, unknown>> = AgentToolResult<TDetails>;

export type GrafanaToolConfig = Pick<PiAppJsonData, 'allowedDatasourceUids'>;

type ResourceCapableDataSource = DataSourceApi & {
  getResource?: <T = unknown>(path: string, params?: Record<string, unknown>) => Promise<T>;
};

type PrometheusMetadataResponse<T> = {
  status?: string;
  data?: T;
  error?: string;
};

type DashboardSearchResult = {
  title: string;
  uid: string;
  url: string;
  folderTitle?: string;
  folderUid?: string;
};

type DatasourceParams = {
  datasourceUid?: string;
};

type ListMetricsParams = DatasourceParams & {
  prefix?: string;
};

type ListLabelValuesParams = DatasourceParams & {
  label: string;
  match?: string;
};

type QueryPrometheusParams = DatasourceParams & {
  query: string;
  type?: 'instant' | 'range';
  start?: string;
  end?: string;
  step?: string;
};

type UploadDashboardParams = {
  dashboard_json: string;
  overwrite?: boolean;
  folderUid?: string;
};

type ManagedDashboardParams = {
  templateId?: string;
  uid?: string;
  title?: string;
  datasourceUid: string;
  folderUid?: string;
  job?: string;
  tags?: string[];
  overwrite?: boolean;
};

type DashboardUidParams = {
  uid: string;
};

type ListDashboardsParams = {
  query?: string;
  tag?: string;
};

type ScreenshotParams = DashboardUidParams & {
  panelId?: number;
  from?: string;
  to?: string;
  width?: number;
  height?: number;
  theme?: 'dark' | 'light';
};

type JsonnetLibSearchParams = {
  pattern: string;
  path?: string;
};

type JsonnetLibReadParams = {
  path: string;
  offset?: number;
  limit?: number;
};

type JsonnetLibListParams = {
  path?: string;
};

const REQUIRED_DASHBOARD_TAG = 'genai';
const BUILTIN_DASHBOARD_DATASOURCE_UIDS = new Set(['__expr__', '-- Mixed --', '-- Dashboard --', 'mixed', 'grafana', 'dashboard', '-100']);

export function createGrafanaTools(toolConfig: GrafanaToolConfig = {}): AgentTool[] {
  return [
    makeGrafanaGetDatasourcesTool(toolConfig),
    makeListMetricsTool(toolConfig),
    makeListLabelValuesTool(toolConfig),
    makeQueryPrometheusTool(toolConfig),
    makeGrafanaUploadDashboardTool(toolConfig),
    makeGrafanaListManagedDashboardTemplatesTool(),
    makeGrafanaListManagedDashboardsTool(),
    makeGrafanaRenderManagedDashboardTool(toolConfig),
    makeGrafanaSyncManagedDashboardTool(toolConfig),
    makeSearchJsonnetLibsTool(),
    makeReadJsonnetLibTool(),
    makeListJsonnetLibsTool(),
    grafanaGetDashboardTool,
    grafanaListDashboardsTool,
    grafanaDeleteDashboardTool,
    grafanaScreenshotTool,
  ];
}

const makeGrafanaGetDatasourcesTool = (toolConfig: GrafanaToolConfig): AgentTool => ({
  name: 'grafana_get_datasources',
  label: 'Get Grafana datasources',
  description: 'List Prometheus-compatible datasources available to the assistant and current Grafana user.',
  parameters: Type.Object({}),
  async execute() {
    const datasources = getPrometheusDatasourceSettings(toolConfig).map((ds) => ({
      name: ds.name,
      uid: ds.uid,
      type: ds.type,
      isDefault: ds.isDefault,
    }));

    return textResult(JSON.stringify(datasources, null, 2), { datasources });
  },
});

const makeListMetricsTool = (toolConfig: GrafanaToolConfig): AgentTool => ({
  name: 'list_metrics',
  label: 'List metrics',
  description: 'List Prometheus metric names, optionally filtered by prefix.',
  parameters: Type.Object({
    datasourceUid: Type.Optional(Type.String({ description: 'Prometheus datasource UID. Defaults to the first available Prometheus datasource.' })),
    prefix: Type.Optional(Type.String({ description: 'Optional metric-name prefix filter.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as ListMetricsParams;
    throwIfAborted(signal);
    const ds = await getPrometheusDatasource(toolConfig, args.datasourceUid);
    const response = await getDatasourceResource<PrometheusMetadataResponse<string[]>>(ds, 'api/v1/label/__name__/values');
    const metrics = (response.data ?? []).filter((name) => !args.prefix || name.startsWith(args.prefix));
    const limited = metrics.slice(0, 1000);
    const suffix = metrics.length > limited.length ? `\n... ${metrics.length - limited.length} more metrics omitted` : '';

    return textResult(`${limited.join('\n')}${suffix}`, {
      datasourceUid: ds.uid,
      count: metrics.length,
      truncated: metrics.length > limited.length,
    });
  },
});

const makeListLabelValuesTool = (toolConfig: GrafanaToolConfig): AgentTool => ({
  name: 'list_label_values',
  label: 'List label values',
  description: 'List Prometheus label values, optionally scoped by a metric selector in match[].',
  parameters: Type.Object({
    datasourceUid: Type.Optional(Type.String({ description: 'Prometheus datasource UID. Defaults to the first available Prometheus datasource.' })),
    label: Type.String({ description: 'Label name, such as job, instance, namespace, pod, or route.' }),
    match: Type.Optional(Type.String({ description: 'Optional Prometheus match[] selector, such as up or http_requests_total{job="api"}.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as ListLabelValuesParams;
    throwIfAborted(signal);
    const ds = await getPrometheusDatasource(toolConfig, args.datasourceUid);
    const response = await getDatasourceResource<PrometheusMetadataResponse<string[]>>(
      ds,
      `api/v1/label/${encodeURIComponent(args.label)}/values`,
      args.match ? { 'match[]': args.match } : undefined
    );
    const values = response.data ?? [];
    const limited = values.slice(0, 1000);
    const suffix = values.length > limited.length ? `\n... ${values.length - limited.length} more values omitted` : '';

    return textResult(`${limited.join('\n')}${suffix}`, {
      datasourceUid: ds.uid,
      label: args.label,
      count: values.length,
      truncated: values.length > limited.length,
    });
  },
});

const makeQueryPrometheusTool = (toolConfig: GrafanaToolConfig): AgentTool => ({
  name: 'query_prometheus',
  label: 'Query Prometheus',
  description: 'Run an instant or range PromQL query through Grafana as the current user.',
  parameters: Type.Object({
    datasourceUid: Type.Optional(Type.String({ description: 'Prometheus datasource UID. Defaults to the first available Prometheus datasource.' })),
    query: Type.String({ description: 'PromQL expression.' }),
    type: Type.Optional(Type.Union([Type.Literal('instant'), Type.Literal('range')], { description: 'Query type. Defaults to instant.' })),
    start: Type.Optional(Type.String({ description: 'Range start such as now-1h, now-6h, or an ISO timestamp.' })),
    end: Type.Optional(Type.String({ description: 'Range end such as now or an ISO timestamp.' })),
    step: Type.Optional(Type.String({ description: 'Resolution step such as 30s, 1m, or 5m.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as QueryPrometheusParams;
    throwIfAborted(signal);
    const ds = await getPrometheusDatasource(toolConfig, args.datasourceUid);
    const queryType = args.type ?? 'instant';
    const timeRange = queryType === 'range' ? makeTimeRange(args.start ?? 'now-1h', args.end ?? 'now') : getDefaultTimeRange();
    const interval = args.step ?? '1m';
    const intervalMs = durationToMs(interval) ?? 60000;
    const target = {
      refId: 'A',
      datasource: { uid: ds.uid, type: ds.type },
      expr: args.query,
      range: queryType === 'range',
      instant: queryType === 'instant',
      interval,
      editorMode: 'code',
    } as DataQueryRequest['targets'][number];

    const request: DataQueryRequest = {
      app: CoreApp.Unknown,
      requestId: `pi-query-${Date.now()}`,
      interval,
      intervalMs,
      maxDataPoints: 600,
      range: timeRange,
      rangeRaw: timeRange.raw,
      scopedVars: {},
      targets: [target],
      timezone: config.bootData.user.timezone || 'browser',
      startTime: Date.now(),
    };

    const response = await resolveQueryResponse(ds.query(request));
    if (response.state === LoadingState.Error) {
      throw new Error(response.errors?.[0]?.message || 'Prometheus query failed');
    }

    const frames = response.data ?? [];
    const result = truncateText(JSON.stringify(frames.map(frameToJson), null, 2), 120000);

    return textResult(result, {
      datasourceUid: ds.uid,
      query: args.query,
      frames: frames.length,
    });
  },
});

const makeGrafanaUploadDashboardTool = (toolConfig: GrafanaToolConfig): AgentTool => ({
  name: 'grafana_upload_dashboard',
  label: 'Upload dashboard',
  description: 'Create or update a Grafana dashboard JSON model as the current user.',
  parameters: Type.Object({
    dashboard_json: Type.String({ description: 'Grafana dashboard JSON object as a string.' }),
    overwrite: Type.Optional(Type.Boolean({ description: 'Whether to overwrite an existing dashboard UID. Defaults to true.' })),
    folderUid: Type.Optional(Type.String({ description: 'Optional target folder UID.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as UploadDashboardParams;
    throwIfAborted(signal);
    const dashboard = parseDashboard(args.dashboard_json);
    if (!dashboard.title) {
      throw new Error('Dashboard JSON must include a title');
    }
    const disallowedDatasourceUids = getDisallowedDashboardDatasourceUids(dashboard, toolConfig);
    if (disallowedDatasourceUids.length > 0) {
      throw new Error(`Dashboard references datasource UIDs not available to the assistant: ${disallowedDatasourceUids.join(', ')}`);
    }

    dashboard.uid = normalizeDashboardUid(dashboard.uid, String(dashboard.title));
    dashboard.tags = ensureRequiredTag(dashboard.tags);
    delete dashboard.id;

    const result = await backendFetch<{ uid: string; url: string; status: string }>('/api/dashboards/db', {
      method: 'POST',
      data: {
        dashboard,
        folderUid: args.folderUid,
        overwrite: args.overwrite ?? true,
      },
    });

    const absoluteUrl = new URL(result.url, window.location.origin).toString();
    return textResult(`Dashboard uploaded: ${absoluteUrl}\nUID: ${result.uid}\nStatus: ${result.status}`, {
      uid: result.uid,
      url: absoluteUrl,
      status: result.status,
    });
  },
});

const makeGrafanaListManagedDashboardTemplatesTool = (): AgentTool => ({
  name: 'grafana_list_managed_dashboard_templates',
  label: 'List managed dashboard templates',
  description: 'List Jsonnet/Grafonnet dashboard templates bundled with this app.',
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, signal) {
    throwIfAborted(signal);
    const result = await pluginResourceFetch<{ templates: unknown[] }>('/managed-dashboards/templates');
    return textResult(JSON.stringify(result.templates, null, 2), { count: result.templates.length });
  },
});

const makeGrafanaListManagedDashboardsTool = (): AgentTool => ({
  name: 'grafana_list_managed_dashboards',
  label: 'List managed dashboards',
  description: 'List dashboards currently managed by this app plugin, including stored template configuration when available.',
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, signal) {
    throwIfAborted(signal);
    const result = await pluginResourceFetch<{ dashboards: unknown[] }>('/managed-dashboards');
    return textResult(JSON.stringify(result.dashboards, null, 2), { count: result.dashboards.length });
  },
});

const makeGrafanaRenderManagedDashboardTool = (toolConfig: GrafanaToolConfig): AgentTool => ({
  name: 'grafana_render_managed_dashboard',
  label: 'Render managed dashboard',
  description: 'Render an app-managed Jsonnet/Grafonnet dashboard template without saving it.',
  parameters: managedDashboardParameters(),
  async execute(_toolCallId, params, signal) {
    const args = params as ManagedDashboardParams;
    throwIfAborted(signal);
    assertManagedDashboardDatasourceAllowed(toolConfig, args.datasourceUid);
    const result = await pluginResourceFetch<unknown>('/managed-dashboards/render', { method: 'POST', data: args });
    return textResult(truncateText(JSON.stringify(result, null, 2), 120000), {
      templateId: args.templateId ?? 'service-red',
      datasourceUid: args.datasourceUid,
    });
  },
});

const makeGrafanaSyncManagedDashboardTool = (toolConfig: GrafanaToolConfig): AgentTool => ({
  name: 'grafana_sync_managed_dashboard',
  label: 'Sync managed dashboard',
  description: 'Create or update a dashboard from an app-managed Jsonnet/Grafonnet template. The Grafana UI remains read-only; future edits should go through this app.',
  parameters: managedDashboardParameters(),
  async execute(_toolCallId, params, signal) {
    const args = params as ManagedDashboardParams;
    throwIfAborted(signal);
    assertManagedDashboardDatasourceAllowed(toolConfig, args.datasourceUid);
    const result = await pluginResourceFetch<{ uid: string; url: string; status: string; sourceChecksum: string }>('/managed-dashboards/sync', {
      method: 'POST',
      data: args,
    });
    return textResult(`Managed dashboard ${result.status}: ${result.url}\nUID: ${result.uid}\nSource: ${result.sourceChecksum}`, result);
  },
});

const makeSearchJsonnetLibsTool = (): AgentTool => ({
  name: 'search_jsonnet_libs',
  label: 'Search Jsonnet libraries',
  description: 'Search vendored Grafonnet/Jsonnet library files for API names and examples.',
  parameters: Type.Object({
    pattern: Type.String({ description: 'Plain text search pattern, at least 2 characters.' }),
    path: Type.Optional(Type.String({ description: 'Optional vendored library path prefix, such as github.com/grafana/grafonnet/gen/grafonnet-v11.4.0/panel.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as JsonnetLibSearchParams;
    throwIfAborted(signal);
    const result = await pluginResourceFetch<unknown>('/jsonnet-libs/search', { method: 'POST', data: args });
    return textResult(truncateText(JSON.stringify(result, null, 2), 80000), { pattern: args.pattern });
  },
});

const makeReadJsonnetLibTool = (): AgentTool => ({
  name: 'read_jsonnet_lib',
  label: 'Read Jsonnet library file',
  description: 'Read a range of lines from a vendored Grafonnet/Jsonnet library file.',
  parameters: Type.Object({
    path: Type.String({ description: 'Vendored library path, such as github.com/grafana/grafonnet/gen/grafonnet-v11.4.0/docs/panel/timeSeries/index.md.' }),
    offset: Type.Optional(Type.Number({ description: '1-based start line. Defaults to 1.' })),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of lines. Defaults to 200 and caps at 500.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as JsonnetLibReadParams;
    throwIfAborted(signal);
    const result = await pluginResourceFetch<unknown>('/jsonnet-libs/read', { method: 'POST', data: args });
    return textResult(truncateText(JSON.stringify(result, null, 2), 80000), { path: args.path });
  },
});

const makeListJsonnetLibsTool = (): AgentTool => ({
  name: 'list_jsonnet_libs',
  label: 'List Jsonnet library files',
  description: 'List vendored .libsonnet files under a Grafonnet/Jsonnet library path.',
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: 'Optional vendored library path prefix. Defaults to Grafonnet v11.4.0.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as JsonnetLibListParams;
    throwIfAborted(signal);
    const result = await pluginResourceFetch<unknown>('/jsonnet-libs/list', { method: 'POST', data: args });
    return textResult(truncateText(JSON.stringify(result, null, 2), 80000), { path: args.path });
  },
});

const grafanaGetDashboardTool: AgentTool = {
  name: 'grafana_get_dashboard',
  label: 'Get dashboard',
  description: 'Fetch a dashboard by UID as the current user.',
  parameters: Type.Object({
    uid: Type.String({ description: 'Dashboard UID.' }),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as DashboardUidParams;
    throwIfAborted(signal);
    const result = await backendFetch<unknown>(`/api/dashboards/uid/${encodeURIComponent(args.uid)}`);
    return textResult(truncateText(JSON.stringify(result, null, 2), 120000), { uid: args.uid });
  },
};

const grafanaListDashboardsTool: AgentTool = {
  name: 'grafana_list_dashboards',
  label: 'List dashboards',
  description: 'Search dashboards visible to the current user.',
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: 'Optional dashboard title search text.' })),
    tag: Type.Optional(Type.String({ description: 'Optional dashboard tag filter.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as ListDashboardsParams;
    throwIfAborted(signal);
    const result = await backendFetch<DashboardSearchResult[]>('/api/search', {
      params: {
        type: 'dash-db',
        query: args.query,
        tag: args.tag,
        limit: 100,
      },
    });

    const dashboards = result.map((dash) => ({
      ...dash,
      url: new URL(dash.url, window.location.origin).toString(),
    }));

    return textResult(JSON.stringify(dashboards, null, 2), { count: dashboards.length });
  },
};

const grafanaDeleteDashboardTool: AgentTool = {
  name: 'grafana_delete_dashboard',
  label: 'Delete dashboard',
  description: 'Delete a dashboard by UID as the current user.',
  parameters: Type.Object({
    uid: Type.String({ description: 'Dashboard UID.' }),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as DashboardUidParams;
    throwIfAborted(signal);
    const result = await backendFetch<unknown>(`/api/dashboards/uid/${encodeURIComponent(args.uid)}`, {
      method: 'DELETE',
    });
    return textResult(`Dashboard ${args.uid} deleted`, { uid: args.uid, result });
  },
};

const grafanaScreenshotTool: AgentTool = {
  name: 'grafana_screenshot',
  label: 'Render dashboard screenshot',
  description: 'Render a dashboard or panel image using Grafana image rendering, if configured.',
  parameters: Type.Object({
    uid: Type.String({ description: 'Dashboard UID.' }),
    panelId: Type.Optional(Type.Number({ description: 'Optional panel ID for d-solo rendering.' })),
    from: Type.Optional(Type.String({ description: 'Render start time. Defaults to now-1h.' })),
    to: Type.Optional(Type.String({ description: 'Render end time. Defaults to now.' })),
    width: Type.Optional(Type.Number({ description: 'Image width. Defaults to 1200.' })),
    height: Type.Optional(Type.Number({ description: 'Image height. Defaults to 700.' })),
    theme: Type.Optional(Type.Union([Type.Literal('dark'), Type.Literal('light')], { description: 'Render theme.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as ScreenshotParams;
    throwIfAborted(signal);
    const dashboard = await backendFetch<{ meta: { slug: string } }>(`/api/dashboards/uid/${encodeURIComponent(args.uid)}`);
    const width = clamp(args.width ?? 1200, 300, 2400);
    const height = clamp(args.height ?? 700, 200, 2400);
    const renderPath =
      typeof args.panelId === 'number'
        ? `/render/d-solo/${encodeURIComponent(args.uid)}/${encodeURIComponent(dashboard.meta.slug)}`
        : `/render/d/${encodeURIComponent(args.uid)}/${encodeURIComponent(dashboard.meta.slug)}`;
    const renderUrl = new URL(renderPath, window.location.origin);
    renderUrl.searchParams.set('orgId', String(config.bootData.user.orgId || 1));
    renderUrl.searchParams.set('from', args.from ?? 'now-1h');
    renderUrl.searchParams.set('to', args.to ?? 'now');
    renderUrl.searchParams.set('width', String(width));
    renderUrl.searchParams.set('height', String(height));
    renderUrl.searchParams.set('theme', args.theme ?? 'dark');
    renderUrl.searchParams.set('kiosk', '1');
    if (typeof args.panelId === 'number') {
      renderUrl.searchParams.set('panelId', String(args.panelId));
    }

    const response = await fetch(renderUrl.toString(), { signal });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Grafana render failed (${response.status}). Is image rendering configured? ${errorText}`);
    }

    const data = arrayBufferToBase64(await response.arrayBuffer());
    return {
      content: [
        { type: 'text', text: `Rendered ${args.uid}${args.panelId ? ` panel ${args.panelId}` : ''}.` },
        { type: 'image', data, mimeType: response.headers.get('content-type') || 'image/png' },
      ],
      details: {
        uid: args.uid,
        panelId: args.panelId,
        width,
        height,
      },
    };
  },
};

export function filterAllowedPrometheusDatasourceSettings(
  datasources: DataSourceInstanceSettings[],
  allowedDatasourceUids?: string[]
) {
  const allowedUids = new Set((allowedDatasourceUids ?? []).filter(Boolean));

  return datasources.filter((ds) => ds.type === 'prometheus' && (allowedUids.size === 0 || allowedUids.has(ds.uid)));
}

function getPrometheusDatasourceSettings(toolConfig: GrafanaToolConfig) {
  return filterAllowedPrometheusDatasourceSettings(getDataSourceSrv().getList({ metrics: true }), toolConfig.allowedDatasourceUids);
}

async function getPrometheusDatasource(toolConfig: GrafanaToolConfig, uid?: string): Promise<ResourceCapableDataSource> {
  const available = getPrometheusDatasourceSettings(toolConfig);
  const selected = uid ? available.find((ds) => ds.uid === uid) : available[0];

  if (!selected) {
    throw new Error(uid ? `Datasource is not available to the assistant: ${uid}` : 'No Prometheus datasource is available to the assistant');
  }

  return getDataSourceSrv().get({ uid: selected.uid, type: selected.type }) as Promise<ResourceCapableDataSource>;
}

async function getDatasourceResource<T>(ds: ResourceCapableDataSource, path: string, params?: Record<string, unknown>): Promise<T> {
  if (typeof ds.getResource === 'function') {
    return ds.getResource<T>(path, params);
  }

  const settings = getDataSourceSrv().getInstanceSettings(ds.getRef());
  if (!settings?.uid) {
    throw new Error('Datasource does not expose resource calls');
  }

  return backendFetch<T>(`/api/datasources/uid/${encodeURIComponent(settings.uid)}/resources/${path}`, { params });
}

async function backendFetch<T>(url: string, options: { method?: string; data?: unknown; params?: Record<string, unknown> } = {}): Promise<T> {
  const response = await lastValueFrom(
    getBackendSrv().fetch<T>({
      url,
      method: options.method ?? 'GET',
      data: options.data,
      params: compactParams(options.params),
      showErrorAlert: false,
    })
  );
  return response.data;
}

async function pluginResourceFetch<T>(path: string, options: { method?: string; data?: unknown; params?: Record<string, unknown> } = {}): Promise<T> {
  return backendFetch<T>(`/api/plugins/${PLUGIN_ID}/resources${path}`, options);
}

function managedDashboardParameters() {
  return Type.Object({
    templateId: Type.Optional(Type.String({ description: 'Bundled managed dashboard template ID. Defaults to service-red.' })),
    uid: Type.Optional(Type.String({ description: 'Optional dashboard UID. Defaults to a normalized UID from the title.' })),
    title: Type.Optional(Type.String({ description: 'Dashboard title.' })),
    datasourceUid: Type.String({ description: 'Prometheus datasource UID. Must be returned by grafana_get_datasources.' }),
    folderUid: Type.Optional(Type.String({ description: 'Optional folder UID.' })),
    job: Type.Optional(Type.String({ description: 'Optional Prometheus job label value used by the service-red template.' })),
    tags: Type.Optional(Type.Array(Type.String(), { description: 'Optional extra dashboard tags.' })),
    overwrite: Type.Optional(Type.Boolean({ description: 'Whether to update an existing dashboard with the same UID. Defaults to true.' })),
  });
}

function assertManagedDashboardDatasourceAllowed(toolConfig: GrafanaToolConfig, datasourceUid: string) {
  const allowed = new Set((toolConfig.allowedDatasourceUids ?? []).filter(Boolean));
  if (!datasourceUid) {
    throw new Error('datasourceUid is required');
  }
  if (allowed.size > 0 && !allowed.has(datasourceUid)) {
    throw new Error(`Datasource is not available to the assistant: ${datasourceUid}`);
  }
}

function makeTimeRange(fromRaw: string, toRaw: string): TimeRange {
  const to = parseTime(toRaw) ?? dateTime();
  const from = parseTime(fromRaw) ?? dateTime(to).subtract(1, 'hour');

  return {
    from,
    to,
    raw: {
      from: fromRaw,
      to: toRaw,
    },
  };
}

function parseTime(raw: string) {
  const trimmed = raw.trim();
  if (trimmed === 'now') {
    return dateTime();
  }

  const relative = /^now-(\d+)(m|h|d)$/.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] === 'm' ? 'minute' : relative[2] === 'h' ? 'hour' : 'day';
    return dateTime().subtract(amount, unit);
  }

  const parsed = dateTime(trimmed);
  return parsed.isValid() ? parsed : undefined;
}

function frameToJson(frame: DataFrame) {
  return dataFrameToJSON(frame);
}

async function resolveQueryResponse(result: Promise<DataQueryResponse> | Observable<DataQueryResponse>): Promise<DataQueryResponse> {
  if (isPromise<DataQueryResponse>(result)) {
    return result;
  }
  return lastValueFrom(result);
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return Boolean(value && typeof value === 'object' && 'then' in value && typeof (value as Promise<T>).then === 'function');
}

function parseDashboard(source: string): Record<string, any> {
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Dashboard JSON must be an object');
  }
  return parsed as Record<string, any>;
}

export function getDisallowedDashboardDatasourceUids(dashboard: unknown, toolConfig: GrafanaToolConfig): string[] {
  const allowedUids = new Set((toolConfig.allowedDatasourceUids ?? []).filter(Boolean));
  if (allowedUids.size === 0) {
    return [];
  }

  return [...collectDashboardDatasourceUids(dashboard)]
    .filter((uid) => !allowedUids.has(uid))
    .sort((left, right) => left.localeCompare(right));
}

function collectDashboardDatasourceUids(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectDashboardDatasourceUids(item, result));
    return result;
  }
  if (!value || typeof value !== 'object') {
    return result;
  }

  const record = value as Record<string, unknown>;
  if ('datasource' in record) {
    addDatasourceUid(record.datasource, result);
  }
  Object.values(record).forEach((item) => collectDashboardDatasourceUids(item, result));

  return result;
}

function addDatasourceUid(datasourceRef: unknown, result: Set<string>) {
  const uid =
    typeof datasourceRef === 'string'
      ? datasourceRef.trim()
      : datasourceRef && typeof datasourceRef === 'object' && !Array.isArray(datasourceRef)
        ? String((datasourceRef as Record<string, unknown>).uid ?? '').trim()
        : '';

  if (!uid || BUILTIN_DASHBOARD_DATASOURCE_UIDS.has(uid)) {
    return;
  }
  result.add(uid);
}

function normalizeDashboardUid(uid: unknown, title: string): string {
  const raw =
    typeof uid === 'string' && uid.trim()
      ? uid.trim()
      : title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');

  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function ensureRequiredTag(tags: unknown): string[] {
  const next = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
  if (!next.includes(REQUIRED_DASHBOARD_TAG)) {
    next.push(REQUIRED_DASHBOARD_TAG);
  }
  return next;
}

function textResult<TDetails extends Record<string, unknown>>(text: string, details: TDetails): TextToolResult<TDetails> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n... (truncated)` : value;
}

function compactParams(params?: Record<string, unknown>) {
  if (!params) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== ''));
}

function durationToMs(duration: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * multipliers[unit];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('Tool call aborted');
  }
}
