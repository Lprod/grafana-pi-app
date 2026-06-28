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
  locationService: {
    push: jest.fn(),
  },
}));

jest.mock('typebox', () => ({
  Type: {
    Array: jest.fn((items, config) => ({ ...config, items })),
    Any: jest.fn((config) => config ?? {}),
    Boolean: jest.fn((config) => config ?? {}),
    Literal: jest.fn((value, config) => ({ ...config, const: value })),
    Number: jest.fn((config) => config ?? {}),
    Object: jest.fn((properties) => ({ properties })),
    Optional: jest.fn((schema) => schema),
    String: jest.fn((config) => config ?? {}),
    Union: jest.fn((items, config) => ({ ...config, items })),
  },
}));

jest.mock('./tools/subagentRunner', () => ({
  runSpecialistAgent: jest.fn(async (options) => ({
    content: [{ type: 'text', text: 'mock subagent' }],
    details: {
      type: 'subagent',
      agent: options.kind,
      status: 'completed',
      task: options.task,
      toolNames: options.tools.map((tool: AgentTool) => tool.name),
      toolCalls: [],
      usage: {
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
      },
      finalOutput: 'mock subagent',
    },
  })),
}));

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DataFrame, DataSourceInstanceSettings } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { of, throwError } from 'rxjs';
import {
  createGrafanaToolRegistry,
  createGrafanaSupervisorTools,
  createGrafanaTools,
  createGrafanaToolsForSkillGroups,
  createSkillTools,
  buildNavigationPath,
  filterAllowedPrometheusDatasourceSettings,
  getUnavailableDashboardDatasourceUids,
  type VirtualJsonnetFileSnapshot,
} from './grafanaTools';
import { GRAFANA_SKILLS } from './skills';
import { runSpecialistAgent } from './tools/subagentRunner';

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
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'list_datasources');

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
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'list_metrics');

    const result = await tool.execute('call-1', {}, undefined);

    expect(mockDataSourceSrv.get).toHaveBeenCalledWith({ uid: 'prom-b', type: 'prometheus' });
    expect(result.details.datasourceUid).toBe('prom-b');
  });

  it('lists multiple metric prefixes with one Prometheus metadata request', async () => {
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      getResource: jest.fn().mockResolvedValue({
        data: ['http_requests_total', 'node_cpu_seconds_total', 'node_load1', 'process_cpu_seconds_total'],
      }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'list_metrics');

    const result = await tool.execute('call-1', { prefixes: ['http', 'node_'] }, undefined);
    const body = JSON.parse(result.content[0].text);

    expect(dataSource.getResource).toHaveBeenCalledTimes(1);
    expect(body.results).toEqual([
      {
        prefix: 'http',
        count: 1,
        truncated: false,
        metrics: ['http_requests_total'],
      },
      {
        prefix: 'node_',
        count: 2,
        truncated: false,
        metrics: ['node_cpu_seconds_total', 'node_load1'],
      },
    ]);
    expect(result.details).toMatchObject({ datasourceUid: 'prom-b', batch: true, prefixes: ['http', 'node_'] });
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
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'inspect_metric_series');

    const result = await tool.execute('call-1', { match: 'http_requests_total', limit: 1 }, undefined);
    const body = JSON.parse(result.content[0].text);

    expect(dataSource.getResource).toHaveBeenCalledWith('api/v1/series', { 'match[]': 'http_requests_total' });
    expect(body.labelNames).toEqual(['job', 'route', 'status']);
    expect(body.examples).toHaveLength(1);
    expect(body.truncated).toBe(true);
    expect(result.details.datasourceUid).toBe('prom-b');
  });

  it('inspects multiple metric series selectors in one tool call', async () => {
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      getResource: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            { __name__: 'http_requests_total', route: '/', status: '200', vm: 'vm-web-01' },
            { __name__: 'http_requests_total', route: '/', status: '500', vm: 'vm-web-01' },
          ],
        })
        .mockResolvedValueOnce({
          data: [{ __name__: 'node_load1', instance: 'vm-web-01:9100', vm: 'vm-web-01' }],
        }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'inspect_metric_series');

    const result = await tool.execute(
      'call-1',
      { matches: ['http_requests_total', 'node_load1'], limit: 1 },
      undefined
    );
    const body = JSON.parse(result.content[0].text);

    expect(dataSource.getResource).toHaveBeenCalledWith('api/v1/series', { 'match[]': 'http_requests_total' });
    expect(dataSource.getResource).toHaveBeenCalledWith('api/v1/series', { 'match[]': 'node_load1' });
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      match: 'http_requests_total',
      labelNames: ['route', 'status', 'vm'],
      totalSeries: 2,
      truncated: true,
    });
    expect(body.results[1]).toMatchObject({
      match: 'node_load1',
      labelNames: ['instance', 'vm'],
      totalSeries: 1,
      truncated: false,
    });
    expect(result.details).toMatchObject({ datasourceUid: 'prom-b', batch: true, matches: 2, totalSeries: 3 });
  });

  it('derives range query interval instead of accepting a caller-selected coarse step', async () => {
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      query: jest.fn().mockResolvedValue({ state: 'Done', data: [] }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'query_prometheus');

    const result = await tool.execute(
      'call-1',
      { query: 'up', type: 'range', start: 'now-6h', end: 'now', step: '30m' },
      undefined
    );
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
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'query_prometheus');

    const result = await tool.execute(
      'call-1',
      { query: 'http_requests_total', type: 'range', start: 'now-6h', end: 'now' },
      undefined
    );
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
      last: { time: '2026-01-01T00:04:30.000Z', value: 4 },
      min: { value: 1 },
      max: { value: 10 },
      mean: 5.777778,
      delta: 3,
      deltaPercent: 300,
    });
    expect(body.series[0]).not.toHaveProperty('samples');
  });

  it('validates multiple PromQL expressions in one query_prometheus call', async () => {
    const frame = makePrometheusFrame({
      displayName: 'value',
      labels: {},
      times: [Date.UTC(2026, 0, 1, 0, 0, 0)],
      values: [1],
    });
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      query: jest.fn().mockResolvedValue({ state: 'Done', data: [frame] }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'query_prometheus');

    const result = await tool.execute(
      'call-1',
      {
        queries: [
          { query: 'sum(rate(http_requests_total[5m]))' },
          { query: 'sum(rate(http_requests_total{status=~"5.."}[5m]))' },
        ],
      },
      undefined
    );
    const body = JSON.parse(result.content[0].text);

    expect(dataSource.query).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({ batch: true, queries: 2, summarized: true });
    expect(body).toMatchObject({
      datasourceUid: 'prom-b',
      queryCount: 2,
      truncatedQueries: false,
      results: [
        { query: 'sum(rate(http_requests_total[5m]))', totalSeries: 1 },
        { query: 'sum(rate(http_requests_total{status=~"5.."}[5m]))', totalSeries: 1 },
      ],
    });
  });

  it('returns PromQL validation errors as query summaries instead of failed tool calls', async () => {
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      query: jest.fn().mockResolvedValue({
        state: 'Error',
        errors: [{ message: 'bad_data: invalid parameter "query": parse error' }],
      }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'query_prometheus');

    const result = await tool.execute('call-1', { query: 'rate(node_load1[5m])' }, undefined);
    const body = JSON.parse(result.content[0].text);

    expect(body).toMatchObject({
      datasourceUid: 'prom-b',
      query: 'rate(node_load1[5m])',
      frameCount: 0,
      totalSeries: 0,
      validationError: 'bad_data: invalid parameter "query": parse error',
      notices: [{ severity: 'error', text: 'bad_data: invalid parameter "query": parse error' }],
      series: [],
    });
    expect(result.details).toMatchObject({
      datasourceUid: 'prom-b',
      query: 'rate(node_load1[5m])',
      series: 0,
      validationError: 'bad_data: invalid parameter "query": parse error',
      summarized: true,
    });
  });

  it('keeps anomalous Prometheus series when compacting batch summaries', async () => {
    const times = [Date.UTC(2026, 0, 1, 0, 0, 0), Date.UTC(2026, 0, 1, 0, 5, 0)];
    const firstFrame = makePrometheusFrame({
      displayName: 'value',
      labels: {},
      times,
      values: [1, 1],
    });
    const latencyFrames = [
      makePrometheusFrame({
        displayName: 'latency{route="/",vm="vm-web-01"}',
        labels: { route: '/', vm: 'vm-web-01' },
        times,
        values: [0.2, 0.7],
      }),
      makePrometheusFrame({
        displayName: 'latency{route="/",vm="vm-web-02"}',
        labels: { route: '/', vm: 'vm-web-02' },
        times,
        values: [0.2, 0.22],
      }),
      makePrometheusFrame({
        displayName: 'latency{route="/api/orders",vm="vm-web-01"}',
        labels: { route: '/api/orders', vm: 'vm-web-01' },
        times,
        values: [0.35, 1.66],
      }),
      makePrometheusFrame({
        displayName: 'latency{route="/api/orders",vm="vm-web-02"}',
        labels: { route: '/api/orders', vm: 'vm-web-02' },
        times,
        values: [0.35, 0.4],
      }),
      makePrometheusFrame({
        displayName: 'latency{route="/health",vm="vm-web-01"}',
        labels: { route: '/health', vm: 'vm-web-01' },
        times,
        values: [0.05, 0.05],
      }),
      makePrometheusFrame({
        displayName: 'latency{route="/render/report",vm="vm-web-01"}',
        labels: { route: '/render/report', vm: 'vm-web-01' },
        times,
        values: [0.1, 4],
      }),
    ];
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      query: jest
        .fn()
        .mockResolvedValueOnce({ state: 'Done', data: [firstFrame] })
        .mockResolvedValueOnce({ state: 'Done', data: latencyFrames }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'query_prometheus');

    const result = await tool.execute(
      'call-1',
      {
        queries: [
          { query: 'node_load1', type: 'range', start: 'now-6h', end: 'now' },
          { query: 'histogram_quantile(...)', type: 'range', start: 'now-6h', end: 'now' },
        ],
      },
      undefined
    );
    const body = JSON.parse(result.content[0].text);
    const latencySummary = body.results[1];

    expect(latencySummary.totalSeries).toBe(6);
    expect(latencySummary.truncatedSeries).toBe(true);
    expect(latencySummary.series).toHaveLength(3);
    expect(latencySummary.series.map((series: { labels: { route: string } }) => series.labels.route)).toContain(
      '/render/report'
    );
    expect(latencySummary.seriesSelection).toMatch(/ranked by max/);
    expect(latencySummary.omittedSeries).toMatchObject({
      count: 3,
      labelValues: {
        route: expect.arrayContaining(['/api/orders', '/', '/health']),
      },
    });
  });

  it('rejects an explicit datasource UID outside the allow-list', async () => {
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'list_metrics');

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
    const uploadTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'], includeAdHocDashboardTools: true }),
      'upload_dashboard'
    );

    expect(getUnavailableDashboardDatasourceUids(dashboard, { allowedPrometheusDatasourceUids: ['prom-a'] })).toEqual([
      '$datasource',
      'prom-b',
    ]);
    await expect(
      uploadTool.execute('call-1', { dashboard_json: JSON.stringify(dashboard) }, undefined)
    ).rejects.toThrow('Dashboard references datasource UIDs not available to the assistant: $datasource, prom-b');
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
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }), 'sync_dashboard');
    const source = "{ title: 'Direct Jsonnet', uid: 'direct-jsonnet', panels: [] }";

    const result = await tool.execute('call-1', { dashboard_jsonnet: source }, undefined);

    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/plugins/g42-pi-app/resources/managed-dashboards/sync',
        method: 'POST',
        data: { dashboard_jsonnet: source },
        showErrorAlert: false,
      })
    );
    expect(result.content[0].text).toContain('Managed dashboard created');
  });

  it('applies the approved folder override to one managed dashboard sync call', async () => {
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
    const clearFolderOverride = jest.fn();
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(
      createGrafanaTools({
        allowedPrometheusDatasourceUids: ['prom-a'],
        dashboardSyncFolders: {
          getFolderOverride: jest.fn(() => ({ uid: 'team-folder', title: 'Team folder' })),
          clearFolderOverride,
        },
      }),
      'sync_dashboard'
    );
    const source = "{ title: 'Direct Jsonnet', uid: 'direct-jsonnet', panels: [] }";

    const result = await tool.execute('call-folder', { dashboard_jsonnet: source }, undefined);

    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { dashboard_jsonnet: source, folderUid: 'team-folder' },
      })
    );
    expect(result.details).toMatchObject({ folderUid: 'team-folder', folderTitle: 'Team folder' });
    expect(clearFolderOverride).toHaveBeenCalledWith('call-folder');
  });

  it('writes and edits a session virtual Jsonnet file without returning full source to the model', async () => {
    const runtime = createVirtualJsonnetRuntime('session-tools');
    const source = "{ title: 'Virtual Jsonnet', uid: 'virtual-jsonnet', panels: [] }";
    const edited = "{ title: 'Edited Virtual Jsonnet', uid: 'virtual-jsonnet', panels: [] }";
    const fetch = jest
      .fn()
      .mockReturnValueOnce(
        of({
          data: {
            path: 'dashboard.jsonnet',
            version: 1,
            checksum: 'sha256:one',
            lineCount: 1,
            dashboardJsonnetSize: source.length,
            dashboard_jsonnet: source,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        })
      )
      .mockReturnValueOnce(
        of({
          data: {
            path: 'dashboard.jsonnet',
            version: 2,
            checksum: 'sha256:two',
            lineCount: 1,
            dashboardJsonnetSize: edited.length,
            dashboard_jsonnet: edited,
            changedRanges: [{ startLine: 1, endLine: 1, newLines: 1 }],
            diff: "@@ lines 1-1 @@\n-{ title: 'Virtual Jsonnet', uid: 'virtual-jsonnet', panels: [] }\n+{ title: 'Edited Virtual Jsonnet', uid: 'virtual-jsonnet', panels: [] }",
            firstChangedLine: 1,
            updatedAt: '2026-01-01T00:01:00Z',
          },
        })
      );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tools = createGrafanaTools({ virtualJsonnetFiles: runtime });

    const writeResult = await getTool(tools, 'write_jsonnet').execute('call-1', { content: source }, undefined);
    const editResult = await getTool(tools, 'edit_jsonnet').execute(
      'call-2',
      {
        baseVersion: 1,
        edits: [{ startLine: 1, endLine: 1, replacement: edited }],
      },
      undefined
    );

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: '/api/plugins/g42-pi-app/resources/managed-dashboards/jsonnet-files/write',
        data: { sessionId: 'session-tools', path: 'dashboard.jsonnet', content: source },
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: '/api/plugins/g42-pi-app/resources/managed-dashboards/jsonnet-files/edit',
        data: {
          sessionId: 'session-tools',
          path: 'dashboard.jsonnet',
          baseVersion: 1,
          edits: [{ startLine: 1, endLine: 1, replacement: edited }],
        },
      })
    );
    expect(runtime.getFile('dashboard.jsonnet')?.content).toBe(edited);
    expect(writeResult.content[0].text).not.toContain('dashboard_jsonnet');
    expect(editResult.content[0].text).not.toContain('dashboard_jsonnet');
  });

  it('rejects rewriting an existing virtual Jsonnet file through the write tool', async () => {
    const source = "{ title: 'Saved Jsonnet', uid: 'saved-jsonnet', panels: [] }";
    const runtime = createVirtualJsonnetRuntime('session-tools', {
      path: 'dashboard.jsonnet',
      content: source,
      version: 3,
      checksum: 'sha256:saved',
      lineCount: 1,
      dashboardJsonnetSize: source.length,
    });
    const fetch = jest.fn();
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ virtualJsonnetFiles: runtime }), 'write_jsonnet');

    await expect(tool.execute('call-1', { content: "{ title: 'Replacement' }" }, undefined)).rejects.toThrow(
      'dashboard.jsonnet already exists at version 3; use edit_jsonnet for follow-up changes.'
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes local dashboard wrapper drafts before writing Jsonnet', async () => {
    const runtime = createVirtualJsonnetRuntime('session-normalize');
    const source = `local dashboard = {
  title: 'HTTP Request Rate & Errors',
  uid: 'http-request-rate-errors',
  panels: [
    {
      title: 'Request rate',
      type: 'timeseries',
      targets: [{ expr: 'sum(rate(http_requests_total[5m]))' }],
    },
  ],
}

{ dashboard: dashboard }`;
    const normalized = `{
  title: 'HTTP Request Rate & Errors',
  uid: 'http-request-rate-errors',
  panels: [
    {
      title: 'Request rate',
      type: 'timeseries',
      targets: [{ expr: 'sum(rate(http_requests_total[5m]))' }],
    },
  ],
}
`;
    const fetch = jest.fn().mockReturnValue(
      of({
        data: {
          path: 'dashboard.jsonnet',
          version: 1,
          checksum: 'sha256:normalized',
          lineCount: 10,
          dashboardJsonnetSize: normalized.length,
          dashboard_jsonnet: normalized,
        },
      })
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ virtualJsonnetFiles: runtime }), 'write_jsonnet');

    await tool.execute('call-1', { content: source }, undefined);

    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          sessionId: 'session-normalize',
          path: 'dashboard.jsonnet',
          content: normalized,
        },
      })
    );
    expect(runtime.getFile('dashboard.jsonnet')?.content).toBe(normalized);
  });

  it('repairs a session virtual Jsonnet file without returning full source to the model', async () => {
    const runtime = createVirtualJsonnetRuntime('session-fix');
    const source = "g.dashboard.new(title='Bad', uid='bad', panels=[])";
    const fixed = "{ title: 'Bad', uid: 'bad', panels: [] }";
    const fetch = jest
      .fn()
      .mockReturnValueOnce(
        of({
          data: {
            path: 'dashboard.jsonnet',
            version: 1,
            checksum: 'sha256:bad',
            lineCount: 1,
            dashboardJsonnetSize: source.length,
            dashboard_jsonnet: source,
          },
        })
      )
      .mockReturnValueOnce(
        of({
          data: {
            path: 'dashboard.jsonnet',
            version: 2,
            checksum: 'sha256:fixed',
            lineCount: 1,
            dashboardJsonnetSize: fixed.length,
            dashboard_jsonnet: fixed,
            changedRanges: [{ startLine: 1, endLine: 1, newLines: 1 }],
            diff: '@@ structural repair @@',
            repairs: ['rewrote g.dashboard.new(...) named arguments into a plain dashboard object'],
          },
        })
      );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tools = createGrafanaTools({ virtualJsonnetFiles: runtime });

    await getTool(tools, 'write_jsonnet').execute('call-1', { content: source }, undefined);
    const result = await getTool(tools, 'fix_jsonnet').execute('call-2', { baseVersion: 1 }, undefined);

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: '/api/plugins/g42-pi-app/resources/managed-dashboards/jsonnet-files/repair',
        data: {
          sessionId: 'session-fix',
          path: 'dashboard.jsonnet',
          baseVersion: 1,
        },
      })
    );
    expect(runtime.getFile('dashboard.jsonnet')?.content).toBe(fixed);
    expect(result.content[0].text).not.toContain('dashboard_jsonnet');
    expect(result.content[0].text).toContain('structural repair');
  });

  it('hydrates a saved virtual Jsonnet file before rendering from a file reference', async () => {
    const source = "{ title: 'Hydrated Jsonnet', uid: 'hydrated-jsonnet', panels: [] }";
    const runtime = createVirtualJsonnetRuntime('session-render', {
      path: 'dashboard.jsonnet',
      content: source,
      version: 4,
      checksum: 'sha256:saved',
      lineCount: 1,
      dashboardJsonnetSize: source.length,
    });
    const fetch = jest
      .fn()
      .mockReturnValueOnce(
        of({
          data: {
            path: 'dashboard.jsonnet',
            version: 4,
            checksum: 'sha256:saved',
            lineCount: 1,
            dashboardJsonnetSize: source.length,
            dashboard_jsonnet: source,
          },
        })
      )
      .mockReturnValueOnce(
        of({
          data: {
            dashboard: {
              title: 'Hydrated Jsonnet',
              uid: 'hydrated-jsonnet',
              tags: ['genai'],
              panels: [
                {
                  id: 1,
                  title: 'Requests',
                  type: 'timeseries',
                  datasource: { uid: 'prom-a' },
                  targets: [{ refId: 'A', expr: 'up', datasource: { uid: 'prom-a' } }],
                },
              ],
            },
            resource: { metadata: { name: 'hydrated-jsonnet' } },
            sourceChecksum: 'sha256:saved',
            jsonnetFile: {
              path: 'dashboard.jsonnet',
              version: 4,
              checksum: 'sha256:saved',
              lineCount: 1,
              dashboardJsonnetSize: source.length,
            },
          },
        })
      );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ virtualJsonnetFiles: runtime }), 'render_dashboard');

    const result = await tool.execute('call-1', {}, undefined);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: '/api/plugins/g42-pi-app/resources/managed-dashboards/jsonnet-files/write',
        data: { sessionId: 'session-render', path: 'dashboard.jsonnet', content: source, version: 4 },
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: '/api/plugins/g42-pi-app/resources/managed-dashboards/render',
        data: { path: 'dashboard.jsonnet', sessionId: 'session-render' },
      })
    );
    expect(result.details).toMatchObject({
      dashboard: {
        title: 'Hydrated Jsonnet',
        uid: 'hydrated-jsonnet',
        panelCount: 1,
        panels: [{ title: 'Requests', type: 'timeseries', datasourceUid: 'prom-a' }],
      },
      path: 'dashboard.jsonnet',
      sourceBytes: source.length,
      sourceChecksum: 'sha256:saved',
    });
    expect(result.content[0].text).not.toContain('resource');
  });

  it('hydrates an auto-repaired virtual Jsonnet file after rendering without exposing full source', async () => {
    const source = "g.dashboard.new(title='Bad', uid='bad', panels=[g.panel.new(title='Broken')])";
    const fixed = "{ title: 'Bad', uid: 'bad', panels: [{ title: 'Broken', type: 'timeseries' }] }";
    const runtime = createVirtualJsonnetRuntime('session-auto-render', {
      path: 'dashboard.jsonnet',
      content: source,
      version: 1,
      checksum: 'sha256:bad',
      lineCount: 1,
      dashboardJsonnetSize: source.length,
    });
    const fetch = jest
      .fn()
      .mockReturnValueOnce(
        of({
          data: {
            path: 'dashboard.jsonnet',
            version: 1,
            checksum: 'sha256:bad',
            lineCount: 1,
            dashboardJsonnetSize: source.length,
            dashboard_jsonnet: source,
          },
        })
      )
      .mockReturnValueOnce(
        of({
          data: {
            dashboard: { title: 'Bad', uid: 'bad', tags: [], panels: [{ title: 'Broken', type: 'timeseries' }] },
            sourceChecksum: 'sha256:fixed',
            autoRepaired: true,
            repairs: ['rewrote the unsupported Grafonnet dashboard constructor chain into a plain dashboard object'],
            jsonnetFile: {
              path: 'dashboard.jsonnet',
              version: 2,
              checksum: 'sha256:fixed',
              lineCount: 1,
              dashboardJsonnetSize: fixed.length,
            },
            dashboard_jsonnet: fixed,
          },
        })
      );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ virtualJsonnetFiles: runtime }), 'render_dashboard');

    const result = await tool.execute('call-1', {}, undefined);

    expect(runtime.getFile('dashboard.jsonnet')).toMatchObject({
      content: fixed,
      version: 2,
      checksum: 'sha256:fixed',
    });
    expect(result.details).toMatchObject({
      autoRepaired: true,
      repairs: ['rewrote the unsupported Grafonnet dashboard constructor chain into a plain dashboard object'],
      jsonnetFile: { version: 2 },
    });
    expect(result.content[0].text).not.toContain('dashboard_jsonnet');
    expect(result.content[0].text).not.toContain('g.panel.new');
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
          url: '/api/plugins/g42-pi-app/resources/managed-dashboards/sync',
        },
      }))
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }), 'sync_dashboard');

    await expect(tool.execute('call-1', { dashboard_jsonnet: 'let textPanel() = {}' }, undefined)).rejects.toThrow(
      'Grafana request failed (400 Bad Request) while calling POST /api/plugins/g42-pi-app/resources/managed-dashboards/sync: jsonnet compilation failed: dashboard.jsonnet:3:5-14 Did not expect: (IDENTIFIER, "textPanel")'
    );
  });

  it('keeps specialist delegation tools available and does not expose Jsonnet exploration', () => {
    expect(createGrafanaToolRegistry().subagents).toEqual([]);

    const defaultRegistry = createGrafanaToolRegistry({
      runtime: {
        model: {} as any,
        streamFn: jest.fn() as any,
        thinkingLevel: 'off',
      },
    });
    expect(defaultRegistry.subagents.map((tool) => tool.name)).toEqual([
      'run_query_agent',
      'run_dashboard_agent',
      'run_investigation_agent',
      'run_support_agent',
      'run_navigation_agent',
    ]);
    expect(defaultRegistry.all.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['run_query_agent', 'run_dashboard_agent', 'run_investigation_agent'])
    );
    expect(defaultRegistry.all.map((tool) => tool.name)).not.toContain('explore_jsonnet');
  });

  it('exposes only specialist delegation tools through the supervisor helper', () => {
    const names = createGrafanaSupervisorTools({
      runtime: {
        model: {} as any,
        streamFn: jest.fn() as any,
        thinkingLevel: 'off',
      },
    }).map((tool) => tool.name);

    expect(names).toEqual([
      'run_query_agent',
      'run_dashboard_agent',
      'run_investigation_agent',
      'run_support_agent',
      'run_navigation_agent',
    ]);
  });

  it('exposes artifact reads to the supervisor and specialist agents when a registry is available', async () => {
    const artifacts = {
      register: jest.fn(),
      get: jest.fn(),
      list: jest.fn(() => []),
    };
    const registry = createGrafanaToolRegistry({
      artifacts,
      runtime: {
        model: {} as any,
        streamFn: jest.fn() as any,
        thinkingLevel: 'off',
      },
    });

    expect(registry.artifacts.map((tool) => tool.name)).toEqual(['read_artifact']);
    expect(createGrafanaSupervisorTools({ artifacts, runtime: registryRuntime() }).map((tool) => tool.name)).toContain(
      'read_artifact'
    );

    const tool = getTool(registry.subagents, 'run_query_agent');
    await tool.execute('call-1', { task: 'Inspect the stored result.' }, undefined);
    const call = jest.mocked(runSpecialistAgent).mock.calls.at(-1)?.[0];
    expect(call?.tools.map((childTool) => childTool.name)).toContain('read_artifact');
  });

  it('builds safe Grafana navigation paths', () => {
    expect(buildNavigationPath({ type: 'dashboard', uid: 'service-red', slug: 'Service RED' })).toBe(
      '/d/service-red/service-red'
    );
    expect(buildNavigationPath({ type: 'relative', path: '/dashboards?query=node' })).toBe('/dashboards?query=node');

    const explorePath = buildNavigationPath({
      type: 'prometheus_explore',
      datasourceUid: 'prom-a',
      query: 'up',
    });
    const left = JSON.parse(decodeURIComponent(explorePath.replace('/explore?left=', '')));
    expect(left).toMatchObject({
      datasource: 'prom-a',
      queries: [
        {
          datasource: { type: 'prometheus', uid: 'prom-a' },
          expr: 'up',
        },
      ],
      range: { from: 'now-1h', to: 'now' },
    });

    expect(() => buildNavigationPath({ type: 'relative', path: 'https://example.com' })).toThrow(
      'navigate relative path must be a Grafana-relative path starting with /.'
    );
    expect(() => buildNavigationPath({ type: 'relative', path: '//example.com' })).toThrow(
      'navigate relative path must be a Grafana-relative path starting with /.'
    );
  });

  it('keeps raw dashboard upload/delete and direct Jsonnet library browsing out of the compatibility toolset', () => {
    const registry = createGrafanaToolRegistry({
      runtime: {
        model: {} as any,
        streamFn: jest.fn() as any,
        thinkingLevel: 'off',
      },
    });

    const names = registry.all.map((tool) => tool.name);
    expect(names).toContain('query_prometheus');
    expect(names).toContain('write_jsonnet');
    expect(names).toContain('edit_jsonnet');
    expect(names).toContain('fix_jsonnet');
    expect(names).toContain('read_jsonnet');
    expect(names).toContain('sync_dashboard');
    expect(names).toContain('get_dashboard_source');
    expect(names).toContain('inspect_dashboard_context');
    expect(names).toContain('screenshot_dashboard');
    expect(names).toContain('run_query_agent');
    expect(names).toContain('run_dashboard_agent');
    expect(names).toContain('run_investigation_agent');
    expect(names).toContain('run_support_agent');
    expect(names).toContain('run_navigation_agent');
    expect(names).not.toContain('explore_metrics');
    expect(names).not.toContain('design_dashboard');
    expect(names).not.toContain('query_prometheus_raw');
    expect(names).not.toContain('upload_dashboard');
    expect(names).not.toContain('delete_dashboard');
    expect(names).not.toContain('apply_live_dashboard_mutation');
    expect(names).not.toContain('explore_jsonnet');
    expect(names).not.toContain('grafana_list_managed_dashboard_templates');
    expect(names).not.toContain('read_managed_dashboard_template');
    expect(names).not.toContain('search_grafonnet');
    expect(names).not.toContain('read_grafonnet');
    expect(names).not.toContain('list_grafonnet');
  });

  it('exposes live dashboard mutation tools only when Grafana provides the restricted API', async () => {
    const withoutApi = createGrafanaToolsForSkillGroups({}, ['liveDashboardEditing']).map((tool) => tool.name);
    expect(withoutApi).not.toContain('apply_live_dashboard_mutation');

    const dashboardMutation = {
      execute: jest.fn(async ({ type, payload }: { type: string; payload: unknown }) => ({
        success: true,
        changes: [{ path: '/elements/panel-1', previousValue: null, newValue: { type, payload } }],
        data: { ok: true },
      })),
      getPayloadSchema: jest.fn(() => ({}) as any),
      getAvailableCommands: jest.fn(() => [
        'ADD_PANEL',
        'ADD_VARIABLE',
        'GET_DASHBOARD_INFO',
        'GET_LAYOUT',
        'LIST_PANELS',
        'LIST_VARIABLES',
        'MOVE_PANEL',
        'UPDATE_DASHBOARD_SETTINGS',
        'UPDATE_PANEL',
        'UPDATE_VARIABLE',
      ]),
    };
    const tools = createGrafanaToolsForSkillGroups({ dashboardMutation }, ['liveDashboardEditing']);
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([
      'list_live_dashboard_panels',
      'get_live_dashboard_layout',
      'get_live_dashboard_info',
      'list_live_dashboard_variables',
      'get_live_dashboard_mutation_schema',
      'rename_live_dashboard_panel',
      'update_live_dashboard_panel_query',
      'add_live_dashboard_panel',
      'move_or_resize_live_dashboard_panel',
      'update_live_dashboard_settings',
      'add_live_dashboard_variable',
      'update_live_dashboard_variable',
      'apply_live_dashboard_mutation',
    ]);

    const listTool = getTool(tools, 'list_live_dashboard_panels');
    const listResult = await listTool.execute('call-1', { includeStatus: true }, undefined);
    expect(dashboardMutation.execute).toHaveBeenCalledWith({
      type: 'LIST_PANELS',
      payload: { includeStatus: true },
    });
    expect(listResult.content[0].text).toContain('Live dashboard mutation LIST_PANELS succeeded');

    const applyTool = getTool(tools, 'apply_live_dashboard_mutation');
    const result = await applyTool.execute(
      'call-2',
      {
        type: 'UPDATE_PANEL',
        payload: {
          element: { kind: 'ElementReference', name: 'panel-1' },
          panel: { kind: 'Panel', spec: { title: 'Renamed' } },
        },
      },
      undefined
    );
    expect(result.details).toMatchObject({ command: 'UPDATE_PANEL', success: true });

    const renameTool = getTool(tools, 'rename_live_dashboard_panel');
    await renameTool.execute('call-3', { elementName: 'panel-1', title: 'Typed rename' }, undefined);
    expect(dashboardMutation.execute).toHaveBeenLastCalledWith({
      type: 'UPDATE_PANEL',
      payload: {
        element: { kind: 'ElementReference', name: 'panel-1' },
        panel: { kind: 'Panel', spec: { title: 'Typed rename' } },
      },
    });

    const queryTool = getTool(tools, 'update_live_dashboard_panel_query');
    await queryTool.execute(
      'call-4',
      { elementName: 'panel-1', queryExpression: 'sum(rate(http_requests_total[$__rate_interval]))' },
      undefined
    );
    expect(dashboardMutation.execute).toHaveBeenLastCalledWith({
      type: 'UPDATE_PANEL',
      payload: {
        element: { kind: 'ElementReference', name: 'panel-1' },
        panel: {
          kind: 'Panel',
          spec: {
            data: {
              kind: 'QueryGroup',
              spec: {
                queries: [
                  {
                    kind: 'PanelQuery',
                    spec: {
                      refId: 'A',
                      query: {
                        kind: 'DataQuery',
                        group: 'prometheus',
                        spec: { expr: 'sum(rate(http_requests_total[$__rate_interval]))' },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });

    const addTool = getTool(tools, 'add_live_dashboard_panel');
    const addResult = await addTool.execute(
      'call-5',
      {
        title: 'Typed added panel',
        queryExpression: 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
        x: 12,
        y: 8,
        width: 12,
        height: 8,
      },
      undefined
    );
    expect(dashboardMutation.execute).toHaveBeenCalledWith({
      type: 'ADD_PANEL',
      payload: {
        panel: {
          kind: 'Panel',
          spec: {
            title: 'Typed added panel',
            data: {
              kind: 'QueryGroup',
              spec: {
                queries: [
                  {
                    kind: 'PanelQuery',
                    spec: {
                      refId: 'A',
                      query: {
                        kind: 'DataQuery',
                        group: 'prometheus',
                        spec: { expr: 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))' },
                      },
                    },
                  },
                ],
              },
            },
            vizConfig: {
              kind: 'VizConfig',
              group: 'timeseries',
              spec: {
                fieldConfig: { defaults: {}, overrides: [] },
                options: {},
              },
            },
          },
        },
        layoutItem: { kind: 'GridLayoutItem', spec: { x: 12, y: 8, width: 12, height: 8 } },
      },
    });
    expect(dashboardMutation.execute).toHaveBeenLastCalledWith({ type: 'GET_DASHBOARD_INFO', payload: {} });
    expect(addResult.details).toMatchObject({
      command: 'ADD_PANEL',
      success: true,
      visualVerification: { status: 'skipped' },
    });

    const settingsTool = getTool(tools, 'update_live_dashboard_settings');
    await settingsTool.execute('call-6', { title: 'Typed dashboard', tags: ['typed', 'live'] }, undefined);
    expect(dashboardMutation.execute).toHaveBeenLastCalledWith({
      type: 'UPDATE_DASHBOARD_SETTINGS',
      payload: {
        title: 'Typed dashboard',
        tags: ['typed', 'live'],
      },
    });

    const variableTool = getTool(tools, 'add_live_dashboard_variable');
    await variableTool.execute(
      'call-7',
      { name: 'env', variableType: 'custom', options: ['prod', 'staging'], current: 'prod' },
      undefined
    );
    expect(dashboardMutation.execute).toHaveBeenLastCalledWith({
      type: 'ADD_VARIABLE',
      payload: {
        variable: {
          kind: 'CustomVariable',
          spec: {
            name: 'env',
            current: { text: 'prod', value: 'prod' },
            query: 'prod,staging',
            options: [
              { text: 'prod', value: 'prod' },
              { text: 'staging', value: 'staging' },
            ],
          },
        },
      },
    });
  });

  it('does not expose live dashboard mutation tools when no dashboard client is active', async () => {
    const dashboardMutation = {
      execute: jest.fn(),
      getPayloadSchema: jest.fn(() => ({}) as any),
      getAvailableCommands: jest.fn(() => []),
    };
    const names = createGrafanaToolsForSkillGroups({ dashboardMutation }, ['liveDashboardEditing']).map(
      (tool) => tool.name
    );

    expect(names).not.toContain('rename_live_dashboard_panel');
    expect(names).not.toContain('apply_live_dashboard_mutation');
    expect(dashboardMutation.execute).not.toHaveBeenCalled();
  });

  it('keeps read-only dashboard mutation commands out of the live apply tool', async () => {
    const dashboardMutation = {
      execute: jest.fn(),
      getPayloadSchema: jest.fn(() => ({}) as any),
      getAvailableCommands: jest.fn(() => ['LIST_PANELS']),
    };
    const applyTool = getTool(
      createGrafanaToolsForSkillGroups({ dashboardMutation }, ['liveDashboardEditing']),
      'apply_live_dashboard_mutation'
    );

    await expect(applyTool.execute('call-1', { type: 'LIST_PANELS', payload: {} }, undefined)).rejects.toThrow(
      'LIST_PANELS is read-only'
    );
    expect(dashboardMutation.execute).not.toHaveBeenCalled();
  });

  it('can explicitly expose advanced dashboard and Jsonnet tools for tests or developer workflows', () => {
    const names = createGrafanaTools({
      includeAdHocDashboardTools: true,
      includeJsonnetLibraryTools: true,
      includeRawPrometheusQueryTool: true,
      runtime: {
        model: {} as any,
        streamFn: jest.fn() as any,
        thinkingLevel: 'off',
      },
    }).map((tool) => tool.name);

    expect(names).toContain('query_prometheus_raw');
    expect(names).toContain('upload_dashboard');
    expect(names).toContain('delete_dashboard');
    expect(names).toContain('get_dashboard_source');
    expect(names).toContain('inspect_dashboard_context');
    expect(names).toContain('search_grafonnet');
    expect(names).toContain('run_query_agent');
    expect(names).toContain('run_dashboard_agent');
    expect(names).not.toContain('explore_jsonnet');
  });

  it('inspects typed dashboard context and validates interpolated Prometheus panel queries', async () => {
    const frame = makePrometheusFrame({
      displayName: 'request rate{route="/render/report"}',
      labels: { route: '/render/report' },
      times: [Date.UTC(2026, 0, 1, 0, 0, 0), Date.UTC(2026, 0, 1, 0, 5, 0)],
      values: [1, 2],
    });
    const dataSource = {
      uid: 'prom-a',
      type: 'prometheus',
      query: jest
        .fn()
        .mockResolvedValueOnce({ state: 'Done', data: [frame] })
        .mockResolvedValueOnce({
          state: 'Error',
          errors: [{ message: 'bad_data: unknown metric http_request_total' }],
        }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const fetch = jest.fn().mockReturnValue(
      of({
        data: {
          dashboard: {
            uid: 'stale-http',
            title: 'Stale HTTP Review',
            tags: ['stale'],
            time: { from: 'now-6h', to: 'now' },
            templating: {
              list: [
                {
                  name: 'route',
                  type: 'custom',
                  query: '/,/api/orders,/render/report',
                  current: { text: '/render/report', value: '/render/report' },
                },
              ],
            },
            panels: [
              {
                id: 1,
                title: 'Healthy rate',
                type: 'timeseries',
                datasource: { uid: 'prom-a', type: 'prometheus' },
                gridPos: { x: 0, y: 0, w: 12, h: 8 },
                fieldConfig: { defaults: { unit: 'reqps' } },
                targets: [
                  {
                    refId: 'A',
                    expr: 'sum(rate(http_requests_total{route="$route"}[$__rate_interval]))',
                  },
                ],
              },
              {
                id: 2,
                title: 'Stale error rate',
                type: 'timeseries',
                datasource: { uid: 'prom-a', type: 'prometheus' },
                targets: [
                  {
                    refId: 'A',
                    expr: 'sum(rate(http_request_total{path="$route",status=~"5.."}[$__rate_interval]))',
                  },
                ],
              },
            ],
          },
          meta: {
            folderTitle: 'Reviews',
            url: '/d/stale-http/stale-http-review',
          },
        },
      })
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'inspect_dashboard_context'
    );

    const result = await tool.execute('call-1', { uid: 'stale-http', validateQueries: true }, undefined);
    const body = JSON.parse(result.content[0].text);

    expect(dataSource.query).toHaveBeenCalledTimes(2);
    expect(body.dashboard).toMatchObject({
      uid: 'stale-http',
      title: 'Stale HTTP Review',
      folderTitle: 'Reviews',
      time: { from: 'now-6h', to: 'now' },
    });
    expect(body.variables[0]).toMatchObject({ name: 'route', current: '/render/report' });
    expect(body.panels[0]).toMatchObject({
      id: '1',
      title: 'Healthy rate',
      gridPos: { x: 0, y: 0, w: 12, h: 8 },
      fieldConfig: { unit: 'reqps' },
    });
    expect(body.panels[0].targets[0].validationQuery).toBe(
      'sum(rate(http_requests_total{route="/render/report"}[5m]))'
    );
    expect(body.panels[1].targets[0].validationQuery).toBe(
      'sum(rate(http_request_total{path="/render/report",status=~"5.."}[5m]))'
    );
    expect(body.validation).toMatchObject({
      queryCount: 2,
      failedQueries: 1,
      zeroSeriesQueries: 0,
      truncatedQueries: false,
    });
    expect(body.validation.results[1]).toMatchObject({
      panelTitle: 'Stale error rate',
      validationError: 'bad_data: unknown metric http_request_total',
    });
    expect(result.details).toMatchObject({
      uid: 'stale-http',
      panelCount: 2,
      variableCount: 1,
      queryCount: 2,
      validation: {
        queryCount: 2,
        failedQueries: 1,
      },
      summarized: true,
    });
  });

  it('exposes narrow read-only subagent tools for skill-selected turns', () => {
    const names = createGrafanaToolsForSkillGroups(
      {
        runtime: {
          model: {} as any,
          streamFn: jest.fn() as any,
          thinkingLevel: 'off',
        },
      },
      ['metrics', 'subagents']
    ).map((tool) => tool.name);

    expect(names).toContain('list_datasources');
    expect(names).toContain('query_prometheus');
    expect(names).toContain('run_query_agent');
    expect(names).toContain('run_dashboard_agent');
    expect(names).toContain('run_investigation_agent');
    expect(names).toContain('run_support_agent');
    expect(names).toContain('run_navigation_agent');
    expect(names).not.toContain('write_jsonnet');
    expect(names).not.toContain('render_dashboard');
    expect(names).not.toContain('sync_dashboard');
    expect(names).not.toContain('get_dashboard');
    expect(names).not.toContain('screenshot_dashboard');
  });

  it('adds managed dashboard tools when the dashboard skill group is selected', () => {
    const names = createGrafanaToolsForSkillGroups(
      {
        runtime: {
          model: {} as any,
          streamFn: jest.fn() as any,
          thinkingLevel: 'off',
        },
      },
      ['metrics', 'dashboardRead', 'jsonnetFiles', 'managedDashboards', 'subagents']
    ).map((tool) => tool.name);

    expect(names).toContain('query_prometheus');
    expect(names).toContain('write_jsonnet');
    expect(names).toContain('render_dashboard');
    expect(names).toContain('sync_dashboard');
    expect(names).toContain('get_dashboard_source');
    expect(names).toContain('get_dashboard');
    expect(names).toContain('inspect_dashboard_context');
    expect(names).toContain('screenshot_dashboard');
    expect(names).toContain('run_dashboard_agent');
    expect(names).not.toContain('design_dashboard');
    expect(names).not.toContain('upload_dashboard');
    expect(names).not.toContain('delete_dashboard');
  });

  it('runs the dashboard agent with managed-dashboard child tools', async () => {
    const registry = createGrafanaToolRegistry({
      skillTools: createSkillTools(GRAFANA_SKILLS),
      runtime: {
        model: {} as any,
        streamFn: jest.fn() as any,
        thinkingLevel: 'off',
      },
    });
    const tool = getTool(registry.subagents, 'run_dashboard_agent');

    const result = await tool.execute(
      'call-1',
      {
        task: 'Design an HTTP request dashboard',
        datasourceUid: 'prom-b',
        existingDashboardUid: 'http-current',
        intent: 'update',
      },
      undefined
    );
    const call = jest.mocked(runSpecialistAgent).mock.calls.at(-1)?.[0];
    const childToolNames = call?.tools.map((childTool) => childTool.name) ?? [];

    expect(call).toMatchObject({
      kind: 'dashboard',
      task: expect.stringContaining('Design an HTTP request dashboard'),
    });
    expect(call?.task).toContain('Prefer datasource UID: prom-b.');
    expect(call?.task).toContain('Inspect existing dashboard UID: http-current.');
    expect(result.details).toMatchObject({ agent: 'dashboard', status: 'completed' });
    expect(childToolNames).toEqual(
      expect.arrayContaining([
        'list_datasources',
        'list_metrics',
        'inspect_metric_series',
        'query_prometheus',
        'write_jsonnet',
        'edit_jsonnet',
        'fix_jsonnet',
        'read_jsonnet',
        'list_managed_dashboards',
        'get_dashboard_source',
        'render_dashboard',
        'sync_dashboard',
        'get_dashboard',
        'list_dashboards',
        'inspect_dashboard_context',
        'screenshot_dashboard',
        'read_skill_resource',
      ])
    );
    expect(childToolNames).not.toContain('upload_dashboard');
    expect(childToolNames).not.toContain('delete_dashboard');
    expect(childToolNames).not.toContain('run_dashboard_agent');
  });

  it('runs the navigation agent with only the safe navigation tool', async () => {
    const registry = createGrafanaToolRegistry({
      runtime: {
        model: {} as any,
        streamFn: jest.fn() as any,
        thinkingLevel: 'off',
      },
    });
    const tool = getTool(registry.subagents, 'run_navigation_agent');

    const result = await tool.execute(
      'call-1',
      {
        task: 'Open the Service RED dashboard.',
        destinationHint: 'service-red',
      },
      undefined
    );
    const call = jest.mocked(runSpecialistAgent).mock.calls.at(-1)?.[0];

    expect(call).toMatchObject({
      kind: 'navigation',
      task: expect.stringContaining('Open the Service RED dashboard.'),
    });
    expect(call?.task).toContain('Destination hint: service-red.');
    expect(call?.tools.map((childTool) => childTool.name)).toEqual(['navigate']);
    expect(result.details).toMatchObject({ agent: 'navigation', status: 'completed' });
  });

  it('reads bundled skill resources through an explicit tool', async () => {
    const tool = getTool(createSkillTools(GRAFANA_SKILLS), 'read_skill_resource');

    const result = await tool.execute(
      'call-1',
      { skill: 'grafana-dashboard', path: 'references/dashboard-jsonnet-workflow.md' },
      undefined
    );

    expect(result.content[0].text).toContain('# Dashboard Jsonnet Workflow');
    expect(result.details).toMatchObject({
      skill: 'grafana-dashboard',
      path: 'references/dashboard-jsonnet-workflow.md',
      truncated: false,
    });
    await expect(tool.execute('call-2', { skill: 'grafana-dashboard', path: 'missing.md' }, undefined)).rejects.toThrow(
      'Unknown resource for grafana-dashboard: missing.md'
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

function registryRuntime() {
  return {
    model: {} as any,
    streamFn: jest.fn() as any,
    thinkingLevel: 'off' as const,
  };
}

function createVirtualJsonnetRuntime(sessionId: string, initialFile?: VirtualJsonnetFileSnapshot) {
  const files: Record<string, VirtualJsonnetFileSnapshot> = initialFile ? { [initialFile.path]: initialFile } : {};
  const hydrated: Record<string, number> = {};

  return {
    getSessionId: () => sessionId,
    getFile: (path: string) => files[path],
    setFile: (file: VirtualJsonnetFileSnapshot, options?: { hydrated?: boolean }) => {
      files[file.path] = file;
      if (options?.hydrated) {
        hydrated[file.path] = file.version;
      }
    },
    isHydrated: (path: string, version: number) => hydrated[path] === version,
    markHydrated: (path: string, version: number) => {
      hydrated[path] = version;
    },
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
