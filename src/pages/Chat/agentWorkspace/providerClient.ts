import { pluginResourceFetchForPlugin } from '../tools/client';
import { AgentWorkspaceVFS } from './vfs';
import type {
  AgentWorkspaceCapabilityManifest,
  AgentWorkspaceKindManifest,
  AgentWorkspaceLaunchPayload,
  AgentWorkspacePreviewResult,
  AgentWorkspaceSaveResult,
  AgentWorkspaceSchemaContent,
  AgentWorkspaceSnapshot,
  AgentWorkspaceState,
  AgentWorkspaceValidationResult,
} from './types';

export async function createAgentWorkspaceState(launch: AgentWorkspaceLaunchPayload): Promise<AgentWorkspaceState> {
  if (launch.contractVersion !== '1') {
    throw new Error(`Unsupported coding-agent contractVersion: ${launch.contractVersion}`);
  }

  const manifest = await providerFetch<AgentWorkspaceCapabilityManifest>(launch, launch.capabilitiesPath);
  if (manifest.contractVersion !== launch.contractVersion) {
    throw new Error(
      `Provider ${launch.sourcePluginId} returned contractVersion ${manifest.contractVersion}; expected ${launch.contractVersion}`
    );
  }

  const kind = manifest.workspaceKinds.find((item) => item.kind === launch.workspaceKind);
  if (!kind) {
    throw new Error(`Provider ${launch.sourcePluginId} does not support workspaceKind ${launch.workspaceKind}`);
  }

  const snapshot = await providerFetch<AgentWorkspaceSnapshot>(launch, kind.snapshotPath, {
    method: 'POST',
    data: {
      workspaceKind: launch.workspaceKind,
      workspaceRef: launch.workspaceRef ?? {},
      contextId: launch.contextId,
    },
  });

  return {
    launch,
    manifest,
    kind,
    snapshot,
    vfs: new AgentWorkspaceVFS(snapshot),
  };
}

export async function fetchAgentWorkspaceSchema(
  state: AgentWorkspaceState,
  schemaId: string
): Promise<AgentWorkspaceSchemaContent> {
  return providerFetch<AgentWorkspaceSchemaContent>(
    state.launch,
    `/agent/workspaces/${encodeURIComponent(state.snapshot.workspaceId)}/schemas/${encodeURIComponent(schemaId)}`
  );
}

export async function validateAgentWorkspace(state: AgentWorkspaceState): Promise<AgentWorkspaceValidationResult> {
  const path = requiredPath(state.kind, 'validatePath');
  return providerFetch<AgentWorkspaceValidationResult>(state.launch, pathForWorkspace(state.kind, path, state), {
    method: 'POST',
    data: state.vfs.overlayPayload(),
  });
}

export async function previewAgentWorkspace(state: AgentWorkspaceState): Promise<AgentWorkspacePreviewResult> {
  const path = requiredPath(state.kind, 'previewPath');
  return providerFetch<AgentWorkspacePreviewResult>(state.launch, pathForWorkspace(state.kind, path, state), {
    method: 'POST',
    data: state.vfs.overlayPayload(),
  });
}

export async function saveAgentWorkspace(state: AgentWorkspaceState): Promise<AgentWorkspaceSaveResult> {
  const path = requiredPath(state.kind, 'savePath');
  return providerFetch<AgentWorkspaceSaveResult>(state.launch, pathForWorkspace(state.kind, path, state), {
    method: 'POST',
    data: state.vfs.overlayPayload(),
  });
}

export async function executeAgentWorkspaceSemanticTool<T = unknown>(
  state: AgentWorkspaceState,
  path: string,
  method: string | undefined,
  args: unknown
): Promise<T> {
  return providerFetch<T>(state.launch, pathForWorkspace(state.kind, path, state), {
    method: method ?? 'POST',
    data: {
      overlay: state.vfs.overlayPayload(),
      args,
    },
  });
}

function providerFetch<T>(
  launch: AgentWorkspaceLaunchPayload,
  path: string,
  options: { method?: string; data?: unknown; params?: Record<string, unknown> } = {}
): Promise<T> {
  return pluginResourceFetchForPlugin<T>(launch.sourcePluginId, path, options);
}

function pathForWorkspace(_kind: AgentWorkspaceKindManifest, path: string, state: AgentWorkspaceState) {
  return path.replaceAll('{workspaceId}', encodeURIComponent(state.snapshot.workspaceId));
}

function requiredPath(kind: AgentWorkspaceKindManifest, field: 'validatePath' | 'previewPath' | 'savePath') {
  const path = kind[field];
  if (!path) {
    throw new Error(`Workspace kind ${kind.kind} does not declare ${field}.`);
  }
  return path;
}
