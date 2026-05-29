import React from 'react';
import { render, screen } from '@testing-library/react';
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
    render(
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
