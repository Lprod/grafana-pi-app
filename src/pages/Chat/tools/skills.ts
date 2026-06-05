import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { GrafanaSkill } from '../skills/types';
import { textResult, throwIfAborted, truncateText } from './result';
import type { SkillResourceReadParams } from './types';

const MAX_SKILL_RESOURCE_LENGTH = 40_000;

export function createSkillTools(skills: readonly GrafanaSkill[]): AgentTool[] {
  return [makeReadSkillResourceTool(skills)];
}

function makeReadSkillResourceTool(skills: readonly GrafanaSkill[]): AgentTool {
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));

  return {
    name: 'read_skill_resource',
    label: 'Read skill resource',
    description:
      'Read a bundled text resource referenced by an active skill. Use this for examples, templates, and detailed workflow notes before applying a skill.',
    parameters: Type.Object({
      skill: Type.String({ description: 'Skill name, for example grafana-dashboard.' }),
      path: Type.String({
        description: 'Resource path listed in the active skill, for example references/example.md.',
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as SkillResourceReadParams;
      throwIfAborted(signal);

      const skill = skillByName.get(args.skill);
      if (!skill) {
        throw new Error(`Unknown skill: ${args.skill}`);
      }

      const resource = skill.resources[args.path];
      if (!resource) {
        throw new Error(`Unknown resource for ${skill.name}: ${args.path}`);
      }

      const text = truncateText(resource.content, MAX_SKILL_RESOURCE_LENGTH);

      return textResult(text, {
        skill: skill.name,
        path: resource.path,
        bytes: resource.bytes,
        truncated: resource.content.length > MAX_SKILL_RESOURCE_LENGTH,
      });
    },
  };
}
