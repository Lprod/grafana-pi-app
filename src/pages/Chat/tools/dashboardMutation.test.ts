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

jest.mock('./dashboards', () => ({
  renderDashboardScreenshot: jest.fn(),
}));

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { DashboardMutationAPI, DashboardMutationResult } from '@grafana/data';
import { createLiveDashboardMutationTools } from './dashboardMutation';

describe('live dashboard mutation tools', () => {
  it('returns compact text for large LIST_PANELS results while preserving full details data', async () => {
    const rawMarker = `RAW_LIST_PANEL_PAYLOAD_${'x'.repeat(4096)}`;
    const data = {
      elements: Array.from({ length: 24 }, (_, index) => {
        const panelNumber = index + 1;
        const elementName = `panel-${panelNumber}`;
        return {
          element: {
            kind: 'Panel',
            spec: {
              id: panelNumber,
              title: `Panel ${panelNumber}`,
              description: `Panel ${panelNumber} summary`,
              vizConfig: { group: index % 2 === 0 ? 'timeseries' : 'stat' },
              fieldConfig: {
                defaults: {
                  custom: {
                    rawMarker,
                  },
                },
              },
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
                          datasource: { name: 'prometheus' },
                          spec: { expr: `sum(rate(http_requests_total{panel="${panelNumber}"}[5m]))` },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          layoutItem: {
            kind: 'GridLayoutItem',
            spec: {
              x: (index % 2) * 12,
              y: Math.floor(index / 2) * 8,
              width: 12,
              height: 8,
              element: { kind: 'ElementReference', name: elementName },
            },
          },
        };
      }),
    };
    const dashboardMutation = createDashboardMutationApi({
      LIST_PANELS: mutationResult({ data }),
    });
    const tool = getTool(createLiveDashboardMutationTools(dashboardMutation), 'list_live_dashboard_panels');

    const result = await tool.execute('call-1', { includeStatus: true }, undefined);
    const text = textContent(result);

    expect(text.length).toBeLessThan(12000);
    expect(text).toContain('Live dashboard mutation LIST_PANELS succeeded.');
    expect(text).toContain('"panelCount": 24');
    expect(text).toContain('"elementName": "panel-1"');
    expect(text).toContain('"title": "Panel 1"');
    expect(text).not.toContain(rawMarker);
    expect(JSON.stringify(result.details)).toContain(rawMarker);
    expect(result.details).toMatchObject({
      command: 'LIST_PANELS',
      success: true,
      data,
    });
  });

  it('returns compact text for large GET_LAYOUT results while preserving full details data', async () => {
    const rawMarker = `RAW_LAYOUT_PAYLOAD_${'y'.repeat(4096)}`;
    const data = {
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
                element: { kind: 'ElementReference', name: 'panel-1' },
                runtimeState: { rawMarker },
              },
            },
          ],
        },
      },
      elements: {
        'panel-1': {
          kind: 'Panel',
          spec: {
            title: 'Request rate',
            vizConfig: { group: 'timeseries' },
            fieldConfig: { defaults: { custom: { rawMarker } } },
          },
        },
      },
    };
    const dashboardMutation = createDashboardMutationApi({
      GET_LAYOUT: mutationResult({ data }),
    });
    const tool = getTool(createLiveDashboardMutationTools(dashboardMutation), 'get_live_dashboard_layout');

    const result = await tool.execute('call-1', {}, undefined);
    const text = textContent(result);

    expect(text.length).toBeLessThan(4000);
    expect(text).toContain('Live dashboard mutation GET_LAYOUT succeeded.');
    expect(text).toContain('"elementName": "panel-1"');
    expect(text).toContain('"title": "Request rate"');
    expect(text).not.toContain(rawMarker);
    expect(JSON.stringify(result.details)).toContain(rawMarker);
    expect(result.details).toMatchObject({
      command: 'GET_LAYOUT',
      success: true,
      data,
    });
  });

  it('omits raw write mutation data from text while preserving details data', async () => {
    const rawMarker = `RAW_UPDATE_PANEL_PAYLOAD_${'z'.repeat(4096)}`;
    const data = {
      element: { kind: 'ElementReference', name: 'panel-1' },
      panel: {
        kind: 'Panel',
        spec: {
          title: 'Renamed panel',
          fieldConfig: { defaults: { custom: { rawMarker } } },
        },
      },
    };
    const dashboardMutation = createDashboardMutationApi({
      UPDATE_PANEL: mutationResult({
        data,
        changes: [{ path: 'elements.panel-1.spec.title', previousValue: 'Old panel', newValue: 'Renamed panel' }],
      }),
    });
    const tool = getTool(createLiveDashboardMutationTools(dashboardMutation), 'rename_live_dashboard_panel');

    const result = await tool.execute('call-1', { elementName: 'panel-1', title: 'Renamed panel' }, undefined);
    const text = textContent(result);

    expect(text).toContain('Live dashboard mutation UPDATE_PANEL succeeded.');
    expect(text).toContain('Changes: 1');
    expect(text).not.toContain('Result:');
    expect(text).not.toContain(rawMarker);
    expect(JSON.stringify(result.details)).toContain(rawMarker);
    expect(result.details).toMatchObject({
      command: 'UPDATE_PANEL',
      success: true,
      data,
    });
  });

  it('batch-updates panel expressions while preserving untouched queries and datasource metadata', async () => {
    const panelData = livePanelData([
      livePanel('panel-1', [
        liveQuery('A', 'sum(rate(old_metric[5m]))', { hidden: true, datasourceName: 'prom-prod' }),
        liveQuery('B', 'sum(rate(untouched_metric[5m]))', { datasourceName: 'prom-prod' }),
      ]),
    ]);
    const dashboardMutation = {
      execute: jest.fn(async ({ type, payload }: { type: string; payload: any }) => {
        if (type === 'LIST_PANELS') {
          return mutationResult({ data: panelData });
        }
        if (type === 'UPDATE_PANEL') {
          return mutationResult({
            data: payload,
            changes: [{ path: '/elements/panel-1/spec/data', previousValue: null, newValue: payload.panel }],
          });
        }
        throw new Error(`Unexpected dashboard mutation command: ${type}`);
      }),
      getAvailableCommands: jest.fn(() => ['LIST_PANELS', 'UPDATE_PANEL']),
    } as unknown as DashboardMutationAPI;
    const tool = getTool(createLiveDashboardMutationTools(dashboardMutation), 'update_live_dashboard_panel_queries');

    const result = await tool.execute(
      'call-1',
      {
        updates: [{ elementName: 'panel-1', refId: 'A', queryExpression: 'sum(rate(new_metric[5m]))' }],
      },
      undefined
    );

    expect(dashboardMutation.execute).toHaveBeenCalledTimes(2);
    const updatePayload = (dashboardMutation.execute as jest.Mock).mock.calls[1][0].payload;
    expect(updatePayload.panel.spec.data.spec.queries).toEqual([
      liveQuery('A', 'sum(rate(new_metric[5m]))', { hidden: true, datasourceName: 'prom-prod' }),
      liveQuery('B', 'sum(rate(untouched_metric[5m]))', { datasourceName: 'prom-prod' }),
    ]);
    expect(result.details).toMatchObject({
      command: 'BATCH_UPDATE_PANEL_QUERIES',
      success: true,
      changedPanelCount: 1,
      queryChangeCount: 1,
      appliedPanelCount: 1,
    });
  });

  it('previews batch query updates without writing', async () => {
    const dashboardMutation = createDashboardMutationApi({
      LIST_PANELS: mutationResult({
        data: livePanelData([livePanel('panel-1', [liveQuery('A', 'up')])]),
      }),
    });
    const tool = getTool(createLiveDashboardMutationTools(dashboardMutation), 'update_live_dashboard_panel_queries');

    const result = await tool.execute(
      'call-1',
      { updates: [{ elementName: 'panel-1', queryExpression: 'up == 1' }], dryRun: true },
      undefined
    );

    expect(dashboardMutation.execute).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ dryRun: true, success: true, queryChangeCount: 1, appliedPanelCount: 0 });
  });

  it('requires non-empty optional filter scope arrays in the tool schema', () => {
    const dashboardMutation = createDashboardMutationApi({});
    const tool = getTool(
      createLiveDashboardMutationTools(dashboardMutation),
      'apply_live_dashboard_prometheus_label_filter'
    );
    const properties = (tool.parameters as any).properties;

    expect(properties.elements.minItems).toBe(1);
    expect(properties.refIds.minItems).toBe(1);
  });

  it('omits dashboard-level parentPath for Grafana runtimes without section variables', async () => {
    const dashboardMutation = {
      execute: jest.fn(async ({ type, payload }: { type: string; payload: unknown }) => {
        expect(type).toBe('LIST_VARIABLES');
        expect(payload).toEqual({});
        return mutationResult({ data: { variables: [] } });
      }),
      getPayloadSchema: jest.fn(() => strictEmptyPayloadSchema()),
      getAvailableCommands: jest.fn(() => ['LIST_VARIABLES']),
    } as unknown as DashboardMutationAPI;
    const tool = getTool(createLiveDashboardMutationTools(dashboardMutation), 'list_live_dashboard_variables');

    await tool.execute('call-1', { parentPath: '/' }, undefined);
    await tool.execute('call-2', { parentPath: '' }, undefined);

    expect(dashboardMutation.execute).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported section-scoped variable operations before mutation', async () => {
    const dashboardMutation = {
      execute: jest.fn(),
      getPayloadSchema: jest.fn(() => strictEmptyPayloadSchema()),
      getAvailableCommands: jest.fn(() => ['LIST_VARIABLES']),
    } as unknown as DashboardMutationAPI;
    const tool = getTool(createLiveDashboardMutationTools(dashboardMutation), 'list_live_dashboard_variables');

    await expect(tool.execute('call-1', { parentPath: '/rows/0' }, undefined)).rejects.toThrow(
      'The current Grafana runtime does not support section-scoped variables for LIST_VARIABLES.'
    );
    expect(dashboardMutation.execute).not.toHaveBeenCalled();
  });

  it('passes section scope when the Grafana mutation schema supports it', async () => {
    const dashboardMutation = {
      execute: jest.fn(async () => mutationResult({ data: { variables: [] } })),
      getPayloadSchema: jest.fn(() => permissivePayloadSchema()),
      getAvailableCommands: jest.fn(() => ['LIST_VARIABLES']),
    } as unknown as DashboardMutationAPI;
    const tool = getTool(createLiveDashboardMutationTools(dashboardMutation), 'list_live_dashboard_variables');

    await tool.execute('call-1', { parentPath: '/rows/0' }, undefined);

    expect(dashboardMutation.execute).toHaveBeenCalledWith({
      type: 'LIST_VARIABLES',
      payload: { parentPath: '/rows/0' },
    });
  });

  it('omits dashboard-level parentPath from add and update variable mutations', async () => {
    const dashboardMutation = {
      execute: jest.fn(async ({ payload }: { payload: Record<string, unknown> }) => {
        expect(payload).not.toHaveProperty('parentPath');
        return mutationResult({ data: payload });
      }),
      getPayloadSchema: jest.fn(() => strictEmptyPayloadSchema()),
      getAvailableCommands: jest.fn(() => ['ADD_VARIABLE', 'LIST_VARIABLES', 'UPDATE_VARIABLE']),
    } as unknown as DashboardMutationAPI;
    const tools = createLiveDashboardMutationTools(dashboardMutation);

    await getTool(tools, 'add_live_dashboard_variable').execute(
      'call-1',
      { name: 'env', options: ['prod'], parentPath: '/' },
      undefined
    );
    await getTool(tools, 'update_live_dashboard_variable').execute(
      'call-2',
      { name: 'env', options: ['prod'], parentPath: '' },
      undefined
    );

    expect(dashboardMutation.execute).toHaveBeenCalledTimes(2);
  });

  it('adds a Prometheus variable, filters all panel selectors, and verifies the result', async () => {
    let variables: Array<Record<string, unknown>> = [];
    let panels = [
      livePanel('panel-1', [liveQuery('A', 'sum(rate(http_requests_total{status=~"5.."}[5m]))')]),
      livePanel('panel-2', [liveQuery('A', 'max(rate(process_cpu_seconds_total[$__rate_interval]))')]),
    ];
    const dashboardMutation = {
      execute: jest.fn(async ({ type, payload }: { type: string; payload: any }) => {
        if (type === 'LIST_PANELS') {
          return mutationResult({ data: livePanelData(panels) });
        }
        if (type === 'LIST_VARIABLES') {
          return mutationResult({ data: { variables } });
        }
        if (type === 'ADD_VARIABLE') {
          variables = [payload.variable];
          return mutationResult({
            data: payload,
            changes: [{ path: '/variables/env', previousValue: null, newValue: payload.variable }],
          });
        }
        if (type === 'UPDATE_PANEL') {
          const elementName = payload.element.name;
          panels = panels.map((panel) =>
            panel.name === elementName
              ? {
                  ...panel,
                  element: { ...panel.element, spec: { ...panel.element.spec, data: payload.panel.spec.data } },
                }
              : panel
          );
          return mutationResult({
            data: payload,
            changes: [{ path: `/elements/${elementName}/spec/data`, previousValue: null, newValue: payload.panel }],
          });
        }
        throw new Error(`Unexpected dashboard mutation command: ${type}`);
      }),
      getAvailableCommands: jest.fn(() => [
        'ADD_VARIABLE',
        'LIST_PANELS',
        'LIST_VARIABLES',
        'UPDATE_PANEL',
        'UPDATE_VARIABLE',
      ]),
    } as unknown as DashboardMutationAPI;
    const tool = getTool(
      createLiveDashboardMutationTools(dashboardMutation),
      'apply_live_dashboard_prometheus_label_filter'
    );

    const result = await tool.execute(
      'call-1',
      {
        variableName: 'env',
        variableLabel: 'Environment',
        variableQueryExpression: 'label_values(http_requests_total, env)',
        current: 'prod',
      },
      undefined
    );

    expect(result.details).toMatchObject({
      command: 'APPLY_PROMETHEUS_LABEL_FILTER',
      success: true,
      variable: { name: 'env', action: 'add' },
      matchedPanelCount: 2,
      changedPanelCount: 2,
      matchedQueryCount: 2,
      changedQueryCount: 2,
      verification: { variablePresent: true, matchingQueryCount: 2, mismatches: [] },
    });
    expect(panelQueryExpressions(panels)).toEqual([
      'sum(rate(http_requests_total{status=~"5..", env=~"$env"}[5m]))',
      'max(rate(process_cpu_seconds_total{env=~"$env"}[$__rate_interval]))',
    ]);
    expect((dashboardMutation.execute as jest.Mock).mock.calls.map(([call]) => call.type)).toEqual([
      'LIST_PANELS',
      'LIST_VARIABLES',
      'ADD_VARIABLE',
      'UPDATE_PANEL',
      'UPDATE_PANEL',
      'LIST_PANELS',
      'LIST_VARIABLES',
    ]);
  });
});

function livePanelData(panels: Array<Record<string, any>>) {
  return { elements: panels };
}

function livePanel(name: string, queries: Array<Record<string, unknown>>) {
  return {
    name,
    element: {
      kind: 'Panel',
      spec: {
        title: name,
        data: { kind: 'QueryGroup', spec: { queries } },
      },
    },
  };
}

function liveQuery(refId: string, expression: string, options: { hidden?: boolean; datasourceName?: string } = {}) {
  return {
    kind: 'PanelQuery',
    spec: {
      refId,
      ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
      query: {
        kind: 'DataQuery',
        group: 'prometheus',
        ...(options.datasourceName ? { datasource: { name: options.datasourceName } } : {}),
        spec: { expr: expression },
      },
    },
  };
}

function panelQueryExpressions(panels: Array<Record<string, any>>) {
  return panels.flatMap((panel) =>
    panel.element.spec.data.spec.queries.map((query: Record<string, any>) => query.spec.query.spec.expr)
  );
}

function createDashboardMutationApi(results: Record<string, DashboardMutationResult>): DashboardMutationAPI {
  return {
    execute: jest.fn(async ({ type }: { type: string }) => {
      const result = results[type];
      if (!result) {
        throw new Error(`Unexpected dashboard mutation command: ${type}`);
      }
      return result;
    }),
    getAvailableCommands: jest.fn(() => [
      'ADD_VARIABLE',
      'GET_DASHBOARD_INFO',
      'GET_LAYOUT',
      'LIST_PANELS',
      'LIST_VARIABLES',
      'UPDATE_PANEL',
      'UPDATE_VARIABLE',
    ]),
  } as unknown as DashboardMutationAPI;
}

function strictEmptyPayloadSchema() {
  return {
    parse: (data: unknown) => data,
    safeParse: (data: unknown) =>
      data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0
        ? { success: true, data }
        : { success: false, error: new Error('Unrecognized key') },
  };
}

function permissivePayloadSchema() {
  return {
    parse: (data: unknown) => data,
    safeParse: (data: unknown) => ({ success: true, data }),
  };
}

function mutationResult({
  data,
  changes = [],
}: {
  data: unknown;
  changes?: DashboardMutationResult['changes'];
}): DashboardMutationResult {
  return {
    success: true,
    changes,
    data,
    warnings: [],
  };
}

function getTool(tools: AgentTool[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool;
}

function textContent(result: AgentToolResult<Record<string, unknown>>) {
  const block = result.content[0];
  return block.type === 'text' ? (block.text ?? '') : '';
}
