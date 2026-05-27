const mockDataSourceSrv = {
  getList: jest.fn(),
  get: jest.fn(),
  getInstanceSettings: jest.fn(),
};

jest.mock('@grafana/runtime', () => ({
  config: {
    bootData: {
      user: {
        orgId: 1,
        timezone: 'browser',
      },
    },
  },
  getBackendSrv: jest.fn(),
  getDataSourceSrv: () => mockDataSourceSrv,
}));

jest.mock('typebox', () => ({
  Type: {
    Boolean: jest.fn((config) => config ?? {}),
    Literal: jest.fn((value, config) => ({ ...config, const: value })),
    Number: jest.fn((config) => config ?? {}),
    Object: jest.fn((properties) => ({ properties })),
    Optional: jest.fn((schema) => schema),
    String: jest.fn((config) => config ?? {}),
    Union: jest.fn((items, config) => ({ ...config, items })),
  },
}));

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DataSourceInstanceSettings } from '@grafana/data';
import {
  createGrafanaTools,
  filterAllowedPrometheusDatasourceSettings,
  getDisallowedDashboardDatasourceUids,
} from './grafanaTools';

const datasourceSettings = [
  { name: 'Prometheus A', uid: 'prom-a', type: 'prometheus', isDefault: true },
  { name: 'Prometheus B', uid: 'prom-b', type: 'prometheus', isDefault: false },
  { name: 'Loki', uid: 'loki', type: 'loki', isDefault: false },
] as unknown as DataSourceInstanceSettings[];

describe('grafana datasource tool policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDataSourceSrv.getList.mockReturnValue(datasourceSettings);
  });

  it('keeps all visible Prometheus datasources when no allow-list is configured', () => {
    expect(filterAllowedPrometheusDatasourceSettings(datasourceSettings)).toEqual([
      datasourceSettings[0],
      datasourceSettings[1],
    ]);
  });

  it('filters datasource discovery to configured UIDs', async () => {
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-b'] }), 'grafana_get_datasources');

    const result = await tool.execute('call-1', {}, undefined);

    expect(JSON.parse(result.content[0].text)).toEqual([
      {
        name: 'Prometheus B',
        uid: 'prom-b',
        type: 'prometheus',
        isDefault: false,
      },
    ]);
  });

  it('uses the first allowed datasource when the tool call omits a UID', async () => {
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      getResource: jest.fn().mockResolvedValue({ data: ['up'] }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-b'] }), 'list_metrics');

    const result = await tool.execute('call-1', {}, undefined);

    expect(mockDataSourceSrv.get).toHaveBeenCalledWith({ uid: 'prom-b', type: 'prometheus' });
    expect(result.details.datasourceUid).toBe('prom-b');
  });

  it('rejects an explicit datasource UID outside the allow-list', async () => {
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-b'] }), 'list_metrics');

    await expect(tool.execute('call-1', { datasourceUid: 'prom-a' }, undefined)).rejects.toThrow(
      'Datasource is not available to the assistant: prom-a'
    );
    expect(mockDataSourceSrv.get).not.toHaveBeenCalled();
  });

  it('rejects uploaded dashboards that reference disallowed datasource UIDs', async () => {
    const dashboard = {
      title: 'Bad dashboard',
      panels: [
        {
          datasource: { type: 'prometheus', uid: 'prom-a' },
          targets: [{ datasource: { type: 'prometheus', uid: 'prom-b' } }],
        },
        {
          datasource: { type: '__expr__', uid: '__expr__' },
        },
      ],
    };
    const uploadTool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-a'] }), 'grafana_upload_dashboard');

    expect(getDisallowedDashboardDatasourceUids(dashboard, { allowedDatasourceUids: ['prom-a'] })).toEqual(['prom-b']);
    await expect(uploadTool.execute('call-1', { dashboard_json: JSON.stringify(dashboard) }, undefined)).rejects.toThrow(
      'Dashboard references datasource UIDs not available to the assistant: prom-b'
    );
  });
});

function getTool(tools: AgentTool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }

  return tool as Omit<AgentTool, 'execute'> & {
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
  };
}

type ToolResult = {
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
};
