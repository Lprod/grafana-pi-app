import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';

const DEFAULT_TIMEOUT_MS = 240_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'robust-dashboard-benchmark');
const BROKEN_QUERY_CANARY = 'pi_broken_metric_canary';

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
};

type LiveBenchmarkState = {
  toolStarts: Map<string, BenchmarkEvent>;
  toolUpdates: Map<string, string>;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 90_000));

test.describe('robust dashboard benchmark', () => {
  test('excludes failed or zero-series PromQL candidates before rendering and saving', async ({
    gotoPage,
    page,
  }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const dashboardUid = `robust-dash-${suffix}`;
    const dashboardTitle = `Robust Dashboard Benchmark ${suffix}`;

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await installBenchmarkRecorder(page);

      const prompt = [
        'This benchmark validates robust dashboard generation from mixed-validity PromQL evidence.',
        'Use exactly one run_dashboard_agent top-level tool call.',
        `Ask the dashboard agent to create and save an editable Jsonnet dashboard titled "${dashboardTitle}" with UID "${dashboardUid}".`,
        'The dashboard must use the default demo Prometheus datasource and cover the last 6 hours.',
        'The dashboard agent must first run one batched query_prometheus range validation with type="range", start="now-6h", and end="now"; instant validation is not acceptable for this benchmark.',
        'That range validation must include these candidate queries exactly:',
        '1. sum by (route) (rate(http_requests_total[5m]))',
        '2. sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))',
        '3. histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])))',
        `4. sum(rate(${BROKEN_QUERY_CANARY}{job="demo"}[5m]))`,
        `The fourth query is an intentionally zero-series canary metric named ${BROKEN_QUERY_CANARY}.`,
        'The dashboard agent must treat any validationError or zero-series candidate as unusable dashboard evidence.',
        'It must not include the broken canary query or metric name in dashboard Jsonnet, rendered dashboard targets, or the saved dashboard.',
        'It must write_jsonnet, render_dashboard, and save_dashboard only after choosing validated successful panel queries.',
        'Expected panels: request rate by route, HTTP 5xx rate by route, and p95 latency by route.',
      ].join(' ');

      const run = await runPrompt({ page, prompt, timeoutMs });
      const report = formatBenchmarkReport(run, dashboardUid);

      await testInfo.attach('robust-dashboard-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('robust-dashboard-benchmark-events.json', {
        body: JSON.stringify(run.events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(run, report);

      console.log(report);

      if (run.timedOut) {
        throw new Error(`Robust dashboard benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(run.events);
      if (finalAssistantError) {
        throw new Error(`Robust dashboard benchmark ended with assistant error: ${finalAssistantError}`);
      }

      const qualityError = findRobustDashboardQualityError(run, dashboardUid);
      if (qualityError) {
        throw new Error(`Robust dashboard benchmark failed quality gate: ${qualityError}`);
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

function findRobustDashboardQualityError(run: BenchmarkRun, dashboardUid: string) {
  const toolCalls = summarizeToolCalls(run.events);
  const directWrite = toolCalls.find((call) => isDashboardMutationCall(call.name));
  if (directWrite) {
    return `expected dashboard work inside run_dashboard_agent, but saw top-level ${directWrite.name}`;
  }

  const dashboardCalls = toolCalls.filter((call) => call.name === 'run_dashboard_agent');
  if (dashboardCalls.length !== 1) {
    return `expected exactly one run_dashboard_agent call, got ${dashboardCalls.length}`;
  }

  const dashboardCall = dashboardCalls[0];
  if (dashboardCall.status !== 'completed' || dashboardCall.isError) {
    return 'run_dashboard_agent did not complete successfully';
  }

  const nestedCalls = dashboardCall.nestedToolCalls ?? [];
  const firstMutationIndex = nestedCalls.findIndex((call) => isDashboardMutationCall(call.name));
  const validationCalls = firstMutationIndex === -1 ? nestedCalls : nestedCalls.slice(0, firstMutationIndex);
  const validationError = findQueryValidationQualityError(validationCalls);
  if (validationError) {
    return `before first dashboard mutation, ${validationError}`;
  }

  const renderedIndex = findLastIndex(
    nestedCalls,
    (call) => call.name === 'render_dashboard' && call.status === 'completed' && !call.isError
  );
  const rendered = renderedIndex === -1 ? undefined : nestedCalls[renderedIndex];
  if (!rendered) {
    return 'dashboard agent did not complete nested render_dashboard';
  }

  const saved = [...nestedCalls]
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
  if (nonRowPanelCount < 3) {
    return `expected at least 3 non-row panels, got ${nonRowPanelCount}`;
  }

  const dashboardTargetText = [
    JSON.stringify(panels),
    dashboardSourceEvidenceText(nestedCalls.slice(0, renderedIndex + 1)),
    extractResultText(rendered.result),
  ]
    .join('\n')
    .toLowerCase();
  if (dashboardTargetText.includes(BROKEN_QUERY_CANARY.toLowerCase())) {
    return `rendered dashboard still contains broken canary metric ${BROKEN_QUERY_CANARY}`;
  }

  for (const expected of ['http_requests_total', 'http_request_duration_seconds_bucket']) {
    if (!dashboardTargetText.includes(expected)) {
      return `rendered dashboard does not include expected validated metric ${expected}`;
    }
  }
  if (!/5\.\.|status/.test(dashboardTargetText)) {
    return 'rendered dashboard does not include an HTTP 5xx/status signal';
  }
  if (!dashboardTargetText.includes('histogram_quantile')) {
    return 'rendered dashboard does not include p95 latency query';
  }

  return undefined;
}

function findQueryValidationQualityError(nestedCalls: NestedToolCallSummary[]) {
  const queryCalls = nestedCalls.filter((call) => call.name === 'query_prometheus');
  if (queryCalls.length === 0) {
    return 'dashboard agent did not validate candidate PromQL with query_prometheus';
  }

  const candidateBatch = queryCalls.find((call) => {
    const queries = queryArgTexts(call.args);
    return (
      queries.length >= 4 &&
      queries.some((query) => query.includes(BROKEN_QUERY_CANARY)) &&
      queries.some((query) => query.includes('http_requests_total')) &&
      queries.some((query) => query.includes('http_request_duration_seconds_bucket'))
    );
  });
  if (!candidateBatch) {
    return `dashboard agent did not run a batched query_prometheus validation containing ${BROKEN_QUERY_CANARY} and the expected candidate metrics`;
  }
  if (!queryValidationCoversLastSixHours(candidateBatch.args)) {
    return 'candidate query_prometheus validation was not run as a now-6h to now range query';
  }

  const evidenceResults = nestedCalls.flatMap((call) => queryEvidenceResults(call.result));
  const canaryResult = evidenceResults.find((result) => String(result.query ?? '').includes(BROKEN_QUERY_CANARY));
  if (!canaryResult) {
    return `query_prometheus evidence did not include broken canary ${BROKEN_QUERY_CANARY}`;
  }
  if (!isUnusableQueryResult(canaryResult)) {
    return `broken canary ${BROKEN_QUERY_CANARY} was not marked with validationError or zero series`;
  }

  const successfulQueries = evidenceResults
    .filter((result) => isSuccessfulQueryResult(result))
    .map((result) => String(result.query ?? ''));
  for (const expected of ['http_requests_total', 'http_request_duration_seconds_bucket']) {
    if (!successfulQueries.some((query) => query.includes(expected))) {
      return `query_prometheus did not validate a successful ${expected} query with data`;
    }
  }

  return undefined;
}

function queryEvidenceResults(result: unknown) {
  const evidence = queryPreviewResults(result);
  for (const record of parseJsonRecords(extractResultText(result))) {
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

function queryValidationCoversLastSixHours(args: unknown) {
  const record = getRecord(args);
  const queries = recordsField(record, 'queries');
  const topLevelRange = stringField(record, 'type') === 'range';
  const topLevelTimeRange = stringField(record, 'start') === 'now-6h' && stringField(record, 'end') === 'now';
  const queryLevelRange =
    queries.length > 0 &&
    queries.every(
      (query) =>
        (stringField(query, 'type') === 'range' || topLevelRange) &&
        (stringField(query, 'start') === 'now-6h' || stringField(record, 'start') === 'now-6h') &&
        (stringField(query, 'end') === 'now' || stringField(record, 'end') === 'now')
    );

  return (topLevelRange && topLevelTimeRange) || queryLevelRange;
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
    return JSON.stringify(args ?? {});
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

function formatBenchmarkReport(run: BenchmarkRun, dashboardUid: string) {
  const report = summarizeRun(run);
  const quality = findRobustDashboardQualityError(run, dashboardUid);
  const lines = [
    '',
    'Robust dashboard benchmark report',
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
    return `[robust-dashboard-benchmark:live] tool_start ${event.toolName} args=${summarizeJson(event.args)}`;
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
      `[robust-dashboard-benchmark:live] tool_update ${event.toolName}`,
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
      `[robust-dashboard-benchmark:live] tool_end ${event.toolName} ${status} duration=${duration}`,
      nestedCalls === undefined ? undefined : `nested=${nestedCalls}`,
      resultText ? (event.isError ? `error=${resultText}` : `text=${resultText}`) : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (event.type === 'agent_end') {
    return '[robust-dashboard-benchmark:live] agent_end';
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

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}

function isDashboardMutationCall(name: string) {
  return ['write_jsonnet', 'edit_jsonnet', 'fix_jsonnet', 'render_dashboard', 'save_dashboard'].includes(name);
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncateOneLine(value: string, maxLength: number) {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}...` : oneLine;
}

function summarizeJson(value: unknown) {
  if (value === undefined) {
    return 'undefined';
  }

  const json = JSON.stringify(value);
  if (!json) {
    return String(value);
  }
  return json.length > 800 ? `${json.slice(0, 800)}...` : json;
}
