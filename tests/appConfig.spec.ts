import { test, expect } from './fixtures';

test('should be possible to save app configuration', async ({ appConfigPage, page }) => {
  const saveButton = page.getByRole('button', { name: /Save LLM settings/i });

  // reset the configured secret
  await page.getByRole('button', { name: /reset/i }).click();

  // enter some valid values
  await page.getByRole('textbox', { name: 'API Key' }).fill('secret-api-key');
  await page.getByRole('textbox', { name: 'Base URL' }).clear();
  await page.getByRole('textbox', { name: 'Base URL' }).fill('https://api.openai.example/v1');
  await page.getByRole('textbox', { name: 'Model' }).clear();
  await page.getByRole('textbox', { name: 'Model' }).fill('gpt-test');

  // listen for the server response on the saved form
  const saveResponse = appConfigPage.waitForSettingsResponse();

  await saveButton.click();
  await expect(saveResponse).toBeOK();
});
