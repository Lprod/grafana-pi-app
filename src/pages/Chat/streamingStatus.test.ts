import {
  createInitialRunStatus,
  formatRunElapsed,
  reduceChatRunStatus,
  resolveChatRunStatusFromStreamingMessage,
  runStatusBadgeText,
  runStatusText,
  type ChatRunStatus,
} from './streamingStatus';

describe('streaming status', () => {
  it('tracks user-visible run phases from agent events', () => {
    let status: ChatRunStatus | undefined = createInitialRunStatus(1000);
    expect(runStatusText(status)).toBe('Waiting for model');
    expect(runStatusBadgeText(status)).toBe('Waiting');

    status = reduceChatRunStatus(
      status,
      {
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'checking' }] },
        assistantMessageEvent: { type: 'thinking_delta' },
      } as any,
      1200
    );
    expect(status).toMatchObject({ phase: 'thinking', startedAt: 1000 });
    expect(runStatusText(status)).toBe('Thinking');

    status = reduceChatRunStatus(
      status,
      {
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        assistantMessageEvent: { type: 'text_start' },
      } as any,
      1600
    );
    expect(status).toMatchObject({ phase: 'generating', startedAt: 1000 });
    expect(runStatusText(status)).toBe('Generating answer');

    expect(reduceChatRunStatus(status, { type: 'agent_end' } as any, 2000)).toBeUndefined();
  });

  it('infers phase from assistant content when stream markers are unavailable', () => {
    let status: ChatRunStatus | undefined = createInitialRunStatus(1000);

    status = reduceChatRunStatus(
      status,
      {
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'checking' }] },
      } as any,
      1200
    );
    expect(status).toMatchObject({ phase: 'thinking', startedAt: 1000 });

    status = reduceChatRunStatus(
      status,
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'checking' },
            { type: 'text', text: 'answer' },
          ],
        },
      } as any,
      1600
    );
    expect(status).toMatchObject({ phase: 'generating', startedAt: 1000 });

    status = reduceChatRunStatus(
      status,
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'checking' },
            { type: 'text', text: 'answer' },
            { type: 'toolCall', name: 'list_datasources', arguments: {} },
          ],
        },
      } as any,
      1800
    );
    expect(status).toMatchObject({ phase: 'preparing_tool', detail: 'list_datasources', startedAt: 1000 });
  });

  it('resolves display status from the live streaming assistant message', () => {
    const status = resolveChatRunStatusFromStreamingMessage(
      createInitialRunStatus(1000),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'checking' },
          { type: 'text', text: 'answer' },
        ],
      } as any,
      1800
    );

    expect(status).toMatchObject({ phase: 'generating', startedAt: 1000 });
    expect(runStatusText(status)).toBe('Generating answer');
  });

  it('surfaces tool preparation, tool execution, and approval labels', () => {
    let status = reduceChatRunStatus(
      createInitialRunStatus(1000),
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'list_datasources', arguments: {} }],
        },
        assistantMessageEvent: { type: 'toolcall_start' },
      } as any,
      1500
    );
    expect(runStatusText(status)).toBe('Preparing list datasources');
    expect(runStatusBadgeText(status)).toBe('Tool call');

    status = reduceChatRunStatus(
      status,
      { type: 'tool_execution_start', toolName: 'list_datasources', toolCallId: 'call-1', args: {} } as any,
      1800
    );
    expect(runStatusText(status)).toBe('Running list datasources');
    expect(runStatusBadgeText(status)).toBe('Running tool');
    expect(runStatusText(status, 'save_dashboard')).toBe('Waiting for approval: save dashboard');
    expect(runStatusBadgeText(status, 'save_dashboard')).toBe('Approval');
  });

  it('formats elapsed run time compactly', () => {
    expect(formatRunElapsed(250)).toBe('0s');
    expect(formatRunElapsed(12_000)).toBe('12s');
    expect(formatRunElapsed(65_000)).toBe('1m 05s');
  });
});
