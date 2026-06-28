export type SkillToolGroup =
  | 'metrics'
  | 'dashboardMetricContext'
  | 'dashboardRead'
  | 'liveDashboardEditing'
  | 'jsonnetFiles'
  | 'managedDashboards'
  | 'investigation'
  | 'subagents'
  | 'skillResources'
  | 'jsonnetLibraries'
  | 'adHocDashboards';

export type BundledSkillResource = {
  path: string;
  content: string;
  bytes: number;
};

export type BundledGrafanaSkill = {
  name: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
  resources: Record<string, BundledSkillResource>;
};

export type GrafanaSkillActivation = {
  keywords?: readonly string[];
  regex?: string;
  explicitOnly?: boolean;
};

export type GrafanaSkill = BundledGrafanaSkill & {
  toolGroups: readonly SkillToolGroup[];
  activation?: GrafanaSkillActivation;
};

export type GrafanaSkillSelection = {
  activeSkills: GrafanaSkill[];
  activeSkillNames: string[];
  toolGroups: SkillToolGroup[];
  explicitSkillNames: string[];
};
