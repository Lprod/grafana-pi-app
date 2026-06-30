import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { textResult } from './result';
import { runSpecialistAgent } from './subagentRunner';

const qwenModel = {
  id: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
  name: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
  api: 'openai-completions',
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8080/v1',
  reasoning: true,
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
    thinkingFormat: 'qwen-chat-template',
  },
} as any;

describe('subagent streaming', () => {
  it('emits parent tool updates while the child agent is still running', async () => {
    const runtimeToolUpdates: Array<{ timestamp: number; update: any }> = [];
    const slowTool: AgentTool = {
      name: 'slow_inner_tool',
      label: 'Slow inner tool',
      description: 'Slow inner tool used to prove nested-agent progress is streamed.',
      parameters: {} as any,
      async execute(_toolCallId, _params, _signal, onUpdate) {
        await delay(40);
        onUpdate?.(textResult('inner tool step 1', { step: 1 }));
        await delay(90);
        onUpdate?.(textResult('inner tool step 2', { step: 2 }));
        await delay(90);
        return textResult('inner tool complete', { step: 3 });
      },
    };

    const streamFn = createNestedAgentStream();
    const subagentTool: AgentTool = {
      name: 'run_query_agent',
      label: 'Run query agent',
      description: 'Delegate Prometheus metric discovery and PromQL validation to a focused query specialist.',
      executionMode: 'sequential',
      parameters: {} as any,
      async execute(toolCallId, params, signal, onUpdate) {
        return runSpecialistAgent({
          kind: 'query',
          task: String((params as { task?: string }).task ?? ''),
          systemPrompt: 'You are a focused query specialist.',
          tools: [slowTool],
          runtime: {
            model: qwenModel,
            streamFn,
            thinkingLevel: 'medium',
            emitToolUpdate: (update) => runtimeToolUpdates.push({ timestamp: Date.now(), update }),
          },
          signal,
          onUpdate,
          parentTool: {
            id: toolCallId,
            name: 'run_query_agent',
            args: params,
          },
        });
      },
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: 'Use the query specialist for metric discovery.',
        model: qwenModel,
        thinkingLevel: 'medium',
        tools: [subagentTool],
      },
      streamFn,
    });
    const events: Array<{ type: string; timestamp: number; event: any }> = [];

    agent.subscribe((event) => {
      events.push({ type: event.type, timestamp: Date.now(), event });
    });

    await agent.prompt('Use run_query_agent for a slow metric lookup, then summarize the result.');

    const queryAgentUpdates = events.filter(
      ({ event }) => event.type === 'tool_execution_update' && event.toolName === 'run_query_agent'
    );
    const queryAgentEnd = events.find(
      ({ event }) => event.type === 'tool_execution_end' && event.toolName === 'run_query_agent'
    );

    expect(queryAgentEnd).toBeDefined();
    expect(queryAgentUpdates.length).toBeGreaterThanOrEqual(3);
    expect(runtimeToolUpdates.length).toBeGreaterThanOrEqual(3);
    expect(runtimeToolUpdates[0].update.toolCallId).toBe('call_parent_query');
    expect(runtimeToolUpdates[0].update.toolName).toBe('run_query_agent');
    expect(queryAgentEnd!.timestamp - runtimeToolUpdates[0].timestamp).toBeGreaterThanOrEqual(150);
    expect(resultDetails(runtimeToolUpdates.at(-1)?.update.partialResult)?.status).toBe('completed');
    expect(queryAgentEnd!.timestamp - queryAgentUpdates[0].timestamp).toBeGreaterThanOrEqual(150);
    expect(queryAgentUpdates.some(({ event }) => nestedToolCallCount(event.partialResult) > 0)).toBe(true);
    expect(runtimeToolUpdates.some(({ update }) => nestedToolCallCount(update.partialResult) > 0)).toBe(true);
    expect(
      queryAgentUpdates.some(({ event }) => resultText(event.partialResult).includes('Query agent drafting'))
    ).toBe(true);
  });
});

function createNestedAgentStream(): StreamFn {
  let parentTurns = 0;
  let childTurns = 0;

  return ((model, context) => {
    const stream = new TestAssistantMessageEventStream();
    const toolNames = new Set(context.tools?.map((tool) => tool.name) ?? []);

    if (toolNames.has('run_query_agent')) {
      parentTurns += 1;
      if (parentTurns === 1) {
        emitToolCall(stream, model, 'call_parent_query', 'run_query_agent', {
          task: 'Run the slow inner metric lookup and report the streamed progress.',
        });
      } else {
        emitText(stream, model, ['Supervisor saw the streamed specialist result.']);
      }
      return stream as any;
    }

    if (toolNames.has('slow_inner_tool')) {
      childTurns += 1;
      if (childTurns === 1) {
        emitToolCall(stream, model, 'call_inner_slow_tool', 'slow_inner_tool', { value: 'http_requests_total' });
      } else {
        emitText(stream, model, ['child ', 'draft ', 'complete']);
      }
      return stream as any;
    }

    emitText(stream, model, ['No specialist tool was available.']);
    return stream as any;
  }) as StreamFn;
}

function emitToolCall(
  stream: TestAssistantMessageEventStream,
  model: any,
  id: string,
  name: string,
  args: Record<string, unknown>
) {
  void (async () => {
    await delay(10);
    const message = assistantMessage(model, [{ type: 'toolCall', id, name, arguments: args }], 'toolUse');
    stream.push({ type: 'done', reason: 'toolUse', message });
  })();
}

function emitText(stream: TestAssistantMessageEventStream, model: any, chunks: string[]) {
  void (async () => {
    let text = '';
    let partial = assistantMessage(model, [{ type: 'text', text }], 'stop');
    stream.push({ type: 'start', partial });
    stream.push({ type: 'text_start', contentIndex: 0, partial });

    for (const chunk of chunks) {
      await delay(70);
      text += chunk;
      partial = assistantMessage(model, [{ type: 'text', text }], 'stop');
      stream.push({ type: 'text_delta', contentIndex: 0, delta: chunk, partial });
    }

    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial });
    stream.push({ type: 'done', reason: 'stop', message: assistantMessage(model, [{ type: 'text', text }], 'stop') });
  })();
}

function assistantMessage(
  model: any,
  content: Array<Record<string, unknown>>,
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
) {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

class TestAssistantMessageEventStream implements AsyncIterable<any> {
  private queue: any[] = [];
  private waiting: Array<(result: IteratorResult<any>) => void> = [];
  private done = false;
  private finalResultPromise: Promise<any>;
  private resolveFinalResult!: (result: any) => void;

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: any) {
    if (this.done) {
      return;
    }
    if (event.type === 'done') {
      this.done = true;
      this.resolveFinalResult(event.message);
    }
    if (event.type === 'error') {
      this.done = true;
      this.resolveFinalResult(event.error);
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
        continue;
      }
      if (this.done) {
        return;
      }
      const result = await new Promise<IteratorResult<any>>((resolve) => this.waiting.push(resolve));
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }

  result() {
    return this.finalResultPromise;
  }
}

function nestedToolCallCount(result: unknown) {
  const details = resultDetails(result);
  return Array.isArray(details?.toolCalls) ? details.toolCalls.length : 0;
}

function resultText(result: unknown) {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  return Array.isArray(content)
    ? content
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join('\n')
        .trim()
    : '';
}

function resultDetails(result: unknown) {
  return (result as { details?: { toolCalls?: unknown[]; status?: string } } | undefined)?.details;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
