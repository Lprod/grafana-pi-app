import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  CoreApp,
  dateTime,
  getDefaultTimeRange,
  LoadingState,
  type DataFrame,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataSourceInstanceSettings,
  type Field,
  type TimeRange,
} from '@grafana/data';
import { config, getDataSourceSrv } from '@grafana/runtime';
import { isObservable, lastValueFrom, type Observable } from 'rxjs';
import { Type } from 'typebox';
import { backendFetch } from './client';
import { textResult, throwIfAborted, truncateText } from './result';
import type { GrafanaToolConfig, QueryRqliteParams, ResourceCapableDataSource, RqliteColumnsParams } from './types';

const RQLITE_DATASOURCE_TYPE = 'g42-rqlite-datasource';
const RQLITE_QUERY_INTERVAL = '1m';
const RQLITE_QUERY_INTERVAL_MS = 60_000;
const RQLITE_QUERY_MAX_DATA_POINTS = 1000;
const MAX_RQLITE_ROWS = 100;

type RqliteColumnInfo = {
  name: string;
  type: string;
};

type RqliteFrameSummary = {
  name?: string;
  rowCount: number;
  truncated: boolean;
  columns: RqliteColumnInfo[];
  rows: Array<Record<string, unknown>>;
};

type RqliteQuerySummary = {
  datasourceUid: string;
  sql: string;
  frameCount: number;
  rowCount: number;
  truncated: boolean;
  frames: RqliteFrameSummary[];
};

export function createRqliteTools(toolConfig: GrafanaToolConfig): AgentTool[] {
  return [
    makeListRqliteDatasourcesTool(toolConfig),
    makeListRqliteTablesTool(toolConfig),
    makeListRqliteColumnsTool(toolConfig),
    makeQueryRqliteTool(toolConfig),
  ];
}

export function filterAllowedRqliteDatasourceSettings(
  datasources: DataSourceInstanceSettings[],
  allowedRqliteDatasourceUids?: string[]
) {
  const allowedUids = new Set((allowedRqliteDatasourceUids ?? []).filter(Boolean));

  return datasources.filter(
    (ds) => ds.type === RQLITE_DATASOURCE_TYPE && (allowedUids.size === 0 || allowedUids.has(ds.uid))
  );
}

function makeListRqliteDatasourcesTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'list_rqlite_datasources',
    label: 'Get rqlite datasources',
    description: 'List rqlite datasources available to the assistant and current Grafana user.',
    parameters: Type.Object({}),
    async execute() {
      const datasources = getRqliteDatasourceSettings(toolConfig).map((ds) => ({
        name: ds.name,
        uid: ds.uid,
        type: ds.type,
        isDefault: ds.isDefault,
      }));

      return textResult(JSON.stringify(datasources, null, 2), { datasources });
    },
  };
}

function makeListRqliteTablesTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'list_rqlite_tables',
    label: 'List rqlite tables',
    description: 'List table names from a rqlite datasource.',
    parameters: Type.Object({
      datasourceUid: Type.Optional(
        Type.String({
          description: 'rqlite datasource UID. Defaults to the first available rqlite datasource.',
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as QueryRqliteParams;
      throwIfAborted(signal);
      const ds = await getRqliteDatasource(toolConfig, args.datasourceUid);
      const tables = await getRqliteDatasourceResource<string[]>(ds, '/tables');

      return textResult(tables.join('\n'), {
        datasourceUid: ds.uid,
        count: tables.length,
      });
    },
  };
}

function makeListRqliteColumnsTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'list_rqlite_columns',
    label: 'List rqlite columns',
    description: 'List column names and SQLite types for a rqlite table.',
    parameters: Type.Object({
      datasourceUid: Type.Optional(
        Type.String({
          description: 'rqlite datasource UID. Defaults to the first available rqlite datasource.',
        })
      ),
      table: Type.String({ description: 'Table name returned by list_rqlite_tables.' }),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as RqliteColumnsParams;
      throwIfAborted(signal);
      if (!args.table?.trim()) {
        throw new Error('list_rqlite_columns requires table.');
      }
      const ds = await getRqliteDatasource(toolConfig, args.datasourceUid);
      const columns = await getRqliteDatasourceResource<RqliteColumnInfo[]>(ds, '/columns', { table: args.table });

      return textResult(JSON.stringify(columns, null, 2), {
        datasourceUid: ds.uid,
        table: args.table,
        count: columns.length,
      });
    },
  };
}

function makeQueryRqliteTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'query_rqlite',
    label: 'Query rqlite',
    description:
      'Run one read-only SQLite SQL statement through Grafana as the current user. The datasource backend rejects writes and multi-statement SQL.',
    parameters: Type.Object({
      datasourceUid: Type.Optional(
        Type.String({
          description: 'rqlite datasource UID. Defaults to the first available rqlite datasource.',
        })
      ),
      sql: Type.String({
        description:
          'Single read-only SQL statement: SELECT, WITH ... SELECT, VALUES, EXPLAIN SELECT, or PRAGMA table_info.',
      }),
      format: Type.Optional(
        Type.Union([Type.Literal('table'), Type.Literal('time_series')], {
          description: 'Grafana result format. Defaults to table.',
        })
      ),
      timeColumns: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Column names that should be interpreted as time fields. Defaults to ["time"].',
        })
      ),
      start: Type.Optional(Type.String({ description: 'Range start for Grafana macros, such as now-1h.' })),
      end: Type.Optional(Type.String({ description: 'Range end for Grafana macros, such as now.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as QueryRqliteParams;
      throwIfAborted(signal);
      if (!args.sql?.trim()) {
        throw new Error('query_rqlite requires sql.');
      }

      const ds = await getRqliteDatasource(toolConfig, args.datasourceUid);
      const response = await runRqliteQuery(ds, args);
      const summary = summarizeRqliteQuery(ds.uid, args.sql, response.data ?? []);

      return textResult(truncateText(JSON.stringify(summary, null, 2), 40000), {
        datasourceUid: ds.uid,
        sql: args.sql,
        frames: summary.frameCount,
        rows: summary.rowCount,
        truncated: summary.truncated,
        summarized: true,
      });
    },
  };
}

function getRqliteDatasourceSettings(toolConfig: GrafanaToolConfig) {
  return filterAllowedRqliteDatasourceSettings(
    getDataSourceSrv().getList({ metrics: true }),
    toolConfig.allowedRqliteDatasourceUids
  );
}

async function getRqliteDatasource(toolConfig: GrafanaToolConfig, uid?: string): Promise<ResourceCapableDataSource> {
  const available = getRqliteDatasourceSettings(toolConfig);
  const selected = uid ? available.find((ds) => ds.uid === uid) : available[0];

  if (!selected) {
    throw new Error(
      uid
        ? `rqlite datasource is not available to the assistant: ${uid}`
        : 'No rqlite datasource is available to the assistant'
    );
  }

  return getDataSourceSrv().get({ uid: selected.uid, type: selected.type }) as Promise<ResourceCapableDataSource>;
}

async function getRqliteDatasourceResource<T>(
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

  const resourcePath = path.replace(/^\/+/, '');
  return backendFetch<T>(`/api/datasources/uid/${encodeURIComponent(settings.uid)}/resources/${resourcePath}`, {
    params,
  });
}

async function runRqliteQuery(ds: ResourceCapableDataSource, args: QueryRqliteParams): Promise<DataQueryResponse> {
  const timeRange =
    args.start || args.end ? makeTimeRange(args.start ?? 'now-1h', args.end ?? 'now') : getDefaultTimeRange();
  const target = {
    refId: 'A',
    datasource: { uid: ds.uid, type: ds.type },
    rawSql: args.sql,
    format: args.format ?? 'table',
    timeColumns: args.timeColumns ?? ['time'],
    editorMode: 'code',
    readOnly: true,
  } as DataQueryRequest['targets'][number];

  const request: DataQueryRequest = {
    app: CoreApp.Unknown,
    requestId: `rqlite-query-${Date.now()}`,
    interval: RQLITE_QUERY_INTERVAL,
    intervalMs: RQLITE_QUERY_INTERVAL_MS,
    maxDataPoints: RQLITE_QUERY_MAX_DATA_POINTS,
    range: timeRange,
    rangeRaw: timeRange.raw,
    scopedVars: {},
    targets: [target],
    timezone: config.bootData.user.timezone || 'browser',
    startTime: Date.now(),
  };

  const response = await resolveQueryResponse(ds.query(request));
  if (response.state === LoadingState.Error) {
    throw new Error(response.errors?.[0]?.message || 'rqlite query failed');
  }

  return response;
}

function summarizeRqliteQuery(datasourceUid: string, sql: string, frames: DataFrame[]): RqliteQuerySummary {
  let remainingRows = MAX_RQLITE_ROWS;
  let totalRows = 0;
  const frameSummaries = frames.map((frame) => {
    const rowCount = frameRowCount(frame);
    totalRows += rowCount;
    const rows = rowsFromFrame(frame, Math.max(0, remainingRows));
    remainingRows -= rows.length;

    return {
      name: frame.name,
      rowCount,
      truncated: rows.length < rowCount,
      columns: frame.fields.map((field) => ({ name: field.name, type: String(field.type) })),
      rows,
    };
  });

  return {
    datasourceUid,
    sql,
    frameCount: frames.length,
    rowCount: totalRows,
    truncated: totalRows > MAX_RQLITE_ROWS,
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
