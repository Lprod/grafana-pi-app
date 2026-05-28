import React, { FormEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { Agent, type AgentEvent, type AgentMessage, type StreamFn, streamProxy } from '@earendil-works/pi-agent-core';
import { SceneComponentProps, SceneObjectBase, SceneObjectState } from '@grafana/scenes';
import { Alert, Badge, Button, EmptyState, Spinner, TextArea, useStyles2 } from '@grafana/ui';
import { usePluginUserStorage } from '@grafana/runtime';
import type { GrafanaTheme2 } from '@grafana/data';
import { PLUGIN_ID } from '../../constants';
import { testIds } from '../../components/testIds';
import { usePluginMeta } from '../../utils/utils.plugin';
import { createGrafanaTools, normalizeJsonnetPath, type VirtualJsonnetFileSnapshot } from './grafanaTools';
import { formatAssistantError, type AssistantErrorView } from './llmErrors';
import { createOpenAICompatibleModel, type PiAppJsonData } from './model';
import { SYSTEM_PROMPT } from './systemPrompt';
import { ContentBlocks, ToolActivityPanel, ToolResultMessageBody, type ToolRunView } from './ToolRenderer';

type ChatSceneObjectState = SceneObjectState;

type SessionIndexItem = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type StoredSession = SessionIndexItem & {
  messages: AgentMessage[];
  modelId?: string;
  virtualJsonnetFiles?: Record<string, VirtualJsonnetFileSnapshot>;
};

type ToolRunState = Record<string, ToolRunView>;

const SESSION_INDEX_KEY = 'sessions:index';
const sessionKey = (id: string) => `sessions:${id}`;

type BenchmarkAgentEvent = {
  type: AgentEvent['type'];
  timestamp: number;
  [key: string]: unknown;
};

declare global {
  interface Window {
    __PI_AGENT_BENCHMARK_RECORD_EVENT__?: (event: BenchmarkAgentEvent) => void;
  }
}

export class ChatSceneObject extends SceneObjectBase<ChatSceneObjectState> {
  static Component = ChatSceneRenderer;
}

function ChatSceneRenderer({ model }: SceneComponentProps<ChatSceneObject>) {
  model.useState();
  return <ChatApp />;
}

function ChatApp() {
  const styles = useStyles2(getStyles);
  const storage = usePluginUserStorage();
  const pluginMeta = usePluginMeta();
  const jsonData = useMemo(() => (pluginMeta?.jsonData ?? {}) as PiAppJsonData, [pluginMeta?.jsonData]);
  const llmModel = useMemo(() => createOpenAICompatibleModel(jsonData), [jsonData]);
  const streamFn = useCallback<StreamFn>(
    (model, context, options) =>
      streamProxy(model, context, {
        ...options,
        authToken: 'grafana',
        proxyUrl: `/api/plugins/${PLUGIN_ID}/resources/llm`,
      }),
    []
  );
  const sessionIdRef = useRef<string>();
  const virtualJsonnetFilesRef = useRef<Record<string, VirtualJsonnetFileSnapshot>>({});
  const virtualJsonnetHydratedRef = useRef<Record<string, number>>({});
  const setVirtualJsonnetFile = useCallback((file: VirtualJsonnetFileSnapshot, options?: { hydrated?: boolean }) => {
    const path = normalizeJsonnetPath(file.path);
    const snapshot = { ...file, path };
    virtualJsonnetFilesRef.current = {
      ...virtualJsonnetFilesRef.current,
      [path]: snapshot,
    };
    if (options?.hydrated) {
      virtualJsonnetHydratedRef.current[path] = file.version;
    }
  }, []);
  const virtualJsonnetRuntime = useMemo(
    () => ({
      getSessionId: () => sessionIdRef.current,
      getFile: (path: string) => virtualJsonnetFilesRef.current[normalizeJsonnetPath(path)],
      setFile: setVirtualJsonnetFile,
      isHydrated: (path: string, version: number) =>
        virtualJsonnetHydratedRef.current[normalizeJsonnetPath(path)] === version,
      markHydrated: (path: string, version: number) => {
        virtualJsonnetHydratedRef.current[normalizeJsonnetPath(path)] = version;
      },
    }),
    [setVirtualJsonnetFile]
  );
  const [agent, setAgent] = useState<Agent>();
  const { revision, flushRevision, scheduleRevision } = useFrameRevision();
  const [input, setInput] = useState('');
  const [sessions, setSessions] = useState<SessionIndexItem[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [currentTitle, setCurrentTitle] = useState('New chat');
  const [error, setError] = useState<string>();
  const [toolRuns, setToolRuns] = useState<ToolRunState>({});
  const unsubscribeRef = useRef<() => void>();
  const titleRef = useRef('New chat');
  const sessionsRef = useRef<SessionIndexItem[]>([]);
  const storageRef = useRef(storage);
  const messagesContainerRef = useRef<HTMLElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const persistIndex = useCallback(
    async (next: SessionIndexItem[]) => {
      sessionsRef.current = next;
      setSessions(next);
      await storage.setItem(SESSION_INDEX_KEY, JSON.stringify(next));
    },
    [storage]
  );

  const saveSession = useCallback(
    async (id: string, title: string, messages: AgentMessage[]) => {
      if (
        !messages.some((message) => message.role === 'user') &&
        !messages.some((message) => message.role === 'assistant')
      ) {
        return;
      }

      const now = new Date().toISOString();
      const indexItem: SessionIndexItem = {
        id,
        title,
        createdAt: sessionsRef.current.find((session) => session.id === id)?.createdAt ?? now,
        updatedAt: now,
      };
      const stored: StoredSession = {
        ...indexItem,
        messages,
        virtualJsonnetFiles: virtualJsonnetFilesRef.current,
      };
      const next = [indexItem, ...sessionsRef.current.filter((session) => session.id !== id)].slice(0, 50);

      await storage.setItem(sessionKey(id), JSON.stringify(stored));
      await persistIndex(next);
    },
    [persistIndex, storage]
  );

  const buildAgent = useCallback(
    (messages: AgentMessage[] = []) => {
      unsubscribeRef.current?.();
      const tools = createGrafanaTools({
        ...jsonData,
        runtime: { model: llmModel, streamFn },
        virtualJsonnetFiles: virtualJsonnetRuntime,
      });
      const nextAgent = new Agent({
        initialState: {
          systemPrompt: SYSTEM_PROMPT,
          model: llmModel,
          thinkingLevel: 'off',
          messages,
          tools,
        },
        streamFn,
      });

      unsubscribeRef.current = nextAgent.subscribe((event) => {
        emitBenchmarkEvent(event);
        if (shouldBatchRevision(event)) {
          scheduleRevision();
        } else {
          flushRevision();
        }
        setToolRuns((value) => reduceToolRuns(value, event));
        if (event.type === 'agent_end') {
          const sessionId = sessionIdRef.current;
          if (sessionId) {
            void saveSession(sessionId, titleRef.current, nextAgent.state.messages);
          }
        }
      });

      setAgent(nextAgent);
      flushRevision();
      return nextAgent;
    },
    [flushRevision, jsonData, llmModel, saveSession, scheduleRevision, streamFn, virtualJsonnetRuntime]
  );

  const startNewSession = useCallback(() => {
    const id = createSessionId();
    sessionIdRef.current = id;
    titleRef.current = 'New chat';
    virtualJsonnetFilesRef.current = {};
    virtualJsonnetHydratedRef.current = {};
    stickToBottomRef.current = true;
    setCurrentSessionId(id);
    setCurrentTitle('New chat');
    setError(undefined);
    setToolRuns({});
    buildAgent([]);
  }, [buildAgent]);

  const startNewSessionRef = useRef(startNewSession);

  useEffect(() => {
    storageRef.current = storage;
  }, [storage]);

  useEffect(() => {
    startNewSessionRef.current = startNewSession;
  }, [startNewSession]);

  useEffect(() => {
    let mounted = true;

    async function loadIndex() {
      const raw = await storageRef.current.getItem(SESSION_INDEX_KEY);
      const parsed = raw ? (JSON.parse(raw) as SessionIndexItem[]) : [];
      if (!mounted) {
        return;
      }
      sessionsRef.current = parsed;
      setSessions(parsed);
      startNewSessionRef.current();
    }

    loadIndex().catch((err) => {
      if (!mounted) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      startNewSessionRef.current();
    });

    return () => {
      mounted = false;
      unsubscribeRef.current?.();
    };
  }, []);

  useLayoutEffect(() => {
    if (stickToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [revision]);

  const updateStickToBottom = useCallback(() => {
    const element = messagesContainerRef.current;
    if (element) {
      stickToBottomRef.current = isNearBottom(element);
    }
  }, []);

  const submitPrompt = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = input.trim();
    if (!agent || !prompt || agent.state.isStreaming) {
      return;
    }

    let sessionId = sessionIdRef.current;
    if (!sessionId) {
      sessionId = createSessionId();
      sessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);
    }

    if (titleRef.current === 'New chat') {
      const title = generateTitle(prompt);
      titleRef.current = title;
      setCurrentTitle(title);
    }

    setInput('');
    setError(undefined);
    stickToBottomRef.current = true;
    try {
      await agent.prompt(prompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      flushRevision();
    }
  };

  const loadSession = async (id: string) => {
    const raw = await storage.getItem(sessionKey(id));
    if (!raw) {
      setError('Session not found');
      return;
    }

    const stored = JSON.parse(raw) as StoredSession;
    sessionIdRef.current = id;
    titleRef.current = stored.title;
    virtualJsonnetFilesRef.current = stored.virtualJsonnetFiles ?? {};
    virtualJsonnetHydratedRef.current = {};
    stickToBottomRef.current = true;
    setCurrentSessionId(id);
    setCurrentTitle(stored.title);
    setError(undefined);
    setToolRuns({});
    buildAgent(stored.messages);
  };

  const deleteSession = async (id: string) => {
    const next = sessions.filter((session) => session.id !== id);
    await persistIndex(next);
    if (id === currentSessionId) {
      startNewSession();
    }
  };

  const visibleMessages = agent
    ? [
        ...agent.state.messages.map((message) => ({ message, isStreaming: false })),
        ...(agent.state.streamingMessage ? [{ message: agent.state.streamingMessage, isStreaming: true }] : []),
      ]
    : [];
  const activeToolRuns = Object.values(toolRuns)
    .filter((run) => run.status === 'running')
    .sort((left, right) => left.updatedAt - right.updatedAt);
  const hasLLMConfig = Boolean(jsonData.isOpenAIAPIKeySet);

  return (
    <div className={styles.container} data-testid={testIds.chat.container}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div>
            <div className={styles.sidebarTitle}>Sessions</div>
            <div className={styles.sidebarSubtle}>{sessions.length} saved</div>
          </div>
          <Button icon="plus" size="sm" variant="secondary" onClick={startNewSession} aria-label="New session" />
        </div>
        <div className={styles.sessionList}>
          {sessions.map((session) => (
            <button
              className={cx(styles.sessionButton, session.id === currentSessionId && styles.sessionButtonActive)}
              key={session.id}
              onClick={() => loadSession(session.id)}
              type="button"
            >
              <span className={styles.sessionTitle}>{session.title}</span>
              <span className={styles.sessionDate}>{formatDate(session.updatedAt)}</span>
            </button>
          ))}
          {sessions.length === 0 && <div className={styles.sidebarSubtle}>No saved chats yet.</div>}
        </div>
      </aside>

      <main className={styles.main}>
        <div className={styles.toolbar}>
          <div className={styles.titleGroup}>
            <h2 className={styles.title}>{currentTitle}</h2>
            <Badge
              text={agent?.state.isStreaming ? 'Streaming' : 'Ready'}
              color={agent?.state.isStreaming ? 'blue' : 'green'}
            />
          </div>
          <div className={styles.toolbarActions}>
            {currentSessionId && (
              <Button icon="trash-alt" variant="secondary" fill="text" onClick={() => deleteSession(currentSessionId)}>
                Delete
              </Button>
            )}
          </div>
        </div>

        {!hasLLMConfig && (
          <Alert severity="warning" title="LLM API key is not configured">
            Configure the app plugin with an OpenAI-compatible API key before sending prompts.
          </Alert>
        )}
        {error && (
          <Alert severity="error" title="Assistant error" onRemove={() => setError(undefined)}>
            {error}
          </Alert>
        )}

        <section className={styles.messages} ref={messagesContainerRef} onScroll={updateStickToBottom}>
          {visibleMessages.length === 0 ? (
            <EmptyState
              variant="call-to-action"
              message="Ask about metrics, PromQL, or dashboards"
              button={
                <Button onClick={() => setInput('Create a dashboard for HTTP request rate and errors')}>
                  Use example
                </Button>
              }
            />
          ) : (
            visibleMessages.map(({ message, isStreaming }, index) => (
              <MessageView key={messageKey(message, index, isStreaming)} message={message} isStreaming={isStreaming} />
            ))
          )}
          <ToolActivityPanel runs={activeToolRuns} />
          {agent?.state.isStreaming && (
            <div className={styles.streaming} role="status" aria-live="polite">
              <Spinner /> Working
            </div>
          )}
          <div ref={messagesEndRef} />
        </section>

        <form className={styles.composer} onSubmit={submitPrompt}>
          <TextArea
            data-testid={testIds.chat.composer}
            rows={3}
            value={input}
            disabled={!agent || agent.state.isStreaming || !hasLLMConfig}
            placeholder="Ask Pi to inspect metrics, validate PromQL, or create a dashboard..."
            onChange={(event) => setInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                void submitPrompt(event);
              }
            }}
          />
          <div className={styles.composerActions}>
            {agent?.state.isStreaming && (
              <Button icon="pause" type="button" variant="secondary" onClick={() => agent.abort()}>
                Stop
              </Button>
            )}
            <Button
              data-testid={testIds.chat.send}
              icon="message"
              type="submit"
              disabled={!agent || !input.trim() || agent.state.isStreaming || !hasLLMConfig}
            >
              Send
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}

const MessageView = memo(function MessageView({
  message,
  isStreaming,
}: {
  message: AgentMessage;
  isStreaming?: boolean;
}) {
  const styles = useStyles2(getStyles);
  const isUser = message.role === 'user';
  const isTool = message.role === 'toolResult';
  const roleLabel = isTool ? undefined : message.role;

  return (
    <article
      className={cx(
        styles.message,
        isUser && styles.messageUser,
        isTool && styles.messageTool,
        isStreaming && styles.messageStreaming
      )}
    >
      {roleLabel && <div className={styles.messageHeader}>{roleLabel}</div>}
      <div className={styles.messageBody}>{renderMessageContent(message, Boolean(isStreaming))}</div>
    </article>
  );
});

function renderMessageContent(message: AgentMessage, isStreaming: boolean) {
  if (message.role === 'user') {
    return <ContentBlocks content={message.content} markdown={false} />;
  }
  if (message.role === 'assistant') {
    const errorView = formatAssistantError(message.errorMessage, message.stopReason);
    if (errorView) {
      return <AssistantErrorNotice error={errorView} />;
    }

    return <ContentBlocks content={message.content} isStreaming={isStreaming} />;
  }
  if (message.role === 'toolResult') {
    return (
      <ToolResultMessageBody
        toolName={message.toolName}
        content={message.content}
        details={message.details}
        isError={message.isError}
      />
    );
  }

  return <pre>{JSON.stringify(message, null, 2)}</pre>;
}

function messageKey(message: AgentMessage, index: number, isStreaming: boolean) {
  const timestamp =
    typeof (message as { timestamp?: unknown }).timestamp === 'number'
      ? (message as { timestamp: number }).timestamp
      : 'untimed';
  return `${message.role}-${timestamp}-${index}${isStreaming ? '-streaming' : ''}`;
}

function AssistantErrorNotice({ error }: { error: AssistantErrorView }) {
  const styles = useStyles2(getStyles);

  return (
    <Alert severity={error.severity} title={error.title}>
      <div className={styles.assistantError}>
        <div>{error.message}</div>
        {error.details && (
          <details>
            <summary>Technical details</summary>
            <pre>{error.details}</pre>
          </details>
        )}
      </div>
    </Alert>
  );
}

function createSessionId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }

  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function reduceToolRuns(state: ToolRunState, event: AgentEvent): ToolRunState {
  if (event.type === 'tool_execution_start') {
    return {
      ...state,
      [event.toolCallId]: {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: 'running',
        updatedAt: Date.now(),
      },
    };
  }

  if (event.type === 'tool_execution_update') {
    const existing = state[event.toolCallId];
    return {
      ...state,
      [event.toolCallId]: {
        ...existing,
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: 'running',
        partialResult: event.partialResult,
        updatedAt: Date.now(),
      },
    };
  }

  if (event.type === 'tool_execution_end') {
    const existing = state[event.toolCallId];
    return {
      ...state,
      [event.toolCallId]: {
        ...existing,
        id: event.toolCallId,
        name: event.toolName,
        args: existing?.args,
        status: event.isError ? 'failed' : 'completed',
        result: event.result,
        isError: event.isError,
        updatedAt: Date.now(),
      },
    };
  }

  return state;
}

function shouldBatchRevision(event: AgentEvent) {
  return event.type === 'message_update' || event.type === 'tool_execution_update';
}

function emitBenchmarkEvent(event: AgentEvent) {
  if (typeof window === 'undefined' || typeof window.__PI_AGENT_BENCHMARK_RECORD_EVENT__ !== 'function') {
    return;
  }

  try {
    window.__PI_AGENT_BENCHMARK_RECORD_EVENT__(serializeBenchmarkEvent(event));
  } catch {
    // Benchmark instrumentation must not affect chat behavior.
  }
}

function serializeBenchmarkEvent(event: AgentEvent): BenchmarkAgentEvent {
  const timestamp = Date.now();

  if (event.type === 'agent_end') {
    return {
      type: event.type,
      timestamp,
      messageCount: event.messages.length,
    };
  }

  if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
    return {
      type: event.type,
      timestamp,
      message: summarizeBenchmarkMessage(event.message),
    };
  }

  if (event.type === 'turn_end') {
    return {
      type: event.type,
      timestamp,
      message: summarizeBenchmarkMessage(event.message),
      toolResultCount: event.toolResults.length,
    };
  }

  if (event.type === 'tool_execution_start') {
    return {
      type: event.type,
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    };
  }

  if (event.type === 'tool_execution_update') {
    return {
      type: event.type,
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      partialResult: event.partialResult,
    };
  }

  if (event.type === 'tool_execution_end') {
    return {
      type: event.type,
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    };
  }

  return { type: event.type, timestamp };
}

function summarizeBenchmarkMessage(message: AgentMessage) {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const record = message as unknown as Record<string, unknown>;
  return {
    role: record.role,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    content: summarizeBenchmarkContent(record.content),
  };
}

function summarizeBenchmarkContent(content: unknown) {
  if (typeof content === 'string') {
    return truncateBenchmarkText(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  return content.map((block) => {
    if (!block || typeof block !== 'object') {
      return block;
    }

    const record = block as Record<string, unknown>;
    if (record.type === 'text') {
      return { type: record.type, text: truncateBenchmarkText(record.text) };
    }
    if (record.type === 'toolCall') {
      return {
        type: record.type,
        id: record.id,
        name: record.name,
        arguments: record.arguments,
      };
    }

    return { type: record.type };
  });
}

function truncateBenchmarkText(value: unknown) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}

type ScheduledFrame = { kind: 'raf'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

function useFrameRevision() {
  const [revision, setRevision] = useState(0);
  const frameRef = useRef<ScheduledFrame>();

  const bumpRevision = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  const scheduleRevision = useCallback(() => {
    if (frameRef.current) {
      return;
    }
    frameRef.current = scheduleFrame(() => {
      frameRef.current = undefined;
      bumpRevision();
    });
  }, [bumpRevision]);

  const flushRevision = useCallback(() => {
    if (frameRef.current) {
      cancelFrame(frameRef.current);
      frameRef.current = undefined;
    }
    bumpRevision();
  }, [bumpRevision]);

  useEffect(
    () => () => {
      if (frameRef.current) {
        cancelFrame(frameRef.current);
      }
    },
    []
  );

  return { revision, flushRevision, scheduleRevision };
}

function scheduleFrame(callback: () => void): ScheduledFrame {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return { kind: 'raf', id: globalThis.requestAnimationFrame(callback) };
  }
  return { kind: 'timeout', id: setTimeout(callback, 16) };
}

function cancelFrame(frame: ScheduledFrame) {
  if (frame.kind === 'raf') {
    globalThis.cancelAnimationFrame(frame.id);
    return;
  }
  clearTimeout(frame.id);
}

function isNearBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

function generateTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr)',
    minHeight: 'calc(100vh - 190px)',
    border: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.primary,
    '@media (max-width: 900px)': {
      gridTemplateColumns: '1fr',
    },
  }),
  sidebar: css({
    borderRight: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.secondary,
    minHeight: 0,
    padding: theme.spacing(2),
    '@media (max-width: 900px)': {
      borderRight: 0,
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      maxHeight: 220,
    },
  }),
  sidebarHeader: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(2),
  }),
  sidebarTitle: css({
    fontWeight: theme.typography.fontWeightMedium,
  }),
  sidebarSubtle: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  sessionList: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    overflow: 'auto',
  }),
  sessionButton: css({
    display: 'grid',
    gap: theme.spacing(0.5),
    width: '100%',
    minHeight: 54,
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    color: theme.colors.text.primary,
    textAlign: 'left',
    cursor: 'pointer',
    '&:hover': {
      borderColor: theme.colors.border.medium,
    },
  }),
  sessionButtonActive: css({
    borderColor: theme.colors.primary.border,
    boxShadow: `inset 3px 0 0 ${theme.colors.primary.main}`,
  }),
  sessionTitle: css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  sessionDate: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  main: css({
    display: 'grid',
    gridTemplateRows: 'auto auto minmax(320px, 1fr) auto',
    minWidth: 0,
    minHeight: 0,
  }),
  toolbar: css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.spacing(2),
    padding: theme.spacing(2),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    flexWrap: 'wrap',
  }),
  titleGroup: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  title: css({
    margin: 0,
    fontSize: theme.typography.h4.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  toolbarActions: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
  messages: css({
    minHeight: 0,
    overflow: 'auto',
    padding: theme.spacing(2),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1.5),
  }),
  message: css({
    maxWidth: 980,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(1.5),
    background: theme.colors.background.secondary,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    '& pre': {
      margin: `${theme.spacing(1)} 0 0`,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
    },
    '& img': {
      maxWidth: '100%',
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
    },
  }),
  messageUser: css({
    alignSelf: 'flex-end',
    background: theme.colors.primary.transparent,
  }),
  messageTool: css({
    borderStyle: 'dashed',
  }),
  messageStreaming: css({
    borderColor: theme.colors.primary.border,
    boxShadow: `inset 3px 0 0 ${theme.colors.primary.main}`,
  }),
  messageHeader: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginBottom: theme.spacing(0.5),
    textTransform: 'uppercase',
  }),
  messageBody: css({
    lineHeight: 1.5,
  }),
  assistantError: css({
    display: 'grid',
    gap: theme.spacing(1),
    '& summary': {
      cursor: 'pointer',
      fontWeight: theme.typography.fontWeightMedium,
    },
    '& pre': {
      margin: `${theme.spacing(1)} 0 0`,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  streaming: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    color: theme.colors.text.secondary,
  }),
  composer: css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'end',
    gap: theme.spacing(1),
    padding: theme.spacing(2),
    borderTop: `1px solid ${theme.colors.border.weak}`,
    '@media (max-width: 700px)': {
      gridTemplateColumns: '1fr',
    },
  }),
  composerActions: css({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: theme.spacing(1),
  }),
});
