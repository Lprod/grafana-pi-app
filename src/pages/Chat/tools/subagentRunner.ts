import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
} from '@earendil-works/pi-agent-core';
import { textResult, truncateText, type TextToolResult } from './result';
import type { GrafanaToolRuntime } from './types';

export type AgentSpecialistKind = 'query' | 'dashboard' | 'investigation' | 'support' | 'navigation';
export type SubagentKind = AgentSpecialistKind;
export type SubagentRunStatus = 'running' | 'completed' | 'failed';

export type SubagentToolCall = {
  id: string;
  name: string;
  args: unknown;
  status: SubagentRunStatus;
  partialResult?: AgentToolResult<any>;
  result?: AgentToolResult<any>;
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

const CHILD_TOOL_CALL_LIMITS: Record<SubagentKind, number> = {
  query: 14,
  dashboard: 24,
  investigation: 20,
  support: 6,
  navigation: 4,
};
const MAX_SPECIALIST_FOLLOW_UPS = 3;

export async function runSpecialistAgent(options: RunSubagentOptions): Promise<TextToolResult<SubagentRunDetails>> {
  const toolCalls = new Map<string, SubagentToolCall>();
  const usage = zeroUsage();
  const toolNames = options.tools.map((tool) => tool.name);
  let finalOutput = '';
  let lastTextUpdateAt = 0;
  let followUpCount = 0;

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
      thinkingLevel: options.runtime.thinkingLevel,
      messages: [],
      tools: options.tools,
    },
    streamFn: options.runtime.streamFn,
    afterToolCall: options.runtime.afterToolCall,
    beforeToolCall: async (context, signal) => {
      const toolCallLimit = CHILD_TOOL_CALL_LIMITS[options.kind];
      if (toolCalls.size >= toolCallLimit) {
        return {
          block: true,
          reason: `Specialist tool budget exhausted after ${toolCallLimit} tool calls. Return a concise summary with what you found.`,
        };
      }
      return options.runtime.beforeToolCall?.(context, signal);
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
    if (event.type === 'turn_end' && event.message.role === 'assistant' && event.toolResults.length === 0) {
      const followUp = buildSpecialistFollowUp(options.kind, options.task, toolCalls, followUpCount);
      if (followUp) {
        followUpCount += 1;
        child.followUp(followUp);
      }
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
      partialResult: event.partialResult,
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
      result: event.result,
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
  const label = subagentLabel(kind);
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

export function specialistLabel(kind: SubagentKind) {
  switch (kind) {
    case 'query':
      return 'Query agent';
    case 'dashboard':
      return 'Dashboard agent';
    case 'investigation':
      return 'Investigation agent';
    case 'support':
      return 'Support agent';
    case 'navigation':
      return 'Navigation agent';
  }
}

function subagentLabel(kind: SubagentKind) {
  return specialistLabel(kind);
}

function buildSpecialistFollowUp(
  kind: SubagentKind,
  task: string,
  toolCalls: Map<string, SubagentToolCall>,
  followUpCount: number
): AgentMessage | undefined {
  if (kind !== 'dashboard' || !dashboardTaskRequiresSync(task) || followUpCount >= MAX_SPECIALIST_FOLLOW_UPS) {
    return undefined;
  }

  if (hasSuccessfulToolCall(toolCalls, 'sync_dashboard')) {
    return undefined;
  }

  const missing = missingDashboardCompletionSteps(toolCalls);
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          'Continue this dashboard create/update task; it is incomplete until the managed dashboard is synced.',
          `Missing successful steps: ${missing.join(', ')}.`,
          'Use the verified datasource UID and metrics already gathered.',
          'If no virtual Jsonnet source exists, call write_jsonnet with a self-contained plain Grafana dashboard object.',
          'Then call render_dashboard, repair Jsonnet if render fails, and call sync_dashboard.',
          'Do not report completion until sync_dashboard succeeds. If a required tool fails, return the exact failure.',
        ].join('\n'),
      },
    ],
    timestamp: Date.now(),
  };
}

function dashboardTaskRequiresSync(task: string) {
  const normalized = task.toLowerCase();
  if (/\bintent:\s*review\b/.test(normalized)) {
    return false;
  }
  if (/\b(draft|preview|plan only|design only|no-sync|no sync|do not sync|without syncing)\b/.test(normalized)) {
    return false;
  }
  return /\bintent:\s*(create|update)\b/.test(normalized) || /\b(create|build|update|apply|sync)\b/.test(normalized);
}

function missingDashboardCompletionSteps(toolCalls: Map<string, SubagentToolCall>) {
  const missing: string[] = [];
  if (!hasAnySuccessfulToolCall(toolCalls, ['write_jsonnet', 'edit_jsonnet', 'fix_jsonnet'])) {
    missing.push('write_jsonnet or edit_jsonnet');
  }
  if (!hasSuccessfulToolCall(toolCalls, 'render_dashboard')) {
    missing.push('render_dashboard');
  }
  if (!hasSuccessfulToolCall(toolCalls, 'sync_dashboard')) {
    missing.push('sync_dashboard');
  }
  return missing;
}

function hasAnySuccessfulToolCall(toolCalls: Map<string, SubagentToolCall>, names: string[]) {
  return names.some((name) => hasSuccessfulToolCall(toolCalls, name));
}

function hasSuccessfulToolCall(toolCalls: Map<string, SubagentToolCall>, name: string) {
  return Array.from(toolCalls.values()).some(
    (call) => call.name === name && call.status === 'completed' && call.isError !== true
  );
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
