import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';

const DEFAULT_TIMEOUT_MS = 180_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'dashboard-metric-discovery-benchmark');
const FORBIDDEN_WRITE_TOOLS = new Set([
  'write_jsonnet',
  'edit_jsonnet',
  'fix_jsonnet',
  'render_dashboard',
  'save_dashboard',
  'upload_dashboard',
  'delete_dashboard',
]);

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
    usage?: unknown;
  };
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
  resultText?: string;
  errorText?: string;
};

type NestedToolCallSummary = {
  name: string;
  status?: string;
  isError?: boolean;
  args?: unknown;
};

type LiveBenchmarkState = {
  toolStarts: Map<string, BenchmarkEvent>;
  toolUpdates: Map<string, string>;
};

type RenderedBenchmarkState = {
  text: string;
  completedQueryAgent: boolean;
  completedDashboardMetricContext: boolean;
  completedPrometheusQuery: boolean;
  failedDashboardMetricContext: boolean;
  failedPrometheusQuery: boolean;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 90_000));

test.describe('dashboard metric discovery benchmark', () => {
  test('uses dashboard metric context before validating PromQL', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const serviceUid = `metric-context-service-${suffix}`;
    const infraUid = `metric-context-infra-${suffix}`;
    const serviceTitle = `Metric Context Service ${suffix}`;
    const infraTitle = `Metric Context Infra ${suffix}`;

    await seedDashboard(page, serviceUid, serviceTitle, serviceDashboard(serviceUid, serviceTitle));
    await seedDashboard(page, infraUid, infraTitle, infraDashboard(infraUid, infraTitle));

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      const streamedEvents = await installBenchmarkRecorder(page);

      const prompt = [
        'Use exactly one run_query_agent top-level tool call.',
        'Do not call list_datasources, list_metrics, inspect_metric_series, list_label_values, query_prometheus, inspect_dashboard_metric_usage, search_dashboard_metric_usage, get_metric_neighborhood, or any dashboard tool directly at top level.',
        `Call run_query_agent with this task: Benchmark dashboard metric context with at most four tool calls. First call search_dashboard_metric_usage with query "Metric Context ${suffix}", seedMetric "http_requests_total", and maxDashboards 5. Then call get_metric_neighborhood with metric "http_requests_total", query "Metric Context ${suffix}", and maxResults 8. Then call query_prometheus once with instant queries for sum(rate(http_requests_total{status=~"5.."}[5m])), histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)), node_load1, and sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) by (instance). Do not call list_metrics, inspect_metric_series, list_label_values, or dashboard write tools. Report the dashboard-derived relation evidence and the validated PromQL results concisely.`,
        'After the tool returns, do not call more tools. Answer with one compact sentence summarizing whether dashboard context found related metrics and PromQL validation ran.',
        'Do not create, render, sync, upload, delete, or modify dashboards.',
      ].join(' ');

      const promptStartedAt = Date.now();
      const composer = page.getByTestId(testIds.chat.composer);
      const send = page.getByTestId(testIds.chat.send);
      await composer.fill(prompt);
      await expect(send).toBeEnabled();
      await send.click();

      const completion = await waitForBenchmarkCompletion(page, streamedEvents, timeoutMs);
      if (completion.completedBy === 'tool_evidence') {
        await page
          .getByRole('button', { name: /Stop/i })
          .click({ timeout: 1000 })
          .catch(() => undefined);
      }
      await expandFailedDashboardMetricToolResults(page);

      const events = await readBenchmarkEvents(page, streamedEvents);
      const renderedState = await readRenderedBenchmarkState(page);
      const finalAnswer = findFinalAssistantText(events);
      const report = formatBenchmarkReport(events, {
        promptStartedAt,
        timeoutMs,
        timedOut: completion.timedOut,
        completedBy: completion.completedBy,
        renderedState,
        finalAnswer,
      });
      await testInfo.attach('dashboard-metric-discovery-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('dashboard-metric-discovery-benchmark-events.json', {
        body: JSON.stringify(events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(events, report, finalAnswer);

      console.log(report);

      if (completion.timedOut) {
        throw new Error(`Dashboard metric discovery benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(events);
      if (finalAssistantError) {
        throw new Error(`Dashboard metric discovery benchmark ended with assistant error: ${finalAssistantError}`);
      }

      const qualityError = findQualityError(events, renderedState);
      if (qualityError) {
        throw new Error(`Dashboard metric discovery benchmark failed quality gate: ${qualityError}`);
      }
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(serviceUid)}`).catch(() => undefined);
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(infraUid)}`).catch(() => undefined);
    }
  });
});

async function seedDashboard(page: Page, uid: string, title: string, dashboard: Record<string, unknown>) {
  const response = await page.request.post('/api/dashboards/db', {
    data: {
      dashboard: {
        uid,
        title,
        tags: ['dashboard-metric-discovery-benchmark'],
        timezone: 'browser',
        schemaVersion: 41,
        time: { from: 'now-6h', to: 'now' },
        ...dashboard,
      },
      overwrite: true,
    },
  });
  expect(response).toBeOK();
}

function serviceDashboard(uid: string, title: string) {
  return {
    uid,
    title,
    panels: [
      {
        id: 1,
        title: 'HTTP errors and host load',
        type: 'timeseries',
        datasource: { uid: 'prometheus', type: 'prometheus' },
        gridPos: { x: 0, y: 0, w: 24, h: 8 },
        targets: [
          {
            refId: 'A',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            expr: 'sum by (vm, route, status) (rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
            legendFormat: '{{vm}} {{route}} {{status}}',
          },
          {
            refId: 'B',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            expr: 'avg by(instance) (node_load1{job="node"})',
            legendFormat: '{{instance}} load',
          },
        ],
      },
      {
        id: 2,
        title: 'Route p95 latency',
        type: 'timeseries',
        datasource: { uid: 'prometheus', type: 'prometheus' },
        gridPos: { x: 0, y: 8, w: 24, h: 8 },
        targets: [
          {
            refId: 'A',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            expr: 'histogram_quantile(0.95, sum by (le, vm, route) (rate(http_request_duration_seconds_bucket[$__rate_interval])))',
            legendFormat: '{{vm}} {{route}}',
          },
        ],
      },
    ],
  };
}

function infraDashboard(uid: string, title: string) {
  return {
    uid,
    title,
    panels: [
      {
        id: 1,
        title: 'CPU busy by instance',
        type: 'timeseries',
        datasource: { uid: 'prometheus', type: 'prometheus' },
        gridPos: { x: 0, y: 0, w: 24, h: 8 },
        targets: [
          {
            refId: 'A',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            expr: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])) * 100)',
            legendFormat: '{{instance}} CPU busy',
          },
        ],
      },
    ],
  };
}

async function installBenchmarkRecorder(page: Page) {
  const streamedEvents: BenchmarkEvent[] = [];
  const liveState: LiveBenchmarkState = {
    toolStarts: new Map(),
    toolUpdates: new Map(),
  };

  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    streamedEvents.push(event);
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
  await Promise.all(page.frames().map((frame) => frame.evaluate(installRecorder).catch(() => undefined)));

  return streamedEvents;
}

async function readBenchmarkEvents(page: Page, streamedEvents: BenchmarkEvent[]): Promise<BenchmarkEvent[]> {
  const frameEvents = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(() => {
          const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkEvent[] };
          return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ ?? [];
        })
        .catch(() => [] as BenchmarkEvent[])
    )
  );
  const bestFrameEvents = frameEvents.reduce<BenchmarkEvent[]>(
    (best, events) => (events.length > best.length ? events : best),
    []
  );
  return bestFrameEvents.length > 0 ? bestFrameEvents : streamedEvents;
}

async function waitForBenchmarkCompletion(page: Page, streamedEvents: BenchmarkEvent[], timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const events = await readBenchmarkEvents(page, streamedEvents);
    if (events.some((event) => event.type === 'agent_end')) {
      return { timedOut: false, completedBy: 'agent_end' as const };
    }
    if (hasCompletedQueryAgentEvidence(events)) {
      return { timedOut: false, completedBy: 'tool_evidence' as const };
    }
    const renderedState = await readRenderedBenchmarkState(page);
    if (renderedState.completedQueryAgent) {
      return { timedOut: false, completedBy: 'tool_evidence' as const };
    }
    await page.waitForTimeout(500);
  }

  return { timedOut: true, completedBy: 'timeout' as const };
}

function formatLiveBenchmarkEvent(event: BenchmarkEvent, state: LiveBenchmarkState) {
  if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
    state.toolStarts.set(event.toolCallId, event);
    return `[dashboard-metric-discovery-benchmark:live] tool_start ${event.toolName} args=${summarizeJson(event.args)}`;
  }

  if (event.type === 'tool_execution_update' && event.toolCallId && event.toolName) {
    const nestedCalls = extractNestedToolCallCount(event.partialResult);
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
      `[dashboard-metric-discovery-benchmark:live] tool_update ${event.toolName}`,
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
    const nestedCalls = extractNestedToolCallCount(event.result);
    const resultText = truncateOneLine(extractResultText(event.result) ?? '', event.isError ? 600 : 240);
    return [
      `[dashboard-metric-discovery-benchmark:live] tool_end ${event.toolName} ${status} duration=${duration}`,
      nestedCalls === undefined ? undefined : `nested=${nestedCalls}`,
      resultText ? (event.isError ? `error=${resultText}` : `text=${resultText}`) : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (event.type === 'agent_end') {
    return '[dashboard-metric-discovery-benchmark:live] agent_end';
  }

  return undefined;
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: {
    promptStartedAt: number;
    timeoutMs: number;
    timedOut: boolean;
    completedBy: 'agent_end' | 'tool_evidence' | 'timeout';
    renderedState: RenderedBenchmarkState;
    finalAnswer: string;
  }
) {
  const agentStart = events.find((event) => event.type === 'agent_start')?.timestamp ?? options.promptStartedAt;
  const agentEnd = [...events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const elapsedMs = (agentEnd ?? Date.now()) - agentStart;
  const toolCalls = summarizeToolCalls(events);
  const qualityError = findQualityError(events, options.renderedState);
  const lines = [
    'Dashboard metric discovery benchmark',
    `Timed out: ${options.timedOut ? 'yes' : 'no'}`,
    `Completed by: ${options.completedBy}`,
    `Agent elapsed: ${formatDuration(elapsedMs)}`,
    `Timeout: ${formatDuration(options.timeoutMs)}`,
    `Quality gate: ${qualityError ?? 'passed'}`,
    '',
    'Tool calls',
  ];

  for (const call of toolCalls) {
    lines.push(
      [
        call.name,
        call.status,
        call.durationMs === undefined ? undefined : formatDuration(call.durationMs),
        call.nestedToolCalls?.length ? `${call.nestedToolCalls.length} nested calls` : undefined,
        call.isError ? 'error' : undefined,
      ]
        .filter(Boolean)
        .join(' | ')
    );
    if (call.nestedToolCalls?.length) {
      lines.push(`  nested=${call.nestedToolCalls.map(formatNestedToolCall).join(', ')}`);
    }
    if (call.errorText) {
      lines.push(`  error=${truncateOneLine(call.errorText, 800)}`);
    }
  }

  if (toolCalls.length === 0 && options.renderedState.text.trim()) {
    lines.push(
      '',
      'Rendered query agent state',
      `Completed query agent: ${options.renderedState.completedQueryAgent ? 'yes' : 'no'}`,
      `Completed dashboard metric context: ${options.renderedState.completedDashboardMetricContext ? 'yes' : 'no'}`,
      `Completed Prometheus query: ${options.renderedState.completedPrometheusQuery ? 'yes' : 'no'}`,
      `Failed dashboard metric context: ${options.renderedState.failedDashboardMetricContext ? 'yes' : 'no'}`,
      `Failed Prometheus query: ${options.renderedState.failedPrometheusQuery ? 'yes' : 'no'}`,
      '',
      'Rendered excerpt',
      truncateReportText(options.renderedState.text, 3000)
    );
  }

  const queryAgentResult = toolCalls.find((call) => call.name === 'run_query_agent')?.resultText;
  if (queryAgentResult) {
    lines.push('', 'Query agent result excerpt', truncateReportText(queryAgentResult, 2500));
  }

  if (options.finalAnswer.trim()) {
    lines.push('', 'Final answer', truncateReportText(options.finalAnswer, 2000));
  }

  return lines.join('\n');
}

function hasCompletedQueryAgentEvidence(events: BenchmarkEvent[]) {
  return summarizeToolCalls(events).some((call) => call.name === 'run_query_agent' && call.status === 'completed');
}

async function writeBenchmarkArtifacts(events: BenchmarkEvent[], report: string, finalAnswer: string) {
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'latest-events.json'), JSON.stringify(events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report),
    writeFile(path.join(OUTPUT_DIR, 'latest-answer.md'), finalAnswer),
    writeFile(path.join(OUTPUT_DIR, `events${runSuffix}.json`), JSON.stringify(events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, `report${runSuffix}.txt`), report),
    writeFile(path.join(OUTPUT_DIR, `answer${runSuffix}.md`), finalAnswer),
  ]);
}

function findQualityError(events: BenchmarkEvent[], renderedState?: RenderedBenchmarkState) {
  if (events.length === 0 && renderedState) {
    return findRenderedQualityError(renderedState);
  }

  const toolCalls = summarizeToolCalls(events);
  const queryAgentCalls = toolCalls.filter((call) => call.name === 'run_query_agent');
  if (queryAgentCalls.length !== 1) {
    return `expected exactly one top-level run_query_agent call, got ${queryAgentCalls.length}`;
  }

  const unexpectedTopLevelCall = toolCalls.find((call) => call.name !== 'run_query_agent');
  if (unexpectedTopLevelCall) {
    return `unexpected top-level tool call: ${unexpectedTopLevelCall.name}`;
  }

  const queryAgent = queryAgentCalls[0];
  if (queryAgent.status !== 'completed' || queryAgent.isError) {
    return 'run_query_agent did not complete successfully';
  }

  const nestedCalls = queryAgent.nestedToolCalls ?? [];
  if (nestedCalls.length === 0) {
    return 'run_query_agent did not report nested tool calls';
  }

  const nestedError = nestedCalls.find((call) => call.isError || call.status === 'failed');
  if (nestedError) {
    return `nested tool call failed: ${nestedError.name}`;
  }

  const nestedNames = new Set(nestedCalls.map((call) => call.name));
  if (!nestedNames.has('search_dashboard_metric_usage') && !nestedNames.has('get_metric_neighborhood')) {
    return 'run_query_agent did not use dashboard metric context';
  }
  if (!nestedNames.has('query_prometheus')) {
    return 'run_query_agent did not validate PromQL';
  }

  const forbidden = findForbiddenToolCall(toolCalls);
  if (forbidden) {
    return `read-only benchmark used dashboard write tool: ${forbidden}`;
  }

  const evidenceText = `${queryAgent.resultText ?? ''}\n${findFinalAssistantText(events)}`;
  if (
    /zero related metrics|no matching dashboards|no related metrics|no dashboard-derived relation evidence/i.test(
      evidenceText
    )
  ) {
    return 'dashboard metric context did not find dashboard-derived evidence';
  }
  const expectations = [
    { label: 'http_requests_total', pattern: /\bhttp_requests_total\b/i },
    { label: 'http_request_duration_seconds_bucket', pattern: /\bhttp_request_duration_seconds_bucket\b/i },
    { label: 'node_load1', pattern: /\bnode_load1\b/i },
    { label: 'node_cpu_seconds_total', pattern: /\bnode_cpu_seconds_total\b/i },
    { label: 'dashboard context evidence', pattern: /dashboard|panel|metric context|neighborhood|same panel/i },
    { label: 'validated PromQL', pattern: /rate\(|histogram_quantile|query_prometheus|validated/i },
  ];
  const missing = expectations.filter((expectation) => !expectation.pattern.test(evidenceText));
  if (missing.length > 0) {
    return `evidence is missing ${missing.map((item) => item.label).join(', ')}`;
  }

  return undefined;
}

async function readRenderedBenchmarkState(page: Page): Promise<RenderedBenchmarkState> {
  const text = await page
    .locator('main')
    .first()
    .innerText({ timeout: 1000 })
    .catch(() => '');
  return {
    text,
    completedQueryAgent: /done\s+run_query_agent/i.test(text),
    completedDashboardMetricContext: /Done\s+(search_dashboard_metric_usage|get_metric_neighborhood)/.test(text),
    completedPrometheusQuery: /Done\s+query_prometheus/.test(text),
    failedDashboardMetricContext: /Failed\s+(search_dashboard_metric_usage|get_metric_neighborhood)/.test(text),
    failedPrometheusQuery: /Failed\s+query_prometheus/.test(text),
  };
}

async function expandFailedDashboardMetricToolResults(page: Page) {
  for (const name of [/Failed search_dashboard_metric_usage/i, /Failed get_metric_neighborhood/i]) {
    const groups = await page.getByRole('group', { name }).all();
    for (const group of groups.slice(0, 3)) {
      await group.click({ timeout: 1000 }).catch(() => undefined);
      await page.waitForTimeout(100);
    }
  }
}

function findRenderedQualityError(renderedState: RenderedBenchmarkState) {
  if (!renderedState.completedQueryAgent) {
    return 'rendered run_query_agent did not complete';
  }
  if (renderedState.failedDashboardMetricContext) {
    return 'rendered dashboard metric context tool failed';
  }
  if (renderedState.failedPrometheusQuery) {
    return 'rendered query_prometheus tool failed';
  }
  if (!renderedState.completedDashboardMetricContext) {
    return 'rendered run_query_agent did not use dashboard metric context';
  }
  if (!renderedState.completedPrometheusQuery) {
    return 'rendered run_query_agent did not validate PromQL';
  }
  if (
    /zero related metrics|no matching dashboards|no related metrics|no dashboard-derived relation evidence/i.test(
      renderedState.text
    )
  ) {
    return 'rendered dashboard metric context did not find dashboard-derived evidence';
  }

  const forbidden = [...FORBIDDEN_WRITE_TOOLS].find((toolName) =>
    new RegExp(`Done\\s+${escapeRegExp(toolName)}`).test(renderedState.text)
  );
  if (forbidden) {
    return `read-only benchmark used dashboard write tool: ${forbidden}`;
  }

  const expectations = [
    { label: 'http_requests_total', pattern: /\bhttp_requests_total\b/i },
    { label: 'http_request_duration_seconds_bucket', pattern: /\bhttp_request_duration_seconds_bucket\b/i },
    { label: 'node_load1', pattern: /\bnode_load1\b/i },
    { label: 'node_cpu_seconds_total', pattern: /\bnode_cpu_seconds_total\b/i },
    { label: 'dashboard context evidence', pattern: /dashboard|panel|metric context|neighborhood|same panel/i },
    { label: 'validated PromQL', pattern: /rate\(|histogram_quantile|query_prometheus|validated/i },
  ];
  const missing = expectations.filter((expectation) => !expectation.pattern.test(renderedState.text));
  if (missing.length > 0) {
    return `rendered evidence is missing ${missing.map((item) => item.label).join(', ')}`;
  }

  return undefined;
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
      const resultText = extractResultText(event.result);
      calls.set(event.toolCallId, {
        ...existing,
        status: event.isError ? 'failed' : 'completed',
        endedAt: event.timestamp,
        durationMs: event.timestamp - existing.startedAt,
        isError: event.isError,
        nestedToolCalls: extractNestedToolCalls(event.result) ?? existing.nestedToolCalls,
        resultText,
        errorText: event.isError ? resultText : undefined,
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
    };
  });
}

function extractNestedToolCallCount(result: unknown) {
  return extractNestedToolCalls(result)?.length;
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

function findForbiddenToolCall(toolCalls: ToolCallSummary[]) {
  for (const call of toolCalls) {
    if (FORBIDDEN_WRITE_TOOLS.has(call.name)) {
      return call.name;
    }
    for (const nested of call.nestedToolCalls ?? []) {
      if (FORBIDDEN_WRITE_TOOLS.has(nested.name)) {
        return `${call.name} -> ${nested.name}`;
      }
    }
  }
  return undefined;
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
  return extractContentText(finalAssistantMessage?.content);
}

function extractContentText(content: unknown) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      const record = getRecord(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'boolean' ? value : undefined;
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

function truncateReportText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatNestedToolCall(call: NestedToolCallSummary) {
  return `${call.name}${call.status ? `:${call.status}` : ''}${call.isError ? ':error' : ''}`;
}

function summarizeJson(value: unknown) {
  if (value === undefined) {
    return 'undefined';
  }
  const json = JSON.stringify(value);
  if (!json) {
    return String(value);
  }
  return json.length > 500 ? `${json.slice(0, 500)}...` : json;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
