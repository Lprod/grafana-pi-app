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
  await pluginResourceFetch<JsonnetFileBackendResponse>('/jsonnet-dashboards/jsonnet-files/write', {
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
      'Create the session virtual Jsonnet file used for dashboard rendering and saving. Write dashboard.jsonnet once with the full initial source. If the file already exists, use edit_jsonnet for every follow-up change. For new dashboards use the function-based helper API: local d = import "github.com/g42/pi-dashboard/main.libsonnet"; d.dashboard.new(title="...", uid="...", rows=[d.row("Overview", [d.layout.twoUp([...])])]).',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: `Virtual file path. Defaults to ${DEFAULT_JSONNET_FILE_PATH}.` })),
      content: Type.String({
        description:
          'Complete Jsonnet source that evaluates to a classic Grafana dashboard object. For new dashboards, prefer importing github.com/g42/pi-dashboard/main.libsonnet for layout/table helpers; do not import Grafonnet unless editing existing Grafonnet source. Prefer d.dashboard.new(title=..., uid=..., rows=...), d.row(...), d.layout.twoUp/fourUp(...), d.panel.timeseries/stat/table(...), and d.prom.query(...).',
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
      const content = normalizeDashboardJsonnetDraft(args.content);
      const result = await pluginResourceFetch<JsonnetFileBackendResponse>('/jsonnet-dashboards/jsonnet-files/write', {
        method: 'POST',
        data: {
          sessionId: requireSessionId(runtime),
          path,
          content,
        },
      });
      const snapshot = snapshotFromResponse(result, content);
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
      const result = await pluginResourceFetch<JsonnetFileBackendResponse>('/jsonnet-dashboards/jsonnet-files/edit', {
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
      const result = await pluginResourceFetch<JsonnetFileBackendResponse>('/jsonnet-dashboards/jsonnet-files/repair', {
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
      const result = await pluginResourceFetch<JsonnetFileBackendResponse>('/jsonnet-dashboards/jsonnet-files/read', {
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

function normalizeDashboardJsonnetDraft(content: string) {
  const source = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/.exec(source);
  if (!match) {
    return source;
  }

  const bindingName = match[1];
  const objectStart = skipWhitespace(source, match[0].length);
  if (source[objectStart] !== '{') {
    return source;
  }

  const objectEnd = findMatchingJsonnetBrace(source, objectStart);
  if (objectEnd < 0) {
    return source;
  }

  const assignedObject = source.slice(objectStart, objectEnd + 1);
  const suffix = source.slice(objectEnd + 1).trim();
  const wrapper = new RegExp(`^;?\\s*\\{\\s*dashboard\\s*:\\s*${escapeRegExp(bindingName)}\\s*,?\\s*\\}\\s*$`);
  const direct = new RegExp(`^;?\\s*${escapeRegExp(bindingName)}\\s*$`);
  if (!wrapper.test(suffix) && !direct.test(suffix)) {
    return source;
  }

  return assignedObject.endsWith('\n') ? assignedObject : `${assignedObject}\n`;
}

function skipWhitespace(source: string, start: number) {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) {
    index++;
  }
  return index;
}

function findMatchingJsonnetBrace(source: string, start: number) {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;

  for (let index = start; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') {
      depth++;
      continue;
    }
    if (char === '}') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
