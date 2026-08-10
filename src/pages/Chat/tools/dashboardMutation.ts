import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { DashboardMutationAPI, DashboardMutationResult } from '@grafana/data';
import { Type } from 'typebox';
import { renderDashboardScreenshot } from './dashboards';
import { addPromqlLabelFilter, type ExistingPromqlMatcherStrategy } from './promqlLabelFilter';
import { textResult, throwIfAborted, truncateText } from './result';

const MAX_MUTATION_RESULT_TEXT = 20000;
const MAX_MUTATION_RESULT_DATA_TEXT = 12000;
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
  'update_live_dashboard_panel_queries',
  'apply_live_dashboard_prometheus_label_filter',
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

type BatchLiveDashboardPanelQueryUpdate = {
  elementName: string;
  refId?: string;
  queryExpression: string;
};

type UpdateLiveDashboardPanelQueriesParams = {
  updates: BatchLiveDashboardPanelQueryUpdate[];
  dryRun?: boolean;
};

type ApplyLiveDashboardPrometheusLabelFilterParams = {
  variableName: string;
  variableLabel?: string;
  variableQueryExpression: string;
  matcherLabel?: string;
  matcherOperator?: '=~' | '=' | '!=' | '!~';
  current?: string;
  multi?: boolean;
  includeAll?: boolean;
  allValue?: string;
  datasourceName?: string;
  elements?: string[];
  refIds?: string[];
  existingMatcher?: ExistingPromqlMatcherStrategy;
  dryRun?: boolean;
};

type LivePanelSnapshot = {
  elementName: string;
  queries: Array<Record<string, unknown>>;
};

type PlannedPanelQueryChange = {
  refId: string;
  previousExpression: string;
  expression: string;
  selectorCount?: number;
  changedSelectorCount?: number;
};

type PlannedPanelUpdate = {
  elementName: string;
  queries: Array<Record<string, unknown>>;
  changes: PlannedPanelQueryChange[];
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
    commandAvailable(availableCommands, 'UPDATE_PANEL') && commandAvailable(availableCommands, 'LIST_PANELS')
      ? makeUpdateLiveDashboardPanelQueriesTool(dashboardMutation)
      : undefined,
    commandAvailable(availableCommands, 'UPDATE_PANEL') &&
    commandAvailable(availableCommands, 'LIST_PANELS') &&
    commandAvailable(availableCommands, 'LIST_VARIABLES') &&
    commandAvailable(availableCommands, 'ADD_VARIABLE') &&
    commandAvailable(availableCommands, 'UPDATE_VARIABLE')
      ? makeApplyLiveDashboardPrometheusLabelFilterTool(dashboardMutation)
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
      'List template variables on the currently loaded dashboard. Omit parentPath for dashboard-level variables. Section scopes require support from the current Grafana runtime.',
    parameters: Type.Object({
      parentPath: Type.Optional(
        Type.String({
          description:
            'Optional layout path for section variables, for example "/rows/0". Omit for dashboard-level variables.',
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as LiveDashboardVariableListParams;
      const payload = withSupportedVariableScope(dashboardMutation, 'LIST_VARIABLES', {}, args.parentPath);
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

function makeUpdateLiveDashboardPanelQueriesTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'update_live_dashboard_panel_queries',
    label: 'Update live dashboard panel queries',
    description:
      'Batch-update query expressions across many panels in the currently loaded dashboard. Reads panel state once, preserves datasource metadata and untouched queries, and groups updates into one Grafana command per panel. Use dryRun to preview.',
    executionMode: 'sequential',
    parameters: Type.Object({
      updates: Type.Array(
        Type.Object({
          elementName: Type.String({ description: 'Panel element name from list_live_dashboard_panels.' }),
          refId: Type.Optional(Type.String({ description: 'Query refId. Defaults to A.' })),
          queryExpression: Type.String({ description: 'Complete replacement expression for this query.' }),
        }),
        { description: 'Query updates to validate and apply together.', minItems: 1, maxItems: 100 }
      ),
      dryRun: Type.Optional(Type.Boolean({ description: 'Preview all changes without mutating the dashboard.' })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as UpdateLiveDashboardPanelQueriesParams;
      const updates = validateBatchQueryUpdates(args.updates);
      const panels = await readLivePanelSnapshots(
        dashboardMutation,
        [...new Set(updates.map((update) => update.elementName))],
        signal
      );
      const plan = planExplicitPanelQueryUpdates(panels, updates);
      return executePanelUpdatePlan(
        dashboardMutation,
        'BATCH_UPDATE_PANEL_QUERIES',
        plan,
        Boolean(args.dryRun),
        signal
      );
    },
  };
}

function makeApplyLiveDashboardPrometheusLabelFilterTool(dashboardMutation: DashboardMutationAPI): AgentTool {
  return {
    name: 'apply_live_dashboard_prometheus_label_filter',
    label: 'Apply Prometheus dashboard label filter',
    description:
      'Add or update one Prometheus query variable and inject its label matcher into every selected PromQL vector selector across the currently loaded dashboard. The operation prevalidates all queries, preserves query metadata, batches panel writes internally, and verifies the final variable and expressions. Use this for dashboard-wide variable filtering instead of editing panels one at a time.',
    executionMode: 'sequential',
    parameters: Type.Object({
      variableName: Type.String({ description: 'Dashboard query variable name, for example env.' }),
      variableLabel: Type.Optional(Type.String({ description: 'Optional display label, for example Environment.' })),
      variableQueryExpression: Type.String({
        description: 'Prometheus variable query, for example label_values(http_requests_total, env).',
      }),
      matcherLabel: Type.Optional(
        Type.String({ description: 'Prometheus label to filter. Defaults to variableName.' })
      ),
      matcherOperator: Type.Optional(
        Type.Union([Type.Literal('=~'), Type.Literal('='), Type.Literal('!='), Type.Literal('!~')], {
          description: 'PromQL matcher operator. Defaults to =~ for multi-value variables.',
        })
      ),
      current: Type.Optional(Type.String({ description: 'Initial/current variable value.' })),
      multi: Type.Optional(Type.Boolean({ description: 'Allow multiple values. Defaults to true.' })),
      includeAll: Type.Optional(Type.Boolean({ description: 'Include All. Defaults to true.' })),
      allValue: Type.Optional(Type.String({ description: 'Custom All value. Defaults to .*.' })),
      datasourceName: Type.Optional(Type.String({ description: 'Optional Prometheus datasource name.' })),
      elements: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Optional panel element names. Omit to update all panels; never pass an empty array.',
          minItems: 1,
        })
      ),
      refIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Optional query refIds to update. Omit to update all Prometheus queries; never pass an empty array.',
          minItems: 1,
        })
      ),
      existingMatcher: Type.Optional(
        Type.Union([Type.Literal('replace'), Type.Literal('keep'), Type.Literal('error')], {
          description: 'How to handle an existing matcher for the label. Defaults to replace.',
        })
      ),
      dryRun: Type.Optional(
        Type.Boolean({ description: 'Preview the variable and query changes without mutating the dashboard.' })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as ApplyLiveDashboardPrometheusLabelFilterParams;
      return applyLiveDashboardPrometheusLabelFilter(dashboardMutation, args, signal);
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
      'Add a dashboard-level custom/query variable, or a section-scoped variable when supported by the current Grafana runtime. Use list_live_dashboard_variables to verify.',
    executionMode: 'sequential',
    parameters: liveDashboardVariableParameters(false),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as LiveDashboardVariableParams;
      const payload = withSupportedVariableScope(
        dashboardMutation,
        'ADD_VARIABLE',
        compactDeep({
          variable: variableKind(args),
          position: args.position,
        }) as Record<string, unknown>,
        args.parentPath
      );
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
      'Replace an existing custom/query variable definition on the currently loaded dashboard. Section scopes require runtime support. Use list_live_dashboard_variables first to get the existing name and scope.',
    executionMode: 'sequential',
    parameters: liveDashboardVariableParameters(true),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as LiveDashboardVariableParams;
      const payload = withSupportedVariableScope(
        dashboardMutation,
        'UPDATE_VARIABLE',
        compactDeep({
          name: args.name,
          variable: variableKind(args, args.newName ?? args.name),
        }) as Record<string, unknown>,
        args.parentPath
      );
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
  const dataSummary = compactMutationResultData(command, result.data);
  const summaryText = truncateText(
    [
      `Live dashboard mutation ${command} ${status}.`,
      result.error ? `Error: ${result.error}` : undefined,
      result.warnings?.length ? `Warnings: ${result.warnings.join('; ')}` : undefined,
      `Changes: ${result.changes.length}`,
      dataSummary !== undefined ? '' : undefined,
      dataSummary !== undefined
        ? `Result:\n${truncateText(JSON.stringify(dataSummary, null, 2), MAX_MUTATION_RESULT_DATA_TEXT)}`
        : undefined,
      '',
    ]
      .filter(Boolean)
      .join('\n'),
    MAX_MUTATION_RESULT_TEXT
  );

  const toolResult = textResult(summaryText, {
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

function validateBatchQueryUpdates(updates: BatchLiveDashboardPanelQueryUpdate[]) {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('update_live_dashboard_panel_queries requires at least one update.');
  }
  if (updates.length > 100) {
    throw new Error('update_live_dashboard_panel_queries accepts at most 100 updates.');
  }

  const seen = new Set<string>();
  return updates.map((update) => {
    const elementName = stringValue(update?.elementName, 'elementName');
    const refId = stringValue(update?.refId, 'refId', 'A');
    const queryExpression = stringValue(update?.queryExpression, 'queryExpression');
    const key = `${elementName}\u0000${refId}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate batch query update for ${elementName} refId ${refId}.`);
    }
    seen.add(key);
    return { elementName, refId, queryExpression };
  });
}

async function readLivePanelSnapshots(
  dashboardMutation: DashboardMutationAPI,
  elements: string[] | undefined,
  signal?: AbortSignal
) {
  throwIfAborted(signal);
  const payload = elements?.length ? { elements } : {};
  const result = await dashboardMutation.execute({ type: 'LIST_PANELS', payload });
  if (!result.success) {
    throw new Error(`Could not read live dashboard panels: ${result.error ?? 'LIST_PANELS failed.'}`);
  }

  const data = isRecord(result.data) ? result.data : undefined;
  const entries = Array.isArray(data?.elements) ? data.elements.filter(isRecord) : [];
  return entries.map((entry, index) => livePanelSnapshot(entry, elements?.[index])).filter(isLivePanelSnapshot);
}

function livePanelSnapshot(
  entry: Record<string, unknown>,
  fallbackElementName?: string
): LivePanelSnapshot | undefined {
  const element = recordField(entry, 'element');
  const spec = recordField(element, 'spec');
  const data = recordField(spec, 'data');
  const dataSpec = recordField(data, 'spec');
  const layoutItem = recordField(entry, 'layoutItem');
  const layoutSpec = recordField(layoutItem, 'spec');
  const layoutElement = recordField(layoutSpec, 'element');
  const elementName =
    stringField(entry, 'name') ?? stringField(layoutElement, 'name') ?? optionalStringValue(fallbackElementName);
  if (!elementName) {
    return undefined;
  }

  return {
    elementName,
    queries: recordsField(dataSpec, 'queries'),
  };
}

function isLivePanelSnapshot(value: LivePanelSnapshot | undefined): value is LivePanelSnapshot {
  return Boolean(value);
}

function planExplicitPanelQueryUpdates(
  panels: LivePanelSnapshot[],
  updates: Array<Required<BatchLiveDashboardPanelQueryUpdate>>
) {
  const panelMap = new Map(panels.map((panel) => [panel.elementName, panel]));
  const updatesByPanel = new Map<string, Array<Required<BatchLiveDashboardPanelQueryUpdate>>>();
  for (const update of updates) {
    const current = updatesByPanel.get(update.elementName) ?? [];
    current.push(update);
    updatesByPanel.set(update.elementName, current);
  }

  return [...updatesByPanel].map(([elementName, panelUpdates]) => {
    const panel = panelMap.get(elementName);
    if (!panel) {
      throw new Error(`Live dashboard panel not found: ${elementName}.`);
    }

    let queries = panel.queries;
    const changes: PlannedPanelQueryChange[] = [];
    for (const update of panelUpdates) {
      const queryIndex = queries.findIndex((query) => panelQueryRefId(query) === update.refId);
      if (queryIndex < 0) {
        throw new Error(`Live dashboard panel ${elementName} has no query with refId ${update.refId}.`);
      }
      const previousExpression = panelQueryExpression(queries[queryIndex]);
      if (previousExpression === undefined) {
        throw new Error(`Live dashboard panel ${elementName} refId ${update.refId} has no expression.`);
      }
      if (previousExpression === update.queryExpression) {
        continue;
      }

      queries = queries.map((query, index) =>
        index === queryIndex ? withPanelQueryExpression(query, update.queryExpression) : query
      );
      changes.push({
        refId: update.refId,
        previousExpression,
        expression: update.queryExpression,
      });
    }

    return { elementName, queries, changes };
  });
}

function panelQueryExpression(query: Record<string, unknown>) {
  const spec = recordField(query, 'spec');
  const dataQuery = recordField(spec, 'query');
  const querySpec = recordField(dataQuery, 'spec');
  return stringField(querySpec, 'expr');
}

function panelQueryDatasourceType(query: Record<string, unknown>) {
  const spec = recordField(query, 'spec');
  const dataQuery = recordField(spec, 'query');
  return stringField(dataQuery, 'group');
}

function withPanelQueryExpression(query: Record<string, unknown>, expression: string) {
  const spec = recordField(query, 'spec');
  const dataQuery = recordField(spec, 'query');
  const querySpec = recordField(dataQuery, 'spec');
  if (!spec || !dataQuery || !querySpec) {
    throw new Error(`Query ${panelQueryRefId(query) ?? 'unknown'} does not have a mutable DataQuery spec.`);
  }

  return {
    ...query,
    spec: {
      ...spec,
      query: {
        ...dataQuery,
        spec: {
          ...querySpec,
          expr: expression,
        },
      },
    },
  };
}

async function executePanelUpdatePlan(
  dashboardMutation: DashboardMutationAPI,
  command: string,
  plan: PlannedPanelUpdate[],
  dryRun: boolean,
  signal?: AbortSignal
) {
  const applied = dryRun ? [] : await applyPanelUpdatePlan(dashboardMutation, plan, signal);
  const failures = applied.filter(({ result }) => !result.success);
  const changedPanels = plan.filter((panel) => panel.changes.length > 0);
  const success = dryRun || failures.length === 0;
  const summary = {
    dryRun,
    success,
    panelCount: plan.length,
    changedPanelCount: changedPanels.length,
    queryChangeCount: changedPanels.reduce((count, panel) => count + panel.changes.length, 0),
    appliedPanelCount: applied.filter(({ result }) => result.success).length,
    failures: failures.map(({ panel, result }) => ({ elementName: panel.elementName, error: result.error })),
    updates: changedPanels.map((panel) => ({ elementName: panel.elementName, queries: panel.changes })),
  };

  return textResult(
    truncateText(
      `${dryRun ? 'Live dashboard batch query preview' : 'Live dashboard batch query update'} ${
        success ? 'succeeded' : 'failed'
      }.\n${JSON.stringify(summary, null, 2)}`,
      MAX_MUTATION_RESULT_TEXT
    ),
    {
      command,
      ...summary,
      changes: applied.flatMap(({ result }) => result.changes),
      warnings: applied.flatMap(({ result }) => result.warnings ?? []),
      availableCommands: safeAvailableCommands(dashboardMutation),
    }
  );
}

async function applyPanelUpdatePlan(
  dashboardMutation: DashboardMutationAPI,
  plan: PlannedPanelUpdate[],
  signal?: AbortSignal
) {
  const results: Array<{ panel: PlannedPanelUpdate; result: DashboardMutationResult }> = [];
  for (const panel of plan) {
    if (panel.changes.length === 0) {
      continue;
    }
    throwIfAborted(signal);
    const payload = {
      element: elementReference(panel.elementName),
      panel: panelPatch({ data: queryGroup(panel.queries) }),
    };
    const result = await dashboardMutation.execute({ type: 'UPDATE_PANEL', payload });
    results.push({ panel, result });
  }
  return results;
}

async function applyLiveDashboardPrometheusLabelFilter(
  dashboardMutation: DashboardMutationAPI,
  args: ApplyLiveDashboardPrometheusLabelFilterParams,
  signal?: AbortSignal
) {
  const variableName = stringValue(args.variableName, 'variableName');
  const matcherLabel = stringValue(args.matcherLabel, 'matcherLabel', variableName);
  const matcherOperator = args.matcherOperator ?? '=~';
  const existingMatcher = args.existingMatcher ?? 'replace';
  const variableQueryExpression = stringValue(args.variableQueryExpression, 'variableQueryExpression');
  const requestedElements = normalizeOptionalStringList(args.elements, 'elements');
  const requestedRefIds = normalizeOptionalStringList(args.refIds, 'refIds');
  const refIdSet = requestedRefIds ? new Set(requestedRefIds) : undefined;

  const [panels, variables] = await Promise.all([
    readLivePanelSnapshots(dashboardMutation, requestedElements, signal),
    readLiveDashboardVariables(dashboardMutation, signal),
  ]);
  if (requestedElements?.length && panels.length !== requestedElements.length) {
    const found = new Set(panels.map((panel) => panel.elementName));
    const missing = requestedElements.filter((element) => !found.has(element));
    throw new Error(`Live dashboard panels not found: ${missing.join(', ')}.`);
  }

  const plan: PlannedPanelUpdate[] = [];
  const expectedQueries: Array<{ elementName: string; refId: string; expression: string }> = [];
  for (const panel of panels) {
    let queries = panel.queries;
    const changes: PlannedPanelQueryChange[] = [];
    for (let queryIndex = 0; queryIndex < panel.queries.length; queryIndex += 1) {
      const query = panel.queries[queryIndex];
      const refId = panelQueryRefId(query) ?? 'A';
      if (panelQueryDatasourceType(query) !== 'prometheus' || (refIdSet && !refIdSet.has(refId))) {
        continue;
      }
      const previousExpression = panelQueryExpression(query);
      if (!previousExpression) {
        throw new Error(`Live dashboard panel ${panel.elementName} refId ${refId} has no PromQL expression.`);
      }

      let filtered;
      try {
        filtered = addPromqlLabelFilter(
          previousExpression,
          matcherLabel,
          matcherOperator,
          `$${variableName}`,
          existingMatcher
        );
      } catch (error) {
        throw new Error(
          `Could not plan ${panel.elementName} refId ${refId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (filtered.selectorCount === 0) {
        throw new Error(`Could not plan ${panel.elementName} refId ${refId}: expression has no vector selectors.`);
      }

      expectedQueries.push({ elementName: panel.elementName, refId, expression: filtered.expression });
      if (!filtered.changed) {
        continue;
      }
      queries = queries.map((candidate, index) =>
        index === queryIndex ? withPanelQueryExpression(candidate, filtered.expression) : candidate
      );
      changes.push({
        refId,
        previousExpression,
        expression: filtered.expression,
        selectorCount: filtered.selectorCount,
        changedSelectorCount: filtered.changedSelectorCount,
      });
    }
    plan.push({ elementName: panel.elementName, queries, changes });
  }
  if (expectedQueries.length === 0) {
    throw new Error('No Prometheus panel queries matched the requested dashboard filter scope.');
  }

  const variableExists = variables.some((variable) => liveVariableName(variable) === variableName);
  const variableArgs: LiveDashboardVariableParams = {
    name: variableName,
    variableType: 'query',
    label: args.variableLabel,
    queryExpression: variableQueryExpression,
    datasourceType: 'prometheus',
    datasourceName: args.datasourceName,
    current: args.current,
    multi: args.multi ?? true,
    includeAll: args.includeAll ?? true,
    allValue: args.allValue ?? '.*',
  };
  const variableCommand = variableExists ? 'UPDATE_VARIABLE' : 'ADD_VARIABLE';
  const variablePayload = variableExists
    ? compactDeep({ name: variableName, variable: variableKind(variableArgs, variableName) })
    : compactDeep({ variable: variableKind(variableArgs) });

  if (args.dryRun) {
    return prometheusLabelFilterResult(dashboardMutation, {
      dryRun: true,
      success: true,
      variableName,
      matcherLabel,
      matcherOperator,
      variableAction: variableExists ? 'update' : 'add',
      expectedQueries,
      plan,
      mutationResults: [],
      verification: { variablePresent: variableExists, matchingQueryCount: expectedQueries.length, mismatches: [] },
    });
  }

  throwIfAborted(signal);
  const variableResult = await dashboardMutation.execute({ type: variableCommand, payload: variablePayload });
  if (!variableResult.success) {
    return prometheusLabelFilterResult(dashboardMutation, {
      dryRun: false,
      success: false,
      error: variableResult.error ?? `${variableCommand} failed.`,
      variableName,
      matcherLabel,
      matcherOperator,
      variableAction: variableExists ? 'update' : 'add',
      expectedQueries,
      plan,
      mutationResults: [variableResult],
    });
  }

  const panelResults = await applyPanelUpdatePlan(dashboardMutation, plan, signal);
  const mutationResults = [variableResult, ...panelResults.map(({ result }) => result)];
  const mutationFailure = panelResults.find(({ result }) => !result.success);
  let verification:
    | {
        variablePresent: boolean;
        matchingQueryCount: number;
        mismatches: Array<{ elementName: string; refId: string }>;
      }
    | undefined;
  let verificationError: string | undefined;
  if (!mutationFailure) {
    try {
      verification = await verifyPrometheusLabelFilter(
        dashboardMutation,
        variableName,
        expectedQueries,
        requestedElements,
        signal
      );
    } catch (error) {
      verificationError = error instanceof Error ? error.message : String(error);
    }
  }

  const success =
    !mutationFailure &&
    !verificationError &&
    Boolean(verification?.variablePresent) &&
    verification?.mismatches.length === 0;
  return prometheusLabelFilterResult(dashboardMutation, {
    dryRun: false,
    success,
    error:
      mutationFailure?.result.error ??
      verificationError ??
      (verification && !verification.variablePresent
        ? `Variable ${variableName} was not present after mutation.`
        : undefined) ??
      (verification?.mismatches.length ? `${verification.mismatches.length} queries failed verification.` : undefined),
    variableName,
    matcherLabel,
    matcherOperator,
    variableAction: variableExists ? 'update' : 'add',
    expectedQueries,
    plan,
    mutationResults,
    verification,
  });
}

async function readLiveDashboardVariables(dashboardMutation: DashboardMutationAPI, signal?: AbortSignal) {
  throwIfAborted(signal);
  const result = await dashboardMutation.execute({ type: 'LIST_VARIABLES', payload: {} });
  if (!result.success) {
    throw new Error(`Could not read live dashboard variables: ${result.error ?? 'LIST_VARIABLES failed.'}`);
  }
  const data = isRecord(result.data) ? result.data : undefined;
  return Array.isArray(data?.variables) ? data.variables.filter(isRecord) : [];
}

function liveVariableName(variable: Record<string, unknown>) {
  return stringField(recordField(variable, 'spec') ?? variable, 'name');
}

async function verifyPrometheusLabelFilter(
  dashboardMutation: DashboardMutationAPI,
  variableName: string,
  expectedQueries: Array<{ elementName: string; refId: string; expression: string }>,
  requestedElements: string[] | undefined,
  signal?: AbortSignal
) {
  const [panels, variables] = await Promise.all([
    readLivePanelSnapshots(dashboardMutation, requestedElements, signal),
    readLiveDashboardVariables(dashboardMutation, signal),
  ]);
  const panelMap = new Map(panels.map((panel) => [panel.elementName, panel]));
  const mismatches = expectedQueries
    .filter((expected) => {
      const query = panelMap
        .get(expected.elementName)
        ?.queries.find((candidate) => panelQueryRefId(candidate) === expected.refId);
      return !query || panelQueryExpression(query) !== expected.expression;
    })
    .map(({ elementName, refId }) => ({ elementName, refId }));

  return {
    variablePresent: variables.some((variable) => liveVariableName(variable) === variableName),
    matchingQueryCount: expectedQueries.length - mismatches.length,
    mismatches,
  };
}

function prometheusLabelFilterResult(
  dashboardMutation: DashboardMutationAPI,
  result: {
    dryRun: boolean;
    success: boolean;
    error?: string;
    variableName: string;
    matcherLabel: string;
    matcherOperator: string;
    variableAction: 'add' | 'update';
    expectedQueries: Array<{ elementName: string; refId: string; expression: string }>;
    plan: PlannedPanelUpdate[];
    mutationResults: DashboardMutationResult[];
    verification?: { variablePresent: boolean; matchingQueryCount: number; mismatches: unknown[] };
  }
) {
  const changedPanels = result.plan.filter((panel) => panel.changes.length > 0);
  const summary = {
    dryRun: result.dryRun,
    success: result.success,
    error: result.error,
    variable: {
      name: result.variableName,
      action: result.variableAction,
    },
    filter: {
      label: result.matcherLabel,
      operator: result.matcherOperator,
      value: `$${result.variableName}`,
    },
    matchedPanelCount: result.plan.length,
    changedPanelCount: changedPanels.length,
    matchedQueryCount: result.expectedQueries.length,
    changedQueryCount: changedPanels.reduce((count, panel) => count + panel.changes.length, 0),
    verification: result.verification,
    updates: changedPanels.map((panel) => ({ elementName: panel.elementName, queries: panel.changes })),
  };
  return textResult(
    truncateText(
      `${result.dryRun ? 'Prometheus dashboard label filter preview' : 'Prometheus dashboard label filter'} ${
        result.success ? 'succeeded' : 'failed'
      }.\n${JSON.stringify(summary, null, 2)}`,
      MAX_MUTATION_RESULT_TEXT
    ),
    {
      command: 'APPLY_PROMETHEUS_LABEL_FILTER',
      ...summary,
      expectedQueries: result.expectedQueries,
      changes: result.mutationResults.flatMap((mutation) => mutation.changes),
      warnings: result.mutationResults.flatMap((mutation) => mutation.warnings ?? []),
      availableCommands: safeAvailableCommands(dashboardMutation),
    }
  );
}

function normalizeOptionalStringList(values: string[] | undefined, field: string) {
  if (values === undefined) {
    return undefined;
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${field} must contain at least one value when provided.`);
  }
  return [...new Set(values.map((value) => stringValue(value, field)))];
}

function withSupportedVariableScope(
  dashboardMutation: DashboardMutationAPI,
  command: 'LIST_VARIABLES' | 'ADD_VARIABLE' | 'UPDATE_VARIABLE',
  payload: Record<string, unknown>,
  parentPath: string | undefined
) {
  const normalizedParentPath = parentPath?.trim();
  if (!normalizedParentPath || normalizedParentPath === '/') {
    return payload;
  }

  const scopedPayload = { ...payload, parentPath: normalizedParentPath };
  const schema = safeMutationPayloadSchema(dashboardMutation, command);
  if (schema && schema.safeParse(payload).success && !schema.safeParse(scopedPayload).success) {
    throw new Error(
      `The current Grafana runtime does not support section-scoped variables for ${command}. Omit parentPath to use dashboard scope.`
    );
  }
  return scopedPayload;
}

function safeMutationPayloadSchema(dashboardMutation: DashboardMutationAPI, command: string) {
  try {
    return dashboardMutation.getPayloadSchema(command);
  } catch {
    return null;
  }
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

function compactMutationResultData(command: string, data: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }

  switch (command) {
    case 'LIST_PANELS':
      return compactLiveDashboardPanels(data);
    case 'GET_LAYOUT':
      return compactLiveDashboardLayout(data);
    case 'GET_DASHBOARD_INFO':
      return compactLiveDashboardInfo(data);
    case 'LIST_VARIABLES':
      return compactLiveDashboardVariables(data);
    default:
      return undefined;
  }
}

function compactLiveDashboardPanels(data: Record<string, unknown>) {
  const panels = recordsField(data, 'elements').map(compactLiveDashboardPanel).filter(isRecord);
  return { panelCount: panels.length, panels };
}

function compactLiveDashboardPanel(panel: Record<string, unknown>) {
  const element = recordField(panel, 'element');
  const spec = recordField(element, 'spec');
  const layoutItem = recordField(panel, 'layoutItem');
  const layoutSpec = recordField(layoutItem, 'spec');
  const grid = compactGrid(layoutSpec);
  const layoutElement = recordField(layoutSpec, 'element');
  const vizConfig = recordField(spec, 'vizConfig');

  return compactDeep({
    elementName: stringField(panel, 'name') ?? stringField(layoutElement, 'name'),
    id: numberField(spec, 'id'),
    title: stringField(spec, 'title'),
    description: stringField(spec, 'description'),
    visualizationType: stringField(vizConfig, 'group'),
    grid,
    queries: compactLiveDashboardPanelQueries(spec),
  });
}

function compactLiveDashboardPanelQueries(spec: Record<string, unknown> | undefined) {
  const data = recordField(spec, 'data');
  const dataSpec = recordField(data, 'spec');
  const queries = recordsField(dataSpec, 'queries').map((query) => {
    const querySpec = recordField(query, 'spec');
    const dataQuery = recordField(querySpec, 'query');
    const datasource = recordField(dataQuery, 'datasource');
    const datasourceSpec = recordField(dataQuery, 'spec');

    return compactDeep({
      refId: stringField(querySpec, 'refId'),
      hidden: booleanField(querySpec, 'hidden'),
      datasourceType: stringField(dataQuery, 'group'),
      datasourceName: stringField(datasource, 'name'),
      expr:
        stringField(datasourceSpec, 'expr') ??
        stringField(datasourceSpec, 'query') ??
        stringField(datasourceSpec, '__grafana_string_value'),
    });
  });

  return queries.length > 0 ? queries : undefined;
}

function compactLiveDashboardLayout(data: Record<string, unknown>) {
  return compactDeep({
    layout: compactLayoutNode(recordField(data, 'layout')),
    elements: compactLiveDashboardElements(recordField(data, 'elements')),
  });
}

function compactLayoutNode(node: Record<string, unknown> | undefined): unknown {
  if (!node) {
    return undefined;
  }

  const spec = recordField(node, 'spec');
  const element = recordField(spec, 'element');
  const items = recordsField(spec, 'items').map(compactLayoutNode).filter(Boolean);

  return compactDeep({
    kind: stringField(node, 'kind'),
    elementName: stringField(element, 'name'),
    grid: compactGrid(spec),
    items: items.length > 0 ? items : undefined,
  });
}

function compactLiveDashboardElements(elements: Record<string, unknown> | undefined) {
  if (!elements) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(elements).map(([name, element]) => {
      const elementRecord = isRecord(element) ? element : undefined;
      const spec = recordField(elementRecord, 'spec');
      const vizConfig = recordField(spec, 'vizConfig');
      return [
        name,
        compactDeep({
          kind: stringField(elementRecord, 'kind'),
          title: stringField(spec, 'title'),
          visualizationType: stringField(vizConfig, 'group'),
        }),
      ];
    })
  );
}

function compactLiveDashboardInfo(data: Record<string, unknown>) {
  const timeSettings = recordField(data, 'timeSettings') ?? recordField(data, 'time');
  return compactDeep({
    uid: stringField(data, 'uid'),
    title: stringField(data, 'title'),
    description: stringField(data, 'description'),
    folderUid: stringField(data, 'folderUid'),
    folderTitle: stringField(data, 'folderTitle'),
    tags: arrayField(data, 'tags'),
    timeSettings,
    editable: booleanField(data, 'editable'),
  });
}

function compactLiveDashboardVariables(data: Record<string, unknown>) {
  const variables = recordsField(data, 'variables').map((variable) => {
    const spec = recordField(variable, 'spec') ?? variable;
    const query = recordField(spec, 'query');
    return compactDeep({
      kind: stringField(variable, 'kind'),
      name: stringField(spec, 'name'),
      label: stringField(spec, 'label'),
      query: stringField(spec, 'query') ?? stringField(query, 'query') ?? stringField(query, '__grafana_string_value'),
      current: recordField(spec, 'current'),
      multi: booleanField(spec, 'multi'),
      includeAll: booleanField(spec, 'includeAll'),
    });
  });
  return { variableCount: variables.length, variables };
}

function compactGrid(spec: Record<string, unknown> | undefined) {
  const grid = compactRecord({
    x: numberField(spec, 'x'),
    y: numberField(spec, 'y'),
    width: numberField(spec, 'width') ?? numberField(spec, 'w'),
    height: numberField(spec, 'height') ?? numberField(spec, 'h'),
  });
  return Object.keys(grid).length > 0 ? grid : undefined;
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
      Type.String({
        description:
          'Optional row/tab variable scope path when supported by the current Grafana runtime. Omit for dashboard scope.',
      })
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

function recordField(record: Record<string, unknown> | undefined, field: string): Record<string, unknown> | undefined {
  const value = record?.[field];
  return isRecord(value) ? value : undefined;
}

function recordsField(record: Record<string, unknown> | undefined, field: string): Array<Record<string, unknown>> {
  const value = record?.[field];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, field: string): boolean | undefined {
  const value = record?.[field];
  return typeof value === 'boolean' ? value : undefined;
}

function arrayField(record: Record<string, unknown> | undefined, field: string): unknown[] | undefined {
  const value = record?.[field];
  return Array.isArray(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const COMMON_COMMAND_GUIDANCE = {
  workflow: [
    'Prefer typed tools for common edits: rename_live_dashboard_panel, update_live_dashboard_panel_query, update_live_dashboard_panel_queries, apply_live_dashboard_prometheus_label_filter, add_live_dashboard_panel, move_or_resize_live_dashboard_panel, update_live_dashboard_settings, add_live_dashboard_variable, update_live_dashboard_variable.',
    'Use apply_live_dashboard_prometheus_label_filter for dashboard-wide Prometheus variable filters and update_live_dashboard_panel_queries for known expression replacements.',
    'Use apply_live_dashboard_mutation only for advanced commands without a typed tool.',
    'Call list_live_dashboard_panels, get_live_dashboard_layout, get_live_dashboard_info, or list_live_dashboard_variables first when you need current names, layout paths, dashboard UID, or variables.',
    'Use element names such as panel-1 from LIST_PANELS when updating, moving, or removing panels.',
    'Batch homogeneous query changes with typed batch tools; otherwise apply focused mutations and verify with LIST_PANELS, GET_LAYOUT, GET_DASHBOARD_INFO, LIST_VARIABLES, or the screenshot attached by layout-affecting typed tools.',
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
