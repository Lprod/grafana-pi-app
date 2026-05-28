import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { pluginResourceFetch } from './client';
import { textResult, throwIfAborted } from './result';
import type {
  CreateGrafanaToolsOptions,
  JsonnetFileEditParams,
  JsonnetFileReadParams,
  JsonnetFileRepairParams,
  JsonnetFileToolSet,
  JsonnetFileWriteParams,
  JsonnetLineEdit,
  VirtualJsonnetFileRuntime,
  VirtualJsonnetFileSnapshot,
} from './types';

export const DEFAULT_JSONNET_FILE_PATH = 'dashboard.jsonnet';

type JsonnetFileBackendResponse = VirtualJsonnetFileSnapshot & {
  dashboard_jsonnet?: string;
  changedRanges?: Array<{ startLine: number; endLine: number; newLines: number }>;
  diff?: string;
  firstChangedLine?: number;
  totalLines?: number;
  lines?: Array<{ line: number; text: string }>;
  repairs?: string[];
};

export function createJsonnetFileTools(options: CreateGrafanaToolsOptions): JsonnetFileToolSet {
  const write = makeWriteJsonnetFileTool(options.virtualJsonnetFiles);
  const edit = makeEditJsonnetFileTool(options.virtualJsonnetFiles);
  const fix = makeFixJsonnetFileTool(options.virtualJsonnetFiles);
  const read = makeReadJsonnetFileTool(options.virtualJsonnetFiles);

  return {
    all: [write, edit, fix, read],
    write,
    edit,
    fix,
    read,
  };
}

export async function ensureVirtualJsonnetFileHydrated(
  runtime: VirtualJsonnetFileRuntime | undefined,
  path: string | undefined,
  signal?: AbortSignal
) {
  if (!runtime) {
    return;
  }
  const resolvedPath = normalizeJsonnetPath(path);
  const file = runtime.getFile(resolvedPath);
  if (!file || runtime.isHydrated?.(file.path, file.version)) {
    return;
  }
  throwIfAborted(signal);
  await pluginResourceFetch<JsonnetFileBackendResponse>('/managed-dashboards/jsonnet-files/write', {
    method: 'POST',
    data: {
      sessionId: requireSessionId(runtime),
      path: file.path,
      content: file.content,
      version: file.version,
    },
  });
  runtime.markHydrated?.(file.path, file.version);
}

export function normalizeJsonnetPath(path?: string) {
  const trimmed = path?.trim();
  return trimmed || DEFAULT_JSONNET_FILE_PATH;
}

function makeWriteJsonnetFileTool(runtime: VirtualJsonnetFileRuntime | undefined): AgentTool {
  return {
    name: 'write_jsonnet',
    label: 'Write Jsonnet file',
    description:
      'Create the session virtual Jsonnet file used for managed dashboards. Write dashboard.jsonnet once with the full initial source. If the file already exists, use edit_jsonnet for every follow-up change.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: `Virtual file path. Defaults to ${DEFAULT_JSONNET_FILE_PATH}.` })),
      content: Type.String({
        description:
          'Complete Jsonnet source that evaluates to a Grafana dashboard object. For new dashboards, write a plain object Jsonnet file; do not import Grafonnet unless editing existing Grafonnet source.',
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as JsonnetFileWriteParams;
      const path = normalizeJsonnetPath(args.path);
      const existing = runtime?.getFile(path);
      if (existing) {
        throw new Error(
          `${path} already exists at version ${existing.version}; use edit_jsonnet for follow-up changes.`
        );
      }
      throwIfAborted(signal);
      const result = await pluginResourceFetch<JsonnetFileBackendResponse>('/managed-dashboards/jsonnet-files/write', {
        method: 'POST',
        data: {
          sessionId: requireSessionId(runtime),
          path,
          content: args.content,
        },
      });
      const snapshot = snapshotFromResponse(result, args.content);
      runtime?.setFile(snapshot, { hydrated: true });
      return textResult(
        JSON.stringify(publicJsonnetFileResult(result, 'written'), null, 2),
        publicJsonnetFileResult(result, 'written')
      );
    },
  };
}

function makeEditJsonnetFileTool(runtime: VirtualJsonnetFileRuntime | undefined): AgentTool {
  return {
    name: 'edit_jsonnet',
    label: 'Edit Jsonnet file',
    description:
      'Apply compact transactional line-range edits to the session virtual Jsonnet file. The edited file must compile. Line numbers are 1-based and inclusive. Use baseVersion from the latest write/edit/read result when available.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: `Virtual file path. Defaults to ${DEFAULT_JSONNET_FILE_PATH}.` })),
      baseVersion: Type.Optional(Type.Number({ description: 'Expected current file version.' })),
      edits: Type.Array(
        Type.Object({
          startLine: Type.Number({
            description: '1-based start line. Use lineCount + 1 with endLine = lineCount to append.',
          }),
          endLine: Type.Number({ description: '1-based inclusive end line. Use startLine - 1 for insertion.' }),
          replacement: Type.String({
            description: 'Replacement text for the target range. Empty string deletes the range.',
          }),
          expectedText: Type.Optional(
            Type.String({ description: 'Optional exact text expected in the target range before editing.' })
          ),
        }),
        { description: 'Non-overlapping line replacements applied to the same base file.' }
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as JsonnetFileEditParams;
      const path = normalizeJsonnetPath(args.path);
      await ensureVirtualJsonnetFileHydrated(runtime, path, signal);
      throwIfAborted(signal);
      const result = await pluginResourceFetch<JsonnetFileBackendResponse>('/managed-dashboards/jsonnet-files/edit', {
        method: 'POST',
        data: {
          sessionId: requireSessionId(runtime),
          path,
          baseVersion: args.baseVersion,
          edits: args.edits,
        },
      });
      const content = result.dashboard_jsonnet ?? applyLineEdits(runtime?.getFile(path)?.content ?? '', args.edits);
      runtime?.setFile(snapshotFromResponse(result, content), { hydrated: true });
      return textResult(
        JSON.stringify(publicJsonnetFileResult(result, 'edited'), null, 2),
        publicJsonnetFileResult(result, 'edited')
      );
    },
  };
}

function makeFixJsonnetFileTool(runtime: VirtualJsonnetFileRuntime | undefined): AgentTool {
  return {
    name: 'fix_jsonnet',
    label: 'Fix Jsonnet file',
    description:
      'Apply a transactional structural repair to the current virtual Jsonnet file after render errors. Use this for common invalid Grafonnet constructor chains such as g.dashboard.new(...) + g.dashboard.with_panels([...]) or g.panel.new(...).',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: `Virtual file path. Defaults to ${DEFAULT_JSONNET_FILE_PATH}.` })),
      baseVersion: Type.Optional(Type.Number({ description: 'Expected current file version.' })),
      error: Type.Optional(Type.String({ description: 'Render or compile error that motivated the repair.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as JsonnetFileRepairParams;
      const path = normalizeJsonnetPath(args.path);
      await ensureVirtualJsonnetFileHydrated(runtime, path, signal);
      throwIfAborted(signal);
      const data: Record<string, unknown> = {
        sessionId: requireSessionId(runtime),
        path,
        baseVersion: args.baseVersion,
      };
      if (args.error) {
        data.error = args.error;
      }
      const result = await pluginResourceFetch<JsonnetFileBackendResponse>('/managed-dashboards/jsonnet-files/repair', {
        method: 'POST',
        data,
      });
      const content = result.dashboard_jsonnet ?? runtime?.getFile(path)?.content ?? '';
      runtime?.setFile(snapshotFromResponse(result, content), { hydrated: true });
      return textResult(
        JSON.stringify(publicJsonnetFileResult(result, 'fixed'), null, 2),
        publicJsonnetFileResult(result, 'fixed')
      );
    },
  };
}

function makeReadJsonnetFileTool(runtime: VirtualJsonnetFileRuntime | undefined): AgentTool {
  return {
    name: 'read_jsonnet',
    label: 'Read Jsonnet file',
    description:
      'Read a bounded line window from the session virtual Jsonnet file. Use this after compile or edit errors instead of asking for the whole file.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: `Virtual file path. Defaults to ${DEFAULT_JSONNET_FILE_PATH}.` })),
      offset: Type.Optional(Type.Number({ description: '1-based start line.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum lines to return.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as JsonnetFileReadParams;
      const path = normalizeJsonnetPath(args.path);
      await ensureVirtualJsonnetFileHydrated(runtime, path, signal);
      throwIfAborted(signal);
      const result = await pluginResourceFetch<JsonnetFileBackendResponse>('/managed-dashboards/jsonnet-files/read', {
        method: 'POST',
        data: {
          sessionId: requireSessionId(runtime),
          path,
          offset: args.offset,
          limit: args.limit,
        },
      });
      return textResult(
        JSON.stringify(publicJsonnetFileResult(result, 'read'), null, 2),
        publicJsonnetFileResult(result, 'read')
      );
    },
  };
}

function requireSessionId(runtime: VirtualJsonnetFileRuntime | undefined) {
  const sessionId = runtime?.getSessionId();
  if (!sessionId) {
    throw new Error('A chat session is required before editing a virtual Jsonnet file.');
  }
  return sessionId;
}

function snapshotFromResponse(response: JsonnetFileBackendResponse, content: string): VirtualJsonnetFileSnapshot {
  return {
    path: response.path,
    content,
    version: response.version,
    checksum: response.checksum,
    lineCount: response.lineCount,
    dashboardJsonnetSize: response.dashboardJsonnetSize,
    updatedAt: response.updatedAt,
  };
}

function publicJsonnetFileResult(
  response: JsonnetFileBackendResponse,
  action: 'written' | 'edited' | 'fixed' | 'read'
) {
  const { dashboard_jsonnet: _dashboardJsonnet, ...publicResponse } = response;
  return { action, ...publicResponse };
}

function applyLineEdits(content: string, edits: JsonnetLineEdit[]) {
  const trailingNewline = content.endsWith('\n');
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '').split('\n');
  const normalizedLines = lines.length === 1 && lines[0] === '' ? [] : lines;
  const sorted = [...edits].sort((left, right) => right.startLine - left.startLine);
  for (const edit of sorted) {
    const start = edit.startLine - 1;
    const end = edit.endLine;
    const replacement = edit.replacement.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
    normalizedLines.splice(start, end - start, ...(replacement ? replacement.split('\n') : []));
  }
  const next = normalizedLines.join('\n');
  return trailingNewline && next ? `${next}\n` : next;
}
