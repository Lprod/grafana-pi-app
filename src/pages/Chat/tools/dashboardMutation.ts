import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { DashboardMutationAPI, DashboardMutationResult } from '@grafana/data';
import { Type } from 'typebox';
import { renderDashboardScreenshot } from './dashboards';
import { textResult, throwIfAborted, truncateText } from './result';

const MAX_MUTATION_RESULT_TEXT = 100000;
const DEFAULT_VISUAL_VERIFICATION_WIDTH = 1200;
const DEFAULT_VISUAL_VERIFICATION_HEIGHT = 700;

const READ_COMMANDS = new Set([
  'GET_DASHBOARD_INFO',
  'GET_LAYOUT',
  'LIST_ANNOTATIONS',
  'LIST_PANELS',
  'LIST_VARIABLES',
]);

export const LIVE_DASHBOARD_WRITE_TOOLS = new Set([
  'rename_live_dashboard_panel',
  'update_live_dashboard_panel_query',
  'add_live_dashboard_panel',
  'move_or_resize_live_dashboard_panel',
  'update_live_dashboard_settings',
  'add_live_dashboard_variable',
  'update_live_dashboard_variable',
  'apply_live_dashboard_mutation',
]);

const LIVE_PANEL_VISUALIZATION_TYPES = Type.Union(
  [Type.Literal('timeseries'), Type.Literal('stat'), Type.Literal('gauge'), Type.Literal('table'), Type.String()],
  { description: 'Grafana panel visualization plugin ID. Common values: timeseries, stat, gauge, table.' }
);

const LIVE_VARIABLE_TYPES = Type.Union([Type.Literal('custom'), Type.Literal('query')], {
  description: 'Variable type. Use custom for comma-separated fixed options and query for datasource-backed options.',
});

type ApplyLiveDashboardMutationParams = {
  type: string;
  payload?: unknown;
};

type LiveDashboardPanelParams = {
  elements?: string[];
  evaluateVariables?: boolean;
  includeStatus?: boolean;
};

type LiveDashboardSchemaParams = {
  command?: string;
};

type LiveDashboardVariableListParams = {
  parentPath?: string;
};

type RenameLiveDashboardPanelParams = {
  elementName: string;
  title: string;
  description?: string;
};

type UpdateLiveDashboardPanelQueryParams = {
  elementName: string;
  queryExpression?: string;
  querySpec?: unknown;
  datasourceType?: string;
  datasourceName?: string;
  refId?: string;
  hidden?: boolean;
};

type LiveDashboardPanelQueryInput = Omit<UpdateLiveDashboardPanelQueryParams, 'elementName'>;

type LiveDashboardPanelQueryDefaults = {
  refId?: string;
  hidden?: boolean;
  group?: string;
  version?: string;
  datasource?: Record<string, unknown>;
};

type AddLiveDashboardPanelParams = {
  title: string;
  queryExpression?: string;
  querySpec?: unknown;
  datasourceType?: string;
  datasourceName?: string;
  refId?: string;
  visualizationType?: string;
  description?: string;
  unit?: string;
  parentPath?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type MoveOrResizeLiveDashboardPanelParams = {
  elementName: string;
  parentPath?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type UpdateLiveDashboardSettingsParams = {
  title?: string;
  description?: string;
  tags?: string[];
  from?: string;
  to?: string;
  autoRefresh?: string;
  timezone?: string;
  editable?: boolean;
  cursorSync?: 'Off' | 'Crosshair' | 'Tooltip';
  liveNow?: boolean;
  preload?: boolean;
};

type LiveDashboardVariableParams = {
  name: string;
  newName?: string;
  variableType?: 'custom' | 'query';
  label?: string;
  description?: string;
  query?: string;
  queryExpression?: string;
  querySpec?: unknown;
  datasourceType?: string;
  datasourceName?: string;
  options?: string[];
  current?: string;
  multi?: boolean;
  includeAll?: boolean;
  allValue?: string;
  position?: number;
  parentPath?: string;
};

export function createLiveDashboardMutationTools(dashboardMutation?: DashboardMutationAPI): AgentTool[] {
  if (!dashboardMutation) {
    return [];
  }

  const availableCommands = safeAvailableCommands(dashboardMutation);
  if (availableCommands.length === 0) {
    return [];
  }

  const tools = [
    makeListLiveDashboardPanelsTool(dashboardMutation),
    makeGetLiveDashboardLayoutTool(dashboardMutation),
    makeGetLiveDashboardInfoTool(dashboardMutation),
    makeListLiveDashboardVariablesTool(dashboardMutation),
    makeGetLiveDashboardMutationSchemaTool(dashboardMutation),
    commandAvailable(availableCommands, 'UPDATE_PANEL')
      ? makeRenameLiveDashboardPanelTool(dashboardMutation)
      : undefined,
    commandAvailable(availableCommands, 'UPDATE_PANEL')
      ? makeUpdateLiveDashboardPanelQueryTool(dashboardMutation)
      : undefined,
    commandAvailable(availableCommands, 'ADD_PANEL') ? makeAddLiveDashboardPanelTool(dashboardMutation) : undefined,
    commandAvailable(availableCommands, 'MOVE_PANEL')
      ? makeMoveOrResizeLiveDashboardPanelTool(dashboardMutation)
      : undefined,
    commandAvailable(availableCommands, 'UPDATE_DASHBOARD_SETTINGS')
      ? makeUpdateLiveDashboardSettingsTool(dashboardMutation)
      : undefined,
    commandAvailable(availableCommands, 'ADD_VARIABLE')
      ? makeAddLiveDashboardVariableTool(dashboardMutation)
      : undefined,
    commandAvailable(availableCommands, 'UPDATE_VARIABLE')
      ? makeUpdateLiveDashboardVariableTool(dashboardMutation)
      : undefined,
    makeApplyLiveDashboardMutationTool(dashboardMutation),
  ];

  return tools.filter((tool): tool is AgentTool => Boolean(tool));
}

function makeListLiveDashboardPanelsTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'list_live_dashboard_panels',
    label: 'List live dashboard panels',
    description:
      'List panels from the currently loaded Grafana dashboard scene, including element names used by live dashboard mutation commands. Use this before live panel edits.',
    parameters: Type.Object({
      elements: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Optional panel element names to return, for example ["panel-1"]. Omit to return all panels.',
        })
      ),
      evaluateVariables: Type.Optional(
        Type.Boolean({ description: 'Include evaluated queries with current dashboard variables resolved.' })
      ),
      includeStatus: Type.Optional(
        Type.Boolean({
          description:
            'Include runtime status and data frame schema for each panel. Use this after edits or when troubleshooting.',
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as LiveDashboardPanelParams;
      const payload = compactRecord({
        elements: args.elements,
        evaluateVariables: args.evaluateVariables,
        includeStatus: args.includeStatus,
      });
      const result = await dashboardMutation.execute({ type: 'LIST_PANELS', payload });
      return mutationResult('LIST_PANELS', result, dashboardMutation, payload);
    },
  };
}

function makeGetLiveDashboardLayoutTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'get_live_dashboard_layout',
    label: 'Get live dashboard layout',
    description:
      'Read the currently loaded dashboard layout tree and element map. Use this to find row/tab paths and panel element names before moving or adding panels.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      throwIfAborted(signal);
      const result = await dashboardMutation.execute({ type: 'GET_LAYOUT', payload: {} });
      return mutationResult('GET_LAYOUT', result, dashboardMutation, {});
    },
  };
}

function makeGetLiveDashboardInfoTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'get_live_dashboard_info',
    label: 'Get live dashboard info',
    description:
      'Read identity, folder metadata, time settings, tags, links, and other settings for the currently loaded dashboard.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      throwIfAborted(signal);
      const result = await dashboardMutation.execute({ type: 'GET_DASHBOARD_INFO', payload: {} });
      return mutationResult('GET_DASHBOARD_INFO', result, dashboardMutation, {});
    },
  };
}

function makeListLiveDashboardVariablesTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'list_live_dashboard_variables',
    label: 'List live dashboard variables',
    description:
      'List template variables on the currently loaded dashboard, optionally scoped to a row or tab parent path from get_live_dashboard_layout.',
    parameters: Type.Object({
      parentPath: Type.Optional(
        Type.String({
          description: 'Optional layout path for section variables, for example "/rows/0". Defaults to "/".',
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as LiveDashboardVariableListParams;
      const payload = compactRecord({ parentPath: args.parentPath });
      const result = await dashboardMutation.execute({ type: 'LIST_VARIABLES', payload });
      return mutationResult('LIST_VARIABLES', result, dashboardMutation, payload);
    },
  };
}

function makeGetLiveDashboardMutationSchemaTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'get_live_dashboard_mutation_schema',
    label: 'Get live dashboard mutation schema',
    description:
      'List available live dashboard mutation commands and show compact payload guidance for common panel/layout edits. Actual validation is performed by Grafana when applying the mutation.',
    parameters: Type.Object({
      command: Type.Optional(
        Type.String({
          description:
            'Optional Grafana mutation command, for example UPDATE_PANEL, ADD_PANEL, MOVE_PANEL, REMOVE_PANEL, UPDATE_DASHBOARD_SETTINGS.',
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as LiveDashboardSchemaParams;
      const command = normalizeCommand(args.command);
      const availableCommands = safeAvailableCommands(dashboardMutation);
      const body = command
        ? {
            command,
            available: commandAvailable(availableCommands, command),
            readOnly: READ_COMMANDS.has(command),
            guidance: COMMAND_GUIDANCE[command] ?? defaultCommandGuidance(command),
            availableCommands,
          }
        : {
            availableCommands,
            guidance: COMMON_COMMAND_GUIDANCE,
          };

      return textResult(JSON.stringify(body, null, 2), {
        command,
        availableCommands,
        guidanceOnly: true,
      });
    },
  };
}

function makeRenameLiveDashboardPanelTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'rename_live_dashboard_panel',
    label: 'Rename live dashboard panel',
    description:
      'Rename or describe one panel in the currently loaded dashboard. Use after list_live_dashboard_panels to get the panel element name.',
    executionMode: 'sequential',
    parameters: Type.Object({
      elementName: Type.String({
        description: 'Panel element name from list_live_dashboard_panels, for example "panel-1".',
      }),
      title: Type.String({ description: 'New panel title. Use an empty string only if the user explicitly asks.' }),
      description: Type.Optional(Type.String({ description: 'Optional new panel description.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as RenameLiveDashboardPanelParams;
      const payload = {
        element: elementReference(args.elementName),
        panel: panelPatch({
          title: args.title,
          description: args.description,
        }),
      };
      const result = await dashboardMutation.execute({ type: 'UPDATE_PANEL', payload });
      return mutationResult('UPDATE_PANEL', result, dashboardMutation, payload);
    },
  };
}

function makeUpdateLiveDashboardPanelQueryTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'update_live_dashboard_panel_query',
    label: 'Update live dashboard panel query',
    description:
      'Replace the queries for one panel in the currently loaded dashboard. For Prometheus or Loki, pass queryExpression; for advanced datasource payloads, pass querySpec.',
    executionMode: 'sequential',
    parameters: Type.Object({
      elementName: Type.String({ description: 'Panel element name from list_live_dashboard_panels.' }),
      queryExpression: Type.Optional(
        Type.String({ description: 'Datasource query expression. For Prometheus and Loki this becomes spec.expr.' })
      ),
      querySpec: Type.Optional(
        Type.Any({
          description: 'Advanced datasource-specific DataQuery spec object. Overrides queryExpression when set.',
        })
      ),
      datasourceType: Type.Optional(
        Type.String({
          description: 'Datasource plugin type. Defaults to prometheus. Examples: prometheus, loki, mysql.',
        })
      ),
      datasourceName: Type.Optional(
        Type.String({ description: 'Optional datasource name used by Grafana v2beta1 DataQueryKind.' })
      ),
      refId: Type.Optional(Type.String({ description: 'Query refId. Defaults to A.' })),
      hidden: Type.Optional(Type.Boolean({ description: 'Whether the query should be hidden. Defaults to false.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as UpdateLiveDashboardPanelQueryParams;
      const existingQuery = await readLivePanelQueryDefaults(dashboardMutation, args.elementName, args.refId);
      const payload = {
        element: elementReference(args.elementName),
        panel: panelPatch({
          data: queryGroup([
            panelQuery(
              {
                refId: args.refId,
                hidden: args.hidden,
                datasourceType: args.datasourceType,
                datasourceName: args.datasourceName,
                queryExpression: args.queryExpression,
                querySpec: args.querySpec,
              },
              existingQuery
            ),
          ]),
        }),
      };
      const result = await dashboardMutation.execute({ type: 'UPDATE_PANEL', payload });
      return mutationResult('UPDATE_PANEL', result, dashboardMutation, payload);
    },
  };
}

function makeAddLiveDashboardPanelTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'add_live_dashboard_panel',
    label: 'Add live dashboard panel',
    description:
      'Add a panel to the currently loaded dashboard and attach an automatic screenshot verification when rendering is configured.',
    executionMode: 'sequential',
    parameters: Type.Object({
      title: Type.String({ description: 'Panel title.' }),
      queryExpression: Type.Optional(
        Type.String({ description: 'Datasource query expression. For Prometheus and Loki this becomes spec.expr.' })
      ),
      querySpec: Type.Optional(
        Type.Any({
          description: 'Advanced datasource-specific DataQuery spec object. Overrides queryExpression when set.',
        })
      ),
      datasourceType: Type.Optional(Type.String({ description: 'Datasource plugin type. Defaults to prometheus.' })),
      datasourceName: Type.Optional(Type.String({ description: 'Optional datasource name.' })),
      refId: Type.Optional(Type.String({ description: 'Query refId. Defaults to A.' })),
      visualizationType: Type.Optional(LIVE_PANEL_VISUALIZATION_TYPES),
      description: Type.Optional(Type.String({ description: 'Optional panel description.' })),
      unit: Type.Optional(
        Type.String({ description: 'Optional Grafana field unit, for example reqps, percentunit, s.' })
      ),
      parentPath: Type.Optional(
        Type.String({ description: 'Optional target layout path from get_live_dashboard_layout. Defaults to "/".' })
      ),
      x: Type.Optional(Type.Number({ description: 'Optional grid x position, 0-23.' })),
      y: Type.Optional(Type.Number({ description: 'Optional grid y position.' })),
      width: Type.Optional(Type.Number({ description: 'Optional grid width, 1-24.' })),
      height: Type.Optional(Type.Number({ description: 'Optional grid height.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as AddLiveDashboardPanelParams;
      const payload = compactDeep({
        parentPath: args.parentPath,
        panel: {
          kind: 'Panel',
          spec: {
            title: args.title,
            description: args.description,
            data: queryGroup([
              panelQuery({
                refId: args.refId,
                datasourceType: args.datasourceType,
                datasourceName: args.datasourceName,
                queryExpression: args.queryExpression,
                querySpec: args.querySpec,
              }),
            ]),
            vizConfig: vizConfig(args.visualizationType, args.unit),
          },
        },
        layoutItem: layoutItem(args),
      });
      const result = await dashboardMutation.execute({ type: 'ADD_PANEL', payload });
      return mutationResult('ADD_PANEL', result, dashboardMutation, payload, {
        signal,
        visualVerification: true,
      });
    },
  };
}

function makeMoveOrResizeLiveDashboardPanelTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'move_or_resize_live_dashboard_panel',
    label: 'Move or resize live dashboard panel',
    description:
      'Move a panel to another layout group or resize/reposition it in the currently loaded dashboard. Attaches automatic screenshot verification when rendering is configured.',
    executionMode: 'sequential',
    parameters: Type.Object({
      elementName: Type.String({ description: 'Panel element name from list_live_dashboard_panels.' }),
      parentPath: Type.Optional(
        Type.String({ description: 'Optional destination layout path, for example "/" or "/rows/0".' })
      ),
      x: Type.Optional(Type.Number({ description: 'Optional grid x position, 0-23.' })),
      y: Type.Optional(Type.Number({ description: 'Optional grid y position.' })),
      width: Type.Optional(Type.Number({ description: 'Optional grid width, 1-24.' })),
      height: Type.Optional(Type.Number({ description: 'Optional grid height.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as MoveOrResizeLiveDashboardPanelParams;
      const item = layoutItem(args);
      if (!args.parentPath && !item) {
        throw new Error('move_or_resize_live_dashboard_panel requires parentPath, x, y, width, or height.');
      }
      const payload = compactDeep({
        element: elementReference(args.elementName),
        toParent: args.parentPath,
        layoutItem: item,
      });
      const result = await dashboardMutation.execute({ type: 'MOVE_PANEL', payload });
      return mutationResult('MOVE_PANEL', result, dashboardMutation, payload, {
        signal,
        visualVerification: true,
      });
    },
  };
}

function makeUpdateLiveDashboardSettingsTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'update_live_dashboard_settings',
    label: 'Update live dashboard settings',
    description:
      'Update title, description, tags, time settings, and display settings for the currently loaded dashboard.',
    executionMode: 'sequential',
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: 'Dashboard title.' })),
      description: Type.Optional(Type.String({ description: 'Dashboard description.' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Dashboard tags. Replaces the full tag list.' })),
      from: Type.Optional(Type.String({ description: 'Dashboard time range start, for example now-6h.' })),
      to: Type.Optional(Type.String({ description: 'Dashboard time range end, for example now.' })),
      autoRefresh: Type.Optional(
        Type.String({ description: 'Auto-refresh interval, for example 30s or empty string.' })
      ),
      timezone: Type.Optional(Type.String({ description: 'Timezone, for example browser or utc.' })),
      editable: Type.Optional(Type.Boolean({ description: 'Whether the dashboard is editable.' })),
      cursorSync: Type.Optional(
        Type.Union([Type.Literal('Off'), Type.Literal('Crosshair'), Type.Literal('Tooltip')], {
          description: 'Shared cursor behavior across panels.',
        })
      ),
      liveNow: Type.Optional(
        Type.Boolean({ description: 'Continuously redraw panels to keep live data moving left.' })
      ),
      preload: Type.Optional(Type.Boolean({ description: 'Load all panels when the dashboard loads.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as UpdateLiveDashboardSettingsParams;
      const payload = compactDeep({
        title: args.title,
        description: args.description,
        tags: args.tags,
        editable: args.editable,
        cursorSync: args.cursorSync,
        timeSettings: nonEmptyRecord(
          compactRecord({
            from: args.from,
            to: args.to,
            autoRefresh: args.autoRefresh,
            timezone: args.timezone,
          })
        ),
        liveNow: args.liveNow,
        preload: args.preload,
      });
      const result = await dashboardMutation.execute({ type: 'UPDATE_DASHBOARD_SETTINGS', payload });
      return mutationResult('UPDATE_DASHBOARD_SETTINGS', result, dashboardMutation, payload);
    },
  };
}

function makeAddLiveDashboardVariableTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'add_live_dashboard_variable',
    label: 'Add live dashboard variable',
    description:
      'Add a dashboard-level or section-scoped custom/query variable to the currently loaded dashboard. Use list_live_dashboard_variables to verify.',
    executionMode: 'sequential',
    parameters: liveDashboardVariableParameters(false),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as LiveDashboardVariableParams;
      const payload = compactDeep({
        variable: variableKind(args),
        position: args.position,
        parentPath: args.parentPath,
      });
      const result = await dashboardMutation.execute({ type: 'ADD_VARIABLE', payload });
      return mutationResult('ADD_VARIABLE', result, dashboardMutation, payload);
    },
  };
}

function makeUpdateLiveDashboardVariableTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'update_live_dashboard_variable',
    label: 'Update live dashboard variable',
    description:
      'Replace an existing custom/query variable definition on the currently loaded dashboard. Use list_live_dashboard_variables first to get the existing name and scope.',
    executionMode: 'sequential',
    parameters: liveDashboardVariableParameters(true),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as LiveDashboardVariableParams;
      const payload = compactDeep({
        name: args.name,
        variable: variableKind(args, args.newName ?? args.name),
        parentPath: args.parentPath,
      });
      const result = await dashboardMutation.execute({ type: 'UPDATE_VARIABLE', payload });
      return mutationResult('UPDATE_VARIABLE', result, dashboardMutation, payload);
    },
  };
}

function makeApplyLiveDashboardMutationTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'apply_live_dashboard_mutation',
    label: 'Apply live dashboard mutation',
    description:
      'Apply a Grafana dashboard mutation to the currently loaded dashboard scene. Use for on-the-fly dashboard edits only after listing panels/layout and after the user requested the change.',
    executionMode: 'sequential',
    parameters: Type.Object({
      type: Type.String({
        description:
          'Grafana mutation command, for example UPDATE_PANEL, ADD_PANEL, MOVE_PANEL, REMOVE_PANEL, UPDATE_DASHBOARD_SETTINGS.',
      }),
      payload: Type.Optional(
        Type.Any({
          description:
            'Command payload matching Grafana dashboard mutation API. Use get_live_dashboard_mutation_schema for examples.',
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as ApplyLiveDashboardMutationParams;
      const command = normalizeCommand(args.type);
      if (!command) {
        throw new Error('apply_live_dashboard_mutation requires a mutation command type.');
      }
      if (READ_COMMANDS.has(command)) {
        throw new Error(
          `${command} is read-only. Use list_live_dashboard_panels, get_live_dashboard_layout, or get_live_dashboard_mutation_schema instead.`
        );
      }

      const payload = args.payload ?? {};
      const result = await dashboardMutation.execute({ type: command, payload });
      return mutationResult(command, result, dashboardMutation, payload);
    },
  };
}

async function mutationResult(
  command: string,
  result: DashboardMutationResult,
  dashboardMutation: DashboardMutationAPI,
  payload: unknown,
  options: { signal?: AbortSignal; visualVerification?: boolean } = {}
) {
  const status = result.success ? 'succeeded' : 'failed';
  const summaryLines = [
    `Live dashboard mutation ${command} ${status}.`,
    result.error ? `Error: ${result.error}` : undefined,
    result.warnings?.length ? `Warnings: ${result.warnings.join('; ')}` : undefined,
    `Changes: ${result.changes.length}`,
    '',
    truncateText(JSON.stringify(result, null, 2), MAX_MUTATION_RESULT_TEXT),
  ]
    .filter(Boolean)
    .join('\n');

  const toolResult = textResult(summaryLines, {
    command,
    payload,
    success: result.success,
    error: result.error,
    changes: result.changes,
    warnings: result.warnings,
    data: result.data,
    availableCommands: safeAvailableCommands(dashboardMutation),
  });

  if (!options.visualVerification || !result.success) {
    return toolResult;
  }

  const verification = await tryRenderCurrentDashboardScreenshot(dashboardMutation, options.signal);
  if (verification.result) {
    return appendToolResultContent(toolResult, verification.result, {
      visualVerification: {
        status: 'rendered',
        details: verification.result.details,
      },
    });
  }

  return appendToolResultContent(
    toolResult,
    textResult(`Automatic screenshot verification skipped: ${verification.error}`, {
      visualVerification: { status: 'skipped', error: verification.error },
    }),
    {
      visualVerification: { status: 'skipped', error: verification.error },
    }
  );
}

function normalizeCommand(command: unknown) {
  return typeof command === 'string' && command.trim() ? command.trim().toUpperCase() : undefined;
}

function commandAvailable(availableCommands: string[], command: string) {
  return availableCommands.includes(command);
}

function safeAvailableCommands(dashboardMutation: DashboardMutationAPI) {
  try {
    return dashboardMutation.getAvailableCommands().slice().sort();
  } catch {
    return [];
  }
}

function compactRecord<T extends Record<string, unknown>>(record: T) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function nonEmptyRecord<T extends Record<string, unknown>>(record: Partial<T>) {
  return Object.keys(record).length > 0 ? record : undefined;
}

function compactDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactDeep);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compactDeep(item)])
  );
}

function elementReference(elementName: string) {
  const name = stringValue(elementName, 'elementName');
  return { kind: 'ElementReference', name };
}

function panelPatch(spec: Record<string, unknown>) {
  return compactDeep({ kind: 'Panel', spec });
}

function queryGroup(queries: unknown[]) {
  return {
    kind: 'QueryGroup',
    spec: { queries },
  };
}

async function readLivePanelQueryDefaults(
  dashboardMutation: DashboardMutationAPI,
  elementName: string,
  refId: unknown
): Promise<LiveDashboardPanelQueryDefaults | undefined> {
  if (!commandAvailable(safeAvailableCommands(dashboardMutation), 'LIST_PANELS')) {
    return undefined;
  }

  try {
    const result = await dashboardMutation.execute({
      type: 'LIST_PANELS',
      payload: { elements: [elementName] },
    });
    if (!result.success) {
      return undefined;
    }

    return selectLivePanelQueryDefaults(result.data, optionalStringValue(refId));
  } catch {
    return undefined;
  }
}

function selectLivePanelQueryDefaults(
  data: unknown,
  requestedRefId?: string
): LiveDashboardPanelQueryDefaults | undefined {
  const dataRecord = isRecord(data) ? data : undefined;
  const elements = Array.isArray(dataRecord?.elements) ? dataRecord.elements : [];
  const firstElement = elements.find(isRecord);
  if (!firstElement) {
    return undefined;
  }

  const element = isRecord(firstElement.element) ? firstElement.element : undefined;
  const spec = isRecord(element?.spec) ? element.spec : undefined;
  const dataKind = isRecord(spec?.data) ? spec.data : undefined;
  const dataSpec = isRecord(dataKind?.spec) ? dataKind.spec : undefined;
  const queries = Array.isArray(dataSpec?.queries) ? dataSpec.queries.filter(isRecord) : [];
  if (queries.length === 0) {
    return undefined;
  }

  const query = requestedRefId
    ? (queries.find((candidate) => panelQueryRefId(candidate) === requestedRefId) ?? queries[0])
    : queries[0];
  return livePanelQueryDefaults(query);
}

function livePanelQueryDefaults(query: Record<string, unknown>): LiveDashboardPanelQueryDefaults | undefined {
  const spec = isRecord(query.spec) ? query.spec : undefined;
  const dataQueryKind = isRecord(spec?.query) ? spec.query : undefined;
  const datasource = isRecord(dataQueryKind?.datasource) ? { ...dataQueryKind.datasource } : undefined;
  const defaults = compactRecord({
    refId: optionalStringValue(spec?.refId),
    hidden: typeof spec?.hidden === 'boolean' ? spec.hidden : undefined,
    group: optionalStringValue(dataQueryKind?.group),
    version: optionalStringValue(dataQueryKind?.version),
    datasource: datasource && Object.keys(datasource).length > 0 ? datasource : undefined,
  });

  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function panelQueryRefId(query: Record<string, unknown>) {
  const spec = isRecord(query.spec) ? query.spec : undefined;
  return optionalStringValue(spec?.refId);
}

function panelQuery(args: LiveDashboardPanelQueryInput, defaults?: LiveDashboardPanelQueryDefaults) {
  return compactDeep({
    kind: 'PanelQuery',
    spec: {
      refId: stringValue(args.refId, 'refId', defaults?.refId ?? 'A'),
      hidden: args.hidden ?? defaults?.hidden,
      query: dataQuery(args, defaults),
    },
  });
}

function dataQuery(args: LiveDashboardPanelQueryInput, defaults?: LiveDashboardPanelQueryDefaults) {
  const explicitDatasourceType = optionalStringValue(args.datasourceType);
  const datasourceType = explicitDatasourceType ?? defaults?.group ?? 'prometheus';
  const querySpec = isRecord(args.querySpec) ? args.querySpec : defaultPanelQuerySpec(args.queryExpression);
  return compactDeep({
    kind: 'DataQuery',
    group: datasourceType,
    version: defaults?.version,
    datasource: dataQueryDatasource(args, defaults, datasourceType, explicitDatasourceType),
    spec: querySpec,
  });
}

function dataQueryDatasource(
  args: LiveDashboardPanelQueryInput,
  defaults: LiveDashboardPanelQueryDefaults | undefined,
  datasourceType: string,
  explicitDatasourceType: string | undefined
) {
  const datasourceName = optionalStringValue(args.datasourceName);
  if (datasourceName) {
    return { name: datasourceName };
  }

  const existingDatasource = defaults?.datasource;
  if (!existingDatasource) {
    return undefined;
  }

  if (!explicitDatasourceType || datasourceType === defaults?.group) {
    return existingDatasource;
  }

  return undefined;
}

function defaultPanelQuerySpec(queryExpression: unknown) {
  const expression = stringValue(queryExpression, 'queryExpression');
  return { expr: expression };
}

function vizConfig(visualizationType: unknown, unit: unknown) {
  return compactDeep({
    kind: 'VizConfig',
    group: stringValue(visualizationType, 'visualizationType', 'timeseries'),
    spec: {
      fieldConfig: {
        defaults: unit ? { unit } : {},
        overrides: [],
      },
      options: {},
    },
  });
}

function layoutItem(
  args: Pick<AddLiveDashboardPanelParams | MoveOrResizeLiveDashboardPanelParams, 'x' | 'y' | 'width' | 'height'>
) {
  const spec = compactRecord({
    x: args.x,
    y: args.y,
    width: args.width,
    height: args.height,
  });
  if (Object.keys(spec).length === 0) {
    return undefined;
  }
  return { kind: 'GridLayoutItem', spec };
}

function liveDashboardVariableParameters(includeRename: boolean) {
  return Type.Object({
    name: Type.String({ description: 'Variable name. For updates, this is the existing variable name.' }),
    newName: Type.Optional(
      Type.String({
        description: includeRename
          ? 'Optional new variable name. Defaults to name.'
          : 'Ignored for add_live_dashboard_variable.',
      })
    ),
    variableType: Type.Optional(LIVE_VARIABLE_TYPES),
    label: Type.Optional(Type.String({ description: 'Optional display label.' })),
    description: Type.Optional(Type.String({ description: 'Optional description shown as tooltip.' })),
    query: Type.Optional(
      Type.String({
        description:
          'Custom variable comma-separated options, for example "prod,staging,dev". Used when variableType is custom.',
      })
    ),
    queryExpression: Type.Optional(
      Type.String({
        description:
          'Datasource variable query. For Prometheus, use a string such as label_values(up, job). Used when variableType is query.',
      })
    ),
    querySpec: Type.Optional(
      Type.Any({
        description: 'Advanced datasource-specific DataQuery spec object. Overrides queryExpression when set.',
      })
    ),
    datasourceType: Type.Optional(
      Type.String({ description: 'Datasource plugin type for query variables. Defaults to prometheus.' })
    ),
    datasourceName: Type.Optional(Type.String({ description: 'Optional datasource name for query variables.' })),
    options: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional custom variable values. Converted to query and option records.',
      })
    ),
    current: Type.Optional(Type.String({ description: 'Optional current selected value.' })),
    multi: Type.Optional(Type.Boolean({ description: 'Allow selecting multiple values.' })),
    includeAll: Type.Optional(Type.Boolean({ description: 'Include an All option.' })),
    allValue: Type.Optional(Type.String({ description: 'Custom value to use when All is selected.' })),
    position: Type.Optional(
      Type.Number({
        description: includeRename
          ? 'Ignored for update_live_dashboard_variable.'
          : 'Optional insert position in the variable list.',
      })
    ),
    parentPath: Type.Optional(
      Type.String({ description: 'Optional row/tab variable scope path. Defaults to dashboard scope.' })
    ),
  });
}

function variableKind(args: LiveDashboardVariableParams, fallbackName = args.name) {
  const name = stringValue(fallbackName, 'name');
  const variableType = args.variableType ?? (args.queryExpression || args.querySpec ? 'query' : 'custom');
  const common = compactRecord({
    name,
    label: args.label,
    description: args.description,
    multi: args.multi,
    includeAll: args.includeAll,
    allValue: args.allValue,
    current: args.current ? variableOption(args.current, args.current) : undefined,
  });

  if (variableType === 'query') {
    return compactDeep({
      kind: 'QueryVariable',
      spec: {
        ...common,
        query: variableDataQuery(args),
      },
    });
  }

  const values = args.options?.length ? args.options : splitCustomVariableValues(args.query);
  const query = args.query ?? values.join(',');
  if (!query.trim()) {
    throw new Error('add/update custom live dashboard variable requires query or options.');
  }

  return compactDeep({
    kind: 'CustomVariable',
    spec: {
      ...common,
      query,
      options: values.map((value) => variableOption(value, value)),
    },
  });
}

function variableDataQuery(args: LiveDashboardVariableParams) {
  const datasourceType = stringValue(args.datasourceType, 'datasourceType', 'prometheus');
  const spec = isRecord(args.querySpec)
    ? args.querySpec
    : datasourceType === 'prometheus'
      ? { __grafana_string_value: stringValue(args.queryExpression, 'queryExpression') }
      : { query: stringValue(args.queryExpression, 'queryExpression') };

  return compactDeep({
    kind: 'DataQuery',
    group: datasourceType,
    datasource: args.datasourceName ? { name: args.datasourceName } : undefined,
    spec,
  });
}

function variableOption(text: string, value: string) {
  return { text, value };
}

function splitCustomVariableValues(query: unknown) {
  return typeof query === 'string'
    ? query
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
}

async function tryRenderCurrentDashboardScreenshot(
  dashboardMutation: DashboardMutationAPI,
  signal?: AbortSignal
): Promise<{ result?: AgentToolResult<Record<string, unknown>>; error?: string }> {
  try {
    throwIfAborted(signal);
    const info = await dashboardMutation.execute({ type: 'GET_DASHBOARD_INFO', payload: {} });
    const data = isRecord(info.data) ? info.data : undefined;
    const uid = typeof data?.uid === 'string' ? data.uid.trim() : '';
    if (!info.success || !uid) {
      return { error: info.error ?? 'Current dashboard UID is not available.' };
    }

    const result = await renderDashboardScreenshot(
      {
        uid,
        width: DEFAULT_VISUAL_VERIFICATION_WIDTH,
        height: DEFAULT_VISUAL_VERIFICATION_HEIGHT,
      },
      signal
    );
    return { result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function appendToolResultContent(
  base: AgentToolResult<Record<string, unknown>>,
  extra: AgentToolResult<Record<string, unknown>>,
  details: Record<string, unknown>
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [...base.content, ...extra.content],
    details: {
      ...base.details,
      ...details,
    },
  };
}

function stringValue(value: unknown, field: string, fallback?: string) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`${field} is required.`);
}

function optionalStringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const COMMON_COMMAND_GUIDANCE = {
  workflow: [
    'Prefer typed tools for common edits: rename_live_dashboard_panel, update_live_dashboard_panel_query, add_live_dashboard_panel, move_or_resize_live_dashboard_panel, update_live_dashboard_settings, add_live_dashboard_variable, update_live_dashboard_variable.',
    'Use apply_live_dashboard_mutation only for advanced commands without a typed tool.',
    'Call list_live_dashboard_panels, get_live_dashboard_layout, get_live_dashboard_info, or list_live_dashboard_variables first when you need current names, layout paths, dashboard UID, or variables.',
    'Use element names such as panel-1 from LIST_PANELS when updating, moving, or removing panels.',
    'Apply one small mutation at a time, then verify with LIST_PANELS, GET_LAYOUT, GET_DASHBOARD_INFO, LIST_VARIABLES, or the screenshot attached by layout-affecting typed tools.',
    'Do not use live mutations unless the user requested an on-the-fly dashboard edit.',
  ],
  commonCommands: [
    'LIST_PANELS',
    'GET_LAYOUT',
    'UPDATE_PANEL',
    'ADD_PANEL',
    'MOVE_PANEL',
    'REMOVE_PANEL',
    'ADD_VARIABLE',
    'UPDATE_VARIABLE',
    'REMOVE_VARIABLE',
    'UPDATE_DASHBOARD_SETTINGS',
  ],
};

const COMMAND_GUIDANCE: Record<string, unknown> = {
  LIST_PANELS: {
    payload: { includeStatus: true, evaluateVariables: true },
    useTool: 'list_live_dashboard_panels',
  },
  GET_LAYOUT: {
    payload: {},
    useTool: 'get_live_dashboard_layout',
  },
  UPDATE_PANEL: {
    payload: {
      element: { kind: 'ElementReference', name: 'panel-1' },
      panel: {
        kind: 'Panel',
        spec: {
          title: 'New title',
          description: 'Optional description',
          vizConfig: {
            kind: 'VizConfig',
            group: 'timeseries',
            spec: {
              fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
              options: {},
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
    notes: [
      'panel.spec is partial; only provided fields are applied.',
      'vizConfig.spec.options and fieldConfig are deep-merged.',
      'data.spec.queries replaces all panel queries when provided.',
    ],
  },
  ADD_PANEL: {
    payload: {
      parentPath: '/',
      panel: {
        kind: 'Panel',
        spec: {
          title: 'HTTP 5xx rate',
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
            spec: { fieldConfig: { defaults: { unit: 'reqps' }, overrides: [] }, options: {} },
          },
        },
      },
      layoutItem: { kind: 'GridLayoutItem', spec: { x: 0, y: 8, width: 12, height: 8 } },
    },
    notes: ['Panel id is auto-assigned.', 'Use get_live_dashboard_layout to find parentPath for rows or tabs.'],
  },
  MOVE_PANEL: {
    payload: {
      element: { kind: 'ElementReference', name: 'panel-1' },
      toParent: '/',
      layoutItem: { kind: 'GridLayoutItem', spec: { x: 12, y: 8, width: 12, height: 8 } },
    },
  },
  REMOVE_PANEL: {
    payload: {
      elements: [{ kind: 'ElementReference', name: 'panel-1' }],
    },
  },
  UPDATE_DASHBOARD_SETTINGS: {
    payload: {
      title: 'New dashboard title',
      description: 'Optional dashboard description',
      tags: ['service', 'sre'],
      timeSettings: { autoRefresh: '30s', timezone: 'browser' },
    },
  },
};

function defaultCommandGuidance(command: string) {
  return {
    command,
    note: 'No compact example is bundled for this command. Call with Grafana dashboard mutation API payload shape; Grafana will validate the payload and return structured errors.',
  };
}
