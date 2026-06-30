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
});

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
      'GET_DASHBOARD_INFO',
      'GET_LAYOUT',
      'LIST_PANELS',
      'LIST_VARIABLES',
      'UPDATE_PANEL',
    ]),
  } as unknown as DashboardMutationAPI;
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
