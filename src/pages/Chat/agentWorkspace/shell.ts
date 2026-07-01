import type {
  CommandName,
  CpOptions,
  FileContent,
  IFileSystem,
  InitialFiles,
  MkdirOptions,
  RmOptions,
} from 'just-bash/browser';
import { truncateText } from '../tools/result';
import type { AgentWorkspaceState } from './types';
import { normalizeVFSPath } from './vfs';

export type AgentWorkspaceBashParams = {
  command: string;
  stdin?: string;
  timeoutMs?: number;
};

export type AgentWorkspaceBashResult = {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  changedFiles: Array<{ path: string; bytes: number; checksum?: string; version?: string }>;
  pendingChanges: unknown[];
};

const DEFAULT_MAX_SHELL_RUNTIME_MS = 5000;
const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 65536;
const DEFAULT_MAX_FILE_BYTES = 262144;

const BASH_COMMANDS: CommandName[] = [
  'echo',
  'cat',
  'printf',
  'ls',
  'pwd',
  'find',
  'grep',
  'fgrep',
  'egrep',
  'rg',
  'sed',
  'awk',
  'sort',
  'uniq',
  'comm',
  'cut',
  'paste',
  'tr',
  'head',
  'tail',
  'wc',
  'nl',
  'fold',
  'expand',
  'unexpand',
  'strings',
  'split',
  'column',
  'join',
  'tee',
  'jq',
  'diff',
  'base64',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'stat',
  'file',
  'mkdir',
  'rmdir',
  'touch',
  'rm',
  'cp',
  'mv',
  'ln',
  'chmod',
  'readlink',
  'basename',
  'dirname',
  'tree',
  'du',
  'env',
  'printenv',
  'xargs',
  'true',
  'false',
  'seq',
  'expr',
  'date',
  'time',
  'which',
  'tac',
  'hostname',
  'whoami',
  'od',
  'help',
];

type ShellFile = {
  path: string;
  content: string;
  version?: string;
  baseVersion?: string;
};

export async function runAgentWorkspaceBash(
  state: AgentWorkspaceState,
  params: AgentWorkspaceBashParams,
  signal?: AbortSignal
): Promise<AgentWorkspaceBashResult> {
  const command = params.command.trim();
  if (!command) {
    throw new Error('bash command is required');
  }

  const { Bash, InMemoryFs, MountableFs } = await import('just-bash/browser');
  const workspaceRoot = normalizeVFSPath(state.snapshot.rootPath || '/workspace');
  const { workspaceFiles, contextFiles, schemaFiles, beforeWorkspaceFiles } = collectShellFiles(state, workspaceRoot);

  const workspaceFs = new InMemoryFs(workspaceFiles);
  const fs = new MountableFs({
    base: new InMemoryFs({
      '/tmp/.keep': '',
    }),
  });
  fs.mount(workspaceRoot, workspaceFs);
  if (Object.keys(contextFiles).length > 0) {
    fs.mount('/context', new ReadOnlyFileSystem(new InMemoryFs(contextFiles), '/context'));
  }
  if (Object.keys(schemaFiles).length > 0) {
    fs.mount('/schemas', new ReadOnlyFileSystem(new InMemoryFs(schemaFiles), '/schemas'));
  }

  const runtimeLimitMs = resolveShellRuntimeMs(state, params.timeoutMs);
  const outputLimit = resolvePositiveLimit(state.manifest.limits?.maxToolOutputBytes, DEFAULT_MAX_TOOL_OUTPUT_BYTES);
  const maxFileBytes = resolvePositiveLimit(state.manifest.limits?.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, runtimeLimitMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const bash = new Bash({
      fs,
      cwd: workspaceRoot,
      commands: BASH_COMMANDS,
      python: false,
      javascript: false,
      executionLimits: {
        maxCommandCount: 2000,
        maxLoopIterations: 2000,
        maxCallDepth: 50,
        maxAwkIterations: 2000,
        maxSedIterations: 2000,
        maxJqIterations: 2000,
        maxStringLength: outputLimit,
        maxHeredocSize: outputLimit,
      },
    });

    const execResult = await bash.exec(command, {
      cwd: workspaceRoot,
      stdin: params.stdin,
      signal: controller.signal,
    });
    const changedFiles = await syncWorkspaceFiles({
      state,
      workspaceFs,
      workspaceRoot,
      beforeWorkspaceFiles,
      maxFileBytes,
    });
    const stdout = limitText(execResult.stdout, outputLimit);
    const stderr = limitText(execResult.stderr, outputLimit);

    return {
      command,
      cwd: workspaceRoot,
      exitCode: timedOut ? 124 : execResult.exitCode,
      stdout: stdout.text,
      stderr: timedOut ? appendLine(stderr.text, `bash timed out after ${runtimeLimitMs}ms`) : stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut,
      changedFiles,
      pendingChanges: state.vfs.pendingChanges(),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function collectShellFiles(state: AgentWorkspaceState, workspaceRoot: string) {
  const workspaceFiles: InitialFiles = {};
  const contextFiles: InitialFiles = {};
  const schemaFiles: InitialFiles = {};
  const beforeWorkspaceFiles = new Map<string, ShellFile>();

  for (const path of state.vfs.find('*')) {
    const file = state.vfs.read(path) as ShellFile;
    if (isWithinRoot(file.path, workspaceRoot)) {
      const relativePath = toMountRelativePath(file.path, workspaceRoot);
      workspaceFiles[relativePath] = file.content;
      beforeWorkspaceFiles.set(file.path, {
        path: file.path,
        content: file.content,
        version: file.version,
        baseVersion: file.baseVersion,
      });
      continue;
    }
    if (isWithinRoot(file.path, '/context')) {
      contextFiles[toMountRelativePath(file.path, '/context')] = file.content;
      continue;
    }
    if (isWithinRoot(file.path, '/schemas')) {
      schemaFiles[toMountRelativePath(file.path, '/schemas')] = file.content;
    }
  }

  return { workspaceFiles, contextFiles, schemaFiles, beforeWorkspaceFiles };
}

async function syncWorkspaceFiles({
  state,
  workspaceFs,
  workspaceRoot,
  beforeWorkspaceFiles,
  maxFileBytes,
}: {
  state: AgentWorkspaceState;
  workspaceFs: IFileSystem;
  workspaceRoot: string;
  beforeWorkspaceFiles: Map<string, ShellFile>;
  maxFileBytes: number;
}) {
  const afterWorkspaceFiles = new Map<string, string>();
  for (const relativePath of workspaceFs.getAllPaths()) {
    const stat = await workspaceFs.stat(relativePath).catch(() => undefined);
    if (!stat?.isFile) {
      continue;
    }
    const content = await workspaceFs.readFile(relativePath);
    if (byteLength(content) > maxFileBytes) {
      throw new Error(
        `bash wrote a file larger than the workspace limit: ${fromMountRelativePath(relativePath, workspaceRoot)}`
      );
    }
    afterWorkspaceFiles.set(fromMountRelativePath(relativePath, workspaceRoot), normalizeLineEndings(content));
  }

  const deletedExistingFiles = [...beforeWorkspaceFiles.keys()].filter((path) => !afterWorkspaceFiles.has(path));
  if (deletedExistingFiles.length > 0) {
    throw new Error(`bash deleted files, which is not supported by this workspace: ${deletedExistingFiles.join(', ')}`);
  }

  const changedFiles: AgentWorkspaceBashResult['changedFiles'] = [];
  for (const [path, content] of afterWorkspaceFiles) {
    const before = beforeWorkspaceFiles.get(path);
    if (before?.content === content) {
      continue;
    }
    state.vfs.applyOverlayFile({
      path,
      baseVersion: before?.baseVersion ?? before?.version,
      content,
    });
    const updated = state.vfs.read(path);
    changedFiles.push({
      path,
      bytes: byteLength(content),
      checksum: updated.checksum,
      version: updated.version,
    });
  }

  return changedFiles.sort((left, right) => left.path.localeCompare(right.path));
}

function resolveShellRuntimeMs(state: AgentWorkspaceState, requestedMs?: number) {
  const maxRuntimeMs = resolvePositiveLimit(state.manifest.limits?.maxShellRuntimeMs, DEFAULT_MAX_SHELL_RUNTIME_MS);
  if (!requestedMs || requestedMs <= 0) {
    return maxRuntimeMs;
  }
  return Math.min(Math.floor(requestedMs), maxRuntimeMs);
}

function resolvePositiveLimit(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function limitText(text: string, maxLength: number) {
  const limited = truncateText(text, maxLength);
  return {
    text: limited,
    truncated: limited !== text,
  };
}

function appendLine(text: string, line: string) {
  return text ? `${text.replace(/\n?$/, '\n')}${line}\n` : `${line}\n`;
}

function isWithinRoot(path: string, root: string) {
  const normalizedPath = normalizeVFSPath(path);
  const normalizedRoot = normalizeVFSPath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function toMountRelativePath(path: string, mountPoint: string) {
  const normalizedPath = normalizeVFSPath(path);
  const normalizedMount = normalizeVFSPath(mountPoint);
  if (normalizedPath === normalizedMount) {
    return '/';
  }
  return normalizedPath.slice(normalizedMount.length) || '/';
}

function fromMountRelativePath(path: string, mountPoint: string) {
  const normalizedPath = normalizeVFSPath(path);
  const normalizedMount = normalizeVFSPath(mountPoint);
  return normalizedPath === '/' ? normalizedMount : `${normalizedMount}${normalizedPath}`;
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

class ReadOnlyFileSystem implements IFileSystem {
  constructor(
    private readonly inner: IFileSystem,
    private readonly label: string
  ) {}

  readFile(path: string, options?: Parameters<IFileSystem['readFile']>[1]) {
    return this.inner.readFile(path, options);
  }

  readFileBuffer(path: string) {
    return this.inner.readFileBuffer(path);
  }

  exists(path: string) {
    return this.inner.exists(path);
  }

  stat(path: string) {
    return this.inner.stat(path);
  }

  readdir(path: string) {
    return this.inner.readdir(path);
  }

  resolvePath(base: string, path: string) {
    return this.inner.resolvePath(base, path);
  }

  getAllPaths() {
    return this.inner.getAllPaths();
  }

  readlink(path: string) {
    return this.inner.readlink(path);
  }

  lstat(path: string) {
    return this.inner.lstat(path);
  }

  realpath(path: string) {
    return this.inner.realpath(path);
  }

  writeFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem['writeFile']>[2]): Promise<void> {
    return Promise.reject(readOnlyError(this.label, path));
  }

  appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem['appendFile']>[2]): Promise<void> {
    return Promise.reject(readOnlyError(this.label, path));
  }

  mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    return Promise.reject(readOnlyError(this.label, path));
  }

  rm(path: string, _options?: RmOptions): Promise<void> {
    return Promise.reject(readOnlyError(this.label, path));
  }

  cp(_src: string, dest: string, _options?: CpOptions): Promise<void> {
    return Promise.reject(readOnlyError(this.label, dest));
  }

  mv(_src: string, dest: string): Promise<void> {
    return Promise.reject(readOnlyError(this.label, dest));
  }

  chmod(path: string, _mode: number): Promise<void> {
    return Promise.reject(readOnlyError(this.label, path));
  }

  symlink(_target: string, linkPath: string): Promise<void> {
    return Promise.reject(readOnlyError(this.label, linkPath));
  }

  link(_existingPath: string, newPath: string): Promise<void> {
    return Promise.reject(readOnlyError(this.label, newPath));
  }

  utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    return Promise.reject(readOnlyError(this.label, path));
  }
}

function readOnlyError(label: string, path: string) {
  return new Error(`${label} is read-only: ${path}`);
}
