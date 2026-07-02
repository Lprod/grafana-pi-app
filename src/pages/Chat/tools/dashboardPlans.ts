import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { pluginResourceFetch } from './client';
import { DEFAULT_JSONNET_FILE_PATH, normalizeJsonnetPath } from './jsonnetFiles';
import { textResult, throwIfAborted } from './result';
import type {
  CreateGrafanaToolsOptions,
  DashboardPlanToolSet,
  VirtualJsonnetFileRuntime,
  VirtualJsonnetFileSnapshot,
} from './types';

type DashboardPlanPanelType = 'stat' | 'timeseries' | 'table';
type DashboardPlanQueryType = 'instant' | 'range';

type DashboardPlanParams = {
  path?: string;
  dashboard?: unknown;
  queryEvidence?: unknown;
  panels?: unknown;
};

type DashboardPlan = {
  dashboard: {
    title: string;
    uid: string;
    datasourceUid: string;
    timeRange: {
      from: string;
      to: string;
    };
    tags: string[];
  };
  queryEvidence: DashboardPlanEvidence[];
  panels: DashboardPlanPanel[];
};

type DashboardPlanEvidence = {
  id: string;
  datasourceUid: string;
  expr: string;
  queryType: DashboardPlanQueryType;
  totalSeries: number;
  validationError: string | null;
  labels: string[];
};

type DashboardPlanPanel = {
  title: string;
  type: DashboardPlanPanelType;
  queryEvidenceId: string;
  targets: DashboardPlanPanelTarget[];
  unit: string | null;
  decimals: number | null;
  layout: string | null;
  row: string | null;
  legend: string | null;
  columns: string[] | null;
  rename: Record<string, string>;
};

type DashboardPlanPanelTarget = {
  queryEvidenceId: string;
  legend: string | null;
};

type JsonnetFileBackendResponse = VirtualJsonnetFileSnapshot & {
  dashboard_jsonnet?: string;
};

const SUPPORTED_PANEL_TYPES = new Set<DashboardPlanPanelType>(['stat', 'timeseries', 'table']);
const SUPPORTED_QUERY_TYPES = new Set<DashboardPlanQueryType>(['instant', 'range']);

export function createDashboardPlanTools(options: CreateGrafanaToolsOptions): DashboardPlanToolSet {
  const write = makeWriteDashboardPlanTool(options.virtualJsonnetFiles);
  return {
    all: [write],
    write,
  };
}

function makeWriteDashboardPlanTool(runtime: VirtualJsonnetFileRuntime | undefined): AgentTool {
  return {
    name: 'write_dashboard_plan',
    label: 'Write dashboard plan',
    description:
      'Validate a typed dashboard plan from query_prometheus evidence, compile it to helper-compatible dashboard.jsonnet, and write the session virtual Jsonnet file. Use this for new durable dashboards when each panel can reference one or more validated query evidence entries. The tool rejects panels that reference zero-series evidence, validationError evidence, unsupported panel types, or a datasource different from the dashboard datasource. After this succeeds, call render_dashboard and then save_dashboard.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: `Virtual file path. Defaults to ${DEFAULT_JSONNET_FILE_PATH}.` })),
      dashboard: Type.Object({
        title: Type.String({ description: 'Dashboard title.' }),
        uid: Type.String({ description: 'Stable dashboard UID.' }),
        datasourceUid: Type.String({ description: 'Prometheus datasource UID used by every planned panel.' }),
        timeRange: Type.Object({
          from: Type.String({ description: 'Dashboard time range start, for example now-6h.' }),
          to: Type.String({ description: 'Dashboard time range end, for example now.' }),
        }),
        tags: Type.Optional(Type.Array(Type.String(), { description: 'Optional dashboard tags.' })),
      }),
      queryEvidence: Type.Array(
        Type.Object({
          id: Type.String({ description: 'Stable evidence ID referenced by panels.' }),
          datasourceUid: Type.String({ description: 'Datasource UID used for the validation query.' }),
          expr: Type.String({ description: 'Validated PromQL expression.' }),
          queryType: Type.Union([Type.Literal('instant'), Type.Literal('range')], {
            description: 'Validation query type used by query_prometheus.',
          }),
          totalSeries: Type.Number({ description: 'Total series returned by validation.' }),
          validationError: Type.Optional(
            Type.Union([Type.String(), Type.Null()], {
              description: 'Validation error from query_prometheus, or null when validation succeeded.',
            })
          ),
          labels: Type.Array(Type.String(), { description: 'Relevant labels observed in validation results.' }),
        }),
        { description: 'All validation evidence, including rejected candidates.' }
      ),
      panels: Type.Array(
        Type.Object({
          title: Type.String({ description: 'Panel title.' }),
          type: Type.Union([Type.Literal('stat'), Type.Literal('timeseries'), Type.Literal('table')], {
            description: 'Panel type supported by the dashboard helper compiler.',
          }),
          queryEvidenceId: Type.Optional(
            Type.String({
              description:
                'ID of successful queryEvidence used by this panel. Kept for single-target panels; use targets for multi-query panels.',
            })
          ),
          queryEvidenceIds: Type.Optional(
            Type.Array(Type.String(), {
              description: 'Optional shorthand for multiple successful queryEvidence IDs used by this panel.',
            })
          ),
          targets: Type.Optional(
            Type.Array(
              Type.Object({
                queryEvidenceId: Type.String({ description: 'ID of successful queryEvidence used by this target.' }),
                legend: Type.Optional(
                  Type.Union([Type.String(), Type.Null()], {
                    description: 'Optional Prometheus legend format for this target.',
                  })
                ),
              }),
              {
                description: 'Optional explicit panel targets. Use this for multi-query panels instead of raw Jsonnet.',
              }
            )
          ),
          unit: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Grafana unit.' })),
          decimals: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: 'Optional decimals.' })),
          layout: Type.Optional(
            Type.Union([Type.String(), Type.Null()], {
              description: 'Optional layout hint: full, twoUp, threeUp, fourUp, or statStrip.',
            })
          ),
          row: Type.Optional(
            Type.Union([Type.String(), Type.Null()], {
              description: 'Optional row title. Panels with the same row title are grouped into that row.',
            })
          ),
          legend: Type.Optional(
            Type.Union([Type.String(), Type.Null()], {
              description: 'Optional Prometheus legend format, for example {{tenant}}.',
            })
          ),
          columns: Type.Optional(
            Type.Union([Type.Array(Type.String()), Type.Null()], {
              description: 'Optional table columns. Defaults to Time, observed labels, Value.',
            })
          ),
          rename: Type.Optional(
            Type.Any({ description: 'Optional table column rename object with string keys and string values.' })
          ),
        }),
        { description: 'Panels to build from successful query evidence.' }
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as DashboardPlanParams;
      const path = normalizeJsonnetPath(args.path);
      const existing = runtime?.getFile(path);
      if (existing) {
        throw new Error(
          `${path} already exists at version ${existing.version}; use edit_jsonnet for follow-up changes.`
        );
      }

      const plan = normalizeDashboardPlan(args);
      const content = compileDashboardPlanToJsonnet(plan);
      throwIfAborted(signal);
      const result = await pluginResourceFetch<JsonnetFileBackendResponse>('/jsonnet-dashboards/jsonnet-files/write', {
        method: 'POST',
        data: {
          sessionId: requireSessionId(runtime),
          path,
          content,
        },
      });
      const snapshot = snapshotFromResponse(result, content);
      runtime?.setFile(snapshot, { hydrated: true });

      const details = {
        action: 'planned_written',
        path: snapshot.path,
        version: snapshot.version,
        checksum: snapshot.checksum,
        lineCount: snapshot.lineCount,
        dashboardJsonnetSize: snapshot.dashboardJsonnetSize,
        panelCount: plan.panels.length,
        rowCount: groupPanelsByRow(plan.panels).length,
        targetCount: plan.panels.reduce((total, panel) => total + panel.targets.length, 0),
        queryEvidenceCount: plan.queryEvidence.length,
        dashboardPlan: plan,
      };
      const summary = { ...details, dashboardPlan: undefined };
      return textResult(`DASHBOARD_PLAN_JSON: ${JSON.stringify(plan)}\n${JSON.stringify(summary, null, 2)}`, details);
    },
  };
}

function normalizeDashboardPlan(args: DashboardPlanParams): DashboardPlan {
  const dashboard = requireRecord(args.dashboard, 'dashboard');
  const timeRange = requireRecord(dashboard.timeRange, 'dashboard.timeRange');
  const title = requiredString(dashboard.title, 'dashboard.title');
  const uid = requiredString(dashboard.uid, 'dashboard.uid');
  const datasourceUid = requiredString(dashboard.datasourceUid, 'dashboard.datasourceUid');
  const from = requiredString(timeRange.from, 'dashboard.timeRange.from');
  const to = requiredString(timeRange.to, 'dashboard.timeRange.to');
  const tags = optionalStringArray(dashboard.tags, 'dashboard.tags');

  const queryEvidence = requireArray(args.queryEvidence, 'queryEvidence').map((entry, index) =>
    normalizeEvidence(entry, `queryEvidence[${index}]`)
  );
  if (queryEvidence.length === 0) {
    throw new Error('dashboard plan must include at least one queryEvidence entry.');
  }

  const evidenceById = new Map<string, DashboardPlanEvidence>();
  for (const evidence of queryEvidence) {
    if (evidenceById.has(evidence.id)) {
      throw new Error(`dashboard plan queryEvidence has duplicate id ${evidence.id}.`);
    }
    evidenceById.set(evidence.id, evidence);
  }

  const panels = requireArray(args.panels, 'panels').map((entry, index) =>
    normalizePanel(entry, `panels[${index}]`, evidenceById, datasourceUid)
  );
  if (panels.length === 0) {
    throw new Error('dashboard plan must include at least one panel.');
  }

  return {
    dashboard: {
      title,
      uid,
      datasourceUid,
      timeRange: { from, to },
      tags,
    },
    queryEvidence,
    panels,
  };
}

function normalizeEvidence(value: unknown, path: string): DashboardPlanEvidence {
  const record = requireRecord(value, path);
  const id = requiredString(record.id, `${path}.id`);
  const datasourceUid = requiredString(record.datasourceUid, `${path}.datasourceUid`);
  const expr = requiredString(record.expr, `${path}.expr`);
  const queryType = requiredString(record.queryType, `${path}.queryType`);
  if (!SUPPORTED_QUERY_TYPES.has(queryType as DashboardPlanQueryType)) {
    throw new Error(`${path}.queryType must be "instant" or "range".`);
  }

  const totalSeries = record.totalSeries;
  if (typeof totalSeries !== 'number' || !Number.isFinite(totalSeries) || totalSeries < 0) {
    throw new Error(`${path}.totalSeries must be a non-negative number.`);
  }

  const validationError = normalizeValidationError(record.validationError, `${path}.validationError`);

  return {
    id,
    datasourceUid,
    expr,
    queryType: queryType as DashboardPlanQueryType,
    totalSeries,
    validationError,
    labels: requireStringArray(record.labels, `${path}.labels`),
  };
}

function normalizePanel(
  value: unknown,
  path: string,
  evidenceById: Map<string, DashboardPlanEvidence>,
  dashboardDatasourceUid: string
): DashboardPlanPanel {
  const record = requireRecord(value, path);
  const title = requiredString(record.title, `${path}.title`);
  const type = requiredString(record.type, `${path}.type`);
  if (!SUPPORTED_PANEL_TYPES.has(type as DashboardPlanPanelType)) {
    throw new Error(`${path}.type must be one of stat, timeseries, or table.`);
  }

  const targets = normalizePanelTargets(
    record,
    path,
    evidenceById,
    dashboardDatasourceUid,
    type as DashboardPlanPanelType,
    title
  );
  for (const [index, target] of targets.entries()) {
    const evidence = evidenceById.get(target.queryEvidenceId);
    const targetPath = `${path}.targets[${index}]`;
    if (!evidence) {
      throw new Error(`${targetPath} references missing queryEvidence ${target.queryEvidenceId}.`);
    }
    if (evidence.totalSeries <= 0 || evidence.validationError !== null) {
      throw new Error(
        `${targetPath} references unusable queryEvidence ${target.queryEvidenceId}; panels require totalSeries > 0 and validationError=null.`
      );
    }
    if (evidence.datasourceUid !== dashboardDatasourceUid) {
      throw new Error(
        `${targetPath} references datasource ${evidence.datasourceUid}, but dashboard.datasourceUid is ${dashboardDatasourceUid}.`
      );
    }
  }

  const layout = optionalNullableString(record.layout, `${path}.layout`);
  const normalizedLayout = normalizeLayoutHint(layout);
  if (layout && !normalizedLayout) {
    throw new Error(`${path}.layout must be one of full, twoUp, threeUp, fourUp, or statStrip.`);
  }
  if (normalizedLayout === 'statStrip' && type !== 'stat') {
    throw new Error(`${path}.layout statStrip requires type="stat".`);
  }

  return {
    title,
    type: type as DashboardPlanPanelType,
    queryEvidenceId: targets[0].queryEvidenceId,
    targets,
    unit: optionalNullableString(record.unit, `${path}.unit`),
    decimals: optionalNullableNumber(record.decimals, `${path}.decimals`),
    layout,
    row: optionalNullableString(record.row, `${path}.row`),
    legend: optionalNullableString(record.legend, `${path}.legend`),
    columns: optionalNullableStringArray(record.columns, `${path}.columns`),
    rename: optionalStringRecord(record.rename, `${path}.rename`),
  };
}

function normalizePanelTargets(
  record: Record<string, unknown>,
  path: string,
  evidenceById: Map<string, DashboardPlanEvidence>,
  dashboardDatasourceUid: string,
  panelType: DashboardPlanPanelType,
  panelTitle: string
): DashboardPlanPanelTarget[] {
  let targets: DashboardPlanPanelTarget[];

  if (record.targets !== undefined && record.targets !== null) {
    targets = requireArray(record.targets, `${path}.targets`).map((target, index) => {
      const targetRecord = requireRecord(target, `${path}.targets[${index}]`);
      return {
        queryEvidenceId: requiredString(targetRecord.queryEvidenceId, `${path}.targets[${index}].queryEvidenceId`),
        legend: optionalNullableString(targetRecord.legend, `${path}.targets[${index}].legend`),
      };
    });
  } else if (record.queryEvidenceIds !== undefined && record.queryEvidenceIds !== null) {
    targets = requireStringArray(record.queryEvidenceIds, `${path}.queryEvidenceIds`).map((queryEvidenceId) => ({
      queryEvidenceId,
      legend: null,
    }));
  } else if (record.queryEvidenceId !== undefined && record.queryEvidenceId !== null) {
    targets = [
      {
        queryEvidenceId: requiredString(record.queryEvidenceId, `${path}.queryEvidenceId`),
        legend: null,
      },
    ];
  } else {
    const inferred = inferPanelTarget(record, evidenceById, dashboardDatasourceUid, panelType, panelTitle);
    if (!inferred) {
      throw new Error(
        `${path}.queryEvidenceId must be a non-empty string, or the panel title must unambiguously match one validated queryEvidence entry.`
      );
    }
    targets = [
      {
        queryEvidenceId: inferred,
        legend: null,
      },
    ];
  }

  if (targets.length === 0) {
    throw new Error(`${path}.targets must include at least one target.`);
  }

  const targetIds = targets.map((target) => target.queryEvidenceId);
  if (uniqueStrings(targetIds).length !== targetIds.length) {
    throw new Error(`${path}.targets must not reference the same queryEvidence ID more than once.`);
  }

  return targets;
}

function inferPanelTarget(
  record: Record<string, unknown>,
  evidenceById: Map<string, DashboardPlanEvidence>,
  dashboardDatasourceUid: string,
  panelType: DashboardPlanPanelType,
  panelTitle: string
) {
  const panelTokens = panelMatchTokens(record, panelTitle);
  const candidates = [...evidenceById.values()]
    .filter(
      (evidence) =>
        evidence.datasourceUid === dashboardDatasourceUid &&
        evidence.totalSeries > 0 &&
        evidence.validationError === null
    )
    .map((evidence) => ({
      evidence,
      score: scoreEvidenceMatch(panelTokens, panelType, evidence),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.evidence.id.localeCompare(right.evidence.id));

  if (candidates.length === 0) {
    return null;
  }

  const [best, second] = candidates;
  if (best.score < 7 || (second && best.score - second.score < 3)) {
    return null;
  }
  return best.evidence.id;
}

function panelMatchTokens(record: Record<string, unknown>, panelTitle: string) {
  const sources = [
    panelTitle,
    optionalTextForMatching(record.row),
    optionalTextForMatching(record.legend),
    optionalTextForMatching(record.unit),
    optionalTextForMatching(record.expr),
    optionalTextForMatching(record.query),
    Array.isArray(record.columns) ? record.columns.filter((value) => typeof value === 'string').join(' ') : '',
  ];
  return expandedTokens(sources.join(' '));
}

function scoreEvidenceMatch(
  panelTokens: Set<string>,
  panelType: DashboardPlanPanelType,
  evidence: DashboardPlanEvidence
) {
  const idTokens = expandedTokens(evidence.id);
  const exprTokens = expandedTokens(evidence.expr);
  const labelTokens = expandedTokens(evidence.labels.join(' '));
  let score = 0;

  score += intersectionSize(panelTokens, idTokens) * 5;
  score += intersectionSize(panelTokens, exprTokens) * 2;
  score += intersectionSize(panelTokens, labelTokens);

  const wantsTotal = panelTokens.has('total');
  const hasSeriesLabels = evidence.labels.length > 0;
  if (wantsTotal) {
    score += evidence.labels.length === 0 ? 7 : -2;
  } else if (!hasSeriesLabels && (panelTokens.has('tenant') || panelTokens.has('pod'))) {
    score -= 4;
  }

  if (panelTokens.has('trend') || panelTokens.has('growth')) {
    score += evidence.queryType === 'range' ? 5 : -2;
  } else if (panelType === 'timeseries') {
    score += evidence.queryType === 'range' ? 3 : -1;
  } else if (panelType === 'stat') {
    score += evidence.queryType === 'instant' ? 3 : -1;
  } else if (panelType === 'table') {
    score += evidence.queryType === 'instant' ? 2 : -1;
  }

  if ((panelTokens.has('per') || panelTokens.has('by')) && hasSeriesLabels) {
    score += 2;
  }
  if (panelTokens.has('top') && hasSeriesLabels) {
    score += 2;
  }

  return score;
}

function expandedTokens(value: string) {
  const rawTokens = value
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const tokens = new Set(rawTokens);
  for (const token of rawTokens) {
    if (token.length > 3 && token.endsWith('s')) {
      tokens.add(token.slice(0, -1));
    }
  }

  if (tokens.has('timeseries')) {
    tokens.add('series');
  }
  if (tokens.has('ts')) {
    tokens.add('series');
    tokens.add('timeseries');
  }
  if (tokens.has('samples')) {
    tokens.add('sample');
  }
  if (tokens.has('memory')) {
    tokens.add('mem');
  }
  if (tokens.has('mem')) {
    tokens.add('memory');
  }
  if (tokens.has('sec') || tokens.has('second') || tokens.has('seconds')) {
    tokens.add('rate');
  }
  if (tokens.has('blocks')) {
    tokens.add('storage');
  }
  if (tokens.has('bytes')) {
    tokens.add('storage');
  }

  return tokens;
}

function intersectionSize(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

function optionalTextForMatching(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function compileDashboardPlanToJsonnet(plan: DashboardPlan) {
  const evidenceById = new Map(plan.queryEvidence.map((evidence) => [evidence.id, evidence]));
  const rowSources = groupPanelsByRow(plan.panels).map((row) => {
    const panelSources = row.panels.map((panel) => ({
      panel,
      source: compilePanel(panel, evidenceById, plan.dashboard.datasourceUid),
    }));
    const layoutSources = compilePanelLayouts(panelSources);
    return [
      `d.row(${jsonnetString(row.title)}, [`,
      layoutSources.map((source) => indent(source, 2)).join('\n'),
      ']),',
    ].join('\n');
  });

  return [
    "local d = import 'github.com/g42/pi-dashboard/main.libsonnet';",
    '',
    'd.dashboard.new(',
    `  title=${jsonnetString(plan.dashboard.title)},`,
    `  uid=${jsonnetString(plan.dashboard.uid)},`,
    `  tags=${jsonnetStringArray(plan.dashboard.tags)},`,
    `  time={ from: ${jsonnetString(plan.dashboard.timeRange.from)}, to: ${jsonnetString(plan.dashboard.timeRange.to)} },`,
    '  rows=[',
    rowSources.map((source) => indent(source, 4)).join('\n'),
    '  ],',
    ')',
    '',
  ].join('\n');
}

function compilePanel(
  panel: DashboardPlanPanel,
  evidenceById: Map<string, DashboardPlanEvidence>,
  datasourceUid: string
) {
  const evidences = panel.targets.map((target) => requireEvidence(evidenceById, target.queryEvidenceId));
  const targets = panel.targets.map((target, index) =>
    compilePrometheusTarget(panel, target, evidences[index], datasourceUid)
  );
  const commonArgs = [
    `title=${jsonnetString(panel.title)},`,
    `datasourceUid=${jsonnetString(datasourceUid)},`,
    'targets=[',
    targets.map((target) => `${indent(target, 4)},`).join('\n'),
    '],',
  ];

  if (panel.type === 'table') {
    const columns = panel.columns?.length ? panel.columns : tableColumns(evidences);
    const tableArgs = [...commonArgs, `columns=${jsonnetStringArray(columns)},`];
    if (Object.keys(panel.rename).length > 0) {
      tableArgs.push(`rename=${jsonnetStringRecord(panel.rename)},`);
    }
    const fieldConfig = fieldConfigDefaults(panel);
    if (fieldConfig) {
      tableArgs.push(`fieldConfig=${fieldConfig},`);
    }
    return ['d.panel.table(', indent(tableArgs.join('\n'), 2), ')'].join('\n');
  }

  const panelArgs = [...commonArgs];
  if (panel.unit) {
    panelArgs.push(`unit=${jsonnetString(panel.unit)},`);
  }
  if (panel.decimals !== null) {
    panelArgs.push(`decimals=${panel.decimals},`);
  }
  return [`d.panel.${panel.type}(`, indent(panelArgs.join('\n'), 2), ')'].join('\n');
}

function compilePrometheusTarget(
  panel: DashboardPlanPanel,
  target: DashboardPlanPanelTarget,
  evidence: DashboardPlanEvidence,
  datasourceUid: string
) {
  const args = [
    `${jsonnetString(evidence.expr)},`,
    `${jsonnetString(datasourceUid)},`,
    `legend=${jsonnetString(legendForEvidence(panel, target, evidence))},`,
  ];
  if (panel.type === 'stat' && evidence.queryType === 'instant') {
    args.push('instant=true,');
  }
  if (panel.type === 'table') {
    if (evidence.queryType === 'instant') {
      args.push('instant=true,');
    }
    args.push(`format=${jsonnetString('table')},`);
  }

  return ['d.prom.query(', indent(args.join('\n'), 2), ')'].join('\n');
}

function compilePanelLayouts(panelSources: Array<{ panel: DashboardPlanPanel; source: string }>) {
  const layouts: string[] = [];
  let index = 0;
  while (index < panelSources.length) {
    const layout = normalizeLayoutHint(panelSources[index].panel.layout);
    if (layout === 'full') {
      layouts.push(compileLayoutGroup(panelSources.slice(index, index + 1), 'full'));
      index += 1;
      continue;
    }

    if (layout === 'statStrip') {
      const group = takeConsecutiveLayout(panelSources, index, 'statStrip');
      layouts.push(compileLayoutGroup(group, 'statStrip'));
      index += group.length;
      continue;
    }

    const groupSize = boundedLayoutGroupSize(panelSources, index, layout);
    const group = panelSources.slice(index, index + groupSize);
    layouts.push(compileLayoutGroup(group, layout ?? undefined));
    index += groupSize;
  }
  return layouts;
}

function compileLayoutGroup(group: Array<{ source: string }>, forcedLayout?: string) {
  if (group.length === 1) {
    return ['d.layout.full(', indent(group[0].source, 2), '),'].join('\n');
  }
  const helper =
    forcedLayout && forcedLayout !== 'full'
      ? forcedLayout
      : group.length === 2
        ? 'twoUp'
        : group.length === 3
          ? 'threeUp'
          : 'fourUp';
  return [`d.layout.${helper}([`, group.map((panel) => `${indent(panel.source, 2)},`).join('\n'), ']),'].join('\n');
}

function legendForEvidence(
  panel: DashboardPlanPanel,
  target: DashboardPlanPanelTarget,
  evidence: DashboardPlanEvidence
) {
  if (target.legend) {
    return target.legend;
  }
  if (panel.legend) {
    return panel.legend;
  }
  const labels = orderedDisplayLabels(evidence.labels);
  if (labels.length === 0) {
    return panel.title;
  }
  return labels
    .slice(0, 3)
    .map((label) => `{{${label}}}`)
    .join(' / ');
}

function tableColumns(evidences: DashboardPlanEvidence[]) {
  return uniqueStrings(['Time', ...orderedDisplayLabels(evidences.flatMap((evidence) => evidence.labels)), 'Value']);
}

function fieldConfigDefaults(panel: DashboardPlanPanel) {
  const defaults: string[] = [];
  if (panel.unit) {
    defaults.push(`unit: ${jsonnetString(panel.unit)}`);
  }
  if (panel.decimals !== null) {
    defaults.push(`decimals: ${panel.decimals}`);
  }
  if (defaults.length === 0) {
    return null;
  }
  return `{ defaults: { ${defaults.join(', ')} } }`;
}

function groupPanelsByRow(panels: DashboardPlanPanel[]) {
  const rows: Array<{ title: string; panels: DashboardPlanPanel[] }> = [];
  const rowByTitle = new Map<string, { title: string; panels: DashboardPlanPanel[] }>();
  for (const panel of panels) {
    const title = panel.row || 'Overview';
    let row = rowByTitle.get(title);
    if (!row) {
      row = { title, panels: [] };
      rowByTitle.set(title, row);
      rows.push(row);
    }
    row.panels.push(panel);
  }
  return rows;
}

function normalizeLayoutHint(value: string | null) {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (['full', 'wide'].includes(normalized)) {
    return 'full';
  }
  if (['twoup', 'two-up', 'two_up', 'half'].includes(normalized)) {
    return 'twoUp';
  }
  if (['threeup', 'three-up', 'three_up', 'third'].includes(normalized)) {
    return 'threeUp';
  }
  if (['fourup', 'four-up', 'four_up', 'quarter'].includes(normalized)) {
    return 'fourUp';
  }
  if (['statstrip', 'stat-strip', 'stat_strip'].includes(normalized)) {
    return 'statStrip';
  }
  return null;
}

function layoutColumns(layout: string | null) {
  switch (layout) {
    case 'twoUp':
      return 2;
    case 'threeUp':
      return 3;
    case 'fourUp':
    case 'statStrip':
      return 4;
    default:
      return 4;
  }
}

function inferredLayoutGroupSize(remaining: number, maxGroupSize: number) {
  return Math.min(maxGroupSize, remaining >= 4 ? 4 : remaining === 3 ? 3 : remaining === 2 ? 2 : 1);
}

function boundedLayoutGroupSize(
  panels: Array<{ panel: DashboardPlanPanel; source: string }>,
  start: number,
  layout: string | null
) {
  const targetSize = inferredLayoutGroupSize(panels.length - start, layoutColumns(layout));
  let size = 1;
  while (size < targetSize) {
    const nextLayout = normalizeLayoutHint(panels[start + size].panel.layout);
    if (nextLayout === 'full' || nextLayout === 'statStrip') {
      break;
    }
    if (layout && nextLayout && nextLayout !== layout) {
      break;
    }
    size += 1;
  }
  return size;
}

function takeConsecutiveLayout(
  panels: Array<{ panel: DashboardPlanPanel; source: string }>,
  start: number,
  layout: string
) {
  const group: Array<{ panel: DashboardPlanPanel; source: string }> = [];
  for (let index = start; index < panels.length; index += 1) {
    if (normalizeLayoutHint(panels[index].panel.layout) !== layout) {
      break;
    }
    group.push(panels[index]);
    if (group.length === 4) {
      break;
    }
  }
  return group;
}

function orderedDisplayLabels(labels: string[]) {
  const preferred = ['tenant', 'tenant_id', 'pod', 'namespace', 'job', 'instance', 'cluster'];
  const candidates = uniqueStrings(labels.filter((label) => label && label !== '__name__'));
  return [
    ...preferred.filter((label) => candidates.includes(label)),
    ...candidates.filter((label) => !preferred.includes(label)).sort(),
  ];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function jsonnetString(value: string) {
  return JSON.stringify(value);
}

function jsonnetStringArray(values: string[]) {
  return `[${values.map(jsonnetString).join(', ')}]`;
}

function jsonnetStringRecord(value: Record<string, string>) {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{ ${entries.map(([key, recordValue]) => `${jsonnetString(key)}: ${jsonnetString(recordValue)}`).join(', ')} }`;
}

function indent(value: string, spaces: number) {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : line))
    .join('\n');
}

function requireEvidence(evidenceById: Map<string, DashboardPlanEvidence>, id: string) {
  const evidence = evidenceById.get(id);
  if (!evidence) {
    throw new Error(`dashboard plan references missing queryEvidence ${id}.`);
  }
  return evidence;
}

function requireSessionId(runtime: VirtualJsonnetFileRuntime | undefined) {
  const sessionId = runtime?.getSessionId();
  if (!sessionId) {
    throw new Error('A chat session is required before editing a virtual Jsonnet file.');
  }
  return sessionId;
}

function snapshotFromResponse(response: JsonnetFileBackendResponse, content: string): VirtualJsonnetFileSnapshot {
  return {
    path: response.path,
    content,
    version: response.version,
    checksum: response.checksum,
    lineCount: response.lineCount,
    dashboardJsonnetSize: response.dashboardJsonnetSize,
    updatedAt: response.updatedAt,
  };
}

function requiredString(value: unknown, path: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalNullableString(value: unknown, path: string) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string or null when provided.`);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalNullableNumber(value: unknown, path: string) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number or null when provided.`);
  }
  if (value < 0) {
    throw new Error(`${path} must be greater than or equal to 0.`);
  }
  return value;
}

function optionalNullableStringArray(value: unknown, path: string) {
  if (value === undefined || value === null) {
    return null;
  }
  return requireStringArray(value, path);
}

function normalizeValidationError(value: unknown, path: string) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string or null.`);
  }

  const trimmed = value.trim();
  if (!trimmed || ['null', 'none', 'undefined', 'no error', 'no errors', 'n/a'].includes(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

function optionalStringArray(value: unknown, path: string) {
  if (value === undefined) {
    return [];
  }
  return requireStringArray(value, path);
}

function optionalStringRecord(value: unknown, path: string) {
  if (value === undefined || value === null) {
    return {};
  }
  const record = requireRecord(value, path);
  const normalized: Record<string, string> = {};
  for (const [key, recordValue] of Object.entries(record)) {
    if (typeof recordValue !== 'string') {
      throw new Error(`${path}.${key} must be a string.`);
    }
    const trimmedKey = key.trim();
    const trimmedValue = recordValue.trim();
    if (trimmedKey && trimmedValue) {
      normalized[trimmedKey] = trimmedValue;
    }
  }
  return normalized;
}

function requireStringArray(value: unknown, path: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${path} must be an array of strings.`);
  }
  return uniqueStrings(value.map((entry) => entry.trim()).filter(Boolean));
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}
