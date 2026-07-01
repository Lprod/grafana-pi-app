import type { AgentTool } from '@earendil-works/pi-agent-core';

export type AgentWorkspaceLaunchPayload = {
  contractVersion: string;
  sourcePluginId: string;
  workspaceKind: string;
  workspaceRef?: Record<string, unknown>;
  contextId?: string;
  intent?: string;
  initialPrompt?: string;
  capabilitiesPath: string;
  returnPath?: string;
};

export type AgentWorkspaceCapabilityManifest = {
  contractVersion: string;
  provider: {
    pluginId: string;
    displayName?: string;
  };
  workspaceKinds: AgentWorkspaceKindManifest[];
  limits?: AgentWorkspaceLimits;
};

export type AgentWorkspaceKindManifest = {
  kind: string;
  displayName?: string;
  snapshotPath: string;
  validatePath?: string;
  previewPath?: string;
  savePath?: string;
  submitPath?: string;
  supportedTools?: string[];
  optionalTools?: string[];
  semanticTools?: AgentWorkspaceSemanticToolManifest[];
};

export type AgentWorkspaceSemanticToolManifest = {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execution: {
    method?: string;
    path: string;
  };
  effect: 'read' | 'overlayMutation' | 'persistentMutation';
  approval?: 'notRequired' | 'required';
};

export type AgentWorkspaceLimits = {
  maxFileBytes?: number;
  maxWorkspaceBytes?: number;
  maxReadLines?: number;
  maxToolOutputBytes?: number;
  maxShellRuntimeMs?: number;
};

export type AgentWorkspaceSnapshot = {
  workspaceId: string;
  workspaceKind: string;
  displayName?: string;
  baseVersion: string;
  rootPath: string;
  files: AgentWorkspaceSnapshotFile[];
  contextFiles?: AgentWorkspaceSnapshotFile[];
  schemas?: AgentWorkspaceSchemaRef[];
  workspaceSchemaVersion?: string;
};

export type AgentWorkspaceSnapshotFile = {
  path: string;
  content: string;
  language?: string;
  version?: string;
  checksum?: string;
  readOnly?: boolean;
};

export type AgentWorkspaceSchemaRef = {
  schemaId: string;
  path: string;
  rootTypes?: string[];
};

export type AgentWorkspaceSchemaContent = AgentWorkspaceSnapshotFile & {
  schemaId: string;
};

export type AgentWorkspaceOverlayPayload = {
  baseVersion?: string;
  files: AgentWorkspaceOverlayFile[];
  operations?: AgentWorkspaceOperation[];
};

export type AgentWorkspaceOverlayFile = {
  path: string;
  baseVersion?: string;
  content: string;
  checksum?: string;
};

export type AgentWorkspaceOperation = {
  type: string;
  [key: string]: unknown;
};

export type AgentWorkspaceValidationFinding = {
  severity: 'error' | 'warning' | 'info' | string;
  message: string;
  sourcePath?: string;
  line?: number;
};

export type AgentWorkspaceValidationResult = {
  status: 'valid' | 'warning' | 'error' | string;
  findings?: AgentWorkspaceValidationFinding[];
  summary?: string;
  [key: string]: unknown;
};

export type AgentWorkspacePreviewResult = {
  status: string;
  changedFiles?: unknown[];
  diff?: string;
  validation?: AgentWorkspaceValidationResult;
  [key: string]: unknown;
};

export type AgentWorkspaceSaveResult = AgentWorkspacePreviewResult & {
  savedVersion?: string;
  audit?: unknown;
};

export type AgentWorkspaceState = {
  launch: AgentWorkspaceLaunchPayload;
  manifest: AgentWorkspaceCapabilityManifest;
  kind: AgentWorkspaceKindManifest;
  snapshot: AgentWorkspaceSnapshot;
  vfs: AgentWorkspaceVFSLike;
};

export type AgentWorkspaceVFSLike = {
  overlayPayload: () => AgentWorkspaceOverlayPayload;
  applyOverlayFile: (file: AgentWorkspaceOverlayFile) => void;
  mountSchemaFile: (file: AgentWorkspaceSchemaContent) => void;
  pendingChanges: () => unknown[];
  list: (path?: string) => unknown[];
  find: (pattern?: string) => string[];
  grep: (pattern: string, options?: { path?: string; caseSensitive?: boolean }) => unknown[];
  read: (path: string) => AgentWorkspaceSnapshotFile & Record<string, unknown>;
  readLines: (
    path: string,
    offset?: number,
    limit?: number
  ) => {
    file: AgentWorkspaceSnapshotFile & Record<string, unknown>;
    totalLines: number;
    lines: Array<{ line: number; text: string }>;
  };
  edit: (
    path: string,
    edits: Array<{ startLine: number; endLine: number; replacement: string; expectedText?: string }>,
    baseVersion?: string
  ) => {
    file: AgentWorkspaceSnapshotFile & Record<string, unknown>;
    changedRanges: Array<{ startLine: number; endLine: number; newLines: number }>;
    firstChangedLine?: number;
    diff: string;
  };
  write: (
    path: string,
    content: string,
    baseVersion?: string
  ) => {
    file: AgentWorkspaceSnapshotFile & Record<string, unknown>;
    changedRanges: Array<{ startLine: number; endLine: number; newLines: number }>;
    firstChangedLine?: number;
    diff: string;
  };
};

export type AgentWorkspaceRuntime = {
  getState: () => AgentWorkspaceState | undefined;
  setState: (state: AgentWorkspaceState | undefined) => void;
};

export type AgentWorkspaceToolSet = {
  all: AgentTool[];
  persistentToolNames: Set<string>;
};
