import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';

const sseResponse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

test.describe('dashboard bootstrap command', () => {
  test('selects a dashboard and sends compact hidden bootstrap context', async ({ gotoPage, page }) => {
    const uid = `bootstrap-e2e-${Date.now()}`;
    const title = `Bootstrap E2E ${Date.now()}`;
    let llmRequestBody: any;

    const saveResponse = await page.request.post('/api/dashboards/db', {
      data: {
        dashboard: {
          uid,
          title,
          tags: ['bootstrap-e2e'],
          time: { from: 'now-6h', to: 'now' },
          templating: {
            list: [
              {
                name: 'service',
                type: 'custom',
                query: 'api,worker',
                current: { text: 'api', value: 'api' },
                options: [
                  { text: 'api', value: 'api', selected: true },
                  { text: 'worker', value: 'worker' },
                ],
              },
            ],
          },
          panels: [
            {
              id: 1,
              title: 'Request rate',
              type: 'timeseries',
              description: 'Requests grouped by service.',
              datasource: { uid: 'prometheus', type: 'prometheus' },
              targets: [
                {
                  refId: 'A',
                  datasource: { uid: 'prometheus', type: 'prometheus' },
                  expr: 'sum(rate(http_requests_total{service="$service"}[$__rate_interval]))',
                },
              ],
            },
          ],
        },
        overwrite: true,
      },
    });
    expect(saveResponse).toBeOK();

    try {
      await page.route('**/api/plugins/g42-pi-app/resources/llm/api/stream', async (route) => {
        llmRequestBody = await route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse([
            { type: 'start' },
            { type: 'text_start', contentIndex: 0 },
            { type: 'text_delta', contentIndex: 0, delta: 'Bootstrap context received.' },
            { type: 'text_end', contentIndex: 0 },
            {
              type: 'done',
              reason: 'stop',
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          ]),
        });
      });

      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();

      const composer = page.getByTestId(testIds.chat.composer);
      await composer.fill('/bootstrap');

      await expect(page.getByRole('dialog', { name: 'Bootstrap from dashboard' })).toBeVisible();
      await page.getByPlaceholder('Search dashboards').fill(title);
      await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
      await page.getByRole('button', { name: new RegExp(title) }).click();

      await expect(page.getByText(title)).toBeVisible();
      await composer.fill('What does this dashboard cover?');
      await page.getByTestId(testIds.chat.send).click();

      await expect(page.getByText('Bootstrap context received.')).toBeVisible();
      expect(llmRequestBody).toBeDefined();

      const llmText = llmRequestBody.context.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : [{ text: message.content }]))
        .map((block: any) => block.text)
        .join('\n');

      expect(llmText).toContain('What does this dashboard cover?');
      expect(llmText).toContain('## Dashboard bootstrap context');
      expect(llmText).toContain(`# Dashboard bootstrap: ${title}`);
      expect(llmText).toContain('service: custom');
      expect(llmText).toContain('Request rate [timeseries]');
      expect(llmText).toContain('sum(rate(http_requests_total{service="$service"}[$__rate_interval]))');
      await expect(page.getByText(`# Dashboard bootstrap: ${title}`)).toHaveCount(0);
    } finally {
      await page.unroute('**/api/plugins/g42-pi-app/resources/llm/api/stream').catch(() => undefined);
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(uid)}`).catch(() => undefined);
    }
  });
});
