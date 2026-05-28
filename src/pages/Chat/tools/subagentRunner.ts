import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { textResult, truncateText, type TextToolResult } from './result';
import type { GrafanaToolRuntime } from './types';

export type SubagentKind = 'metrics' | 'jsonnet';
export type SubagentRunStatus = 'running' | 'completed' | 'failed';

export type SubagentToolCall = {
  id: string;
  name: string;
  args: unknown;
  status: SubagentRunStatus;
  text?: string;
  isError?: boolean;
};

export type SubagentUsage = {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

export type SubagentRunDetails = Record<string, unknown> & {
  type: 'subagent';
  agent: SubagentKind;
  status: SubagentRunStatus;
  task: string;
  toolNames: string[];
  toolCalls: SubagentToolCall[];
  usage: SubagentUsage;
  finalOutput?: string;
  error?: string;
};

type RunSubagentOptions = {
  kind: SubagentKind;
  task: string;
  systemPrompt: string;
  tools: AgentTool[];
  runtime: GrafanaToolRuntime;
  signal?: AbortSignal;
  onUpdate?: (partialResult: TextToolResult<SubagentRunDetails>) => void;
};

const MAX_CHILD_TOOL_CALLS = 14;

export async function runGrafanaSubagent(options: RunSubagentOptions): Promise<TextToolResult<SubagentRunDetails>> {
  const { Agent } = await import('@earendil-works/pi-agent-core');
  const toolCalls = new Map<string, SubagentToolCall>();
  const usage = zeroUsage();
  const toolNames = options.tools.map((tool) => tool.name);
  let finalOutput = '';
  let lastTextUpdateAt = 0;

  const details = (status: SubagentRunStatus, error?: string): SubagentRunDetails => ({
    type: 'subagent',
    agent: options.kind,
    status,
    task: options.task,
    toolNames,
    toolCalls: Array.from(toolCalls.values()),
    usage: { ...usage },
    finalOutput: finalOutput || undefined,
    error,
  });

  const emitUpdate = (status: SubagentRunStatus = 'running', error?: string) => {
    options.onUpdate?.(
      textResult(subagentStatusText(options.kind, status, toolCalls.size, finalOutput, error), details(status, error))
    );
  };
  const emitTextUpdate = () => {
    const now = Date.now();
    if (now - lastTextUpdateAt < 100) {
      return;
    }
    lastTextUpdateAt = now;
    emitUpdate('running');
  };

  const child = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.runtime.model,
      thinkingLevel: 'off',
      messages: [],
      tools: options.tools,
    },
    streamFn: options.runtime.streamFn,
    beforeToolCall: async () => {
      if (toolCalls.size >= MAX_CHILD_TOOL_CALLS) {
        return {
          block: true,
          reason: `Subagent tool budget exhausted after ${MAX_CHILD_TOOL_CALLS} tool calls. Return a concise summary with what you found.`,
        };
      }
      return undefined;
    },
  });

  const abortChild = () => child.abort();
  if (options.signal?.aborted) {
    abortChild();
  } else {
    options.signal?.addEventListener('abort', abortChild, { once: true });
  }

  const unsubscribe = child.subscribe((event) => {
    handleChildEvent(event, toolCalls, usage);
    if (event.type === 'message_update' && event.message.role === 'assistant') {
      const text = getContentText(event.message.content);
      if (text && text !== finalOutput) {
        finalOutput = text;
        emitTextUpdate();
      }
    }
    if (event.type === 'message_end') {
      finalOutput = getLastAssistantText(child.state.messages) || finalOutput;
      if (event.message.role === 'assistant') {
        emitUpdate('running');
      }
    }
    if (
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update' ||
      event.type === 'tool_execution_end'
    ) {
      emitUpdate('running');
    }
  });

  try {
    emitUpdate('running');
    await child.prompt(options.task);
    finalOutput = getLastAssistantText(child.state.messages) || finalOutput || '(no output)';
    return textResult(finalOutput, details('completed'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finalOutput = finalOutput || message;
    return textResult(`Subagent failed: ${message}`, details('failed', message));
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', abortChild);
  }
}

function handleChildEvent(event: AgentEvent, toolCalls: Map<string, SubagentToolCall>, usage: SubagentUsage) {
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    addUsage(usage, event.message);
    return;
  }

  if (event.type === 'tool_execution_start') {
    toolCalls.set(event.toolCallId, {
      id: event.toolCallId,
      name: event.toolName,
      args: event.args,
      status: 'running',
    });
    return;
  }

  if (event.type === 'tool_execution_update') {
    const existing = toolCalls.get(event.toolCallId);
    toolCalls.set(event.toolCallId, {
      ...existing,
      id: event.toolCallId,
      name: event.toolName,
      args: event.args,
      status: 'running',
      text: getContentText(event.partialResult?.content),
      isError: false,
    });
    return;
  }

  if (event.type === 'tool_execution_end') {
    const existing = toolCalls.get(event.toolCallId);
    toolCalls.set(event.toolCallId, {
      ...existing,
      id: event.toolCallId,
      name: event.toolName,
      args: existing?.args,
      status: event.isError ? 'failed' : 'completed',
      text: getContentText(event.result?.content),
      isError: event.isError,
    });
  }
}

function addUsage(total: SubagentUsage, message: AgentMessage) {
  const usage = (message as any).usage;
  if (!usage) {
    return;
  }
  total.turns += 1;
  total.input += Number(usage.input ?? 0);
  total.output += Number(usage.output ?? 0);
  total.cacheRead += Number(usage.cacheRead ?? 0);
  total.cacheWrite += Number(usage.cacheWrite ?? 0);
  total.totalTokens = Number(usage.totalTokens ?? total.input + total.output + total.cacheRead + total.cacheWrite);
  total.cost += Number(usage.cost?.total ?? 0);
}

function getLastAssistantText(messages: readonly AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant') {
      return getContentText((message as any).content);
    }
  }
  return '';
}

function getContentText(content: unknown) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return '';
      }
      const typed = block as Record<string, unknown>;
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function subagentStatusText(
  kind: SubagentKind,
  status: SubagentRunStatus,
  toolCallCount: number,
  finalOutput: string,
  error?: string
) {
  const label = kind === 'metrics' ? 'Metrics explorer' : 'Jsonnet explorer';
  if (status === 'failed') {
    return `${label} failed${error ? `: ${error}` : ''}`;
  }
  if (status === 'completed') {
    return truncateText(finalOutput || `${label} completed.`, 4000);
  }
  if (finalOutput.trim()) {
    return `${label} drafting:\n${truncateText(finalOutput, 1200)}`;
  }
  return `${label} running. ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'} so far.`;
}

function zeroUsage(): SubagentUsage {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}
