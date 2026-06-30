import { test, expect } from './fixtures';
import type { AppConfigPage, Page } from '@grafana/plugin-e2e';
import { testIds } from '../src/components/testIds';
import type { PiAppThinkingFormat, PiAppThinkingLevel } from '../src/types';

const defaultLocalLLMSettings = {
  baseURL: 'http://host.docker.internal:8080/v1',
  model: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
  thinkingLevel: 'medium' as const,
  thinkingFormat: 'qwen-chat-template' as const,
};

const localLLMSettings = {
  apiKey: process.env.OPENAI_API_KEY || 'local-dev-key',
  baseURL: process.env.E2E_OPENAI_BASE_URL || process.env.PI_OPENAI_BASE_URL || defaultLocalLLMSettings.baseURL,
  model: process.env.E2E_DEFAULT_MODEL || process.env.PI_DEFAULT_MODEL || defaultLocalLLMSettings.model,
  thinkingLevel: readThinkingLevel(process.env.E2E_THINKING_LEVEL || process.env.PI_THINKING_LEVEL),
  thinkingFormat: readThinkingFormat(process.env.E2E_THINKING_FORMAT || process.env.PI_THINKING_FORMAT),
  systemPromptAddendum: '',
};

test('should be possible to save app configuration', async ({ appConfigPage, page }) => {
  await saveLLMSettings(appConfigPage, page, {
    apiKey: 'secret-api-key',
    baseURL: 'https://api.openai.example/v1',
    model: 'gpt-test',
    systemPromptAddendum: 'Prefer concise incident summaries.',
    customSkill: {
      name: 'team-runbook',
      description: 'Team incident workflow.',
      content: '# Team Runbook\n\nUse the internal incident workflow.',
    },
  });
  await saveLLMSettings(appConfigPage, page, localLLMSettings);
});

async function saveLLMSettings(
  appConfigPage: AppConfigPage,
  page: Page,
  settings: {
    apiKey: string;
    baseURL: string;
    model: string;
    thinkingLevel?: PiAppThinkingLevel;
    thinkingFormat?: PiAppThinkingFormat;
    systemPromptAddendum?: string;
    customSkill?: {
      name: string;
      description: string;
      content: string;
    };
  }
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
  await selectThinkingLevel(page, settings.thinkingLevel ?? 'off');
  await selectThinkingFormat(page, settings.thinkingFormat ?? 'openai');
  await page.getByRole('textbox', { name: 'System prompt addendum' }).clear();
  if (settings.systemPromptAddendum) {
    await page.getByRole('textbox', { name: 'System prompt addendum' }).fill(settings.systemPromptAddendum);
  }

  await clearCustomSkills(page);
  if (settings.customSkill) {
    await addCustomSkill(page, settings.customSkill);
  }

  const saveResponse = appConfigPage.waitForSettingsResponse();
  await page.getByRole('button', { name: /Save LLM settings/i }).click();
  await expect(saveResponse).toBeOK();
}

async function selectThinkingLevel(page: Page, value: PiAppThinkingLevel) {
  await page
    .getByTestId(testIds.appConfig.thinkingLevel)
    .getByRole('radio', { name: thinkingLevelLabels[value] })
    .check({ force: true });
}

async function selectThinkingFormat(page: Page, value: PiAppThinkingFormat) {
  await page
    .getByTestId(testIds.appConfig.thinkingFormat)
    .getByRole('radio', { name: thinkingFormatLabels[value] })
    .check({ force: true });
}

async function clearCustomSkills(page: Page) {
  const deleteButtons = page.getByTestId(testIds.appConfig.customSkillDelete);

  while ((await deleteButtons.count()) > 0) {
    await deleteButtons.first().click();
  }
}

async function addCustomSkill(
  page: Page,
  skill: {
    name: string;
    description: string;
    content: string;
  }
) {
  await page.getByTestId(testIds.appConfig.customSkillAdd).click();
  await page.getByTestId(testIds.appConfig.customSkillName).clear();
  await page.getByTestId(testIds.appConfig.customSkillName).fill(skill.name);
  await page.getByTestId(testIds.appConfig.customSkillDescription).fill(skill.description);

  const editor = page.getByTestId(testIds.appConfig.customSkillContent).locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText(skill.content);
  await page.getByRole('button', { name: 'Done' }).click();
}

function readThinkingLevel(value: string | undefined): PiAppThinkingLevel {
  return isThinkingLevel(value) ? value : defaultLocalLLMSettings.thinkingLevel;
}

function readThinkingFormat(value: string | undefined): PiAppThinkingFormat {
  return isThinkingFormat(value) ? value : defaultLocalLLMSettings.thinkingFormat;
}

function isThinkingLevel(value: string | undefined): value is PiAppThinkingLevel {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high';
}

function isThinkingFormat(value: string | undefined): value is PiAppThinkingFormat {
  return value === 'openai' || value === 'qwen' || value === 'qwen-chat-template';
}

const thinkingLevelLabels: Record<PiAppThinkingLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const thinkingFormatLabels: Record<PiAppThinkingFormat, string> = {
  openai: 'OpenAI',
  qwen: 'Qwen',
  'qwen-chat-template': 'Qwen template',
};
