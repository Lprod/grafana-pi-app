import { AgentWorkspaceVFS } from './vfs';
import type { AgentWorkspaceSnapshot } from './types';

describe('AgentWorkspaceVFS', () => {
  it('applies expected line edits and exposes overlay payload', () => {
    const vfs = new AgentWorkspaceVFS(sampleSnapshot());

    const result = vfs.edit('/workspace/platform/shop/prod/virtual-machines.json', [
      {
        startLine: 6,
        endLine: 6,
        expectedText: '      "memoryMiB": 4096',
        replacement: '      "memoryMiB": 8192',
      },
    ]);

    expect(result.diff).toContain('"memoryMiB": 4096');
    expect(result.diff).toContain('"memoryMiB": 8192');
    expect(result.diff).toContain('@@ -3,7 +3,7 @@');
    expect(result.diff).not.toContain('-{');
    expect(result.diff).not.toContain('+{');
    expect(vfs.read('/workspace/platform/shop/prod/virtual-machines.json').content).toContain('"memoryMiB": 8192');
    expect(vfs.overlayPayload()).toMatchObject({
      baseVersion: 'main:abc123',
      files: [
        {
          path: '/workspace/platform/shop/prod/virtual-machines.json',
          baseVersion: 'blob:abc123',
        },
      ],
    });
  });

  it('rejects stale expected text', () => {
    const vfs = new AgentWorkspaceVFS(sampleSnapshot());

    expect(() =>
      vfs.edit('/workspace/platform/shop/prod/virtual-machines.json', [
        {
          startLine: 6,
          endLine: 6,
          expectedText: '      "memoryMiB": 2048',
          replacement: '      "memoryMiB": 8192',
        },
      ])
    ).toThrow(/expectedText/);
  });

  it('prevents writes outside the workspace root', () => {
    const vfs = new AgentWorkspaceVFS(sampleSnapshot());

    expect(() => vfs.write('/context/resource.json', '{}\n')).toThrow(/not writable/);
  });
});

function sampleSnapshot(): AgentWorkspaceSnapshot {
  return {
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
    contextFiles: [
      {
        path: '/context/resource.json',
        content: '{}\n',
        readOnly: true,
      },
    ],
    schemas: [],
  };
}
