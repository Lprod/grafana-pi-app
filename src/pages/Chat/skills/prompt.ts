import { BASE_SYSTEM_PROMPT } from '../systemPrompt';
import { GRAFANA_SKILLS } from './catalog';
import type { GrafanaSkill } from './types';

type RenderGrafanaSystemPromptOptions = {
  basePrompt?: string;
  skills?: readonly GrafanaSkill[];
  activeSkillNames?: readonly string[];
};

export function renderGrafanaSystemPrompt({
  basePrompt = BASE_SYSTEM_PROMPT,
  skills = GRAFANA_SKILLS,
  activeSkillNames = [],
}: RenderGrafanaSystemPromptOptions = {}) {
  const activeSkillNameSet = new Set(activeSkillNames);
  const modelVisibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  const activeSkills = modelVisibleSkills.filter((skill) => activeSkillNameSet.has(skill.name));

  return [
    basePrompt.trim(),
    renderAvailableSkills(modelVisibleSkills),
    renderActiveSkills(activeSkills),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderAvailableSkills(skills: readonly GrafanaSkill[]) {
  if (skills.length === 0) {
    return '';
  }

  const rows = skills
    .map((skill) => `- ${skill.name}: ${skill.description} (${skill.filePath})`)
    .join('\n');

  return `## Available Skills\n${rows}\n\nUse a skill when the user's request matches its description or when the user names it with $skill-name. Active skill reference files can be opened with read_skill_resource.`;
}

function renderActiveSkills(skills: readonly GrafanaSkill[]) {
  if (skills.length === 0) {
    return '';
  }

  return [
    '## Active Skills',
    ...skills.map((skill) => renderSkill(skill)),
  ].join('\n\n');
}

function renderSkill(skill: GrafanaSkill) {
  const resources = Object.keys(skill.resources);
  const resourceList =
    resources.length > 0
      ? resources.map((resourcePath) => `- ${resourcePath}`).join('\n')
      : '- No bundled resources';

  return [`### ${skill.name}`, `Source: ${skill.filePath}`, 'Resources:', resourceList, skill.content].join('\n');
}
