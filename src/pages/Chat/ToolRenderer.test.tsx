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
    static Component = ({ model }: { model: any }) =>
      React.createElement('div', { 'data-testid': 'mock-embedded-scene' }, panelTitle(model));
  }

  class SceneFlexLayout extends MockSceneObject {}
  class SceneFlexItem extends MockSceneObject {}
  class SceneQueryRunner extends MockSceneObject {}
  class SceneTimeRange extends MockSceneObject {}

  function panelTitle(model: any) {
    return model.state?.body?.state?.children?.[0]?.state?.body?.state?.title ?? 'scene';
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
});
