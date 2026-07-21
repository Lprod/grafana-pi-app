jest.mock('@grafana/runtime', () => ({
  getAppEvents: jest.fn(),
}));

import { getAppEvents } from '@grafana/runtime';
import { publishAgentWorkspaceSaved } from './events';

describe('publishAgentWorkspaceSaved', () => {
  it('publishes the provider workspace identity and save result', () => {
    const publish = jest.fn();
    jest.mocked(getAppEvents).mockReturnValue({ publish } as never);

    publishAgentWorkspaceSaved(
      {
        contractVersion: '1',
        sourcePluginId: 'debeka-cloud-portal-app',
        workspaceKind: 'resource-workspace',
        workspaceRef: { org: 'axon', repo: 'axon_infra', application: 'Axon', substage: 'PROD' },
        capabilitiesPath: '/agent/capabilities',
      },
      {
        status: 'valid',
        savedVersion: 'draft:portal/admin/example:abc123',
        changedFiles: [{ path: 'applications/Axon/PROD/rbac.yml' }],
      }
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      type: 'agent-workspace-saved',
      payload: {
        sourcePluginId: 'debeka-cloud-portal-app',
        workspaceKind: 'resource-workspace',
        workspaceRef: { org: 'axon', repo: 'axon_infra', application: 'Axon', substage: 'PROD' },
        savedVersion: 'draft:portal/admin/example:abc123',
        changedFiles: [{ path: 'applications/Axon/PROD/rbac.yml' }],
      },
    });
  });
});
