import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createAlertTools } from './alerts';
import { createArtifactTools } from './artifacts';
import { createDashboardTools } from './dashboards';
import { createDashboardMetricContextTools } from './dashboardMetricContext';
import { createLiveDashboardMutationTools } from './dashboardMutation';
import { createJsonnetDashboardTools } from './jsonnetDashboards';
import { createJsonnetFileTools } from './jsonnetFiles';
import { createJsonnetLibTools } from './jsonnetLibs';
import { createInvestigationTools } from './investigation';
import { createMetricTools, filterAllowedPrometheusDatasourceSettings } from './metrics';
import { createNavigationTools } from './navigation';
import { createSubagentTools } from './subagents';
import type { CreateGrafanaToolsOptions, GrafanaToolRegistry, SkillToolGroup } from './types';

export { artifactByteSize, artifactizeToolResult, createArtifactTools, readArtifact } from './artifacts';
export type { Artifact, ArtifactPreview, ArtifactRef, ArtifactRuntime } from './artifacts';
export { createAlertTools } from './alerts';
export { createDashboardMetricContextTools, extractDashboardMetricUsage } from './dashboardMetricContext';
export { getUnavailableDashboardDatasourceUids } from './dashboardPolicy';
export { createLiveDashboardMutationTools, LIVE_DASHBOARD_WRITE_TOOLS } from './dashboardMutation';
export { DEFAULT_JSONNET_FILE_PATH, normalizeJsonnetPath } from './jsonnetFiles';
export { filterAllowedPrometheusDatasourceSettings };
export { createSkillTools } from './skills';
export { buildNavigationPath } from './navigation';
export type {
  CreateGrafanaToolsOptions,
  DashboardSaveFolderRuntime,
  DashboardSaveFolderSelection,
  GrafanaToolConfig,
  GrafanaToolRegistry,
  GrafanaToolRuntime,
  InvestigationReport,
  InvestigationReportRuntime,
  SkillToolGroup,
  VirtualJsonnetFileRuntime,
  VirtualJsonnetFileSnapshot,
} from './types';
export type { SubagentRunDetails, SubagentToolCall, SubagentUsage } from './subagentRunner';

export function createGrafanaToolRegistry(options: CreateGrafanaToolsOptions = {}): GrafanaToolRegistry {
  const metrics = createMetricTools(options);
  const alerts = createAlertTools(options);
  const dashboardMetricContext = createDashboardMetricContextTools(options);
  const dashboards = createDashboardTools(options, options.includeAdHocDashboardTools);
  const dashboardReadTools = createDashboardTools(options, false);
  const liveDashboardEditing = createLiveDashboardMutationTools(options.dashboardMutation);
  const jsonnetFiles = createJsonnetFileTools(options);
  const jsonnetDashboards = createJsonnetDashboardTools(options);
  const investigation = createInvestigationTools(options.investigationReport);
  const jsonnet = createJsonnetLibTools();
  const navigation = createNavigationTools();
  const artifacts = createArtifactTools(options.artifacts);
  const parentJsonnetDashboardTools = jsonnetDashboards.all;
  const skills = options.skillTools ?? [];
  const subagents = options.runtime
    ? createSubagentTools({
        runtime: options.runtime,
        metricsTools: metrics,
        alertTools: alerts,
        dashboardMetricContextTools: dashboardMetricContext,
        dashboardReadTools,
        liveDashboardTools: liveDashboardEditing,
        jsonnetFileTools: jsonnetFiles.all,
        jsonnetDashboardTools: jsonnetDashboards.all,
        investigationTools: investigation,
        navigationTools: navigation,
        artifactTools: artifacts,
        skillTools: skills,
      })
    : [];

  return {
    metrics,
    alerts,
    dashboardMetricContext,
    dashboards,
    liveDashboardEditing,
    jsonnetFiles,
    jsonnetDashboards,
    investigation,
    jsonnet,
    artifacts,
    subagents,
    skills,
    all: [
      ...metrics,
      ...alerts,
      ...dashboardMetricContext,
      ...liveDashboardEditing,
      ...jsonnetFiles.all,
      ...parentJsonnetDashboardTools,
      ...investigation,
      ...artifacts,
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

export function createGrafanaSupervisorTools(options: CreateGrafanaToolsOptions = {}): AgentTool[] {
  const registry = createGrafanaToolRegistry(options);
  return dedupeTools([...registry.subagents, ...registry.artifacts]);
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

  if (groupSet.has('alerts')) {
    selected.push(...registry.alerts);
  }

  if (groupSet.has('dashboardMetricContext')) {
    selected.push(...registry.dashboardMetricContext);
  }

  if (groupSet.has('jsonnetFiles')) {
    selected.push(...registry.jsonnetFiles.all);
  }

  if (groupSet.has('liveDashboardEditing')) {
    selected.push(...registry.liveDashboardEditing);
  }

  if (groupSet.has('jsonnetDashboards')) {
    selected.push(...registry.jsonnetDashboards.all);
  }

  if (groupSet.has('investigation')) {
    selected.push(...registry.investigation);
  }

  if (groupSet.has('subagents')) {
    selected.push(...registry.subagents);
  }

  if (groupSet.has('skillResources')) {
    selected.push(...registry.skills);
  }

  selected.push(...registry.artifacts);

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
