import { structuredPatch } from 'diff';
import type {
  AgentWorkspaceOverlayFile,
  AgentWorkspaceOverlayPayload,
  AgentWorkspaceSchemaContent,
  AgentWorkspaceSnapshot,
  AgentWorkspaceSnapshotFile,
} from './types';

const DIFF_CONTEXT_LINES = 3;

export type AgentWorkspaceVFSFile = AgentWorkspaceSnapshotFile & {
  layer: 'base' | 'overlay' | 'context' | 'schema';
  baseVersion?: string;
};

export type AgentWorkspaceEdit = {
  startLine: number;
  endLine: number;
  replacement: string;
  expectedText?: string;
};

export type AgentWorkspaceMutationResult = {
  file: AgentWorkspaceVFSFile;
  changedRanges: Array<{ startLine: number; endLine: number; newLines: number }>;
  firstChangedLine?: number;
  diff: string;
};

export class AgentWorkspaceVFS {
  private readonly base = new Map<string, AgentWorkspaceVFSFile>();
  private readonly overlay = new Map<string, AgentWorkspaceVFSFile>();
  private readonly context = new Map<string, AgentWorkspaceVFSFile>();
  private readonly schemas = new Map<string, AgentWorkspaceVFSFile>();
  private overlayVersion = 0;

  constructor(private readonly snapshot: AgentWorkspaceSnapshot) {
    for (const file of snapshot.files ?? []) {
      this.base.set(normalizeVFSPath(file.path), toVFSFile(file, 'base'));
    }
    for (const file of snapshot.contextFiles ?? []) {
      this.context.set(normalizeVFSPath(file.path), toVFSFile({ ...file, readOnly: true }, 'context'));
    }
  }

  workspaceRoot() {
    return normalizeVFSPath(this.snapshot.rootPath || '/workspace');
  }

  read(path: string) {
    const normalized = normalizeVFSPath(path);
    const file =
      this.overlay.get(normalized) ??
      this.base.get(normalized) ??
      this.context.get(normalized) ??
      this.schemas.get(normalized);
    if (!file) {
      throw new Error(`File not found: ${normalized}`);
    }
    return file;
  }

  list(dir = this.workspaceRoot()) {
    const normalized = normalizeDirectoryPath(dir);
    const entries = new Map<string, { name: string; path: string; type: 'file' | 'directory'; layer: string }>();

    for (const file of this.allFiles()) {
      if (!file.path.startsWith(normalized)) {
        continue;
      }
      const rest = file.path.slice(normalized.length).replace(/^\/+/, '');
      if (!rest) {
        continue;
      }
      const [name] = rest.split('/');
      const entryPath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;
      entries.set(name, {
        name,
        path: entryPath,
        type: rest.includes('/') ? 'directory' : 'file',
        layer: file.layer,
      });
    }

    return [...entries.values()].sort((left, right) =>
      left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : 1
    );
  }

  find(pattern = '*') {
    const regex = globToRegExp(pattern.trim() || '*');
    return this.allFiles()
      .map((file) => file.path)
      .filter((path) => regex.test(path))
      .sort();
  }

  grep(pattern: string, options: { path?: string; caseSensitive?: boolean } = {}) {
    if (!pattern) {
      throw new Error('grep pattern is required');
    }

    const flags = options.caseSensitive ? 'g' : 'gi';
    const regex = new RegExp(escapeRegExp(pattern), flags);
    const prefix = options.path ? normalizeVFSPath(options.path) : undefined;
    const matches: Array<{ path: string; line: number; text: string }> = [];

    for (const file of this.allFiles()) {
      if (prefix && file.path !== prefix && !file.path.startsWith(`${prefix}/`)) {
        continue;
      }
      splitLines(file.content).forEach((line, index) => {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          matches.push({ path: file.path, line: index + 1, text: line });
        }
      });
    }

    return matches;
  }

  readLines(path: string, offset?: number, limit?: number) {
    const file = this.read(path);
    const lines = splitLines(file.content);
    const start = Math.max(0, (offset && offset > 0 ? offset : 1) - 1);
    const boundedLimit = Math.min(Math.max(limit ?? 200, 1), 200);
    const end = Math.min(lines.length, start + boundedLimit);
    return {
      file,
      totalLines: lines.length,
      lines: lines.slice(start, end).map((text, index) => ({ line: start + index + 1, text })),
    };
  }

  edit(path: string, edits: AgentWorkspaceEdit[], baseVersion?: string): AgentWorkspaceMutationResult {
    if (edits.length === 0) {
      throw new Error('edits must contain at least one replacement');
    }

    const file = this.assertWritableFile(path);
    this.assertBaseVersion(file, baseVersion);

    const oldLines = splitLines(file.content);
    const trailingNewline = file.content.endsWith('\n');
    const normalizedEdits = normalizeEdits(edits, oldLines);
    const newLines = [...oldLines];
    for (const edit of normalizedEdits) {
      newLines.splice(edit.start, edit.end - edit.start, ...edit.replacement);
    }

    const newContent = joinLines(newLines, trailingNewline);
    if (newContent === file.content) {
      throw new Error('edits produced no changes');
    }

    const overlayFile = this.setOverlay(file.path, newContent, file.language, file.version);
    const changedRanges = normalizedEdits
      .map((edit) => ({
        startLine: edit.start + 1,
        endLine: edit.end,
        newLines: edit.replacement.length,
      }))
      .sort((left, right) => left.startLine - right.startLine);

    return {
      file: overlayFile,
      changedRanges,
      firstChangedLine: firstChangedLine(oldLines, newLines),
      diff: renderDiff(file.path, oldLines, newLines),
    };
  }

  write(path: string, content: string, baseVersion?: string): AgentWorkspaceMutationResult {
    const normalizedPath = normalizeVFSPath(path);
    if (!isWithinRoot(normalizedPath, this.workspaceRoot())) {
      throw new Error(`Path is not writable in this workspace: ${normalizedPath}`);
    }

    const existing = this.overlay.get(normalizedPath) ?? this.base.get(normalizedPath);
    if (existing) {
      if (existing.readOnly) {
        throw new Error(`File is read-only: ${normalizedPath}`);
      }
      this.assertBaseVersion(existing, baseVersion);
    }

    const oldContent = existing?.content ?? '';
    const oldLines = splitLines(oldContent);
    const newContent = normalizeLineEndings(content);
    const newLines = splitLines(newContent);
    if (oldContent === newContent) {
      throw new Error('write produced no changes');
    }

    const overlayFile = this.setOverlay(normalizedPath, newContent, existing?.language, existing?.version);
    return {
      file: overlayFile,
      changedRanges: [
        {
          startLine: 1,
          endLine: oldLines.length,
          newLines: newLines.length,
        },
      ],
      firstChangedLine: firstChangedLine(oldLines, newLines),
      diff: renderDiff(normalizedPath, oldLines, newLines),
    };
  }

  overlayPayload(): AgentWorkspaceOverlayPayload {
    return {
      baseVersion: this.snapshot.baseVersion,
      files: [...this.overlay.values()]
        .filter((file) => isWithinRoot(file.path, this.workspaceRoot()))
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((file) => ({
          path: file.path,
          baseVersion: file.baseVersion,
          content: file.content,
          checksum: file.checksum,
        })),
    };
  }

  applyOverlayFile(file: AgentWorkspaceOverlayFile) {
    const base = this.base.get(normalizeVFSPath(file.path));
    this.setOverlay(file.path, file.content, base?.language, file.baseVersion ?? base?.version, file.checksum);
  }

  mountSchemaFile(file: AgentWorkspaceSchemaContent) {
    this.schemas.set(normalizeVFSPath(file.path), toVFSFile({ ...file, readOnly: true }, 'schema'));
  }

  pendingChanges() {
    return this.overlayPayload().files.map((file) => {
      const base = this.base.get(normalizeVFSPath(file.path));
      return {
        path: file.path,
        baseVersion: file.baseVersion,
        checksum: file.checksum,
        previousBytes: byteLength(base?.content ?? ''),
        currentBytes: byteLength(file.content),
      };
    });
  }

  commitOverlay(baseVersion?: string) {
    for (const file of this.overlay.values()) {
      this.base.set(file.path, {
        ...file,
        layer: 'base',
        version: file.checksum ?? file.version,
        baseVersion: undefined,
      });
    }
    this.overlay.clear();
    if (baseVersion) {
      this.snapshot.baseVersion = baseVersion;
    }
  }

  private allFiles() {
    const files = new Map<string, AgentWorkspaceVFSFile>();
    for (const file of [...this.base.values(), ...this.context.values(), ...this.schemas.values()]) {
      files.set(file.path, file);
    }
    for (const file of this.overlay.values()) {
      files.set(file.path, file);
    }
    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  private assertWritableFile(path: string) {
    const file = this.read(path);
    if (!isWithinRoot(file.path, this.workspaceRoot())) {
      throw new Error(`Path is not writable in this workspace: ${file.path}`);
    }
    if (file.readOnly) {
      throw new Error(`File is read-only: ${file.path}`);
    }
    return file;
  }

  private assertBaseVersion(file: AgentWorkspaceVFSFile, baseVersion?: string) {
    if (baseVersion && baseVersion !== file.version && baseVersion !== file.baseVersion) {
      throw new Error(
        `Version conflict for ${file.path}: current version is ${file.version}, request used ${baseVersion}`
      );
    }
  }

  private setOverlay(path: string, content: string, language?: string, baseVersion?: string, checksum?: string) {
    this.overlayVersion += 1;
    const normalizedContent = normalizeLineEndings(content);
    const file: AgentWorkspaceVFSFile = {
      path: normalizeVFSPath(path),
      content: normalizedContent,
      language,
      readOnly: false,
      checksum: checksum ?? checksumText(normalizedContent),
      version: `overlay:${this.overlayVersion}`,
      baseVersion,
      layer: 'overlay',
    };
    this.overlay.set(file.path, file);
    return file;
  }
}

export function normalizeVFSPath(path: string) {
  const trimmed = path.trim().replace(/\\/g, '/');
  if (!trimmed) {
    throw new Error('path is required');
  }

  const absolute = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      throw new Error(`path must not contain '..': ${path}`);
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function toVFSFile(file: AgentWorkspaceSnapshotFile, layer: AgentWorkspaceVFSFile['layer']): AgentWorkspaceVFSFile {
  const content = normalizeLineEndings(file.content);
  return {
    ...file,
    path: normalizeVFSPath(file.path),
    content,
    checksum: file.checksum ?? checksumText(content),
    version: file.version ?? file.checksum ?? checksumText(content),
    readOnly: Boolean(file.readOnly),
    layer,
  };
}

function normalizeDirectoryPath(path: string) {
  const normalized = normalizeVFSPath(path);
  return normalized === '/' ? normalized : normalized.replace(/\/$/, '');
}

function isWithinRoot(path: string, root: string) {
  const normalizedRoot = normalizeDirectoryPath(root);
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

function splitLines(content: string) {
  const normalized = normalizeLineEndings(content);
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed ? trimmed.split('\n') : [];
}

function joinLines(lines: string[], trailingNewline: boolean) {
  const joined = lines.join('\n');
  return trailingNewline && joined ? `${joined}\n` : joined;
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeEdits(edits: AgentWorkspaceEdit[], lines: string[]) {
  const normalized = edits.map((edit, index) => {
    if (edit.startLine < 1) {
      throw new Error(`edits[${index}].startLine must be at least 1`);
    }
    const endLine = edit.endLine === 0 ? edit.startLine - 1 : edit.endLine;
    if (endLine < edit.startLine - 1) {
      throw new Error(`edits[${index}].endLine must be greater than or equal to startLine - 1`);
    }
    if (edit.startLine > lines.length + 1) {
      throw new Error(`edits[${index}].startLine is out of range`);
    }
    if (endLine > lines.length) {
      throw new Error(`edits[${index}].endLine is out of range`);
    }
    if (edit.expectedText !== undefined) {
      const actual = lines.slice(edit.startLine - 1, endLine).join('\n');
      if (normalizeLineEndings(edit.expectedText) !== actual) {
        throw new Error(`edits[${index}].expectedText did not match lines ${edit.startLine}-${endLine}`);
      }
    }

    return {
      originalIndex: index,
      start: edit.startLine - 1,
      end: endLine,
      replacement: replacementLines(edit.replacement),
    };
  });

  normalized.sort((left, right) => {
    if (left.start === right.start) {
      return right.end - left.end;
    }
    return right.start - left.start;
  });

  for (let index = 1; index < normalized.length; index += 1) {
    const later = normalized[index - 1];
    const earlier = normalized[index];
    if (earlier.end > later.start) {
      throw new Error(`edits[${earlier.originalIndex}] and edits[${later.originalIndex}] overlap`);
    }
  }

  return normalized;
}

function replacementLines(replacement: string) {
  const normalized = normalizeLineEndings(replacement).replace(/\n$/, '');
  return normalized ? normalized.split('\n') : [];
}

function renderDiff(path: string, oldLines: string[], newLines: string[]) {
  const patch = structuredPatch(path, path, linesToDiffText(oldLines), linesToDiffText(newLines), '', '', {
    context: DIFF_CONTEXT_LINES,
  });

  return [
    `--- ${path}`,
    `+++ ${path}`,
    ...patch.hunks.flatMap((hunk) => [
      `@@ -${formatDiffRange(hunk.oldStart, hunk.oldLines)} +${formatDiffRange(hunk.newStart, hunk.newLines)} @@`,
      ...hunk.lines,
    ]),
  ].join('\n');
}

function linesToDiffText(lines: string[]) {
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function formatDiffRange(start: number, lines: number) {
  return lines === 1 ? String(start) : `${start},${lines}`;
}

function firstChangedLine(oldLines: string[], newLines: string[]) {
  const limit = Math.min(oldLines.length, newLines.length);
  for (let index = 0; index < limit; index += 1) {
    if (oldLines[index] !== newLines[index]) {
      return index + 1;
    }
  }
  return oldLines.length === newLines.length ? undefined : limit + 1;
}

function globToRegExp(pattern: string) {
  const normalized = pattern.startsWith('/') ? pattern : `*${pattern}*`;
  const escaped = normalized.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${escaped}$`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checksumText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}
