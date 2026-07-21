import { BusEventWithPayload } from '@grafana/data';
import { getAppEvents } from '@grafana/runtime';
import type { AgentWorkspaceLaunchPayload, AgentWorkspaceSaveResult } from './types';

export type AgentWorkspaceSavedPayload = {
  sourcePluginId: string;
  workspaceKind: string;
  workspaceRef?: Record<string, unknown>;
  savedVersion?: string;
  changedFiles?: unknown[];
};

class AgentWorkspaceSavedEvent extends BusEventWithPayload<AgentWorkspaceSavedPayload> {
  static type = 'agent-workspace-saved';
}

export function publishAgentWorkspaceSaved(launch: AgentWorkspaceLaunchPayload, result: AgentWorkspaceSaveResult) {
  getAppEvents().publish(
    new AgentWorkspaceSavedEvent({
      sourcePluginId: launch.sourcePluginId,
      workspaceKind: launch.workspaceKind,
      workspaceRef: launch.workspaceRef,
      savedVersion: result.savedVersion,
      changedFiles: result.changedFiles,
    })
  );
}
