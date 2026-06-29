import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';

const JQ_FILTER = '.results[] | {query, validationError, totalSeries, series: [.series[]? | {name, labels, last}]}';
const QUERY_AGENT_TASK = [
  'Run one batched query_prometheus call that creates a JSON artifact for the artifact registry.',
  'Use these PromQL queries in the batch:',
  '1. sum by (vm, route) (increase(http_requests_total{status="500"}[6h]))',
  '2. sum by (vm) (increase(http_requests_total{status="500"}[6h]))',
  '3. topk(6, sum by (vm, route) (rate(http_requests_total{status="500"}[5m])))',
  '4. histogram_quantile(0.95, sum by (vm, route, le) (rate(http_request_duration_seconds_bucket[5m])))',
  '5. histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])))',
  '6. node_load1{job="node"}',
  '7. avg_over_time(node_load1{job="node"}[5m])',
  '8. 100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
  'Return a compact note that the query batch ran. Do not call read_artifact yourself.',
].join('\n');
const BENCHMARK_PROMPT = [
  'This is an artifact registry jq e2e check.',
  'Use exactly two top-level tool calls in this order: run_query_agent, then read_artifact.',
  `For run_query_agent, use this exact task:\n${QUERY_AGENT_TASK}`,
  `After run_query_agent returns, call read_artifact with id "artifact_1", mode "jq", and jq filter: ${JQ_FILTER}`,
  'Do not call dashboard tools. Do not use read_artifact mode "full".',
  'Final answer must be one short sentence that says the jq-mode artifact read completed.',
].join('\n\n');
const DEFAULT_TIMEOUT_MS = 180_000;
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
    stopReason?: unknown;
    errorMessage?: unknown;
    content?: unknown;
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
  nestedToolCalls?: NestedToolCallSummary[];
  errorText?: string;
  resultText?: string;
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
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 60_000));

test.describe('agent artifact jq benchmark', () => {
  test('reads a stored Prometheus artifact with jq-wasm', async ({ gotoPage, page }, testInfo) => {
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

    const installRecorder = () => {
      const benchmarkWindow = window as typeof window & {
        __PI_AGENT_BENCHMARK_CAPTURE__?: boolean;
        __PI_AGENT_BENCHMARK_EVENTS__?: unknown[];
        __PI_AGENT_BENCHMARK_RECORD_EVENT__?: (event: unknown) => void;
        __PI_AGENT_BENCHMARK_STREAM_EVENT__?: (event: unknown) => Promise<void>;
      };

      benchmarkWindow.__PI_AGENT_BENCHMARK_CAPTURE__ = true;
      benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
      benchmarkWindow.__PI_AGENT_BENCHMARK_RECORD_EVENT__ = (event: unknown) => {
        benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__?.push(event);
        void benchmarkWindow.__PI_AGENT_BENCHMARK_STREAM_EVENT__?.(event);
      };
    };

    await page.addInitScript(installRecorder);
    await Promise.all(page.frames().map((frame) => frame.evaluate(installRecorder).catch(() => undefined)));

    await gotoPage(`/${ROUTES.Chat}?piAgentBenchmark=1`);
    await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
    await Promise.all(page.frames().map((frame) => frame.evaluate(installRecorder).catch(() => undefined)));

    const composer = page.getByTestId(testIds.chat.composer);
    const send = page.getByTestId(testIds.chat.send);
    await composer.fill(BENCHMARK_PROMPT);
    await expect(send).toBeEnabled();

    const promptStartedAt = Date.now();
    await send.click();

    let timedOut = false;
    try {
      await waitForBenchmarkAgentEnd(page, timeoutMs);
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
    await testInfo.attach('agent-artifact-jq-benchmark-events.json', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('agent-artifact-jq-benchmark-report.txt', {
      body: report,
      contentType: 'text/plain',
    });
    await testInfo.attach('agent-artifact-jq-benchmark-answer.md', {
      body: finalAnswer,
      contentType: 'text/markdown',
    });
    await writeBenchmarkArtifacts(events, report, finalAnswer);

    console.log(report);

    if (timedOut) {
      throw new Error(`Agent artifact jq benchmark timed out after ${timeoutMs}ms.`);
    }

    const finalAssistantError = findFinalAssistantError(events);
    if (finalAssistantError) {
      throw new Error(`Agent artifact jq benchmark ended with assistant error: ${finalAssistantError}`);
    }

    const qualityError = findArtifactJqQualityError(events);
    if (qualityError) {
      throw new Error(`Agent artifact jq benchmark failed quality gate: ${qualityError}`);
    }
  });
});

async function readBenchmarkEvents(page: Page): Promise<BenchmarkEvent[]> {
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

  return frameEvents.flat();
}

async function waitForBenchmarkAgentEnd(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readBenchmarkEvents(page);
    if (events.some((event) => event.type === 'agent_end')) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Agent artifact jq benchmark timed out after ${timeoutMs}ms.`);
}

function formatLiveBenchmarkEvent(event: BenchmarkEvent, state: LiveBenchmarkState) {
  if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
    state.toolStarts.set(event.toolCallId, event);
    return `[artifact-jq-benchmark:live] tool_start ${event.toolName} args=${summarizeJson(event.args)}`;
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

    const parts = [`[artifact-jq-benchmark:live] tool_update ${event.toolName}`];
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
    const nestedCalls = extractNestedToolCalls(event.result)?.length;
    const resultText = truncateOneLine(extractResultText(event.result) ?? '', event.isError ? 600 : 240);
    const parts = [`[artifact-jq-benchmark:live] tool_end ${event.toolName} ${status} duration=${duration}`];
    if (nestedCalls !== undefined) {
      parts.push(`nested=${nestedCalls}`);
    }
    if (resultText) {
      parts.push(event.isError ? `error=${resultText}` : `text=${resultText}`);
    }
    return parts.join(' ');
  }

  if (event.type === 'agent_end') {
    return '[artifact-jq-benchmark:live] agent_end';
  }

  return undefined;
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: { promptStartedAt: number; timeoutMs: number; timedOut: boolean; finalAnswer: string }
) {
  const agentStart = events.find((event) => event.type === 'agent_start')?.timestamp ?? options.promptStartedAt;
  const agentEnd = [...events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const elapsedMs = (agentEnd ?? Date.now()) - agentStart;
  const toolCalls = summarizeToolCalls(events);
  const qualityError = options.timedOut ? undefined : findArtifactJqQualityError(events);
  const lines = [
    '',
    'Agent artifact jq benchmark report',
    `Prompt: ${BENCHMARK_PROMPT}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    `Timeout: ${formatDuration(options.timeoutMs)}`,
    `Status: ${options.timedOut ? 'timed out' : qualityError ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration(elapsedMs)}`,
    `Quality gate: ${options.timedOut ? 'not run' : qualityError ? `failed: ${qualityError}` : 'passed'}`,
    `Events: ${events.length}`,
    `Tool calls: ${toolCalls.length}`,
  ];

  if (toolCalls.length > 0) {
    lines.push('', 'Tool call timeline');
    for (const [index, call] of toolCalls.entries()) {
      const parts = [
        `${index + 1}. ${call.name}`,
        call.status,
        call.durationMs === undefined ? 'duration pending' : formatDuration(call.durationMs),
      ];
      if (call.nestedToolCalls?.length) {
        parts.push(`${call.nestedToolCalls.length} nested calls`);
      }
      if (call.isError) {
        parts.push('error');
      }

      lines.push(parts.join(' | '));
      lines.push(`   id=${call.id}`);
      lines.push(`   args=${summarizeJson(call.args)}`);
      if (call.nestedToolCalls?.length) {
        lines.push(`   nested=${call.nestedToolCalls.map(formatNestedToolCall).join(', ')}`);
      }
      if (call.resultText) {
        lines.push(`   result=${truncateReportText(call.resultText, 1000)}`);
      }
      if (call.errorText) {
        lines.push(`   error=${call.errorText}`);
      }
    }
  }

  if (options.finalAnswer.trim()) {
    lines.push('', 'Final answer', truncateReportText(options.finalAnswer, 1500));
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
        nestedToolCalls: extractNestedToolCalls(event.partialResult) ?? existing.nestedToolCalls,
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
        nestedToolCalls: extractNestedToolCalls(event.result) ?? existing.nestedToolCalls,
        errorText: event.isError ? extractResultText(event.result) : undefined,
        resultText: extractResultText(event.result),
      });
    }
  }

  return [...calls.values()].sort((left, right) => left.startedAt - right.startedAt);
}

function findArtifactJqQualityError(events: BenchmarkEvent[]) {
  const toolCalls = summarizeToolCalls(events);
  const queryAgent = toolCalls.find((call) => call.name === 'run_query_agent');
  if (!queryAgent || queryAgent.status !== 'completed' || queryAgent.isError) {
    return 'run_query_agent did not complete successfully';
  }

  const jqRead = toolCalls.find((call) => call.name === 'read_artifact' && isJqArtifactReadArgs(call.args));
  if (!jqRead || jqRead.status !== 'completed' || jqRead.isError) {
    return 'read_artifact jq call did not complete successfully';
  }

  const unexpected = toolCalls.find((call) => call.name !== 'run_query_agent' && call.name !== 'read_artifact');
  if (unexpected) {
    return `unexpected top-level tool call: ${unexpected.name}`;
  }

  const forbidden = findForbiddenToolCall(toolCalls);
  if (forbidden) {
    return `read-only jq benchmark used dashboard write tool: ${forbidden}`;
  }

  if (!hasArtifactizedPrometheusQuery(queryAgent)) {
    return 'run_query_agent did not produce an artifactized query_prometheus result';
  }

  const jqText = jqRead.resultText ?? '';
  if (!/query/.test(jqText) || !/totalSeries|validationError|series/.test(jqText)) {
    return 'jq read result did not contain projected artifact fields';
  }

  return undefined;
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

function hasArtifactizedPrometheusQuery(call: ToolCallSummary) {
  return call.nestedToolCalls?.some((nested) => {
    const details = getRecord(getRecord(nested.result)?.details);
    return nested.name === 'query_prometheus' && nested.status === 'completed' && Boolean(details?.artifactRef);
  });
}

function isJqArtifactReadArgs(args: unknown) {
  const record = getRecord(args);
  return record?.mode === 'jq' || typeof record?.jq === 'string';
}

async function writeBenchmarkArtifacts(events: BenchmarkEvent[], report: string, finalAnswer: string) {
  const outputDir = path.join(process.cwd(), 'test-results', 'artifact-jq-benchmark');
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

function truncateReportText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
