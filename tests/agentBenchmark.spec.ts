import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import type { Page } from '@playwright/test';

const BENCHMARK_PROMPT = 'Create a dashboard for HTTP request rate and errors';
const DEFAULT_TIMEOUT_MS = 120_000;

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
    usage?: unknown;
  };
  messageCount?: number;
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
  subagentToolCalls?: number;
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

type LiveBenchmarkState = {
  toolStarts: Map<string, BenchmarkEvent>;
  toolUpdates: Map<string, string>;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 60_000));

test.describe('agent benchmark', () => {
  test('creates an HTTP request rate and errors dashboard', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
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

    await page.addInitScript(() => {
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
    await testInfo.attach('agent-benchmark-events.json', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    });

    const report = formatBenchmarkReport(events, { promptStartedAt, timeoutMs, timedOut });
    await testInfo.attach('agent-benchmark-report.txt', {
      body: report,
      contentType: 'text/plain',
    });
    await writeBenchmarkArtifacts(events, report);

    console.log(report);

    if (timedOut) {
      throw new Error(`Agent benchmark timed out after ${timeoutMs}ms.`);
    }

    const finalAssistantError = findFinalAssistantError(events);
    if (finalAssistantError) {
      throw new Error(`Agent benchmark ended with assistant error: ${finalAssistantError}`);
    }

    const qualityError = findDashboardQualityError(events);
    if (qualityError) {
      throw new Error(`Agent benchmark failed quality gate: ${qualityError}`);
    }
  });
});

async function readBenchmarkEvents(page: Page): Promise<BenchmarkEvent[]> {
  return page.evaluate(() => {
    const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkEvent[] };
    return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ ?? [];
  });
}

function formatLiveBenchmarkEvent(event: BenchmarkEvent, state: LiveBenchmarkState) {
  if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
    state.toolStarts.set(event.toolCallId, event);
    return `[agent-benchmark:live] tool_start ${event.toolName} args=${summarizeJson(event.args)}`;
  }

  if (event.type === 'tool_execution_update' && event.toolCallId && event.toolName) {
    const nestedCalls = extractSubagentToolCallCount(event.partialResult);
    const resultText = truncateOneLine(extractResultText(event.partialResult) ?? '', 240);
    if (nestedCalls === undefined && !resultText) {
      return undefined;
    }

    const updateKey = `${nestedCalls ?? ''}|${resultText}`;
    if (state.toolUpdates.get(event.toolCallId) === updateKey) {
      return undefined;
    }
    state.toolUpdates.set(event.toolCallId, updateKey);

    const parts = [`[agent-benchmark:live] tool_update ${event.toolName}`];
    if (nestedCalls !== undefined) {
      parts.push(`nested=${nestedCalls}`);
    }
    if (resultText) {
      parts.push(`text=${resultText}`);
    }
    return parts.join(' ');
  }

  if (event.type === 'tool_execution_end' && event.toolCallId && event.toolName) {
    const start = state.toolStarts.get(event.toolCallId);
    const duration = start ? formatDuration(event.timestamp - start.timestamp) : 'unknown';
    const status = event.isError ? 'failed' : 'completed';
    const nestedCalls = extractSubagentToolCallCount(event.result);
    const resultText = truncateOneLine(extractResultText(event.result) ?? '', event.isError ? 600 : 240);
    const parts = [`[agent-benchmark:live] tool_end ${event.toolName} ${status} duration=${duration}`];
    if (nestedCalls !== undefined) {
      parts.push(`nested=${nestedCalls}`);
    }
    if (resultText) {
      parts.push(event.isError ? `error=${resultText}` : `text=${resultText}`);
    }
    return parts.join(' ');
  }

  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const error = event.message.errorMessage;
    if (typeof error === 'string' && error) {
      return `[agent-benchmark:live] assistant_error ${truncateOneLine(error, 600)}`;
    }
  }

  if (event.type === 'agent_end') {
    return '[agent-benchmark:live] agent_end';
  }

  return undefined;
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: { promptStartedAt: number; timeoutMs: number; timedOut: boolean }
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
  const qualityError = options.timedOut ? undefined : findDashboardQualityError(events);
  const lines = [
    '',
    'Agent benchmark report',
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
      if (call.subagentToolCalls !== undefined) {
        parts.push(`${call.subagentToolCalls} nested calls`);
      }
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

    if (event.type === 'tool_execution_update') {
      calls.set(event.toolCallId, {
        ...existing,
        args: event.args ?? existing.args,
        subagentToolCalls: extractSubagentToolCallCount(event.partialResult) ?? existing.subagentToolCalls,
      });
      continue;
    }

    if (event.type === 'tool_execution_end') {
      const durationMs = event.timestamp - existing.startedAt;
      calls.set(event.toolCallId, {
        ...existing,
        status: event.isError ? 'failed' : 'completed',
        endedAt: event.timestamp,
        durationMs,
        isError: event.isError,
        subagentToolCalls: extractSubagentToolCallCount(event.result) ?? existing.subagentToolCalls,
        errorText: event.isError ? extractResultText(event.result) : undefined,
        resultTextBytes: extractResultText(event.result)?.length,
      });
    }
  }

  return [...calls.values()].sort((left, right) => left.startedAt - right.startedAt);
}

async function writeBenchmarkArtifacts(events: BenchmarkEvent[], report: string) {
  const outputDir = path.join(process.cwd(), 'test-results', 'agent-benchmark');
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'latest-events.json'), JSON.stringify(events, null, 2)),
    writeFile(path.join(outputDir, 'latest-report.txt'), report),
    writeFile(path.join(outputDir, `events${runSuffix}.json`), JSON.stringify(events, null, 2)),
    writeFile(path.join(outputDir, `report${runSuffix}.txt`), report),
  ]);
}

function extractSubagentToolCallCount(result: unknown) {
  const details = getRecord(getRecord(result)?.details);
  const toolCalls = details?.toolCalls;
  return Array.isArray(toolCalls) ? toolCalls.length : undefined;
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

function findDashboardQualityError(events: BenchmarkEvent[]) {
  const designed = [...events]
    .reverse()
    .find((event) => event.type === 'tool_execution_end' && event.toolName === 'design_dashboard' && !event.isError);
  if (!designed) {
    return 'design_dashboard did not complete successfully';
  }

  const synced = [...events]
    .reverse()
    .find((event) => event.type === 'tool_execution_end' && event.toolName === 'sync_dashboard' && !event.isError);
  if (!synced) {
    return 'sync_dashboard did not complete successfully';
  }

  const rendered = [...events]
    .reverse()
    .find((event) => event.type === 'tool_execution_end' && event.toolName === 'render_dashboard' && !event.isError);
  const details = getRecord(getRecord(rendered?.result)?.details);
  const dashboard = getRecord(details?.dashboard);
  if (!dashboard) {
    return 'render_dashboard did not return a dashboard summary';
  }

  const panels = recordsField(dashboard, 'panels');
  if (panels.length < 2) {
    return `expected at least 2 panels, got ${panels.length}`;
  }

  const panelText = JSON.stringify(panels).toLowerCase();
  if (!panelText.includes('rate(')) {
    return 'dashboard panels do not include a rate() query';
  }
  if (
    !panelText.includes('error') &&
    !panelText.includes('5..') &&
    !panelText.includes('4..') &&
    !panelText.includes('status')
  ) {
    return 'dashboard panels do not include an error/status signal';
  }

  return undefined;
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

function recordsField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return Array.isArray(value)
    ? value.map(getRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
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
  return json.length > 500 ? `${json.slice(0, 500)}...` : json;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
