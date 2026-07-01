import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { testIds } from '../src/components/testIds';

const DEFAULT_TIMEOUT_MS = 240_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'agent-contract-sample-benchmark');

type BenchmarkEvent = {
  type: string;
  timestamp: number;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    content?: unknown;
  };
};

type BenchmarkRun = {
  prompt: string;
  events: BenchmarkEvent[];
  domTranscript: string;
  finalAnswer: string;
  timeoutMs: number;
  timedOut: boolean;
  finishReason: 'agent_event' | 'dom_success' | 'timeout';
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 90_000));

test.describe('coding-agent contract sample benchmark', () => {
  test('edits, validates, previews, and saves the sample resource workspace', async ({ page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    await page.goto('/a/grafana-assistant-app/chat?orgId=1&agentSample=vm-memory&piAgentBenchmark=1');
    await installBenchmarkRecorder(page);
    await expect(page.getByTestId(testIds.chat.composer)).toBeVisible();

    const prompt = [
      'This benchmark validates the Coding Agent App Contract sample workspace.',
      'Use only the Coding Agent App Contract workspace tools.',
      'Complete this exact checklist before answering:',
      '1. Call workspace_info.',
      '2. Call read for /workspace/platform/shop/prod/virtual-machines.json.',
      '3. Call edit to change web-01 memoryMiB from 4096 to 8192 using expectedText.',
      '4. Call validate_workspace.',
      '5. Call preview_diff.',
      '6. Call save_changes.',
      'Do not call dashboard, Prometheus, Jsonnet, live dashboard editing, or navigation tools.',
      'After save_changes succeeds, answer exactly: AGENT_CONTRACT_SAMPLE_DONE.',
    ].join(' ');

    const run = await runPrompt({
      page,
      prompt,
      timeoutMs,
      finishTexts: ['AGENT_CONTRACT_SAMPLE_DONE'],
    });
    const report = formatReport(run);
    await testInfo.attach('agent-contract-sample-benchmark-report.txt', {
      body: report,
      contentType: 'text/plain',
    });
    await testInfo.attach('agent-contract-sample-benchmark-events.json', {
      body: JSON.stringify(run.events, null, 2),
      contentType: 'application/json',
    });
    await writeBenchmarkArtifacts(run, report);
    console.log(report);

    if (run.timedOut) {
      throw new Error(`Coding-agent contract sample benchmark timed out after ${timeoutMs}ms.`);
    }
    const assistantError = findFinalAssistantError(run.events);
    if (assistantError) {
      throw new Error(`Assistant ended with error: ${assistantError}`);
    }
    const qualityError = findQualityError(run);
    if (qualityError) {
      throw new Error(`Coding-agent contract sample benchmark failed quality gate: ${qualityError}`);
    }
  });
});

async function installBenchmarkRecorder(page: import('@playwright/test').Page) {
  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    const line =
      event.type === 'tool_execution_end' ? `[tool] ${event.toolName} ${event.isError ? 'failed' : 'ok'}` : '';
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
}

async function runPrompt({
  page,
  prompt,
  timeoutMs,
  finishTexts,
}: {
  page: import('@playwright/test').Page;
  prompt: string;
  timeoutMs: number;
  finishTexts: string[];
}): Promise<BenchmarkRun> {
  await resetBenchmarkEvents(page);
  const composer = page.getByTestId(testIds.chat.composer);
  const send = page.getByTestId(testIds.chat.send);
  await composer.fill(prompt);
  await expect(send).toBeEnabled();
  await send.click();

  let timedOut = false;
  let benchmarkFinished = false;
  const approvalTask = autoApproveToolConfirmations(page, () => benchmarkFinished);
  let finishReason: BenchmarkRun['finishReason'] = 'timeout';
  try {
    finishReason = await Promise.race([
      waitForAgentEndEvent(page, timeoutMs),
      ...finishTexts.map((text) => waitForDomFinishTextAfterPrompt(page, prompt, text, timeoutMs)),
    ]);
    if (finishReason === 'dom_success') {
      await page.waitForTimeout(1000);
    }
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
  const domTranscript = await readDomTranscript(page);
  return {
    prompt,
    events,
    domTranscript,
    finalAnswer: findFinalAssistantText(events),
    timeoutMs,
    timedOut,
    finishReason,
  };
}

async function waitForAgentEndEvent(page: import('@playwright/test').Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readBenchmarkEvents(page);
    if (events.some((event) => event.type === 'agent_end')) {
      return 'agent_event' as const;
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

async function waitForDomFinishTextAfterPrompt(
  page: import('@playwright/test').Page,
  prompt: string,
  text: string,
  timeoutMs: number
) {
  await page.waitForFunction(
    ({ prompt, text, testId }) => {
      const element = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      const transcript = normalizeBenchmarkText(element?.innerText ?? element?.textContent ?? '');
      const normalizedPrompt = normalizeBenchmarkText(prompt);
      const promptIndex = transcript.indexOf(normalizedPrompt);
      if (promptIndex < 0) {
        return false;
      }
      return transcript.slice(promptIndex + normalizedPrompt.length).includes(normalizeBenchmarkText(text));

      function normalizeBenchmarkText(value: string) {
        return value.replace(/\s+/g, ' ').trim();
      }
    },
    { prompt, text, testId: testIds.chat.messages },
    { timeout: timeoutMs }
  );
  return 'dom_success' as const;
}

async function resetBenchmarkEvents(page: import('@playwright/test').Page) {
  await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(() => {
          const benchmarkWindow = window as typeof window & {
            __PI_AGENT_BENCHMARK_CAPTURE__?: boolean;
            __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkEvent[];
          };
          benchmarkWindow.__PI_AGENT_BENCHMARK_CAPTURE__ = true;
          benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
        })
        .catch(() => undefined)
    )
  );
}

async function readBenchmarkEvents(page: import('@playwright/test').Page): Promise<BenchmarkEvent[]> {
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

async function readDomTranscript(page: import('@playwright/test').Page) {
  return page
    .getByRole('region', { name: 'Chat messages' })
    .innerText()
    .catch(() => '');
}

async function autoApproveToolConfirmations(page: import('@playwright/test').Page, isDone: () => boolean) {
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

function findQualityError(run: BenchmarkRun) {
  const toolNames = run.events
    .filter((event) => event.type === 'tool_execution_end')
    .map((event) => event.toolName)
    .filter((name): name is string => typeof name === 'string');
  const required = ['workspace_info', 'read', 'edit', 'validate_workspace', 'preview_diff', 'save_changes'];
  const forbidden = [
    'write_jsonnet',
    'edit_jsonnet',
    'render_dashboard',
    'save_dashboard',
    'upload_dashboard',
    'delete_dashboard',
    'list_live_dashboard_panels',
    'rename_live_dashboard_panel',
    'query_prometheus',
    'run_query_agent',
    'run_dashboard_agent',
  ];

  for (const requiredTool of required) {
    if (!toolNames.includes(requiredTool)) {
      return `assistant did not call required tool ${requiredTool}; saw ${toolNames.join(', ') || 'none'}`;
    }
  }
  const forbiddenTool = toolNames.find((name) => forbidden.includes(name));
  if (forbiddenTool) {
    return `assistant used forbidden tool ${forbiddenTool}`;
  }
  if (
    !run.finalAnswer.includes('AGENT_CONTRACT_SAMPLE_DONE') &&
    !run.domTranscript.includes('AGENT_CONTRACT_SAMPLE_DONE')
  ) {
    return 'assistant did not return completion marker';
  }
  const saveEvent = run.events.find(
    (event) => event.type === 'tool_execution_end' && event.toolName === 'save_changes'
  );
  if (saveEvent?.isError) {
    return 'save_changes failed';
  }
  return undefined;
}

function findFinalAssistantError(events: BenchmarkEvent[]) {
  const finalAssistant = [...events]
    .reverse()
    .find((event) => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
  return finalAssistant?.stopReason === 'error' ? String(finalAssistant.errorMessage ?? 'unknown error') : undefined;
}

function findFinalAssistantText(events: BenchmarkEvent[]) {
  const finalAssistant = [...events]
    .reverse()
    .find((event) => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
  const content = Array.isArray(finalAssistant?.content) ? finalAssistant.content : [];
  return content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

function formatReport(run: BenchmarkRun) {
  const toolEvents = run.events.filter((event) => event.type === 'tool_execution_end');
  const lines = [
    '',
    'Coding-agent contract sample benchmark report',
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3001'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    '',
    `Status: ${run.timedOut ? 'timed out' : findFinalAssistantError(run.events) ? 'failed' : 'completed'}`,
    `Finish signal: ${run.finishReason}`,
    `Event count: ${run.events.length}`,
    `Assistant error: ${findFinalAssistantError(run.events) ?? 'none'}`,
    `Quality: ${findQualityError(run) ?? 'passed'}`,
    '',
    'Tool calls',
  ];
  for (const [index, event] of toolEvents.entries()) {
    lines.push(`${index + 1}. ${event.toolName ?? 'unknown'} | ${event.isError ? 'failed' : 'completed'}`);
  }
  lines.push('', 'Final answer preview', run.finalAnswer.slice(0, 1600));
  return lines.join('\n');
}

async function writeBenchmarkArtifacts(run: BenchmarkRun, report: string) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report),
    writeFile(path.join(OUTPUT_DIR, 'latest-answer.md'), run.finalAnswer),
    writeFile(path.join(OUTPUT_DIR, 'latest-events.json'), JSON.stringify(run.events, null, 2)),
  ]);
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
