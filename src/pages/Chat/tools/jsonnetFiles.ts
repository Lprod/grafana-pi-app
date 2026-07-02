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
const DASHBOARD_HELPER_IMPORT = 'github.com/g42/pi-dashboard/main.libsonnet';
const DASHBOARD_HELPER_ALLOWED_LAYOUTS = new Set(['full', 'twoUp', 'threeUp', 'fourUp', 'statStrip']);
const DASHBOARD_HELPER_FORBIDDEN_DASHBOARD_ARGS = ['timeframe', 'timeFrom', 'timeTo'];
const DASHBOARD_HELPER_PANEL_ALLOWED_ARGS: Record<string, Set<string>> = {
  timeseries: new Set(['title', 'datasourceUid', 'targets', 'unit', 'decimals', 'options', 'fieldConfig']),
  stat: new Set(['title', 'datasourceUid', 'targets', 'unit', 'decimals', 'options', 'fieldConfig']),
  table: new Set([
    'title',
    'datasourceUid',
    'targets',
    'columns',
    'rename',
    'transformations',
    'options',
    'fieldConfig',
  ]),
};
const DASHBOARD_HELPER_PANEL_ARG_HINTS: Record<string, string> = {
  span: 'Layout helpers set grid positions; omit span and choose d.layout.full/twoUp/threeUp/fourUp/statStrip instead.',
  description: 'Omit description when using the helper panel constructors.',
  sortByField: 'Use columns, rename, or transformations for table presentation; omit sortByField.',
  sortDesc: 'Use columns, rename, or transformations for table presentation; omit sortDesc.',
  unit: 'd.panel.table does not support unit; use fieldConfig={ defaults: { unit: ... } } if a table field needs a unit.',
  decimals:
    'd.panel.table does not support decimals; use fieldConfig={ defaults: { decimals: ... } } if a table field needs decimals.',
};

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
      'Fallback raw Jsonnet writer for dashboard cases that cannot be expressed with write_dashboard_plan. Do not use this for new Prometheus dashboards whose stat, timeseries, or table panels can reference validated query evidence; write_dashboard_plan emits editable dashboard.jsonnet and preflights helper-compatible panels. If raw Jsonnet is required, write dashboard.jsonnet once with the full initial source. If the file already exists, use edit_jsonnet for every follow-up change. For new raw dashboards use the function-based helper API: local d = import "github.com/g42/pi-dashboard/main.libsonnet"; d.dashboard.new(title="...", uid="...", time={ from: "now-6h", to: "now" }, rows=[d.row("Overview", [d.layout.twoUp([...])])]). Valid d.dashboard.new arguments are title, uid, tags, timezone, time, refresh, and rows; do not use timeframe, timeFrom, or timeTo. Valid helper panel calls are d.panel.timeseries/stat(title,datasourceUid,targets,unit,decimals,options,fieldConfig) and d.panel.table(title,datasourceUid,targets,columns,rename,transformations,options,fieldConfig); do not pass span, description, sortByField, or sortDesc.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: `Virtual file path. Defaults to ${DEFAULT_JSONNET_FILE_PATH}.` })),
      content: Type.String({
        description:
          'Complete Jsonnet source that evaluates to a classic Grafana dashboard object. This is a fallback when write_dashboard_plan cannot express the dashboard. For new raw dashboards, prefer importing github.com/g42/pi-dashboard/main.libsonnet for layout/table helpers; do not import Grafonnet unless editing existing Grafonnet source. Prefer d.dashboard.new(title=..., uid=..., time={ from: ..., to: ... }, rows=...), d.row(...), d.layout.full(panel), d.layout.twoUp/threeUp/fourUp/statStrip([...]), d.panel.timeseries/stat/table(...), and d.prom.query(...). Helper panels do not accept span or description; table panels do not accept unit, decimals, sortByField, or sortDesc.',
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
      const content = normalizeDashboardHelperPresentationArgs(normalizeDashboardJsonnetDraft(args.content));
      assertSupportedDashboardHelperDraft(content);
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
      'Apply compact transactional line-range edits to the session virtual Jsonnet file. The edited file must compile. Line numbers are 1-based and inclusive. Use baseVersion from the latest write/edit/read result when available. Prefer read_jsonnet plus expectedText before replacing a block; start at the first line of the block being replaced, not an inner line.',
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
      const existingContent = runtime?.getFile(path)?.content;
      let edits = args.edits;
      if (existingContent) {
        edits = normalizeJsonnetLineEditAnchors(existingContent, args.edits);
        const editedContent = applyLineEdits(existingContent, edits);
        const normalizedContent = normalizeDashboardHelperPresentationArgs(editedContent);
        assertSupportedDashboardHelperDraft(normalizedContent);
        if (normalizedContent !== editedContent) {
          edits = [
            {
              startLine: 1,
              endLine: normalizedJsonnetLines(existingContent).length,
              replacement: normalizedContent,
            },
          ];
        }
      }
      const result = await pluginResourceFetch<JsonnetFileBackendResponse>('/jsonnet-dashboards/jsonnet-files/edit', {
        method: 'POST',
        data: {
          sessionId: requireSessionId(runtime),
          path,
          baseVersion: args.baseVersion,
          edits,
        },
      });
      const content = result.dashboard_jsonnet ?? applyLineEdits(runtime?.getFile(path)?.content ?? '', edits);
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

function normalizeJsonnetLineEditAnchors(content: string, edits: JsonnetLineEdit[]) {
  const lines = normalizedJsonnetLines(content);
  return edits.map((edit) => normalizeJsonnetLineEditAnchor(lines, edit));
}

function normalizeJsonnetLineEditAnchor(lines: string[], edit: JsonnetLineEdit): JsonnetLineEdit {
  if (edit.expectedText || edit.startLine <= 1) {
    return edit;
  }

  const firstReplacementLine = firstStructuralReplacementLine(edit.replacement);
  if (!firstReplacementLine) {
    return edit;
  }

  const startIndex = edit.startLine - 1;
  const lookbackStart = Math.max(0, startIndex - 12);
  const matchingLines: number[] = [];
  for (let index = lookbackStart; index < startIndex; index++) {
    if (lines[index] === firstReplacementLine) {
      matchingLines.push(index + 1);
    }
  }

  if (matchingLines.length !== 1) {
    return edit;
  }

  return {
    ...edit,
    startLine: matchingLines[0],
  };
}

function firstStructuralReplacementLine(replacement: string) {
  const firstLine = replacement
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .find((line) => line.trim().length > 0);
  if (!firstLine || !/\b[A-Za-z_][A-Za-z0-9_]*\.(dashboard|row|layout|panel)\b/.test(firstLine)) {
    return undefined;
  }
  return firstLine;
}

function applyLineEdits(content: string, edits: JsonnetLineEdit[]) {
  const trailingNewline = content.endsWith('\n');
  const normalizedLines = normalizedJsonnetLines(content);
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

function normalizedJsonnetLines(content: string) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '').split('\n');
  return lines.length === 1 && lines[0] === '' ? [] : lines;
}

function normalizeDashboardHelperPresentationArgs(source: string) {
  const binding = dashboardHelperBindingName(source);
  if (!binding) {
    return source;
  }

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const pattern = new RegExp(`${escapeRegExp(binding)}\\.panel\\.table\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf('(', match.index);
    const close = findMatchingJsonnetParen(source, open);
    if (close < 0) {
      continue;
    }
    const body = source.slice(open + 1, close);
    const normalizedBody = normalizeDashboardHelperTablePresentationArgs(body);
    if (normalizedBody !== body) {
      replacements.push({ start: open + 1, end: close, text: normalizedBody });
    }
  }

  return applyStringReplacements(source, replacements);
}

function normalizeDashboardHelperTablePresentationArgs(body: string) {
  const segments = topLevelJsonnetArgumentSegments(body);
  const presentationArgs = segments
    .filter((segment) => segment.name === 'unit' || segment.name === 'decimals')
    .map((segment) => ({
      name: segment.name as 'unit' | 'decimals',
      value: body.slice(segment.valueStart, segment.valueEnd).trim(),
    }));
  if (presentationArgs.length === 0) {
    return body;
  }

  const defaults = presentationArgs.map((arg) => `${arg.name}: ${arg.value}`).join(', ');
  const fieldConfig = segments.find((segment) => segment.name === 'fieldConfig');
  const replacements = presentationArgs.map((arg) => {
    const segment = segments.find((candidate) => candidate.name === arg.name);
    return { start: segment?.start ?? 0, end: segment?.end ?? 0, text: '' };
  });

  if (fieldConfig) {
    const existingValue = body.slice(fieldConfig.valueStart, fieldConfig.valueEnd).trim();
    replacements.push({
      start: fieldConfig.valueStart,
      end: fieldConfig.valueEnd,
      text: `${existingValue} + { defaults+: { ${defaults} } }`,
    });
    return applyStringReplacements(body, replacements);
  }

  return insertJsonnetArgument(
    applyStringReplacements(body, replacements),
    `fieldConfig={ defaults: { ${defaults} } }`
  );
}

function topLevelJsonnetArgumentSegments(source: string) {
  const segments: Array<{ start: number; end: number; name?: string; valueStart: number; valueEnd: number }> = [];
  let segmentStart = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: '"' | "'" | undefined;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;

  for (let index = 0; index < source.length; index++) {
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
    if (char === '(') {
      parenDepth++;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === '[') {
      bracketDepth++;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === '{') {
      braceDepth++;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      segments.push(jsonnetArgumentSegment(source, segmentStart, index + 1));
      segmentStart = index + 1;
    }
  }

  if (segmentStart < source.length) {
    segments.push(jsonnetArgumentSegment(source, segmentStart, source.length));
  }

  return segments;
}

function jsonnetArgumentSegment(source: string, start: number, end: number) {
  const text = source.slice(start, end);
  const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(text);
  if (!match) {
    return { start, end, valueStart: end, valueEnd: end };
  }

  let valueStart = start + match[0].length;
  while (valueStart < end && /[ \t]/.test(source[valueStart])) {
    valueStart++;
  }
  let valueEnd = end;
  if (source[valueEnd - 1] === ',') {
    valueEnd--;
  }
  while (valueEnd > valueStart && /\s/.test(source[valueEnd - 1])) {
    valueEnd--;
  }
  return { start, end, name: match[2], valueStart, valueEnd };
}

function insertJsonnetArgument(body: string, argument: string) {
  const trailingWhitespace = /\s*$/.exec(body)?.[0] ?? '';
  const insertAt = body.length - trailingWhitespace.length;
  const prefix = body.slice(0, insertAt);
  const suffix = body.slice(insertAt);
  if (!body.includes('\n')) {
    return prefix.trim().length > 0 ? `${prefix}, ${argument}${suffix}` : `${argument}${suffix}`;
  }

  const indent = inferJsonnetArgumentIndent(body);
  let nextPrefix = prefix;
  if (nextPrefix.trim().length > 0 && !nextPrefix.trimEnd().endsWith(',')) {
    nextPrefix = `${nextPrefix.trimEnd()},`;
  }
  if (!nextPrefix.endsWith('\n')) {
    nextPrefix = `${nextPrefix}\n`;
  }
  return `${nextPrefix}${indent}${argument},${suffix}`;
}

function inferJsonnetArgumentIndent(body: string) {
  return /\n([ \t]*)[A-Za-z_][A-Za-z0-9_]*\s*=/.exec(body)?.[1] ?? '  ';
}

function applyStringReplacements(source: string, replacements: Array<{ start: number; end: number; text: string }>) {
  let result = source;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.text}${result.slice(replacement.end)}`;
  }
  return result;
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

function assertSupportedDashboardHelperDraft(source: string) {
  const binding = dashboardHelperBindingName(source);
  if (!binding) {
    return;
  }

  const dashboardArgs = topLevelJsonnetNamedArguments(dashboardHelperCallBody(source, binding, ['dashboard', 'new']));
  const forbiddenArg = DASHBOARD_HELPER_FORBIDDEN_DASHBOARD_ARGS.find((arg) => dashboardArgs.has(arg));
  if (forbiddenArg) {
    throw new Error(
      `${binding}.dashboard.new does not support ${forbiddenArg}=. Use time={ from: 'now-6h', to: 'now' } or omit time instead.`
    );
  }

  const unsupportedLayout = unsupportedDashboardHelperLayout(source, binding);
  if (unsupportedLayout) {
    throw new Error(
      `${binding}.layout.${unsupportedLayout} is not available. Use d.layout.full(panel), twoUp([...]), threeUp([...]), fourUp([...]), or statStrip([...]).`
    );
  }

  const fullWithArray = new RegExp(`${escapeRegExp(binding)}\\.layout\\.full\\s*\\(\\s*\\[`).test(source);
  if (fullWithArray) {
    throw new Error(
      `${binding}.layout.full takes one panel object, not an array. Use ${binding}.layout.full(d.panel.timeseries(...)) or ${binding}.layout.twoUp([...]).`
    );
  }

  const unsupportedPanel = unsupportedDashboardHelperPanel(source, binding);
  if (unsupportedPanel) {
    if (unsupportedPanel.arg) {
      const hint =
        DASHBOARD_HELPER_PANEL_ARG_HINTS[unsupportedPanel.arg] ?? 'Use only the documented helper arguments.';
      throw new Error(`${binding}.panel.${unsupportedPanel.panel} does not support ${unsupportedPanel.arg}=. ${hint}`);
    }
    throw new Error(
      `${binding}.panel.${unsupportedPanel.panel} is not available. Use ${binding}.panel.timeseries, ${binding}.panel.stat, or ${binding}.panel.table, or write a raw panel object with explicit gridPos.`
    );
  }
}

function dashboardHelperBindingName(source: string) {
  const match = new RegExp(
    `\\blocal\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*import\\s+['"]${escapeRegExp(DASHBOARD_HELPER_IMPORT)}['"]`
  ).exec(source);
  return match?.[1];
}

function dashboardHelperCallBody(source: string, binding: string, path: string[]) {
  const call = `${binding}.${path.join('.')}`;
  const match = new RegExp(`${escapeRegExp(call)}\\s*\\(`).exec(source);
  if (!match) {
    return '';
  }
  const open = source.indexOf('(', match.index);
  const close = findMatchingJsonnetParen(source, open);
  return close >= 0 ? source.slice(open + 1, close) : source.slice(open + 1);
}

function unsupportedDashboardHelperLayout(source: string, binding: string) {
  const pattern = new RegExp(`${escapeRegExp(binding)}\\.layout\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const layout = match[1];
    if (!DASHBOARD_HELPER_ALLOWED_LAYOUTS.has(layout)) {
      return layout;
    }
  }
  return undefined;
}

function unsupportedDashboardHelperPanel(source: string, binding: string): { panel: string; arg?: string } | undefined {
  const pattern = new RegExp(`${escapeRegExp(binding)}\\.panel\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const panel = match[1];
    const allowedArgs = DASHBOARD_HELPER_PANEL_ALLOWED_ARGS[panel];
    if (!allowedArgs) {
      return { panel };
    }

    const open = source.indexOf('(', match.index);
    const close = findMatchingJsonnetParen(source, open);
    const body = close >= 0 ? source.slice(open + 1, close) : source.slice(open + 1);
    const args = topLevelJsonnetNamedArguments(body);
    for (const arg of args) {
      if (!allowedArgs.has(arg)) {
        return { panel, arg };
      }
    }
  }

  return undefined;
}

function topLevelJsonnetNamedArguments(source: string) {
  const names = new Set<string>();
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: '"' | "'" | undefined;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;

  for (let index = 0; index < source.length; index++) {
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

    if (char === '(') {
      parenDepth++;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === '[') {
      bracketDepth++;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === '{') {
      braceDepth++;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (char === '=' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const name = identifierBefore(source, index);
      if (name) {
        names.add(name);
      }
    }
  }

  return names;
}

function identifierBefore(source: string, index: number) {
  let end = index - 1;
  while (end >= 0 && /\s/.test(source[end])) {
    end--;
  }
  let start = end;
  while (start >= 0 && /[A-Za-z0-9_]/.test(source[start])) {
    start--;
  }
  const name = source.slice(start + 1, end + 1);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : undefined;
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

function findMatchingJsonnetParen(source: string, start: number) {
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
    if (char === '(') {
      depth++;
      continue;
    }
    if (char === ')') {
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
