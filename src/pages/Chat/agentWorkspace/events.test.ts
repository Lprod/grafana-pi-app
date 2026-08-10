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
        sourcePluginId: 'cloud-portal-app',
        workspaceKind: 'resource-workspace',
        workspaceRef: { org: 'foo', repo: 'foo_infra', application: 'foo', substage: 'PROD' },
        capabilitiesPath: '/agent/capabilities',
      },
      {
        status: 'valid',
        savedVersion: 'draft:portal/admin/example:abc123',
        changedFiles: [{ path: 'applications/foo/PROD/rbac.yml' }],
      }
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      type: 'agent-workspace-saved',
      payload: {
        sourcePluginId: 'cloud-portal-app',
        workspaceKind: 'resource-workspace',
        workspaceRef: { org: 'foo', repo: 'foo_infra', application: 'foo', substage: 'PROD' },
        savedVersion: 'draft:portal/admin/example:abc123',
        changedFiles: [{ path: 'applications/foo/PROD/rbac.yml' }],
      },
    });
  });
});
