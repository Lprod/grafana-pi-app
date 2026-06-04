import type { AgentTool } from '@earendil-works/pi-agent-core';
import { getDefaultTimeRange, type DataSourceApi, type MetricFindValue, type ScopedVars } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { Type } from 'typebox';
import { backendFetch } from './client';
import { textResult, throwIfAborted, truncateText } from './result';
import type { DashboardUidParams, GrafanaToolConfig } from './types';

const MAX_VARIABLE_VALUES = 20;
const MAX_VARIABLES = 30;
const MAX_PANELS = 20;
const MAX_QUERIES_PER_PANEL = 8;
const MAX_LINKS_PER_PANEL = 4;
const MAX_MARKDOWN_LENGTH = 12000;

type DashboardResponse = {
  dashboard?: Record<string, any>;
  meta?: Record<string, any>;
};

export type DashboardBootstrapDigest = {
  uid: string;
  title: string;
  folderTitle?: string;
  url?: string;
  markdown: string;
  panelCount: number;
  variableCount: number;
  queryCount: number;
  truncated: boolean;
  warnings: string[];
};

type DashboardVariableSummary = {
  name: string;
  label?: string;
  type: string;
  datasource?: string;
  query?: string;
  current?: string;
  values: string[];
  totalValues?: number;
  warning?: string;
};

type PanelSummary = {
  id?: string;
  title: string;
  type: string;
  description?: string;
  datasource?: string;
  repeat?: string;
  queries: QuerySummary[];
  transformations: string[];
  links: string[];
};

type QuerySummary = {
  refId?: string;
  datasource?: string;
  text: string;
};

export function createDashboardBootstrapTools(toolConfig: GrafanaToolConfig): AgentTool[] {
  return [makeBootstrapDashboardContextTool(toolConfig)];
}

function makeBootstrapDashboardContextTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'bootstrap_dashboard_context',
    label: 'Bootstrap dashboard context',
    description:
      'Read one existing Grafana dashboard and return compact markdown with variables, variable values, panel titles, descriptions, datasources, and queries. Use this to introduce an observability problem domain without loading raw dashboard JSON.',
    parameters: Type.Object({
      uid: Type.String({ description: 'Dashboard UID.' }),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as DashboardUidParams;
      throwIfAborted(signal);
      const digest = await buildDashboardBootstrapDigest({ uid: args.uid, toolConfig, signal });

      return textResult(digest.markdown, {
        uid: digest.uid,
        title: digest.title,
        folderTitle: digest.folderTitle,
        url: digest.url,
        panelCount: digest.panelCount,
        variableCount: digest.variableCount,
        queryCount: digest.queryCount,
        truncated: digest.truncated,
        warnings: digest.warnings,
        summarized: true,
      });
    },
  };
}

export async function buildDashboardBootstrapDigest({
  uid,
  toolConfig,
  signal,
}: {
  uid: string;
  toolConfig: GrafanaToolConfig;
  signal?: AbortSignal;
}): Promise<DashboardBootstrapDigest> {
  throwIfAborted(signal);
  const result = await backendFetch<DashboardResponse>(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
  const dashboard = result.dashboard ?? {};
  const meta = result.meta ?? {};
  const warnings: string[] = [];
  const title = stringField(dashboard, 'title') ?? stringField(meta, 'slug') ?? uid;
  const panels = collectPanels(dashboard);
  const variables = await summarizeVariables(dashboard, toolConfig, warnings, signal);
  const panelSummaries = panels.map(summarizePanel);
  const queryCount = panelSummaries.reduce((sum, panel) => sum + panel.queries.length, 0);
  const markdown = renderBootstrapMarkdown({
    dashboard,
    meta,
    uid,
    title,
    variables,
    panels: panelSummaries,
    warnings,
  });
  const truncatedMarkdown = truncateText(markdown, MAX_MARKDOWN_LENGTH);
  const truncated = truncatedMarkdown !== markdown || panels.length > MAX_PANELS || variables.length > MAX_VARIABLES;

  return {
    uid,
    title,
    folderTitle: stringField(meta, 'folderTitle'),
    url: stringField(meta, 'url'),
    markdown: truncatedMarkdown,
    panelCount: panels.length,
    variableCount: variables.length,
    queryCount,
    truncated,
    warnings,
  };
}

async function summarizeVariables(
  dashboard: Record<string, any>,
  toolConfig: GrafanaToolConfig,
  warnings: string[],
  signal?: AbortSignal
): Promise<DashboardVariableSummary[]> {
  const rawVariables = arrayField(recordField(dashboard, 'templating'), 'list').filter(isRecord);
  const scopedVars: ScopedVars = {};
  const summaries: DashboardVariableSummary[] = [];

  for (const variable of rawVariables.slice(0, MAX_VARIABLES)) {
    throwIfAborted(signal);
    const summary = await summarizeVariable(variable, scopedVars, toolConfig);
    summaries.push(summary);
    scopedVars[summary.name] = {
      text: summary.current ?? firstVariableValue(summary.values) ?? '',
      value: summary.current ?? firstVariableValue(summary.values) ?? '',
    };
    if (summary.warning) {
      warnings.push(`${summary.name}: ${summary.warning}`);
    }
  }

  if (rawVariables.length > MAX_VARIABLES) {
    warnings.push(`${rawVariables.length - MAX_VARIABLES} variables omitted`);
  }

  return summaries;
}

async function summarizeVariable(
  variable: Record<string, any>,
  scopedVars: ScopedVars,
  toolConfig: GrafanaToolConfig
): Promise<DashboardVariableSummary> {
  const name = stringField(variable, 'name') ?? 'unnamed';
  const type = stringField(variable, 'type') ?? 'unknown';
  const query = variableQueryText(variable);
  const valuesFromOptions = variableOptionValues(variable);
  const summary: DashboardVariableSummary = {
    name,
    label: stringField(variable, 'label'),
    type,
    datasource: datasourceLabel(variable.datasource),
    query,
    current: variableCurrentText(variable),
    values: valuesFromOptions.slice(0, MAX_VARIABLE_VALUES),
    totalValues: valuesFromOptions.length,
  };

  if (type !== 'query') {
    return summary;
  }

  const datasourceRef = variable.datasource;
  if (!datasourceRef) {
    summary.warning = 'query variable has no datasource reference';
    return summary;
  }

  try {
    const datasource = (await getDataSourceSrv().get(normalizeDatasourceLookup(datasourceRef))) as DataSourceApi & {
      uid?: string;
      type?: string;
    };
    const datasourceUid = datasource.uid ?? datasourceLabel(datasourceRef);
    const datasourceType = datasource.type ?? datasourceTypeFromRef(datasourceRef);

    if (isPrometheusBlocked(datasourceUid, datasourceType, toolConfig)) {
      summary.warning = `datasource ${datasourceUid} is outside the assistant allow-list`;
      return summary;
    }

    if (typeof datasource.metricFindQuery !== 'function') {
      summary.warning = `datasource ${datasourceUid} does not support variable value lookup`;
      return summary;
    }

    const found = await datasource.metricFindQuery(variable.query, {
      scopedVars,
      range: getDefaultTimeRange(),
      variable: { name },
    });
    const values = metricFindValues(found);
    summary.values = values.slice(0, MAX_VARIABLE_VALUES);
    summary.totalValues = values.length;
    summary.datasource = datasourceUid || summary.datasource;
  } catch (error) {
    summary.warning = error instanceof Error ? error.message : String(error);
  }

  return summary;
}

function renderBootstrapMarkdown({
  dashboard,
  meta,
  uid,
  title,
  variables,
  panels,
  warnings,
}: {
  dashboard: Record<string, any>;
  meta: Record<string, any>;
  uid: string;
  title: string;
  variables: DashboardVariableSummary[];
  panels: PanelSummary[];
  warnings: string[];
}) {
  const lines: string[] = [];
  const folder = stringField(meta, 'folderTitle') ?? stringField(meta, 'folderUid') ?? 'Dashboards';
  const tags = stringArrayField(dashboard, 'tags');
  const time = recordField(dashboard, 'time');
  const from = stringField(time, 'from') ?? 'default';
  const to = stringField(time, 'to') ?? 'default';
  const refresh = stringField(dashboard, 'refresh');

  lines.push(`# Dashboard bootstrap: ${title}`);
  lines.push(`uid: ${uid} | folder: ${folder} | time: ${from} -> ${to}${refresh ? ` | refresh: ${refresh}` : ''}`);
  if (tags.length > 0) {
    lines.push(`tags: ${tags.join(', ')}`);
  }

  if (variables.length > 0) {
    lines.push('');
    lines.push('## Variables');
    for (const variable of variables) {
      const label = variable.label && variable.label !== variable.name ? ` (${variable.label})` : '';
      const datasource = variable.datasource ? ` ds=${variable.datasource}` : '';
      const current = variable.current ? ` current=${inlineCode(variable.current)}` : '';
      const query = variable.query ? ` query=${inlineCode(limitInline(variable.query, 180))}` : '';
      const values = renderValues(variable.values, variable.totalValues);
      const warning = variable.warning ? ` warning=${limitInline(variable.warning, 180)}` : '';
      lines.push(`- ${variable.name}${label}: ${variable.type}${datasource}${current}${query}${values}${warning}`);
    }
  }

  lines.push('');
  lines.push('## Panels');
  for (const [index, panel] of panels.slice(0, MAX_PANELS).entries()) {
    const id = panel.id ? ` id=${panel.id}` : '';
    const datasource = panel.datasource ? ` ds=${panel.datasource}` : '';
    const repeat = panel.repeat ? ` repeat=${panel.repeat}` : '';
    lines.push(`${index + 1}. ${panel.title} [${panel.type}]${id}${datasource}${repeat}`);
    if (panel.description) {
      lines.push(`   desc: ${limitInline(panel.description, 240)}`);
    }
    for (const query of panel.queries.slice(0, MAX_QUERIES_PER_PANEL)) {
      const refId = query.refId ? `${query.refId}: ` : '';
      const queryDatasource = query.datasource && query.datasource !== panel.datasource ? ` (${query.datasource})` : '';
      lines.push(`   ${refId}${limitInline(query.text, 380)}${queryDatasource}`);
    }
    if (panel.queries.length > MAX_QUERIES_PER_PANEL) {
      lines.push(`   ... ${panel.queries.length - MAX_QUERIES_PER_PANEL} queries omitted`);
    }
    if (panel.transformations.length > 0) {
      lines.push(`   transformations: ${panel.transformations.join(', ')}`);
    }
    if (panel.links.length > 0) {
      lines.push(`   links: ${panel.links.slice(0, MAX_LINKS_PER_PANEL).join('; ')}`);
    }
  }

  if (panels.length > MAX_PANELS) {
    lines.push(`... ${panels.length - MAX_PANELS} panels omitted`);
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push(`warnings: ${warnings.slice(0, 8).join('; ')}`);
  }

  return lines.join('\n');
}

function collectPanels(dashboard: Record<string, any>) {
  const panels: Record<string, any>[] = [];
  const visit = (panel: Record<string, any>) => {
    const nested = arrayField(panel, 'panels').filter(isRecord);
    if (stringField(panel, 'type') !== 'row' || nested.length === 0) {
      panels.push(panel);
    }
    for (const child of nested) {
      visit(child);
    }
  };

  for (const panel of arrayField(dashboard, 'panels').filter(isRecord)) {
    visit(panel);
  }

  return panels;
}

function summarizePanel(panel: Record<string, any>): PanelSummary {
  const targets = arrayField(panel, 'targets').filter(isRecord);
  const queries = targets
    .map((target) => summarizeTarget(target, panel.datasource))
    .filter((query): query is QuerySummary => Boolean(query));
  const transformations = arrayField(panel, 'transformations')
    .filter(isRecord)
    .map((transformation) => stringField(transformation, 'id'))
    .filter((value): value is string => Boolean(value));
  const links = arrayField(panel, 'links')
    .filter(isRecord)
    .map((link) => [stringField(link, 'title'), stringField(link, 'url')].filter(Boolean).join(' -> '))
    .filter(Boolean);

  return {
    id: stringOrNumberField(panel, 'id'),
    title: stringField(panel, 'title') ?? '<No title>',
    type: stringField(panel, 'type') ?? 'unknown',
    description: normalizeWhitespace(stringField(panel, 'description')),
    datasource: datasourceLabel(panel.datasource),
    repeat: stringField(panel, 'repeat'),
    queries,
    transformations,
    links,
  };
}

function summarizeTarget(target: Record<string, any>, panelDatasource: unknown): QuerySummary | undefined {
  if (target.hide === true) {
    return undefined;
  }

  const text = targetQueryText(target);
  if (!text) {
    return undefined;
  }

  return {
    refId: stringField(target, 'refId'),
    datasource: datasourceLabel(target.datasource) ?? datasourceLabel(panelDatasource),
    text,
  };
}

function targetQueryText(target: Record<string, any>): string | undefined {
  for (const key of ['expr', 'query', 'rawSql', 'rawQuery', 'luceneQuery', 'target', 'expression']) {
    const value = stringField(target, key);
    if (value) {
      return normalizeWhitespace(value);
    }
  }

  const model = recordField(target, 'model');
  if (model) {
    const modelText = targetQueryText(model);
    if (modelText) {
      return modelText;
    }
  }

  return compactJson(target, 420);
}

function variableQueryText(variable: Record<string, any>) {
  const query = variable.query;
  if (typeof query === 'string') {
    return normalizeWhitespace(query);
  }
  if (query && typeof query === 'object') {
    return compactJson(query, 360);
  }
  return undefined;
}

function variableOptionValues(variable: Record<string, any>) {
  return arrayField(variable, 'options')
    .filter(isRecord)
    .map((option) => stringField(option, 'text') ?? stringOrNumberValue(option.value))
    .filter((value): value is string => Boolean(value && value !== 'All'));
}

function variableCurrentText(variable: Record<string, any>) {
  const current = recordField(variable, 'current');
  if (!current) {
    return undefined;
  }
  return stringField(current, 'text') ?? stringOrNumberValue(current.value);
}

function metricFindValues(values: MetricFindValue[] | undefined) {
  return (values ?? [])
    .map((value) => stringOrNumberValue(value.value) ?? value.text)
    .filter((value): value is string => Boolean(value));
}

function renderValues(values: string[], totalValues?: number) {
  if (values.length === 0) {
    return '';
  }
  const omitted = totalValues && totalValues > values.length ? ` +${totalValues - values.length}` : '';
  return ` values=${values.map((value) => inlineCode(limitInline(value, 80))).join(', ')}${omitted}`;
}

function isPrometheusBlocked(uid: string | undefined, type: string | undefined, toolConfig: GrafanaToolConfig) {
  const allowed = new Set((toolConfig.allowedPrometheusDatasourceUids ?? []).filter(Boolean));
  return type === 'prometheus' && allowed.size > 0 && (!uid || !allowed.has(uid));
}

function normalizeDatasourceLookup(ref: unknown) {
  if (typeof ref === 'string') {
    return ref;
  }
  if (isRecord(ref)) {
    if (typeof ref.uid === 'string' && ref.uid) {
      return { uid: ref.uid, type: typeof ref.type === 'string' ? ref.type : undefined };
    }
    if (typeof ref.name === 'string' && ref.name) {
      return ref.name;
    }
  }
  return ref as any;
}

function datasourceLabel(ref: unknown): string | undefined {
  if (typeof ref === 'string') {
    return ref;
  }
  if (!isRecord(ref)) {
    return undefined;
  }
  return stringField(ref, 'uid') ?? stringField(ref, 'name') ?? stringField(ref, 'type');
}

function datasourceTypeFromRef(ref: unknown) {
  return isRecord(ref) ? stringField(ref, 'type') : undefined;
}

function firstVariableValue(values: string[]) {
  return values.find(Boolean);
}

function inlineCode(value: string) {
  return `\`${value.replace(/`/g, "'")}\``;
}

function limitInline(value: string, limit: number) {
  const normalized = normalizeWhitespace(value) ?? '';
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function normalizeWhitespace(value: string | undefined) {
  return value?.replace(/\s+/g, ' ').trim() || undefined;
}

function compactJson(value: unknown, limit: number) {
  try {
    return limitInline(JSON.stringify(value), limit);
  } catch {
    return undefined;
  }
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

function arrayField(record: Record<string, any> | undefined, key: string) {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function recordField(record: Record<string, any> | undefined, key: string): Record<string, any> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
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
    return value.map(stringOrNumberValue).filter(Boolean).join(',');
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
