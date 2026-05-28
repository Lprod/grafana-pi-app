import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createDashboardTools } from './dashboards';
import { createJsonnetLibTools } from './jsonnetLibs';
import { createManagedDashboardTools } from './managedDashboards';
import { createMetricTools, filterAllowedPrometheusDatasourceSettings } from './metrics';
import { createSubagentTools } from './subagents';
import type { CreateGrafanaToolsOptions, GrafanaToolRegistry } from './types';

export { getDisallowedDashboardDatasourceUids } from './dashboardPolicy';
export { filterAllowedPrometheusDatasourceSettings };
export type { CreateGrafanaToolsOptions, GrafanaToolConfig, GrafanaToolRegistry, GrafanaToolRuntime } from './types';
export type { SubagentRunDetails, SubagentToolCall, SubagentUsage } from './subagentRunner';

export function createGrafanaToolRegistry(options: CreateGrafanaToolsOptions = {}): GrafanaToolRegistry {
  const metrics = createMetricTools(options);
  const dashboards = createDashboardTools(options, options.includeAdHocDashboardTools);
  const managedDashboards = createManagedDashboardTools(options);
  const jsonnet = createJsonnetLibTools();
  const parentManagedDashboardTools = options.includeJsonnetLibraryTools
    ? managedDashboards.all
    : [managedDashboards.listTemplates, managedDashboards.listManaged, managedDashboards.render, managedDashboards.sync];
  const subagents = options.runtime
    ? createSubagentTools({
        runtime: options.runtime,
        metricsTools: metrics,
        jsonnetTools: [managedDashboards.listTemplates, managedDashboards.listManaged, managedDashboards.readTemplate, managedDashboards.render, ...jsonnet.all],
      })
    : [];

  return {
    metrics,
    dashboards,
    managedDashboards,
    jsonnet,
    subagents,
    all: [...subagents, ...metrics, ...parentManagedDashboardTools, ...(options.includeJsonnetLibraryTools ? jsonnet.all : []), ...dashboards],
  };
}

export function createGrafanaTools(options: CreateGrafanaToolsOptions = {}): AgentTool[] {
  return createGrafanaToolRegistry(options).all;
}
