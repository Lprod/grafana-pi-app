import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { isFailedDashboardMutationResult } from './result';

describe('tool result helpers', () => {
  it('recognizes structured dashboard mutation failures', () => {
    const result: AgentToolResult<Record<string, unknown>> = {
      content: [{ type: 'text', text: 'Live dashboard mutation LIST_VARIABLES failed.' }],
      details: {
        command: 'LIST_VARIABLES',
        success: false,
        error: 'Validation failed',
      },
    };

    expect(isFailedDashboardMutationResult(result)).toBe(true);
  });

  it('does not classify successful or unrelated structured results as mutation failures', () => {
    expect(
      isFailedDashboardMutationResult({
        content: [],
        details: { command: 'LIST_VARIABLES', success: true },
      })
    ).toBe(false);
    expect(
      isFailedDashboardMutationResult({
        content: [],
        details: { success: false },
      })
    ).toBe(false);
  });
});
