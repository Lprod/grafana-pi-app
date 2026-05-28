import { GRAFANA_SKILLS } from './catalog';
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
});
