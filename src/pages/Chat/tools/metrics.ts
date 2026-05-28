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
  type Field,
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
  PrometheusQuerySpec,
  QueryPrometheusParams,
  ResourceCapableDataSource,
} from './types';

type MetricToolConfig = GrafanaToolConfig & {
  includeRawPrometheusQueryTool?: boolean;
};

export function createMetricTools(toolConfig: MetricToolConfig): AgentTool[] {
  const tools = [
    makeGrafanaGetDatasourcesTool(toolConfig),
    makeListMetricsTool(toolConfig),
    makeListLabelValuesTool(toolConfig),
    makeInspectMetricSeriesTool(toolConfig),
    makeQueryPrometheusTool(toolConfig),
  ];

  if (toolConfig.includeRawPrometheusQueryTool) {
    tools.push(makeQueryPrometheusRawTool(toolConfig));
  }

  return tools;
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
    name: 'list_datasources',
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
      datasourceUid: Type.Optional(
        Type.String({
          description: 'Prometheus datasource UID. Defaults to the first available Prometheus datasource.',
        })
      ),
      prefix: Type.Optional(Type.String({ description: 'Optional metric-name prefix filter.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as ListMetricsParams;
      throwIfAborted(signal);
      const ds = await getPrometheusDatasource(toolConfig, args.datasourceUid);
      const response = await getDatasourceResource<PrometheusMetadataResponse<string[]>>(
        ds,
        'api/v1/label/__name__/values'
      );
      const metrics = (response.data ?? []).filter((name) => !args.prefix || name.startsWith(args.prefix));
      const limited = metrics.slice(0, 1000);
      const suffix =
        metrics.length > limited.length ? `\n... ${metrics.length - limited.length} more metrics omitted` : '';

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
      datasourceUid: Type.Optional(
        Type.String({
          description: 'Prometheus datasource UID. Defaults to the first available Prometheus datasource.',
        })
      ),
      label: Type.String({ description: 'Label name, such as job, instance, namespace, pod, or route.' }),
      match: Type.Optional(
        Type.String({
          description: 'Optional Prometheus match[] selector, such as up or http_requests_total{job="api"}.',
        })
      ),
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
      const suffix =
        values.length > limited.length ? `\n... ${values.length - limited.length} more values omitted` : '';

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
      datasourceUid: Type.Optional(
        Type.String({
          description: 'Prometheus datasource UID. Defaults to the first available Prometheus datasource.',
        })
      ),
      match: Type.String({
        description: 'Prometheus match[] selector, such as http_requests_total or http_requests_total{job="web"}.',
      }),
      limit: Type.Optional(
        Type.Number({ description: 'Maximum example series to return. Defaults to 20, maximum 100.' })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as InspectMetricSeriesParams;
      throwIfAborted(signal);
      const ds = await getPrometheusDatasource(toolConfig, args.datasourceUid);
      const response = await getDatasourceResource<PrometheusMetadataResponse<Array<Record<string, string>>>>(
        ds,
        'api/v1/series',
        {
          'match[]': args.match,
        }
      );
      const series = response.data ?? [];
      const limit = clampInt(args.limit ?? 20, 1, 100);
      const examples = series.slice(0, limit);
      const labelNames = Array.from(
        new Set(series.flatMap((item) => Object.keys(item)).filter((name) => name !== '__name__'))
      ).sort();
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
    description:
      'Run an instant or range PromQL query through Grafana as the current user. Results are compact validation summaries with min/max/last values, not raw data frames.',
    parameters: Type.Object({
      datasourceUid: Type.Optional(
        Type.String({
          description: 'Prometheus datasource UID. Defaults to the first available Prometheus datasource.',
        })
      ),
      query: Type.Optional(Type.String({ description: 'PromQL expression for a single validation.' })),
      queries: Type.Optional(
        Type.Array(
          Type.Object({
            query: Type.String({ description: 'PromQL expression.' }),
            type: Type.Optional(
              Type.Union([Type.Literal('instant'), Type.Literal('range')], {
                description: 'Query type. Defaults to instant.',
              })
            ),
            start: Type.Optional(
              Type.String({ description: 'Range start such as now-1h, now-6h, or an ISO timestamp.' })
            ),
            end: Type.Optional(Type.String({ description: 'Range end such as now or an ISO timestamp.' })),
          }),
          {
            description:
              'Batch of PromQL expressions to validate in one tool call. Prefer this when checking multiple dashboard queries.',
          }
        )
      ),
      type: Type.Optional(
        Type.Union([Type.Literal('instant'), Type.Literal('range')], {
          description: 'Query type. Defaults to instant.',
        })
      ),
      start: Type.Optional(Type.String({ description: 'Range start such as now-1h, now-6h, or an ISO timestamp.' })),
      end: Type.Optional(Type.String({ description: 'Range end such as now or an ISO timestamp.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as QueryPrometheusParams;
      throwIfAborted(signal);
      const ds = await getPrometheusDatasource(toolConfig, args.datasourceUid);
      const querySpecs = querySpecsFromParams(args);
      if (querySpecs.length === 0) {
        throw new Error('query_prometheus requires query or queries.');
      }

      if (querySpecs.length === 1) {
        const summary = await runPrometheusQuerySummary(ds, querySpecs[0]);
        const result = truncateText(JSON.stringify(summary, null, 2), 40000);

        return textResult(result, {
          datasourceUid: ds.uid,
          query: summary.query,
          interval: summary.interval,
          frames: summary.frameCount,
          series: summary.series.length,
          totalSeries: summary.totalSeries,
          truncatedSeries: summary.truncatedSeries,
          summarized: true,
          ...prometheusVisualizationDetails(summary),
        });
      }

      const results: PrometheusQuerySummary[] = [];
      for (const querySpec of querySpecs.slice(0, 10)) {
        throwIfAborted(signal);
        results.push(compactBatchPrometheusSummary(await runPrometheusQuerySummary(ds, querySpec)));
      }
      const batch = {
        datasourceUid: ds.uid,
        queryCount: querySpecs.length,
        truncatedQueries: querySpecs.length > results.length,
        results,
      };

      return textResult(truncateText(JSON.stringify(batch, null, 2), 40000), {
        datasourceUid: ds.uid,
        queries: querySpecs.length,
        summarized: true,
        batch: true,
      });
    },
  };
}

function makeQueryPrometheusRawTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'query_prometheus_raw',
    label: 'Query Prometheus raw',
    description:
      'Run a PromQL query and return raw Grafana data frames. This is intentionally verbose and should only be enabled for developer/debug workflows.',
    parameters: Type.Object({
      datasourceUid: Type.Optional(
        Type.String({
          description: 'Prometheus datasource UID. Defaults to the first available Prometheus datasource.',
        })
      ),
      query: Type.String({ description: 'PromQL expression.' }),
      type: Type.Optional(
        Type.Union([Type.Literal('instant'), Type.Literal('range')], {
          description: 'Query type. Defaults to instant.',
        })
      ),
      start: Type.Optional(Type.String({ description: 'Range start such as now-1h, now-6h, or an ISO timestamp.' })),
      end: Type.Optional(Type.String({ description: 'Range end such as now or an ISO timestamp.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as QueryPrometheusParams;
      if (!args.query) {
        throw new Error('query_prometheus_raw requires query.');
      }
      throwIfAborted(signal);
      const ds = await getPrometheusDatasource(toolConfig, args.datasourceUid);
      const queryType = args.type ?? 'instant';
      const timeRange =
        queryType === 'range' ? makeTimeRange(args.start ?? 'now-1h', args.end ?? 'now') : getDefaultTimeRange();
      const interval = queryType === 'range' ? chooseRangeInterval(timeRange) : '1m';
      const response = await runPrometheusQuery(ds, args.query, queryType, timeRange, interval);
      const frames = response.data ?? [];
      const result = truncateText(JSON.stringify(frames.map(frameToJson), null, 2), 120000);

      return textResult(result, {
        datasourceUid: ds.uid,
        query: args.query,
        interval,
        frames: frames.length,
        raw: true,
      });
    },
  };
}

function querySpecsFromParams(args: QueryPrometheusParams): PrometheusQuerySpec[] {
  if (Array.isArray(args.queries) && args.queries.length > 0) {
    return args.queries.filter((querySpec) => typeof querySpec.query === 'string' && querySpec.query.trim());
  }
  return typeof args.query === 'string' && args.query.trim()
    ? [{ query: args.query, type: args.type, start: args.start, end: args.end }]
    : [];
}

async function runPrometheusQuerySummary(
  ds: ResourceCapableDataSource,
  querySpec: PrometheusQuerySpec
): Promise<PrometheusQuerySummary> {
  const queryType = querySpec.type ?? 'instant';
  const timeRange =
    queryType === 'range' ? makeTimeRange(querySpec.start ?? 'now-1h', querySpec.end ?? 'now') : getDefaultTimeRange();
  const interval = queryType === 'range' ? chooseRangeInterval(timeRange) : '1m';
  const response = await runPrometheusQuery(ds, querySpec.query, queryType, timeRange, interval);
  const frames = response.data ?? [];
  return summarizePrometheusQuery({
    datasourceUid: ds.uid,
    query: querySpec.query,
    queryType,
    interval,
    timeRange,
    frames,
  });
}

function getPrometheusDatasourceSettings(toolConfig: GrafanaToolConfig) {
  return filterAllowedPrometheusDatasourceSettings(
    getDataSourceSrv().getList({ metrics: true }),
    toolConfig.allowedDatasourceUids
  );
}

async function getPrometheusDatasource(
  toolConfig: GrafanaToolConfig,
  uid?: string
): Promise<ResourceCapableDataSource> {
  const available = getPrometheusDatasourceSettings(toolConfig);
  const selected = uid ? available.find((ds) => ds.uid === uid) : available[0];

  if (!selected) {
    throw new Error(
      uid
        ? `Datasource is not available to the assistant: ${uid}`
        : 'No Prometheus datasource is available to the assistant'
    );
  }

  return getDataSourceSrv().get({ uid: selected.uid, type: selected.type }) as Promise<ResourceCapableDataSource>;
}

async function getDatasourceResource<T>(
  ds: ResourceCapableDataSource,
  path: string,
  params?: Record<string, unknown>
): Promise<T> {
  if (typeof ds.getResource === 'function') {
    return ds.getResource<T>(path, params);
  }

  const settings = getDataSourceSrv().getInstanceSettings(ds.getRef());
  if (!settings?.uid) {
    throw new Error('Datasource does not expose resource calls');
  }

  return backendFetch<T>(`/api/datasources/uid/${encodeURIComponent(settings.uid)}/resources/${path}`, { params });
}

async function runPrometheusQuery(
  ds: ResourceCapableDataSource,
  query: string,
  queryType: 'instant' | 'range',
  timeRange: TimeRange,
  interval: string
): Promise<DataQueryResponse> {
  const intervalMs = durationToMs(interval) ?? 60000;
  const target = {
    refId: 'A',
    datasource: { uid: ds.uid, type: ds.type },
    expr: query,
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
    maxDataPoints: PROMETHEUS_QUERY_MAX_DATA_POINTS,
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

  return response;
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

type PrometheusQuerySummary = {
  datasourceUid: string;
  query: string;
  queryType: 'instant' | 'range';
  interval: string;
  range: {
    from: string;
    to: string;
    raw: TimeRange['raw'];
  };
  frameCount: number;
  totalSeries: number;
  truncatedSeries: boolean;
  notices: QueryNotice[];
  executedQueryStrings: string[];
  series: SeriesSummary[];
};

type QueryNotice = {
  severity?: string;
  text?: string;
};

type SeriesSummary = {
  name: string;
  labels: Record<string, string>;
  points: number;
  nonNullPoints: number;
  nullPoints: number;
  last?: SummaryPoint;
  min?: SummaryPoint;
  max?: SummaryPoint;
  mean?: number;
  delta?: number;
  deltaPercent?: number;
};

type SummaryPoint = {
  time?: string;
  value: number | null;
};

const MAX_SERIES_SUMMARIES = 8;
const MAX_BATCH_SERIES_SUMMARIES = 3;
const PROMETHEUS_QUERY_MAX_DATA_POINTS = 1200;

function summarizePrometheusQuery(options: {
  datasourceUid: string;
  query: string;
  queryType: 'instant' | 'range';
  interval: string;
  timeRange: TimeRange;
  frames: DataFrame[];
}): PrometheusQuerySummary {
  const allSeries: SeriesSummary[] = [];

  for (const frame of options.frames) {
    const timeField = frame.fields.find(isTimeField);
    const numberFields = frame.fields.filter(isNumberField);

    for (const field of numberFields) {
      allSeries.push(summarizeNumberField(frame, field, timeField));
    }
  }

  return {
    datasourceUid: options.datasourceUid,
    query: options.query,
    queryType: options.queryType,
    interval: options.interval,
    range: {
      from: options.timeRange.from.toISOString(),
      to: options.timeRange.to.toISOString(),
      raw: options.timeRange.raw,
    },
    frameCount: options.frames.length,
    totalSeries: allSeries.length,
    truncatedSeries: allSeries.length > MAX_SERIES_SUMMARIES,
    notices: collectNotices(options.frames),
    executedQueryStrings: collectExecutedQueryStrings(options.frames),
    series: allSeries.slice(0, MAX_SERIES_SUMMARIES),
  };
}

function prometheusVisualizationDetails(summary: PrometheusQuerySummary) {
  if (summary.queryType !== 'range') {
    return {};
  }

  return {
    visualization: {
      kind: 'prometheus-timeseries',
      datasourceUid: summary.datasourceUid,
      query: summary.query,
      queryType: summary.queryType,
      interval: summary.interval,
      maxDataPoints: PROMETHEUS_QUERY_MAX_DATA_POINTS,
      range: {
        from: summary.range.from,
        to: summary.range.to,
        raw: {
          from: String(summary.range.raw.from),
          to: String(summary.range.raw.to),
        },
      },
    },
  };
}

function summarizeNumberField(frame: DataFrame, field: Field, timeField?: Field): SeriesSummary {
  const points = getFieldLength(field, frame.length ?? 0);
  let first: SummaryPoint | undefined;
  let last: SummaryPoint | undefined;
  let min: SummaryPoint | undefined;
  let max: SummaryPoint | undefined;
  let sum = 0;
  let nonNullPoints = 0;

  for (let index = 0; index < points; index++) {
    const value = finiteNumber(valueAt(field, index));
    if (value === null) {
      continue;
    }

    const point = pointAt(field, timeField, index, value);
    first ??= point;
    last = point;
    if (!min || value < min.value!) {
      min = point;
    }
    if (!max || value > max.value!) {
      max = point;
    }
    sum += value;
    nonNullPoints++;
  }

  const summary: SeriesSummary = {
    name: seriesName(frame, field),
    labels: stringLabels(field.labels),
    points,
    nonNullPoints,
    nullPoints: Math.max(0, points - nonNullPoints),
    last,
    min,
    max,
    mean: nonNullPoints > 0 ? roundNumber(sum / nonNullPoints) : undefined,
  };

  if (first && last && first.value !== null && last.value !== null) {
    summary.delta = roundNumber(last.value - first.value);
    if (first.value !== 0) {
      summary.deltaPercent = roundNumber(((last.value - first.value) / Math.abs(first.value)) * 100);
    }
  }

  return summary;
}

function compactBatchPrometheusSummary(summary: PrometheusQuerySummary): PrometheusQuerySummary {
  return {
    ...summary,
    truncatedSeries: summary.truncatedSeries || summary.totalSeries > MAX_BATCH_SERIES_SUMMARIES,
    series: summary.series.slice(0, MAX_BATCH_SERIES_SUMMARIES),
  };
}

function isTimeField(field: Field) {
  return field.type === 'time';
}

function isNumberField(field: Field) {
  return field.type === 'number';
}

function seriesName(frame: DataFrame, field: Field) {
  const displayName = field.config?.displayNameFromDS || field.config?.displayName || field.name || frame.name;
  return displayName || 'series';
}

function stringLabels(labels: Field['labels']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    result[key] = String(value);
  }
  return result;
}

function pointAt(field: Field, timeField: Field | undefined, index: number, knownValue?: number | null): SummaryPoint {
  const value = knownValue ?? finiteNumber(valueAt(field, index));
  const rawTime = timeField ? valueAt(timeField, index) : undefined;
  const time = formatTime(rawTime);
  return time ? { time, value } : { value };
}

function formatTime(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw).toISOString();
  }
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (typeof raw === 'string' && raw.trim()) {
    const date = new Date(raw);
    return Number.isNaN(date.valueOf()) ? raw : date.toISOString();
  }
  return undefined;
}

function finiteNumber(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(value) ? roundNumber(value) : null;
}

function roundNumber(value: number): number {
  if (value === 0) {
    return 0;
  }
  if (Math.abs(value) >= 1_000_000 || Math.abs(value) < 0.000001) {
    return Number(value.toExponential(6));
  }
  return Number(value.toPrecision(7));
}

function getFieldLength(field: Field, fallback: number): number {
  const values = (field as any).values;
  return Number.isFinite(values?.length) ? values.length : fallback;
}

function valueAt(field: Field, index: number): unknown {
  const values = (field as any).values;
  if (!values) {
    return undefined;
  }
  if (typeof values.get === 'function') {
    return values.get(index);
  }
  return values[index];
}

function collectNotices(frames: DataFrame[]): QueryNotice[] {
  const seen = new Set<string>();
  const notices: QueryNotice[] = [];

  for (const frame of frames) {
    const frameNotices = ((frame.meta as any)?.notices ?? []) as QueryNotice[];
    for (const notice of frameNotices) {
      const key = `${notice.severity ?? ''}:${notice.text ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        notices.push({
          severity: notice.severity,
          text: notice.text,
        });
      }
    }
  }

  return notices.slice(0, 10);
}

function collectExecutedQueryStrings(frames: DataFrame[]): string[] {
  const queries = new Set<string>();
  for (const frame of frames) {
    const executed = (frame.meta as any)?.executedQueryString;
    if (typeof executed === 'string' && executed.trim()) {
      queries.add(executed);
    }
  }
  return Array.from(queries).slice(0, 3);
}

async function resolveQueryResponse(
  result: Promise<DataQueryResponse> | Observable<DataQueryResponse>
): Promise<DataQueryResponse> {
  if (isPromise<DataQueryResponse>(result)) {
    return result;
  }
  return lastValueFrom(result);
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return Boolean(
    value && typeof value === 'object' && 'then' in value && typeof (value as Promise<T>).then === 'function'
  );
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

function chooseRangeInterval(timeRange: TimeRange): string {
  const durationMs = Math.max(0, timeRange.to.valueOf() - timeRange.from.valueOf());
  if (durationMs <= 6 * 60 * 60 * 1000) {
    return '30s';
  }
  if (durationMs <= 24 * 60 * 60 * 1000) {
    return '1m';
  }
  if (durationMs <= 7 * 24 * 60 * 60 * 1000) {
    return '5m';
  }
  return '1h';
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
