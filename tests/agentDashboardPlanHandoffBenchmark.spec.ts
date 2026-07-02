import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';

const DEFAULT_TIMEOUT_MS = 420_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'dashboard-plan-handoff-benchmark');
const DATASOURCE_UID = 'thanos-prod-db';
const NAMESPACE = 'thanos-prod';
const CLUSTER_SELECTOR = 'cluster="openshift-obs-it-prod"';
const PLAN_MARKER = 'DASHBOARD_PLAN_JSON:';
const REQUIRED_VALID_METRICS = [
  'prometheus_tsdb_storage_blocks_bytes',
  'prometheus_tsdb_wal_storage_size_bytes',
  'thanos_receive_write_samples_sum',
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

test.describe('dashboard plan handoff benchmark', () => {
  test('produces a typed dashboard plan before writing Jsonnet from validated evidence', async ({
    gotoPage,
    page,
  }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const dashboardUid = `plan-handoff-${suffix}`;
    const dashboardTitle = `Dashboard Plan Handoff Benchmark ${suffix}`;

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await installBenchmarkRecorder(page);

      const prompt = [
        'This benchmark validates typed dashboard planning before raw Jsonnet authoring.',
        'Use exactly one run_dashboard_agent top-level tool call. Do not call run_query_agent or any other top-level tool. Do not use dashboard write tools directly at the top level.',
        `The dashboard agent must create, render, and save an editable Jsonnet dashboard titled "${dashboardTitle}" with UID "${dashboardUid}" using datasource UID ${DATASOURCE_UID}.`,
        'Inside run_dashboard_agent, use write_dashboard_plan to submit the typed plan and write the initial dashboard.jsonnet. Do not call write_jsonnet for this benchmark.',
        'The write_dashboard_plan arguments must use this exact contract:',
        '{ "dashboard": { "title": string, "uid": string, "datasourceUid": string, "timeRange": { "from": string, "to": string } }, "queryEvidence": [{ "id": string, "datasourceUid": string, "expr": string, "queryType": "instant" | "range", "totalSeries": number, "validationError": string | null, "labels": string[] }], "panels": [{ "title": string, "type": "stat" | "timeseries" | "table", "queryEvidenceId": string, "unit": string | null, "layout": string }] }',
        'Validate these four candidates before emitting the plan:',
        `1. sum by (tenant) (prometheus_tsdb_storage_blocks_bytes{namespace="${NAMESPACE}"})`,
        `2. sum by (tenant) (prometheus_tsdb_wal_storage_size_bytes{namespace="${NAMESPACE}"})`,
        `3. sum by (tenant) (thanos_receive_write_samples_sum{namespace="${NAMESPACE}"})`,
        `4. sum by (tenant) (prometheus_tsdb_storage_blocks_bytes{${CLUSTER_SELECTOR}, namespace="${NAMESPACE}"})`,
        'The fourth candidate is intentionally over-scoped and must appear in queryEvidence as unusable evidence with totalSeries=0 or a non-null validationError.',
        'Every panel in the plan must reference only queryEvidence with totalSeries > 0 and validationError=null.',
        'After write_dashboard_plan succeeds, render it, and save it. The saved dashboard must not include the cluster-scoped query.',
      ].join(' ');

      const run = await runPrompt({ page, prompt, timeoutMs });
      const persistedDashboard = await fetchPersistedDashboard(page, dashboardUid);
      const report = formatBenchmarkReport(run, dashboardUid, persistedDashboard);

      await testInfo.attach('dashboard-plan-handoff-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('dashboard-plan-handoff-benchmark-events.json', {
        body: JSON.stringify(run.events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(run, report);

      console.log(report);

      if (run.timedOut) {
        throw new Error(`Dashboard plan handoff benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(run.events);
      if (finalAssistantError) {
        throw new Error(`Dashboard plan handoff benchmark ended with assistant error: ${finalAssistantError}`);
      }

      const qualityError = findDashboardPlanHandoffQualityError(run, dashboardUid, persistedDashboard);
      if (qualityError) {
        throw new Error(`Dashboard plan handoff benchmark failed quality gate: ${qualityError}`);
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

async function runPrompt({ page, prompt, timeoutMs }: { page: Page; prompt: string; timeoutMs: number }) {
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

async function fetchPersistedDashboard(page: Page, dashboardUid: string) {
  const response = await page.request.get(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`);
  if (!response.ok()) {
    return undefined;
  }
  return response.json();
}

function findDashboardPlanHandoffQualityError(run: BenchmarkRun, dashboardUid: string, persistedDashboard?: unknown) {
  const toolCalls = summarizeToolCalls(run.events);
  const unexpectedTopLevel = toolCalls.find((call) => call.name !== 'run_dashboard_agent');
  if (unexpectedTopLevel) {
    return `unexpected top-level ${unexpectedTopLevel.name}; expected only run_dashboard_agent`;
  }

  const dashboardCalls = toolCalls.filter((call) => call.name === 'run_dashboard_agent');
  if (dashboardCalls.length !== 1) {
    return `expected exactly one run_dashboard_agent call, got ${dashboardCalls.length}`;
  }

  const dashboardCall = dashboardCalls[0];
  if (dashboardCall.status !== 'completed' || dashboardCall.isError) {
    return 'run_dashboard_agent did not complete successfully';
  }

  const nested = dashboardCall.nestedToolCalls ?? [];
  const planCallIndex = nested.findIndex((call) => call.name === 'write_dashboard_plan');
  if (planCallIndex === -1) {
    return 'dashboard agent never called write_dashboard_plan';
  }

  const planCall = nested[planCallIndex];
  if (planCall.status !== 'completed' || planCall.isError) {
    return 'write_dashboard_plan did not complete successfully';
  }

  const rawBeforePlan = nested.slice(0, planCallIndex).find((call) => isDashboardMutationCall(call.name));
  if (rawBeforePlan) {
    return `dashboard agent called ${rawBeforePlan.name} before write_dashboard_plan`;
  }

  const rawWrite = nested.find((call) => call.name === 'write_jsonnet');
  if (rawWrite) {
    return 'dashboard agent used raw write_jsonnet instead of write_dashboard_plan';
  }

  const firstMutationIndex = nested.findIndex((call) => isDashboardMutationCall(call.name));
  if (firstMutationIndex === -1) {
    return 'dashboard agent never wrote, rendered, or saved a dashboard';
  }

  const plan =
    extractDashboardPlanFromToolCall(planCall) ??
    extractDashboardPlan(dashboardAgentTextBeforeFirstMutation(run.events, dashboardCall.id));
  if (!plan) {
    return 'dashboard agent did not provide a parseable typed dashboard plan';
  }

  const planError = validateDashboardPlan(plan, dashboardUid);
  if (planError) {
    return planError;
  }

  const failedMutation = nested.find(
    (call) =>
      (isDashboardMutationCall(call.name) || call.name === 'write_dashboard_plan') &&
      (call.status === 'failed' || call.isError)
  );
  if (failedMutation) {
    return `dashboard agent hit failed ${failedMutation.name}`;
  }

  const renderedAfterPlan = nested
    .slice(planCallIndex + 1)
    .find((call) => call.name === 'render_dashboard' && call.status === 'completed' && !call.isError);
  if (!renderedAfterPlan) {
    return 'dashboard agent did not complete render_dashboard after write_dashboard_plan';
  }

  const saved = [...nested]
    .reverse()
    .find((call) => call.name === 'save_dashboard' && call.status === 'completed' && !call.isError);
  if (!saved) {
    return 'dashboard agent did not complete save_dashboard';
  }
  const saveDetails = getRecord(getRecord(saved.result)?.details);
  if (stringField(saveDetails, 'uid') !== dashboardUid) {
    return `save_dashboard wrote UID ${stringField(saveDetails, 'uid') ?? 'unknown'} instead of ${dashboardUid}`;
  }

  const dashboardText = JSON.stringify(persistedDashboard ?? {}).toLowerCase();
  if (dashboardText.includes(CLUSTER_SELECTOR.toLowerCase())) {
    return `saved dashboard still contains over-scoped selector ${CLUSTER_SELECTOR}`;
  }
  for (const metric of REQUIRED_VALID_METRICS) {
    if (!dashboardText.includes(metric.toLowerCase())) {
      return `saved dashboard does not include required metric ${metric}`;
    }
  }

  return undefined;
}

function extractDashboardPlanFromToolCall(call: NestedToolCallSummary) {
  const textPlan = extractDashboardPlan(call.text ?? extractResultText(call.result) ?? '');
  if (textPlan) {
    return textPlan;
  }

  const detailsPlan = getRecord(getRecord(getRecord(call.result)?.details)?.dashboardPlan);
  if (isDashboardPlanRecord(detailsPlan)) {
    return detailsPlan;
  }

  const args = getRecord(call.args);
  if (isDashboardPlanRecord(args)) {
    return args;
  }

  const nestedPlan = getRecord(args?.plan);
  if (isDashboardPlanRecord(nestedPlan)) {
    return nestedPlan;
  }

  return undefined;
}

function isDashboardPlanRecord(value: Record<string, unknown> | undefined) {
  return Boolean(
    value &&
    getRecord(value.dashboard) &&
    recordsField(value, 'queryEvidence').length > 0 &&
    recordsField(value, 'panels').length > 0
  );
}

function validateDashboardPlan(plan: Record<string, unknown>, dashboardUid: string) {
  const dashboard = getRecord(plan.dashboard);
  if (stringField(dashboard, 'uid') !== dashboardUid) {
    return `plan dashboard UID ${stringField(dashboard, 'uid') ?? 'unknown'} did not match ${dashboardUid}`;
  }
  if (stringField(dashboard, 'datasourceUid') !== DATASOURCE_UID) {
    return `plan datasourceUid ${stringField(dashboard, 'datasourceUid') ?? 'unknown'} did not match ${DATASOURCE_UID}`;
  }

  const evidence = recordsField(plan, 'queryEvidence');
  if (evidence.length < 4) {
    return `plan queryEvidence had ${evidence.length} entries; expected at least 4`;
  }

  const panels = recordsField(plan, 'panels');
  if (panels.length < 3) {
    return `plan panels had ${panels.length} entries; expected at least 3`;
  }

  const evidenceById = new Map(evidence.map((item) => [stringField(item, 'id'), item]));
  const clusterEvidence = evidence.find((item) => String(item.expr ?? '').includes(CLUSTER_SELECTOR));
  if (!clusterEvidence) {
    return `plan did not record unusable over-scoped ${CLUSTER_SELECTOR} evidence`;
  }
  if (!isUnusableEvidence(clusterEvidence)) {
    return `over-scoped ${CLUSTER_SELECTOR} evidence was not marked unusable`;
  }

  for (const panel of panels) {
    for (const evidenceId of panelEvidenceIds(panel)) {
      const referenced = evidenceById.get(evidenceId);
      if (!referenced) {
        return `panel ${stringField(panel, 'title') ?? 'unknown'} referenced missing evidence ${evidenceId}`;
      }
      if (!isSuccessfulEvidence(referenced)) {
        return `panel ${stringField(panel, 'title') ?? 'unknown'} referenced unusable evidence ${evidenceId}`;
      }
    }
  }

  for (const metric of REQUIRED_VALID_METRICS) {
    const metricEvidence = evidence.find((item) => String(item.expr ?? '').includes(metric));
    if (!metricEvidence || !isSuccessfulEvidence(metricEvidence)) {
      return `plan did not include successful evidence for ${metric}`;
    }
  }

  return undefined;
}

function panelEvidenceIds(panel: Record<string, unknown>) {
  const targets = recordsField(panel, 'targets')
    .map((target) => stringField(target, 'queryEvidenceId'))
    .filter((id): id is string => Boolean(id));
  if (targets.length > 0) {
    return targets;
  }

  const evidenceId = stringField(panel, 'queryEvidenceId');
  return evidenceId ? [evidenceId] : [];
}

function dashboardAgentTextBeforeFirstMutation(events: BenchmarkEvent[], dashboardToolCallId: string) {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.toolCallId !== dashboardToolCallId || event.toolName !== 'run_dashboard_agent') {
      continue;
    }
    if (event.type !== 'tool_execution_update') {
      continue;
    }

    const nested = extractNestedToolCalls(event.partialResult) ?? [];
    if (nested.some((call) => isDashboardMutationCall(call.name))) {
      break;
    }

    const text = extractResultText(event.partialResult);
    if (text) {
      chunks.push(text);
    }
  }
  return chunks.join('\n');
}

function extractDashboardPlan(text: string) {
  const markerIndex = text.indexOf(PLAN_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }
  const objectStart = text.indexOf('{', markerIndex + PLAN_MARKER.length);
  if (objectStart < 0) {
    return undefined;
  }
  const objectEnd = findMatchingBrace(text, objectStart);
  if (objectEnd < 0) {
    return undefined;
  }

  try {
    return getRecord(JSON.parse(text.slice(objectStart, objectEnd + 1)));
  } catch {
    return undefined;
  }
}

function findMatchingBrace(source: string, start: number) {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escape = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') {
      depth++;
      continue;
    }
    if (char === '}') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
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

function formatBenchmarkReport(run: BenchmarkRun, dashboardUid: string, persistedDashboard?: unknown) {
  const summary = summarizeRun(run);
  const quality = findDashboardPlanHandoffQualityError(run, dashboardUid, persistedDashboard);
  const lines = [
    '',
    'Dashboard plan handoff benchmark report',
    `Dashboard UID: ${dashboardUid}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    '',
    `Status: ${run.timedOut ? 'timed out' : findFinalAssistantError(run.events) ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration(summary.elapsedMs)}`,
    `Time to first tool: ${summary.firstToolStart ? formatDuration(summary.firstToolStart - summary.agentStart) : 'none'}`,
    `Tool calls: ${summary.toolCalls.length}`,
    `Assistant error: ${findFinalAssistantError(run.events) ?? 'none'}`,
    `Quality: ${quality ?? 'passed'}`,
    '',
    'Tool call timeline',
  ];

  for (const [index, call] of summary.toolCalls.entries()) {
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

  const dashboardCall = summary.toolCalls.find((call) => call.name === 'run_dashboard_agent');
  if (dashboardCall) {
    lines.push(
      '',
      'Plan text before first dashboard mutation',
      truncateOneLine(dashboardAgentTextBeforeFirstMutation(run.events, dashboardCall.id), 1800)
    );
  }

  lines.push('', 'Final answer preview', truncateOneLine(run.finalAnswer, 1200));
  return lines.join('\n');
}

function formatLiveBenchmarkEvent(event: BenchmarkEvent, state: LiveBenchmarkState) {
  if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
    state.toolStarts.set(event.toolCallId, event);
    return `[dashboard-plan-handoff-benchmark:live] tool_start ${event.toolName} args=${summarizeJson(event.args)}`;
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
      `[dashboard-plan-handoff-benchmark:live] tool_update ${event.toolName}`,
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
      `[dashboard-plan-handoff-benchmark:live] tool_end ${event.toolName} ${status} duration=${duration}`,
      nestedCalls === undefined ? undefined : `nested=${nestedCalls}`,
      resultText ? (event.isError ? `error=${resultText}` : `text=${resultText}`) : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (event.type === 'agent_end') {
    return '[dashboard-plan-handoff-benchmark:live] agent_end';
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

function isSuccessfulEvidence(record: Record<string, unknown>) {
  return numericField(record, 'totalSeries') > 0 && nullableStringField(record, 'validationError') === null;
}

function isUnusableEvidence(record: Record<string, unknown>) {
  return numericField(record, 'totalSeries') === 0 || nullableStringField(record, 'validationError') !== null;
}

function isDashboardMutationCall(name: string) {
  return ['write_jsonnet', 'edit_jsonnet', 'fix_jsonnet', 'render_dashboard', 'save_dashboard'].includes(name);
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

function nullableStringField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return value === null || typeof value === 'string' ? value : undefined;
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
