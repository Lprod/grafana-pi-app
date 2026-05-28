import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createDashboardTools } from './dashboards';
import { createJsonnetFileTools } from './jsonnetFiles';
import { createJsonnetLibTools } from './jsonnetLibs';
import { createManagedDashboardTools } from './managedDashboards';
import { createMetricTools, filterAllowedPrometheusDatasourceSettings } from './metrics';
import { createSubagentTools } from './subagents';
import type { CreateGrafanaToolsOptions, GrafanaToolRegistry, SkillToolGroup } from './types';

export { getDisallowedDashboardDatasourceUids } from './dashboardPolicy';
export { DEFAULT_JSONNET_FILE_PATH, normalizeJsonnetPath } from './jsonnetFiles';
export { filterAllowedPrometheusDatasourceSettings };
export { createSkillTools } from './skills';
export type {
  CreateGrafanaToolsOptions,
  GrafanaToolConfig,
  GrafanaToolRegistry,
  GrafanaToolRuntime,
  SkillToolGroup,
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
  const skills = options.skillTools ?? [];
  const subagents = options.runtime
    ? createSubagentTools({
        runtime: options.runtime,
        metricsTools: metrics,
        includeMetrics: options.includeMetricsSubagentTool !== false,
      })
    : [];

  return {
    metrics,
    dashboards,
    jsonnetFiles,
    managedDashboards,
    jsonnet,
    subagents,
    skills,
    all: [
      ...metrics,
      ...jsonnetFiles.all,
      ...parentManagedDashboardTools,
      ...subagents,
      ...skills,
      ...(options.includeJsonnetLibraryTools ? jsonnet.all : []),
      ...dashboards,
    ],
  };
}

export function createGrafanaTools(options: CreateGrafanaToolsOptions = {}): AgentTool[] {
  return createGrafanaToolRegistry(options).all;
}

export function createGrafanaToolsForSkillGroups(
  options: CreateGrafanaToolsOptions = {},
  groups: Iterable<SkillToolGroup>
): AgentTool[] {
  const groupSet = new Set(groups);
  const registry = createGrafanaToolRegistry({
    ...options,
    includeAdHocDashboardTools: groupSet.has('adHocDashboards'),
    includeJsonnetLibraryTools: groupSet.has('jsonnetLibraries'),
  });
  const selected: AgentTool[] = [];

  if (groupSet.has('metrics')) {
    selected.push(...registry.metrics);
  }

  if (groupSet.has('jsonnetFiles')) {
    selected.push(...registry.jsonnetFiles.all);
  }

  if (groupSet.has('managedDashboards')) {
    selected.push(...registry.managedDashboards.all);
  }

  if (groupSet.has('subagents')) {
    selected.push(...registry.subagents);
  }

  if (groupSet.has('skillResources')) {
    selected.push(...registry.skills);
  }

  if (groupSet.has('jsonnetLibraries')) {
    selected.push(...registry.jsonnet.all);
  }

  if (groupSet.has('dashboardRead') || groupSet.has('adHocDashboards')) {
    selected.push(...registry.dashboards);
  }

  return dedupeTools(selected);
}

function dedupeTools(tools: readonly AgentTool[]) {
  const seen = new Set<string>();
  const deduped: AgentTool[] = [];

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      continue;
    }

    seen.add(tool.name);
    deduped.push(tool);
  }

  return deduped;
}
