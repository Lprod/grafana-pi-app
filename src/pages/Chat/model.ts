import type { Model } from '@earendil-works/pi-ai';
import type { PiAppJsonData, PiAppThinkingFormat, PiAppThinkingLevel } from '../../types';

export type { PiAppJsonData } from '../../types';

export const DEFAULT_THINKING_LEVEL: PiAppThinkingLevel = 'off';
export const DEFAULT_THINKING_FORMAT: PiAppThinkingFormat = 'openai';

export function createOpenAICompatibleModel(jsonData?: PiAppJsonData): Model<'openai-completions'> {
  const modelId = jsonData?.defaultModel || 'gpt-4.1';
  const thinkingLevel = getConfiguredThinkingLevel(jsonData);
  const thinkingFormat = getConfiguredThinkingFormat(jsonData);

  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'openai-compatible',
    baseUrl: jsonData?.openAIBaseUrl || 'https://api.openai.com/v1',
    reasoning: thinkingLevel !== 'off',
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
    },
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
    compat: {
      supportsUsageInStreaming: true,
      maxTokensField: 'max_tokens',
      supportsReasoningEffort: thinkingFormat === 'openai',
      thinkingFormat,
    },
  };
}

export function getConfiguredThinkingLevel(jsonData?: Pick<PiAppJsonData, 'thinkingLevel'>): PiAppThinkingLevel {
  const value = jsonData?.thinkingLevel;
  return value === 'low' || value === 'medium' || value === 'high' ? value : DEFAULT_THINKING_LEVEL;
}

export function getConfiguredThinkingFormat(jsonData?: Pick<PiAppJsonData, 'thinkingFormat'>): PiAppThinkingFormat {
  const value = jsonData?.thinkingFormat;
  return value === 'qwen' || value === 'qwen-chat-template' ? value : DEFAULT_THINKING_FORMAT;
}
