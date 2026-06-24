import React, { FormEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type BeforeToolCallResult,
  type StreamFn,
  streamProxy,
} from '@earendil-works/pi-agent-core';
import { SceneComponentProps, SceneObjectBase, SceneObjectState } from '@grafana/scenes';
import { Alert, Badge, Button, EmptyState, Icon, Modal, Spinner, TextArea, useStyles2 } from '@grafana/ui';
import { usePluginUserStorage } from '@grafana/runtime';
import type { GrafanaTheme2 } from '@grafana/data';
import { PLUGIN_ID } from '../../constants';
import { testIds } from '../../components/testIds';
import { usePluginMeta } from '../../utils/utils.plugin';
import {
  createGrafanaSupervisorTools,
  createGrafanaToolsForSkillGroups,
  createSkillTools,
  artifactByteSize,
  artifactizeToolResult,
  normalizeJsonnetPath,
  type Artifact,
  type ArtifactRuntime,
  type GrafanaToolRuntime,
  type InvestigationReport,
  type VirtualJsonnetFileSnapshot,
} from './grafanaTools';
import { formatAssistantError, type AssistantErrorView } from './llmErrors';
import { createOpenAICompatibleModel, getConfiguredThinkingLevel, type PiAppJsonData } from './model';
import { convertChatMessagesToLlm, hasPersistableMessages } from './chatMessages';
import { getGrafanaSkills, renderGrafanaSystemPrompt, selectGrafanaSkills } from './skills';
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
  investigationReport?: InvestigationReport;
  artifacts?: Record<string, Artifact>;
  artifactCounter?: number;
};

type ToolRunState = Record<string, ToolRunView>;

type ToolConfirmationView = {
  id: string;
  toolName: string;
  title: string;
  description: string;
  fields: Array<{ label: string; value: string }>;
  args: unknown;
};

const SESSION_INDEX_KEY = 'sessions:index';
const CHAT_SESSION_EXPORT_KIND = 'g42-pi-app.chat-session';
const LEGACY_CHAT_SESSION_EXPORT_KINDS = ['grafana-pi-app.chat-session'];
const CHAT_SESSION_EXPORT_SCHEMA_VERSION = 1;
const PERSISTENT_WRITE_TOOLS = new Set(['sync_dashboard', 'upload_dashboard', 'delete_dashboard']);
const sessionKey = (id: string) => `sessions:${id}`;

type ChatSessionExport = {
  kind: typeof CHAT_SESSION_EXPORT_KIND;
  schemaVersion: typeof CHAT_SESSION_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  pluginId: string;
  session: StoredSession;
};

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
  const thinkingLevel = useMemo(() => getConfiguredThinkingLevel(jsonData), [jsonData]);
  const skills = useMemo(() => getGrafanaSkills(jsonData), [jsonData]);
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
  const investigationReportRef = useRef<InvestigationReport>();
  const artifactsRef = useRef<Record<string, Artifact>>({});
  const artifactCounterRef = useRef(0);
  const [investigationReport, setInvestigationReport] = useState<InvestigationReport>();
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
  const setInvestigationReportSnapshot = useCallback((report: InvestigationReport) => {
    investigationReportRef.current = report;
    setInvestigationReport(report);
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
  const investigationReportRuntime = useMemo(
    () => ({
      getReport: () => investigationReportRef.current,
      setReport: setInvestigationReportSnapshot,
    }),
    [setInvestigationReportSnapshot]
  );
  const setArtifactSnapshots = useCallback((artifacts: Record<string, Artifact>, counter?: number) => {
    const compacted = compactArtifacts(artifacts);
    artifactsRef.current = compacted;
    artifactCounterRef.current = counter ?? nextArtifactCounter(compacted);
  }, []);
  const clearArtifacts = useCallback(() => {
    artifactsRef.current = {};
    artifactCounterRef.current = 0;
  }, []);
  const artifactRuntime = useMemo<ArtifactRuntime>(
    () => ({
      register: (input) => {
        const id = createArtifactId(artifactCounterRef.current + 1);
        artifactCounterRef.current += 1;
        const artifact: Artifact = {
          id,
          kind: input.kind,
          title: input.title,
          toolName: input.toolName,
          createdAt: new Date().toISOString(),
          bytes: input.bytes ?? artifactByteSize(input.data),
          summary: input.summary,
          data: input.data,
          preview: input.preview,
          mimeType: input.mimeType,
          toolDetails: input.toolDetails,
        };
        artifactsRef.current = compactArtifacts({
          ...artifactsRef.current,
          [id]: artifact,
        });
        return artifact;
      },
      get: (id) => artifactsRef.current[id],
      list: () => Object.values(artifactsRef.current).sort(compareArtifactsByCreatedAt),
    }),
    []
  );
  const afterToolCall = useCallback(
    async (context: AfterToolCallContext, signal?: AbortSignal): Promise<AfterToolCallResult | undefined> => {
      if (signal?.aborted || context.isError) {
        return undefined;
      }
      return artifactizeToolResult(artifactRuntime, context.toolCall.name, context.result);
    },
    [artifactRuntime]
  );
  const [agent, setAgent] = useState<Agent>();
  const agentRef = useRef<Agent>();
  const { revision, flushRevision, scheduleRevision } = useFrameRevision();
  const [input, setInput] = useState('');
  const [pendingToolConfirmation, setPendingToolConfirmation] = useState<ToolConfirmationView>();
  const [sessions, setSessions] = useState<SessionIndexItem[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [currentTitle, setCurrentTitle] = useState('New chat');
  const [error, setError] = useState<string>();
  const [toolRuns, setToolRuns] = useState<ToolRunState>({});
  const unsubscribeRef = useRef<() => void>();
  const titleRef = useRef('New chat');
  const sessionsRef = useRef<SessionIndexItem[]>([]);
  const storageRef = useRef(storage);
  const importSessionInputRef = useRef<HTMLInputElement | null>(null);
  const messagesContainerRef = useRef<HTMLElement | null>(null);
  const autoScrollRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number>();
  const toolConfirmationResolverRef = useRef<(approved: boolean) => void>();
  const [isAutoScrollPaused, setIsAutoScrollPaused] = useState(false);

  const settleToolConfirmation = useCallback((approved: boolean) => {
    const resolve = toolConfirmationResolverRef.current;
    toolConfirmationResolverRef.current = undefined;
    setPendingToolConfirmation(undefined);
    resolve?.(approved);
  }, []);

  const requestToolConfirmation = useCallback(
    (toolName: string, args: unknown, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
      const confirmation = buildToolConfirmation(toolName, args);
      if (!confirmation) {
        return Promise.resolve(undefined);
      }

      if (toolConfirmationResolverRef.current) {
        return Promise.resolve({
          block: true,
          reason: `Persistent Grafana write tool ${toolName} was blocked because another approval is pending.`,
        });
      }

      return new Promise((resolve) => {
        let settled = false;
        const finish = (approved: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          signal?.removeEventListener('abort', handleAbort);
          toolConfirmationResolverRef.current = undefined;
          setPendingToolConfirmation(undefined);
          resolve(
            approved
              ? undefined
              : {
                  block: true,
                  reason: `User denied persistent Grafana write tool ${toolName}.`,
                }
          );
        };
        const handleAbort = () => finish(false);

        toolConfirmationResolverRef.current = finish;
        setPendingToolConfirmation(confirmation);

        if (signal?.aborted) {
          finish(false);
        } else {
          signal?.addEventListener('abort', handleAbort, { once: true });
        }
      });
    },
    []
  );

  const buildSkillRuntime = useCallback(
    (prompt: string) => {
      const selection = selectGrafanaSkills(prompt, skills);
      const skillTools = createSkillTools(selection.activeSkills);
      const beforeToolCall: NonNullable<GrafanaToolRuntime['beforeToolCall']> = async ({ toolCall, args }, signal) =>
        requestToolConfirmation(toolCall.name, args, signal);
      const toolOptions = {
        ...jsonData,
        runtime: {
          model: llmModel,
          streamFn,
          thinkingLevel,
          beforeToolCall,
          afterToolCall,
        },
        virtualJsonnetFiles: virtualJsonnetRuntime,
        investigationReport: investigationReportRuntime,
        artifacts: artifactRuntime,
        skillTools,
      };
      const tools =
        prompt.trim() === ''
          ? createGrafanaSupervisorTools(toolOptions)
          : createGrafanaToolsForSkillGroups(toolOptions, selection.toolGroups);

      return {
        systemPrompt: renderGrafanaSystemPrompt({
          skills,
          activeSkillNames: selection.activeSkillNames,
        }),
        tools,
      };
    },
    [
      investigationReportRuntime,
      afterToolCall,
      artifactRuntime,
      jsonData,
      llmModel,
      requestToolConfirmation,
      skills,
      streamFn,
      thinkingLevel,
      virtualJsonnetRuntime,
    ]
  );

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
      if (!hasPersistableMessages(messages)) {
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
        modelId: llmModel.id,
        virtualJsonnetFiles: virtualJsonnetFilesRef.current,
        investigationReport: investigationReportRef.current,
        artifacts: artifactsRef.current,
        artifactCounter: artifactCounterRef.current,
      };
      const next = [indexItem, ...sessionsRef.current.filter((session) => session.id !== id)].slice(0, 50);

      await storage.setItem(sessionKey(id), JSON.stringify(stored));
      await persistIndex(next);
    },
    [llmModel.id, persistIndex, storage]
  );

  const buildAgent = useCallback(
    (messages: AgentMessage[] = []) => {
      unsubscribeRef.current?.();
      const runtime = buildSkillRuntime('');
      const nextAgent = new Agent({
        initialState: {
          systemPrompt: runtime.systemPrompt,
          model: llmModel,
          thinkingLevel,
          messages,
          tools: runtime.tools,
        },
        convertToLlm: convertChatMessagesToLlm,
        streamFn,
        afterToolCall,
        beforeToolCall: async ({ toolCall, args }, signal) => requestToolConfirmation(toolCall.name, args, signal),
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
      agentRef.current = nextAgent;
      flushRevision();
      return nextAgent;
    },
    [
      buildSkillRuntime,
      afterToolCall,
      flushRevision,
      llmModel,
      requestToolConfirmation,
      saveSession,
      scheduleRevision,
      streamFn,
      thinkingLevel,
    ]
  );

  const startNewSession = useCallback(() => {
    const id = createSessionId();
    sessionIdRef.current = id;
    titleRef.current = 'New chat';
    virtualJsonnetFilesRef.current = {};
    virtualJsonnetHydratedRef.current = {};
    investigationReportRef.current = undefined;
    clearArtifacts();
    autoScrollRef.current = true;
    setIsAutoScrollPaused(false);
    setCurrentSessionId(id);
    setCurrentTitle('New chat');
    setError(undefined);
    setToolRuns({});
    setInvestigationReport(undefined);
    settleToolConfirmation(false);
    buildAgent([]);
  }, [buildAgent, clearArtifacts, settleToolConfirmation]);

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
      toolConfirmationResolverRef.current?.(false);
      toolConfirmationResolverRef.current = undefined;
      unsubscribeRef.current?.();
    };
  }, []);

  const setAutoScrollEnabled = useCallback((enabled: boolean) => {
    autoScrollRef.current = enabled;
    setIsAutoScrollPaused((paused) => {
      const nextPaused = !enabled;
      return paused === nextPaused ? paused : nextPaused;
    });
  }, []);

  const pauseAutoScroll = useCallback(() => {
    setAutoScrollEnabled(false);
  }, [setAutoScrollEnabled]);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const element = messagesContainerRef.current;
    if (!element) {
      return;
    }

    const top = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTo({ top, behavior });
    if (behavior !== 'smooth') {
      lastScrollTopRef.current = top;
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    setAutoScrollEnabled(true);
    scrollMessagesToBottom('smooth');
  }, [scrollMessagesToBottom, setAutoScrollEnabled]);

  const updateAutoScrollFromPosition = useCallback(() => {
    const element = messagesContainerRef.current;
    if (!element) {
      return;
    }

    const nextScrollTop = element.scrollTop;
    if (isNearBottom(element)) {
      setAutoScrollEnabled(true);
    } else if (nextScrollTop < lastScrollTopRef.current - 1) {
      setAutoScrollEnabled(false);
    }
    lastScrollTopRef.current = nextScrollTop;
  }, [setAutoScrollEnabled]);

  const handleMessagesWheel = useCallback(
    (event: React.WheelEvent<HTMLElement>) => {
      if (event.deltaY < 0) {
        pauseAutoScroll();
      }
    },
    [pauseAutoScroll]
  );

  const handleMessagesTouchStart = useCallback((event: React.TouchEvent<HTMLElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY;
  }, []);

  const handleMessagesTouchMove = useCallback(
    (event: React.TouchEvent<HTMLElement>) => {
      const touchY = event.touches[0]?.clientY;
      if (touchY !== undefined && touchStartYRef.current !== undefined && touchY > touchStartYRef.current + 4) {
        pauseAutoScroll();
      }
    },
    [pauseAutoScroll]
  );

  const handleMessagesKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Home' || event.key === 'PageUp' || event.key === 'ArrowUp') {
        pauseAutoScroll();
        return;
      }
      if (event.key === 'End') {
        setAutoScrollEnabled(true);
      }
    },
    [pauseAutoScroll, setAutoScrollEnabled]
  );

  const abortAgent = useCallback(() => {
    agent?.abort();
  }, [agent]);

  const isStreaming = Boolean(agent?.state.isStreaming);
  const isBusy = isStreaming;

  const keepAutoScrollEnabled = useCallback(() => {
    setAutoScrollEnabled(true);
  }, [setAutoScrollEnabled]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
  }, []);

  useLayoutEffect(() => {
    if (autoScrollRef.current) {
      scrollMessagesToBottom();
    }
  }, [revision, scrollMessagesToBottom]);

  const submitPrompt = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = input.trim();
    const currentAgent = agentRef.current;
    if (!currentAgent || !prompt || currentAgent.state.isStreaming) {
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
    keepAutoScrollEnabled();
    try {
      const runtime = buildSkillRuntime(prompt);
      currentAgent.state.systemPrompt = runtime.systemPrompt;
      currentAgent.state.tools = runtime.tools;
      await currentAgent.prompt(prompt);
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
    investigationReportRef.current = stored.investigationReport;
    setArtifactSnapshots(stored.artifacts ?? {}, stored.artifactCounter);
    keepAutoScrollEnabled();
    setCurrentSessionId(id);
    setCurrentTitle(stored.title);
    setError(undefined);
    setToolRuns({});
    setInvestigationReport(stored.investigationReport);
    settleToolConfirmation(false);
    buildAgent(stored.messages);
  };

  const deleteSession = async (id: string) => {
    const next = sessions.filter((session) => session.id !== id);
    await persistIndex(next);
    if (id === currentSessionId) {
      startNewSession();
    }
  };

  const handleExportDownloadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();

      const currentAgent = agentRef.current;
      const sessionId = sessionIdRef.current;
      if (!currentAgent || !sessionId || currentAgent.state.isStreaming) {
        return;
      }

      const messages = currentAgent.state.messages;
      if (!hasPersistableMessages(messages)) {
        setError('There are no chat messages to export.');
        return;
      }

      const exportedAt = new Date().toISOString();
      const indexItem = sessionsRef.current.find((session) => session.id === sessionId);
      const title = titleRef.current || indexItem?.title || 'New chat';
      const payload: ChatSessionExport = {
        kind: CHAT_SESSION_EXPORT_KIND,
        schemaVersion: CHAT_SESSION_EXPORT_SCHEMA_VERSION,
        exportedAt,
        pluginId: PLUGIN_ID,
        session: {
          id: sessionId,
          title,
          createdAt: indexItem?.createdAt ?? exportedAt,
          updatedAt: exportedAt,
          modelId: llmModel.id,
          messages,
          virtualJsonnetFiles: virtualJsonnetFilesRef.current,
          investigationReport: investigationReportRef.current,
          artifacts: artifactsRef.current,
          artifactCounter: artifactCounterRef.current,
        },
      };

      try {
        downloadJsonFile(payload, chatSessionExportFilename(title));
        setError(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [llmModel.id]
  );

  const openImportSessionPicker = useCallback(() => {
    if (agentRef.current?.state.isStreaming) {
      return;
    }

    importSessionInputRef.current?.click();
  }, []);

  const importSessionFromFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = '';
      if (!file) {
        return;
      }

      if (agentRef.current?.state.isStreaming) {
        setError('Cannot import a session while the assistant is streaming.');
        return;
      }

      try {
        const imported = parseChatSessionExport(JSON.parse(await file.text()));
        const id = createSessionId();
        const title = imported.title || importTitleFromFilename(file.name) || 'Imported chat';

        sessionIdRef.current = id;
        titleRef.current = title;
        virtualJsonnetFilesRef.current = imported.virtualJsonnetFiles ?? {};
        virtualJsonnetHydratedRef.current = {};
        investigationReportRef.current = imported.investigationReport;
        setArtifactSnapshots(imported.artifacts ?? {}, imported.artifactCounter);
        keepAutoScrollEnabled();
        setCurrentSessionId(id);
        setCurrentTitle(title);
        setError(undefined);
        setToolRuns({});
        setInvestigationReport(imported.investigationReport);
        settleToolConfirmation(false);
        buildAgent(imported.messages);
        await saveSession(id, title, imported.messages);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Could not import chat session: ${message}`);
      }
    },
    [buildAgent, keepAutoScrollEnabled, saveSession, setArtifactSnapshots, settleToolConfirmation]
  );

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
  const hasCurrentMessages = hasPersistableMessages(agent?.state.messages ?? []);

  return (
    <div className={styles.container} data-testid={testIds.chat.container}>
      <ToolConfirmationModal
        confirmation={pendingToolConfirmation}
        onApprove={() => settleToolConfirmation(true)}
        onDeny={() => settleToolConfirmation(false)}
      />
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div>
            <div className={styles.sidebarTitle}>Sessions</div>
            <div className={styles.sidebarSubtle}>{sessions.length} saved</div>
          </div>
          <div className={styles.sidebarActions}>
            <input
              accept="application/json,.json"
              data-testid={testIds.chat.importInput}
              disabled={isBusy}
              hidden
              ref={importSessionInputRef}
              type="file"
              onChange={importSessionFromFile}
            />
            <Button
              aria-label="Import session"
              data-testid={testIds.chat.import}
              disabled={isBusy}
              icon="import"
              size="sm"
              title="Import session"
              type="button"
              variant="secondary"
              onClick={openImportSessionPicker}
            />
            <Button icon="plus" size="sm" variant="secondary" onClick={startNewSession} aria-label="New session" />
          </div>
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
            <Badge text={isStreaming ? 'Streaming' : 'Ready'} color={isStreaming ? 'blue' : 'green'} />
          </div>
          <div className={styles.toolbarActions}>
            {isStreaming && (
              <Button
                aria-label="Abort response"
                data-testid={testIds.chat.stop}
                icon="pause"
                type="button"
                variant="secondary"
                onClick={abortAgent}
              >
                Stop
              </Button>
            )}
            {currentSessionId && (
              <>
                <Button
                  data-testid={testIds.chat.export}
                  disabled={isBusy || !hasCurrentMessages}
                  fill="text"
                  icon="file-download"
                  type="button"
                  variant="secondary"
                  onClick={handleExportDownloadClick}
                >
                  Export
                </Button>
                <Button
                  icon="trash-alt"
                  variant="secondary"
                  fill="text"
                  disabled={isBusy || !hasCurrentMessages}
                  onClick={() => deleteSession(currentSessionId)}
                >
                  Delete
                </Button>
              </>
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

        <div className={cx(styles.messagesFrame, investigationReport && styles.messagesFrameWithReport)}>
          <section
            aria-label="Chat messages"
            className={styles.messages}
            data-testid={testIds.chat.messages}
            ref={messagesContainerRef}
            tabIndex={0}
            onKeyDown={handleMessagesKeyDown}
            onScroll={updateAutoScrollFromPosition}
            onTouchMove={handleMessagesTouchMove}
            onTouchStart={handleMessagesTouchStart}
            onWheel={handleMessagesWheel}
          >
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
                <MessageView
                  key={messageKey(message, index, isStreaming)}
                  message={message}
                  isStreaming={isStreaming}
                />
              ))
            )}
            <ToolActivityPanel runs={activeToolRuns} />
            {isStreaming && (
              <div className={styles.streaming} role="status" aria-live="polite">
                <Spinner /> Working
              </div>
            )}
          </section>
          {investigationReport && <InvestigationReportPanel report={investigationReport} />}
          {isAutoScrollPaused && visibleMessages.length > 0 && (
            <Button
              className={styles.jumpToLatest}
              data-testid={testIds.chat.jumpToLatest}
              icon="angle-down"
              size="sm"
              type="button"
              variant="secondary"
              onClick={jumpToLatest}
            >
              Jump to latest
            </Button>
          )}
        </div>

        <form className={styles.composer} onSubmit={submitPrompt}>
          <div className={styles.composerInputGroup}>
            <TextArea
              data-testid={testIds.chat.composer}
              rows={3}
              value={input}
              disabled={!agent || isBusy || !hasLLMConfig}
              placeholder="Ask about metrics, PromQL, or dashboards..."
              onChange={(event) => handleInputChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  void submitPrompt(event);
                }
              }}
            />
          </div>
          <div className={styles.composerActions}>
            {isStreaming && (
              <Button icon="pause" type="button" variant="secondary" onClick={abortAgent}>
                Stop
              </Button>
            )}
            <Button
              data-testid={testIds.chat.send}
              icon="message"
              type="submit"
              disabled={!agent || !input.trim() || isBusy || !hasLLMConfig}
            >
              Send
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}

function ToolConfirmationModal({
  confirmation,
  onApprove,
  onDeny,
}: {
  confirmation?: ToolConfirmationView;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const styles = useStyles2(getStyles);
  const args = useMemo(() => formatConfirmationArgs(confirmation?.args), [confirmation?.args]);

  return (
    <Modal
      title={confirmation?.title ?? 'Approve Grafana write'}
      isOpen={Boolean(confirmation)}
      closeOnEscape
      onDismiss={onDeny}
      className={styles.toolConfirmationModal}
      contentClassName={styles.toolConfirmationModalContent}
    >
      {confirmation && (
        <div className={styles.toolConfirmation} data-testid={testIds.chat.toolConfirmation}>
          <Alert severity="warning" title="Persistent Grafana write">
            {confirmation.description}
          </Alert>
          <dl className={styles.toolConfirmationFields}>
            <div className={styles.toolConfirmationField}>
              <dt>Tool</dt>
              <dd>{confirmation.toolName}</dd>
            </div>
            {confirmation.fields.map((field) => (
              <div className={styles.toolConfirmationField} key={`${field.label}:${field.value}`}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
          <details className={styles.toolConfirmationDetails}>
            <summary>Tool arguments</summary>
            <pre>{args}</pre>
          </details>
          <div className={styles.toolConfirmationActions}>
            <Button
              data-testid={testIds.chat.toolConfirmationDeny}
              icon="times"
              type="button"
              variant="secondary"
              onClick={onDeny}
            >
              Deny
            </Button>
            <Button
              data-testid={testIds.chat.toolConfirmationApprove}
              icon="check"
              type="button"
              variant="primary"
              onClick={onApprove}
            >
              Approve
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

type InvestigationReportArraySection = 'scope' | 'evidence' | 'hypotheses' | 'ruledOut' | 'nextSteps' | 'remediation';

const INVESTIGATION_REPORT_SECTIONS: Array<{ key: InvestigationReportArraySection; title: string }> = [
  { key: 'scope', title: 'Scope' },
  { key: 'evidence', title: 'Evidence' },
  { key: 'hypotheses', title: 'Hypotheses' },
  { key: 'ruledOut', title: 'Ruled out' },
  { key: 'nextSteps', title: 'Next checks' },
  { key: 'remediation', title: 'Remediation' },
];

function InvestigationReportPanel({ report }: { report: InvestigationReport }) {
  const styles = useStyles2(getStyles);

  return (
    <aside className={styles.investigationReport} data-testid={testIds.chat.investigationReport}>
      <div className={styles.investigationReportHeader}>
        <div className={styles.investigationReportTitleGroup}>
          <Icon name="search" />
          <h3>{report.title}</h3>
        </div>
        <Badge
          text={report.status === 'complete' ? 'Complete' : 'Active'}
          color={report.status === 'complete' ? 'green' : 'blue'}
        />
      </div>
      <div className={styles.investigationReportUpdated}>Updated {formatDate(report.updatedAt)}</div>
      <div className={styles.investigationReportSections}>
        {INVESTIGATION_REPORT_SECTIONS.map((section) => {
          const items = report[section.key];
          return (
            <section className={styles.investigationReportSection} key={section.key}>
              <h4>{section.title}</h4>
              {Array.isArray(items) && items.length > 0 ? (
                <ul>
                  {items.map((item, index) => (
                    <li key={`${section.key}:${index}:${item}`}>{item}</li>
                  ))}
                </ul>
              ) : (
                <div className={styles.investigationReportEmpty}>No entries yet.</div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
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

function buildToolConfirmation(toolName: string, args: unknown): ToolConfirmationView | undefined {
  if (!PERSISTENT_WRITE_TOOLS.has(toolName)) {
    return undefined;
  }

  const record = isRecord(args) ? args : {};
  const id = `confirm-${toolName}-${Date.now()}`;

  if (toolName === 'sync_dashboard') {
    return {
      id,
      toolName,
      title: 'Approve dashboard sync',
      description:
        'The assistant wants to create or update a Grafana dashboard from managed Jsonnet source. Approve only if this is the dashboard change you requested.',
      fields: compactConfirmationFields([
        confirmationField('UID', stringValue(record.uid) ?? 'compiled dashboard UID'),
        confirmationField('Folder UID', stringValue(record.folderUid)),
        confirmationField('Overwrite', booleanValue(record.overwrite, true)),
        confirmationField('Source path', stringValue(record.path) ?? 'dashboard.jsonnet'),
        confirmationField('Tags', stringArrayValue(record.tags)),
      ]),
      args,
    };
  }

  if (toolName === 'upload_dashboard') {
    const dashboard = parseConfirmationDashboard(record.dashboard_json);
    return {
      id,
      toolName,
      title: 'Approve dashboard upload',
      description: 'The assistant wants to create or update a raw Grafana dashboard JSON model as the current user.',
      fields: compactConfirmationFields([
        confirmationField('Title', dashboard.title),
        confirmationField('UID', dashboard.uid),
        confirmationField('Folder UID', stringValue(record.folderUid)),
        confirmationField('Overwrite', booleanValue(record.overwrite, true)),
      ]),
      args,
    };
  }

  return {
    id,
    toolName,
    title: 'Approve dashboard deletion',
    description: 'The assistant wants to delete a Grafana dashboard. This removes the dashboard by UID.',
    fields: compactConfirmationFields([confirmationField('UID', stringValue(record.uid))]),
    args,
  };
}

function confirmationField(label: string, value: unknown) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return { label, value: String(value) };
}

function compactConfirmationFields(fields: Array<{ label: string; value: string } | undefined>) {
  return fields.filter((field): field is { label: string; value: string } => Boolean(field));
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(', ') : undefined;
}

function parseConfirmationDashboard(value: unknown) {
  try {
    const dashboard = typeof value === 'string' ? JSON.parse(value) : value;
    if (!isRecord(dashboard)) {
      return {};
    }
    return {
      title: stringValue(dashboard.title),
      uid: stringValue(dashboard.uid),
    };
  } catch {
    return {};
  }
}

function formatConfirmationArgs(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

const MAX_SESSION_ARTIFACTS = 40;
const MAX_SESSION_ARTIFACT_BYTES = 8 * 1024 * 1024;

function createArtifactId(index: number) {
  return `artifact_${Math.max(1, Math.floor(index))}`;
}

function nextArtifactCounter(artifacts: Record<string, Artifact>) {
  return Object.keys(artifacts).reduce((max, id) => {
    const match = /^artifact_(\d+)$/.exec(id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

function compactArtifacts(artifacts: Record<string, Artifact>) {
  const sorted = Object.values(artifacts).sort(compareArtifactsByCreatedAt);
  const kept: Record<string, Artifact> = {};
  let totalBytes = 0;

  for (const artifact of sorted) {
    if (Object.keys(kept).length >= MAX_SESSION_ARTIFACTS) {
      break;
    }
    const artifactBytes = Math.max(0, artifact.bytes || artifactByteSize(artifact.data));
    if (totalBytes > 0 && totalBytes + artifactBytes > MAX_SESSION_ARTIFACT_BYTES) {
      continue;
    }
    kept[artifact.id] = {
      ...artifact,
      bytes: artifactBytes,
    };
    totalBytes += artifactBytes;
  }

  return kept;
}

function compareArtifactsByCreatedAt(left: Artifact, right: Artifact) {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
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

function createJsonDownload(data: ChatSessionExport, filename: string) {
  const serialized = JSON.stringify(data, null, 2);
  if (!serialized) {
    throw new Error('Could not serialize chat session export.');
  }

  const blob = new Blob([`${serialized}\n`], { type: 'application/octet-stream;charset=utf-8' });
  return {
    filename,
    url: URL.createObjectURL(blob),
  };
}

function downloadJsonFile(data: ChatSessionExport, filename: string) {
  const download = createJsonDownload(data, filename);
  const anchor = document.createElement('a');
  anchor.href = download.url;
  anchor.download = download.filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  anchor.addEventListener('click', stopDownloadClickPropagation, { capture: true });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(download.url), 60000);
}

function stopDownloadClickPropagation(event: MouseEvent) {
  event.stopPropagation();
}

function chatSessionExportFilename(title: string) {
  const safeTitle = safeFilenamePart(title) || 'observability-analyst-chat-session';
  return `${safeTitle}.json`;
}

function safeFilenamePart(value: string) {
  return value
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .toLowerCase();
}

function importTitleFromFilename(filename: string) {
  const withoutExtension = filename.replace(/\.json$/i, '').replace(/[-_]+/g, ' ');
  return normalizeSessionTitle(withoutExtension);
}

function parseChatSessionExport(value: unknown): StoredSession {
  if (!isRecord(value)) {
    throw new Error('Import file must contain a JSON object.');
  }
  if (value.kind !== CHAT_SESSION_EXPORT_KIND && !LEGACY_CHAT_SESSION_EXPORT_KINDS.includes(String(value.kind))) {
    throw new Error('Import file is not an Observability Analyst chat session export.');
  }
  if (value.schemaVersion !== CHAT_SESSION_EXPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported chat session export version: ${String(value.schemaVersion)}`);
  }
  if (!isRecord(value.session)) {
    throw new Error('Import file is missing a session object.');
  }

  const rawMessages = value.session.messages;
  if (!Array.isArray(rawMessages) || !rawMessages.every(isAgentMessageLike)) {
    throw new Error('Import file session.messages must be an array of chat messages.');
  }

  const messages = rawMessages as AgentMessage[];
  if (!hasPersistableMessages(messages)) {
    throw new Error('Import file does not contain any user or assistant messages.');
  }

  return {
    id: typeof value.session.id === 'string' ? value.session.id : '',
    title: normalizeSessionTitle(value.session.title),
    createdAt: normalizeDateString(value.session.createdAt),
    updatedAt: normalizeDateString(value.session.updatedAt),
    modelId: typeof value.session.modelId === 'string' ? value.session.modelId : undefined,
    messages,
    virtualJsonnetFiles: parseVirtualJsonnetFiles(value.session.virtualJsonnetFiles),
    investigationReport: parseInvestigationReport(value.session.investigationReport),
    artifacts: parseArtifacts(value.session.artifacts),
    artifactCounter:
      typeof value.session.artifactCounter === 'number' && Number.isFinite(value.session.artifactCounter)
        ? Math.max(0, Math.floor(value.session.artifactCounter))
        : undefined,
  };
}

function parseInvestigationReport(value: unknown): InvestigationReport | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Import file session.investigationReport must be an object when present.');
  }

  return {
    id: typeof value.id === 'string' && value.id ? value.id : createSessionId(),
    title: typeof value.title === 'string' && value.title.trim() ? generateTitle(value.title) : 'Investigation report',
    status: value.status === 'complete' ? 'complete' : 'active',
    scope: parseStringList(value.scope),
    evidence: parseStringList(value.evidence),
    hypotheses: parseStringList(value.hypotheses),
    ruledOut: parseStringList(value.ruledOut),
    nextSteps: parseStringList(value.nextSteps),
    remediation: parseStringList(value.remediation),
    updatedAt: normalizeDateString(value.updatedAt),
  };
}

function parseStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseVirtualJsonnetFiles(value: unknown): Record<string, VirtualJsonnetFileSnapshot> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Import file session.virtualJsonnetFiles must be an object when present.');
  }

  const files: Record<string, VirtualJsonnetFileSnapshot> = {};
  for (const [key, file] of Object.entries(value)) {
    if (!isRecord(file)) {
      throw new Error(`Imported Jsonnet file ${key} must be an object.`);
    }

    const content = file.content;
    const version = file.version;
    if (typeof content !== 'string' || typeof version !== 'number') {
      throw new Error(`Imported Jsonnet file ${key} must include string content and numeric version.`);
    }

    const path = normalizeJsonnetPath(typeof file.path === 'string' ? file.path : key);
    files[path] = {
      path,
      content,
      version,
      checksum: typeof file.checksum === 'string' ? file.checksum : '',
      lineCount: typeof file.lineCount === 'number' ? file.lineCount : countLines(content),
      dashboardJsonnetSize: typeof file.dashboardJsonnetSize === 'number' ? file.dashboardJsonnetSize : content.length,
      ...(typeof file.updatedAt === 'string' ? { updatedAt: file.updatedAt } : {}),
    };
  }

  return files;
}

function parseArtifacts(value: unknown): Record<string, Artifact> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Import file session.artifacts must be an object when present.');
  }

  const artifacts: Record<string, Artifact> = {};
  for (const [key, artifact] of Object.entries(value)) {
    if (!isRecord(artifact)) {
      throw new Error(`Imported artifact ${key} must be an object.`);
    }

    const id = typeof artifact.id === 'string' && artifact.id ? artifact.id : key;
    const kind = parseArtifactKind(artifact.kind);
    const title = typeof artifact.title === 'string' && artifact.title ? artifact.title : id;
    const toolName = typeof artifact.toolName === 'string' && artifact.toolName ? artifact.toolName : 'tool';
    const summary = typeof artifact.summary === 'string' ? artifact.summary : `${toolName} result stored as artifact.`;

    artifacts[id] = {
      id,
      kind,
      title,
      toolName,
      createdAt: normalizeDateString(artifact.createdAt),
      bytes: typeof artifact.bytes === 'number' && Number.isFinite(artifact.bytes) ? artifact.bytes : 0,
      summary,
      data: artifact.data,
      preview: parseArtifactPreview(artifact.preview),
      mimeType: typeof artifact.mimeType === 'string' ? artifact.mimeType : undefined,
      toolDetails: artifact.toolDetails,
    };
  }

  return compactArtifacts(artifacts);
}

function parseArtifactKind(value: unknown): Artifact['kind'] {
  return value === 'json' || value === 'table' || value === 'dashboard' || value === 'image' || value === 'text'
    ? value
    : 'json';
}

function parseArtifactPreview(value: unknown): Artifact['preview'] {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    return {
      type: 'text',
      text: value.text,
      truncated: value.truncated === true,
    };
  }
  if (value.type === 'json') {
    return {
      type: 'json',
      data: value.data,
      truncated: value.truncated === true,
    };
  }
  if (value.type === 'image' && typeof value.mimeType === 'string' && typeof value.data === 'string') {
    return {
      type: 'image',
      mimeType: value.mimeType,
      data: value.data,
    };
  }
  return undefined;
}

function isAgentMessageLike(value: unknown): value is AgentMessage {
  return isRecord(value) && typeof value.role === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSessionTitle(value: unknown) {
  return typeof value === 'string' ? generateTitle(value) : '';
}

function normalizeDateString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : new Date().toISOString();
}

function countLines(value: string) {
  return value.split('\n').length;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr)',
    gridTemplateRows: 'minmax(0, 1fr)',
    height: 'calc(100vh - 190px)',
    minHeight: 420,
    overflow: 'hidden',
    border: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.primary,
    '@media (max-width: 900px)': {
      gridTemplateColumns: '1fr',
      gridTemplateRows: 'auto minmax(0, 1fr)',
    },
  }),
  sidebar: css({
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
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
  sidebarActions: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
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
    minHeight: 0,
    overflow: 'auto',
  }),
  sessionButton: css({
    display: 'grid',
    gridTemplateRows: 'auto auto',
    alignContent: 'center',
    gap: theme.spacing(0.5),
    flexShrink: 0,
    width: '100%',
    minHeight: 60,
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
    display: 'block',
    minWidth: 0,
    lineHeight: theme.typography.body.lineHeight,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  sessionDate: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: theme.typography.bodySmall.lineHeight,
  }),
  main: css({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
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
  messagesFrame: css({
    position: 'relative',
    display: 'grid',
    flex: '1 1 auto',
    minHeight: 0,
  }),
  messagesFrameWithReport: css({
    gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 360px)',
    '@media (max-width: 1050px)': {
      gridTemplateColumns: '1fr',
      gridTemplateRows: 'minmax(0, 1fr) auto',
    },
  }),
  messages: css({
    height: '100%',
    minHeight: 0,
    overflow: 'auto',
    overscrollBehavior: 'contain',
    padding: theme.spacing(2, 2, 7),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1.5),
    outline: 'none',
    '&:focus-visible': {
      boxShadow: `inset 0 0 0 2px ${theme.colors.primary.border}`,
    },
  }),
  investigationReport: css({
    display: 'grid',
    gridTemplateRows: 'auto auto minmax(0, 1fr)',
    gap: theme.spacing(1.5),
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    borderLeft: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.secondary,
    padding: theme.spacing(2),
    '@media (max-width: 1050px)': {
      borderLeft: 0,
      borderTop: `1px solid ${theme.colors.border.weak}`,
      maxHeight: 360,
    },
  }),
  investigationReportHeader: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  investigationReportTitleGroup: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    minWidth: 0,
    '& h3': {
      margin: 0,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: theme.typography.h5.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
    },
  }),
  investigationReportUpdated: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  investigationReportSections: css({
    display: 'grid',
    alignContent: 'start',
    gap: theme.spacing(1.5),
    minHeight: 0,
    overflow: 'auto',
    paddingRight: theme.spacing(0.5),
  }),
  investigationReportSection: css({
    display: 'grid',
    gap: theme.spacing(0.75),
    '& h4': {
      margin: 0,
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
      textTransform: 'uppercase',
    },
    '& ul': {
      display: 'grid',
      gap: theme.spacing(0.5),
      margin: 0,
      paddingLeft: theme.spacing(2.25),
    },
    '& li': {
      overflowWrap: 'anywhere',
    },
  }),
  investigationReportEmpty: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
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
  jumpToLatest: css({
    position: 'absolute',
    right: theme.spacing(2),
    bottom: theme.spacing(2),
    zIndex: 1,
    boxShadow: theme.shadows.z2,
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
  composerInputGroup: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  composerActions: css({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
  toolConfirmationModal: css({
    width: 'min(620px, calc(100vw - 32px))',
  }),
  toolConfirmationModalContent: css({
    minHeight: 260,
  }),
  toolConfirmation: css({
    display: 'grid',
    gap: theme.spacing(2),
  }),
  toolConfirmationFields: css({
    display: 'grid',
    gap: theme.spacing(1),
    margin: 0,
  }),
  toolConfirmationField: css({
    display: 'grid',
    gridTemplateColumns: '140px minmax(0, 1fr)',
    gap: theme.spacing(1),
    alignItems: 'start',
    '& dt': {
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    },
    '& dd': {
      margin: 0,
      overflowWrap: 'anywhere',
    },
    '@media (max-width: 520px)': {
      gridTemplateColumns: '1fr',
      gap: theme.spacing(0.25),
    },
  }),
  toolConfirmationDetails: css({
    '& summary': {
      cursor: 'pointer',
      fontWeight: theme.typography.fontWeightMedium,
    },
    '& pre': {
      maxHeight: 220,
      overflow: 'auto',
      margin: `${theme.spacing(1)} 0 0`,
      padding: theme.spacing(1),
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      background: theme.colors.background.secondary,
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    },
  }),
  toolConfirmationActions: css({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
});
