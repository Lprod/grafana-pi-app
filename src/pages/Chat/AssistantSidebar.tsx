import React from 'react';
import { ChatApp } from './ChatSceneObject';
import type { DashboardAssistantAction } from './dashboardLaunch';

export type AssistantSidebarProps = {
  action?: DashboardAssistantAction;
  contextId?: string;
  path?: string;
  sessionId?: string;
};

export default function AssistantSidebar({ action, contextId, sessionId }: AssistantSidebarProps) {
  return (
    <ChatApp
      key={sessionId ?? contextId ?? action ?? 'sidebar'}
      variant="sidebar"
      launchContextId={contextId}
      sessionId={sessionId}
    />
  );
}
