import type { Model } from '@earendil-works/pi-ai';

export type PiAppJsonData = {
  openAIBaseUrl?: string;
  defaultModel?: string;
  isOpenAIAPIKeySet?: boolean;
};

export function createOpenAICompatibleModel(jsonData?: PiAppJsonData): Model<'openai-completions'> {
  const modelId = jsonData?.defaultModel || 'gpt-4.1';

  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'openai-compatible',
    baseUrl: jsonData?.openAIBaseUrl || 'https://api.openai.com/v1',
    reasoning: false,
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
    },
  };
}
