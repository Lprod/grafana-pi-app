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
  isFetchError: (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && 'data' in error),
  getDataSourceSrv: () => mockDataSourceSrv,
}));

jest.mock('typebox', () => ({
  Type: {
    Array: jest.fn((items, config) => ({ ...config, items })),
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
import type { DataFrame, DataSourceInstanceSettings } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { of, throwError } from 'rxjs';
import {
  createGrafanaToolRegistry,
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

  it('inspects metric series labels through the selected datasource', async () => {
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      getResource: jest.fn().mockResolvedValue({
        data: [
          { __name__: 'http_requests_total', job: 'web', route: '/', status: '200' },
          { __name__: 'http_requests_total', job: 'web', route: '/', status: '500' },
        ],
      }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-b'] }), 'inspect_metric_series');

    const result = await tool.execute('call-1', { match: 'http_requests_total', limit: 1 }, undefined);
    const body = JSON.parse(result.content[0].text);

    expect(dataSource.getResource).toHaveBeenCalledWith('api/v1/series', { 'match[]': 'http_requests_total' });
    expect(body.labelNames).toEqual(['job', 'route', 'status']);
    expect(body.examples).toHaveLength(1);
    expect(body.truncated).toBe(true);
    expect(result.details.datasourceUid).toBe('prom-b');
  });

  it('derives range query interval instead of accepting a caller-selected coarse step', async () => {
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      query: jest.fn().mockResolvedValue({ state: 'Done', data: [] }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-b'] }), 'query_prometheus');

    const result = await tool.execute('call-1', { query: 'up', type: 'range', start: 'now-6h', end: 'now', step: '30m' }, undefined);
    const request = dataSource.query.mock.calls[0][0];

    expect(request.interval).toBe('30s');
    expect(request.intervalMs).toBe(30000);
    expect(request.maxDataPoints).toBe(1200);
    expect(result.details.interval).toBe('30s');
  });

  it('summarizes range query frames instead of returning raw point arrays', async () => {
    const frame = makePrometheusFrame({
      displayName: 'http_requests_total{route="/render/report",vm="vm-web-01"}',
      labels: { route: '/render/report', vm: 'vm-web-01' },
      times: Array.from({ length: 10 }, (_, index) => Date.UTC(2026, 0, 1, 0, 0, index * 30)),
      values: [1, 2, null, 10, 5, 7, 6, 9, 8, 4],
    });
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      query: jest.fn().mockResolvedValue({ state: 'Done', data: [frame] }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-b'] }), 'query_prometheus');

    const result = await tool.execute('call-1', { query: 'http_requests_total', type: 'range', start: 'now-6h', end: 'now' }, undefined);
    const body = JSON.parse(result.content[0].text);

    expect(result.details).toMatchObject({ summarized: true, frames: 1, series: 1 });
    expect(result.content[0].text).not.toContain('"values"');
    expect(body).toMatchObject({
      datasourceUid: 'prom-b',
      query: 'http_requests_total',
      queryType: 'range',
      interval: '30s',
      frameCount: 1,
      totalSeries: 1,
      truncatedSeries: false,
      notices: [{ severity: 'info', text: 'demo notice' }],
      executedQueryStrings: ['Expr: http_requests_total\nStep: 30s'],
    });
    expect(body.series[0]).toMatchObject({
      name: 'http_requests_total{route="/render/report",vm="vm-web-01"}',
      labels: { route: '/render/report', vm: 'vm-web-01' },
      points: 10,
      nonNullPoints: 9,
      nullPoints: 1,
      first: { time: '2026-01-01T00:00:00.000Z', value: 1 },
      last: { time: '2026-01-01T00:04:30.000Z', value: 4 },
      min: { value: 1 },
      max: { value: 10 },
      mean: 5.777778,
      delta: 3,
      deltaPercent: 300,
      sampled: true,
    });
    expect(body.series[0].samples).toHaveLength(8);
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
        {
          datasource: { type: 'prometheus', uid: '$datasource' },
        },
      ],
    };
    const uploadTool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-a'], includeAdHocDashboardTools: true }), 'grafana_upload_dashboard');

    expect(getDisallowedDashboardDatasourceUids(dashboard, { allowedDatasourceUids: ['prom-a'] })).toEqual(['$datasource', 'prom-b']);
    await expect(uploadTool.execute('call-1', { dashboard_json: JSON.stringify(dashboard) }, undefined)).rejects.toThrow(
      'Dashboard references datasource UIDs not available to the assistant: $datasource, prom-b'
    );
  });

  it('sends Jsonnet source to the managed dashboard sync endpoint', async () => {
    const fetch = jest.fn().mockReturnValue(
      of({
        data: {
          uid: 'direct-jsonnet',
          url: '/d/direct-jsonnet',
          status: 'created',
          sourceChecksum: 'sha256:test',
        },
      })
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-a'] }), 'grafana_sync_managed_dashboard');
    const source = "{ title: 'Direct Jsonnet', uid: 'direct-jsonnet', panels: [] }";

    const result = await tool.execute('call-1', { dashboard_jsonnet: source }, undefined);

    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/plugins/elohmeier-grafanapiapp-app/resources/managed-dashboards/sync',
        method: 'POST',
        data: { dashboard_jsonnet: source },
        showErrorAlert: false,
      })
    );
    expect(result.content[0].text).toContain('Managed dashboard created');
  });

  it('surfaces managed dashboard sync backend errors as readable messages', async () => {
    const fetch = jest.fn().mockReturnValue(
      throwError(() => ({
        status: 400,
        statusText: 'Bad Request',
        data: {
          error: 'jsonnet compilation failed: dashboard.jsonnet:3:5-14 Did not expect: (IDENTIFIER, "textPanel")',
        },
        config: {
          method: 'POST',
          url: '/api/plugins/elohmeier-grafanapiapp-app/resources/managed-dashboards/sync',
        },
      }))
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-a'] }), 'grafana_sync_managed_dashboard');

    await expect(tool.execute('call-1', { dashboard_jsonnet: 'let textPanel() = {}' }, undefined)).rejects.toThrow(
      'Grafana request failed (400 Bad Request) while calling POST /api/plugins/elohmeier-grafanapiapp-app/resources/managed-dashboards/sync: jsonnet compilation failed: dashboard.jsonnet:3:5-14 Did not expect: (IDENTIFIER, "textPanel")'
    );
  });

  it('adds subagent tools only when a chat runtime is supplied', () => {
    expect(createGrafanaToolRegistry().subagents).toEqual([]);

    const registry = createGrafanaToolRegistry({
      runtime: {
        model: {} as any,
        streamFn: jest.fn() as any,
      },
    });

    expect(registry.subagents.map((tool) => tool.name)).toEqual(['grafana_explore_metrics', 'grafana_explore_jsonnet']);
    expect(registry.all.slice(0, 2).map((tool) => tool.name)).toEqual(['grafana_explore_metrics', 'grafana_explore_jsonnet']);
  });

  it('keeps raw dashboard writes and direct Jsonnet library browsing out of the default chat toolset', () => {
    const registry = createGrafanaToolRegistry({
      runtime: {
        model: {} as any,
        streamFn: jest.fn() as any,
      },
    });

    const names = registry.all.map((tool) => tool.name);
    expect(names).toContain('query_prometheus');
    expect(names).toContain('grafana_sync_managed_dashboard');
    expect(names).toContain('grafana_get_managed_dashboard_source');
    expect(names).toContain('grafana_screenshot');
    expect(names).not.toContain('query_prometheus_raw');
    expect(names).not.toContain('grafana_upload_dashboard');
    expect(names).not.toContain('grafana_delete_dashboard');
    expect(names).not.toContain('grafana_list_managed_dashboard_templates');
    expect(names).not.toContain('read_managed_dashboard_template');
    expect(names).not.toContain('search_jsonnet_libs');
    expect(names).not.toContain('read_jsonnet_lib');
    expect(names).not.toContain('list_jsonnet_libs');
  });

  it('can explicitly expose advanced dashboard and Jsonnet tools for tests or developer workflows', () => {
    const names = createGrafanaTools({
      includeAdHocDashboardTools: true,
      includeJsonnetLibraryTools: true,
      includeRawPrometheusQueryTool: true,
    }).map((tool) => tool.name);

    expect(names).toContain('query_prometheus_raw');
    expect(names).toContain('grafana_upload_dashboard');
    expect(names).toContain('grafana_delete_dashboard');
    expect(names).toContain('grafana_get_managed_dashboard_source');
    expect(names).toContain('search_jsonnet_libs');
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

function makePrometheusFrame(options: {
  displayName: string;
  labels: Record<string, string>;
  times: number[];
  values: Array<number | null>;
}): DataFrame {
  return {
    name: 'A',
    length: options.values.length,
    fields: [
      {
        name: 'Time',
        type: 'time',
        values: options.times,
        config: {},
      },
      {
        name: 'Value',
        type: 'number',
        labels: options.labels,
        values: options.values,
        config: {
          displayNameFromDS: options.displayName,
        },
      },
    ],
    meta: {
      notices: [{ severity: 'info', text: 'demo notice' }],
      executedQueryString: 'Expr: http_requests_total\nStep: 30s',
    },
  } as unknown as DataFrame;
}

type ToolResult = {
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
};
