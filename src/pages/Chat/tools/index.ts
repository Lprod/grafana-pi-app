import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createDashboardTools } from './dashboards';
import { createJsonnetFileTools } from './jsonnetFiles';
import { createJsonnetLibTools } from './jsonnetLibs';
import { createManagedDashboardTools } from './managedDashboards';
import { createMetricTools, filterAllowedPrometheusDatasourceSettings } from './metrics';
import { createSubagentTools } from './subagents';
import type { CreateGrafanaToolsOptions, GrafanaToolRegistry } from './types';

export { getDisallowedDashboardDatasourceUids } from './dashboardPolicy';
export { DEFAULT_JSONNET_FILE_PATH, normalizeJsonnetPath } from './jsonnetFiles';
export { filterAllowedPrometheusDatasourceSettings };
export type {
  CreateGrafanaToolsOptions,
  GrafanaToolConfig,
  GrafanaToolRegistry,
  GrafanaToolRuntime,
  VirtualJsonnetFileRuntime,
  VirtualJsonnetFileSnapshot,
} from './types';
export type { SubagentRunDetails, SubagentToolCall, SubagentUsage } from './subagentRunner';

export function createGrafanaToolRegistry(options: CreateGrafanaToolsOptions = {}): GrafanaToolRegistry {
  const metrics = createMetricTools(options);
  const dashboards = createDashboardTools(options, options.includeAdHocDashboardTools);
  const jsonnetFiles = createJsonnetFileTools(options);
  const managedDashboards = createManagedDashboardTools(options);
  const jsonnet = createJsonnetLibTools();
  const parentManagedDashboardTools = managedDashboards.all;
  const subagents = options.runtime
    ? createSubagentTools({
        runtime: options.runtime,
        metricsTools: metrics,
        jsonnetTools: [
          managedDashboards.listManaged,
          managedDashboards.getSource,
          managedDashboards.render,
          ...jsonnet.all,
        ],
      })
    : [];

  return {
    metrics,
    dashboards,
    jsonnetFiles,
    managedDashboards,
    jsonnet,
    subagents,
    all: [
      ...metrics,
      ...jsonnetFiles.all,
      ...parentManagedDashboardTools,
      ...subagents,
      ...(options.includeJsonnetLibraryTools ? jsonnet.all : []),
      ...dashboards,
    ],
  };
}

export function createGrafanaTools(options: CreateGrafanaToolsOptions = {}): AgentTool[] {
  return createGrafanaToolRegistry(options).all;
}
