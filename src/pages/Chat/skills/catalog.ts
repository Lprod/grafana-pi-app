import { BUNDLED_GRAFANA_SKILLS } from './bundledSkills.generated';
import type { GrafanaSkill, SkillToolGroup } from './types';

const TOOL_GROUPS_BY_SKILL: Record<string, readonly SkillToolGroup[]> = {
  'grafana-dashboard': ['dashboardRead', 'jsonnetFiles', 'managedDashboards', 'skillResources'],
};

export const GRAFANA_SKILLS: readonly GrafanaSkill[] = BUNDLED_GRAFANA_SKILLS.map((skill) => ({
  ...skill,
  toolGroups: TOOL_GROUPS_BY_SKILL[skill.name] ?? ['skillResources'],
}));

export function getGrafanaSkill(name: string, skills: readonly GrafanaSkill[] = GRAFANA_SKILLS) {
  return skills.find((skill) => skill.name === name);
}
