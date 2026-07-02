import { BASE_SYSTEM_PROMPT } from './systemPrompt';

describe('chat system prompt', () => {
  it('routes dashboard handoffs directly to the dashboard agent', () => {
    expect(BASE_SYSTEM_PROMPT).toContain(
      'when a dashboard task already has validated evidence, requires validation before dashboard creation, follows an investigation, or the user explicitly asks for run_dashboard_agent'
    );
    expect(BASE_SYSTEM_PROMPT).toContain(
      'Persistent dashboard create/update tasks must go through run_dashboard_agent'
    );
    expect(BASE_SYSTEM_PROMPT).toContain('write_dashboard_plan');
    expect(BASE_SYSTEM_PROMPT).toContain('treat that as a hard routing constraint');
    expect(BASE_SYSTEM_PROMPT).toContain('do not add extra top-level specialists');
    expect(BASE_SYSTEM_PROMPT).toContain('After the requested sequence has completed, stop calling tools');
  });
});
