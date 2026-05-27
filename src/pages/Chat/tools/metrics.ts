import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  CoreApp,
  dateTime,
  dataFrameToJSON,
  getDefaultTimeRange,
  LoadingState,
  type DataFrame,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataSourceInstanceSettings,
  type TimeRange,
} from '@grafana/data';
import { config, getDataSourceSrv } from '@grafana/runtime';
import { lastValueFrom, type Observable } from 'rxjs';
import { Type } from 'typebox';
import { backendFetch } from './client';
import { textResult, throwIfAborted, truncateText } from './result';
import type {
  GrafanaToolConfig,
  InspectMetricSeriesParams,
  ListLabelValuesParams,
  ListMetricsParams,
  PrometheusMetadataResponse,
  QueryPrometheusParams,
  ResourceCapableDataSource,
} from './types';

export function createMetricTools(toolConfig: GrafanaToolConfig): AgentTool[] {
  return [
    makeGrafanaGetDatasourcesTool(toolConfig),
    makeListMetricsTool(toolConfig),
    makeListLabelValuesTool(toolConfig),
    makeInspectMetricSeriesTool(toolConfig),
    makeQueryPrometheusTool(toolConfig),
  ];
}

export function filterAllowedPrometheusDatasourceSettings(
  datasources: DataSourceInstanceSettings[],
  allowedDatasourceUids?: string[]
) {
  const allowedUids = new Set((allowedDatasourceUids ?? []).filter(Boolean));

  return datasources.filter((ds) => ds.type === 'prometheus' && (allowedUids.size === 0 || allowedUids.has(ds.uid)));
}

function makeGrafanaGetDatasourcesTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
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
  };
}

function makeListMetricsTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
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
  };
}

function makeListLabelValuesTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
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
  };
}

function makeInspectMetricSeriesTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'inspect_metric_series',
    label: 'Inspect metric series',
    description: 'Inspect Prometheus series label names and example label sets for a metric selector.',
    parameters: Type.Object({
      datasourceUid: Type.Optional(Type.String({ description: 'Prometheus datasource UID. Defaults to the first available Prometheus datasource.' })),
      match: Type.String({ description: 'Prometheus match[] selector, such as http_requests_total or http_requests_total{job="web"}.' }),
      limit: Type.Optional(Type.Number({ description: 'Maximum example series to return. Defaults to 20, maximum 100.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as InspectMetricSeriesParams;
      throwIfAborted(signal);
      const ds = await getPrometheusDatasource(toolConfig, args.datasourceUid);
      const response = await getDatasourceResource<PrometheusMetadataResponse<Array<Record<string, string>>>>(ds, 'api/v1/series', {
        'match[]': args.match,
      });
      const series = response.data ?? [];
      const limit = clampInt(args.limit ?? 20, 1, 100);
      const examples = series.slice(0, limit);
      const labelNames = Array.from(new Set(series.flatMap((item) => Object.keys(item)).filter((name) => name !== '__name__'))).sort();
      const result = {
        datasourceUid: ds.uid,
        match: args.match,
        labelNames,
        totalSeries: series.length,
        truncated: series.length > examples.length,
        examples,
      };

      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function makeQueryPrometheusTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
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
  };
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

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
