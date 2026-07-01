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
  extractDashboardMetricUsage,
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

  it('retries transient datasource resource failures transparently', async () => {
    jest.useFakeTimers();
    try {
      const dataSource = {
        uid: 'prom-b',
        type: 'prometheus',
        getResource: jest
          .fn()
          .mockRejectedValueOnce(
            grafanaFetchError(503, 'Service Unavailable', 'upstream Prometheus is temporarily unavailable')
          )
          .mockResolvedValueOnce({ data: ['up'] }),
      };
      mockDataSourceSrv.get.mockResolvedValue(dataSource);
      const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'list_metrics');

      const pending = tool.execute('call-1', {}, undefined);
      await runPendingRetryTimers();
      const result = await pending;

      expect(dataSource.getResource).toHaveBeenCalledTimes(2);
      expect(result.content[0].text).toBe('up');
      expect(result.content[0].text).not.toContain('failed after');
      expect(result.details).toMatchObject({ datasourceUid: 'prom-b', count: 1, truncated: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it('normalizes datasource resource failures into readable tool errors', async () => {
    jest.useFakeTimers();
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      getResource: jest
        .fn()
        .mockRejectedValue(
          grafanaFetchError(502, 'Bad Gateway', 'dial tcp 10.0.0.1:9090: connect: connection refused')
        ),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'list_metrics');

    try {
      const pending = tool.execute('call-1', {}, undefined);
      const expectation = expect(pending).rejects.toThrow(
        'Prometheus resource api/v1/label/__name__/values failed for datasource prom-b: resource request for datasource prom-b failed after 3 attempts: Grafana request failed (502 Bad Gateway) while calling GET api/v1/label/__name__/values: dial tcp 10.0.0.1:9090: connect: connection refused'
      );
      await runPendingRetryTimers();

      await expectation;
      expect(dataSource.getResource).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
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

  it('retries transient Prometheus query failures without exposing retry noise', async () => {
    jest.useFakeTimers();
    try {
      const frame = makePrometheusFrame({
        displayName: 'up{job="api"}',
        labels: { job: 'api' },
        times: [Date.UTC(2026, 0, 1, 0, 0, 0)],
        values: [1],
      });
      const dataSource = {
        uid: 'prom-b',
        type: 'prometheus',
        query: jest
          .fn()
          .mockRejectedValueOnce(
            grafanaFetchError(503, 'Service Unavailable', 'upstream Prometheus is temporarily unavailable')
          )
          .mockResolvedValueOnce({ state: 'Done', data: [frame] }),
      };
      mockDataSourceSrv.get.mockResolvedValue(dataSource);
      const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'query_prometheus');

      const pending = tool.execute('call-1', { query: 'up{job="api"}' }, undefined);
      await runPendingRetryTimers();
      const result = await pending;
      const body = JSON.parse(result.content[0].text);

      expect(dataSource.query).toHaveBeenCalledTimes(2);
      expect(body.validationError).toBeUndefined();
      expect(result.content[0].text).not.toContain('failed after');
      expect(result.details).toMatchObject({ datasourceUid: 'prom-b', summarized: true, totalSeries: 1 });
    } finally {
      jest.useRealTimers();
    }
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

    expect(dataSource.query).toHaveBeenCalledTimes(1);
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

  it('finds App Platform alert rules linked to a dashboard panel', async () => {
    const alertRule = {
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: {
        name: 'high-error-rate',
        annotations: { 'grafana.app/folder': 'service-folder' },
      },
      spec: {
        title: 'High error rate',
        trigger: { interval: '1m' },
        for: '5m',
        noDataState: 'NoData',
        execErrState: 'Error',
        labels: { severity: 'warning' },
        annotations: { __dashboardUid__: 'service-dashboard', __panelId__: '2' },
        panelRef: { dashboardUID: 'service-dashboard', panelID: 2 },
        expressions: {
          A: {
            datasourceUID: 'prom-b',
            relativeTimeRange: { from: '600s', to: '0s' },
            model: {
              refId: 'A',
              expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
              range: true,
            },
          },
          B: {
            model: {
              refId: 'B',
              type: 'reduce',
              expression: 'A',
              reducer: 'last',
            },
          },
          C: {
            source: true,
            model: {
              refId: 'C',
              type: 'threshold',
              expression: 'B',
              conditions: [
                {
                  evaluator: { type: 'gt', params: [0.5] },
                  reducer: { type: 'last' },
                },
              ],
            },
          },
        },
      },
    };
    const fetch = jest.fn((request: { url: string }) => {
      if (request.url === '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules') {
        return of({ data: { items: [alertRule] } });
      }
      if (request.url === '/api/dashboards/uid/service-dashboard') {
        return of({
          data: {
            dashboard: {
              panels: [
                {
                  id: 2,
                  title: '5xx rate',
                  type: 'timeseries',
                  datasource: { uid: 'prom-b', type: 'prometheus' },
                  fieldConfig: {
                    defaults: {
                      thresholds: {
                        mode: 'absolute',
                        steps: [
                          { color: 'green', value: null },
                          { color: 'yellow', value: 0.1 },
                        ],
                      },
                    },
                  },
                  targets: [
                    {
                      refId: 'A',
                      datasource: { uid: 'prom-b', type: 'prometheus' },
                      expr: 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
                    },
                  ],
                },
              ],
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'find_panel_alert_rules');

    const result = await tool.execute(
      'call-alerts',
      { namespace: 'default', dashboardUid: 'service-dashboard', panelId: 2 },
      undefined
    );
    const body = JSON.parse(result.content[0].text);

    expect(result.details).toMatchObject({
      namespace: 'default',
      dashboardUid: 'service-dashboard',
      panelId: '2',
      exactPanelMatchCount: 1,
      matchCount: 1,
    });
    expect(body.dashboardPanel).toMatchObject({
      id: '2',
      title: '5xx rate',
      thresholds: { mode: 'absolute' },
    });
    expect(body.matches[0]).toMatchObject({
      reasons: expect.arrayContaining([
        'panelRef+annotations dashboardUID match',
        'panelRef+annotations panelID match',
        'panel link exact match',
      ]),
      rule: {
        name: 'high-error-rate',
        title: 'High error rate',
        folderUid: 'service-folder',
        conditionRef: 'C',
        panelRef: { dashboardUID: 'service-dashboard', panelID: 2 },
        panelLink: { dashboardUID: 'service-dashboard', panelID: 2, source: 'panelRef+annotations' },
        annotations: { __dashboardUid__: 'service-dashboard', __panelId__: '2' },
        alertCondition: {
          sourceRefId: 'C',
          expression: 'B',
          evaluator: { type: 'gt', params: [0.5] },
          reducer: 'last',
        },
        prometheusChecks: [
          {
            refId: 'A',
            datasourceUid: 'prom-b',
            query: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
            type: 'range',
            start: 'now-600s',
            end: 'now',
          },
        ],
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules',
        method: 'GET',
      })
    );
  });

  it('finds App Platform alert rules linked through Grafana dashboard annotations', async () => {
    const alertRule = {
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: {
        name: 'annotated-error-rate',
        annotations: { 'grafana.app/folder': 'service-folder' },
      },
      spec: {
        title: 'Annotated high error rate',
        trigger: { interval: '1m' },
        noDataState: 'NoData',
        execErrState: 'Error',
        annotations: { __dashboardUid__: 'service-dashboard', __panelId__: '2' },
        expressions: {
          A: {
            datasourceUID: 'prom-b',
            relativeTimeRange: { from: '600s', to: '0s' },
            model: {
              refId: 'A',
              expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
              range: true,
            },
          },
        },
      },
    };
    const fetch = jest.fn((request: { url: string }) => {
      if (request.url === '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules') {
        return of({ data: { items: [alertRule] } });
      }
      if (request.url === '/api/dashboards/uid/service-dashboard') {
        return of({ data: { dashboard: { panels: [{ id: 2, title: '5xx rate', targets: [] }] } } });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'find_panel_alert_rules');

    const result = await tool.execute(
      'call-alerts',
      { namespace: 'default', dashboardUid: 'service-dashboard', panelId: 2 },
      undefined
    );
    const body = JSON.parse(result.content[0].text);

    expect(result.details).toMatchObject({ exactPanelMatchCount: 1, matchCount: 1 });
    expect(body.matches[0]).toMatchObject({
      reasons: expect.arrayContaining([
        'annotations dashboardUID match',
        'annotations panelID match',
        'panel link exact match',
      ]),
      rule: {
        name: 'annotated-error-rate',
        panelLink: { dashboardUID: 'service-dashboard', panelID: 2, source: 'annotations' },
      },
    });
  });

  it('handles unrelated alert rules without Prometheus checks while scanning panel matches', async () => {
    const unrelatedRule = {
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: { name: 'log-alert' },
      spec: {
        title: 'Log alert',
        expressions: {
          A: {
            datasourceUID: 'loki',
            model: { refId: 'A', expr: '{job="server"} |= "down"' },
          },
        },
      },
    };
    const linkedRule = {
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: { name: 'availability-alert' },
      spec: {
        title: 'Availability alert',
        annotations: { __dashboardUid__: 'sample-dashboard', __panelId__: '12' },
        panelRef: { dashboardUID: 'sample-dashboard', panelID: 12 },
        expressions: {
          A: {
            datasourceUID: 'prom-b',
            relativeTimeRange: { from: '300s', to: '0s' },
            model: { refId: 'A', expr: 'avg(sample_availability_state{service="app"})', range: true },
          },
        },
      },
    };
    const fetch = jest.fn((request: { url: string }) => {
      if (request.url === '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules') {
        return of({ data: { items: [unrelatedRule, linkedRule] } });
      }
      if (request.url === '/api/dashboards/uid/sample-dashboard') {
        return of({
          data: {
            dashboard: {
              panels: [
                {
                  id: 12,
                  title: 'Availability',
                  type: 'stat',
                  datasource: { uid: 'prom-b', type: 'prometheus' },
                  targets: [{ refId: 'A', expr: 'avg(sample_availability_state{service="app"})' }],
                },
              ],
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'find_panel_alert_rules');

    const result = await tool.execute(
      'call-alerts',
      { namespace: 'default', dashboardUid: 'sample-dashboard', panelTitle: 'Availability' },
      undefined
    );
    const body = JSON.parse(result.content[0].text);

    expect(result.details).toMatchObject({ matchCount: 1, exactPanelMatchCount: 1 });
    expect(body.matches[0].rule.name).toBe('availability-alert');
  });

  it('summarizes persistent transient query failures after retries are exhausted', async () => {
    jest.useFakeTimers();
    try {
      const dataSource = {
        uid: 'prom-b',
        type: 'prometheus',
        query: jest.fn().mockResolvedValue({
          state: 'Error',
          errors: [{ status: 503, message: '503 Service Unavailable' }],
        }),
      };
      mockDataSourceSrv.get.mockResolvedValue(dataSource);
      const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'query_prometheus');

      const pending = tool.execute('call-1', { query: 'up' }, undefined);
      await runPendingRetryTimers();
      const result = await pending;
      const body = JSON.parse(result.content[0].text);

      expect(dataSource.query).toHaveBeenCalledTimes(3);
      expect(body).toMatchObject({
        datasourceUid: 'prom-b',
        query: 'up',
        frameCount: 0,
        totalSeries: 0,
        validationError: 'Prometheus query for datasource prom-b failed after 3 attempts: 503 Service Unavailable',
        notices: [
          {
            severity: 'error',
            text: 'Prometheus query for datasource prom-b failed after 3 attempts: 503 Service Unavailable',
          },
        ],
        series: [],
      });
      expect(result.details).toMatchObject({
        datasourceUid: 'prom-b',
        validationError: 'Prometheus query for datasource prom-b failed after 3 attempts: 503 Service Unavailable',
        summarized: true,
      });
    } finally {
      jest.useRealTimers();
    }
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

  it('sends Jsonnet source to the dashboard save endpoint', async () => {
    const fetch = jest.fn().mockReturnValue(
      of({
        data: {
          uid: 'direct-jsonnet',
          url: '/d/direct-jsonnet',
          status: 'created',
          sourceChecksum: 'sha256:test',
          validation: {
            warnings: [{ code: 'layout_missing', message: 'Panel was missing a complete gridPos.' }],
            layoutFixes: [{ message: 'Assigned missing gridPos.' }],
          },
        },
      })
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }), 'save_dashboard');
    const source = "{ title: 'Direct Jsonnet', uid: 'direct-jsonnet', panels: [] }";

    const result = await tool.execute('call-1', { dashboard_jsonnet: source }, undefined);

    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/plugins/g42-pi-app/resources/jsonnet-dashboards/save',
        method: 'POST',
        data: { dashboard_jsonnet: source },
        showErrorAlert: false,
      })
    );
    expect(result.content[0].text).toContain('Dashboard created');
    expect(result.details).toMatchObject({
      validation: {
        warnings: [{ code: 'layout_missing' }],
        layoutFixes: [{ message: 'Assigned missing gridPos.' }],
      },
    });
  });

  it('applies the approved folder override to one dashboard save call', async () => {
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
        dashboardSaveFolders: {
          getFolderOverride: jest.fn(() => ({ uid: 'team-folder', title: 'Team folder' })),
          clearFolderOverride,
        },
      }),
      'save_dashboard'
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
        url: '/api/plugins/g42-pi-app/resources/jsonnet-dashboards/jsonnet-files/write',
        data: { sessionId: 'session-tools', path: 'dashboard.jsonnet', content: source },
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: '/api/plugins/g42-pi-app/resources/jsonnet-dashboards/jsonnet-files/edit',
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
        url: '/api/plugins/g42-pi-app/resources/jsonnet-dashboards/jsonnet-files/repair',
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
            validation: {
              warnings: [
                {
                  code: 'table_columns_uncontrolled',
                  message: 'Table panel does not explicitly filter or organize visible columns.',
                  panelId: 1,
                  panelTitle: 'Requests',
                },
              ],
              layoutFixes: [],
            },
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
        url: '/api/plugins/g42-pi-app/resources/jsonnet-dashboards/jsonnet-files/write',
        data: { sessionId: 'session-render', path: 'dashboard.jsonnet', content: source, version: 4 },
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: '/api/plugins/g42-pi-app/resources/jsonnet-dashboards/render',
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
      validation: {
        warnings: [{ code: 'table_columns_uncontrolled', panelTitle: 'Requests' }],
      },
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

  it('surfaces dashboard save backend errors as readable messages', async () => {
    const fetch = jest.fn().mockReturnValue(
      throwError(() => ({
        status: 400,
        statusText: 'Bad Request',
        data: {
          error: 'jsonnet compilation failed: dashboard.jsonnet:3:5-14 Did not expect: (IDENTIFIER, "textPanel")',
        },
        config: {
          method: 'POST',
          url: '/api/plugins/g42-pi-app/resources/jsonnet-dashboards/save',
        },
      }))
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }), 'save_dashboard');

    await expect(tool.execute('call-1', { dashboard_jsonnet: 'let textPanel() = {}' }, undefined)).rejects.toThrow(
      'Grafana request failed (400 Bad Request) while calling POST /api/plugins/g42-pi-app/resources/jsonnet-dashboards/save: jsonnet compilation failed: dashboard.jsonnet:3:5-14 Did not expect: (IDENTIFIER, "textPanel")'
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
      'run_alert_agent',
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
      'run_alert_agent',
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
    expect(names).toContain('find_panel_alert_rules');
    expect(names).toContain('get_alert_rule');
    expect(names).toContain('write_jsonnet');
    expect(names).toContain('edit_jsonnet');
    expect(names).toContain('fix_jsonnet');
    expect(names).toContain('read_jsonnet');
    expect(names).toContain('save_dashboard');
    expect(names).toContain('inspect_dashboard_context');
    expect(names).toContain('screenshot_dashboard');
    expect(names).toContain('run_query_agent');
    expect(names).toContain('run_dashboard_agent');
    expect(names).toContain('run_investigation_agent');
    expect(names).toContain('run_alert_agent');
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

  it('preserves the existing live panel query datasource when editing only the expression', async () => {
    const dashboardMutation = {
      execute: jest.fn(async ({ type, payload }: { type: string; payload: unknown }) => {
        if (type === 'LIST_PANELS') {
          return {
            success: true,
            changes: [],
            data: {
              elements: [
                {
                  element: {
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
                                hidden: true,
                                query: {
                                  kind: 'DataQuery',
                                  group: 'prometheus',
                                  datasource: { name: 'prom-prod' },
                                  spec: { expr: 'sum(rate(old_metric[$__rate_interval]))' },
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              ],
            },
          };
        }

        return {
          success: true,
          changes: [{ path: '/elements/panel-1', previousValue: null, newValue: { type, payload } }],
          data: { ok: true },
        };
      }),
      getPayloadSchema: jest.fn(() => ({}) as any),
      getAvailableCommands: jest.fn(() => ['LIST_PANELS', 'UPDATE_PANEL']),
    };
    const queryTool = getTool(
      createGrafanaToolsForSkillGroups({ dashboardMutation }, ['liveDashboardEditing']),
      'update_live_dashboard_panel_query'
    );

    await queryTool.execute(
      'call-1',
      { elementName: 'panel-1', queryExpression: 'sum(rate(new_metric[$__rate_interval]))' },
      undefined
    );

    expect(dashboardMutation.execute).toHaveBeenNthCalledWith(1, {
      type: 'LIST_PANELS',
      payload: { elements: ['panel-1'] },
    });
    expect(dashboardMutation.execute).toHaveBeenNthCalledWith(2, {
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
                      hidden: true,
                      query: {
                        kind: 'DataQuery',
                        group: 'prometheus',
                        datasource: { name: 'prom-prod' },
                        spec: { expr: 'sum(rate(new_metric[$__rate_interval]))' },
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

  it('handles dashboard panels without targets during context validation', async () => {
    const fetch = jest.fn().mockReturnValue(
      of({
        data: {
          dashboard: {
            uid: 'sample-dashboard',
            title: 'Application Dashboard',
            panels: [
              {
                id: 12,
                title: 'Availability',
                type: 'stat',
                datasource: { uid: 'prom-b', type: 'prometheus' },
              },
            ],
          },
          meta: {
            folderTitle: 'Operations',
            url: '/d/sample-dashboard/application-dashboard',
          },
        },
      })
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }),
      'inspect_dashboard_context'
    );

    const result = await tool.execute('call-1', { uid: 'sample-dashboard', validateQueries: true }, undefined);
    const body = JSON.parse(result.content[0].text);

    expect(body.panels[0]).toMatchObject({
      id: '12',
      title: 'Availability',
      targets: [],
    });
    expect(body.validation).toMatchObject({
      queryCount: 0,
      failedQueries: 0,
      zeroSeriesQueries: 0,
    });
    expect(result.details).toMatchObject({
      uid: 'sample-dashboard',
      panelCount: 1,
      queryCount: 0,
    });
  });

  it('inspects dashboard.grafana.app v2 panel specs from the dashboard response', async () => {
    const fetch = jest.fn().mockReturnValue(
      of({
        data: {
          dashboard: {
            title: 'Application_Overview',
            tags: ['ops'],
            timeSettings: { from: 'now-6h', to: 'now', autoRefresh: '1m' },
            variables: [
              {
                kind: 'QueryVariable',
                spec: {
                  name: 'service',
                  label: 'Service',
                  current: { text: 'app-a', value: 'app-a' },
                  query: { kind: 'DataQuery', spec: { query: 'label_values(service)' } },
                },
              },
            ],
            elements: {
              'panel-12': {
                kind: 'Panel',
                spec: {
                  id: 12,
                  title: 'Availability',
                  description: 'Values above zero indicate an availability issue.',
                  data: {
                    kind: 'QueryGroup',
                    spec: {
                      queries: [
                        {
                          kind: 'PanelQuery',
                          spec: {
                            refId: 'A',
                            hidden: false,
                            query: {
                              kind: 'DataQuery',
                              group: 'prometheus',
                              datasource: { name: 'prom-main' },
                              spec: {
                                expr: 'avg by (service, endpoint) (sample_availability_state{service=~"$service"})',
                              },
                            },
                          },
                        },
                      ],
                      transformations: [],
                      queryOptions: {},
                    },
                  },
                  vizConfig: {
                    kind: 'VizConfig',
                    group: 'timeseries',
                    spec: {
                      fieldConfig: {
                        defaults: {
                          unit: 'short',
                          thresholds: {
                            mode: 'absolute',
                            steps: [
                              { color: 'green', value: 0 },
                              { color: 'red', value: 80 },
                            ],
                          },
                        },
                        overrides: [],
                      },
                    },
                  },
                },
              },
            },
            layout: {
              kind: 'RowsLayout',
              spec: {
                rows: [
                  {
                    kind: 'RowsLayoutRow',
                    spec: {
                      title: 'Overview',
                      layout: {
                        kind: 'GridLayout',
                        spec: {
                          items: [
                            {
                              kind: 'GridLayoutItem',
                              spec: {
                                x: 0,
                                y: 0,
                                width: 12,
                                height: 8,
                                element: { kind: 'ElementReference', name: 'panel-12' },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
          meta: {
            folderTitle: 'Operations',
            url: '/d/sample-dashboard/application-overview',
          },
        },
      })
    );
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-main'] }),
      'inspect_dashboard_context'
    );

    const result = await tool.execute('call-1', { uid: 'sample-dashboard', validateQueries: false }, undefined);
    const body = JSON.parse(result.content[0].text);

    expect(body.dashboard).toMatchObject({
      uid: 'sample-dashboard',
      title: 'Application_Overview',
      refresh: '1m',
    });
    expect(body.variables[0]).toMatchObject({ name: 'service', current: 'app-a' });
    expect(body.panels[0]).toMatchObject({
      id: '12',
      title: 'Availability',
      type: 'timeseries',
      rowPath: ['Overview'],
      gridPos: { x: 0, y: 0, w: 12, h: 8 },
      fieldConfig: {
        unit: 'short',
        thresholds: { mode: 'absolute' },
      },
    });
    expect(body.panels[0].targets[0]).toMatchObject({
      refId: 'A',
      datasourceUid: 'prom-main',
      datasourceType: 'prometheus',
      queryKind: 'expr',
    });
    expect(body.panels[0].targets[0].query).toContain('sample_availability_state');
  });

  it('extracts dashboard metric usage with PromQL parser-backed labels and relations', () => {
    const result = extractDashboardMetricUsage(makeDashboardMetricUsageFixture('metric-context', 'Metric Context'), {
      uid: 'metric-context',
      meta: {
        folderTitle: 'Observability',
        url: '/d/metric-context/metric-context',
      },
      allowedPrometheusDatasourceUids: ['prom-a'],
    });

    expect(result.metrics.map((metric) => metric.metric)).toEqual(
      expect.arrayContaining(['http_requests_total', 'http_request_duration_seconds_bucket', 'node_load1'])
    );
    expect(result.metrics.find((metric) => metric.metric === 'http_requests_total')).toMatchObject({
      labels: expect.arrayContaining(['route', 'status']),
      groupingLabels: expect.arrayContaining(['route', 'status', 'vm']),
      functions: expect.arrayContaining(['rate', 'sum']),
      dashboardCount: 1,
    });
    expect(result.usages.find((usage) => usage.metric === 'http_requests_total')).toMatchObject({
      datasourceUid: 'prom-a',
      dashboardUid: 'metric-context',
      panelTitle: 'HTTP errors and host load',
      selector: 'http_requests_total{status=~"5..",route="$route"}',
    });
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'http_requests_total',
          target: 'node_load1',
          reasons: expect.arrayContaining(['same panel']),
        }),
      ])
    );
  });

  it('extracts dashboard metric usage from dashboard.grafana.app v2 specs', () => {
    const result = extractDashboardMetricUsage(makeDashboardMetricUsageV2Fixture('Metric Context V2'), {
      uid: 'metric-context-v2',
      meta: {
        folderTitle: 'Observability',
        url: '/d/metric-context-v2/metric-context-v2',
      },
      allowedPrometheusDatasourceUids: ['prom-main'],
    });

    expect(result.dashboard).toMatchObject({
      uid: 'metric-context-v2',
      title: 'Metric Context V2',
      folderTitle: 'Observability',
    });
    expect(result.metrics.map((metric) => metric.metric)).toEqual(
      expect.arrayContaining(['sample_requests_total', 'sample_request_duration_seconds_bucket'])
    );
    expect(result.usages.find((usage) => usage.metric === 'sample_requests_total')).toMatchObject({
      datasourceUid: 'prom-main',
      datasourceType: 'prometheus',
      panelTitle: 'HTTP requests',
      panelType: 'timeseries',
      rowPath: ['Overview'],
      refId: 'A',
      unit: 'reqps',
      selector: 'sample_requests_total{status=~"5..",service="$service"}',
    });
  });

  it('inspects dashboard metric usage from dashboard.grafana.app v2 resource responses', async () => {
    const fetch = jest.fn(({ url }) => {
      if (url === '/api/dashboards/uid/metric-context-v2') {
        return of({
          data: {
            metadata: { name: 'metric-context-v2' },
            spec: makeDashboardMetricUsageV2Fixture('Metric Context V2'),
            meta: {
              folderTitle: 'Observability',
              url: '/d/metric-context-v2/metric-context-v2',
            },
          },
        });
      }

      return throwError(() => new Error(`unexpected fetch: ${url}`));
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-main'] }),
      'inspect_dashboard_metric_usage'
    );

    const result = await tool.execute('call-1', { uid: 'metric-context-v2' }, undefined);
    const body = JSON.parse(result.content[0].text);

    expect(body.metrics.map((metric: { metric: string }) => metric.metric)).toContain('sample_requests_total');
    expect(body.usages[0]).toMatchObject({
      dashboardUid: 'metric-context-v2',
      panelTitle: 'HTTP requests',
      datasourceUid: 'prom-main',
    });
    expect(result.details).toMatchObject({
      uid: 'metric-context-v2',
      title: 'Metric Context V2',
      metricCount: 2,
      usageCount: 2,
    });
  });

  it('searches visible dashboards for metric usage and ranks seed metric neighborhoods', async () => {
    const fetch = jest.fn(({ url }) => {
      if (url === '/api/search') {
        return of({
          data: [
            {
              uid: 'metric-context',
              title: 'Metric Context',
              url: '/d/metric-context/metric-context',
              folderTitle: 'Observability',
            },
            {
              uid: 'infra-context',
              title: 'Infra Context',
              url: '/d/infra-context/infra-context',
              folderTitle: 'Observability',
            },
          ],
        });
      }

      if (url === '/api/dashboards/uid/metric-context') {
        return of({
          data: {
            dashboard: makeDashboardMetricUsageFixture('metric-context', 'Metric Context'),
            meta: {
              folderTitle: 'Observability',
              url: '/d/metric-context/metric-context',
            },
          },
        });
      }

      if (url === '/api/dashboards/uid/infra-context') {
        return of({
          data: {
            dashboard: {
              uid: 'infra-context',
              title: 'Infra Context',
              panels: [
                {
                  id: 1,
                  title: 'CPU busy',
                  type: 'timeseries',
                  datasource: { uid: 'prom-a', type: 'prometheus' },
                  targets: [
                    {
                      refId: 'A',
                      expr: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])) * 100)',
                    },
                  ],
                },
              ],
            },
            meta: {
              folderTitle: 'Observability',
              url: '/d/infra-context/infra-context',
            },
          },
        });
      }

      return throwError(() => new Error(`unexpected fetch: ${url}`));
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    const searchTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'search_dashboard_metric_usage'
    );
    const search = await searchTool.execute(
      'call-1',
      { query: 'Context', seedMetric: 'http_requests_total' },
      undefined
    );
    const searchBody = JSON.parse(search.content[0].text);

    expect(searchBody.dashboards).toHaveLength(2);
    expect(searchBody.metrics.map((metric: { metric: string }) => metric.metric)).toEqual(
      expect.arrayContaining([
        'http_requests_total',
        'http_request_duration_seconds_bucket',
        'node_load1',
        'node_cpu_seconds_total',
      ])
    );
    expect(search.details).toMatchObject({
      dashboardCount: 2,
      seedMetrics: ['http_requests_total'],
      summarized: true,
    });

    const neighborhoodTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'get_metric_neighborhood'
    );
    const neighborhood = await neighborhoodTool.execute(
      'call-2',
      { metric: 'http_requests_total', query: 'Context' },
      undefined
    );
    const neighborhoodBody = JSON.parse(neighborhood.content[0].text);

    expect(neighborhoodBody.neighbors.map((metric: { metric: string }) => metric.metric)).toEqual(
      expect.arrayContaining(['http_request_duration_seconds_bucket', 'node_load1'])
    );
    expect(neighborhood.details).toMatchObject({
      seedMetrics: ['http_requests_total'],
      dashboardCount: 2,
      summarized: true,
    });
  });

  it('returns stable empty arrays when dashboard metric search has no matches', async () => {
    const fetch = jest.fn(({ url }) => {
      if (url === '/api/search') {
        return of({ data: [] });
      }

      return throwError(() => new Error(`unexpected fetch: ${url}`));
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    const searchTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'search_dashboard_metric_usage'
    );
    const search = await searchTool.execute(
      'call-1',
      { query: 'Missing Context', seedMetric: 'http_requests_total' },
      undefined
    );
    const searchBody = JSON.parse(search.content[0].text);

    expect(searchBody).toMatchObject({
      seedMetrics: ['http_requests_total'],
      dashboards: [],
      metrics: [],
      usages: [],
      relations: [],
    });
    expect(search.details).toMatchObject({
      dashboardCount: 0,
      metricCount: 0,
      usageCount: 0,
      relationCount: 0,
      seedMetrics: ['http_requests_total'],
    });

    const neighborhoodTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'get_metric_neighborhood'
    );
    const neighborhood = await neighborhoodTool.execute(
      'call-2',
      { metric: 'http_requests_total', query: 'Missing Context' },
      undefined
    );
    const neighborhoodBody = JSON.parse(neighborhood.content[0].text);

    expect(neighborhoodBody).toMatchObject({
      seedMetrics: ['http_requests_total'],
      dashboards: [],
      neighbors: [],
      relations: [],
      usages: [],
    });
    expect(neighborhood.details).toMatchObject({
      seedMetrics: ['http_requests_total'],
      dashboardCount: 0,
      neighborCount: 0,
      relationCount: 0,
    });
  });

  it('relaxes dashboard metric search for non-contiguous dashboard title terms', async () => {
    const fetch = jest.fn(({ url, params }) => {
      if (url === '/api/search' && params?.query === 'Metric Context abc123') {
        return of({ data: [] });
      }

      if (url === '/api/search' && params?.query === 'metric context') {
        return of({
          data: [
            {
              uid: 'metric-context-service-abc123',
              title: 'Metric Context Service abc123',
              url: '/d/metric-context-service-abc123/metric-context-service-abc123',
              folderTitle: 'Observability',
            },
          ],
        });
      }

      if (url === '/api/dashboards/uid/metric-context-service-abc123') {
        return of({
          data: {
            dashboard: makeDashboardMetricUsageFixture(
              'metric-context-service-abc123',
              'Metric Context Service abc123'
            ),
            meta: {
              folderTitle: 'Observability',
              url: '/d/metric-context-service-abc123/metric-context-service-abc123',
            },
          },
        });
      }

      return throwError(() => new Error(`unexpected fetch: ${url}`));
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    const searchTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'search_dashboard_metric_usage'
    );
    const search = await searchTool.execute(
      'call-1',
      { query: 'Metric Context abc123', seedMetric: 'http_requests_total' },
      undefined
    );
    const body = JSON.parse(search.content[0].text);

    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/search' }));
    expect(body.dashboards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uid: 'metric-context-service-abc123',
          title: 'Metric Context Service abc123',
        }),
      ])
    );
    expect(body.metrics.map((metric: { metric: string }) => metric.metric)).toContain('http_requests_total');
    expect(search.details).toMatchObject({ dashboardCount: 1, metricCount: expect.any(Number) });
  });

  it('normalizes dashboard metric context tool arguments before validation', () => {
    const searchTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'search_dashboard_metric_usage'
    );
    expect(
      searchTool.prepareArguments?.({
        query: ['Metric', 'Context'],
        seedMetrics: 'http_requests_total',
        maxDashboards: '2',
      })
    ).toMatchObject({
      query: 'Metric Context',
      seedMetrics: ['http_requests_total'],
      maxDashboards: 2,
    });

    const neighborhoodTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'get_metric_neighborhood'
    );
    expect(
      neighborhoodTool.prepareArguments?.({
        seedMetric: 'http_requests_total',
        metrics: 'node_load1,node_cpu_seconds_total',
        uid: 'metric-context',
      })
    ).toMatchObject({
      metric: 'http_requests_total',
      metrics: ['node_load1', 'node_cpu_seconds_total'],
      dashboardUid: 'metric-context',
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
      ['metrics', 'dashboardMetricContext', 'subagents']
    ).map((tool) => tool.name);

    expect(names).toContain('list_datasources');
    expect(names).toContain('query_prometheus');
    expect(names).toContain('search_dashboard_metric_usage');
    expect(names).toContain('get_metric_neighborhood');
    expect(names).toContain('run_query_agent');
    expect(names).toContain('run_dashboard_agent');
    expect(names).toContain('run_investigation_agent');
    expect(names).toContain('run_support_agent');
    expect(names).toContain('run_navigation_agent');
    expect(names).not.toContain('write_jsonnet');
    expect(names).not.toContain('render_dashboard');
    expect(names).not.toContain('save_dashboard');
    expect(names).not.toContain('get_dashboard');
    expect(names).not.toContain('screenshot_dashboard');
  });

  it('adds Jsonnet dashboard tools when the dashboard skill group is selected', () => {
    const names = createGrafanaToolsForSkillGroups(
      {
        runtime: {
          model: {} as any,
          streamFn: jest.fn() as any,
          thinkingLevel: 'off',
        },
      },
      ['metrics', 'dashboardRead', 'jsonnetFiles', 'jsonnetDashboards', 'subagents']
    ).map((tool) => tool.name);

    expect(names).toContain('query_prometheus');
    expect(names).toContain('write_jsonnet');
    expect(names).toContain('render_dashboard');
    expect(names).toContain('save_dashboard');
    expect(names).toContain('get_dashboard');
    expect(names).toContain('inspect_dashboard_context');
    expect(names).toContain('screenshot_dashboard');
    expect(names).toContain('run_dashboard_agent');
    expect(names).not.toContain('design_dashboard');
    expect(names).not.toContain('upload_dashboard');
    expect(names).not.toContain('delete_dashboard');
  });

  it('runs the dashboard agent with Jsonnet dashboard child tools', async () => {
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
        'search_dashboard_metric_usage',
        'get_metric_neighborhood',
        'write_jsonnet',
        'edit_jsonnet',
        'fix_jsonnet',
        'read_jsonnet',
        'render_dashboard',
        'save_dashboard',
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

  it('runs the alert agent with read-only alert, dashboard, and Prometheus child tools', async () => {
    const registry = createGrafanaToolRegistry({
      skillTools: createSkillTools(GRAFANA_SKILLS),
      runtime: {
        model: {} as any,
        streamFn: jest.fn() as any,
        thinkingLevel: 'off',
      },
    });
    const tool = getTool(registry.subagents, 'run_alert_agent');

    const result = await tool.execute(
      'call-1',
      {
        task: 'Troubleshoot why the linked alert is firing.',
        datasourceUid: 'prom-b',
        dashboardUid: 'service-dashboard',
        panelId: '2',
      },
      undefined
    );
    const call = jest.mocked(runSpecialistAgent).mock.calls.at(-1)?.[0];
    const childToolNames = call?.tools.map((childTool) => childTool.name) ?? [];

    expect(call).toMatchObject({
      kind: 'alerts',
      task: expect.stringContaining('Troubleshoot why the linked alert is firing.'),
    });
    expect(call?.task).toContain('Prefer datasource UID: prom-b.');
    expect(call?.task).toContain('Dashboard UID: service-dashboard.');
    expect(call?.task).toContain('Panel ID: 2.');
    expect(result.details).toMatchObject({ agent: 'alerts', status: 'completed' });
    expect(childToolNames).toEqual(
      expect.arrayContaining([
        'find_panel_alert_rules',
        'get_alert_rule',
        'inspect_dashboard_context',
        'search_dashboard_metric_usage',
        'query_prometheus',
        'read_skill_resource',
      ])
    );
    expect(childToolNames).not.toContain('upload_dashboard');
    expect(childToolNames).not.toContain('delete_dashboard');
    expect(childToolNames).not.toContain('save_dashboard');
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
    await expect(
      tool.execute('call-example', { skill: 'grafana-dashboard', path: 'references/example.md' }, undefined)
    ).resolves.toMatchObject({
      details: { skill: 'grafana-dashboard', path: 'references/example.md', truncated: false },
    });
    await expect(
      tool.execute('call-template', { skill: 'grafana-dashboard', path: 'templates/prometheus.md' }, undefined)
    ).resolves.toMatchObject({
      details: { skill: 'grafana-dashboard', path: 'templates/prometheus.md', truncated: false },
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

async function runPendingRetryTimers() {
  await Promise.resolve();
  await jest.runAllTimersAsync();
}

function grafanaFetchError(status: number, statusText: string, message: string) {
  return {
    status,
    statusText,
    data: { message },
    config: { method: 'GET', url: 'api/v1/label/__name__/values' },
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

function makeDashboardMetricUsageFixture(uid: string, title: string) {
  return {
    uid,
    title,
    tags: ['metric-context'],
    templating: {
      list: [
        {
          name: 'route',
          type: 'custom',
          current: { text: '/render/report', value: '/render/report' },
          query: '/,/render/report',
        },
      ],
    },
    panels: [
      {
        id: 1,
        title: 'HTTP errors and host load',
        type: 'timeseries',
        datasource: { uid: 'prom-a', type: 'prometheus' },
        fieldConfig: { defaults: { unit: 'reqps' } },
        targets: [
          {
            refId: 'A',
            expr: 'sum by (vm, route, status) (rate(http_requests_total{status=~"5..",route="$route"}[$__rate_interval]))',
            legendFormat: '{{vm}} {{route}} {{status}}',
          },
          {
            refId: 'B',
            expr: 'avg by(instance) (node_load1{job="node"})',
            legendFormat: '{{instance}} load',
          },
        ],
      },
      {
        id: 2,
        title: 'Route p95 latency',
        type: 'timeseries',
        datasource: { uid: 'prom-a', type: 'prometheus' },
        fieldConfig: { defaults: { unit: 's' } },
        targets: [
          {
            refId: 'A',
            expr: 'histogram_quantile(0.95, sum by (le, vm, route) (rate(http_request_duration_seconds_bucket{route="$route"}[$__rate_interval])))',
            legendFormat: '{{vm}} {{route}}',
          },
        ],
      },
    ],
  };
}

function makeDashboardMetricUsageV2Fixture(title: string) {
  return {
    title,
    tags: ['metric-context'],
    timeSettings: { from: 'now-6h', to: 'now', autoRefresh: '1m' },
    elements: {
      'panel-1': {
        kind: 'Panel',
        spec: {
          id: 1,
          title: 'HTTP requests',
          description: 'Sample request volume and errors.',
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
                      datasource: { name: 'prom-main' },
                      spec: {
                        expr: 'sum by (service, status) (rate(sample_requests_total{status=~"5..",service="$service"}[$__rate_interval]))',
                        legendFormat: '{{service}} {{status}}',
                      },
                    },
                  },
                },
                {
                  kind: 'PanelQuery',
                  spec: {
                    refId: 'B',
                    query: {
                      kind: 'DataQuery',
                      group: 'prometheus',
                      datasource: { name: 'prom-main' },
                      spec: {
                        expr: 'histogram_quantile(0.95, sum by (le, service) (rate(sample_request_duration_seconds_bucket{service="$service"}[$__rate_interval])))',
                        legendFormat: '{{service}} p95',
                      },
                    },
                  },
                },
              ],
              transformations: [],
              queryOptions: {},
            },
          },
          vizConfig: {
            kind: 'VizConfig',
            group: 'timeseries',
            spec: {
              fieldConfig: {
                defaults: { unit: 'reqps' },
                overrides: [],
              },
            },
          },
        },
      },
    },
    layout: {
      kind: 'RowsLayout',
      spec: {
        rows: [
          {
            kind: 'RowsLayoutRow',
            spec: {
              title: 'Overview',
              layout: {
                kind: 'GridLayout',
                spec: {
                  items: [
                    {
                      kind: 'GridLayoutItem',
                      spec: {
                        x: 0,
                        y: 0,
                        width: 24,
                        height: 8,
                        element: { kind: 'ElementReference', name: 'panel-1' },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
    variables: [
      {
        kind: 'QueryVariable',
        spec: {
          name: 'service',
          current: { text: 'app-a', value: 'app-a' },
          query: {
            kind: 'DataQuery',
            group: 'prometheus',
            datasource: { name: 'prom-main' },
            spec: { query: 'label_values(sample_requests_total, service)' },
          },
        },
      },
    ],
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
