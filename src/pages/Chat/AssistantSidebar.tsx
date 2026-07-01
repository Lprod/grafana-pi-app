import React from 'react';
import { ChatApp } from './ChatSceneObject';
import type { DashboardAssistantAction } from './dashboardLaunch';
import type { AgentWorkspaceLaunchPayload } from './agentWorkspace/types';

export type AssistantSidebarProps = {
  action?: DashboardAssistantAction;
  agentWorkspaceLaunch?: AgentWorkspaceLaunchPayload;
  contextId?: string;
  path?: string;
  sessionId?: string;
};

export default function AssistantSidebar({
  action,
  agentWorkspaceLaunch,
  contextId,
  path,
  sessionId,
}: AssistantSidebarProps) {
  return (
    <ChatApp
      key={sidebarKey({ action, agentWorkspaceLaunch, contextId, sessionId })}
      variant="sidebar"
      agentWorkspaceLaunch={agentWorkspaceLaunch}
      launchContextId={contextId}
      sidebarRoute={path}
      sessionId={sessionId}
    />
  );
}

function sidebarKey({
  action,
  agentWorkspaceLaunch,
  contextId,
  sessionId,
}: Pick<AssistantSidebarProps, 'action' | 'agentWorkspaceLaunch' | 'contextId' | 'sessionId'>) {
  if (sessionId) {
    return sessionId;
  }
  if (agentWorkspaceLaunch) {
    return JSON.stringify({
      sourcePluginId: agentWorkspaceLaunch.sourcePluginId,
      workspaceKind: agentWorkspaceLaunch.workspaceKind,
      workspaceRef: agentWorkspaceLaunch.workspaceRef,
      contextId: agentWorkspaceLaunch.contextId,
    });
  }
  return contextId ?? action ?? 'sidebar';
}
