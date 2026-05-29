import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import type { Page } from '@playwright/test';

const BENCHMARK_PROMPT = [
  'Analyze the last 6 hours of the demo InfluxDB v1 data and summarize what is wrong.',
  'Use only list_influx_datasources and query_influx for data access; do not use Prometheus, rqlite, or dashboard tools.',
  'Use InfluxQL against datasource influx-v1. Useful measurements are http_requests_total, http_request_duration_seconds_sum, http_request_duration_seconds_count, node_load1, and node_cpu_seconds_total.',
  'Use at most six tool calls. Prefer grouped InfluxQL queries for 500s by vm/route/status, latency, node_load1, and CPU.',
  'Final answer must be exactly five short bullets: finding, affected host, affected route/status, CPU/load/latency corroboration, validated InfluxQL.',
].join(' ');

const DEFAULT_TIMEOUT_MS = 120_000;
const FORBIDDEN_TOOLS = new Set([
  'query_prometheus',
  'query_prometheus_raw',
  'query_rqlite',
  'write_jsonnet',
  'edit_jsonnet',
  'fix_jsonnet',
  'render_dashboard',
  'sync_dashboard',
  'upload_dashboard',
  'delete_dashboard',
]);

type BenchmarkEvent = {
  type: string;
  timestamp: number;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: {
    role?: unknown;
    errorMessage?: unknown;
    content?: unknown;
    usage?: unknown;
  };
  messageCount?: number;
};

type ToolCallSummary = {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  durationMs?: number;
  args?: unknown;
  isError?: boolean;
  errorText?: string;
  resultTextBytes?: number;
};

type BenchmarkUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 60_000));

test.describe('agent InfluxDB analysis benchmark', () => {
  test('analyzes the demo InfluxDB incident without using other datasource tools', async ({
    gotoPage,
    page,
  }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

    await page.addInitScript(() => {
      const benchmarkWindow = window as typeof window & {
        __PI_AGENT_BENCHMARK_EVENTS__?: unknown[];
        __PI_AGENT_BENCHMARK_RECORD_EVENT__?: (event: unknown) => void;
      };

      benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
      benchmarkWindow.__PI_AGENT_BENCHMARK_RECORD_EVENT__ = (event: unknown) => {
        benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__?.push(event);
      };
    });

    await gotoPage(`/${ROUTES.Chat}`);
    await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();

    const composer = page.getByTestId(testIds.chat.composer);
    const send = page.getByTestId(testIds.chat.send);
    await composer.fill(BENCHMARK_PROMPT);
    await expect(send).toBeEnabled();

    const promptStartedAt = Date.now();
    await send.click();

    let timedOut = false;
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
    }

    const events = await readBenchmarkEvents(page);
    const finalAnswer = findFinalAssistantText(events);
    const report = formatBenchmarkReport(events, { promptStartedAt, timeoutMs, timedOut, finalAnswer });

    await testInfo.attach('agent-influx-analysis-benchmark-events.json', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('agent-influx-analysis-benchmark-answer.md', {
      body: finalAnswer,
      contentType: 'text/markdown',
    });
    await testInfo.attach('agent-influx-analysis-benchmark-report.txt', {
      body: report,
      contentType: 'text/plain',
    });
    await writeBenchmarkArtifacts(events, report, finalAnswer);

    console.log(report);

    if (timedOut) {
      throw new Error(`Agent InfluxDB analysis benchmark timed out after ${timeoutMs}ms.`);
    }

    const finalAssistantError = findFinalAssistantError(events);
    if (finalAssistantError) {
      throw new Error(`Agent InfluxDB analysis benchmark ended with assistant error: ${finalAssistantError}`);
    }

    const qualityError = findInfluxAnalysisQualityError(events);
    if (qualityError) {
      throw new Error(`Agent InfluxDB analysis benchmark failed quality gate: ${qualityError}`);
    }
  });
});

async function readBenchmarkEvents(page: Page): Promise<BenchmarkEvent[]> {
  return page.evaluate(() => {
    const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkEvent[] };
    return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ ?? [];
  });
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: { promptStartedAt: number; timeoutMs: number; timedOut: boolean; finalAnswer: string }
) {
  const agentStart = events.find((event) => event.type === 'agent_start')?.timestamp ?? options.promptStartedAt;
  const agentEnd = [...events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const elapsedMs = (agentEnd ?? Date.now()) - agentStart;
  const toolCalls = summarizeToolCalls(events);
  const toolWallMs = toolCalls.reduce((total, call) => total + (call.durationMs ?? 0), 0);
  const firstToolStart = toolCalls[0]?.startedAt;
  const assistantTurns = events.filter(
    (event) => event.type === 'message_end' && event.message?.role === 'assistant'
  ).length;
  const messageCount = [...events].reverse().find((event) => typeof event.messageCount === 'number')?.messageCount;
  const usage = summarizeUsage(events);
  const finalAssistantError = findFinalAssistantError(events);
  const qualityError = options.timedOut ? undefined : findInfluxAnalysisQualityError(events);
  const lines = [
    '',
    'Agent InfluxDB analysis benchmark report',
    `Prompt: ${BENCHMARK_PROMPT}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    `Timeout: ${formatDuration(options.timeoutMs)}`,
    `Status: ${options.timedOut ? 'timed out' : finalAssistantError ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration(elapsedMs)}`,
    `Time to first tool: ${firstToolStart ? formatDuration(firstToolStart - agentStart) : 'none'}`,
    `Tool wall time: ${formatDuration(toolWallMs)}`,
    `Non-tool time: ${formatDuration(Math.max(0, elapsedMs - toolWallMs))}`,
    `Assistant turns: ${assistantTurns}`,
    `Messages: ${messageCount ?? 'unknown'}`,
    `Token usage: input=${usage.input}, output=${usage.output}, cacheRead=${usage.cacheRead}, cacheWrite=${usage.cacheWrite}, total=${usage.totalTokens}`,
    `Quality gate: ${options.timedOut ? 'not run' : qualityError ? `failed: ${qualityError}` : 'passed'}`,
    `Events: ${events.length}`,
    `Tool calls: ${toolCalls.length}`,
  ];

  if (finalAssistantError) {
    lines.push(`Assistant error: ${finalAssistantError}`);
  }

  if (toolCalls.length > 0) {
    lines.push('', 'Tool call timeline');
    for (const [index, call] of toolCalls.entries()) {
      const parts = [
        `${index + 1}. ${call.name}`,
        call.status,
        call.durationMs === undefined ? 'duration pending' : formatDuration(call.durationMs),
      ];
      if (call.resultTextBytes !== undefined) {
        parts.push(`${call.resultTextBytes} result bytes`);
      }
      if (call.isError) {
        parts.push('error');
      }

      lines.push(parts.join(' | '));
      lines.push(`   id=${call.id}`);
      lines.push(`   args=${summarizeJson(call.args)}`);
      if (call.errorText) {
        lines.push(`   error=${call.errorText}`);
      }
    }
  }

  if (options.finalAnswer.trim()) {
    lines.push('', 'Final answer', truncateReportText(options.finalAnswer, 3000));
  }

  return lines.join('\n');
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

    if (event.type === 'tool_execution_end') {
      calls.set(event.toolCallId, {
        ...existing,
        status: event.isError ? 'failed' : 'completed',
        durationMs: event.timestamp - existing.startedAt,
        isError: event.isError,
        errorText: event.isError ? extractResultText(event.result) : undefined,
        resultTextBytes: extractResultText(event.result)?.length,
      });
    }
  }

  return [...calls.values()].sort((left, right) => left.startedAt - right.startedAt);
}

async function writeBenchmarkArtifacts(events: BenchmarkEvent[], report: string, finalAnswer: string) {
  const outputDir = path.join(process.cwd(), 'test-results', 'influx-analysis-benchmark');
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'latest-events.json'), JSON.stringify(events, null, 2)),
    writeFile(path.join(outputDir, 'latest-report.txt'), report),
    writeFile(path.join(outputDir, 'latest-answer.md'), finalAnswer),
    writeFile(path.join(outputDir, `events${runSuffix}.json`), JSON.stringify(events, null, 2)),
    writeFile(path.join(outputDir, `report${runSuffix}.txt`), report),
    writeFile(path.join(outputDir, `answer${runSuffix}.md`), finalAnswer),
  ]);
}

function findInfluxAnalysisQualityError(events: BenchmarkEvent[]) {
  const forbidden = findForbiddenToolCall(events);
  if (forbidden) {
    return `InfluxDB benchmark used forbidden tool: ${forbidden}`;
  }

  if (!hasCompletedInfluxQuery(events)) {
    return 'no completed query_influx evidence was found';
  }

  const answer = findFinalAssistantText(events);
  if (!answer.trim()) {
    return 'final assistant answer is empty';
  }

  const expectations = [
    { label: 'affected host vm-web-01', pattern: /\bvm-web-01\b/i },
    { label: 'route /render/report', pattern: /\/render\/report/i },
    { label: 'HTTP 500 or 5xx status', pattern: /(500|5xx|5\.\.|status=["']?500)/i },
    { label: 'CPU, load, or latency corroboration', pattern: /(cpu|load|latenc|duration|node_load1|node_cpu)/i },
    { label: 'validated InfluxQL or measurement names', pattern: /(influxql|select|http_requests_total|node_load1)/i },
  ];
  const missing = expectations.filter((expectation) => !expectation.pattern.test(answer));
  if (missing.length > 0) {
    return `final answer is missing ${missing.map((item) => item.label).join(', ')}`;
  }

  return undefined;
}

function findForbiddenToolCall(events: BenchmarkEvent[]) {
  for (const call of summarizeToolCalls(events)) {
    if (FORBIDDEN_TOOLS.has(call.name)) {
      return call.name;
    }
  }
  return undefined;
}

function hasCompletedInfluxQuery(events: BenchmarkEvent[]) {
  return summarizeToolCalls(events).some(
    (call) => call.name === 'query_influx' && call.status === 'completed' && !call.isError
  );
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

function summarizeUsage(events: BenchmarkEvent[]): BenchmarkUsage {
  const total = zeroUsage();
  for (const event of events) {
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') {
      continue;
    }
    const usage = getRecord(event.message.usage);
    if (!usage) {
      continue;
    }
    total.input += numericField(usage, 'input');
    total.output += numericField(usage, 'output');
    total.cacheRead += numericField(usage, 'cacheRead');
    total.cacheWrite += numericField(usage, 'cacheWrite');
    total.totalTokens += numericField(usage, 'totalTokens');
    const cost = usage.cost;
    total.cost += typeof cost === 'number' ? cost : numericField(getRecord(cost), 'total');
  }
  if (total.totalTokens === 0) {
    total.totalTokens = total.input + total.output + total.cacheRead + total.cacheWrite;
  }
  return total;
}

function zeroUsage(): BenchmarkUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function numericField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
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

function truncateReportText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
