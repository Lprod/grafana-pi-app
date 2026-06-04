import { createOpenAICompatibleModel, getConfiguredThinkingFormat, getConfiguredThinkingLevel } from './model';

describe('createOpenAICompatibleModel', () => {
  it('keeps reasoning disabled by default', () => {
    const model = createOpenAICompatibleModel();

    expect(model.reasoning).toBe(false);
    expect(model.compat?.thinkingFormat).toBe('openai');
    expect(model.compat?.supportsReasoningEffort).toBe(true);
  });

  it('enables OpenAI-compatible reasoning metadata when configured', () => {
    const model = createOpenAICompatibleModel({
      thinkingLevel: 'medium',
      thinkingFormat: 'openai',
    });

    expect(model.reasoning).toBe(true);
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
    expect(model.compat?.thinkingFormat).toBe('qwen-chat-template');
    expect(model.compat?.supportsReasoningEffort).toBe(false);
  });
});

describe('thinking settings normalization', () => {
  it('normalizes unknown settings to safe defaults', () => {
    expect(getConfiguredThinkingLevel({ thinkingLevel: 'minimal' as any })).toBe('off');
    expect(getConfiguredThinkingFormat({ thinkingFormat: 'deepseek' as any })).toBe('openai');
  });
});
