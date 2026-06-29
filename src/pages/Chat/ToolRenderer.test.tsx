import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContentBlocks, ToolResultMessageBody } from './ToolRenderer';

jest.mock('@grafana/scenes', () => {
  const React = jest.requireActual<typeof import('react')>('react');

  class MockSceneObject {
    state: any;

    constructor(state: any) {
      this.state = state;
    }

    get Component() {
      return (this.constructor as any).Component;
    }
  }

  class EmbeddedScene extends MockSceneObject {
    static Component = ({ model }: { model: any }) => {
      const state = panelState(model);
      return React.createElement(
        'div',
        { 'data-testid': 'mock-embedded-scene' },
        state?.title ?? 'scene',
        state?.headerActions
      );
    };
  }

  class SceneFlexLayout extends MockSceneObject {}
  class SceneFlexItem extends MockSceneObject {}
  class SceneQueryRunner extends MockSceneObject {}
  class SceneTimeRange extends MockSceneObject {}

  function panelState(model: any) {
    return model.state?.body?.state?.children?.[0]?.state?.body?.state;
  }

  function timeseriesBuilder() {
    const state: Record<string, unknown> = {};
    const builder = {
      setTitle(title: string) {
        state.title = title;
        return builder;
      },
      setDescription(description: string) {
        state.description = description;
        return builder;
      },
      setColor(color: unknown) {
        state.color = color;
        return builder;
      },
      setNoValue(noValue: string) {
        state.noValue = noValue;
        return builder;
      },
      setHeaderActions(headerActions: React.ReactNode) {
        state.headerActions = headerActions;
        return builder;
      },
      setData(data: unknown) {
        state.data = data;
        return builder;
      },
      build() {
        return { state };
      },
    };

    return builder;
  }

  return {
    EmbeddedScene,
    PanelBuilders: {
      timeseries: timeseriesBuilder,
    },
    SceneFlexItem,
    SceneFlexLayout,
    SceneQueryRunner,
    SceneTimeRange,
  };
});

describe('ToolRenderer', () => {
  it('renders write_jsonnet arguments as a virtual Jsonnet file', () => {
    const source = "local dashboard = {\n  title: 'CPU',\n};";

    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'write_jsonnet',
            arguments: {
              path: 'dashboard.jsonnet',
              content: source,
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('Created');
    expect(container.textContent).toContain('dashboard.jsonnet');
    expect(container.textContent).toContain('local dashboard = {');
    expect(container.textContent).toContain("title: 'CPU'");
    expect(container.textContent).not.toContain('"content"');
    expect(container.textContent).not.toContain('\\n');
    expect(screen.getByTestId('brackets-curly')).toBeInTheDocument();
  });

  it('renders tool category icons in generic tool call headers', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'list_metrics',
            arguments: {},
          },
        ]}
      />
    );

    expect(screen.getByTestId('list-ul')).toBeInTheDocument();
    expect(screen.getByText('list_metrics')).toBeInTheDocument();
    expect(container.textContent).toContain('List metric names | default datasource');
    expect(container.textContent).not.toContain('{}');
  });

  it('renders empty discovery tool calls as intent summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'list_datasources',
            arguments: {},
          },
          {
            type: 'toolCall',
            name: 'list_dashboards',
            arguments: {},
          },
          {
            type: 'toolCall',
            name: 'list_grafonnet',
            arguments: {},
          },
        ]}
      />
    );

    expect(container.textContent).toContain('Discover Prometheus datasources');
    expect(container.textContent).toContain('List dashboards');
    expect(container.textContent).toContain('List Jsonnet library files');
    expect(container.textContent).not.toContain('{}');
  });

  it('renders inspection tool arguments as readable summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'list_label_values',
            arguments: {
              datasourceUid: 'prometheus',
              label: 'job',
              match: 'http_requests_total',
            },
          },
          {
            type: 'toolCall',
            name: 'inspect_metric_series',
            arguments: {
              match: 'up{job="api"}',
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('List label values | label job | datasource prometheus');
    expect(container.textContent).toContain('Inspect metric series | selector provided | default datasource');
    expect(container.textContent).toContain('up{job="api"}');
    expect(container.textContent).not.toContain('"label"');
    expect(container.textContent).not.toContain('"match"');
  });

  it('renders batched metric discovery arguments as readable summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'list_metrics',
            arguments: {
              datasourceUid: 'prometheus',
              prefixes: ['http', 'node_'],
            },
          },
          {
            type: 'toolCall',
            name: 'inspect_metric_series',
            arguments: {
              matches: ['http_requests_total', 'node_load1'],
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('List metric names | 2 prefixes | datasource prometheus');
    expect(container.textContent).toContain('http, node_');
    expect(container.textContent).toContain('Inspect metric series | 2 selectors | default datasource');
    expect(container.textContent).toContain('http_requests_total, node_load1');
    expect(container.textContent).not.toContain('"prefixes"');
    expect(container.textContent).not.toContain('"matches"');
  });

  it('renders query_prometheus_raw arguments with the Prometheus query plan', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'query_prometheus_raw',
            arguments: {
              datasourceUid: 'prometheus',
              query: 'up',
              type: 'instant',
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('1 instant query | datasource prometheus');
    expect(container.textContent).toContain('Query 1');
    expect(container.textContent).toContain('up');
    expect(container.textContent).not.toContain('"query"');
  });

  it('renders dashboard and Jsonnet tool calls as summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'render_dashboard',
            arguments: {
              uid: 'service-health',
              panelId: 4,
            },
          },
          {
            type: 'toolCall',
            name: 'screenshot_dashboard',
            arguments: {
              uid: 'service-health',
              width: 1200,
              height: 800,
            },
          },
          {
            type: 'toolCall',
            name: 'inspect_dashboard_context',
            arguments: {
              uid: 'service-health',
            },
          },
          {
            type: 'toolCall',
            name: 'search_grafonnet',
            arguments: {
              query: 'timeseries panel',
            },
          },
          {
            type: 'toolCall',
            name: 'edit_jsonnet',
            arguments: {
              path: 'dashboards/service.jsonnet',
              startLine: 10,
              endLine: 12,
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('Render dashboard | service-health');
    expect(container.textContent).toContain('Capture dashboard screenshot | service-health');
    expect(container.textContent).toContain('Inspect dashboard context | service-health');
    expect(container.textContent).toContain('1200 x 800');
    expect(container.textContent).toContain('Search Jsonnet libraries | timeseries panel');
    expect(container.textContent).toContain('Edit Jsonnet source | dashboards/service.jsonnet');
    expect(container.textContent).toContain('10-12');
    expect(container.textContent).not.toContain('"uid"');
    expect(container.textContent).not.toContain('"path"');
  });

  it('renders live dashboard schema tool calls as summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'get_live_dashboard_mutation_schema',
            arguments: {
              command: 'UPDATE_PANEL',
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('Get live dashboard mutation schema | UPDATE_PANEL');
    expect(container.textContent).not.toContain('"command"');
    expect(screen.getByTestId('book')).toBeInTheDocument();
  });

  it('renders batched query_prometheus arguments as a compact query plan', () => {
    const queries = [
      {
        query: 'rate(http_requests_total{status=~"5.."}[5m])',
        type: 'range',
        start: 'now-6h',
        end: 'now',
      },
      {
        query: 'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))',
        type: 'range',
        start: 'now-6h',
        end: 'now',
      },
      {
        query: 'rate(node_cpu_seconds_total{mode="idle"}[5m])',
        type: 'range',
        start: 'now-6h',
        end: 'now',
      },
    ];

    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'query_prometheus',
            arguments: { queries },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('3 range queries | now-6h -> now | default datasource');
    expect(container.textContent).toContain('Query 1');
    expect(container.textContent).toContain('Query 2');
    expect(container.textContent).toContain('Query 3');
    expect(container.textContent).toContain('rate(http_requests_total{status=~"5.."}[5m])');
    expect(container.textContent).toContain('histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))');
    expect(container.textContent).toContain('rate(node_cpu_seconds_total{mode="idle"}[5m])');
    expect(container.textContent).toContain('range | now-6h -> now');
    expect(container.textContent).not.toContain('"queries"');
    expect(container.textContent).not.toContain('"start"');
    expect(screen.getByTestId('gf-prometheus')).toBeInTheDocument();
  });

  it('renders streaming write_jsonnet content from partial JSON arguments', () => {
    const partialJson = '{"path":"service.jsonnet","content":"local title = \\"Errors\\";\\n{ title: title';

    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'write_jsonnet',
            arguments: {},
            partialJson,
          },
        ]}
        isStreaming
      />
    );

    expect(container.textContent).toContain('Writing');
    expect(container.textContent).toContain('service.jsonnet');
    expect(container.textContent).toContain('local title = "Errors";');
    expect(container.textContent).toContain('{ title: title');
    expect(container.textContent).not.toContain('"content"');
  });

  it('collapses completed query-agent output by default', () => {
    const details = {
      type: 'subagent',
      agent: 'query',
      status: 'completed',
      task: 'Find availability metrics.',
      toolNames: ['list_metrics'],
      toolCalls: [
        {
          id: 'tool-1',
          name: 'list_metrics',
          args: {},
          status: 'completed',
          text: 'up',
        },
      ],
      usage: {
        turns: 1,
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
        cost: 0,
      },
      finalOutput: 'Use up for availability.',
    };

    const { container } = render(
      <ToolResultMessageBody
        toolName="run_query_agent"
        content={[{ type: 'text', text: 'Use up for availability.' }]}
        details={details}
      />
    );

    const result = screen.getByTestId('subagent-result') as HTMLDetailsElement;
    expect(result.open).toBe(false);
    expect(screen.getByText('Query agent result')).toBeInTheDocument();
    expect(screen.getByTestId('angle-right')).toBeInTheDocument();
    expect(container.textContent).toContain('Query agent');
    expect(container.textContent).toContain('list_metrics');

    fireEvent.click(screen.getByText('Query agent result'));

    expect(result.open).toBe(true);
    expect(screen.getByTestId('angle-down')).toBeInTheDocument();
  });

  it('renders nested query-agent Prometheus results with the structured renderer', () => {
    const rangeQuery = 'rate(http_requests_total[5m])';
    const instantQuery = 'up';
    const batchResult = {
      datasourceUid: 'prometheus',
      queryCount: 2,
      truncatedQueries: false,
      results: [
        {
          datasourceUid: 'prometheus',
          query: rangeQuery,
          queryType: 'range',
          interval: '30s',
          range: {
            from: '2026-05-28T10:00:00.000Z',
            to: '2026-05-28T11:00:00.000Z',
            raw: { from: 'now-1h', to: 'now' },
          },
          frameCount: 1,
          totalSeries: 1,
          truncatedSeries: false,
          notices: [],
          executedQueryStrings: [],
          series: [
            {
              name: 'http_requests_total',
              labels: { job: 'api' },
              points: 120,
              nonNullPoints: 120,
              nullPoints: 0,
              last: { value: 2 },
            },
          ],
        },
        {
          datasourceUid: 'prometheus',
          query: instantQuery,
          queryType: 'instant',
          interval: '1m',
          frameCount: 1,
          totalSeries: 1,
          truncatedSeries: false,
          notices: [],
          executedQueryStrings: [],
          series: [
            {
              name: 'up{job="api"}',
              labels: { job: 'api' },
              points: 1,
              nonNullPoints: 1,
              nullPoints: 0,
              last: { value: 1 },
            },
          ],
        },
      ],
    };
    const details = {
      type: 'subagent',
      agent: 'query',
      status: 'completed',
      task: 'Validate PromQL.',
      toolNames: ['query_prometheus'],
      toolCalls: [
        {
          id: 'tool-1',
          name: 'query_prometheus',
          args: {
            datasourceUid: 'prometheus',
            queries: [
              { query: rangeQuery, type: 'range', start: 'now-1h', end: 'now' },
              { query: instantQuery, type: 'instant' },
            ],
          },
          status: 'completed',
          text: JSON.stringify(batchResult, null, 2),
        },
      ],
      usage: {
        turns: 1,
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
        cost: 0,
      },
      finalOutput: 'PromQL validated.',
    };

    const { container } = render(
      <ToolResultMessageBody
        toolName="run_query_agent"
        content={[{ type: 'text', text: 'PromQL validated.' }]}
        details={details}
      />
    );

    expect(screen.queryByTestId('prometheus-timeseries-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('query_prometheus'));

    expect(container.textContent).toContain('2 of 2 Prometheus queries summarized');
    expect(container.textContent).toContain('Query 1');
    expect(container.textContent).toContain(rangeQuery);
    expect(container.textContent).toContain('range | 1 series | 30s');
    expect(screen.getByTestId('prometheus-timeseries-panel')).toBeInTheDocument();
    expect(container.textContent).not.toContain('"queryCount"');
  });

  it('renders artifactized nested query-agent Prometheus range batches with a live panel', () => {
    const rangeQuery = 'rate(http_requests_total[5m])';
    const instantQuery = 'up';
    const artifactPreviewData = {
      datasourceUid: 'prometheus',
      queryCount: 2,
      truncatedQueries: false,
      results: [
        {
          query: rangeQuery,
          queryType: 'range',
          interval: '30s',
          range: {
            from: '2026-05-28T10:00:00.000Z',
            to: '2026-05-28T11:00:00.000Z',
            raw: { from: 'now-1h', to: 'now' },
          },
          frameCount: 1,
          totalSeries: 1,
          truncatedSeries: false,
          notices: [],
          executedQueryStrings: [],
          series: [
            {
              name: 'http_requests_total',
              labels: { job: 'api' },
              points: 120,
              nonNullPoints: 120,
              nullPoints: 0,
              last: { value: 2 },
            },
          ],
        },
        {
          query: instantQuery,
          queryType: 'instant',
          interval: '1m',
          frameCount: 1,
          totalSeries: 1,
          truncatedSeries: false,
          notices: [],
          executedQueryStrings: [],
          series: [
            {
              name: 'up{job="api"}',
              labels: { job: 'api' },
              points: 1,
              nonNullPoints: 1,
              nullPoints: 0,
              last: { value: 1 },
            },
          ],
        },
      ],
    };
    const details = {
      type: 'subagent',
      agent: 'query',
      status: 'completed',
      task: 'Validate PromQL.',
      toolNames: ['query_prometheus'],
      toolCalls: [
        {
          id: 'tool-1',
          name: 'query_prometheus',
          args: {
            datasourceUid: 'prometheus',
            queries: [
              { query: rangeQuery, type: 'range', start: 'now-1h', end: 'now' },
              { query: instantQuery, type: 'instant' },
            ],
          },
          status: 'completed',
          result: {
            content: [{ type: 'text', text: 'Stored artifact [artifact: artifact_1] query_prometheus' }],
            details: {
              datasourceUid: 'prometheus',
              queries: 2,
              summarized: true,
              batch: true,
              artifactRef: {
                id: 'artifact_1',
                kind: 'json',
                title: 'query_prometheus',
                toolName: 'query_prometheus',
                createdAt: '2026-06-05T00:00:00.000Z',
                bytes: 8192,
                summary: '2 Prometheus queries summarized.',
              },
              artifactPreview: {
                type: 'json',
                data: artifactPreviewData,
                truncated: true,
              },
            },
          },
          isError: false,
        },
      ],
      usage: {
        turns: 1,
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
        cost: 0,
      },
      finalOutput: 'PromQL validated.',
    };

    const { container } = render(
      <ToolResultMessageBody
        toolName="run_query_agent"
        content={[{ type: 'text', text: 'PromQL validated.' }]}
        details={details}
      />
    );

    expect(screen.queryByTestId('prometheus-timeseries-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('query_prometheus'));

    expect(screen.getByTestId('artifact-result')).toBeInTheDocument();
    expect(container.textContent).toContain('2 of 2 Prometheus queries summarized');
    expect(container.textContent).toContain('Query 1');
    expect(container.textContent).toContain(rangeQuery);
    expect(container.textContent).toContain('range | 1 series | 30s');
    expect(screen.getByTestId('prometheus-timeseries-panel')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Stored artifact [artifact: artifact_1]');
  });

  it('renders artifactized nested query-agent instant batches with live panels from tool args', () => {
    const instantQuery = 'up';
    const details = {
      type: 'subagent',
      agent: 'query',
      status: 'completed',
      task: 'Validate PromQL.',
      toolNames: ['query_prometheus'],
      toolCalls: [
        {
          id: 'tool-1',
          name: 'query_prometheus',
          args: {
            datasourceUid: 'prometheus',
            queries: [{ query: instantQuery, type: 'instant' }],
          },
          status: 'completed',
          result: {
            content: [{ type: 'text', text: 'Stored artifact [artifact: artifact_1] query_prometheus' }],
            details: {
              datasourceUid: 'prometheus',
              queries: 1,
              summarized: true,
              batch: true,
              artifactRef: {
                id: 'artifact_1',
                kind: 'json',
                title: 'query_prometheus',
                toolName: 'query_prometheus',
                createdAt: '2026-06-05T00:00:00.000Z',
                bytes: 4096,
                summary: '1 Prometheus query summarized.',
              },
              artifactPreview: {
                type: 'json',
                data: {
                  datasourceUid: 'prometheus',
                  queryCount: 1,
                  truncatedQueries: false,
                  results: [
                    {
                      query: instantQuery,
                      totalSeries: 1,
                      series: [
                        {
                          name: 'up{job="api"}',
                          labels: { job: 'api' },
                          last: { value: 1 },
                        },
                      ],
                    },
                  ],
                },
                truncated: true,
              },
            },
          },
          isError: false,
        },
      ],
      usage: {
        turns: 1,
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
        cost: 0,
      },
      finalOutput: 'PromQL validated.',
    };

    const { container } = render(
      <ToolResultMessageBody
        toolName="run_query_agent"
        content={[{ type: 'text', text: 'PromQL validated.' }]}
        details={details}
      />
    );

    fireEvent.click(screen.getByText('query_prometheus'));

    expect(container.textContent).toContain('1 of 1 Prometheus queries summarized');
    expect(container.textContent).toContain('instant | 1 series | 1m');
    expect(screen.getByTestId('prometheus-timeseries-panel')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Stored artifact [artifact: artifact_1]');
  });

  it('renders failed save_dashboard results as error text instead of a successful action card', () => {
    const errorText =
      'Grafana request failed (502 Bad Gateway) while calling POST api/plugins/g42-pi-app/resources/jsonnet-dashboards/save: PluginAppClientSecret not set in config';

    const { container } = render(
      <ToolResultMessageBody
        toolName="save_dashboard"
        content={[{ type: 'text', text: errorText }]}
        details={{}}
        isError
      />
    );

    expect(container.textContent).toContain(errorText);
    expect(container.textContent).toContain('failed');
    expect(container.textContent).not.toContain('Dashboard saved');
  });

  it('expands successful nested save_dashboard results by default', () => {
    const details = {
      type: 'subagent',
      agent: 'dashboard',
      status: 'completed',
      task: 'Create a dashboard.',
      toolNames: ['save_dashboard'],
      toolCalls: [
        {
          id: 'tool-1',
          name: 'save_dashboard',
          args: {
            uid: 'service-health',
          },
          status: 'completed',
          result: {
            content: [{ type: 'text', text: 'Dashboard saved.' }],
            details: {
              status: 'success',
              uid: 'service-health',
              url: '/d/service-health/service-health',
              sourceChecksum: '0123456789abcdef',
            },
          },
          isError: false,
        },
      ],
      usage: {
        turns: 1,
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
        cost: 0,
      },
      finalOutput: 'Dashboard saved.',
    };

    render(
      <ToolResultMessageBody
        toolName="run_dashboard_agent"
        content={[{ type: 'text', text: 'Dashboard saved.' }]}
        details={details}
      />
    );

    const row = screen.getByText('save_dashboard').closest('details') as HTMLDetailsElement | null;

    expect(row?.open).toBe(true);
    expect(screen.getByText('Dashboard saved')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open dashboard' })).toHaveAttribute(
      'href',
      '/d/service-health/service-health'
    );
  });

  it('renders object-shaped failed tool results as readable errors', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="inspect_metric_series"
        content={{ error: { message: 'Prometheus series lookup failed' } }}
        details={{ error: { message: 'Prometheus series lookup failed' }, datasourceUid: 'prometheus' }}
        isError
      />
    );

    expect(screen.getByTestId('tool-error')).toBeInTheDocument();
    expect(container.textContent).toContain('inspect_metric_series failed');
    expect(container.textContent).toContain('Prometheus series lookup failed');
    expect(container.textContent).not.toContain('[object Object]');
    expect(container.textContent).not.toContain('Inspect metric series | selector provided');
  });

  it('renders run_query_agent calls as specialist summaries', () => {
    const task =
      'Discover Prometheus metrics related to HTTP requests and errors. Look for metrics like http_requests_total.';

    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'run_query_agent',
            arguments: {
              task,
              metricPrefix: 'http_',
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('Run query agent | prefix http_');
    expect(container.textContent).toContain(task);
    expect(container.textContent).toContain('http_');
    expect(container.textContent).not.toContain('"task"');
    expect(container.textContent).not.toContain('"metricPrefix"');
  });

  it('renders nested failed subagent tool calls with normalized errors', () => {
    const details = {
      type: 'subagent',
      agent: 'query',
      status: 'completed',
      task: 'Inspect HTTP metrics.',
      toolNames: ['inspect_metric_series'],
      toolCalls: [
        {
          id: 'tool-1',
          name: 'inspect_metric_series',
          args: {
            match: 'http_server_requests_seconds_bucket',
          },
          status: 'failed',
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: { message: 'Series endpoint failed' } }) }],
            details: { error: { message: 'Series endpoint failed' } },
          },
          isError: true,
        },
      ],
      usage: {
        turns: 1,
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
        cost: 0,
      },
      finalOutput: 'Metric inspection failed.',
    };

    const { container } = render(
      <ToolResultMessageBody
        toolName="run_query_agent"
        content={[{ type: 'text', text: 'Metric inspection failed.' }]}
        details={details}
      />
    );

    const row = screen.getByText('inspect_metric_series').closest('details') as HTMLDetailsElement | null;

    expect(row?.open).toBe(true);
    expect(container.textContent).toContain('http_server_requests_seconds_bucket');
    expect(container.textContent).toContain('inspect_metric_series failed');
    expect(container.textContent).toContain('Series endpoint failed');
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('renders batched inspect_metric_series results with the structured renderer', () => {
    const content = [
      {
        type: 'text',
        text: JSON.stringify({
          datasourceUid: 'prometheus',
          matchCount: 2,
          truncatedMatches: false,
          results: [
            {
              datasourceUid: 'prometheus',
              match: 'http_requests_total',
              labelNames: ['job', 'method', 'status_code'],
              totalSeries: 12,
              truncated: false,
              examples: [{ __name__: 'http_requests_total', job: 'api', method: 'GET', status_code: '200' }],
            },
            {
              datasourceUid: 'prometheus',
              match: 'http_request_duration_seconds_bucket',
              labelNames: ['job', 'le', 'path'],
              totalSeries: 24,
              truncated: true,
              examples: [{ __name__: 'http_request_duration_seconds_bucket', job: 'api', le: '0.5', path: '/v1' }],
            },
          ],
        }),
      },
    ];

    const { container } = render(
      <ToolResultMessageBody
        toolName="inspect_metric_series"
        content={content}
        details={{ datasourceUid: 'prometheus', batch: true, matches: 2, totalSeries: 36 }}
      />
    );

    expect(container.textContent).toContain('2 of 2 metric selectors inspected');
    expect(container.textContent).toContain('Selector 1');
    expect(container.textContent).toContain('http_requests_total');
    expect(container.textContent).toContain('12 series | 3 labels');
    expect(container.textContent).not.toContain('"matchCount"');
  });

  it('renders a time series panel for range query visualization details', () => {
    const query = 'rate(http_requests_total[5m])';
    const content = [
      {
        type: 'text',
        text: JSON.stringify({
          datasourceUid: 'prometheus',
          query,
          queryType: 'range',
          interval: '1m',
          frameCount: 1,
          totalSeries: 12,
          truncatedSeries: true,
          notices: [],
          executedQueryStrings: [],
          series: [
            {
              name: 'http_requests_total',
              labels: { job: 'api' },
              points: 60,
              nonNullPoints: 60,
              nullPoints: 0,
              last: { value: 2 },
            },
          ],
        }),
      },
    ];
    const details = {
      datasourceUid: 'prometheus',
      query,
      interval: '1m',
      summarized: true,
      visualization: {
        kind: 'prometheus-timeseries',
        datasourceUid: 'prometheus',
        query,
        queryType: 'range',
        interval: '1m',
        maxDataPoints: 1200,
        range: {
          from: '2026-05-28T10:00:00.000Z',
          to: '2026-05-28T11:00:00.000Z',
          raw: { from: 'now-1h', to: 'now' },
        },
      },
    };

    render(<ToolResultMessageBody toolName="query_prometheus" content={content} details={details} />);

    expect(screen.getByTestId('prometheus-timeseries-panel')).toBeInTheDocument();
    expect(screen.getByTestId('mock-embedded-scene')).toHaveTextContent('Query result');
    expect(screen.getAllByText(query).length).toBeGreaterThan(0);

    const exploreLink = screen.getByRole('link', { name: 'Explore' });
    expect(exploreLink).toHaveAttribute('target', '_blank');
    const href = exploreLink.getAttribute('href') ?? '';
    expect(href.startsWith('/explore?left=')).toBe(true);
    expect(JSON.parse(decodeURIComponent(href.replace('/explore?left=', '')))).toMatchObject({
      datasource: 'prometheus',
      queries: [
        {
          refId: 'A',
          datasource: { uid: 'prometheus', type: 'prometheus' },
          expr: query,
          range: true,
          instant: false,
          interval: '1m',
          editorMode: 'code',
        },
      ],
      range: { from: 'now-1h', to: 'now' },
    });
  });

  it('keeps instant query summaries on the aggregate renderer only', () => {
    const query = 'up';
    const content = [
      {
        type: 'text',
        text: JSON.stringify({
          datasourceUid: 'prometheus',
          query,
          queryType: 'instant',
          interval: '1m',
          frameCount: 1,
          totalSeries: 1,
          truncatedSeries: false,
          notices: [],
          executedQueryStrings: [],
          series: [
            {
              name: 'up',
              labels: { job: 'api' },
              points: 1,
              nonNullPoints: 1,
              nullPoints: 0,
              last: { value: 1 },
            },
          ],
        }),
      },
    ];

    render(<ToolResultMessageBody toolName="query_prometheus" content={content} details={{ summarized: true }} />);

    expect(screen.queryByTestId('prometheus-timeseries-panel')).not.toBeInTheDocument();
    expect(screen.getAllByText(query).length).toBeGreaterThan(0);
  });

  it('renders batched query_prometheus summaries with the structured renderer', () => {
    const content = [
      {
        type: 'text',
        text: JSON.stringify({
          datasourceUid: 'prometheus',
          queryCount: 2,
          truncatedQueries: false,
          results: [
            {
              datasourceUid: 'prometheus',
              query: 'rate(http_requests_total[5m])',
              queryType: 'range',
              interval: '30s',
              range: {
                from: '2026-05-28T10:00:00.000Z',
                to: '2026-05-28T11:00:00.000Z',
                raw: { from: 'now-1h', to: 'now' },
              },
              frameCount: 1,
              totalSeries: 1,
              truncatedSeries: false,
              notices: [],
              executedQueryStrings: [],
              series: [
                {
                  name: 'http_requests_total',
                  labels: { job: 'api' },
                  points: 120,
                  nonNullPoints: 120,
                  nullPoints: 0,
                  last: { value: 2 },
                },
              ],
            },
            {
              datasourceUid: 'prometheus',
              query: 'up',
              queryType: 'instant',
              interval: '1m',
              frameCount: 1,
              totalSeries: 1,
              truncatedSeries: false,
              notices: [],
              executedQueryStrings: [],
              series: [
                {
                  name: 'up{job="api"}',
                  labels: { job: 'api' },
                  points: 1,
                  nonNullPoints: 1,
                  nullPoints: 0,
                  last: { value: 1 },
                },
              ],
            },
          ],
        }),
      },
    ];

    const { container } = render(
      <ToolResultMessageBody
        toolName="query_prometheus"
        content={content}
        details={{ datasourceUid: 'prometheus', queries: 2, summarized: true, batch: true }}
      />
    );

    expect(container.textContent).toContain('2 of 2 Prometheus queries summarized');
    expect(container.textContent).toContain('Query 1');
    expect(container.textContent).toContain('Query 2');
    expect(container.textContent).toContain('rate(http_requests_total[5m])');
    expect(container.textContent).toContain('range | 1 series | 30s');
    expect(container.textContent).toContain('instant | 1 series | 1m');
    expect(screen.getByTestId('gf-prometheus')).toBeInTheDocument();
    expect(screen.getByTestId('angle-down')).toBeInTheDocument();
    expect(screen.getByTestId('angle-right')).toBeInTheDocument();
    expect(screen.getByTestId('prometheus-timeseries-panel')).toBeInTheDocument();
    expect(container.textContent).not.toContain('"queryCount"');
  });

  it('renders a completed batch shell when query_prometheus batch content is unavailable', () => {
    const content = [{ type: 'text', text: '{"datasourceUid":"prometheus","queryCount":2,' }];

    const { container } = render(
      <ToolResultMessageBody
        toolName="query_prometheus"
        content={content}
        details={{ datasourceUid: 'prometheus', queries: 2, summarized: true, batch: true }}
      />
    );

    expect(container.textContent).toContain('2 of 2 Prometheus queries summarized');
    expect(container.textContent).toContain('The query batch completed, but the detailed result text was unavailable.');
    expect(container.textContent).not.toContain('{"datasourceUid"');
  });

  it('renders artifactized tool results as artifact cards', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="query_prometheus"
        content={[{ type: 'text', text: 'Stored artifact [artifact: artifact_1]' }]}
        details={{
          artifactRef: {
            id: 'artifact_1',
            kind: 'json',
            title: 'query_prometheus',
            toolName: 'query_prometheus',
            createdAt: '2026-06-05T00:00:00.000Z',
            bytes: 8192,
            summary: 'Prometheus batch result.',
          },
          artifactPreview: {
            type: 'json',
            data: { results: [{ query: 'up' }] },
            truncated: true,
          },
        }}
      />
    );

    expect(screen.getByTestId('artifact-result')).toBeInTheDocument();
    expect(container.textContent).toContain('artifact_1');
    expect(container.textContent).toContain('Prometheus batch result.');
    expect(container.textContent).toContain('8.0 KiB');
    expect(container.textContent).not.toContain('Stored artifact [artifact: artifact_1]');
  });

  it('renders read_artifact output instead of hiding it behind an artifact card', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="read_artifact"
        content={[{ type: 'text', text: 'selected artifact value' }]}
        details={{
          artifactRead: true,
          mode: 'field',
          path: 'results.0.query',
          artifactRef: {
            id: 'artifact_1',
            kind: 'json',
            title: 'query_prometheus',
            toolName: 'query_prometheus',
            createdAt: '2026-06-05T00:00:00.000Z',
            bytes: 8192,
            summary: 'Prometheus batch result.',
          },
        }}
      />
    );

    expect(screen.queryByTestId('artifact-result')).not.toBeInTheDocument();
    expect(container.textContent).toContain('selected artifact value');
    expect(container.textContent).not.toContain('read_artifact {"id":"artifact_1"}');
  });

  it('renders artifactized dashboard summaries from preview data', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="render_dashboard"
        content={[{ type: 'text', text: 'Stored artifact [artifact: artifact_1] render_dashboard' }]}
        details={{
          sourceBytes: 2048,
          artifactRef: {
            id: 'artifact_1',
            kind: 'dashboard',
            title: 'render_dashboard: HTTP Overview',
            toolName: 'render_dashboard',
            createdAt: '2026-06-05T00:00:00.000Z',
            bytes: 8192,
            summary: 'HTTP Overview with 1 panels.',
          },
          artifactPreview: {
            type: 'json',
            data: {
              dashboard: {
                title: 'HTTP Overview',
                uid: 'http-overview',
                tags: ['genai'],
                panels: [{ id: 1, title: 'Request rate', type: 'timeseries' }],
              },
              sourceChecksum: '0123456789abcdef0123456789abcdef',
            },
            truncated: true,
          },
        }}
      />
    );

    expect(container.textContent).toContain('HTTP Overview');
    expect(container.textContent).toContain('http-overview');
    expect(container.textContent).toContain('Panels');
    expect(container.textContent).toContain('timeseries: 1');
    expect(container.textContent).not.toContain('Stored artifact [artifact: artifact_1]');
  });

  it('suppresses raw Prometheus artifact handles inside the raw frame wrapper', () => {
    const query = 'up';
    const { container } = render(
      <ToolResultMessageBody
        toolName="query_prometheus_raw"
        content={[{ type: 'text', text: 'Stored artifact [artifact: artifact_1] query_prometheus_raw' }]}
        details={{
          datasourceUid: 'prometheus',
          query,
          interval: '1m',
          frames: 2,
          raw: true,
          artifactRef: {
            id: 'artifact_1',
            kind: 'json',
            title: 'query_prometheus_raw',
            toolName: 'query_prometheus_raw',
            createdAt: '2026-06-05T00:00:00.000Z',
            bytes: 8192,
            summary: 'query_prometheus_raw result stored as artifact.',
          },
          artifactPreview: {
            type: 'json',
            data: [{ name: 'frame' }],
            truncated: true,
          },
        }}
      />
    );

    expect(container.textContent).toContain(query);
    expect(container.textContent).toContain('Frames');
    expect(container.textContent).not.toContain('Stored artifact [artifact: artifact_1]');
    expect(container.textContent).not.toContain('Raw frames');
  });

  it('renders empty line-list tool results with the empty state', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="list_metrics"
        content={[{ type: 'text', text: '' }]}
        details={{ datasourceUid: 'prometheus', count: 0, truncated: false }}
      />
    );

    expect(container.textContent).toContain('0 metrics | from prometheus');
    expect(container.textContent).toContain('No results');
  });

  it('renders batched list_metrics JSON as grouped metric lists', () => {
    const content = [
      {
        type: 'text',
        text: JSON.stringify(
          {
            datasourceUid: 'prometheus',
            prefixCount: 2,
            results: [
              {
                prefix: 'http_',
                count: 2,
                truncated: false,
                metrics: ['http_requests_total', 'http_request_duration_seconds_bucket'],
              },
              {
                prefix: 'node_',
                count: 1,
                truncated: true,
                metrics: ['node_cpu_seconds_total'],
              },
            ],
          },
          null,
          2
        ),
      },
    ];

    const { container } = render(
      <ToolResultMessageBody
        toolName="list_metrics"
        content={content}
        details={{ datasourceUid: 'prometheus', batch: true, prefixes: ['http_', 'node_'], count: 3, truncated: true }}
      />
    );

    expect(container.textContent).toContain('2 metric prefixes | 3 metrics | from prometheus | truncated');
    expect(container.textContent).toContain('prefix http_');
    expect(container.textContent).toContain('http_requests_total');
    expect(container.textContent).toContain('node_cpu_seconds_total');
    expect(container.textContent).not.toContain('"prefixCount"');
    expect(container.textContent).not.toContain('"results"');
  });

  it('renders live dashboard mutation schema results', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="get_live_dashboard_mutation_schema"
        content={[
          {
            type: 'text',
            text: JSON.stringify({
              command: 'UPDATE_PANEL',
              available: true,
              readOnly: false,
              guidance: {
                workflow: ['Use list_live_dashboard_panels first.'],
              },
              availableCommands: ['LIST_PANELS', 'UPDATE_PANEL'],
            }),
          },
        ]}
        details={{
          command: 'UPDATE_PANEL',
          availableCommands: ['LIST_PANELS', 'UPDATE_PANEL'],
          guidanceOnly: true,
        }}
      />
    );

    expect(container.textContent).toContain('Live dashboard mutation schema | UPDATE_PANEL');
    expect(container.textContent).toContain('LIST_PANELS');
    expect(container.textContent).toContain('UPDATE_PANEL');
    expect(container.textContent).toContain('Guidance');
    expect(container.textContent).not.toContain('Details');
  });

  it('renders live dashboard mutation results as structured changes', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="rename_live_dashboard_panel"
        content={[
          {
            type: 'text',
            text: 'Live dashboard mutation UPDATE_PANEL succeeded.\nChanges: 1\n{"previousValue":"Old title"}',
          },
        ]}
        details={{
          command: 'UPDATE_PANEL',
          success: true,
          changes: [{ path: '/elements/panel-1/spec/title', previousValue: 'Old title', newValue: 'New title' }],
          warnings: ['Panel data will refresh after save.'],
          data: { ok: true },
          availableCommands: ['LIST_PANELS', 'UPDATE_PANEL'],
        }}
      />
    );

    expect(container.textContent).toContain('Live dashboard mutation succeeded');
    expect(container.textContent).toContain('UPDATE_PANEL');
    expect(container.textContent).toContain('/elements/panel-1/spec/title');
    expect(container.textContent).toContain('Old title');
    expect(container.textContent).toContain('New title');
    expect(container.textContent).toContain('Panel data will refresh after save.');
    expect(container.textContent).not.toContain('"previousValue"');
  });
});
