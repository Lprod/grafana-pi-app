import {
  agentWorkspaceLaunchFromSearch,
  encodeAgentWorkspaceLaunchParam,
  parseAgentWorkspaceLaunchPayload,
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

  it('parses a generic provider launch from a URL parameter', () => {
    const encoded = encodeAgentWorkspaceLaunchParam({
      contractVersion: '1',
      sourcePluginId: 'example-provider-app',
      workspaceKind: 'resource-workspace',
      workspaceRef: {
        repository: 'platform/services',
        path: 'applications/shop/prod',
        resourceId: 'vm/web-01',
      },
      intent: 'edit-resource',
      initialPrompt: 'Increase memory for web-01.',
      capabilitiesPath: '/agent/capabilities',
      returnPath: '/a/example-provider-app/resources',
    });

    expect(agentWorkspaceLaunchFromSearch(`?agentWorkspaceLaunch=${encoded}`)).toMatchObject({
      sourcePluginId: 'example-provider-app',
      workspaceKind: 'resource-workspace',
      workspaceRef: {
        resourceId: 'vm/web-01',
      },
      capabilitiesPath: '/agent/capabilities',
    });
  });

  it('rejects malformed generic launch payloads', () => {
    expect(parseAgentWorkspaceLaunchPayload({ contractVersion: '2' })).toBeUndefined();
    expect(agentWorkspaceLaunchFromSearch('?agentWorkspaceLaunch=not-json')).toBeUndefined();
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
