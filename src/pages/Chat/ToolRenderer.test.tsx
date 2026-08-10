import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { config } from '@grafana/runtime';
import { structuredPatch } from 'diff';
import { highlightJsonnetLines } from './jsonnetRendering';
import { ContentBlocks, ToolActivityPanel, ToolResultMessageBody } from './ToolRenderer';

jest.mock('./jsonnetRendering', () => {
  const actual = jest.requireActual<typeof import('./jsonnetRendering')>('./jsonnetRendering');
  return { ...actual, highlightJsonnetLines: jest.fn(actual.highlightJsonnetLines) };
});

jest.mock('diff', () => {
  const actual = jest.requireActual<typeof import('diff')>('diff');
  return { ...actual, structuredPatch: jest.fn(actual.structuredPatch) };
});

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

const alertQuery = 'sum(rate(http_requests_total{status=~"5.."}[5m]))';

function alertRuleFixture(source = 'panelRef+annotations') {
  return {
    name: 'service-5xx-rate',
    title: 'Service 5xx rate',
    viewUrl: '/alerting/grafana/service-5xx-rate/view',
    apiPath: '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules/service-5xx-rate',
    folderUid: 'service-folder',
    panelLink: { dashboardUID: 'service-dashboard', panelID: 2, source },
    for: '1m',
    noDataState: 'NoData',
    execErrState: 'Error',
    labels: { severity: 'warning' },
    annotations: { __dashboardUid__: 'service-dashboard', __panelId__: '2' },
    conditionRef: 'B',
    expressions: [
      {
        refId: 'A',
        datasourceUid: 'prom-b',
        queryType: 'range',
        expressionType: 'prometheus',
        expression: alertQuery,
        relativeTimeRange: { from: 300, to: 0 },
      },
      {
        refId: 'B',
        source: true,
        datasourceUid: '__expr__',
        expressionType: 'threshold',
        expression: 'A',
        reducer: 'last',
        evaluator: { type: 'gt', params: [0] },
      },
    ],
    alertCondition: {
      sourceRefId: 'B',
      reducer: 'last',
      evaluator: { type: 'gt', params: [0] },
    },
    prometheusChecks: [
      {
        refId: 'A',
        datasourceUid: 'prom-b',
        query: alertQuery,
        type: 'range',
        start: 'now-5m',
        end: 'now',
        relativeTimeRange: { from: 300, to: 0 },
      },
    ],
  };
}

function alertSearchResultFixture(source = 'panelRef+annotations') {
  return {
    namespace: 'default',
    query: {
      dashboardUid: 'service-dashboard',
      panelId: '2',
      panelTitle: '5xx rate panel',
    },
    dashboardPanel: {
      id: '2',
      title: '5xx rate panel',
      type: 'timeseries',
      datasourceUid: 'prom-b',
      datasourceType: 'prometheus',
      targets: [
        {
          refId: 'A',
          datasourceUid: 'prom-b',
          datasourceType: 'prometheus',
          query: alertQuery,
          legendFormat: '5xx',
        },
      ],
      thresholds: {
        mode: 'absolute',
        steps: [{ value: 0, color: 'green' }],
      },
    },
    ruleCount: 3,
    matchCount: 1,
    exactPanelMatchCount: 1,
    matches: [
      {
        score: 160,
        reasons: ['panel link exact match', `${source} panelID match`],
        rule: alertRuleFixture(source),
      },
    ],
    guidance: ['Compare alert prometheusChecks against the panel query.'],
  };
}

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

  it('renders skill resource reads as collapsed reference cards', () => {
    const call = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'read_skill_resource',
            arguments: { skill: 'grafana-dashboard', path: 'references/dashboard-jsonnet-workflow.md' },
          },
        ]}
      />
    );

    expect(call.container.textContent).toContain(
      'Read skill resource | grafana-dashboard | references/dashboard-jsonnet-workflow.md'
    );
    call.unmount();

    const { container } = render(
      <ToolResultMessageBody
        toolName="read_skill_resource"
        content={[
          {
            type: 'text',
            text: '# Dashboard Jsonnet Workflow\n\nA long reference body that should not dominate the transcript.',
          },
        ]}
        details={{
          skill: 'grafana-dashboard',
          path: 'references/dashboard-jsonnet-workflow.md',
          bytes: 4096,
          truncated: false,
        }}
      />
    );

    expect(container.textContent).toContain('Skill resource loaded');
    expect(container.textContent).toContain('grafana-dashboard');
    expect(container.textContent).toContain('references/dashboard-jsonnet-workflow.md');
    expect(container.textContent).toContain('4096 bytes');
    const details = container.querySelector('details');
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute('open');
    expect(details?.querySelector('summary')?.textContent).toContain('Reference text');
  });

  it('renders live dashboard edit tool calls with audit fields', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'list_live_dashboard_panels',
            arguments: { elements: ['panel-2'], includeStatus: true },
          },
          { type: 'toolCall', name: 'get_live_dashboard_layout', arguments: {} },
          { type: 'toolCall', name: 'get_live_dashboard_info', arguments: {} },
          { type: 'toolCall', name: 'list_live_dashboard_variables', arguments: { parentPath: '/rows/0' } },
          {
            type: 'toolCall',
            name: 'rename_live_dashboard_panel',
            arguments: { elementName: 'panel-2', title: 'Requests', description: 'Updated panel copy' },
          },
          {
            type: 'toolCall',
            name: 'update_live_dashboard_panel_query',
            arguments: {
              elementName: 'panel-2',
              queryExpression: 'sum(rate(http_requests_total[$__rate_interval]))',
              datasourceType: 'prometheus',
              datasourceName: 'prom-prod',
              refId: 'B',
              hidden: true,
            },
          },
          {
            type: 'toolCall',
            name: 'add_live_dashboard_panel',
            arguments: {
              title: 'Errors',
              visualizationType: 'timeseries',
              unit: 'reqps',
              datasourceType: 'prometheus',
              datasourceName: 'prom-prod',
              x: 12,
              y: 8,
              width: 12,
              height: 8,
            },
          },
          {
            type: 'toolCall',
            name: 'move_or_resize_live_dashboard_panel',
            arguments: { elementName: 'panel-2', parentPath: '/', x: 0, y: 8, width: 12, height: 8 },
          },
          {
            type: 'toolCall',
            name: 'update_live_dashboard_settings',
            arguments: {
              title: 'Ops',
              tags: ['service', 'sre'],
              from: 'now-6h',
              to: 'now',
              autoRefresh: '30s',
              timezone: 'browser',
              cursorSync: 'Tooltip',
              editable: false,
              liveNow: true,
              preload: true,
            },
          },
          {
            type: 'toolCall',
            name: 'add_live_dashboard_variable',
            arguments: {
              name: 'env',
              variableType: 'query',
              queryExpression: 'label_values(up, job)',
              datasourceName: 'prom-prod',
              current: 'prod',
              multi: true,
              includeAll: true,
            },
          },
          {
            type: 'toolCall',
            name: 'update_live_dashboard_variable',
            arguments: { name: 'env', newName: 'service', options: ['api', 'worker'], position: 2 },
          },
          {
            type: 'toolCall',
            name: 'apply_live_dashboard_mutation',
            arguments: {
              type: 'REMOVE_PANEL',
              payload: { elements: [{ kind: 'ElementReference', name: 'panel-9' }] },
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('List live dashboard panels | panel-2');
    expect(container.textContent).toContain('Rename live dashboard panel | panel-2');
    expect(container.textContent).toContain('Updated panel copy');
    expect(container.textContent).toContain('Update live dashboard panel query | panel-2');
    expect(container.textContent).toContain('prometheus/prom-prod');
    expect(container.textContent).toContain('Ref ID');
    expect(container.textContent).toContain('B');
    expect(container.textContent).toContain('Add live dashboard panel | Errors');
    expect(container.textContent).toContain('timeseries');
    expect(container.textContent).toContain('reqps');
    expect(container.textContent).toContain('x 12, y 8, width 12, height 8');
    expect(container.textContent).toContain('Update live dashboard settings | Ops');
    expect(container.textContent).toContain('now-6h -> now');
    expect(container.textContent).toContain('30s');
    expect(container.textContent).toContain('Tooltip');
    expect(container.textContent).toContain('service, sre');
    expect(container.textContent).toContain('Add live dashboard variable | env');
    expect(container.textContent).toContain('label_values(up, job)');
    expect(container.textContent).toContain('Update live dashboard variable | env');
    expect(container.textContent).toContain('service');
    expect(container.textContent).toContain('Apply live dashboard mutation | REMOVE_PANEL');
    expect(container.textContent).toContain('panel-9');
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

  it('shows a completed query-agent result preview before the full output is expanded', () => {
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
    expect(screen.getByTestId('subagent-result-preview')).toHaveTextContent('Use up for availability.');
    expect(screen.getByTestId('subagent-result-preview')).toBeVisible();
    expect(screen.getByTestId('angle-right')).toBeInTheDocument();
    expect(container.textContent).toContain('Query agent');
    expect(container.textContent).toContain('List metric names');

    fireEvent.click(screen.getByText('Query agent result'));

    expect(result.open).toBe(true);
    expect(screen.getByTestId('angle-down')).toBeInTheDocument();
    expect(screen.queryByTestId('subagent-result-preview')).not.toBeInTheDocument();
  });

  it('keeps the active and latest completed specialist steps visible while collapsing older activity', () => {
    render(
      <ToolActivityPanel
        elapsed="1m 37s"
        runs={[
          {
            id: 'run-1',
            name: 'run_investigation_agent',
            args: {},
            status: 'running',
            updatedAt: 1,
            partialResult: {
              content: [],
              details: {
                type: 'subagent',
                agent: 'investigation',
                status: 'running',
                task: 'Investigate latency.',
                toolCalls: [
                  { id: 'completed-0', name: 'list_dashboards', args: {}, status: 'completed' },
                  { id: 'completed-1', name: 'inspect_dashboard_context', args: {}, status: 'completed' },
                  { id: 'running-1', name: 'query_prometheus', args: {}, status: 'running' },
                ],
                usage: {
                  turns: 2,
                  input: 10,
                  output: 4,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 14,
                  cost: 0,
                },
              },
            },
          },
        ]}
      />
    );

    expect(screen.getByText('1m 37s')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('NowQuery Prometheus');
    expect(screen.getByText('Inspect dashboard context')).toBeVisible();
    expect(screen.getAllByText('Query Prometheus').some((element) => element.closest('summary'))).toBe(true);
    const history = screen.getByText('1 earlier step').closest('details') as HTMLDetailsElement;
    expect(history).not.toBeNull();
    expect(history.open).toBe(false);
  });

  it('keeps meaningful specialist feedback visible between nested tool calls', () => {
    render(
      <ToolActivityPanel
        runs={[
          {
            id: 'run-1',
            name: 'run_dashboard_agent',
            args: {},
            status: 'running',
            updatedAt: 1,
            partialResult: {
              content: [{ type: 'text', text: 'Dashboard agent running. 3 tool calls so far.' }],
              details: {
                type: 'subagent',
                agent: 'dashboard',
                status: 'running',
                task: 'Create a service dashboard.',
                toolCalls: [
                  { id: 'completed-0', name: 'list_metrics', args: {}, status: 'completed' },
                  { id: 'completed-1', name: 'inspect_metric_series', args: {}, status: 'completed' },
                  { id: 'completed-2', name: 'query_prometheus', args: {}, status: 'completed' },
                ],
                usage: {
                  turns: 2,
                  input: 10,
                  output: 4,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 14,
                  cost: 0,
                },
              },
            },
          },
        ]}
      />
    );

    expect(screen.getByText('Dashboard agent')).toBeVisible();
    expect(screen.queryByText('run_dashboard_agent')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('NowPreparing the next step');
    expect(screen.getByText('Query Prometheus')).toBeVisible();
    const history = screen.getByText('2 earlier steps').closest('details') as HTMLDetailsElement;
    expect(history.open).toBe(false);
  });

  it('shows when a specialist is drafting after its nested calls complete', () => {
    render(
      <ToolActivityPanel
        runs={[
          {
            id: 'run-1',
            name: 'run_dashboard_agent',
            args: {},
            status: 'running',
            updatedAt: 1,
            partialResult: {
              content: [{ type: 'text', text: 'Dashboard agent drafting a response.' }],
              details: {
                type: 'subagent',
                agent: 'dashboard',
                status: 'running',
                task: 'Review a dashboard.',
                toolCalls: [{ id: 'completed-1', name: 'inspect_dashboard_context', args: {}, status: 'completed' }],
                usage: {
                  turns: 1,
                  input: 10,
                  output: 4,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 14,
                  cost: 0,
                },
                finalOutput: 'The dashboard review is ready.',
              },
            },
          },
        ]}
      />
    );

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('NowDrafting response');
    expect(screen.getByText('Inspect dashboard context')).toBeVisible();
  });

  it('labels a failed specialist call as recovered after a successful retry', () => {
    render(
      <ToolActivityPanel
        runs={[
          {
            id: 'run-1',
            name: 'run_dashboard_agent',
            args: {},
            status: 'running',
            updatedAt: 1,
            partialResult: {
              content: [],
              details: {
                type: 'subagent',
                agent: 'dashboard',
                status: 'running',
                task: 'Apply a dashboard filter.',
                toolCalls: [
                  {
                    id: 'failed-1',
                    name: 'apply_live_dashboard_prometheus_label_filter',
                    args: { refIds: [] },
                    status: 'failed',
                    result: { content: [{ type: 'text', text: 'refIds must not be empty.' }], details: {} },
                    isError: true,
                  },
                  {
                    id: 'completed-1',
                    name: 'apply_live_dashboard_prometheus_label_filter',
                    args: { refIds: ['A'] },
                    status: 'completed',
                    result: { content: [{ type: 'text', text: 'Filter applied.' }], details: { success: true } },
                    isError: false,
                  },
                ],
                usage: {
                  turns: 2,
                  input: 10,
                  output: 4,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 14,
                  cost: 0,
                },
              },
            },
          },
        ]}
      />
    );

    const history = screen.getByText('1 earlier step · 1 recovered attempt').closest('details') as HTMLDetailsElement;
    const recovered = screen.getByText('Recovered').closest('details') as HTMLDetailsElement;

    expect(history.open).toBe(false);
    expect(recovered.open).toBe(false);
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByText('Query Prometheus'));

    expect(container.textContent).toContain('2 of 2 Prometheus queries summarized');
    expect(container.textContent).toContain('Query 1');
    expect(container.textContent).toContain(rangeQuery);
    expect(container.textContent).toContain('range | 1 series | 30s');
    expect(screen.queryByTestId('prometheus-timeseries-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Chart'));

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

    fireEvent.click(screen.getByText('Query Prometheus'));

    expect(screen.getByTestId('artifact-result')).toBeInTheDocument();
    expect(container.textContent).toContain('2 of 2 Prometheus queries summarized');
    expect(container.textContent).toContain('Query 1');
    expect(container.textContent).toContain(rangeQuery);
    expect(container.textContent).toContain('range | 1 series | 30s');

    fireEvent.click(screen.getByText('Chart'));

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

    fireEvent.click(screen.getByText('Query Prometheus'));

    expect(container.textContent).toContain('1 of 1 Prometheus queries summarized');
    expect(container.textContent).toContain('instant | 1 series | 1m');

    fireEvent.click(screen.getByText('Chart'));

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

  it('renders alert tool calls as troubleshooting summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'run_alert_agent',
            arguments: {
              task: 'Explain why this panel-linked alert is firing.',
              datasourceUid: 'prom-b',
              dashboardUid: 'service-dashboard',
              panelId: '2',
              timeRange: 'now-1h to now',
            },
          },
          {
            type: 'toolCall',
            name: 'find_panel_alert_rules',
            arguments: {
              dashboardUid: 'service-dashboard',
              panelId: 2,
              panelTitle: '5xx rate panel',
            },
          },
          {
            type: 'toolCall',
            name: 'get_alert_rule',
            arguments: {
              name: 'service-5xx-rate',
              namespace: 'default',
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('Run alert agent | datasource prom-b');
    expect(container.textContent).toContain('Find panel alert rules | dashboard service-dashboard | panel 2');
    expect(container.textContent).toContain('Get alert rule | service-5xx-rate | namespace default');
    expect(container.textContent).not.toContain('"dashboardUid"');
    expect(screen.getAllByTestId('bell').length).toBeGreaterThan(0);
  });

  it('renders panel alert rule matches with link health', () => {
    const content = [{ type: 'text', text: JSON.stringify(alertSearchResultFixture()) }];

    const { container } = render(
      <ToolResultMessageBody
        toolName="find_panel_alert_rules"
        content={content}
        details={{
          namespace: 'default',
          dashboardUid: 'service-dashboard',
          panelId: '2',
          ruleCount: 3,
          matchCount: 1,
          exactPanelMatchCount: 1,
          summarized: true,
        }}
      />
    );

    expect(container.textContent).toContain('1 matched alert rule | 1 exact panel link | 3 scanned');
    expect(container.textContent).toContain('5xx rate panel');
    expect(container.textContent).toContain('Service 5xx rate');
    expect(container.textContent).toContain('properly linked');
    expect(container.textContent).toContain('panel indicator should appear');
    expect(container.textContent).toContain(alertQuery);
    expect(container.textContent).not.toContain('"matches"');
    expect(container.textContent).not.toContain('Compare alert prometheusChecks against the panel query.');
    expect(container.querySelector('table')).not.toBeInTheDocument();
  });

  it('warns when an alert match only has panelRef linkage', () => {
    const content = [{ type: 'text', text: JSON.stringify(alertSearchResultFixture('panelRef')) }];

    const { container } = render(
      <ToolResultMessageBody
        toolName="find_panel_alert_rules"
        content={content}
        details={{
          namespace: 'default',
          ruleCount: 3,
          matchCount: 1,
          exactPanelMatchCount: 1,
          summarized: true,
        }}
      />
    );

    expect(container.textContent).toContain('panelRef only');
    expect(container.textContent).toContain('panel indicator annotations missing');
  });

  it('renders alert rule expression chains and Prometheus checks', () => {
    const content = [
      {
        type: 'text',
        text: JSON.stringify({
          namespace: 'default',
          rule: alertRuleFixture('panelRef'),
          rawStatus: { state: 'firing' },
          guidance: ['Run prometheusChecks with query_prometheus for current evidence.'],
        }),
      },
    ];

    const { container } = render(
      <ToolResultMessageBody
        toolName="get_alert_rule"
        content={content}
        details={{ namespace: 'default', name: 'service-5xx-rate', prometheusChecks: 1, summarized: true }}
      />
    );

    expect(container.textContent).toContain('Alert rule | Service 5xx rate | service-5xx-rate');
    expect(container.textContent).toContain('B last gt 0');
    expect(container.textContent).toContain('Expression chain');
    expect(container.textContent).toContain('Prometheus checks');
    expect(container.textContent).toContain('panel indicator annotations missing');
    expect(container.textContent).toContain(alertQuery);
    expect(container.textContent).not.toContain('"rawStatus"');
  });

  it('labels alert subagents and expands completed alert evidence calls', () => {
    const details = {
      type: 'subagent',
      agent: 'alerts',
      status: 'completed',
      task: 'Troubleshoot the panel-linked alert.',
      toolNames: ['find_panel_alert_rules'],
      toolCalls: [
        {
          id: 'tool-1',
          name: 'find_panel_alert_rules',
          args: {
            dashboardUid: 'service-dashboard',
            panelId: 2,
          },
          status: 'completed',
          result: {
            content: [{ type: 'text', text: JSON.stringify(alertSearchResultFixture()) }],
            details: {
              namespace: 'default',
              ruleCount: 3,
              matchCount: 1,
              exactPanelMatchCount: 1,
              summarized: true,
            },
          },
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
      finalOutput: 'The rule is linked.',
    };

    render(
      <ToolResultMessageBody
        toolName="run_alert_agent"
        content={[{ type: 'text', text: 'The rule is linked.' }]}
        details={details}
      />
    );

    const row = screen.getByText('find_panel_alert_rules').closest('details') as HTMLDetailsElement | null;

    expect(screen.getByText('Alert agent result')).toBeInTheDocument();
    expect(screen.getByText('Alert agent')).toBeInTheDocument();
    expect(row?.open).toBe(true);
    expect(screen.getByText('properly linked')).toBeInTheDocument();
  });

  it('collapses nested alert-agent dashboard context by default', () => {
    const details = {
      type: 'subagent',
      agent: 'alerts',
      status: 'completed',
      task: 'Troubleshoot the panel-linked alert.',
      toolNames: ['inspect_dashboard_context'],
      toolCalls: [
        {
          id: 'tool-1',
          name: 'inspect_dashboard_context',
          args: {
            uid: 'service-dashboard',
            validateQueries: true,
          },
          status: 'completed',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  dashboard: { uid: 'service-dashboard', title: 'Service dashboard' },
                  panels: [{ title: 'HTTP requests', targets: [{ query: 'sum(rate(sample_requests_total[5m]))' }] }],
                }),
              },
            ],
            details: {
              uid: 'service-dashboard',
              title: 'Service dashboard',
              panelCount: 1,
              queryCount: 1,
              summarized: true,
            },
          },
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
      finalOutput: 'The dashboard context was inspected.',
    };

    const { container } = render(
      <ToolResultMessageBody
        toolName="run_alert_agent"
        content={[{ type: 'text', text: 'The dashboard context was inspected.' }]}
        details={details}
      />
    );

    const row = screen.getByTitle('inspect_dashboard_context').closest('details') as HTMLDetailsElement | null;

    expect(row?.open).toBe(false);
    expect(container.textContent).toContain('Inspect dashboard context');
    expect(container.textContent).not.toContain('HTTP requests');
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

    const row = screen.getByTitle('inspect_metric_series').closest('details') as HTMLDetailsElement | null;

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

    expect(screen.queryByTestId('prometheus-timeseries-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Chart'));

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
    expect(screen.queryByTestId('prometheus-timeseries-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Chart'));

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

  it('renders live dashboard JSON artifacts without dumping raw preview data', () => {
    const rawMarker = `RAW_LIVE_DASHBOARD_JSON_${'x'.repeat(2048)}`;
    const { container } = render(
      <ToolResultMessageBody
        toolName="list_live_dashboard_panels"
        content={[
          {
            type: 'text',
            text: `Stored artifact [artifact: artifact_1]\n${rawMarker}`,
          },
        ]}
        details={{
          artifactRef: {
            id: 'artifact_1',
            kind: 'dashboard',
            title: 'list_live_dashboard_panels',
            toolName: 'list_live_dashboard_panels',
            createdAt: '2026-06-05T00:00:00.000Z',
            bytes: 256000,
            summary: '24 live dashboard panels summarized.',
          },
          artifactPreview: {
            type: 'json',
            data: {
              command: 'LIST_PANELS',
              summary: {
                panelCount: 24,
                panels: [{ elementName: 'panel-1', title: 'Request rate' }],
              },
              data: {
                elements: [
                  {
                    element: {
                      kind: 'Panel',
                      spec: {
                        title: 'Request rate',
                        fieldConfig: { defaults: { custom: { rawMarker } } },
                      },
                    },
                  },
                ],
              },
            },
            truncated: true,
          },
        }}
      />
    );

    expect(screen.getByTestId('artifact-result')).toBeInTheDocument();
    expect(container.textContent).toContain('artifact_1');
    expect(container.textContent).toContain('24 live dashboard panels summarized.');
    expect(container.textContent).toContain('250.0 KiB');
    expect(container.textContent).toContain('read_artifact {"id":"artifact_1"}');
    expect(container.textContent).not.toContain('Stored artifact [artifact: artifact_1]');
    expect(container.textContent).not.toContain(rawMarker);
    expect(container.textContent).not.toContain('"elements"');
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
    expect(container.textContent).toContain('Artifact read | field | query_prometheus');
    expect(container.textContent).toContain('selected artifact value');
    expect(container.textContent).not.toContain('read_artifact {"id":"artifact_1"}');
  });

  it('renders jq null artifact reads without raw null fallback details', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="read_artifact"
        content={[{ type: 'text', text: 'null' }]}
        details={{
          artifactRead: true,
          mode: 'jq',
          jq: '.elements[0].element.vizConfig.spec.fieldConfig.defaults.thresholds',
          exitCode: 0,
          truncated: false,
          artifactRef: {
            id: 'artifact_1',
            kind: 'dashboard',
            title: 'list_live_dashboard_panels',
            toolName: 'list_live_dashboard_panels',
            createdAt: '2026-07-01T08:44:20.964Z',
            bytes: 5573,
            summary: 'list_live_dashboard_panels returned 1 panel.',
          },
        }}
      />
    );

    expect(container.textContent).toContain('Artifact read | jq | list_live_dashboard_panels');
    expect(container.textContent).toContain('jq result is null.');
    expect(container.textContent).toContain('.elements[0].element.vizConfig.spec.fieldConfig.defaults.thresholds');
    expect(container.textContent).not.toContain('"artifactRead"');
    expect(container.textContent).not.toContain('Details');
  });

  it('renders undefined artifact fields as an empty state', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="read_artifact"
        content={[{ type: 'text', text: 'undefined' }]}
        details={{
          artifactRead: true,
          mode: 'field',
          path: 'data.elements.0.element.vizConfig.spec.fieldConfig.defaults',
          artifactRef: {
            id: 'artifact_1',
            kind: 'dashboard',
            title: 'list_live_dashboard_panels',
            toolName: 'list_live_dashboard_panels',
            createdAt: '2026-07-01T08:44:20.964Z',
            bytes: 5573,
            summary: 'list_live_dashboard_panels returned 1 panel.',
          },
        }}
      />
    );

    expect(container.textContent).toContain('Artifact read | field | list_live_dashboard_panels');
    expect(container.textContent).toContain('Selected artifact field is undefined.');
    expect(container.textContent).toContain('data.elements.0.element.vizConfig.spec.fieldConfig.defaults');
    expect(container.textContent).not.toContain('Details');
  });

  it('collapses full JSON artifact reads behind a dashboard summary', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="read_artifact"
        content={[
          {
            type: 'text',
            text: JSON.stringify({
              command: 'LIST_PANELS',
              success: true,
              data: {
                elements: [
                  {
                    element: {
                      kind: 'Panel',
                      spec: {
                        title: '5xx rate panel',
                        data: { kind: 'QueryGroup', spec: { queries: [{ kind: 'PanelQuery' }] } },
                        vizConfig: { kind: 'VizConfig', group: 'timeseries' },
                      },
                    },
                    layoutItem: { kind: 'GridLayoutItem', spec: { x: 0, y: 0, width: 24, height: 8 } },
                  },
                ],
              },
              availableCommands: ['LIST_PANELS'],
            }),
          },
        ]}
        details={{
          artifactRead: true,
          mode: 'full',
          truncated: false,
          artifactRef: {
            id: 'artifact_1',
            kind: 'dashboard',
            title: 'list_live_dashboard_panels',
            toolName: 'list_live_dashboard_panels',
            createdAt: '2026-07-01T08:44:20.964Z',
            bytes: 5573,
            summary: 'list_live_dashboard_panels returned 1 panel.',
          },
        }}
      />
    );

    const details = screen.getByText('Full artifact JSON').closest('details') as HTMLDetailsElement | null;

    expect(container.textContent).toContain('Artifact read | full | list_live_dashboard_panels');
    expect(container.textContent).toContain('LIST_PANELS');
    expect(container.textContent).toContain('5xx rate panel');
    expect(container.textContent).toContain('24x8 at 0,0');
    expect(details?.open).toBe(false);
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
          payload: {
            element: { kind: 'ElementReference', name: 'panel-1' },
            panel: { kind: 'Panel', spec: { title: 'New title' } },
          },
          changes: [{ path: '/elements/panel-1/spec/title', previousValue: 'Old title', newValue: 'New title' }],
          warnings: ['Panel data will refresh after save.'],
          data: { ok: true },
          visualVerification: { status: 'skipped', error: 'Renderer unavailable' },
          availableCommands: ['LIST_PANELS', 'UPDATE_PANEL'],
        }}
      />
    );

    expect(container.textContent).toContain('Live dashboard mutation succeeded');
    expect(container.textContent).toContain('UPDATE_PANEL');
    expect(container.textContent).toContain('panel-1');
    expect(container.textContent).toContain('Panel title');
    expect(container.textContent).toContain('/elements/panel-1/spec/title');
    expect(container.textContent).toContain('Old title');
    expect(container.textContent).toContain('New title');
    expect(container.textContent).toContain('Verification issue');
    expect(container.textContent).toContain('Renderer unavailable');
    expect(container.textContent).toContain('Panel data will refresh after save.');
    expect(container.textContent).not.toContain('"previousValue"');
    const changes = [...container.querySelectorAll('details')].find((details) =>
      details.querySelector('summary')?.textContent?.includes('Changes')
    );
    expect(changes).toBeInTheDocument();
    expect(changes).not.toHaveAttribute('open');
  });

  it('renders read-only live dashboard results as commands', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="list_live_dashboard_panels"
        content={[{ type: 'text', text: 'Live dashboard mutation LIST_PANELS succeeded.' }]}
        details={{
          command: 'LIST_PANELS',
          success: true,
          changes: [],
          data: {
            elements: [
              { element: { kind: 'Panel', spec: { title: 'Requests' } } },
              { element: { kind: 'Panel', spec: { title: 'Errors' } } },
            ],
          },
          availableCommands: ['LIST_PANELS', 'UPDATE_PANEL'],
        }}
      />
    );

    expect(container.textContent).toContain('Live dashboard command succeeded');
    expect(container.textContent).toContain('LIST_PANELS');
    expect(container.textContent).toContain('Panels');
    expect(container.textContent).toContain('2');
    expect(container.textContent).not.toContain('Live dashboard mutation succeeded');
  });

  it('renders coding-agent workspace tool calls as compact summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'bash',
            arguments: {
              command:
                'jq \'.resources["web-01"].memoryMiB = 8192\' /workspace/platform/shop/prod/virtual-machines.json',
              timeoutMs: 5000,
            },
          },
          {
            type: 'toolCall',
            name: 'read',
            arguments: {
              path: '/workspace/platform/shop/prod/virtual-machines.json',
              offset: 1,
              limit: 20,
            },
          },
          {
            type: 'toolCall',
            name: 'validate_workspace',
            arguments: {},
          },
        ]}
      />
    );

    const summaries = Array.from(container.querySelectorAll('details > summary')).map((summary) => summary.textContent);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Run workspace bash'),
        expect.stringContaining('Read workspace file'),
        expect.stringContaining('Validate workspace overlay'),
      ])
    );
    expect(summaries.some((summary) => summary?.includes('/workspace/platform/shop/prod/virtual-machines.json'))).toBe(
      false
    );
    expect(summaries.some((summary) => summary?.includes('jq'))).toBe(false);
    expect(Array.from(container.querySelectorAll('details')).every((details) => !details.hasAttribute('open'))).toBe(
      true
    );
    expect(container.textContent).toContain('Run workspace bash');
    expect(container.textContent).toContain('Read workspace file');
    expect(container.textContent).toContain('Validate workspace overlay');
    expect(container.textContent).toContain('/workspace/platform/shop/prod/virtual-machines.json');
    expect(container.textContent).not.toContain('"command"');
    expect(container.textContent).not.toContain('"path"');
  });

  it('renders workspace metadata, search, and read results without raw JSON', () => {
    const { container } = render(
      <>
        <ToolResultMessageBody
          toolName="workspace_info"
          content={[{ type: 'text', text: '{}' }]}
          details={{
            provider: { pluginId: 'grafana-assistant-app' },
            workspaceId: 'sample_wks_1',
            workspaceKind: 'sample-resource-workspace',
            displayName: 'Sample VM workspace',
            rootPath: '/workspace',
            baseVersion: 'sample-main:abc123',
            files: [
              {
                path: '/workspace/platform/shop/prod/virtual-machines.json',
                language: 'json',
                version: 'blob:abc123',
                readOnly: false,
              },
            ],
            schemas: [{ schemaId: 'virtual-machine.v1', path: '/schemas/virtual-machine.v1.schema.json' }],
            limits: { maxReadLines: 200 },
            pendingChanges: [],
          }}
        />
        <ToolResultMessageBody
          toolName="grep"
          content={[{ type: 'text', text: '{}' }]}
          details={{
            matchCount: 1,
            matches: [
              {
                path: '/workspace/platform/shop/prod/virtual-machines.json',
                line: 6,
                text: '      "memoryMiB": 4096',
              },
            ],
          }}
        />
        <ToolResultMessageBody
          toolName="read"
          content={[{ type: 'text', text: '{}' }]}
          details={{
            path: '/workspace/platform/shop/prod/virtual-machines.json',
            language: 'json',
            version: 'blob:abc123',
            checksum: 'sha256:abc123',
            totalLines: 9,
            lines: [
              { line: 5, text: '      "cpu": 2,' },
              { line: 6, text: '      "memoryMiB": 4096' },
            ],
          }}
        />
      </>
    );

    expect(container.textContent).toContain('Sample VM workspace');
    expect(container.textContent).toContain('sample_wks_1');
    expect(container.textContent).toContain('virtual-machine.v1');
    expect(container.textContent).toContain('1 matches');
    const readSummary = Array.from(container.querySelectorAll('details > summary')).find((summary) =>
      summary.textContent?.includes('/workspace/platform/shop/prod/virtual-machines.json | json | lines 5-6 of 9')
    );
    expect(readSummary).toBeTruthy();
    expect((readSummary?.parentElement as HTMLDetailsElement | undefined)?.open).toBe(false);
    expect(readSummary?.textContent).not.toContain('Read only');
    expect(readSummary?.textContent).not.toContain('Version');
    expect(readSummary?.textContent).not.toContain('Checksum');
    expect(readSummary?.textContent).not.toContain('"memoryMiB": 4096');
    expect(container.textContent).toContain('"memoryMiB": 4096');
    expect(container.textContent).toContain('5-6 of 9');
    expect(container.textContent).not.toContain('"workspaceKind"');
    expect(container.textContent).not.toContain('"matchCount"');
  });

  it('renders workspace mutation, validation, preview, and save results with diffs', () => {
    const diff =
      '--- /workspace/platform/shop/prod/virtual-machines.json\n' +
      '+++ /workspace/platform/shop/prod/virtual-machines.json\n' +
      '@@ sample diff @@\n' +
      '-{\n' +
      '-  "resources": {\n' +
      '-    "web-01": {\n' +
      '-      "kind": "VirtualMachine",\n' +
      '-      "cpu": 2,\n' +
      '-      "memoryMiB": 4096\n' +
      '-    }\n' +
      '-  }\n' +
      '-}\n' +
      '+{\n' +
      '+  "resources": {\n' +
      '+    "web-01": {\n' +
      '+      "kind": "VirtualMachine",\n' +
      '+      "cpu": 2,\n' +
      '+      "memoryMiB": 8192\n' +
      '+    }\n' +
      '+  }\n' +
      '+}\n';

    const validation = {
      status: 'warning',
      summary: 'Workspace is valid with warnings.',
      findings: [
        {
          severity: 'warning',
          message: 'web-01.memoryMiB is high',
          sourcePath: '/workspace/platform/shop/prod/virtual-machines.json',
          line: 6,
        },
      ],
      details: { 'web-01': { memoryMiB: 8192 } },
    };

    const changedFile = {
      path: '/workspace/platform/shop/prod/virtual-machines.json',
      baseVersion: 'sha256:old',
      checksum: 'sha256:new',
      addedLines: 1,
      removedLines: 1,
      firstChangedLine: 6,
      previousBytes: 119,
      currentBytes: 119,
    };

    const { container } = render(
      <>
        <ToolResultMessageBody
          toolName="edit"
          content={[{ type: 'text', text: '{}' }]}
          details={{
            path: changedFile.path,
            version: 'overlay:1',
            checksum: 'fnv32:40fbcc5a',
            changedRanges: [{ startLine: 6, endLine: 6, newLines: 1 }],
            diff,
            pendingChanges: [changedFile],
          }}
        />
        <ToolResultMessageBody
          toolName="validate_workspace"
          content={[{ type: 'text', text: '{}' }]}
          details={validation}
        />
        <ToolResultMessageBody
          toolName="preview_diff"
          content={[{ type: 'text', text: '{}' }]}
          details={{
            status: 'changed',
            workspaceId: 'sample_wks_1',
            baseVersion: 'sample-main:old',
            changedFiles: [changedFile],
            validation,
            diff,
          }}
        />
        <ToolResultMessageBody
          toolName="save_changes"
          content={[{ type: 'text', text: '{}' }]}
          details={{
            status: 'saved',
            workspaceId: 'sample_wks_1',
            savedVersion: 'sample-save:1',
            changedFiles: [changedFile],
            validation,
            diff,
            audit: { action: 'save_changes', provider: 'grafana-assistant-app' },
          }}
        />
      </>
    );

    expect(container.textContent).toContain('Workspace is valid with warnings.');
    expect(container.textContent).toContain('web-01.memoryMiB is high');
    expect(container.textContent).not.toContain(
      'Workspace file edited | /workspace/platform/shop/prod/virtual-machines.json | 6-6'
    );
    expect(container.textContent).not.toContain('Version');
    expect(container.textContent).not.toContain('Checksum');
    expect(container.textContent).not.toContain('Pending');
    expect(container.textContent).not.toContain('Saved version');
    expect(container.textContent).not.toContain('Changed files');
    expect(Array.from(container.querySelectorAll('th')).map((header) => header.textContent)).not.toEqual(
      expect.arrayContaining(['File', 'Changed', 'Size'])
    );
    const diffSummaries = Array.from(container.querySelectorAll('details > summary')).filter((summary) =>
      summary.textContent?.includes('Diff | 1 hunk | +1 / -1')
    );
    expect(diffSummaries).toHaveLength(3);
    expect(diffSummaries.every((summary) => (summary.parentElement as HTMLDetailsElement | null)?.open)).toBe(true);
    expect(diffSummaries.some((summary) => summary.textContent?.includes('memoryMiB'))).toBe(false);
    expect(container.textContent).toContain('-      "memoryMiB": 4096');
    expect(container.textContent).toContain('+      "memoryMiB": 8192');
    expect(container.textContent).toContain('       "cpu": 2,');
    expect(container.textContent).not.toContain('-      "cpu": 2,');
    expect(container.textContent).not.toContain('+      "cpu": 2,');
    expect(container.textContent).not.toContain('-{');
    expect(container.textContent).not.toContain('+{');
    expect(container.textContent).not.toContain('"changedFiles"');
    expect(container.textContent).not.toContain('"pendingChanges"');
  });

  it('renders bash results with command output and changed files', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="bash"
        content={[{ type: 'text', text: '{}' }]}
        details={{
          command: 'jq . /workspace/platform/shop/prod/virtual-machines.json',
          cwd: '/workspace',
          exitCode: 0,
          stdout: '{ "ok": true }\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          changedFiles: [
            {
              path: '/workspace/platform/shop/prod/virtual-machines.json',
              bytes: 119,
              checksum: 'fnv32:40fbcc5a',
              version: 'overlay:1',
            },
          ],
          pendingChanges: [
            {
              path: '/workspace/platform/shop/prod/virtual-machines.json',
              baseVersion: 'sha256:old',
              checksum: 'fnv32:40fbcc5a',
              previousBytes: 119,
              currentBytes: 119,
            },
          ],
        }}
      />
    );

    expect(container.textContent).toContain('Exit code');
    expect(container.textContent).toContain('jq . /workspace/platform/shop/prod/virtual-machines.json');
    expect(container.textContent).toContain('{ "ok": true }');
    expect(container.textContent).toContain('Changed files');
    expect(container.textContent).toContain('Pending changes');
    expect(container.textContent).not.toContain('"stdout"');
    expect(container.textContent).not.toContain('"changedFiles"');
  });
});

describe('ToolRenderer hardening', () => {
  const subagentUsage = {
    turns: 1,
    input: 10,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 14,
    cost: 0,
  };

  it('renders malformed subagent details without crashing', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="run_query_agent"
        content={[{ type: 'text', text: 'done' }]}
        details={{ type: 'subagent', status: 'completed' }}
      />
    );

    expect(container.textContent).toContain('Specialist agent');
    expect(container.textContent).toContain('0 tool calls');
  });

  it('renders subagent tool calls with non-string ids and names without crashing', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="run_query_agent"
        content={[{ type: 'text', text: 'done' }]}
        details={{
          type: 'subagent',
          agent: 'query',
          status: 'completed',
          task: 'Inspect.',
          toolCalls: [
            { id: 7, name: { bad: true }, args: {}, status: 'completed' },
            { name: 'list_metrics', args: {}, status: 'completed' },
          ],
          usage: subagentUsage,
        }}
      />
    );

    expect(container.textContent).toContain('2 tool calls');
    expect(container.textContent).toContain('List metric names');
  });

  it('renders non-string thinking blocks without crashing', () => {
    const { container } = render(<ContentBlocks content={[{ type: 'thinking', thinking: { nested: true } }]} />);

    expect(container.textContent).toContain('"nested"');
  });

  it('renders non-string tool call names without crashing', () => {
    const { container } = render(
      <ContentBlocks content={[{ type: 'toolCall', name: { bad: true }, arguments: { a: 1 } }]} />
    );

    expect(container.textContent).toContain('"bad"');
  });

  it('renders a completed batch shell when list_metrics batch content is truncated', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="list_metrics"
        content={[{ type: 'text', text: '{\n  "datasourceUid": "prometheus",\n  "prefixCount": 2,' }]}
        details={{ datasourceUid: 'prometheus', batch: true, prefixes: ['http_', 'node_'], count: 42, truncated: true }}
      />
    );

    expect(container.textContent).toContain('2 metric prefixes | 42 metrics | from prometheus | truncated');
    expect(container.textContent).toContain(
      'The metric list batch completed, but the detailed result text was unavailable.'
    );
    expect(container.textContent).not.toContain('"prefixCount"');
    expect(container.textContent).not.toContain('"datasourceUid"');
  });

  it('mounts range query charts only after the chart section is opened', () => {
    const query = 'rate(http_requests_total[5m])';
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
    const content = [
      {
        type: 'text',
        text: JSON.stringify({
          datasourceUid: 'prometheus',
          query,
          queryType: 'range',
          interval: '1m',
          frameCount: 1,
          totalSeries: 1,
          truncatedSeries: false,
          notices: [],
          executedQueryStrings: [],
          series: [{ name: query, labels: { job: 'api' }, points: 60, last: { value: 2 } }],
        }),
      },
    ];

    render(<ToolResultMessageBody toolName="query_prometheus" content={content} details={details} />);

    expect(screen.queryByTestId('prometheus-timeseries-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Chart'));

    expect(screen.getByTestId('prometheus-timeseries-panel')).toBeInTheDocument();
  });

  it('prefixes Explore links with the Grafana sub-path', () => {
    const query = 'rate(http_requests_total[5m])';
    const previousAppSubUrl = config.appSubUrl;
    config.appSubUrl = '/grafana';
    try {
      render(
        <ToolResultMessageBody
          toolName="query_prometheus"
          content={[
            {
              type: 'text',
              text: JSON.stringify({
                datasourceUid: 'prometheus',
                query,
                queryType: 'range',
                interval: '1m',
                frameCount: 1,
                totalSeries: 1,
                truncatedSeries: false,
                notices: [],
                executedQueryStrings: [],
                series: [{ name: query, labels: { job: 'api' }, points: 60, last: { value: 2 } }],
              }),
            },
          ]}
          details={{
            datasourceUid: 'prometheus',
            query,
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
          }}
        />
      );

      fireEvent.click(screen.getByText('Chart'));

      const href = screen.getByRole('link', { name: 'Explore' }).getAttribute('href') ?? '';
      expect(href.startsWith('/grafana/explore?left=')).toBe(true);
    } finally {
      config.appSubUrl = previousAppSubUrl;
    }
  });

  it('renders a structured streaming summary from partial query_prometheus JSON', () => {
    const partialJson =
      '{"datasourceUid":"prometheus","queries":[{"query":"rate(http_requests_total[5m])","type":"range","start":"now-1h","end":"no';

    const { container } = render(
      <ContentBlocks
        content={[{ type: 'toolCall', name: 'query_prometheus', arguments: undefined, partialJson }]}
        isStreaming
      />
    );

    expect(container.textContent).toContain('1 range query');
    expect(container.textContent).toContain('streaming');
    expect(container.textContent).toContain('rate(http_requests_total[5m])');
    expect(container.textContent).not.toContain('"queries"');
  });

  it('counts removed lines starting with dashes as content, not metadata', () => {
    const diff =
      '--- dashboard.jsonnet\n' +
      '+++ dashboard.jsonnet\n' +
      '@@ -1,2 +1,2 @@\n' +
      '---foo\n' +
      '+++bar\n' +
      ' context\n';

    const { container } = render(
      <ToolResultMessageBody
        toolName="edit_jsonnet"
        content={[{ type: 'text', text: '{}' }]}
        details={{ path: 'dashboard.jsonnet', changedRanges: [], diff }}
      />
    );

    expect(container.textContent).toContain('Diff | 1 hunk | +1 / -1');
  });

  it('does not fabricate hunk positions when the diff header is unparseable', () => {
    const diff =
      '@@ sample diff @@\n' +
      '-{\n' +
      '-  "a": 1,\n' +
      '-  "b": 2,\n' +
      '-  "c": 3\n' +
      '-}\n' +
      '+{\n' +
      '+  "a": 1,\n' +
      '+  "b": 2,\n' +
      '+  "c": 4\n' +
      '+}\n';

    const { container } = render(
      <ToolResultMessageBody
        toolName="edit_jsonnet"
        content={[{ type: 'text', text: '{}' }]}
        details={{ path: 'dashboard.jsonnet', changedRanges: [], diff }}
      />
    );

    expect(container.textContent).toContain('@@ sample diff @@');
    expect(container.textContent).not.toMatch(/@@ -\d/);
  });

  it('renders alert rule matches with duplicate rule names without duplicate keys', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ToolResultMessageBody
          toolName="find_panel_alert_rules"
          content={[
            {
              type: 'text',
              text: JSON.stringify({
                ruleCount: 2,
                matchCount: 2,
                exactPanelMatchCount: 0,
                matches: [
                  { score: 1, reasons: [], rule: { name: 'unknown', title: 'Rule A' } },
                  { score: 1, reasons: [], rule: { name: 'unknown', title: 'Rule B' } },
                ],
              }),
            },
          ]}
          details={{ ruleCount: 2, matchCount: 2 }}
        />
      );

      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('falls back to the default error message instead of dumping JSON', () => {
    render(
      <ToolResultMessageBody
        toolName="query_prometheus"
        content={undefined}
        details={{ someField: { nested: true } }}
        isError
      />
    );

    const error = screen.getByTestId('tool-error');
    expect(error.textContent).toContain('Tool failed without a readable error message.');
  });

  it('ignores non-string error primitives like false', () => {
    render(
      <ToolResultMessageBody toolName="query_prometheus" content={undefined} details={{ error: false }} isError />
    );

    const error = screen.getByTestId('tool-error');
    expect(error.textContent).toContain('Tool failed without a readable error message.');
    // The raw details JSON stays inspectable in the Details section, but the
    // headline error message must not be the stringified primitive.
    expect(screen.queryByText('false')).not.toBeInTheDocument();
  });

  it('omits the line range for empty jsonnet library reads', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="read_grafonnet"
        content={[{ type: 'text', text: JSON.stringify({ path: 'gen.libsonnet', totalLines: 10, result: [] }) }]}
        details={{}}
      />
    );

    expect(container.textContent).not.toContain('0-0');
  });

  it('skips non-primitive label values instead of stringifying them', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="inspect_metric_series"
        content={[
          {
            type: 'text',
            text: JSON.stringify({
              datasourceUid: 'prometheus',
              match: 'up',
              labelNames: ['job'],
              totalSeries: 1,
              truncated: false,
              examples: [{ job: 'api', bad: { nested: true } }],
            }),
          },
        ]}
        details={undefined}
      />
    );

    expect(container.textContent).toContain('Selector');
    expect(container.textContent).toContain('job');
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('does not render dashboard links with unsafe schemes', () => {
    render(
      <ToolResultMessageBody
        toolName="list_dashboards"
        content={[
          {
            type: 'text',
            text: JSON.stringify([{ title: 'Evil', uid: 'evil', url: 'javascript:alert(1)' }]),
          },
        ]}
        details={{}}
      />
    );

    expect(screen.queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Open').length).toBeGreaterThan(0);
  });

  it('strips remote images and iframes from rendered markdown', () => {
    const { container } = render(
      <ContentBlocks
        content={'![exfil](https://evil.example/x.png)\n\n<iframe src="https://evil.example"></iframe>\n\nplain text'}
      />
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('plain text');
  });

  it('memoizes jsonnet highlighting across re-renders of the same content', () => {
    const highlightMock = highlightJsonnetLines as jest.Mock;
    highlightMock.mockClear();
    const block = () => (
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'write_jsonnet',
            arguments: { path: 'dashboard.jsonnet', content: 'local a = 1;\n{ panels: [] }' },
          },
        ]}
      />
    );

    const { rerender } = render(block());
    const callsAfterFirstRender = highlightMock.mock.calls.length;
    expect(callsAfterFirstRender).toBeGreaterThan(0);

    rerender(block());

    expect(highlightMock.mock.calls.length).toBe(callsAfterFirstRender);
  });

  it('memoizes diff optimization across re-renders of the same diff', () => {
    const patchMock = structuredPatch as jest.Mock;
    patchMock.mockClear();
    const diff =
      '@@ -1,5 +1,5 @@\n' +
      '-{\n' +
      '-  "a": 1,\n' +
      '-  "b": 2,\n' +
      '-  "c": 3\n' +
      '-}\n' +
      '+{\n' +
      '+  "a": 1,\n' +
      '+  "b": 2,\n' +
      '+  "c": 4\n' +
      '+}\n';
    const block = () => (
      <ToolResultMessageBody
        toolName="edit_jsonnet"
        content={[{ type: 'text', text: '{}' }]}
        details={{ path: 'dashboard.jsonnet', changedRanges: [], diff }}
      />
    );

    const { rerender } = render(block());
    const callsAfterFirstRender = patchMock.mock.calls.length;
    expect(callsAfterFirstRender).toBeGreaterThan(0);

    rerender(block());

    expect(patchMock.mock.calls.length).toBe(callsAfterFirstRender);
  });
});
