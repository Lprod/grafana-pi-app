import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { textResult, throwIfAborted, truncateText } from '../tools/result';
import {
  executeAgentWorkspaceSemanticTool,
  fetchAgentWorkspaceSchema,
  previewAgentWorkspace,
  saveAgentWorkspace,
  validateAgentWorkspace,
} from './providerClient';
import type {
  AgentWorkspaceOperation,
  AgentWorkspaceOverlayFile,
  AgentWorkspaceRuntime,
  AgentWorkspaceSemanticToolManifest,
  AgentWorkspaceState,
  AgentWorkspaceToolSet,
  AgentWorkspaceValidationResult,
} from './types';
import { runAgentWorkspaceBash, type AgentWorkspaceBashParams } from './shell';
import { publishAgentWorkspaceSaved } from './events';

type ReadParams = {
  path: string;
  offset?: number;
  limit?: number;
};

type ListParams = {
  path?: string;
};

type FindParams = {
  pattern?: string;
};

type GrepParams = {
  pattern: string;
  path?: string;
  caseSensitive?: boolean;
};

type EditParams = {
  path: string;
  baseVersion?: string;
  edits: Array<{
    startLine: number;
    endLine: number;
    replacement: string;
    expectedText?: string;
  }>;
};

type WriteParams = {
  path: string;
  content: string;
  baseVersion?: string;
};

type SchemaParams = {
  schemaId?: string;
  path?: string;
};

type SemanticToolProviderResponse = {
  summary?: string;
  files?: AgentWorkspaceOverlayFile[];
  operation?: AgentWorkspaceOperation;
  validation?: AgentWorkspaceValidationResult;
  diff?: string;
  [key: string]: unknown;
};

const PERSISTENT_AGENT_WORKSPACE_TOOLS = new Set(['save_changes', 'submit_changes']);

export function createAgentWorkspaceTools(runtime: AgentWorkspaceRuntime): AgentWorkspaceToolSet {
  const state = runtime.getState();
  const baseTools = [
    makeWorkspaceInfoTool(runtime),
    makeListTool(runtime),
    makeFindTool(runtime),
    makeGrepTool(runtime),
    makeReadTool(runtime),
    makeEditTool(runtime),
    makeWriteTool(runtime),
    makeGetSchemaTool(runtime),
    makeValidateTool(runtime),
    makePreviewTool(runtime),
    makeSaveTool(runtime),
  ];
  const optionalTools = state && workspaceSupportsTool(state, 'bash') ? [makeBashTool(runtime)] : [];
  const semanticTools = state ? createSemanticTools(runtime, state.kind.semanticTools ?? []) : [];

  return {
    all: [...baseTools, ...optionalTools, ...semanticTools],
    persistentToolNames: PERSISTENT_AGENT_WORKSPACE_TOOLS,
  };
}

function makeWorkspaceInfoTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'workspace_info',
    label: 'Workspace info',
    description:
      'Summarize the active Coding Agent App Contract workspace, limits, files, schemas, and pending changes.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const result = {
        provider: state.manifest.provider,
        workspaceId: state.snapshot.workspaceId,
        workspaceKind: state.snapshot.workspaceKind,
        displayName: state.snapshot.displayName,
        rootPath: state.snapshot.rootPath,
        baseVersion: state.snapshot.baseVersion,
        files: state.snapshot.files.map((file) => ({
          path: file.path,
          language: file.language,
          version: file.version,
          readOnly: file.readOnly,
        })),
        schemas: state.snapshot.schemas ?? [],
        limits: state.manifest.limits ?? {},
        pendingChanges: state.vfs.pendingChanges(),
      };
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function makeListTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'ls',
    label: 'List files',
    description: 'List Browser VFS directory entries. Omit path to list the workspace root.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Directory path. Defaults to workspace root.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const args = params as ListParams;
      const entries = state.vfs.list(args.path);
      const result = { path: args.path ?? state.snapshot.rootPath, entries };
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function makeFindTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'find',
    label: 'Find files',
    description: 'Find Browser VFS paths by a simple glob pattern. Use * as a wildcard.',
    parameters: Type.Object({
      pattern: Type.Optional(Type.String({ description: 'Glob pattern. Defaults to *.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const args = params as FindParams;
      const paths = state.vfs.find(args.pattern);
      return textResult(JSON.stringify({ paths }, null, 2), { paths });
    },
  };
}

function makeGrepTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'grep',
    label: 'Search files',
    description: 'Search text files in the Browser VFS. This performs literal text matching, not regular expressions.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Literal text to search for.' }),
      path: Type.Optional(Type.String({ description: 'Optional file or directory path to search under.' })),
      caseSensitive: Type.Optional(Type.Boolean({ description: 'Whether matching is case sensitive.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const args = params as GrepParams;
      const matches = state.vfs.grep(args.pattern, {
        path: args.path,
        caseSensitive: args.caseSensitive,
      });
      const result = { matchCount: matches.length, matches: matches.slice(0, 200) };
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function makeReadTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'read',
    label: 'Read file',
    description: 'Read a bounded line window from one Browser VFS file. Use offset and limit for larger files.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute VFS path to read.' }),
      offset: Type.Optional(Type.Number({ description: '1-based start line. Defaults to 1.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum lines to read. Defaults to 200.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const args = params as ReadParams;
      const result = state.vfs.readLines(args.path, args.offset, args.limit);
      const publicResult = {
        path: result.file.path,
        version: result.file.version,
        checksum: result.file.checksum,
        language: result.file.language,
        readOnly: result.file.readOnly,
        totalLines: result.totalLines,
        lines: result.lines,
      };
      return textResult(JSON.stringify(publicResult, null, 2), publicResult);
    },
  };
}

function makeEditTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'edit',
    label: 'Edit file',
    description:
      'Apply transactional line-range edits to a writable Browser VFS file. Line numbers are 1-based and inclusive. Use expectedText when possible.',
    executionMode: 'sequential',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute VFS path to edit.' }),
      baseVersion: Type.Optional(
        Type.String({ description: 'Expected current file version from read/workspace_info.' })
      ),
      edits: Type.Array(
        Type.Object({
          startLine: Type.Number({ description: '1-based start line.' }),
          endLine: Type.Number({ description: '1-based inclusive end line. Use startLine - 1 for insertion.' }),
          replacement: Type.String({ description: 'Replacement text. Empty string deletes the range.' }),
          expectedText: Type.Optional(Type.String({ description: 'Exact text expected in the target range.' })),
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const args = params as EditParams;
      const mutation = state.vfs.edit(args.path, args.edits, args.baseVersion);
      const result = {
        path: mutation.file.path,
        version: mutation.file.version,
        checksum: mutation.file.checksum,
        changedRanges: mutation.changedRanges,
        firstChangedLine: mutation.firstChangedLine,
        diff: mutation.diff,
        pendingChanges: state.vfs.pendingChanges(),
      };
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function makeWriteTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'write',
    label: 'Write file',
    description: 'Create or overwrite one allowed Browser VFS file under the workspace root.',
    executionMode: 'sequential',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute VFS path to create or overwrite.' }),
      content: Type.String({ description: 'Complete file content.' }),
      baseVersion: Type.Optional(Type.String({ description: 'Expected current file version when overwriting.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const args = params as WriteParams;
      const mutation = state.vfs.write(args.path, args.content, args.baseVersion);
      const result = {
        path: mutation.file.path,
        version: mutation.file.version,
        checksum: mutation.file.checksum,
        changedRanges: mutation.changedRanges,
        firstChangedLine: mutation.firstChangedLine,
        diff: mutation.diff,
        pendingChanges: state.vfs.pendingChanges(),
      };
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function makeGetSchemaTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'get_schema',
    label: 'Get schema',
    description: 'Read schema metadata or schema content for the active workspace.',
    parameters: Type.Object({
      schemaId: Type.Optional(Type.String({ description: 'Schema ID from workspace_info.' })),
      path: Type.Optional(Type.String({ description: 'Schema VFS path to read if already mounted.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const args = params as SchemaParams;
      if (args.path) {
        const file = state.vfs.read(args.path);
        const result = {
          path: file.path,
          content: truncateText(file.content, 20000),
          checksum: file.checksum,
          version: file.version,
        };
        return textResult(JSON.stringify(result, null, 2), result);
      }

      const schemaId = args.schemaId ?? state.snapshot.schemas?.[0]?.schemaId;
      if (!schemaId) {
        throw new Error('No schemaId provided and the workspace snapshot did not declare schemas.');
      }
      const schema = await fetchAgentWorkspaceSchema(state, schemaId);
      state.vfs.mountSchemaFile(schema);
      const result = {
        schemaId,
        path: schema.path,
        content: truncateText(schema.content, 20000),
        checksum: schema.checksum,
      };
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function makeValidateTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'validate_workspace',
    label: 'Validate workspace',
    description: 'Ask the provider backend to authoritatively validate the current workspace overlay.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const result = await validateAgentWorkspace(state);
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function makePreviewTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'preview_diff',
    label: 'Preview diff',
    description:
      'Ask the provider backend to preview changed files and a compact diff for the current workspace overlay.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const result = await previewAgentWorkspace(state);
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function makeSaveTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'save_changes',
    label: 'Save changes',
    description:
      'Persist approved workspace changes through the provider backend. Call validate_workspace and preview_diff before save_changes.',
    executionMode: 'sequential',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const result = await saveAgentWorkspace(state);
      const committable = state.vfs as { commitOverlay?: (baseVersion?: string) => void };
      committable.commitOverlay?.(result.savedVersion);
      publishAgentWorkspaceSaved(state.launch, result);
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function makeBashTool(runtime: AgentWorkspaceRuntime): AgentTool {
  return {
    name: 'bash',
    label: 'Bash',
    description:
      'Run one non-interactive bash command against the browser virtual filesystem. It has no network or provider secrets. Allowed /workspace file changes are copied into the workspace overlay.',
    executionMode: 'sequential',
    parameters: Type.Object({
      command: Type.String({ description: 'Non-interactive shell command to run.' }),
      stdin: Type.Optional(Type.String({ description: 'Optional standard input for the command.' })),
      timeoutMs: Type.Optional(
        Type.Number({ description: 'Requested timeout in milliseconds, capped by workspace limits.' })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const state = requireWorkspaceState(runtime);
      const result = await runAgentWorkspaceBash(state, params as AgentWorkspaceBashParams, signal);
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

function createSemanticTools(
  runtime: AgentWorkspaceRuntime,
  semanticTools: readonly AgentWorkspaceSemanticToolManifest[]
): AgentTool[] {
  return semanticTools.map((tool): AgentTool => {
    const persistent = tool.effect === 'persistentMutation' || tool.approval === 'required';
    if (persistent) {
      PERSISTENT_AGENT_WORKSPACE_TOOLS.add(tool.name);
    }

    return {
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters as any,
      executionMode: tool.effect === 'read' ? undefined : 'sequential',
      async execute(_toolCallId, params, signal) {
        throwIfAborted(signal);
        const state = requireWorkspaceState(runtime);
        const result = await executeAgentWorkspaceSemanticTool<SemanticToolProviderResponse>(
          state,
          tool.execution.path,
          tool.execution.method,
          params
        );
        for (const file of result.files ?? []) {
          state.vfs.applyOverlayFile(file);
        }
        const publicResult = {
          ...result,
          pendingChanges: state.vfs.pendingChanges(),
        };
        return textResult(JSON.stringify(publicResult, null, 2), publicResult);
      },
    };
  });
}

function requireWorkspaceState(runtime: AgentWorkspaceRuntime): AgentWorkspaceState {
  const state = runtime.getState();
  if (!state) {
    throw new Error('No active Coding Agent App Contract workspace is loaded.');
  }
  return state;
}

function workspaceSupportsTool(state: AgentWorkspaceState, toolName: string) {
  return Boolean(state.kind.optionalTools?.includes(toolName) || state.kind.supportedTools?.includes(toolName));
}
