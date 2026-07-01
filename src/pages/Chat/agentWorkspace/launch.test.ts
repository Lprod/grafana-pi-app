import {
  agentWorkspaceLaunchFromSearch,
  renderAgentWorkspaceContextBlock,
  renderAgentWorkspaceSystemPrompt,
} from './launch';
import type { AgentWorkspaceState } from './types';

describe('agent workspace launch', () => {
  it('enables the sample workspace bash prompt for PI benchmark launches', () => {
    const launch = agentWorkspaceLaunchFromSearch('?orgId=1&agentSample=vm-memory&piAgentBenchmark=1');

    expect(launch).toMatchObject({
      sourcePluginId: 'g42-pi-app',
      workspaceKind: 'sample-resource-workspace',
      capabilitiesPath: '/agent/capabilities',
    });
    expect(launch?.initialPrompt).toContain('bash');
    expect(launch?.initialPrompt).toContain('/workspace');
  });

  it('renders available workspace tools including optional bash', () => {
    const state = sampleState();

    expect(renderAgentWorkspaceSystemPrompt(state)).toContain(
      'Available workspace tools: read, edit, bash, upsert_resource'
    );
    expect(renderAgentWorkspaceContextBlock(state)).toContain('"optionalTools"');
    expect(renderAgentWorkspaceContextBlock(state)).toContain('"bash"');
  });
});

function sampleState(): AgentWorkspaceState {
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
      supportedTools: ['read', 'edit'],
      optionalTools: ['bash'],
      semanticTools: [
        {
          name: 'upsert_resource',
          description: 'Upsert resource',
          parameters: {},
          execution: { path: '/agent/workspaces/{workspaceId}/tools/upsert-resource' },
          effect: 'overlayMutation',
        },
      ],
    },
    snapshot: {
      workspaceId: 'sample_wks_1',
      workspaceKind: 'sample-resource-workspace',
      displayName: 'Sample VM workspace',
      baseVersion: 'sample-main:abc123',
      rootPath: '/workspace',
      files: [],
      contextFiles: [],
      schemas: [],
    },
    vfs: {} as AgentWorkspaceState['vfs'],
  };
}
