import { GRAFANA_SKILLS } from './catalog';
import type { GrafanaSkill, GrafanaSkillSelection, SkillToolGroup } from './types';

const BASE_TOOL_GROUPS: readonly SkillToolGroup[] = ['metrics', 'subagents'];
const DASHBOARD_INTENT =
  /\b(dashboard|dashboards|panel|panels|row|rows|variable|variables|jsonnet|render|sync|managed dashboard|grafana view)\b/i;
const DASHBOARD_WRITE_INTENT =
  /\b(create|build|generate|make|add|update|edit|modify|change|sync|apply|render|write)\b[\s\S]{0,80}\b(dashboard|panel|jsonnet)\b/i;
const RQLITE_INTENT = /\b(rqlite|sqlite|sql|pragma|database tables?|select\s+[\s\S]{1,120}\s+from)\b/i;
const INVESTIGATION_INTENT =
  /\b(investigat(?:e|ion)|analy[sz](?:e|ing|is)|diagnos(?:e|is|tic)|root cause|why (?:is|are|did)|incident|outage|failure|failing|error spike|latency spike|degradation|regression|what'?s (?:wrong|causing))\b/i;
const SKILL_REFERENCE = /\$([a-z0-9][a-z0-9-]{0,62}[a-z0-9])/gi;

export function selectGrafanaSkills(
  prompt: string,
  skills: readonly GrafanaSkill[] = GRAFANA_SKILLS
): GrafanaSkillSelection {
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const explicitSkillNames = extractSkillReferences(prompt).filter((name) => skillByName.has(name));
  const activeNames = new Set<string>();

  for (const skillName of explicitSkillNames) {
    activeNames.add(skillName);
  }

  if (shouldActivateDashboardSkill(prompt) && skillByName.has('grafana-dashboard')) {
    activeNames.add('grafana-dashboard');
  }

  if (RQLITE_INTENT.test(prompt) && skillByName.has('rqlite-datasource')) {
    activeNames.add('rqlite-datasource');
  }

  if (INVESTIGATION_INTENT.test(prompt) && skillByName.has('investigation')) {
    activeNames.add('investigation');
  }

  for (const skill of skills) {
    if (!activeNames.has(skill.name) && shouldActivateConfiguredSkill(prompt, skill)) {
      activeNames.add(skill.name);
    }
  }

  const activeSkills = [...activeNames].map((name) => skillByName.get(name)).filter(isSkill);
  const toolGroups = unionToolGroups(activeSkills, BASE_TOOL_GROUPS);

  return {
    activeSkills,
    activeSkillNames: activeSkills.map((skill) => skill.name),
    toolGroups,
    explicitSkillNames,
  };
}

export function extractSkillReferences(prompt: string): string[] {
  const names = new Set<string>();

  for (const match of prompt.matchAll(SKILL_REFERENCE)) {
    names.add(match[1].toLowerCase());
  }

  return [...names];
}

function shouldActivateDashboardSkill(prompt: string) {
  return DASHBOARD_INTENT.test(prompt) || DASHBOARD_WRITE_INTENT.test(prompt);
}

function shouldActivateConfiguredSkill(prompt: string, skill: GrafanaSkill) {
  const activation = skill.activation;

  if (!activation || activation.explicitOnly) {
    return false;
  }

  const lowerPrompt = prompt.toLowerCase();

  if (activation.keywords?.some((keyword) => lowerPrompt.includes(keyword.toLowerCase()))) {
    return true;
  }

  if (activation.regex) {
    try {
      return new RegExp(activation.regex, 'i').test(prompt);
    } catch {
      return false;
    }
  }

  return false;
}

function unionToolGroups(
  skills: readonly GrafanaSkill[],
  initialGroups: readonly SkillToolGroup[] = []
): SkillToolGroup[] {
  const groups = new Set<SkillToolGroup>(initialGroups);

  for (const skill of skills) {
    for (const group of skill.toolGroups) {
      groups.add(group);
    }
  }

  return [...groups];
}

function isSkill(skill: GrafanaSkill | undefined): skill is GrafanaSkill {
  return Boolean(skill);
}
