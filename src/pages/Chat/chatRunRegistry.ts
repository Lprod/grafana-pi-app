import type { Agent, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import type { DashboardAssistantLaunch } from './dashboardLaunch';
import type {
  Artifact,
  DashboardSaveFolderSelection,
  InvestigationReport,
  VirtualJsonnetFileSnapshot,
} from './grafanaTools';
import type { ToolRunView } from './ToolRenderer';

export type ChatToolConfirmationHandler = (
  toolCallId: string,
  toolName: string,
  args: unknown,
  signal?: AbortSignal
) => Promise<BeforeToolCallResult | undefined>;

export type ChatRunSnapshot = {
  id: string;
  title: string;
  agent: Agent;
  dashboardLaunch?: DashboardAssistantLaunch;
  virtualJsonnetFiles: Record<string, VirtualJsonnetFileSnapshot>;
  virtualJsonnetHydrated: Record<string, number>;
  investigationReport?: InvestigationReport;
  artifacts: Record<string, Artifact>;
  artifactCounter: number;
  toolRuns: Record<string, ToolRunView>;
  requestToolConfirmation?: ChatToolConfirmationHandler;
  updatedAt: number;
};

const liveRuns = new Map<string, ChatRunSnapshot>();
const dashboardSaveFolderOverrides = new Map<string, DashboardSaveFolderSelection>();

export function storeChatRun(snapshot: Omit<ChatRunSnapshot, 'updatedAt'>): ChatRunSnapshot {
  const stored = {
    ...snapshot,
    updatedAt: Date.now(),
  };
  liveRuns.set(snapshot.id, stored);
  return stored;
}

export function getChatRun(id: string | undefined): ChatRunSnapshot | undefined {
  return id ? liveRuns.get(id) : undefined;
}

export function removeChatRun(id: string | undefined) {
  if (!id) {
    return;
  }
  liveRuns.delete(id);
  clearDashboardSaveFolderOverridesForSession(id);
}

export function isStoredChatRunAgent(id: string | undefined, agent: Agent | undefined) {
  return Boolean(id && agent && liveRuns.get(id)?.agent === agent);
}

export function setChatRunConfirmationHandler(id: string | undefined, handler: ChatToolConfirmationHandler) {
  const run = getChatRun(id);
  if (run) {
    run.requestToolConfirmation = handler;
    run.updatedAt = Date.now();
  }
}

export function setDashboardSaveFolderOverride(
  sessionId: string,
  toolCallId: string,
  selection: DashboardSaveFolderSelection
) {
  dashboardSaveFolderOverrides.set(dashboardSaveFolderKey(sessionId, toolCallId), selection);
}

export function getDashboardSaveFolderOverride(sessionId: string | undefined, toolCallId: string) {
  return sessionId ? dashboardSaveFolderOverrides.get(dashboardSaveFolderKey(sessionId, toolCallId)) : undefined;
}

export function clearDashboardSaveFolderOverride(sessionId: string | undefined, toolCallId: string) {
  if (!sessionId) {
    return;
  }
  dashboardSaveFolderOverrides.delete(dashboardSaveFolderKey(sessionId, toolCallId));
}

function clearDashboardSaveFolderOverridesForSession(sessionId: string) {
  const prefix = `${sessionId}:`;
  for (const key of dashboardSaveFolderOverrides.keys()) {
    if (key.startsWith(prefix)) {
      dashboardSaveFolderOverrides.delete(key);
    }
  }
}

function dashboardSaveFolderKey(sessionId: string, toolCallId: string) {
  return `${sessionId}:${toolCallId}`;
}
