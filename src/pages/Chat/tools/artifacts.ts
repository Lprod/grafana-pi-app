import type { AfterToolCallResult, AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

type JqModule = typeof import('jq-wasm');

export type ArtifactKind = 'json' | 'table' | 'dashboard' | 'image' | 'text';

export type ArtifactRef = {
  id: string;
  kind: ArtifactKind;
  title: string;
  toolName: string;
  createdAt: string;
  bytes: number;
  summary: string;
};

export type ArtifactPreview =
  | {
      type: 'json';
      data: unknown;
      truncated: boolean;
    }
  | {
      type: 'text';
      text: string;
      truncated: boolean;
    }
  | {
      type: 'image';
      mimeType: string;
      data: string;
    };

export type Artifact = ArtifactRef & {
  data: unknown;
  preview?: ArtifactPreview;
  mimeType?: string;
  toolDetails?: unknown;
};

export type RegisterArtifactInput = {
  kind: ArtifactKind;
  title: string;
  toolName: string;
  data: unknown;
  summary: string;
  bytes?: number;
  preview?: ArtifactPreview;
  mimeType?: string;
  toolDetails?: unknown;
};

export type ArtifactRuntime = {
  register: (artifact: RegisterArtifactInput) => Artifact;
  get: (id: string) => Artifact | undefined;
  list: () => Artifact[];
};

type ReadArtifactParams = {
  id?: string;
  mode?: 'summary' | 'preview' | 'field' | 'slice' | 'jq' | 'full';
  path?: string;
  offset?: number;
  limit?: number;
  jq?: string;
};

type ToolImageBlock = {
  type: 'image';
  mimeType: string;
  data: string;
};

const ARTIFACT_MIN_BYTES = 6000;
const ARTIFACT_READ_TEXT_LIMIT = 80000;
const ARTIFACT_PREVIEW_TEXT_LIMIT = 6000;
const ARTIFACT_HANDLE_PREVIEW_TEXT_LIMIT = 2400;
const ARTIFACT_PREVIEW_STRING_FIELD_LIMIT = 1200;
const ARTIFACT_DEFAULT_SLICE_LIMIT = 50;
const ARTIFACT_MAX_SLICE_LIMIT = 500;
const JQ_OUTPUT_LIMIT = 80000;

const ARTIFACT_TOOL_NAMES = new Set([
  'query_prometheus',
  'query_prometheus_raw',
  'query_rqlite',
  'list_managed_dashboards',
  'get_dashboard',
  'grafana_get_dashboard',
  'inspect_dashboard_context',
  'get_dashboard_source',
  'grafana_get_managed_dashboard_source',
  'render_dashboard',
  'grafana_render_managed_dashboard',
  'screenshot_dashboard',
  'grafana_screenshot',
]);

const ALWAYS_ARTIFACT_TOOL_NAMES = new Set([
  'query_prometheus_raw',
  'get_dashboard',
  'grafana_get_dashboard',
  'inspect_dashboard_context',
  'get_dashboard_source',
  'grafana_get_managed_dashboard_source',
  'render_dashboard',
  'grafana_render_managed_dashboard',
  'screenshot_dashboard',
  'grafana_screenshot',
]);

let jqModulePromise: Promise<JqModule> | undefined;

export function createArtifactTools(artifacts?: ArtifactRuntime): AgentTool[] {
  if (!artifacts) {
    return [];
  }

  return [
    {
      name: 'read_artifact',
      label: 'Read artifact',
      description:
        'Read a stored bulky tool artifact by id. Prefer field, slice, or jq mode instead of full when inspecting large JSON.',
      executionMode: 'sequential',
      parameters: Type.Object({
        id: Type.String({ description: 'Artifact id, such as artifact_1.' }),
        mode: Type.Optional(
          Type.Union(
            [
              Type.Literal('summary'),
              Type.Literal('preview'),
              Type.Literal('field'),
              Type.Literal('slice'),
              Type.Literal('jq'),
              Type.Literal('full'),
            ],
            {
              description:
                'Read mode. Defaults to jq when jq is provided, field when path is provided, otherwise preview.',
            }
          )
        ),
        path: Type.Optional(
          Type.String({
            description:
              'Optional JSON path for field or slice mode, for example dashboard.panels, results.0.series, or $.data.items.',
          })
        ),
        offset: Type.Optional(Type.Number({ description: 'Zero-based offset for slice mode. Defaults to 0.' })),
        limit: Type.Optional(
          Type.Number({
            description: `Maximum items or lines for slice mode. Defaults to ${ARTIFACT_DEFAULT_SLICE_LIMIT}.`,
          })
        ),
        jq: Type.Optional(
          Type.String({ description: 'jq filter to run in jq mode, for example .results[] | .query.' })
        ),
      }),
      async execute(_toolCallId, params, signal) {
        throwIfAborted(signal);
        return readArtifact(artifacts, params as ReadArtifactParams, signal);
      },
    },
  ];
}

export async function readArtifact(
  artifacts: ArtifactRuntime,
  params: ReadArtifactParams,
  signal?: AbortSignal
): Promise<AgentToolResult<Record<string, unknown>>> {
  const id = params.id?.trim();
  if (!id) {
    throw new Error('read_artifact requires id.');
  }

  const artifact = artifacts.get(id);
  if (!artifact) {
    const available = artifacts.list().map((item) => item.id);
    throw new Error(
      available.length > 0
        ? `Unknown artifact id ${id}. Available artifacts: ${available.join(', ')}.`
        : `Unknown artifact id ${id}. No artifacts are stored in this session.`
    );
  }

  const mode = params.mode ?? (params.jq ? 'jq' : params.path ? 'field' : 'preview');
  const selected = params.path ? selectArtifactPath(artifact.data, params.path) : artifact.data;
  const artifactRef = toArtifactRef(artifact);

  if (mode === 'summary') {
    return artifactReadResult(JSON.stringify(artifactSummary(artifact), null, 2), {
      artifactRead: true,
      artifactRef,
      mode,
    });
  }

  if (mode === 'preview') {
    return artifactReadResult(formatArtifactPreview(artifact), {
      artifactRead: true,
      artifactRef,
      mode,
      truncated: artifact.preview ? previewIsTruncated(artifact.preview) : false,
    });
  }

  if (mode === 'jq') {
    if (!params.jq?.trim()) {
      throw new Error('read_artifact jq mode requires jq.');
    }
    throwIfAborted(signal);
    const jq = await loadJq();
    throwIfAborted(signal);
    const result = await jq.raw(toJqInput(selected), params.jq, ['-c']);
    const stdout = truncateText(result.stdout.trim(), JQ_OUTPUT_LIMIT);
    const stderr = truncateText(result.stderr.trim(), 4000);
    return artifactReadResult(
      [stdout || '(jq returned no output)', stderr ? `stderr:\n${stderr}` : ''].filter(Boolean).join('\n\n'),
      {
        artifactRead: true,
        artifactRef,
        mode,
        path: params.path,
        jq: params.jq,
        exitCode: result.exitCode,
        stderr: result.stderr || undefined,
        truncated: result.stdout.length > stdout.length,
      }
    );
  }

  const value =
    mode === 'slice'
      ? sliceArtifactValue(selected, params.offset, params.limit)
      : mode === 'field'
        ? selected
        : artifact.data;
  const text = formatArtifactValue(value);

  return artifactReadResult(truncateText(text, ARTIFACT_READ_TEXT_LIMIT), {
    artifactRead: true,
    artifactRef,
    mode,
    path: params.path,
    offset: mode === 'slice' ? clampInteger(params.offset ?? 0, 0, Number.MAX_SAFE_INTEGER) : undefined,
    limit:
      mode === 'slice'
        ? clampInteger(params.limit ?? ARTIFACT_DEFAULT_SLICE_LIMIT, 1, ARTIFACT_MAX_SLICE_LIMIT)
        : undefined,
    truncated: text.length > ARTIFACT_READ_TEXT_LIMIT,
  });
}

export function artifactizeToolResult(
  artifacts: ArtifactRuntime | undefined,
  toolName: string | undefined,
  result: AgentToolResult<any>
): AfterToolCallResult | undefined {
  if (!artifacts || !toolName || toolName === 'read_artifact' || !ARTIFACT_TOOL_NAMES.has(toolName)) {
    return undefined;
  }
  if (hasArtifactRef(result.details)) {
    return undefined;
  }

  const extraction = extractArtifactData(toolName, result);
  if (!extraction) {
    return undefined;
  }

  if (!ALWAYS_ARTIFACT_TOOL_NAMES.has(toolName) && extraction.bytes < ARTIFACT_MIN_BYTES) {
    return undefined;
  }

  const artifact = artifacts.register({
    kind: extraction.kind,
    title: extraction.title,
    toolName,
    data: extraction.data,
    summary: extraction.summary,
    bytes: extraction.bytes,
    preview: extraction.preview,
    mimeType: extraction.mimeType,
    toolDetails: result.details,
  });
  const artifactRef = toArtifactRef(artifact);
  const details = mergeArtifactDetails(result.details, artifactRef, artifact.preview);

  return {
    content: [{ type: 'text', text: artifactHandleText(artifactRef, artifact.preview) }],
    details,
  };
}

export function toArtifactRef(artifact: Artifact): ArtifactRef {
  const { id, kind, title, toolName, createdAt, bytes, summary } = artifact;
  return { id, kind, title, toolName, createdAt, bytes, summary };
}

export function artifactByteSize(value: unknown): number {
  return utf8ByteLength(formatArtifactValue(value));
}

function artifactReadResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function extractArtifactData(
  toolName: string,
  result: AgentToolResult<any>
):
  | {
      kind: ArtifactKind;
      title: string;
      data: unknown;
      summary: string;
      bytes: number;
      preview?: ArtifactPreview;
      mimeType?: string;
    }
  | undefined {
  const image = firstImageBlock(result.content);
  if (image) {
    const data = {
      image: {
        mimeType: image.mimeType,
        data: image.data,
      },
      details: result.details,
    };
    return {
      kind: 'image',
      title: artifactTitle(toolName, result.details),
      data,
      summary: artifactSummaryLine(toolName, data, result.details),
      bytes: utf8ByteLength(image.data),
      preview: { type: 'image', mimeType: image.mimeType, data: image.data },
      mimeType: image.mimeType,
    };
  }

  const text = getSingleTextContent(result.content);
  if (text === undefined) {
    return undefined;
  }

  const parsed = parseJson(text);
  const data = parsed.ok ? parsed.value : text;
  const kind = artifactKind(toolName, data, result.details);
  const bytes = utf8ByteLength(text);

  return {
    kind,
    title: artifactTitle(toolName, result.details, data),
    data,
    summary: artifactSummaryLine(toolName, data, result.details),
    bytes,
    preview: makePreview(data, bytes),
  };
}

function artifactKind(toolName: string, data: unknown, details: unknown): ArtifactKind {
  if (
    toolName === 'get_dashboard' ||
    toolName === 'grafana_get_dashboard' ||
    toolName === 'inspect_dashboard_context' ||
    toolName === 'render_dashboard' ||
    toolName === 'grafana_render_managed_dashboard'
  ) {
    return 'dashboard';
  }
  if (toolName === 'query_rqlite') {
    return 'table';
  }
  if (toolName === 'list_managed_dashboards') {
    return 'dashboard';
  }
  if (isRecord(details) && details.format === 'table') {
    return 'table';
  }
  return typeof data === 'string' ? 'text' : 'json';
}

function artifactTitle(toolName: string, details: unknown, data?: unknown) {
  const detailsRecord = isRecord(details) ? details : undefined;
  const dataRecord = isRecord(data) ? data : undefined;
  const dashboard = recordField(dataRecord, 'dashboard') ?? dataRecord;
  const title =
    stringField(detailsRecord, 'title') ??
    stringField(dashboard, 'title') ??
    stringField(dataRecord, 'title') ??
    stringField(dataRecord, 'uid') ??
    stringField(detailsRecord, 'uid');

  return title ? `${toolName}: ${title}` : toolName;
}

function artifactSummaryLine(toolName: string, data: unknown, details: unknown) {
  if (toolName === 'query_prometheus' && isRecord(data)) {
    const query = stringField(data, 'query');
    const queryCount = numberField(data, 'queryCount');
    if (queryCount !== undefined) {
      return `${queryCount} Prometheus queries summarized.`;
    }
    if (query) {
      return `Prometheus query summary for ${query}.`;
    }
  }

  if (toolName === 'query_rqlite' && isRecord(details)) {
    const rows = numberField(details, 'rows');
    return rows === undefined ? 'rqlite query result.' : `rqlite query result with ${rows} rows.`;
  }

  const dashboard = isRecord(data) ? (recordField(data, 'dashboard') ?? data) : undefined;
  const panels = dashboard ? recordsField(dashboard, 'panels').length : undefined;
  const title = stringField(dashboard, 'title');
  if (title) {
    return `${title}${panels !== undefined ? ` with ${panels} panels` : ''}.`;
  }

  if (Array.isArray(data)) {
    return `${toolName} returned ${data.length} items.`;
  }

  return `${toolName} result stored as artifact.`;
}

function makePreview(data: unknown, bytes: number): ArtifactPreview {
  if (typeof data === 'string') {
    return {
      type: 'text',
      text: truncateText(data, ARTIFACT_PREVIEW_TEXT_LIMIT),
      truncated: data.length > ARTIFACT_PREVIEW_TEXT_LIMIT || bytes > ARTIFACT_PREVIEW_TEXT_LIMIT,
    };
  }

  return {
    type: 'json',
    data: previewJsonValue(data),
    truncated: bytes > ARTIFACT_PREVIEW_TEXT_LIMIT,
  };
}

function previewJsonValue(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.slice(0, 20).map(previewJsonValue);
  }
  if (typeof data === 'string') {
    return truncateText(data, ARTIFACT_PREVIEW_STRING_FIELD_LIMIT);
  }
  if (!isRecord(data)) {
    return data;
  }
  if (Array.isArray(data.results)) {
    return {
      ...Object.fromEntries(
        Object.entries(data)
          .filter(([key]) => key !== 'results')
          .slice(0, 10)
      ),
      results: data.results.slice(0, 10).map(previewQueryResult),
    };
  }

  const entries = Object.entries(data).slice(0, 20);
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      Array.isArray(value) || typeof value === 'string' || isRecord(value) ? previewJsonValue(value) : value,
    ])
  );
}

function previewQueryResult(value: unknown) {
  if (!isRecord(value)) {
    return value;
  }

  const series = Array.isArray(value.series)
    ? value.series.slice(0, 3).map((item) => {
        if (!isRecord(item)) {
          return item;
        }
        return {
          name: item.name,
          labels: item.labels,
          points: item.points,
          nonNullPoints: item.nonNullPoints,
          nullPoints: item.nullPoints,
          last: item.last,
          min: item.min,
          max: item.max,
          mean: item.mean,
          delta: item.delta,
          deltaPercent: item.deltaPercent,
        };
      })
    : undefined;

  return {
    datasourceUid: value.datasourceUid,
    query: value.query,
    queryType: value.queryType,
    interval: value.interval,
    range: value.range,
    frameCount: value.frameCount,
    validationError: value.validationError,
    totalSeries: value.totalSeries,
    truncatedSeries: value.truncatedSeries,
    notices: Array.isArray(value.notices) ? value.notices.slice(0, 3) : value.notices,
    executedQueryStrings: Array.isArray(value.executedQueryStrings)
      ? value.executedQueryStrings.slice(0, 3)
      : value.executedQueryStrings,
    series,
  };
}

function artifactHandleText(artifact: ArtifactRef, preview: ArtifactPreview | undefined) {
  const lines = [
    `Stored artifact [artifact: ${artifact.id}] ${artifact.title}`,
    `Kind: ${artifact.kind}`,
    `Size: ${artifact.bytes} bytes`,
    `Summary: ${artifact.summary}`,
    `Use read_artifact with id "${artifact.id}" to inspect preview, fields, slices, or jq queries.`,
  ];
  const previewText = artifactHandlePreview(preview);
  if (previewText) {
    lines.push('Inline preview:', previewText);
  }
  return lines.join('\n');
}

function artifactHandlePreview(preview: ArtifactPreview | undefined) {
  if (!preview || preview.type === 'image') {
    return undefined;
  }

  const text =
    preview.type === 'text'
      ? preview.text
      : (() => {
          try {
            return JSON.stringify(preview.data, null, 2);
          } catch {
            return String(preview.data);
          }
        })();

  const truncated = truncateText(text, ARTIFACT_HANDLE_PREVIEW_TEXT_LIMIT);
  return preview.truncated || text.length > ARTIFACT_HANDLE_PREVIEW_TEXT_LIMIT
    ? `${truncated}\nPreview truncated; use read_artifact for more.`
    : truncated;
}

function mergeArtifactDetails(details: unknown, artifactRef: ArtifactRef, preview: ArtifactPreview | undefined) {
  const base = isRecord(details) ? details : details === undefined ? {} : { value: details };
  return {
    ...base,
    artifactRef,
    artifactPreview: preview,
  };
}

function artifactSummary(artifact: Artifact) {
  return {
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    toolName: artifact.toolName,
    createdAt: artifact.createdAt,
    bytes: artifact.bytes,
    summary: artifact.summary,
  };
}

function formatArtifactPreview(artifact: Artifact) {
  if (!artifact.preview) {
    return JSON.stringify(artifactSummary(artifact), null, 2);
  }

  if (artifact.preview.type === 'image') {
    return JSON.stringify(
      {
        ...artifactSummary(artifact),
        preview: {
          type: 'image',
          mimeType: artifact.preview.mimeType,
          dataBytes: utf8ByteLength(artifact.preview.data),
        },
      },
      null,
      2
    );
  }

  if (artifact.preview.type === 'text') {
    return artifact.preview.text;
  }

  return JSON.stringify(artifact.preview.data, null, 2);
}

function previewIsTruncated(preview: ArtifactPreview) {
  return preview.type !== 'image' && preview.truncated;
}

function sliceArtifactValue(value: unknown, rawOffset: number | undefined, rawLimit: number | undefined) {
  const offset = clampInteger(rawOffset ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInteger(rawLimit ?? ARTIFACT_DEFAULT_SLICE_LIMIT, 1, ARTIFACT_MAX_SLICE_LIMIT);

  if (Array.isArray(value)) {
    return value.slice(offset, offset + limit);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .slice(offset, offset + limit)
      .join('\n');
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(offset, offset + limit));
  }
  return value;
}

function selectArtifactPath(value: unknown, path: string): unknown {
  let current = value;
  const parts = parsePath(path);
  for (const part of parts) {
    if (typeof part === 'number') {
      current = Array.isArray(current) ? current[part] : undefined;
    } else {
      current = isRecord(current) ? current[part] : undefined;
    }
  }
  return current;
}

function parsePath(path: string): Array<string | number> {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '$') {
    return [];
  }

  const normalized = trimmed.replace(/^\$\.?/, '').replace(/^\./, '');
  const parts: Array<string | number> = [];
  const pattern = /([^.[\]]+)|\[(\d+|"[^"]+"|'[^']+')\]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(normalized))) {
    const bare = match[1];
    const bracket = match[2];
    if (bare !== undefined) {
      parts.push(/^\d+$/.test(bare) ? Number(bare) : bare);
      continue;
    }
    if (bracket === undefined) {
      continue;
    }
    if (/^\d+$/.test(bracket)) {
      parts.push(Number(bracket));
    } else {
      parts.push(bracket.slice(1, -1));
    }
  }

  return parts;
}

function formatArtifactValue(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function getSingleTextContent(content: AgentToolResult<any>['content']): string | undefined {
  if (content.length !== 1) {
    return undefined;
  }

  const block = content[0];
  return block.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

function firstImageBlock(content: AgentToolResult<any>['content']): ToolImageBlock | undefined {
  return content.find(isToolImageBlock);
}

function isToolImageBlock(block: AgentToolResult<any>['content'][number]): block is ToolImageBlock {
  return (
    isRecord(block) && block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
  );
}

function hasArtifactRef(details: unknown) {
  return isRecord(details) && isRecord(details.artifactRef) && typeof details.artifactRef.id === 'string';
}

function toJqInput(value: unknown): string | object {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === 'object') {
    return value;
  }
  return String(value);
}

async function loadJq() {
  jqModulePromise ??= import('jq-wasm');
  return jqModulePromise;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('Tool call aborted');
  }
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n... (truncated)` : value;
}

function utf8ByteLength(value: string) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength;
  }

  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

function recordField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return record && isRecord(record[key]) ? record[key] : undefined;
}

function recordsField(record: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
