import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  CoreApp,
  dateTime,
  LoadingState,
  type DataFrame,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataSourceInstanceSettings,
  type DataSourceJsonData,
  type Field,
  type TimeRange,
} from '@grafana/data';
import { config, getDataSourceSrv } from '@grafana/runtime';
import { isObservable, lastValueFrom, type Observable } from 'rxjs';
import { Type } from 'typebox';
import { textResult, throwIfAborted, truncateText } from './result';
import type { GrafanaToolConfig, QueryInfluxParams, ResourceCapableDataSource } from './types';

const INFLUX_DATASOURCE_TYPE = 'influxdb';
const INFLUX_QUERY_INTERVAL = '1m';
const INFLUX_QUERY_INTERVAL_MS = 60_000;
const INFLUX_QUERY_MAX_DATA_POINTS = 1000;
const MAX_INFLUX_ROWS = 100;

type InfluxQueryLanguage = 'flux' | 'influxql' | 'sql';

type InfluxDatasourceJsonData = DataSourceJsonData & {
  version?: string;
};

type InfluxDatasourceSettings = DataSourceInstanceSettings<InfluxDatasourceJsonData>;

type InfluxFieldSummary = {
  name: string;
  type: string;
  labels?: Record<string, string>;
};

type InfluxFrameSummary = {
  name?: string;
  rowCount: number;
  truncated: boolean;
  fields: InfluxFieldSummary[];
  rows: Array<Record<string, unknown>>;
};

type InfluxQuerySummary = {
  datasourceUid: string;
  language: InfluxQueryLanguage;
  query: string;
  format: string;
  range: {
    from: string;
    to: string;
    raw: TimeRange['raw'];
  };
  frameCount: number;
  rowCount: number;
  truncated: boolean;
  notices: QueryNotice[];
  executedQueryStrings: string[];
  frames: InfluxFrameSummary[];
};

type QueryNotice = {
  severity?: string;
  text?: string;
};

export function createInfluxTools(toolConfig: GrafanaToolConfig): AgentTool[] {
  return [makeListInfluxDatasourcesTool(toolConfig), makeQueryInfluxTool(toolConfig)];
}

export function filterAllowedInfluxDatasourceSettings(
  datasources: DataSourceInstanceSettings[],
  allowedInfluxDatasourceUids?: string[]
) {
  const allowedUids = new Set((allowedInfluxDatasourceUids ?? []).filter(Boolean));

  return datasources.filter(
    (ds) => ds.type === INFLUX_DATASOURCE_TYPE && (allowedUids.size === 0 || allowedUids.has(ds.uid))
  ) as InfluxDatasourceSettings[];
}

function makeListInfluxDatasourcesTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'list_influx_datasources',
    label: 'Get InfluxDB datasources',
    description: 'List InfluxDB datasources available to the assistant and current Grafana user.',
    parameters: Type.Object({}),
    async execute() {
      const datasources = getInfluxDatasourceSettings(toolConfig).map((ds) => ({
        name: ds.name,
        uid: ds.uid,
        type: ds.type,
        version: ds.jsonData?.version,
        isDefault: ds.isDefault,
      }));

      return textResult(JSON.stringify(datasources, null, 2), { datasources });
    },
  };
}

function makeQueryInfluxTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'query_influx',
    label: 'Query InfluxDB',
    description:
      'Run one read-only Flux, InfluxQL, or InfluxDB SQL query through Grafana as the current user. Results are compact summaries, not raw data frames.',
    parameters: Type.Object({
      datasourceUid: Type.Optional(
        Type.String({
          description: 'InfluxDB datasource UID. Defaults to the first available InfluxDB datasource.',
        })
      ),
      query: Type.String({ description: 'Read-only Flux, InfluxQL, or InfluxDB SQL query text.' }),
      language: Type.Optional(
        Type.Union([Type.Literal('flux'), Type.Literal('influxql'), Type.Literal('sql')], {
          description:
            'Optional language validation hint. The datasource configured InfluxDB version is authoritative.',
        })
      ),
      format: Type.Optional(
        Type.Union([Type.Literal('table'), Type.Literal('time_series')], {
          description:
            'Grafana result format for SQL or InfluxQL. Defaults to table for SQL and time_series for InfluxQL.',
        })
      ),
      start: Type.Optional(Type.String({ description: 'Range start for Grafana macros, such as now-1h.' })),
      end: Type.Optional(Type.String({ description: 'Range end for Grafana macros, such as now.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as QueryInfluxParams;
      throwIfAborted(signal);
      if (!args.query?.trim()) {
        throw new Error('query_influx requires query.');
      }

      const selected = getInfluxDatasourceSetting(toolConfig, args.datasourceUid);
      const language = resolveInfluxLanguage(selected, args.language);
      ensureReadOnlyInfluxQuery(args.query, language);

      const ds = (await getDataSourceSrv().get({
        uid: selected.uid,
        type: selected.type,
      })) as ResourceCapableDataSource;
      const timeRange = makeTimeRange(args.start ?? 'now-1h', args.end ?? 'now');
      const response = await runInfluxQuery(ds, language, args, timeRange);
      const summary = summarizeInfluxQuery({
        datasourceUid: selected.uid,
        language,
        query: args.query,
        format: formatForInfluxLanguage(language, args.format),
        timeRange,
        frames: response.data ?? [],
      });

      return textResult(truncateText(JSON.stringify(summary, null, 2), 40000), {
        datasourceUid: selected.uid,
        language,
        query: args.query,
        format: summary.format,
        frames: summary.frameCount,
        rows: summary.rowCount,
        truncated: summary.truncated,
        summarized: true,
      });
    },
  };
}

function getInfluxDatasourceSettings(toolConfig: GrafanaToolConfig) {
  return filterAllowedInfluxDatasourceSettings(
    getDataSourceSrv().getList({ metrics: true }),
    toolConfig.allowedInfluxDatasourceUids
  );
}

function getInfluxDatasourceSetting(toolConfig: GrafanaToolConfig, uid?: string) {
  const available = getInfluxDatasourceSettings(toolConfig);
  const selected = uid ? available.find((ds) => ds.uid === uid) : available[0];

  if (!selected) {
    throw new Error(
      uid
        ? `InfluxDB datasource is not available to the assistant: ${uid}`
        : 'No InfluxDB datasource is available to the assistant'
    );
  }

  return selected;
}

async function runInfluxQuery(
  ds: ResourceCapableDataSource,
  language: InfluxQueryLanguage,
  args: QueryInfluxParams,
  timeRange: TimeRange
): Promise<DataQueryResponse> {
  const target = makeInfluxTarget(ds, language, args);
  const request: DataQueryRequest = {
    app: CoreApp.Unknown,
    requestId: `influx-query-${Date.now()}`,
    interval: INFLUX_QUERY_INTERVAL,
    intervalMs: INFLUX_QUERY_INTERVAL_MS,
    maxDataPoints: INFLUX_QUERY_MAX_DATA_POINTS,
    range: timeRange,
    rangeRaw: timeRange.raw,
    scopedVars: {},
    targets: [target],
    timezone: config.bootData.user.timezone || 'browser',
    startTime: Date.now(),
  };

  const response = await resolveQueryResponse(ds.query(request));
  if (response.state === LoadingState.Error) {
    throw new Error(response.errors?.[0]?.message || 'InfluxDB query failed');
  }

  return response;
}

function makeInfluxTarget(ds: ResourceCapableDataSource, language: InfluxQueryLanguage, args: QueryInfluxParams) {
  const baseTarget = {
    refId: 'A',
    datasource: { uid: ds.uid, type: ds.type },
    editorMode: 'code',
  };

  if (language === 'sql') {
    return {
      ...baseTarget,
      rawSql: args.query,
      format: formatForInfluxLanguage(language, args.format),
    } as DataQueryRequest['targets'][number];
  }

  if (language === 'flux') {
    return {
      ...baseTarget,
      query: args.query,
      rawQuery: true,
    } as DataQueryRequest['targets'][number];
  }

  return {
    ...baseTarget,
    query: args.query,
    rawQuery: true,
    resultFormat: formatForInfluxLanguage(language, args.format),
  } as DataQueryRequest['targets'][number];
}

function resolveInfluxLanguage(settings: InfluxDatasourceSettings, languageHint?: string): InfluxQueryLanguage {
  const configured = normalizeInfluxLanguage(settings.jsonData?.version);
  const hinted = normalizeInfluxLanguage(languageHint);

  if (configured && hinted && configured !== hinted) {
    throw new Error(
      `query_influx language ${hinted} does not match datasource ${settings.uid} configured version ${configured}.`
    );
  }

  return configured ?? hinted ?? 'influxql';
}

function normalizeInfluxLanguage(value: unknown): InfluxQueryLanguage | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case 'flux':
      return 'flux';
    case 'influxql':
      return 'influxql';
    case 'sql':
      return 'sql';
    default:
      return undefined;
  }
}

function formatForInfluxLanguage(language: InfluxQueryLanguage, format?: QueryInfluxParams['format']) {
  if (language === 'sql') {
    return format ?? 'table';
  }
  if (language === 'influxql') {
    return format ?? 'time_series';
  }
  return 'native';
}

function ensureReadOnlyInfluxQuery(query: string, language: InfluxQueryLanguage) {
  const statements = query
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  if (statements.length > 1) {
    throw new Error('query_influx accepts one read-only statement.');
  }

  const firstStatement = stripLeadingComments(statements[0] ?? query).trim();
  if (!firstStatement) {
    throw new Error('query_influx requires query.');
  }

  if (language === 'sql') {
    if (!/^(select|with|show|explain|describe|values)\b/i.test(firstStatement)) {
      throw new Error('query_influx only accepts read-only InfluxDB SQL queries.');
    }
    if (/\b(insert|update|delete|drop|create|alter|grant|revoke|truncate|copy)\b/i.test(firstStatement)) {
      throw new Error('query_influx rejects SQL write or schema statements.');
    }
    return;
  }

  if (language === 'influxql') {
    if (!/^(select|show|explain)\b/i.test(firstStatement)) {
      throw new Error('query_influx only accepts read-only InfluxQL queries.');
    }
    if (/\binto\b/i.test(firstStatement) || /\b(delete|drop|create|alter|grant|revoke)\b/i.test(firstStatement)) {
      throw new Error('query_influx rejects InfluxQL write or schema statements.');
    }
    return;
  }

  if (/\b(?:experimental\.)?to\s*\(/i.test(firstStatement) || /\bhttp\.post\s*\(/i.test(firstStatement)) {
    throw new Error('query_influx rejects Flux queries with write or outbound side effects.');
  }
}

function stripLeadingComments(value: string) {
  return value.replace(/^\s*(?:(?:--|\/\/)[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, '');
}

function summarizeInfluxQuery(options: {
  datasourceUid: string;
  language: InfluxQueryLanguage;
  query: string;
  format: string;
  timeRange: TimeRange;
  frames: DataFrame[];
}): InfluxQuerySummary {
  let remainingRows = MAX_INFLUX_ROWS;
  let totalRows = 0;
  const frameSummaries = options.frames.map((frame) => {
    const rowCount = frameRowCount(frame);
    totalRows += rowCount;
    const rows = rowsFromFrame(frame, Math.max(0, remainingRows));
    remainingRows -= rows.length;

    return {
      name: frame.name,
      rowCount,
      truncated: rows.length < rowCount,
      fields: frame.fields.map((field) => ({
        name: field.name,
        type: String(field.type),
        ...(field.labels ? { labels: field.labels } : {}),
      })),
      rows,
    };
  });

  return {
    datasourceUid: options.datasourceUid,
    language: options.language,
    query: options.query,
    format: options.format,
    range: {
      from: options.timeRange.from.toISOString(),
      to: options.timeRange.to.toISOString(),
      raw: options.timeRange.raw,
    },
    frameCount: options.frames.length,
    rowCount: totalRows,
    truncated: totalRows > MAX_INFLUX_ROWS,
    notices: collectNotices(options.frames),
    executedQueryStrings: collectExecutedQueryStrings(options.frames),
    frames: frameSummaries,
  };
}

function rowsFromFrame(frame: DataFrame, limit: number): Array<Record<string, unknown>> {
  const rowCount = Math.min(frameRowCount(frame), limit);
  const rows: Array<Record<string, unknown>> = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row: Record<string, unknown> = {};
    for (const field of frame.fields) {
      row[field.name] = jsonValue(valueAt(field, rowIndex), field.type);
    }
    rows.push(row);
  }

  return rows;
}

function frameRowCount(frame: DataFrame) {
  if (typeof frame.length === 'number' && Number.isFinite(frame.length)) {
    return frame.length;
  }
  return Math.max(0, ...frame.fields.map((field) => getFieldLength(field, 0)));
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

function jsonValue(value: unknown, fieldType?: Field['type']): unknown {
  if (value === undefined) {
    return null;
  }
  if (fieldType === 'time' && typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return value;
  }
  return String(value);
}

function collectNotices(frames: DataFrame[]): QueryNotice[] {
  return frames.flatMap((frame) =>
    (frame.meta?.notices ?? []).map((notice) => ({
      severity: notice.severity,
      text: notice.text,
    }))
  );
}

function collectExecutedQueryStrings(frames: DataFrame[]): string[] {
  return frames
    .map((frame) => frame.meta?.executedQueryString)
    .filter((value): value is string => typeof value === 'string' && Boolean(value));
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

async function resolveQueryResponse(
  result: Promise<DataQueryResponse> | Observable<DataQueryResponse>
): Promise<DataQueryResponse> {
  if (isObservable(result)) {
    return lastValueFrom(result as Observable<DataQueryResponse>);
  }
  return result as Promise<DataQueryResponse>;
}
