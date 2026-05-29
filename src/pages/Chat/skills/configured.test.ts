jest.mock('typebox', () => ({
  Type: {
    Object: jest.fn((properties) => ({ properties })),
    String: jest.fn((config) => config ?? {}),
  },
}));

import { createSkillTools } from '../tools/skills';
import { getGrafanaSkills } from './catalog';
import { parseCustomSkillsJson, validateCustomSkillsJson } from './configured';

describe('configured Grafana skills', () => {
  it('normalizes enabled custom skills without allowing bundled skill overrides', () => {
    const skills = getGrafanaSkills(
      {
        customSkills: [
          {
            name: 'grafana-dashboard',
            description: 'Attempted override',
            content: 'Do something else.',
          },
          {
            name: 'team-runbook',
            description: 'Team incident workflow.',
            content: '# Team Runbook\n\nUse the internal incident workflow.',
            toolGroups: ['metrics', 'rqlite', 'dashboardRead', 'adHocDashboards'],
            resources: [
              {
                path: 'references/runbook.md',
                content: '# Runbook\n\nEscalate after 15 minutes.',
              },
            ],
          },
        ],
      },
      []
    );

    expect(skills).toHaveLength(2);
    expect(skills[0]).toMatchObject({
      name: 'grafana-dashboard',
      filePath: 'plugin-config/customSkills/grafana-dashboard',
    });
    expect(skills[1]).toMatchObject({
      name: 'team-runbook',
      filePath: 'plugin-config/customSkills/team-runbook',
      toolGroups: expect.arrayContaining(['skillResources', 'metrics', 'rqlite', 'dashboardRead']),
    });
    expect(skills[1].toolGroups).not.toContain('adHocDashboards');
    expect(skills[1].resources['references/runbook.md']).toMatchObject({
      path: 'references/runbook.md',
      content: '# Runbook\n\nEscalate after 15 minutes.',
    });

    const withBundledNameReserved = getGrafanaSkills(
      {
        customSkills: [
          {
            name: 'grafana-dashboard',
            description: 'Attempted override',
            content: 'Do something else.',
          },
        ],
      },
      [
        {
          name: 'grafana-dashboard',
          description: 'Bundled dashboard skill.',
          content: '# Bundled',
          filePath: '.agents/skills/grafana-dashboard/SKILL.md',
          resources: {},
          toolGroups: ['skillResources'],
        },
      ]
    );

    expect(withBundledNameReserved).toHaveLength(1);
    expect(withBundledNameReserved[0].content).toBe('# Bundled');
  });

  it('validates custom skill JSON before saving plugin config', () => {
    expect(
      parseCustomSkillsJson(`[
        {
          "name": "team-runbook",
          "description": "Team incident workflow.",
          "content": "# Team Runbook",
          "activation": { "keywords": ["incident"] },
          "toolGroups": ["metrics", "rqlite", "skillResources"]
        }
      ]`)
    ).toEqual([
      {
        name: 'team-runbook',
        description: 'Team incident workflow.',
        content: '# Team Runbook',
        activation: { keywords: ['incident'] },
        toolGroups: ['metrics', 'rqlite', 'skillResources'],
      },
    ]);

    expect(validateCustomSkillsJson('{"name":"not-array"}')).toContain('must be an array');
    expect(
      validateCustomSkillsJson(`[
        {
          "name": "bad name",
          "description": "Invalid",
          "content": "# Invalid",
          "toolGroups": ["adHocDashboards"]
        }
      ]`)
    ).toContain('name must be kebab-case');
  });

  it('reads resources from a configured skill', async () => {
    const skills = getGrafanaSkills(
      {
        customSkills: [
          {
            name: 'team-runbook',
            description: 'Team incident workflow.',
            content: '# Team Runbook',
            resources: [{ path: 'references/runbook.md', content: '# Runbook' }],
          },
        ],
      },
      []
    );
    const tool = createSkillTools(skills)[0] as {
      execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
    };

    const result = await tool.execute('call-1', { skill: 'team-runbook', path: 'references/runbook.md' }, undefined);

    expect(result.content[0].text).toContain('# Runbook');
    expect(result.details).toMatchObject({
      skill: 'team-runbook',
      path: 'references/runbook.md',
      truncated: false,
    });
  });
});

type ToolResult = {
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
};
