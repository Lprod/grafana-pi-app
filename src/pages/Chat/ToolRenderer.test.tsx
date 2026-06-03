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
      return React.createElement('div', { 'data-testid': 'mock-embedded-scene' }, state?.title ?? 'scene', state?.headerActions);
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
    expect(container.textContent).toContain('1200 x 800');
    expect(container.textContent).toContain('Search Jsonnet libraries | timeseries panel');
    expect(container.textContent).toContain('Edit Jsonnet source | dashboards/service.jsonnet');
    expect(container.textContent).toContain('10-12');
    expect(container.textContent).not.toContain('"uid"');
    expect(container.textContent).not.toContain('"path"');
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

  it('collapses completed explore subagent output by default', () => {
    const details = {
      type: 'subagent',
      agent: 'metrics',
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
        toolName="explore_metrics"
        content={[{ type: 'text', text: 'Use up for availability.' }]}
        details={details}
      />
    );

    const result = screen.getByTestId('subagent-result') as HTMLDetailsElement;
    expect(result.open).toBe(false);
    expect(screen.getByText('Metrics explorer result')).toBeInTheDocument();
    expect(screen.getByTestId('angle-right')).toBeInTheDocument();
    expect(container.textContent).toContain('Metrics explorer');
    expect(container.textContent).toContain('list_metrics');

    fireEvent.click(screen.getByText('Metrics explorer result'));

    expect(result.open).toBe(true);
    expect(screen.getByTestId('angle-down')).toBeInTheDocument();
  });

  it('renders nested explore_metrics Prometheus results with the structured renderer', () => {
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
      agent: 'metrics',
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
        toolName="explore_metrics"
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

  it('renders failed sync_dashboard results as error text instead of a successful action card', () => {
    const errorText =
      'Grafana request failed (502 Bad Gateway) while calling POST api/plugins/g42-pi-app/resources/managed-dashboards/sync: PluginAppClientSecret not set in config';

    const { container } = render(
      <ToolResultMessageBody
        toolName="sync_dashboard"
        content={[{ type: 'text', text: errorText }]}
        details={{}}
        isError
      />
    );

    expect(container.textContent).toContain(errorText);
    expect(container.textContent).toContain('failed');
    expect(container.textContent).not.toContain('Managed dashboard synced');
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
});
