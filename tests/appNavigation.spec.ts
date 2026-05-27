import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';

test.describe('navigating app', () => {
  test('chat page should render successfully', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Chat}`);
    await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
    await expect(page.getByRole('button', { name: /Send/i })).toBeVisible();
  });
});
