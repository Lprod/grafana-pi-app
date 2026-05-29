import { test, expect } from './fixtures';
import type { AppConfigPage, Page } from '@grafana/plugin-e2e';

const localLLMSettings = {
  apiKey: process.env.OPENAI_API_KEY || 'local-dev-key',
  baseURL: process.env.E2E_OPENAI_BASE_URL || 'http://host.docker.internal:8080/v1',
  model: process.env.E2E_DEFAULT_MODEL || 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
};

test('should be possible to save app configuration', async ({ appConfigPage, page }) => {
  await saveLLMSettings(appConfigPage, page, {
    apiKey: 'secret-api-key',
    baseURL: 'https://api.openai.example/v1',
    model: 'gpt-test',
  });
  await saveLLMSettings(appConfigPage, page, localLLMSettings);
});

async function saveLLMSettings(
  appConfigPage: AppConfigPage,
  page: Page,
  settings: { apiKey: string; baseURL: string; model: string }
) {
  await page
    .getByRole('button', { name: /reset/i })
    .click({ timeout: 5000 })
    .catch(() => undefined);

  await page.getByRole('textbox', { name: 'API Key' }).fill(settings.apiKey);
  await page.getByRole('textbox', { name: 'Base URL' }).clear();
  await page.getByRole('textbox', { name: 'Base URL' }).fill(settings.baseURL);
  await page.getByRole('textbox', { name: 'Model' }).clear();
  await page.getByRole('textbox', { name: 'Model' }).fill(settings.model);

  const saveResponse = appConfigPage.waitForSettingsResponse();
  await page.getByRole('button', { name: /Save LLM settings/i }).click();
  await expect(saveResponse).toBeOK();
}
