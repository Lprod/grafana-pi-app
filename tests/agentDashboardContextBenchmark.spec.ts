import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import type { Page } from '@playwright/test';

const DEFAULT_TIMEOUT_MS = 240_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'dashboard-context-benchmark');

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
    stopReason?: unknown;
    errorMessage?: unknown;
    content?: unknown;
  };
  messageCount?: number;
};

type BenchmarkRun = {
  name: 'rich';
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
  errorText?: string;
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
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS * 2 + 90_000));

test.describe('dashboard context benchmark', () => {
  test('repairs a stale dashboard using rich dashboard context', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const sourceUid = `ctx-bench-stale-${suffix}`;
    const fixedUid = `ctx-bench-rich-${suffix}`;
    const sourceTitle = `Context Benchmark Stale ${suffix}`;
    const fixedTitle = `Context Benchmark Rich ${suffix}`;

    await seedStaleDashboard(page, sourceUid, sourceTitle);

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await installBenchmarkRecorder(page);

      const richPrompt = [
        'This benchmark validates the rich dashboard context repair path.',
        'Use exactly one run_dashboard_agent top-level tool call.',
        `Ask the dashboard agent to repair existing dashboard UID ${sourceUid} into an editable Jsonnet dashboard titled "${fixedTitle}" with UID ${fixedUid}.`,
        'The dashboard agent must inspect the existing dashboard with inspect_dashboard_context using validateQueries=true before writing the replacement.',
        'It should use the validation evidence to replace stale metric and label names with the demo Prometheus schema: http_requests_total, route, status, vm, and http_request_duration_seconds_bucket.',
        'It must write Jsonnet, render_dashboard, then save_dashboard with overwrite=true.',
        'The repaired dashboard should include request rate, HTTP 5xx/error signal, and p95 latency panels for /render/report over the last 6 hours.',
      ].join(' ');

      const richRun = await runPrompt({
        page,
        prompt: richPrompt,
        name: 'rich',
        timeoutMs,
      });

      const report = formatBenchmarkReport(richRun, { sourceUid, fixedUid });
      await testInfo.attach('dashboard-context-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('dashboard-context-benchmark-rich-events.json', {
        body: JSON.stringify(richRun.events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(richRun, report);

      console.log(report);

      if (richRun.timedOut) {
        throw new Error(`Rich dashboard context benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(richRun.events);
      if (finalAssistantError) {
        throw new Error(`Rich dashboard context benchmark ended with assistant error: ${finalAssistantError}`);
      }

      const qualityError = findRichQualityError(richRun, fixedUid);
      if (qualityError) {
        throw new Error(`Rich dashboard context benchmark failed quality gate: ${qualityError}`);
      }
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(sourceUid)}`).catch(() => undefined);
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(fixedUid)}`).catch(() => undefined);
    }
  });
});

async function seedStaleDashboard(page: Page, uid: string, title: string) {
  const response = await page.request.post('/api/dashboards/db', {
    data: {
      dashboard: {
        uid,
        title,
        tags: ['dashboard-context-benchmark', 'stale'],
        timezone: 'browser',
        schemaVersion: 41,
        time: { from: 'now-6h', to: 'now' },
        templating: {
          list: [
            {
              name: 'route',
              type: 'custom',
              query: '/,/api/orders,/render/report',
              current: { text: '/render/report', value: '/render/report' },
              options: [
                { text: '/', value: '/' },
                { text: '/api/orders', value: '/api/orders' },
                { text: '/render/report', value: '/render/report', selected: true },
              ],
            },
          ],
        },
        panels: [
          {
            id: 1,
            title: 'Request rate by path',
            type: 'timeseries',
            description: 'Intentionally stale: metric and path label no longer match demo Prometheus data.',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            gridPos: { x: 0, y: 0, w: 24, h: 8 },
            fieldConfig: { defaults: { unit: 'bytes' }, overrides: [] },
            targets: [
              {
                refId: 'A',
                datasource: { uid: 'prometheus', type: 'prometheus' },
                expr: 'sum by (path) (rate(http_request_total{job="web",path="$route"}[$__rate_interval]))',
                legendFormat: '{{path}}',
              },
            ],
          },
          {
            id: 2,
            title: 'HTTP error ratio by path',
            type: 'timeseries',
            description: 'Intentionally stale: status_code/path labels are wrong for the demo data.',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            gridPos: { x: 0, y: 8, w: 24, h: 8 },
            fieldConfig: { defaults: { unit: 'percentunit' }, overrides: [] },
            targets: [
              {
                refId: 'A',
                datasource: { uid: 'prometheus', type: 'prometheus' },
                expr: 'sum by (vm,path) (rate(http_request_total{job="web",path="$route",status_code=~"5.."}[$__rate_interval])) / clamp_min(sum by (vm,path) (rate(http_request_total{job="web",path="$route"}[$__rate_interval])), 1e-9)',
                legendFormat: '{{vm}} {{path}}',
              },
            ],
          },
          {
            id: 3,
            title: 'p95 latency',
            type: 'timeseries',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            gridPos: { x: 0, y: 16, w: 24, h: 8 },
            fieldConfig: { defaults: { unit: 's' }, overrides: [] },
            targets: [
              {
                refId: 'A',
                datasource: { uid: 'prometheus', type: 'prometheus' },
                expr: 'histogram_quantile(0.95, sum by (le, vm, route) (rate(http_request_duration_seconds_bucket{job="web",route="$route"}[$__rate_interval])))',
                legendFormat: '{{vm}} {{route}}',
              },
            ],
          },
        ],
      },
      overwrite: true,
    },
  });
  expect(response).toBeOK();
}

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

  await resetBenchmarkEvents(page);
}

async function runPrompt({
  page,
  prompt,
  name,
  timeoutMs,
}: {
  page: Page;
  prompt: string;
  name: BenchmarkRun['name'];
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
    name,
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

function formatBenchmarkReport(run: BenchmarkRun, ids: { sourceUid: string; fixedUid: string }) {
  const report = summarizeRun(run);
  const lines = [
    '',
    'Dashboard context benchmark report',
    `Source dashboard UID: ${ids.sourceUid}`,
    `Expected output UID: ${ids.fixedUid}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    '',
    'Rich context repair',
    `Prompt: ${run.prompt}`,
    `Status: ${run.timedOut ? 'timed out' : findFinalAssistantError(run.events) ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration(report.elapsedMs)}`,
    `Time to first tool: ${report.firstToolStart ? formatDuration(report.firstToolStart - report.agentStart) : 'none'}`,
    `Tool calls: ${report.toolCalls.length}`,
    `Assistant error: ${findFinalAssistantError(run.events) ?? 'none'}`,
    `Quality: ${findRichQualityError(run, ids.fixedUid) ?? 'passed'}`,
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

function findRichQualityError(run: BenchmarkRun, expectedUid: string) {
  const nested = dashboardNestedCalls(run);
  if (nested.length === 0) {
    return 'run_dashboard_agent did not complete with nested tool calls';
  }

  const context = nested.find((call) => call.name === 'inspect_dashboard_context' && call.status === 'completed');
  if (!context) {
    return 'dashboard agent did not complete inspect_dashboard_context';
  }
  if (!richContextHadStaleEvidence(nested)) {
    return 'inspect_dashboard_context did not report failed or zero-series stale query evidence';
  }

  const rendered = [...nested]
    .reverse()
    .find((call) => call.name === 'render_dashboard' && call.status === 'completed' && !call.isError);
  if (!rendered) {
    return 'dashboard agent did not complete render_dashboard';
  }

  const saved = [...nested]
    .reverse()
    .find((call) => call.name === 'save_dashboard' && call.status === 'completed' && !call.isError);
  if (!saved) {
    return 'dashboard agent did not complete save_dashboard';
  }

  const saveDetails = getRecord(getRecord(saved.result)?.details);
  if (stringField(saveDetails, 'uid') !== expectedUid) {
    return `save_dashboard wrote UID ${stringField(saveDetails, 'uid') ?? 'unknown'} instead of ${expectedUid}`;
  }

  const dashboard = getRecord(getRecord(getRecord(rendered.result)?.details)?.dashboard);
  const panels = recordsField(dashboard, 'panels');
  if (panels.length < 3) {
    return `expected at least 3 rendered panels, got ${panels.length}`;
  }

  const panelText = JSON.stringify(panels);
  if (panelText.includes('http_request_total')) {
    return 'rendered dashboard still references stale http_request_total metric';
  }
  if (panelText.includes('path=') || panelText.includes('status_code')) {
    return 'rendered dashboard still references stale path/status_code labels';
  }
  if (!panelText.includes('http_requests_total') || !panelText.includes('route') || !panelText.includes('status')) {
    return 'rendered dashboard does not include corrected HTTP request metric and labels';
  }
  if (!panelText.includes('http_request_duration_seconds_bucket') || !panelText.includes('histogram_quantile')) {
    return 'rendered dashboard does not include p95 latency histogram query';
  }

  return undefined;
}

function richContextHadStaleEvidence(nested: NestedToolCallSummary[]) {
  const context = nested.find((call) => call.name === 'inspect_dashboard_context');
  const details = getRecord(getRecord(context?.result)?.details);
  const validation = getRecord(details?.validation);
  return numericField(validation, 'failedQueries') > 0 || numericField(validation, 'zeroSeriesQueries') > 0;
}

function dashboardNestedCalls(run: BenchmarkRun) {
  const dashboardCall = summarizeToolCalls(run.events)
    .reverse()
    .find((call) => call.name === 'run_dashboard_agent' && call.status === 'completed' && !call.isError);
  return dashboardCall?.nestedToolCalls ?? [];
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
        errorText: event.isError ? extractResultText(event.result) : undefined,
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

async function writeBenchmarkArtifacts(run: BenchmarkRun, report: string) {
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report),
    writeFile(path.join(OUTPUT_DIR, 'latest-rich-events.json'), JSON.stringify(run.events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, 'latest-rich-answer.md'), run.finalAnswer),
    writeFile(path.join(OUTPUT_DIR, `report${runSuffix}.txt`), report),
    writeFile(path.join(OUTPUT_DIR, `rich-events${runSuffix}.json`), JSON.stringify(run.events, null, 2)),
  ]);
}

function formatLiveBenchmarkEvent(event: BenchmarkEvent, state: LiveBenchmarkState) {
  if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
    state.toolStarts.set(event.toolCallId, event);
    return `[dashboard-context-benchmark:live] tool_start ${event.toolName} args=${summarizeJson(event.args)}`;
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
      `[dashboard-context-benchmark:live] tool_update ${event.toolName}`,
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
      `[dashboard-context-benchmark:live] tool_end ${event.toolName} ${status} duration=${duration}`,
      nestedCalls === undefined ? undefined : `nested=${nestedCalls}`,
      resultText ? (event.isError ? `error=${resultText}` : `text=${resultText}`) : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const error = event.message.errorMessage;
    if (typeof error === 'string' && error) {
      return `[dashboard-context-benchmark:live] assistant_error ${truncateOneLine(error, 600)}`;
    }
  }

  if (event.type === 'agent_end') {
    return '[dashboard-context-benchmark:live] agent_end';
  }

  return undefined;
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function numericField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
