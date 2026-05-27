import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { Agent, type AgentEvent, type AgentMessage, type StreamFn, streamProxy } from '@earendil-works/pi-agent-core';
import { SceneComponentProps, SceneObjectBase, SceneObjectState } from '@grafana/scenes';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Spinner,
  TextArea,
  useStyles2,
} from '@grafana/ui';
import { usePluginUserStorage } from '@grafana/runtime';
import type { GrafanaTheme2 } from '@grafana/data';
import { PLUGIN_ID } from '../../constants';
import { testIds } from '../../components/testIds';
import { usePluginMeta } from '../../utils/utils.plugin';
import { createGrafanaTools } from './grafanaTools';
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
};

type ToolRunState = Record<string, ToolRunView>;

const SESSION_INDEX_KEY = 'sessions:index';
const sessionKey = (id: string) => `sessions:${id}`;

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
  const tools = useMemo(() => createGrafanaTools({ ...jsonData, runtime: { model: llmModel, streamFn } }), [jsonData, llmModel, streamFn]);
  const [agent, setAgent] = useState<Agent>();
  const [revision, setRevision] = useState(0);
  const [input, setInput] = useState('');
  const [sessions, setSessions] = useState<SessionIndexItem[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [currentTitle, setCurrentTitle] = useState('New chat');
  const [error, setError] = useState<string>();
  const [toolRuns, setToolRuns] = useState<ToolRunState>({});
  const unsubscribeRef = useRef<() => void>();
  const sessionIdRef = useRef<string>();
  const titleRef = useRef('New chat');
  const sessionsRef = useRef<SessionIndexItem[]>([]);
  const initializedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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
      if (!messages.some((message) => message.role === 'user') && !messages.some((message) => message.role === 'assistant')) {
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
        setRevision((value) => value + 1);
        setToolRuns((value) => reduceToolRuns(value, event));
        if (event.type === 'agent_end') {
          const sessionId = sessionIdRef.current;
          if (sessionId) {
            void saveSession(sessionId, titleRef.current, nextAgent.state.messages);
          }
        }
      });

      setAgent(nextAgent);
      setRevision((value) => value + 1);
      return nextAgent;
    },
    [llmModel, saveSession, streamFn, tools]
  );

  const startNewSession = useCallback(() => {
    const id = crypto.randomUUID();
    sessionIdRef.current = id;
    titleRef.current = 'New chat';
    setCurrentSessionId(id);
    setCurrentTitle('New chat');
    setError(undefined);
    setToolRuns({});
    buildAgent([]);
  }, [buildAgent]);

  useEffect(() => {
    if (initializedRef.current) {
      return undefined;
    }
    initializedRef.current = true;
    let mounted = true;

    async function loadIndex() {
      const raw = await storage.getItem(SESSION_INDEX_KEY);
      const parsed = raw ? (JSON.parse(raw) as SessionIndexItem[]) : [];
      if (!mounted) {
        return;
      }
      sessionsRef.current = parsed;
      setSessions(parsed);
      startNewSession();
    }

    loadIndex().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      startNewSession();
    });

    return () => {
      mounted = false;
      unsubscribeRef.current?.();
    };
  }, [startNewSession, storage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [revision]);

  const submitPrompt = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = input.trim();
    if (!agent || !prompt || agent.state.isStreaming) {
      return;
    }

    let sessionId = sessionIdRef.current;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
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
    try {
      await agent.prompt(prompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    ? [...agent.state.messages, ...(agent.state.streamingMessage ? [agent.state.streamingMessage] : [])]
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
            <Badge text={agent?.state.isStreaming ? 'Streaming' : 'Ready'} color={agent?.state.isStreaming ? 'blue' : 'green'} />
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

        <section className={styles.messages} aria-live="polite">
          {visibleMessages.length === 0 ? (
            <EmptyState
              variant="call-to-action"
              message="Ask about metrics, PromQL, or dashboards"
              button={<Button onClick={() => setInput('Create a dashboard for HTTP request rate and errors')}>Use example</Button>}
            />
          ) : (
            visibleMessages.map((message, index) => <MessageView key={`${message.role}-${index}`} message={message} />)
          )}
          <ToolActivityPanel runs={activeToolRuns} />
          {agent?.state.isStreaming && (
            <div className={styles.streaming}>
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
          <Button
            data-testid={testIds.chat.send}
            icon={agent?.state.isStreaming ? 'pause' : 'message'}
            type="submit"
            disabled={!agent || !input.trim() || agent.state.isStreaming || !hasLLMConfig}
          >
            Send
          </Button>
        </form>
      </main>
    </div>
  );
}

function MessageView({ message }: { message: AgentMessage }) {
  const styles = useStyles2(getStyles);
  const roleLabel = message.role === 'toolResult' ? `tool: ${message.toolName}` : message.role;
  const isUser = message.role === 'user';
  const isTool = message.role === 'toolResult';

  return (
    <article className={cx(styles.message, isUser && styles.messageUser, isTool && styles.messageTool)}>
      <div className={styles.messageHeader}>{roleLabel}</div>
      <div className={styles.messageBody}>{renderMessageContent(message)}</div>
    </article>
  );
}

function renderMessageContent(message: AgentMessage) {
  if (message.role === 'user') {
    return <ContentBlocks content={message.content} />;
  }
  if (message.role === 'assistant') {
    return <ContentBlocks content={message.content} />;
  }
  if (message.role === 'toolResult') {
    return <ToolResultMessageBody toolName={message.toolName} content={message.content} details={message.details} isError={message.isError} />;
  }

  return <pre>{JSON.stringify(message, null, 2)}</pre>;
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
  messageHeader: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginBottom: theme.spacing(0.5),
    textTransform: 'uppercase',
  }),
  messageBody: css({
    lineHeight: 1.5,
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
});
