jest.mock('typebox', () => ({
  Type: {
    Array: jest.fn((items, config) => ({ ...config, items })),
    Boolean: jest.fn((config) => config ?? {}),
    Number: jest.fn((config) => config ?? {}),
    Object: jest.fn((properties) => ({ properties })),
    Optional: jest.fn((schema) => schema),
    String: jest.fn((config) => config ?? {}),
  },
}));

jest.mock('./providerClient', () => ({
  executeAgentWorkspaceSemanticTool: jest.fn(),
  fetchAgentWorkspaceSchema: jest.fn(),
  previewAgentWorkspace: jest.fn(),
  saveAgentWorkspace: jest.fn(),
  validateAgentWorkspace: jest.fn(),
}));

jest.mock('./shell', () => ({
  runAgentWorkspaceBash: jest.fn(),
}));

jest.mock('./events', () => ({
  publishAgentWorkspaceSaved: jest.fn(),
}));

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { AgentWorkspaceVFS } from './vfs';
import { createAgentWorkspaceTools } from './tools';
import type { AgentWorkspaceRuntime, AgentWorkspaceState } from './types';
import { runAgentWorkspaceBash } from './shell';
import { publishAgentWorkspaceSaved } from './events';
import { saveAgentWorkspace } from './providerClient';

describe('agent workspace tools', () => {
  it('edits through the browser VFS and reports pending changes', async () => {
    const state = sampleState();
    const runtime: AgentWorkspaceRuntime = {
      getState: () => state,
      setState: jest.fn(),
    };
    const tools = createAgentWorkspaceTools(runtime).all;
    const edit = getTool(tools, 'edit');

    const result = await edit.execute(
      'call-1',
      {
        path: '/workspace/platform/shop/prod/virtual-machines.json',
        baseVersion: 'blob:abc123',
        edits: [
          {
            startLine: 6,
            endLine: 6,
            expectedText: '      "memoryMiB": 4096',
            replacement: '      "memoryMiB": 8192',
          },
        ],
      },
      undefined
    );

    expect(textContent(result)).toContain('memoryMiB');
    expect(String(result.details?.diff)).toContain('"memoryMiB": 8192');
    expect(result.details).toMatchObject({
      path: '/workspace/platform/shop/prod/virtual-machines.json',
      pendingChanges: [
        {
          path: '/workspace/platform/shop/prod/virtual-machines.json',
          baseVersion: 'blob:abc123',
        },
      ],
    });
  });

  it('registers and runs bash only when the workspace advertises the optional tool', async () => {
    const state = sampleState();
    state.kind.optionalTools = ['bash'];
    const runtime: AgentWorkspaceRuntime = {
      getState: () => state,
      setState: jest.fn(),
    };
    const bashResult = {
      command: 'jq . /workspace/platform/shop/prod/virtual-machines.json',
      cwd: '/workspace',
      exitCode: 0,
      stdout: '{}\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      changedFiles: [],
      pendingChanges: [],
    };
    jest.mocked(runAgentWorkspaceBash).mockResolvedValueOnce(bashResult);

    const tools = createAgentWorkspaceTools(runtime).all;
    const bash = getTool(tools, 'bash');
    const result = await bash.execute('call-2', { command: bashResult.command }, undefined);

    expect(runAgentWorkspaceBash).toHaveBeenCalledWith(state, { command: bashResult.command }, undefined);
    expect(result.details).toEqual(bashResult);
  });

  it('does not register bash for workspaces that do not advertise it', () => {
    const state = sampleState();
    const runtime: AgentWorkspaceRuntime = {
      getState: () => state,
      setState: jest.fn(),
    };

    expect(createAgentWorkspaceTools(runtime).all.some((tool) => tool.name === 'bash')).toBe(false);
  });

  it('publishes a workspace-saved event after a successful provider save', async () => {
    const state = sampleState();
    const runtime: AgentWorkspaceRuntime = {
      getState: () => state,
      setState: jest.fn(),
    };
    const saveResult = {
      status: 'valid',
      savedVersion: 'draft:portal/user/example:abc123',
      changedFiles: [{ path: 'platform/shop/prod/virtual-machines.json' }],
    };
    jest.mocked(saveAgentWorkspace).mockResolvedValueOnce(saveResult);

    const save = getTool(createAgentWorkspaceTools(runtime).all, 'save_changes');
    await save.execute('call-save', {}, undefined);

    expect(publishAgentWorkspaceSaved).toHaveBeenCalledWith(state.launch, saveResult);
  });
});

function sampleState(): AgentWorkspaceState {
  const snapshot = {
    workspaceId: 'wks_1',
    workspaceKind: 'sample-resource-workspace',
    displayName: 'Sample',
    baseVersion: 'main:abc123',
    rootPath: '/workspace',
    files: [
      {
        path: '/workspace/platform/shop/prod/virtual-machines.json',
        version: 'blob:abc123',
        language: 'json',
        content: [
          '{',
          '  "resources": {',
          '    "web-01": {',
          '      "kind": "VirtualMachine",',
          '      "cpu": 2,',
          '      "memoryMiB": 4096',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    contextFiles: [],
    schemas: [],
  };

  return {
    launch: {
      contractVersion: '1',
      sourcePluginId: 'grafana-assistant-app',
      workspaceKind: 'sample-resource-workspace',
      capabilitiesPath: '/agent/capabilities',
    },
    manifest: {
      contractVersion: '1',
      provider: { pluginId: 'grafana-assistant-app' },
      workspaceKinds: [],
    },
    kind: {
      kind: 'sample-resource-workspace',
      snapshotPath: '/agent/workspaces',
    },
    snapshot,
    vfs: new AgentWorkspaceVFS(snapshot),
  };
}

function getTool(tools: AgentTool[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool;
}

function textContent(result: AgentToolResult<Record<string, unknown>>) {
  const block = result.content[0];
  return block.type === 'text' ? (block.text ?? '') : '';
}
