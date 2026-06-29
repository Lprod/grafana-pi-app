import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';

const LLM_ROUTE = '**/api/plugins/g42-pi-app/resources/llm/api/stream';
const SAVE_ROUTE = '**/api/plugins/g42-pi-app/resources/jsonnet-dashboards/save';

test.describe('assistant safety workflows', () => {
  test('requires approval before saving a persistent dashboard write', async ({ gotoPage, page }) => {
    const deniedUid = `denied-e2e-${Date.now()}`;
    const approvedUid = `approved-e2e-${Date.now()}`;
    const responses = [
      toolCallResponse(
        'save_dashboard',
        {
          uid: deniedUid,
          overwrite: true,
          dashboard_jsonnet: `{ title: 'Denied E2E', uid: '${deniedUid}', panels: [] }`,
        },
        'call_denied_save'
      ),
      textResponse('Denied path handled.'),
      toolCallResponse(
        'save_dashboard',
        {
          uid: approvedUid,
          overwrite: true,
          dashboard_jsonnet: `{ title: 'Approved E2E', uid: '${approvedUid}', panels: [] }`,
        },
        'call_approved_save'
      ),
      textResponse('Approved path handled.'),
    ];
    const llmRequests: any[] = [];
    const saveRequests: any[] = [];

    await page.route(LLM_ROUTE, async (route) => {
      llmRequests.push(await route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: responses.shift() ?? textResponse('No scripted response available.'),
      });
    });
    await page.route(SAVE_ROUTE, async (route) => {
      saveRequests.push(await route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          uid: approvedUid,
          url: `/d/${approvedUid}/approved-e2e`,
          status: 'created',
          sourceChecksum: 'sha256:e2e',
        }),
      });
    });

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();

      const composer = page.getByTestId(testIds.chat.composer);
      await composer.fill('Create a dashboard for confirmation denial');
      await page.getByTestId(testIds.chat.send).click();

      const confirmation = page.getByTestId(testIds.chat.toolConfirmation);
      await expect(confirmation).toBeVisible();
      await expect(confirmation.getByText(deniedUid, { exact: true })).toBeVisible();
      await page.getByTestId(testIds.chat.toolConfirmationDeny).click();
      await expect(page.getByText('Denied path handled.')).toBeVisible();
      expect(saveRequests).toHaveLength(0);

      await composer.fill('Create a dashboard for confirmation approval');
      await page.getByTestId(testIds.chat.send).click();

      await expect(confirmation).toBeVisible();
      await expect(confirmation.getByText(approvedUid, { exact: true })).toBeVisible();
      await page.getByTestId(testIds.chat.toolConfirmationApprove).click();
      await expect(page.getByText('Approved path handled.')).toBeVisible();

      expect(saveRequests).toHaveLength(1);
      expect(saveRequests[0]).toMatchObject({
        uid: approvedUid,
        overwrite: true,
      });
      expect(llmRequests[0].context.tools.map((tool: any) => tool.name)).toContain('save_dashboard');
    } finally {
      await page.unroute(LLM_ROUTE).catch(() => undefined);
      await page.unroute(SAVE_ROUTE).catch(() => undefined);
    }
  });

  test('renders an investigation report updated by the assistant', async ({ gotoPage, page }) => {
    const title = `VM web investigation ${Date.now()}`;
    const llmRequests: any[] = [];

    await page.route(LLM_ROUTE, async (route) => {
      llmRequests.push(await route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          llmRequests.length === 1
            ? toolCallResponse(
                'update_report',
                {
                  title,
                  patch: [
                    { op: 'add', path: '/scope/-', value: 'vm-web-01 latency spike over the last 6h' },
                    { op: 'add', path: '/evidence/-', value: 'HTTP 500s are concentrated on /render/report' },
                    { op: 'add', path: '/hypotheses/-', value: 'CPU saturation may be increasing request latency' },
                    { op: 'add', path: '/nextSteps/-', value: 'Validate node_load1 and CPU idle for vm-web-01' },
                  ],
                },
                'call_update_report'
              )
            : textResponse('Investigation report updated.'),
      });
    });

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();

      const composer = page.getByTestId(testIds.chat.composer);
      await composer.fill('Investigate why vm-web-01 latency is high');
      await page.getByTestId(testIds.chat.send).click();

      const report = page.getByTestId(testIds.chat.investigationReport);
      await expect(report).toBeVisible();
      await expect(report.getByText(title)).toBeVisible();
      await expect(report.getByText('vm-web-01 latency spike over the last 6h')).toBeVisible();
      await expect(report.getByText('HTTP 500s are concentrated on /render/report')).toBeVisible();
      await expect(report.getByText('CPU saturation may be increasing request latency')).toBeVisible();
      await expect(report.getByText('Validate node_load1 and CPU idle for vm-web-01')).toBeVisible();
      await expect(page.getByText('Investigation report updated.')).toBeVisible();

      expect(llmRequests[0].context.tools.map((tool: any) => tool.name)).toContain('update_report');
    } finally {
      await page.unroute(LLM_ROUTE).catch(() => undefined);
    }
  });
});

function sseResponse(events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function toolCallResponse(toolName: string, args: unknown, id = `call_${toolName}`) {
  return sseResponse([
    { type: 'start' },
    { type: 'toolcall_start', contentIndex: 0, id, toolName },
    { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args) },
    { type: 'toolcall_end', contentIndex: 0 },
    doneEvent('toolUse'),
  ]);
}

function textResponse(text: string) {
  return sseResponse([
    { type: 'start' },
    { type: 'text_start', contentIndex: 0 },
    { type: 'text_delta', contentIndex: 0, delta: text },
    { type: 'text_end', contentIndex: 0 },
    doneEvent('stop'),
  ]);
}

function doneEvent(reason: 'stop' | 'toolUse') {
  return {
    type: 'done',
    reason,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
