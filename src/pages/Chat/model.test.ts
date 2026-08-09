import {
  createOpenAICompatibleModel,
  getConfiguredOpenAIProtocol,
  getConfiguredThinkingFormat,
  getConfiguredThinkingLevel,
} from './model';

describe('createOpenAICompatibleModel', () => {
  it('keeps reasoning disabled by default', () => {
    const model = createOpenAICompatibleModel();

    expect(model.reasoning).toBe(false);
    expect(model.api).toBe('openai-completions');
    if (model.api !== 'openai-completions') {
      throw new Error('expected Chat Completions model');
    }
    expect(model.compat?.thinkingFormat).toBe('openai');
    expect(model.compat?.supportsReasoningEffort).toBe(true);
  });

  it('enables OpenAI-compatible reasoning metadata when configured', () => {
    const model = createOpenAICompatibleModel({
      thinkingLevel: 'medium',
      thinkingFormat: 'openai',
    });

    expect(model.reasoning).toBe(true);
    if (model.api !== 'openai-completions') {
      throw new Error('expected Chat Completions model');
    }
    expect(model.thinkingLevelMap?.medium).toBe('medium');
    expect(model.compat?.thinkingFormat).toBe('openai');
    expect(model.compat?.supportsReasoningEffort).toBe(true);
  });

  it('uses qwen chat template compatibility without reasoning_effort support', () => {
    const model = createOpenAICompatibleModel({
      thinkingLevel: 'high',
      thinkingFormat: 'qwen-chat-template',
    });

    expect(model.reasoning).toBe(true);
    if (model.api !== 'openai-completions') {
      throw new Error('expected Chat Completions model');
    }
    expect(model.compat?.thinkingFormat).toBe('qwen-chat-template');
    expect(model.compat?.supportsReasoningEffort).toBe(false);
  });

  it('declares a Responses model when the protocol is explicit', () => {
    const model = createOpenAICompatibleModel({
      openAIProtocol: 'responses',
      thinkingLevel: 'medium',
    });

    expect(model.api).toBe('openai-responses');
    expect(model.reasoning).toBe(true);
    if (model.api !== 'openai-responses') {
      throw new Error('expected Responses model');
    }
    expect(model.compat?.sendSessionIdHeader).toBe(false);
  });
});

describe('thinking settings normalization', () => {
  it('normalizes unknown settings to safe defaults', () => {
    expect(getConfiguredThinkingLevel({ thinkingLevel: 'minimal' as any })).toBe('off');
    expect(getConfiguredThinkingFormat({ thinkingFormat: 'deepseek' as any })).toBe('openai');
    expect(getConfiguredOpenAIProtocol({ openAIProtocol: 'legacy' as any })).toBe('auto');
    expect(getConfiguredOpenAIProtocol({ openAIProtocol: 'responses' })).toBe('responses');
  });
});
