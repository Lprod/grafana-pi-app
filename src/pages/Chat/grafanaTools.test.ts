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
  type VirtualJsonnetFileSnapshot,
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
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-b'] }), 'list_datasources');

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
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-b'] }), 'query_prometheus');

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
    const uploadTool = getTool(
      createGrafanaTools({ allowedDatasourceUids: ['prom-a'], includeAdHocDashboardTools: true }),
      'upload_dashboard'
    );

    expect(getDisallowedDashboardDatasourceUids(dashboard, { allowedDatasourceUids: ['prom-a'] })).toEqual([
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
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-a'] }), 'sync_dashboard');
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

    const writeResult = await getTool(tools, 'write_jsonnet').execute(
      'call-1',
      { content: source },
      undefined
    );
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
        url: '/api/plugins/elohmeier-grafanapiapp-app/resources/managed-dashboards/jsonnet-files/write',
        data: { sessionId: 'session-tools', path: 'dashboard.jsonnet', content: source },
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: '/api/plugins/elohmeier-grafanapiapp-app/resources/managed-dashboards/jsonnet-files/edit',
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
        url: '/api/plugins/elohmeier-grafanapiapp-app/resources/managed-dashboards/jsonnet-files/repair',
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
            dashboard: { title: 'Hydrated Jsonnet', uid: 'hydrated-jsonnet', tags: [], panels: [] },
            resource: { metadata: { name: 'hydrated-jsonnet' } },
            sourceChecksum: 'sha256:saved',
          },
        })
      );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ virtualJsonnetFiles: runtime }), 'render_dashboard');

    const result = await tool.execute('call-1', {}, undefined);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: '/api/plugins/elohmeier-grafanapiapp-app/resources/managed-dashboards/jsonnet-files/write',
        data: { sessionId: 'session-render', path: 'dashboard.jsonnet', content: source, version: 4 },
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: '/api/plugins/elohmeier-grafanapiapp-app/resources/managed-dashboards/render',
        data: { path: 'dashboard.jsonnet', sessionId: 'session-render' },
      })
    );
    expect(result.details).toMatchObject({ path: 'dashboard.jsonnet', sourceBytes: source.length });
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
    const tool = getTool(createGrafanaTools({ allowedDatasourceUids: ['prom-a'] }), 'sync_dashboard');

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

    expect(registry.subagents.map((tool) => tool.name)).toEqual(['explore_metrics', 'explore_jsonnet']);
    expect(registry.all.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['explore_metrics', 'explore_jsonnet'])
    );
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
    expect(names).toContain('write_jsonnet');
    expect(names).toContain('edit_jsonnet');
    expect(names).toContain('fix_jsonnet');
    expect(names).toContain('read_jsonnet');
    expect(names).toContain('sync_dashboard');
    expect(names).toContain('get_dashboard_source');
    expect(names).toContain('screenshot_dashboard');
    expect(names).not.toContain('query_prometheus_raw');
    expect(names).not.toContain('upload_dashboard');
    expect(names).not.toContain('delete_dashboard');
    expect(names).not.toContain('grafana_list_managed_dashboard_templates');
    expect(names).not.toContain('read_managed_dashboard_template');
    expect(names).not.toContain('search_grafonnet');
    expect(names).not.toContain('read_grafonnet');
    expect(names).not.toContain('list_grafonnet');
  });

  it('can explicitly expose advanced dashboard and Jsonnet tools for tests or developer workflows', () => {
    const names = createGrafanaTools({
      includeAdHocDashboardTools: true,
      includeJsonnetLibraryTools: true,
      includeRawPrometheusQueryTool: true,
    }).map((tool) => tool.name);

    expect(names).toContain('query_prometheus_raw');
    expect(names).toContain('upload_dashboard');
    expect(names).toContain('delete_dashboard');
    expect(names).toContain('get_dashboard_source');
    expect(names).toContain('search_grafonnet');
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
