import { GRAFANA_SKILLS, getGrafanaSkills } from './catalog';
import { renderGrafanaSystemPrompt } from './prompt';
import { selectGrafanaSkills } from './selection';

describe('Grafana skill selection', () => {
  it('keeps metrics and subagents available without a default skill', () => {
    const selection = selectGrafanaSkills('why is CPU usage high?', GRAFANA_SKILLS);

    expect(selection.activeSkillNames).toEqual([]);
    expect(selection.toolGroups).toEqual(expect.arrayContaining(['metrics', 'subagents']));
    expect(selection.toolGroups).not.toContain('skillResources');
    expect(selection.toolGroups).not.toContain('managedDashboards');
    expect(selection.toolGroups).not.toContain('jsonnetFiles');
  });

  it('activates the dashboard skill for dashboard artifact requests', () => {
    const selection = selectGrafanaSkills('build a dashboard for node health panels', GRAFANA_SKILLS);

    expect(selection.activeSkillNames).toEqual(['grafana-dashboard']);
    expect(selection.toolGroups).toEqual(
      expect.arrayContaining([
        'metrics',
        'subagents',
        'dashboardRead',
        'jsonnetFiles',
        'managedDashboards',
        'skillResources',
      ])
    );
  });

  it('activates the rqlite skill for SQL datasource requests', () => {
    const selection = selectGrafanaSkills('show me rqlite tables and query SELECT * FROM metrics', GRAFANA_SKILLS);

    expect(selection.activeSkillNames).toEqual(['rqlite-datasource']);
    expect(selection.toolGroups).toEqual(expect.arrayContaining(['metrics', 'subagents', 'rqlite', 'skillResources']));
  });

  it('activates the InfluxDB skill for InfluxDB requests', () => {
    const selection = selectGrafanaSkills('query InfluxDB with Flux for CPU usage', GRAFANA_SKILLS);

    expect(selection.activeSkillNames).toEqual(['influx-datasource']);
    expect(selection.toolGroups).toEqual(expect.arrayContaining(['metrics', 'subagents', 'influx', 'skillResources']));
  });

  it('does not activate rqlite for InfluxDB SQL requests', () => {
    const selection = selectGrafanaSkills('run an InfluxDB SQL query for host metrics', GRAFANA_SKILLS);

    expect(selection.activeSkillNames).toEqual(['influx-datasource']);
    expect(selection.toolGroups).toContain('influx');
    expect(selection.toolGroups).not.toContain('rqlite');
  });

  it('renders only active skill instructions into the system prompt', () => {
    const prompt = renderGrafanaSystemPrompt({
      skills: GRAFANA_SKILLS,
      activeSkillNames: ['grafana-dashboard'],
    });

    expect(prompt).toContain('## Available Skills');
    expect(prompt).toContain('### grafana-dashboard');
    expect(prompt).toContain('references/dashboard-jsonnet-workflow.md');
    expect(prompt).not.toContain('### grafana-metrics');
    expect(prompt).not.toContain('references/promql-patterns.md');
  });

  it('activates configured skills by explicit reference', () => {
    const skills = getGrafanaSkills(
      {
        customSkills: [
          {
            name: 'team-runbook',
            description: 'Use the team incident workflow.',
            content: '# Team Runbook\n\nFollow the team workflow.',
          },
        ],
      },
      []
    );
    const selection = selectGrafanaSkills('Use $team-runbook for this incident', skills);
    const prompt = renderGrafanaSystemPrompt({
      skills,
      activeSkillNames: selection.activeSkillNames,
    });

    expect(selection.activeSkillNames).toEqual(['team-runbook']);
    expect(selection.toolGroups).toEqual(expect.arrayContaining(['metrics', 'subagents', 'skillResources']));
    expect(prompt).toContain('### team-runbook');
    expect(prompt).toContain('# Team Runbook');
  });

  it('activates configured skills by configured keyword or regex only when auto activation is enabled', () => {
    const skills = getGrafanaSkills(
      {
        customSkills: [
          {
            name: 'keyword-runbook',
            description: 'Use for paging incidents.',
            content: '# Keyword Runbook',
            activation: { keywords: ['paging incident'] },
          },
          {
            name: 'regex-runbook',
            description: 'Use for database alerts.',
            content: '# Regex Runbook',
            activation: { regex: '\\bdatabase\\b' },
          },
          {
            name: 'explicit-only',
            description: 'Use only when named.',
            content: '# Explicit Only',
          },
        ],
      },
      []
    );

    expect(selectGrafanaSkills('Handle this paging incident', skills).activeSkillNames).toEqual(['keyword-runbook']);
    expect(selectGrafanaSkills('Investigate database latency', skills).activeSkillNames).toEqual(['regex-runbook']);
    expect(selectGrafanaSkills('Use an explicit only workflow', skills).activeSkillNames).toEqual([]);
  });
});
