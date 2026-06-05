import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { backendFetch } from './client';
import {
  compactBatchPrometheusSummary,
  getPrometheusDatasource,
  runPrometheusQuerySummaryOrValidationError,
  type PrometheusQueryValidationSummary,
} from './metrics';
import { textResult, throwIfAborted, truncateText } from './result';
import type { DashboardUidParams, GrafanaToolConfig, ResourceCapableDataSource } from './types';

const MAX_CONTEXT_PANELS = 40;
const MAX_CONTEXT_QUERIES = 80;
const MAX_VALIDATION_QUERIES = 12;
const MAX_CONTEXT_LENGTH = 120000;

type DashboardContextParams = DashboardUidParams & {
  validateQueries?: boolean;
  maxPanels?: number;
  maxValidationQueries?: number;
  from?: string;
  to?: string;
};

type DashboardResponse = {
  dashboard?: Record<string, any>;
  meta?: Record<string, any>;
};

type DashboardVariableContext = {
  name: string;
  type: string;
  label?: string;
  datasourceUid?: string;
  query?: string;
  current?: string;
  values?: string[];
};

type DashboardTargetContext = {
  refId?: string;
  datasourceUid?: string;
  datasourceType?: string;
  hidden?: boolean;
  queryKind?: string;
  query?: string;
  validationQuery?: string;
  legendFormat?: string;
};

type DashboardPanelContext = {
  id?: string;
  title: string;
  type: string;
  rowPath?: string[];
  description?: string;
  datasourceUid?: string;
  datasourceType?: string;
  repeat?: string;
  gridPos?: Record<string, unknown>;
  targets: DashboardTargetContext[];
  transformations?: string[];
  fieldConfig?: Record<string, unknown>;
  options?: Record<string, unknown>;
  links?: string[];
};

type DashboardQueryValidation = {
  panelId?: string;
  panelTitle: string;
  refId?: string;
  datasourceUid?: string;
  query: string;
  validationQuery: string;
  totalSeries: number;
  frameCount: number;
  validationError?: string;
  notices?: unknown[];
  series?: unknown[];
};

type DashboardContextResult = {
  dashboard: {
    uid: string;
    title: string;
    folderTitle?: string;
    url?: string;
    tags?: string[];
    time: { from: string; to: string };
    refresh?: string;
  };
  variables: DashboardVariableContext[];
  panels: DashboardPanelContext[];
  validation?: {
    enabled: boolean;
    range: { from: string; to: string };
    queryCount: number;
    failedQueries: number;
    zeroSeriesQueries: number;
    truncatedQueries: boolean;
    results: DashboardQueryValidation[];
  };
  omitted?: {
    panels?: number;
  };
};

type PanelWithPath = {
  panel: Record<string, any>;
  rowPath: string[];
};

export function createDashboardContextTools(toolConfig: GrafanaToolConfig): AgentTool[] {
  return [makeInspectDashboardContextTool(toolConfig)];
}

function makeInspectDashboardContextTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'inspect_dashboard_context',
    label: 'Inspect dashboard context',
    description:
      'Read one existing Grafana dashboard as typed compact context, including variables, layout, panel config, targets, and current-variable-substituted PromQL validation summaries.',
    parameters: Type.Object({
      uid: Type.String({ description: 'Dashboard UID.' }),
      validateQueries: Type.Optional(
        Type.Boolean({ description: 'Validate Prometheus panel queries. Defaults to true.' })
      ),
      maxPanels: Type.Optional(
        Type.Number({ description: `Maximum panels to include. Defaults to ${MAX_CONTEXT_PANELS}.` })
      ),
      maxValidationQueries: Type.Optional(
        Type.Number({
          description: `Maximum panel queries to validate. Defaults to ${MAX_VALIDATION_QUERIES}.`,
        })
      ),
      from: Type.Optional(Type.String({ description: 'Validation range start. Defaults to dashboard time.from.' })),
      to: Type.Optional(Type.String({ description: 'Validation range end. Defaults to dashboard time.to.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as DashboardContextParams;
      throwIfAborted(signal);
      const context = await buildDashboardContext({ params: args, toolConfig, signal });
      const text = truncateText(JSON.stringify(context, null, 2), MAX_CONTEXT_LENGTH);

      return textResult(text, {
        uid: context.dashboard.uid,
        title: context.dashboard.title,
        folderTitle: context.dashboard.folderTitle,
        url: context.dashboard.url,
        panelCount: context.panels.length,
        variableCount: context.variables.length,
        queryCount: context.panels.reduce((sum, panel) => sum + panel.targets.length, 0),
        validation: context.validation
          ? {
              queryCount: context.validation.queryCount,
              failedQueries: context.validation.failedQueries,
              zeroSeriesQueries: context.validation.zeroSeriesQueries,
              truncatedQueries: context.validation.truncatedQueries,
            }
          : undefined,
        omitted: context.omitted,
        summarized: true,
      });
    },
  };
}

async function buildDashboardContext({
  params,
  toolConfig,
  signal,
}: {
  params: DashboardContextParams;
  toolConfig: GrafanaToolConfig;
  signal?: AbortSignal;
}): Promise<DashboardContextResult> {
  const result = await backendFetch<DashboardResponse>(`/api/dashboards/uid/${encodeURIComponent(params.uid)}`);
  const dashboard = result.dashboard ?? {};
  const meta = result.meta ?? {};
  const title = stringField(dashboard, 'title') ?? stringField(meta, 'slug') ?? params.uid;
  const variables = summarizeVariables(dashboard);
  const variableValues = variableValueMap(variables);
  const rawPanels = collectPanels(dashboard);
  const maxPanels = clampInt(params.maxPanels ?? MAX_CONTEXT_PANELS, 1, MAX_CONTEXT_PANELS);
  const panels = rawPanels
    .slice(0, maxPanels)
    .map(({ panel, rowPath }) => summarizePanel(panel, rowPath, variableValues));
  const range = dashboardRange(dashboard, params);
  const context: DashboardContextResult = {
    dashboard: {
      uid: params.uid,
      title,
      folderTitle: stringField(meta, 'folderTitle'),
      url: stringField(meta, 'url'),
      tags: stringArrayField(dashboard, 'tags'),
      time: range,
      refresh: stringField(dashboard, 'refresh'),
    },
    variables,
    panels,
    omitted: rawPanels.length > panels.length ? { panels: rawPanels.length - panels.length } : undefined,
  };

  if (params.validateQueries !== false) {
    context.validation = await validateDashboardQueries({
      panels,
      range,
      maxQueries: clampInt(params.maxValidationQueries ?? MAX_VALIDATION_QUERIES, 1, MAX_VALIDATION_QUERIES),
      toolConfig,
      signal,
    });
  }

  return context;
}

function summarizeVariables(dashboard: Record<string, any>): DashboardVariableContext[] {
  return arrayField(recordField(dashboard, 'templating'), 'list')
    .filter(isRecord)
    .map((variable) => {
      const values = variableValues(variable);
      return compactRecord({
        name: stringField(variable, 'name') ?? 'unnamed',
        type: stringField(variable, 'type') ?? 'unknown',
        label: stringField(variable, 'label'),
        datasourceUid: datasourceUid(variable.datasource),
        query: variableQueryText(variable),
        current: variableCurrentText(variable) ?? values[0],
        values: values.length > 0 ? values.slice(0, 20) : undefined,
      }) as DashboardVariableContext;
    });
}

function collectPanels(dashboard: Record<string, any>) {
  const panels: PanelWithPath[] = [];
  const visit = (panel: Record<string, any>, rowPath: string[]) => {
    const nested = arrayField(panel, 'panels').filter(isRecord);
    const type = stringField(panel, 'type');
    const title = stringField(panel, 'title');
    const childRowPath = type === 'row' && title ? [...rowPath, title] : rowPath;

    if (type !== 'row' || nested.length === 0) {
      panels.push({ panel, rowPath });
    }

    for (const child of nested) {
      visit(child, childRowPath);
    }
  };

  for (const panel of arrayField(dashboard, 'panels').filter(isRecord)) {
    visit(panel, []);
  }

  return panels;
}

function summarizePanel(
  panel: Record<string, any>,
  rowPath: string[],
  variableValues: Record<string, string>
): DashboardPanelContext {
  const panelDatasourceUid = datasourceUid(panel.datasource);
  const panelDatasourceType = datasourceType(panel.datasource);
  const targets = arrayField(panel, 'targets')
    .filter(isRecord)
    .slice(0, MAX_CONTEXT_QUERIES)
    .map((target) => summarizeTarget(target, panelDatasourceUid, panelDatasourceType, variableValues));
  const transformations = arrayField(panel, 'transformations')
    .filter(isRecord)
    .map((transformation) => stringField(transformation, 'id'))
    .filter((value): value is string => Boolean(value));
  const links = arrayField(panel, 'links')
    .filter(isRecord)
    .map((link) => [stringField(link, 'title'), stringField(link, 'url')].filter(Boolean).join(' -> '))
    .filter(Boolean);

  return compactRecord({
    id: stringOrNumberField(panel, 'id'),
    title: stringField(panel, 'title') ?? '<No title>',
    type: stringField(panel, 'type') ?? 'unknown',
    rowPath: rowPath.length > 0 ? rowPath : undefined,
    description: normalizeWhitespace(stringField(panel, 'description')),
    datasourceUid: panelDatasourceUid,
    datasourceType: panelDatasourceType,
    repeat: stringField(panel, 'repeat'),
    gridPos: compactRecord(recordField(panel, 'gridPos')),
    targets,
    transformations: transformations.length > 0 ? transformations : undefined,
    fieldConfig: compactFieldConfig(recordField(panel, 'fieldConfig')),
    options: compactPanelOptions(recordField(panel, 'options')),
    links: links.length > 0 ? links.slice(0, 8) : undefined,
  }) as DashboardPanelContext;
}

function summarizeTarget(
  target: Record<string, any>,
  panelDatasourceUid: string | undefined,
  panelDatasourceType: string | undefined,
  variableValues: Record<string, string>
): DashboardTargetContext {
  const datasource = target.datasource;
  const uid = datasourceUid(datasource) ?? panelDatasourceUid;
  const type = datasourceType(datasource) ?? panelDatasourceType;
  const query = targetQueryText(target);
  const queryKind = targetQueryKind(target);

  return compactRecord({
    refId: stringField(target, 'refId'),
    datasourceUid: uid,
    datasourceType: type,
    hidden: target.hide === true ? true : undefined,
    queryKind,
    query,
    validationQuery: query && queryKind === 'expr' ? interpolateDashboardQuery(query, variableValues) : undefined,
    legendFormat: stringField(target, 'legendFormat'),
  }) as DashboardTargetContext;
}

async function validateDashboardQueries({
  panels,
  range,
  maxQueries,
  toolConfig,
  signal,
}: {
  panels: DashboardPanelContext[];
  range: { from: string; to: string };
  maxQueries: number;
  toolConfig: GrafanaToolConfig;
  signal?: AbortSignal;
}): Promise<DashboardContextResult['validation']> {
  const candidates = panels.flatMap((panel) =>
    panel.targets
      .filter((target) => isPrometheusTarget(target) && !target.hidden && target.validationQuery)
      .map((target) => ({ panel, target }))
  );
  const limited = candidates.slice(0, maxQueries);
  const datasourceCache = new Map<string, Promise<ResourceCapableDataSource>>();
  const results: DashboardQueryValidation[] = [];

  for (const { panel, target } of limited) {
    throwIfAborted(signal);
    const validationQuery = target.validationQuery!;
    let summary: PrometheusQueryValidationSummary;
    try {
      const datasourceUid = target.datasourceUid;
      const datasource = datasourceUid
        ? await getCachedDatasource(datasourceCache, toolConfig, datasourceUid)
        : await getPrometheusDatasource(toolConfig);
      summary = compactBatchPrometheusSummary(
        await runPrometheusQuerySummaryOrValidationError(
          datasource,
          { query: validationQuery, type: 'range', start: range.from, end: range.to },
          signal
        )
      );
    } catch (error) {
      summary = failedDashboardQuerySummary(target, validationQuery, range, error);
    }

    results.push({
      panelId: panel.id,
      panelTitle: panel.title,
      refId: target.refId,
      datasourceUid: target.datasourceUid,
      query: target.query ?? validationQuery,
      validationQuery,
      totalSeries: summary.totalSeries,
      frameCount: summary.frameCount,
      validationError: summary.validationError,
      notices: summary.notices,
      series: summary.series,
    });
  }

  return {
    enabled: true,
    range,
    queryCount: candidates.length,
    failedQueries: results.filter((result) => result.validationError).length,
    zeroSeriesQueries: results.filter((result) => !result.validationError && result.totalSeries === 0).length,
    truncatedQueries: candidates.length > limited.length,
    results,
  };
}

function getCachedDatasource(
  cache: Map<string, Promise<ResourceCapableDataSource>>,
  toolConfig: GrafanaToolConfig,
  uid: string
) {
  if (!cache.has(uid)) {
    cache.set(uid, getPrometheusDatasource(toolConfig, uid));
  }
  return cache.get(uid)!;
}

function failedDashboardQuerySummary(
  target: DashboardTargetContext,
  query: string,
  range: { from: string; to: string },
  error: unknown
): PrometheusQueryValidationSummary {
  const message = error instanceof Error ? error.message : String(error);
  return {
    datasourceUid: target.datasourceUid ?? 'unknown',
    query,
    queryType: 'range',
    interval: 'unknown',
    range: {
      from: range.from,
      to: range.to,
      raw: range,
    },
    frameCount: 0,
    totalSeries: 0,
    truncatedSeries: false,
    notices: [{ severity: 'error', text: message }],
    executedQueryStrings: [],
    series: [],
    validationError: message,
  };
}

function dashboardRange(dashboard: Record<string, any>, params: DashboardContextParams) {
  const time = recordField(dashboard, 'time');
  return {
    from: params.from ?? stringField(time, 'from') ?? 'now-6h',
    to: params.to ?? stringField(time, 'to') ?? 'now',
  };
}

function isPrometheusTarget(target: DashboardTargetContext) {
  return target.queryKind === 'expr' && (!target.datasourceType || target.datasourceType === 'prometheus');
}

function compactFieldConfig(fieldConfig: Record<string, any> | undefined) {
  const defaults = recordField(fieldConfig, 'defaults');
  const custom = recordField(defaults, 'custom');
  const compact = compactRecord({
    displayName: stringField(defaults, 'displayName'),
    unit: stringField(defaults, 'unit'),
    decimals: numberField(defaults, 'decimals'),
    min: numberField(defaults, 'min'),
    max: numberField(defaults, 'max'),
    thresholds: compactThresholds(recordField(defaults, 'thresholds')),
    mappings: arrayField(defaults, 'mappings').slice(0, 5),
    custom: compactRecord({
      drawStyle: stringField(custom, 'drawStyle'),
      lineWidth: numberField(custom, 'lineWidth'),
      fillOpacity: numberField(custom, 'fillOpacity'),
      axisPlacement: stringField(custom, 'axisPlacement'),
      axisLabel: stringField(custom, 'axisLabel'),
      scaleDistribution: recordField(custom, 'scaleDistribution'),
      stacking: recordField(custom, 'stacking'),
    }),
    overrides: arrayField(fieldConfig, 'overrides').slice(0, 5),
  });

  return Object.keys(compact).length > 0 ? compact : undefined;
}

function compactPanelOptions(options: Record<string, any> | undefined) {
  return compactRecord({
    legend: recordField(options, 'legend'),
    tooltip: recordField(options, 'tooltip'),
    reduceOptions: recordField(options, 'reduceOptions'),
    orientation: stringField(options, 'orientation'),
    showHeader: options?.showHeader,
    cellHeight: stringField(options, 'cellHeight'),
    footer: recordField(options, 'footer'),
    sortBy: arrayField(options, 'sortBy'),
  });
}

function compactThresholds(thresholds: Record<string, any> | undefined) {
  const steps = arrayField(thresholds, 'steps');
  return steps.length > 0 ? { mode: stringField(thresholds, 'mode'), steps: steps.slice(0, 8) } : undefined;
}

function targetQueryText(target: Record<string, any>): string | undefined {
  for (const key of ['expr', 'query', 'rawSql', 'rawQuery', 'luceneQuery', 'target', 'expression']) {
    const value = stringField(target, key);
    if (value) {
      return normalizeWhitespace(value);
    }
  }

  const model = recordField(target, 'model');
  return model ? targetQueryText(model) : undefined;
}

function targetQueryKind(target: Record<string, any>) {
  for (const key of ['expr', 'query', 'rawSql', 'rawQuery', 'luceneQuery', 'target', 'expression']) {
    if (stringField(target, key)) {
      return key;
    }
  }
  return undefined;
}

function interpolateDashboardQuery(query: string, variableValues: Record<string, string>) {
  let result = query
    .replace(/\$__rate_interval/g, '5m')
    .replace(/\$__interval/g, '1m')
    .replace(/\$__range/g, '6h');

  for (const [name, value] of Object.entries(variableValues)) {
    const replacement = value === 'All' ? '.*' : value;
    result = result
      .replace(new RegExp(`\\$${escapeRegExp(name)}\\b`, 'g'), replacement)
      .replace(new RegExp(`\\$\\{${escapeRegExp(name)}(?::[^}]*)?\\}`, 'g'), replacement);
  }

  return result;
}

function variableValueMap(variables: DashboardVariableContext[]) {
  return Object.fromEntries(
    variables
      .filter((variable) => variable.name)
      .map((variable) => [variable.name, variable.current ?? variable.values?.[0] ?? ''])
      .filter(([, value]) => value)
  );
}

function variableQueryText(variable: Record<string, any>) {
  const query = variable.query;
  if (typeof query === 'string') {
    return normalizeWhitespace(query);
  }
  return isRecord(query) ? JSON.stringify(query) : undefined;
}

function variableValues(variable: Record<string, any>) {
  const optionValues = arrayField(variable, 'options')
    .filter(isRecord)
    .map((option) => stringField(option, 'text') ?? stringOrNumberValue(option.value))
    .filter((value): value is string => Boolean(value));
  if (optionValues.length > 0) {
    return optionValues;
  }
  if (stringField(variable, 'type') === 'custom' && typeof variable.query === 'string') {
    return variable.query
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function variableCurrentText(variable: Record<string, any>) {
  const current = recordField(variable, 'current');
  return current ? (stringField(current, 'text') ?? stringOrNumberValue(current.value)) : undefined;
}

function datasourceUid(ref: unknown): string | undefined {
  if (typeof ref === 'string') {
    return ref;
  }
  return isRecord(ref) ? (stringField(ref, 'uid') ?? stringField(ref, 'name')) : undefined;
}

function datasourceType(ref: unknown): string | undefined {
  return isRecord(ref) ? stringField(ref, 'type') : undefined;
}

function compactRecord<T extends Record<string, unknown> | undefined>(record: T): Record<string, unknown> {
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value === undefined || value === null || value === '') {
        return false;
      }
      if (Array.isArray(value) && value.length === 0) {
        return false;
      }
      if (isRecord(value) && Object.keys(value).length === 0) {
        return false;
      }
      return true;
    })
  );
}

function normalizeWhitespace(value: string | undefined) {
  return value?.replace(/\s+/g, ' ').trim() || undefined;
}

function stringField(record: Record<string, any> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayField(record: Record<string, any> | undefined, key: string) {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function numberField(record: Record<string, any> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrNumberField(record: Record<string, any> | undefined, key: string) {
  return stringOrNumberValue(record?.[key]);
}

function stringOrNumberValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(stringOrNumberValue).filter(Boolean).join('|');
  }
  return undefined;
}

function arrayField(record: Record<string, any> | undefined, key: string) {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function recordField(record: Record<string, any> | undefined, key: string): Record<string, any> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
