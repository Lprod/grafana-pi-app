import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { testIds } from '../src/components/testIds';

const SIDEBAR_VARIANT_ENABLED =
  process.env.PLUGIN_VARIANT_ID === 'grafana-assistant-app' ||
  (process.env.GRAFANA_URL ? new URL(process.env.GRAFANA_URL).port === '3001' : false);

test.describe('Assistant sidebar layout', () => {
  test.skip(!SIDEBAR_VARIANT_ENABLED, 'The extension sidebar is only available in the grafana-assistant-app variant.');

  test('keeps an imported investigation report in one collapsible reading column', async ({ page }, testInfo) => {
    const suffix = Date.now().toString(36);
    const dashboardUid = `assistant-sidebar-layout-${suffix}`;
    const dashboardTitle = `Assistant sidebar layout ${suffix}`;

    await seedDashboard(page, dashboardUid, dashboardTitle);

    try {
      await page.goto(`/d/${dashboardUid}/assistant-sidebar-layout?orgId=1`);
      await expect(page.getByRole('heading', { name: 'Sidebar layout fixture' })).toBeVisible();
      await openAssistantSidebar(page, dashboardUid);

      await page.getByTestId(testIds.chat.importInput).setInputFiles({
        name: 'assistant-sidebar-layout.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(investigationSessionFixture())),
      });

      const report = page.getByTestId(testIds.chat.investigationReport);
      const reportScroll = page.getByTestId(testIds.chat.investigationReportScroll);
      const messages = page.getByTestId(testIds.chat.messages);
      const container = page.getByTestId(testIds.chat.container);
      const reportDisclosure = report.getByRole('button', {
        name: /^Analyse long-running login latency/,
      });
      await expect(report).toBeVisible();
      await expect(reportDisclosure).toHaveAttribute('aria-expanded', 'true');
      await expect(report.getByText(/^Analyse long-running login latency/)).toBeVisible();

      const [reportBox, messagesBox, containerBox, inputBox, sendBox] = await Promise.all([
        report.boundingBox(),
        messages.boundingBox(),
        container.boundingBox(),
        page.getByTestId(testIds.chat.composer).boundingBox(),
        page.getByTestId(testIds.chat.send).boundingBox(),
      ]);
      expect(reportBox).not.toBeNull();
      expect(messagesBox).not.toBeNull();
      expect(containerBox).not.toBeNull();
      expect(inputBox).not.toBeNull();
      expect(sendBox).not.toBeNull();

      expect(Math.abs(reportBox!.x - messagesBox!.x)).toBeLessThan(2);
      expect(reportBox!.width).toBeGreaterThanOrEqual(messagesBox!.width - 2);
      expect(messagesBox!.height).toBeGreaterThanOrEqual(120);
      expect(reportBox!.height).toBeLessThanOrEqual(360);
      expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(containerBox!.x + containerBox!.width + 1);
      expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(containerBox!.y + containerBox!.height + 1);

      const horizontalOverflow = await container.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(horizontalOverflow).toBeLessThanOrEqual(1);

      await expect
        .poll(() => reportScroll.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true);
      const initialReportScrollTop = await reportScroll.evaluate((element) => element.scrollTop);
      await reportScroll.hover();
      await page.mouse.wheel(0, 800);
      await expect
        .poll(() => reportScroll.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(initialReportScrollTop);

      await reportScroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(
        report.getByText('Final remediation marker: validate the recovered login latency.')
      ).toBeInViewport();

      const [scrolledReportBox, scrolledInputBox] = await Promise.all([
        report.boundingBox(),
        page.getByTestId(testIds.chat.composer).boundingBox(),
      ]);
      expect(scrolledReportBox).not.toBeNull();
      expect(scrolledInputBox).not.toBeNull();
      expect(scrolledReportBox!.y + scrolledReportBox!.height).toBeLessThanOrEqual(scrolledInputBox!.y + 1);

      await testInfo.attach('assistant-sidebar-layout-open.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      await reportDisclosure.click();
      await expect(reportDisclosure).toHaveAttribute('aria-expanded', 'false');
      const collapsedBox = await report.boundingBox();
      expect(collapsedBox).not.toBeNull();
      expect(collapsedBox!.height).toBeLessThan(reportBox!.height);

      await testInfo.attach('assistant-sidebar-layout-collapsed.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`).catch(() => undefined);
    }
  });
});

async function seedDashboard(page: Page, uid: string, title: string) {
  const response = await page.request.post('/api/dashboards/db', {
    data: {
      dashboard: {
        uid,
        title,
        tags: ['assistant-sidebar-layout'],
        timezone: 'browser',
        schemaVersion: 41,
        time: { from: 'now-6h', to: 'now' },
        panels: [
          {
            id: 1,
            title: 'Sidebar layout fixture',
            type: 'text',
            gridPos: { x: 0, y: 0, w: 12, h: 8 },
            options: { mode: 'markdown', content: 'Sidebar layout fixture' },
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
    if (await locator.isVisible({ timeout: 5000 }).catch(() => false)) {
      await locator.click();
      await expect(page).toHaveURL(new RegExp(`/d/${escapeRegExp(dashboardUid)}/`));
      await expect(page.getByTestId(testIds.chat.composer)).toBeVisible();
      return;
    }
  }

  throw new Error('Could not find the Assistant sidebar trigger on the dashboard page.');
}

function investigationSessionFixture() {
  const timestamp = '2026-08-10T19:37:00.000Z';
  return {
    kind: 'g42-pi-app.chat-session',
    schemaVersion: 1,
    exportedAt: timestamp,
    pluginId: 'grafana-assistant-app',
    session: {
      id: 'assistant-sidebar-layout',
      title: 'Troubleshoot login latency',
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Investigate the login latency.' }],
          timestamp,
        },
      ],
      investigationReport: {
        id: 'login-latency',
        title: 'Analyse long-running login latency across the customer domain',
        status: 'active',
        scope: [
          'Dashboard UID: long-dashboard-identifier, Panel ID: 86 (Durchschnittliche Login-Zeit)',
          'Prometheus datasource UID: thanos-production-database',
          'Incident time range: now-6h to now, focus around 19:00',
        ],
        evidence: [
          'The customer domain latency series rises sharply at 18:57 and remains elevated through 19:08.',
          'The corresponding request-rate series remains within its normal operating range.',
        ],
        hypotheses: [
          'A downstream identity provider is adding latency after the application accepts each login request.',
          'A saturated connection pool is serialising work during the incident window.',
        ],
        ruledOut: [
          'A broad traffic spike is not supported by the request-rate series.',
          'Dashboard rendering delay does not explain the server-side metric increase.',
        ],
        nextSteps: [
          'Compare the login latency with identity-provider duration and connection-pool wait time.',
          'Inspect pod-level latency to determine whether the increase is isolated to one replica.',
        ],
        remediation: [
          'Drain an unhealthy replica if the pod comparison identifies a single outlier.',
          'Final remediation marker: validate the recovered login latency.',
        ],
        updatedAt: timestamp,
      },
    },
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
