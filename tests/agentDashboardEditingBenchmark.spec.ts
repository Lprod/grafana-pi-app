import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { testIds } from '../src/components/testIds';

const DEFAULT_TIMEOUT_MS = 240_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'dashboard-editing-benchmark');

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
    stopReason?: unknown;
    errorMessage?: unknown;
    content?: unknown;
  };
};

type BenchmarkRun = {
  prompt: string;
  events: BenchmarkEvent[];
  domToolNames: string[];
  domTranscript: string;
  finalAnswer: string;
  promptStartedAt: number;
  timeoutMs: number;
  timedOut: boolean;
  finishReason: 'agent_event' | 'dom_success' | 'timeout';
};

type BenchmarkQuality = {
  requiredTools?: string[];
  forbiddenTools?: string[];
  requiredTranscript?: string[];
  requiredTranscriptAny?: string[];
  requireFailedTool?: string;
};

type BenchmarkReportIds = {
  uid: string;
  originalPanelTitle?: string;
  editedPanelTitle?: string;
  addedPanelTitle?: string;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 90_000));

test.describe('dashboard live editing benchmark', () => {
  test('performs typed multi-step live edits from the assistant sidebar', async ({ page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const uid = `typed-live-edit-${suffix}`;
    const dashboardTitle = `Live Edit Benchmark ${suffix}`;
    const originalPanelTitle = 'Original request rate';
    const editedPanelTitle = `Typed edited request rate ${suffix}`;
    const addedPanelTitle = `Typed added error rate ${suffix}`;

    await seedDashboard(page, uid, dashboardTitle, originalPanelTitle);

    try {
      await page.goto(`/d/${uid}/live-edit-benchmark?orgId=1`);
      await expect(page.getByText(originalPanelTitle)).toBeVisible();
      await installBenchmarkRecorder(page);
      await openAssistantSidebar(page, uid);
      await expect(page.getByTestId(testIds.chat.composer)).toBeVisible();

      const prompt = [
        'This benchmark validates typed live dashboard editing from the assistant sidebar.',
        'Use typed live dashboard editing tools only.',
        'First call list_live_dashboard_panels and get_live_dashboard_layout.',
        `Use rename_live_dashboard_panel to rename the existing panel to "${editedPanelTitle}".`,
        'Use move_or_resize_live_dashboard_panel to move that panel to x=0 y=8 width=12 height=8.',
        `Use add_live_dashboard_panel to add a timeseries panel titled "${addedPanelTitle}" with query sum(rate(http_requests_total{status=~"5.."}[$__rate_interval])) at x=12 y=8 width=12 height=8.`,
        'Verify with list_live_dashboard_panels and get_live_dashboard_layout.',
        'Do not call apply_live_dashboard_mutation, write_jsonnet, render_dashboard, save_dashboard, upload_dashboard, or delete_dashboard.',
        'After verification succeeds, answer with one short sentence.',
      ].join(' ');

      const run = await runPrompt({
        page,
        prompt,
        timeoutMs,
        finishTexts: ['"panel-2"'],
      });
      await assertBenchmarkRun({
        run,
        testInfo,
        reportIds: { uid, originalPanelTitle, editedPanelTitle, addedPanelTitle },
        quality: {
          requiredTools: [
            'list_live_dashboard_panels',
            'get_live_dashboard_layout',
            'rename_live_dashboard_panel',
            'move_or_resize_live_dashboard_panel',
            'add_live_dashboard_panel',
          ],
          forbiddenTools: [
            'apply_live_dashboard_mutation',
            'write_jsonnet',
            'render_dashboard',
            'save_dashboard',
            'upload_dashboard',
            'delete_dashboard',
          ],
          requiredTranscript: ['"panel-2"'],
        },
      });

      await expect(page.getByText(editedPanelTitle).first()).toBeVisible();
      await expect(page.getByText(addedPanelTitle).first()).toBeVisible();
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(uid)}`).catch(() => undefined);
    }
  });

  test('recovers after a failed typed live edit', async ({ page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const uid = `typed-live-recovery-${suffix}`;
    const dashboardTitle = `Live Edit Recovery ${suffix}`;
    const originalPanelTitle = 'Recovery original panel';
    const editedPanelTitle = `Recovery edited panel ${suffix}`;

    await seedDashboard(page, uid, dashboardTitle, originalPanelTitle);

    try {
      await page.goto(`/d/${uid}/live-edit-recovery?orgId=1`);
      await expect(page.getByText(originalPanelTitle)).toBeVisible();
      await installBenchmarkRecorder(page);
      await openAssistantSidebar(page, uid);

      const prompt = [
        'This benchmark validates recovery after a failed live dashboard edit.',
        'Use typed live dashboard editing tools only.',
        'First intentionally call rename_live_dashboard_panel with elementName "panel-does-not-exist" and title "Should fail".',
        'After that fails, call list_live_dashboard_panels to find the correct element.',
        `Then call rename_live_dashboard_panel again to rename the existing panel to "${editedPanelTitle}".`,
        'Do not call apply_live_dashboard_mutation, write_jsonnet, render_dashboard, save_dashboard, upload_dashboard, or delete_dashboard.',
        'After the successful retry, answer with one short sentence.',
      ].join(' ');

      const run = await runPrompt({
        page,
        prompt,
        timeoutMs,
        finishTexts: ['Live dashboard mutation UPDATE_PANEL succeeded'],
      });
      await assertBenchmarkRun({
        run,
        testInfo,
        reportIds: { uid, originalPanelTitle, editedPanelTitle },
        quality: {
          requiredTools: ['rename_live_dashboard_panel', 'list_live_dashboard_panels'],
          forbiddenTools: [
            'apply_live_dashboard_mutation',
            'write_jsonnet',
            'render_dashboard',
            'save_dashboard',
            'upload_dashboard',
            'delete_dashboard',
          ],
          requiredTranscript: ['Live dashboard mutation UPDATE_PANEL succeeded'],
          requireFailedTool: 'rename_live_dashboard_panel',
        },
      });

      await expect(page.getByText(editedPanelTitle).first()).toBeVisible();
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(uid)}`).catch(() => undefined);
    }
  });

  test('falls back when live dashboard editing is unavailable', async ({ page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    await page.goto('/a/grafana-assistant-app/chat?orgId=1');
    await installBenchmarkRecorder(page);
    await expect(page.getByTestId(testIds.chat.composer)).toBeVisible();

    const prompt = [
      'This benchmark validates the fallback path when no dashboard is currently loaded.',
      'Can you directly rename the currently open dashboard panel to "Unavailable edit"?',
      'Answer with one short sentence that starts with "I cannot directly rename" and do not call any dashboard editing tool.',
    ].join(' ');

    const run = await runPrompt({
      page,
      prompt,
      timeoutMs,
      finishTexts: ['I cannot directly rename', 'not available', 'no dashboard', 'open a dashboard'],
    });
    await assertBenchmarkRun({
      run,
      testInfo,
      reportIds: { uid: 'no-active-dashboard' },
      quality: {
        forbiddenTools: [
          'list_live_dashboard_panels',
          'get_live_dashboard_layout',
          'rename_live_dashboard_panel',
          'update_live_dashboard_panel_query',
          'add_live_dashboard_panel',
          'move_or_resize_live_dashboard_panel',
          'update_live_dashboard_settings',
          'add_live_dashboard_variable',
          'update_live_dashboard_variable',
          'apply_live_dashboard_mutation',
          'write_jsonnet',
          'render_dashboard',
          'save_dashboard',
          'upload_dashboard',
          'delete_dashboard',
        ],
        requiredTranscriptAny: [
          'I cannot directly rename',
          'not available',
          'no dashboard',
          'open a dashboard',
          'currently loaded dashboard',
        ],
      },
    });
  });
});

async function seedDashboard(page: Page, uid: string, title: string, panelTitle: string) {
  const response = await page.request.post('/api/dashboards/db', {
    data: {
      dashboard: {
        uid,
        title,
        tags: ['dashboard-editing-benchmark'],
        timezone: 'browser',
        schemaVersion: 41,
        time: { from: 'now-6h', to: 'now' },
        panels: [
          {
            id: 1,
            title: panelTitle,
            type: 'timeseries',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            gridPos: { x: 0, y: 0, w: 24, h: 8 },
            fieldConfig: { defaults: { unit: 'reqps' }, overrides: [] },
            targets: [
              {
                refId: 'A',
                datasource: { uid: 'prometheus', type: 'prometheus' },
                expr: 'sum(rate(http_requests_total[$__rate_interval]))',
                legendFormat: 'requests',
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

async function openAssistantSidebar(page: Page, dashboardUid: string) {
  const locators = [
    page.getByRole('button', { name: /^Open Assistant$/ }).first(),
    page.locator('[aria-label="Open Assistant"], [title="Open Assistant"]').first(),
  ];

  for (const locator of locators) {
    if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
      await locator.click();
      await expect(page).toHaveURL(new RegExp(`/d/${escapeRegExp(dashboardUid)}/`));
      return;
    }
  }

  throw new Error('Could not find the Assistant sidebar trigger on the dashboard page.');
}

async function installBenchmarkRecorder(page: Page) {
  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    const line = formatLiveBenchmarkEvent(event);
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
  finishTexts = [],
}: {
  page: Page;
  prompt: string;
  timeoutMs: number;
  finishTexts?: string[];
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
  const domToolNames = await readDomToolNames(page);
  const domTranscript = await readDomTranscript(page);
  return {
    prompt,
    events,
    domToolNames,
    domTranscript,
    finalAnswer: findFinalAssistantText(events),
    promptStartedAt,
    timeoutMs,
    timedOut,
    finishReason,
  };
}

async function assertBenchmarkRun({
  run,
  testInfo,
  reportIds,
  quality,
}: {
  run: BenchmarkRun;
  testInfo: { attach: (name: string, options: { body: string; contentType: string }) => Promise<void> };
  reportIds: BenchmarkReportIds;
  quality: BenchmarkQuality;
}) {
  const report = formatBenchmarkReport(run, reportIds, quality);

  await testInfo.attach('dashboard-editing-benchmark-report.txt', {
    body: report,
    contentType: 'text/plain',
  });
  await testInfo.attach('dashboard-editing-benchmark-events.json', {
    body: JSON.stringify(run.events, null, 2),
    contentType: 'application/json',
  });
  await writeBenchmarkArtifacts(run, report);
  console.log(report);

  if (run.timedOut) {
    throw new Error(`Dashboard live editing benchmark timed out after ${run.timeoutMs}ms.`);
  }

  const finalAssistantError = findFinalAssistantError(run.events);
  if (finalAssistantError) {
    throw new Error(`Dashboard live editing benchmark ended with assistant error: ${finalAssistantError}`);
  }

  const qualityError = findQualityError(run, quality);
  if (qualityError) {
    throw new Error(`Dashboard live editing benchmark failed quality gate: ${qualityError}`);
  }
}

async function waitForAgentEndEvent(page: Page, timeoutMs: number) {
  await page.waitForFunction(
    () => {
      const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkEvent[] };
      return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__?.some((event) => event.type === 'agent_end') ?? false;
    },
    undefined,
    { timeout: timeoutMs }
  );
  return 'agent_event' as const;
}

async function waitForDomFinishTextAfterPrompt(page: Page, prompt: string, text: string, timeoutMs: number) {
  await page.waitForFunction(
    ({ prompt, text, testId }) => {
      const element = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      const transcript = normalizeBenchmarkText(element?.innerText ?? element?.textContent ?? '');
      const normalizedPrompt = normalizeBenchmarkText(prompt);
      const promptIndex = transcript.indexOf(normalizedPrompt);
      if (promptIndex < 0) {
        return false;
      }

      const assistantTranscript = transcript.slice(promptIndex + normalizedPrompt.length);
      return assistantTranscript.includes(normalizeBenchmarkText(text));

      function normalizeBenchmarkText(value: string) {
        return value.replace(/\s+/g, ' ').trim();
      }
    },
    { prompt, text, testId: testIds.chat.messages },
    { timeout: timeoutMs }
  );
  return 'dom_success' as const;
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

async function readDomToolNames(page: Page) {
  const chat = page.getByRole('region', { name: 'Chat messages' });
  return chat
    .locator('strong')
    .allInnerTexts()
    .catch(() => []);
}

async function readDomTranscript(page: Page) {
  return page
    .getByRole('region', { name: 'Chat messages' })
    .innerText()
    .catch(() => '');
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

function findQualityError(run: BenchmarkRun, quality: BenchmarkQuality) {
  const toolNames = observedToolNames(run);
  const assistantTranscript = transcriptAfterPrompt(run);

  for (const requiredTool of quality.requiredTools ?? []) {
    if (!toolNames.includes(requiredTool)) {
      return `assistant did not call required tool ${requiredTool}`;
    }
  }

  const forbidden = toolNames.find((name) => quality.forbiddenTools?.includes(name ?? ''));
  if (forbidden) {
    return `assistant used forbidden tool ${forbidden}`;
  }

  if (quality.requireFailedTool) {
    const failed = hasFailedTool(run, quality.requireFailedTool);
    const transcriptFailure =
      assistantTranscript.toLowerCase().includes('failed') || assistantTranscript.toLowerCase().includes('not found');
    if (!failed && !transcriptFailure) {
      return `assistant did not visibly hit the expected failed ${quality.requireFailedTool} call`;
    }
  }

  for (const requiredText of quality.requiredTranscript ?? []) {
    if (!assistantTranscript.includes(requiredText)) {
      return `transcript did not contain required text: ${requiredText}`;
    }
  }

  if (quality.requiredTranscriptAny?.length) {
    const transcript = assistantTranscript.toLowerCase();
    if (!quality.requiredTranscriptAny.some((text) => transcript.includes(text.toLowerCase()))) {
      return `transcript did not contain any fallback text: ${quality.requiredTranscriptAny.join(', ')}`;
    }
  }

  return undefined;
}

function hasFailedTool(run: BenchmarkRun, toolName: string) {
  return run.events.some(
    (event) => event.type === 'tool_execution_end' && event.toolName === toolName && event.isError
  );
}

function observedToolNames(run: BenchmarkRun) {
  const eventToolNames = run.events
    .filter((event) => event.type === 'tool_execution_end')
    .map((event) => event.toolName)
    .filter((name): name is string => typeof name === 'string');
  return eventToolNames.length > 0 ? eventToolNames : run.domToolNames;
}

function transcriptAfterPrompt(run: BenchmarkRun) {
  const promptIndex = run.domTranscript.indexOf(run.prompt);
  return promptIndex >= 0 ? run.domTranscript.slice(promptIndex + run.prompt.length) : run.domTranscript;
}

function formatBenchmarkReport(run: BenchmarkRun, ids: BenchmarkReportIds, quality: BenchmarkQuality) {
  const toolEvents = run.events.filter((event) => event.type === 'tool_execution_end');
  const agentStart = run.events.find((event) => event.type === 'agent_start')?.timestamp ?? run.promptStartedAt;
  const agentEnd = [...run.events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const lines = [
    '',
    'Dashboard live editing benchmark report',
    `Dashboard UID: ${ids.uid}`,
    ids.originalPanelTitle ? `Original panel title: ${ids.originalPanelTitle}` : undefined,
    ids.editedPanelTitle ? `Expected panel title: ${ids.editedPanelTitle}` : undefined,
    ids.addedPanelTitle ? `Expected added panel title: ${ids.addedPanelTitle}` : undefined,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3001'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    '',
    `Status: ${run.timedOut ? 'timed out' : findFinalAssistantError(run.events) ? 'failed' : 'completed'}`,
    `Finish signal: ${run.finishReason}`,
    `Event count: ${run.events.length}`,
    `Elapsed: ${formatDuration((agentEnd ?? Date.now()) - agentStart)}`,
    `Assistant error: ${findFinalAssistantError(run.events) ?? 'none'}`,
    `Quality: ${findQualityError(run, quality) ?? 'passed'}`,
    '',
    'Tool calls',
  ].filter((line): line is string => typeof line === 'string');

  for (const [index, event] of toolEvents.entries()) {
    lines.push(
      `${index + 1}. ${event.toolName ?? 'unknown'} | ${event.isError ? 'failed' : 'completed'} | args=${summarizeJson(
        event.args
      )}`
    );
  }
  if (toolEvents.length === 0 && run.domToolNames.length > 0) {
    for (const [index, toolName] of run.domToolNames.entries()) {
      lines.push(`${index + 1}. ${toolName} | observed in DOM transcript`);
    }
  }

  lines.push('', 'Final answer preview', truncateOneLine(run.finalAnswer, 1600));

  return lines.join('\n');
}

async function writeBenchmarkArtifacts(run: BenchmarkRun, report: string) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report);
  await writeFile(path.join(OUTPUT_DIR, 'latest-answer.md'), run.finalAnswer);
  await writeFile(path.join(OUTPUT_DIR, 'latest-events.json'), JSON.stringify(run.events, null, 2));
  await writeFile(path.join(OUTPUT_DIR, 'latest-transcript.txt'), run.domTranscript);
}

function formatLiveBenchmarkEvent(event: BenchmarkEvent) {
  if (event.type === 'tool_execution_start') {
    return `[benchmark] tool start ${event.toolName ?? 'unknown'} ${summarizeJson(event.args)}`;
  }
  if (event.type === 'tool_execution_end') {
    return `[benchmark] tool end ${event.toolName ?? 'unknown'} ${event.isError ? 'failed' : 'completed'}`;
  }
  if (event.type === 'agent_end') {
    return '[benchmark] agent end';
  }
  return undefined;
}

function findFinalAssistantError(events: BenchmarkEvent[]) {
  const finalMessage = [...events].reverse().find((event) => event.type === 'agent_end')?.message;
  return typeof finalMessage?.errorMessage === 'string' ? finalMessage.errorMessage : undefined;
}

function findFinalAssistantText(events: BenchmarkEvent[]) {
  const message = [...events]
    .reverse()
    .find((event) => event.type === 'agent_end' && event.message?.role === 'assistant')?.message;
  return summarizeContent(message?.content);
}

function summarizeContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => (isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
}

function summarizeJson(value: unknown) {
  return truncateOneLine(JSON.stringify(value), 500);
}

function truncateOneLine(value: unknown, limit: number) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readPositiveInteger(value: unknown, fallback: number) {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
