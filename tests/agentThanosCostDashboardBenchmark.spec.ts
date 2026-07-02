import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';

const DEFAULT_TIMEOUT_MS = 600_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'thanos-cost-dashboard-benchmark');
const DATASOURCE_UID = 'thanos-prod-db';
const NAMESPACE = 'thanos-prod';
const CLUSTER_SELECTOR = 'cluster="openshift-obs-it-prod"';
const REQUIRED_METRIC_GROUPS = [
  ['prometheus_tsdb_storage_blocks_bytes'],
  ['prometheus_tsdb_wal_storage_size_bytes'],
  ['thanos_receive_write_samples_sum'],
  ['thanos_receive_write_timeseries_sum'],
  ['container_cpu_usage_seconds_total'],
  ['container_memory_working_set_bytes', 'container_memory_usage_bytes'],
];
const FORBIDDEN_JSONNET_PATTERNS = [
  { label: 'unsupported oneByThree layout', pattern: /\bd\.layout\.oneByThree\s*\(/ },
  { label: 'unsupported panel description argument', pattern: /\bdescription\s*=/ },
  { label: 'unsupported table sortByField argument', pattern: /\bsortByField\s*=/ },
  { label: 'unsupported table sortDesc argument', pattern: /\bsortDesc\s*=/ },
  { label: 'unsupported dashboard timeframe argument', pattern: /\btimeframe\s*=/ },
  { label: 'unsupported dashboard timeFrom argument', pattern: /\btimeFrom\s*=/ },
  { label: 'unsupported dashboard timeTo argument', pattern: /\btimeTo\s*=/ },
];

type BenchmarkEvent = {
  type: string;
  timestamp: number;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: {
    role?: unknown;
    errorMessage?: unknown;
    content?: unknown;
  };
};

type BenchmarkRun = {
  prompt: string;
  events: BenchmarkEvent[];
  finalAnswer: string;
  promptStartedAt: number;
  timeoutMs: number;
  timedOut: boolean;
};

type ToolCallSummary = {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  args?: unknown;
  isError?: boolean;
  nestedToolCalls?: NestedToolCallSummary[];
  result?: unknown;
};

type NestedToolCallSummary = {
  name: string;
  status?: string;
  isError?: boolean;
  args?: unknown;
  result?: unknown;
  text?: string;
};

type LiveBenchmarkState = {
  toolStarts: Map<string, BenchmarkEvent>;
  toolUpdates: Map<string, string>;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 90_000));

test.describe('Thanos cost dashboard benchmark', () => {
  test('turns validated Thanos cost evidence into a saved dashboard without unsupported Jsonnet helper usage', async ({
    gotoPage,
    page,
  }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const dashboardUid = `thanos-cost-${suffix}`;
    const dashboardTitle = `Thanos Tenant Cost Benchmark ${suffix}`;

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await installBenchmarkRecorder(page);

      const prompt = [
        'This benchmark reproduces a German Thanos tenant-cost dashboard session with mixed valid and invalid PromQL evidence.',
        'Use exactly one run_investigation_agent top-level tool call first, then exactly one run_dashboard_agent top-level tool call. Do not use dashboard write tools directly at the top level.',
        'There are exactly two top-level tool calls total. After run_dashboard_agent reports the dashboard was saved, stop calling tools and provide the final answer from the two completed tool results.',
        `The target datasource UID is ${DATASOURCE_UID}.`,
        `German user request: Kannst du auf Grundlage der Thanos Daten mal schauen, welche Datentoepfe in Thanos die groessten sind und welche am meisten Ressourcen und Kosten verursachen. Cool waere auch eine Berechnung, welcher Tenant wie viel CPU und Memory benoetigt. Alles bezogen auf den Namespace ${NAMESPACE} im Cluster openshift-obs-it-prod.`,
        'The local benchmark fixture intentionally has namespace="thanos-prod" series but no cluster label.',
        'The investigation agent must first validate this intentionally over-scoped candidate batch using cluster="openshift-obs-it-prod" selectors:',
        '1. sum by (tenant) (prometheus_tsdb_storage_blocks_bytes{cluster="openshift-obs-it-prod", namespace="thanos-prod"})',
        '2. sum by (tenant) (prometheus_tsdb_wal_storage_size_bytes{cluster="openshift-obs-it-prod", namespace="thanos-prod"})',
        '3. sum by (tenant) (rate(thanos_receive_write_samples_sum{cluster="openshift-obs-it-prod", namespace="thanos-prod"}[5m]))',
        '4. sum by (tenant) (rate(thanos_receive_write_timeseries_sum{cluster="openshift-obs-it-prod", namespace="thanos-prod"}[5m]))',
        '5. topk(10, sum by (pod, tenant_id) (rate(container_cpu_usage_seconds_total{cluster="openshift-obs-it-prod", namespace="thanos-prod"}[5m])))',
        '6. topk(10, sum by (pod, tenant_id) (container_memory_working_set_bytes{cluster="openshift-obs-it-prod", namespace="thanos-prod"}))',
        'After those fail with zero series, inspect labels/series and recover to the same six queries without the cluster selector before the dashboard agent writes the dashboard.',
        'Investigation hard budget: validate the over-scoped batch once, inspect labels/series once, validate the recovered batch once, retry only failed recovered queries once individually, then stop querying. Do not read artifacts for tenant values or per-series detail; for dashboard handoff, query text plus totalSeries, validationError status, and key label names are enough.',
        'The validated dashboard plan must cover TSDB storage per tenant, WAL storage per tenant, storage growth or current storage trend, ingest samples/sec, ingest series/sec, top CPU pods, and top memory pods.',
        `Ask the dashboard agent to create, render, and save an editable Jsonnet dashboard titled "${dashboardTitle}" with UID "${dashboardUid}" by calling write_dashboard_plan first; write_dashboard_plan emits dashboard.jsonnet, so raw write_jsonnet is not needed for this benchmark. The dashboard must use time={ from: "now-6h", to: "now" }.`,
        'The dashboard agent may only write panels backed by query_prometheus evidence with no validationError and totalSeries greater than zero. It must not save cluster-scoped zero-series targets.',
        'Use only supported Jsonnet helper calls: d.dashboard.new(... time=...), d.row(...), d.layout.full/twoUp/threeUp/fourUp/statStrip, d.panel.table/stat/timeseries, and d.prom.query(...). Do not use d.layout.oneByThree, description=, sortByField=, sortDesc=, timeframe=, timeFrom=, or timeTo=.',
      ].join(' ');

      const run = await runPrompt({ page, prompt, timeoutMs });
      const persistedDashboard = await fetchPersistedDashboard(page, dashboardUid);
      const report = formatBenchmarkReport(run, dashboardUid, persistedDashboard);

      await testInfo.attach('thanos-cost-dashboard-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('thanos-cost-dashboard-benchmark-events.json', {
        body: JSON.stringify(run.events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(run, report);

      console.log(report);

      const finalAssistantError = findFinalAssistantError(run.events);
      if (finalAssistantError) {
        throw new Error(`Thanos cost dashboard benchmark ended with assistant error: ${finalAssistantError}`);
      }

      const qualityError = findThanosDashboardQualityError(run, dashboardUid, persistedDashboard);
      if (qualityError) {
        throw new Error(`Thanos cost dashboard benchmark failed quality gate: ${qualityError}`);
      }

      if (run.timedOut) {
        throw new Error(`Thanos cost dashboard benchmark timed out after ${timeoutMs}ms.`);
      }
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`).catch(() => undefined);
    }
  });
});

async function installBenchmarkRecorder(page: Page) {
  const liveState: LiveBenchmarkState = {
    toolStarts: new Map(),
    toolUpdates: new Map(),
  };

  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    const line = formatLiveBenchmarkEvent(event, liveState);
    if (line) {
      console.log(line);
    }
  });

  const installRecorder = () => {
    const benchmarkWindow = window as typeof window & {
      __PI_AGENT_BENCHMARK_EVENTS__?: unknown[];
      __PI_AGENT_BENCHMARK_RECORD_EVENT__?: (event: unknown) => void;
      __PI_AGENT_BENCHMARK_STREAM_EVENT__?: (event: unknown) => Promise<void>;
    };

    benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
    benchmarkWindow.__PI_AGENT_BENCHMARK_RECORD_EVENT__ = (event: unknown) => {
      benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__?.push(event);
      void benchmarkWindow.__PI_AGENT_BENCHMARK_STREAM_EVENT__?.(event);
    };
  };

  await page.addInitScript(installRecorder);
  await page.evaluate(installRecorder);
}

async function runPrompt({
  page,
  prompt,
  timeoutMs,
}: {
  page: Page;
  prompt: string;
  timeoutMs: number;
}): Promise<BenchmarkRun> {
  await resetBenchmarkEvents(page);
  const composer = page.getByTestId(testIds.chat.composer);
  const send = page.getByTestId(testIds.chat.send);
  await composer.fill(prompt);
  await expect(send).toBeEnabled();

  const promptStartedAt = Date.now();
  await send.click();

  let timedOut = false;
  let benchmarkFinished = false;
  const approvalTask = autoApproveToolConfirmations(page, () => benchmarkFinished);
  try {
    await page.waitForFunction(
      () => {
        const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkEvent[] };
        return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__?.some((event) => event.type === 'agent_end') ?? false;
      },
      undefined,
      { timeout: timeoutMs }
    );
  } catch {
    timedOut = true;
    await page
      .getByRole('button', { name: /Stop/i })
      .click({ timeout: 1000 })
      .catch(() => undefined);
  } finally {
    benchmarkFinished = true;
    await approvalTask;
  }

  const events = await readBenchmarkEvents(page);
  return {
    prompt,
    events,
    finalAnswer: findFinalAssistantText(events),
    promptStartedAt,
    timeoutMs,
    timedOut,
  };
}

async function resetBenchmarkEvents(page: Page) {
  await page.evaluate(() => {
    const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkEvent[] };
    benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
  });
}

async function readBenchmarkEvents(page: Page): Promise<BenchmarkEvent[]> {
  return page.evaluate(() => {
    const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkEvent[] };
    return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ ?? [];
  });
}

async function fetchPersistedDashboard(page: Page, dashboardUid: string) {
  const response = await page.request.get(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`);
  if (!response.ok()) {
    return undefined;
  }
  return response.json();
}

async function autoApproveToolConfirmations(page: Page, isDone: () => boolean) {
  while (!isDone()) {
    try {
      const approve = page.getByTestId(testIds.chat.toolConfirmationApprove);
      if (await approve.isVisible({ timeout: 500 }).catch(() => false)) {
        await approve.click();
        continue;
      }
      await page.waitForTimeout(250);
    } catch {
      if (!isDone()) {
        await page.waitForTimeout(250).catch(() => undefined);
      }
    }
  }
}

function findThanosDashboardQualityError(run: BenchmarkRun, dashboardUid: string, persistedDashboard?: unknown) {
  const toolCalls = summarizeToolCalls(run.events);
  const unexpectedTopLevel = toolCalls.find(
    (call) => !['run_investigation_agent', 'run_dashboard_agent'].includes(call.name)
  );
  if (unexpectedTopLevel) {
    return `unexpected top-level ${unexpectedTopLevel.name}; expected only run_investigation_agent then run_dashboard_agent`;
  }

  const directWrite = toolCalls.find((call) => isDashboardMutationCall(call.name));
  if (directWrite) {
    return `expected dashboard work inside run_dashboard_agent, but saw top-level ${directWrite.name}`;
  }

  const investigationCalls = toolCalls.filter((call) => call.name === 'run_investigation_agent');
  if (investigationCalls.length !== 1) {
    return `expected exactly one run_investigation_agent call, got ${investigationCalls.length}`;
  }
  const dashboardCalls = toolCalls.filter((call) => call.name === 'run_dashboard_agent');
  if (dashboardCalls.length !== 1) {
    return `expected exactly one run_dashboard_agent call, got ${dashboardCalls.length}`;
  }

  const investigationCall = investigationCalls[0];
  const dashboardCall = dashboardCalls[0];
  if (investigationCall.startedAt > dashboardCall.startedAt) {
    return 'run_dashboard_agent started before run_investigation_agent';
  }
  if (investigationCall.status !== 'completed' || investigationCall.isError) {
    return 'run_investigation_agent did not complete successfully';
  }
  if (dashboardCall.status !== 'completed' || dashboardCall.isError) {
    return 'run_dashboard_agent did not complete successfully';
  }

  const investigationNested = investigationCall.nestedToolCalls ?? [];
  const dashboardNested = dashboardCall.nestedToolCalls ?? [];
  const dashboardFailure = dashboardNested.find(
    (call) =>
      ['write_dashboard_plan', 'write_jsonnet', 'edit_jsonnet', 'render_dashboard', 'save_dashboard'].includes(
        call.name
      ) &&
      (call.status === 'failed' || call.isError)
  );
  if (dashboardFailure) {
    return `dashboard agent hit a failed ${dashboardFailure.name} call instead of preflighting the draft`;
  }

  const firstMutationIndex = dashboardNested.findIndex((call) => isDashboardMutationCall(call.name));
  if (firstMutationIndex === -1) {
    return 'dashboard agent never wrote Jsonnet';
  }

  const validationError = findPrometheusEvidenceQualityError(
    investigationNested,
    dashboardNested.slice(0, firstMutationIndex),
    [extractResultText(investigationCall.result), run.finalAnswer].filter(Boolean).join('\n')
  );
  if (validationError) {
    return validationError;
  }

  const renderedIndex = findLastIndex(
    dashboardNested,
    (call) => call.name === 'render_dashboard' && call.status === 'completed' && !call.isError
  );
  const rendered = renderedIndex === -1 ? undefined : dashboardNested[renderedIndex];
  if (!rendered) {
    return 'dashboard agent did not complete nested render_dashboard';
  }

  const saved = [...dashboardNested]
    .reverse()
    .find((call) => call.name === 'save_dashboard' && call.status === 'completed' && !call.isError);
  if (!saved) {
    return 'dashboard agent did not complete nested save_dashboard';
  }

  const saveDetails = getRecord(getRecord(saved.result)?.details);
  if (stringField(saveDetails, 'uid') !== dashboardUid) {
    return `save_dashboard wrote UID ${stringField(saveDetails, 'uid') ?? 'unknown'} instead of ${dashboardUid}`;
  }

  const renderDetails = getRecord(getRecord(rendered.result)?.details);
  const dashboard = getRecord(renderDetails?.dashboard);
  if (!dashboard) {
    return 'render_dashboard did not return a dashboard summary';
  }

  const panels = recordsField(dashboard, 'panels');
  const nonRowPanelCount = panels.length
    ? panels.filter((panel) => stringField(panel, 'type') !== 'row').length
    : Math.max(0, numericField(dashboard, 'panelCount') - 1);
  if (nonRowPanelCount < 5) {
    return `expected at least 5 non-row panels, got ${nonRowPanelCount}`;
  }

  const sourceText = dashboardSourceEvidenceText(dashboardNested.slice(0, renderedIndex + 1));
  for (const { label, pattern } of FORBIDDEN_JSONNET_PATTERNS) {
    if (pattern.test(sourceText)) {
      return `dashboard Jsonnet contains ${label}`;
    }
  }

  const dashboardTargetText = [
    JSON.stringify(persistedDashboard),
    JSON.stringify(panels),
    sourceText,
    extractResultText(rendered.result),
  ]
    .join('\n')
    .toLowerCase();
  if (dashboardTargetText.includes(CLUSTER_SELECTOR.toLowerCase())) {
    return `rendered dashboard still contains zero-series over-scoped selector ${CLUSTER_SELECTOR}`;
  }

  for (const group of REQUIRED_METRIC_GROUPS) {
    if (!group.some((metric) => dashboardTargetText.includes(metric.toLowerCase()))) {
      return `rendered dashboard does not include expected metric group ${group.join(' or ')}`;
    }
  }

  return undefined;
}

function findPrometheusEvidenceQualityError(
  investigationCalls: NestedToolCallSummary[],
  dashboardValidationCalls: NestedToolCallSummary[],
  textualEvidence: string
) {
  const allValidationCalls = [...investigationCalls, ...dashboardValidationCalls].filter(
    (call) => call.name === 'query_prometheus'
  );
  if (allValidationCalls.length === 0) {
    return 'no query_prometheus validation evidence was collected before dashboard mutation';
  }

  const queryTexts = allValidationCalls.flatMap((call) => queryArgTexts(call.args));
  if (!queryTexts.some((query) => query.includes(CLUSTER_SELECTOR))) {
    return `investigation did not validate the intentionally over-scoped ${CLUSTER_SELECTOR} candidates`;
  }

  const evidenceResults = allValidationCalls.flatMap((call) => queryEvidenceResults(call.result, call.text));
  const clusterScopedResult = evidenceResults.find((result) => String(result.query ?? '').includes(CLUSTER_SELECTOR));
  if (
    (!clusterScopedResult || !isUnusableQueryResult(clusterScopedResult)) &&
    !hasTextualClusterZeroSeriesEvidence(textualEvidence)
  ) {
    return `over-scoped ${CLUSTER_SELECTOR} evidence was not observed as validationError or zero-series`;
  }

  for (const group of REQUIRED_METRIC_GROUPS) {
    const successful = evidenceResults.some((result) => {
      const query = String(result.query ?? '');
      return (
        group.some((metric) => query.includes(metric)) &&
        query.includes(`namespace="${NAMESPACE}"`) &&
        isSuccessfulQueryResult(result)
      );
    });
    if (!successful && !hasTextualSuccessfulMetricEvidence(textualEvidence, group)) {
      return `no successful namespace-scoped validation evidence for metric group ${group.join(' or ')}`;
    }
  }

  return undefined;
}

function hasTextualClusterZeroSeriesEvidence(text: string) {
  const normalized = text.toLowerCase();
  const mentionsCluster =
    normalized.includes(CLUSTER_SELECTOR.toLowerCase()) || /\bcluster\b[^.\n]*openshift-obs-it-prod/.test(normalized);
  const mentionsZeroSeries =
    /zero[-\s]?series/.test(normalized) || /0\s+series/.test(normalized) || /totalseries\s*[:=]\s*0/.test(normalized);
  return mentionsCluster && mentionsZeroSeries;
}

function hasTextualSuccessfulMetricEvidence(text: string, metricGroup: string[]) {
  const normalized = text.toLowerCase();
  const terms = [...metricGroup, ...metricGroup.flatMap(metricEvidenceAliases)];
  const mentionsMetric = terms.some((metric) => normalized.includes(metric.toLowerCase()));
  const mentionsNamespace = normalized.includes(`namespace="${NAMESPACE}"`);
  const mentionsSuccess =
    /validated successfully|validierten erfolgreich|totalseries/.test(normalized) &&
    /status|no validationerror|validationerror\s*\|\s*none|validationerror.*none|\u2705/.test(normalized);
  return mentionsMetric && mentionsNamespace && mentionsSuccess;
}

function metricEvidenceAliases(metric: string) {
  switch (metric) {
    case 'prometheus_tsdb_storage_blocks_bytes':
      return ['tsdb storage'];
    case 'prometheus_tsdb_wal_storage_size_bytes':
      return ['wal storage'];
    case 'thanos_receive_write_samples_sum':
      return ['ingest samples', 'samples/sec'];
    case 'thanos_receive_write_timeseries_sum':
      return ['ingest series', 'series/sec'];
    case 'container_cpu_usage_seconds_total':
      return ['top cpu', 'cpu pods'];
    case 'container_memory_working_set_bytes':
    case 'container_memory_usage_bytes':
      return ['top memory', 'memory pods'];
    default:
      return [];
  }
}

function queryEvidenceResults(result: unknown, text?: string) {
  const evidence = queryPreviewResults(result);
  for (const record of [...parseJsonRecords(extractResultText(result)), ...parseJsonRecords(text)]) {
    const results = record.results;
    if (Array.isArray(results)) {
      evidence.push(...results.map(getRecord).filter((item): item is Record<string, unknown> => Boolean(item)));
    } else if (stringField(record, 'query')) {
      evidence.push(record);
    }
  }

  return evidence;
}

function queryPreviewResults(result: unknown) {
  const details = getRecord(getRecord(result)?.details);
  const preview = getRecord(details?.artifactPreview);
  const previewData = getRecord(preview?.data);
  const results = previewData?.results;
  if (Array.isArray(results)) {
    return results.map(getRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  }

  const textData = parseJsonObject(extractResultText(result));
  const textResults = textData?.results;
  if (Array.isArray(textResults)) {
    return textResults.map(getRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  }

  const directResult = getRecord(details);
  return directResult && stringField(directResult, 'query') ? [directResult] : [];
}

function queryArgTexts(args: unknown) {
  const record = getRecord(args);
  const queries = record?.queries;
  if (Array.isArray(queries)) {
    return queries
      .map((query) => {
        if (typeof query === 'string') {
          return query;
        }
        return stringField(getRecord(query), 'query');
      })
      .filter((query): query is string => Boolean(query));
  }

  return [stringField(record, 'query')].filter((query): query is string => Boolean(query));
}

function isUnusableQueryResult(result: Record<string, unknown>) {
  return (
    Boolean(stringField(result, 'validationError')) ||
    optionalNumericField(result, 'totalSeries') === 0 ||
    optionalNumericField(result, 'seriesCount') === 0
  );
}

function isSuccessfulQueryResult(result: Record<string, unknown>) {
  const series = optionalNumericField(result, 'totalSeries') ?? optionalNumericField(result, 'seriesCount') ?? 0;
  return !stringField(result, 'validationError') && series > 0;
}

function parseJsonRecords(text: string | undefined) {
  if (!text) {
    return [];
  }

  const whole = parseJsonObject(text);
  if (whole) {
    return [whole];
  }

  return text
    .split(/\r?\n/)
    .map((line) => parseJsonObject(line))
    .filter((record): record is Record<string, unknown> => Boolean(record));
}

function parseJsonObject(text: string | undefined) {
  if (!text) {
    return undefined;
  }
  try {
    return getRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function dashboardSourceEvidenceText(nestedCalls: NestedToolCallSummary[]) {
  const mutation = [...nestedCalls]
    .reverse()
    .find(
      (call) =>
        ['write_dashboard_plan', 'write_jsonnet', 'edit_jsonnet'].includes(call.name) &&
        call.status === 'completed' &&
        !call.isError
    );
  const args = getRecord(mutation?.args);
  if (mutation?.name === 'write_dashboard_plan') {
    const detailsPlan = getRecord(getRecord(getRecord(mutation.result)?.details)?.dashboardPlan);
    return JSON.stringify([args, detailsPlan]);
  }
  if (mutation?.name === 'write_jsonnet') {
    return stringField(args, 'content') ?? '';
  }

  const edits = args?.edits;
  if (Array.isArray(edits)) {
    return edits
      .map((edit) => stringField(getRecord(edit), 'replacement'))
      .filter((replacement): replacement is string => Boolean(replacement))
      .join('\n');
  }

  return '';
}

function formatBenchmarkReport(run: BenchmarkRun, dashboardUid: string, persistedDashboard?: unknown) {
  const report = summarizeRun(run);
  const quality = findThanosDashboardQualityError(run, dashboardUid, persistedDashboard);
  const lines = [
    '',
    'Thanos cost dashboard benchmark report',
    `Dashboard UID: ${dashboardUid}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    '',
    `Prompt: ${run.prompt}`,
    `Status: ${run.timedOut ? 'timed out' : findFinalAssistantError(run.events) ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration(report.elapsedMs)}`,
    `Time to first tool: ${report.firstToolStart ? formatDuration(report.firstToolStart - report.agentStart) : 'none'}`,
    `Tool calls: ${report.toolCalls.length}`,
    `Assistant error: ${findFinalAssistantError(run.events) ?? 'none'}`,
    `Quality: ${quality ?? 'passed'}`,
    '',
    'Tool call timeline',
  ];

  for (const [index, call] of report.toolCalls.entries()) {
    const nested = call.nestedToolCalls?.length ? ` | ${call.nestedToolCalls.length} nested calls` : '';
    lines.push(
      `${index + 1}. ${call.name} | ${call.status} | ${
        call.durationMs === undefined ? 'duration pending' : formatDuration(call.durationMs)
      }${nested}`,
      `   args=${summarizeJson(call.args)}`
    );
    if (call.nestedToolCalls?.length) {
      lines.push(`   nested=${call.nestedToolCalls.map((nestedCall) => nestedCall.name).join(', ')}`);
    }
  }

  lines.push('', 'Final answer preview', truncateOneLine(run.finalAnswer, 1600));
  return lines.join('\n');
}

function summarizeRun(run: BenchmarkRun) {
  const agentStart = run.events.find((event) => event.type === 'agent_start')?.timestamp ?? run.promptStartedAt;
  const agentEnd = [...run.events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const toolCalls = summarizeToolCalls(run.events);
  return {
    agentStart,
    elapsedMs: (agentEnd ?? Date.now()) - agentStart,
    firstToolStart: toolCalls[0]?.startedAt,
    toolCalls,
  };
}

function summarizeToolCalls(events: BenchmarkEvent[]): ToolCallSummary[] {
  const calls = new Map<string, ToolCallSummary>();

  for (const event of events) {
    if (!event.toolCallId || !event.toolName) {
      continue;
    }

    if (event.type === 'tool_execution_start') {
      calls.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        status: 'running',
        startedAt: event.timestamp,
        args: event.args,
      });
      continue;
    }

    const existing =
      calls.get(event.toolCallId) ??
      ({
        id: event.toolCallId,
        name: event.toolName,
        status: 'running',
        startedAt: event.timestamp,
        args: event.args,
      } satisfies ToolCallSummary);

    if (event.type === 'tool_execution_update') {
      calls.set(event.toolCallId, {
        ...existing,
        args: event.args ?? existing.args,
        nestedToolCalls: extractNestedToolCalls(event.partialResult) ?? existing.nestedToolCalls,
      });
      continue;
    }

    if (event.type === 'tool_execution_end') {
      calls.set(event.toolCallId, {
        ...existing,
        status: event.isError ? 'failed' : 'completed',
        endedAt: event.timestamp,
        durationMs: event.timestamp - existing.startedAt,
        isError: event.isError,
        nestedToolCalls: extractNestedToolCalls(event.result) ?? existing.nestedToolCalls,
        result: event.result,
      });
    }
  }

  return [...calls.values()].sort((left, right) => left.startedAt - right.startedAt);
}

function extractNestedToolCalls(result: unknown): NestedToolCallSummary[] | undefined {
  const details = getRecord(getRecord(result)?.details);
  const toolCalls = details?.toolCalls;
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  return toolCalls.map((call) => {
    const record = getRecord(call);
    return {
      name: stringField(record, 'name') ?? 'unknown',
      status: stringField(record, 'status'),
      isError: booleanField(record, 'isError'),
      args: record?.args,
      result: record?.result,
      text: stringField(record, 'text'),
    };
  });
}

async function writeBenchmarkArtifacts(run: BenchmarkRun, report: string) {
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report),
    writeFile(path.join(OUTPUT_DIR, 'latest-events.json'), JSON.stringify(run.events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, 'latest-answer.md'), run.finalAnswer),
    writeFile(path.join(OUTPUT_DIR, `report${runSuffix}.txt`), report),
    writeFile(path.join(OUTPUT_DIR, `events${runSuffix}.json`), JSON.stringify(run.events, null, 2)),
  ]);
}

function formatLiveBenchmarkEvent(event: BenchmarkEvent, state: LiveBenchmarkState) {
  if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
    state.toolStarts.set(event.toolCallId, event);
    return `[thanos-cost-dashboard-benchmark:live] tool_start ${event.toolName} args=${summarizeJson(event.args)}`;
  }

  if (event.type === 'tool_execution_update' && event.toolCallId && event.toolName) {
    const nestedCalls = extractNestedToolCalls(event.partialResult)?.length;
    const resultText = truncateOneLine(extractResultText(event.partialResult) ?? '', 240);
    if (nestedCalls === undefined && !resultText) {
      return undefined;
    }

    const updateKey = `${nestedCalls ?? ''}|${resultText}`;
    if (state.toolUpdates.get(event.toolCallId) === updateKey) {
      return undefined;
    }
    state.toolUpdates.set(event.toolCallId, updateKey);

    return [
      `[thanos-cost-dashboard-benchmark:live] tool_update ${event.toolName}`,
      nestedCalls === undefined ? undefined : `nested=${nestedCalls}`,
      resultText ? `text=${resultText}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (event.type === 'tool_execution_end' && event.toolCallId && event.toolName) {
    const start = state.toolStarts.get(event.toolCallId);
    const duration = start ? formatDuration(event.timestamp - start.timestamp) : 'unknown';
    const status = event.isError ? 'failed' : 'completed';
    const nestedCalls = extractNestedToolCalls(event.result)?.length;
    const resultText = truncateOneLine(extractResultText(event.result) ?? '', event.isError ? 600 : 240);
    return [
      `[thanos-cost-dashboard-benchmark:live] tool_end ${event.toolName} ${status} duration=${duration}`,
      nestedCalls === undefined ? undefined : `nested=${nestedCalls}`,
      resultText ? (event.isError ? `error=${resultText}` : `text=${resultText}`) : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (event.type === 'agent_end') {
    return '[thanos-cost-dashboard-benchmark:live] agent_end';
  }

  return undefined;
}

function extractResultText(result: unknown) {
  const content = getRecord(result)?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  return content
    .map((block) => getRecord(block))
    .filter((block): block is Record<string, unknown> => Boolean(block) && block.type === 'text')
    .map((block) => block.text)
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function findFinalAssistantError(events: BenchmarkEvent[]) {
  const finalAssistantMessage = [...events]
    .reverse()
    .find((event) => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
  return typeof finalAssistantMessage?.errorMessage === 'string' ? finalAssistantMessage.errorMessage : undefined;
}

function findFinalAssistantText(events: BenchmarkEvent[]) {
  const finalAssistantMessage = [...events]
    .reverse()
    .find((event) => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
  const content = finalAssistantMessage?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => getRecord(block))
    .filter((block): block is Record<string, unknown> => Boolean(block) && block.type === 'text')
    .map((block) => block.text)
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function numericField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumericField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'boolean' ? value : undefined;
}

function recordsField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return Array.isArray(value)
    ? value.map(getRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isDashboardMutationCall(name: string) {
  return [
    'write_dashboard_plan',
    'write_jsonnet',
    'edit_jsonnet',
    'fix_jsonnet',
    'render_dashboard',
    'save_dashboard',
  ].includes(name);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}

function summarizeJson(value: unknown) {
  return truncateOneLine(JSON.stringify(value ?? {}), 900);
}

function truncateOneLine(value: string, maxLength: number) {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 3)}...`;
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
