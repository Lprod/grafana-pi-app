export type SkillToolGroup =
  | 'metrics'
  | 'dashboardRead'
  | 'jsonnetFiles'
  | 'managedDashboards'
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

export type GrafanaSkill = BundledGrafanaSkill & {
  toolGroups: readonly SkillToolGroup[];
};

export type GrafanaSkillSelection = {
  activeSkills: GrafanaSkill[];
  activeSkillNames: string[];
  toolGroups: SkillToolGroup[];
  explicitSkillNames: string[];
};
