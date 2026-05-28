import React, { useMemo } from 'react';
import { css, cx, keyframes } from '@emotion/css';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { renderMarkdown, type GrafanaTheme2 } from '@grafana/data';
import { Badge, Spinner, useStyles2 } from '@grafana/ui';
import type { SubagentRunDetails, SubagentToolCall } from './tools';

export type ToolRunView = {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed';
  partialResult?: AgentToolResult<any>;
  result?: AgentToolResult<any>;
  isError?: boolean;
  updatedAt: number;
};

export function ContentBlocks({
  content,
  isStreaming = false,
  markdown = true,
}: {
  content: unknown;
  isStreaming?: boolean;
  markdown?: boolean;
}) {
  const styles = useStyles2(getToolStyles);

  if (typeof content === 'string') {
    return markdown ? <MarkdownText isStreaming={isStreaming} text={content} /> : <div>{content}</div>;
  }
  if (!Array.isArray(content)) {
    return <pre>{JSON.stringify(content, null, 2)}</pre>;
  }

  return (
    <>
      {content.map((block, index) => {
        if (!block || typeof block !== 'object') {
          return <pre key={index}>{JSON.stringify(block, null, 2)}</pre>;
        }
        const typedBlock = block as Record<string, any>;
        if (typedBlock.type === 'text') {
          return markdown ? (
            <MarkdownText isStreaming={isStreaming} key={index} text={typedBlock.text} />
          ) : (
            <div key={index}>{typedBlock.text}</div>
          );
        }
        if (typedBlock.type === 'thinking') {
          return (
            <details className={styles.collapsible} key={index}>
              <summary>Thinking</summary>
              <pre>{typedBlock.thinking}</pre>
            </details>
          );
        }
        if (typedBlock.type === 'toolCall') {
          return (
            <ToolCallBlock
              key={index}
              name={typedBlock.name}
              args={typedBlock.arguments}
              partialJson={typeof typedBlock.partialJson === 'string' ? typedBlock.partialJson : undefined}
              isStreaming={isStreaming}
            />
          );
        }
        if (typedBlock.type === 'image') {
          return <img key={index} alt="Tool result" src={`data:${typedBlock.mimeType};base64,${typedBlock.data}`} />;
        }
        return <pre key={index}>{JSON.stringify(typedBlock, null, 2)}</pre>;
      })}
    </>
  );
}

export function ToolResultMessageBody({
  toolName,
  content,
  details,
  isError,
}: {
  toolName?: string;
  content: unknown;
  details: unknown;
  isError?: boolean;
}) {
  const styles = useStyles2(getToolStyles);
  const subagentDetails = asSubagentDetails(details);

  if (subagentDetails) {
    return (
      <div className={cx(styles.toolFrame, subagentDetails.status === 'failed' && styles.toolFrameError)}>
        <ToolHeader name={toolName ?? subagentDetails.agent} status={subagentDetails.status} />
        <ContentBlocks content={content} />
        <SubagentDetailsView details={subagentDetails} />
      </div>
    );
  }

  return (
    <div className={cx(styles.toolFrame, isError && styles.toolFrameError)}>
      <ToolHeader name={toolName ?? 'tool'} status={isError ? 'failed' : 'completed'} />
      <ContentBlocks content={content} />
      {hasDetails(details) && (
        <details className={styles.collapsible}>
          <summary>Details</summary>
          <pre>{formatJson(details)}</pre>
        </details>
      )}
    </div>
  );
}

export function ToolActivityPanel({ runs }: { runs: ToolRunView[] }) {
  const styles = useStyles2(getToolStyles);
  if (runs.length === 0) {
    return null;
  }

  return (
    <section className={styles.activity} aria-label="Tool activity">
      <div className={styles.activityTitle}>
        <Spinner size="sm" />
        <span>Tool activity</span>
      </div>
      <div className={styles.activityList}>
        {runs.map((run) => (
          <div className={styles.activityItem} key={run.id}>
            <ToolHeader name={run.name} status={run.status} compact />
            {asSubagentDetails(run.partialResult?.details) ? (
              <SubagentDetailsView details={run.partialResult?.details as SubagentRunDetails} compact />
            ) : (
              <>
                <pre>{formatJson(run.args)}</pre>
                {run.partialResult && <ContentBlocks content={run.partialResult.content} isStreaming />}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function MarkdownText({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const styles = useStyles2(getToolStyles);
  const html = useMemo(() => renderMarkdown(completeOpenMarkdownFences(text), { breaks: true }).trim(), [text]);

  return (
    <div className={styles.markdown}>
      {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : isStreaming ? null : <span />}
      {isStreaming && <span className={styles.streamingCursor} aria-hidden="true" />}
    </div>
  );
}

function ToolCallBlock({
  name,
  args,
  partialJson,
  isStreaming,
}: {
  name: string;
  args: unknown;
  partialJson?: string;
  isStreaming?: boolean;
}) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.toolCall}>
      <div className={styles.toolCallHeader}>
        <Badge text={isStreaming ? 'preparing' : 'tool call'} color="blue" />
        <strong>{name}</strong>
      </div>
      <pre>{partialJson && isStreaming ? partialJson : formatJson(args)}</pre>
    </div>
  );
}

function ToolHeader({
  name,
  status,
  compact,
}: {
  name: string;
  status: 'running' | 'completed' | 'failed';
  compact?: boolean;
}) {
  const styles = useStyles2(getToolStyles);
  const badge =
    status === 'running' ? (
      <Badge text="running" color="blue" />
    ) : status === 'failed' ? (
      <Badge text="failed" color="red" />
    ) : (
      <Badge text="done" color="green" />
    );

  return (
    <div className={cx(styles.toolHeader, compact && styles.toolHeaderCompact)}>
      {status === 'running' && <Spinner size="sm" />}
      {badge}
      <strong>{name}</strong>
    </div>
  );
}

function SubagentDetailsView({ details, compact }: { details: SubagentRunDetails; compact?: boolean }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.subagent}>
      <div className={styles.subagentMeta}>
        <span>{details.agent === 'metrics' ? 'Metrics explorer' : 'Jsonnet explorer'}</span>
        <span>{formatUsage(details.usage)}</span>
        <span>{details.toolCalls.length} tool calls</span>
      </div>
      {!compact && (
        <details className={styles.collapsible}>
          <summary>Task</summary>
          <pre>{details.task}</pre>
        </details>
      )}
      <div className={styles.toolTimeline}>
        {details.toolCalls.map((call) => (
          <SubagentToolCallRow call={call} key={call.id} />
        ))}
      </div>
    </div>
  );
}

function SubagentToolCallRow({ call }: { call: SubagentToolCall }) {
  const styles = useStyles2(getToolStyles);
  return (
    <details className={cx(styles.toolStep, call.status === 'failed' && styles.toolStepError)}>
      <summary>
        <span>{call.status === 'running' ? 'Running' : call.status === 'failed' ? 'Failed' : 'Done'}</span>
        <strong>{call.name}</strong>
      </summary>
      <pre>{formatJson(call.args)}</pre>
      {call.text && <div className={styles.toolStepText}>{call.text}</div>}
    </details>
  );
}

function asSubagentDetails(details: unknown): SubagentRunDetails | undefined {
  if (!details || typeof details !== 'object') {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  return record.type === 'subagent' ? (details as SubagentRunDetails) : undefined;
}

function hasDetails(details: unknown) {
  return Boolean(details && typeof details === 'object' && Object.keys(details as Record<string, unknown>).length > 0);
}

function formatUsage(usage: SubagentRunDetails['usage']) {
  const parts = [`${usage.turns} turn${usage.turns === 1 ? '' : 's'}`];
  if (usage.totalTokens > 0) {
    parts.push(`${formatCount(usage.totalTokens)} tokens`);
  }
  if (usage.cost > 0) {
    parts.push(`$${usage.cost.toFixed(4)}`);
  }
  return parts.join(' | ');
}

function formatCount(value: number) {
  if (value < 1000) {
    return String(value);
  }
  if (value < 1000000) {
    return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
  }
  return `${(value / 1000000).toFixed(1)}M`;
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function completeOpenMarkdownFences(text: string) {
  const fenceCount = text.split('\n').filter((line) => line.trimStart().startsWith('```')).length;
  return fenceCount % 2 === 1 ? `${text}\n\`\`\`` : text;
}

const blink = keyframes({
  '0%, 45%': { opacity: 1 },
  '46%, 100%': { opacity: 0 },
});

const getToolStyles = (theme: GrafanaTheme2) => ({
  toolFrame: css({
    display: 'grid',
    gap: theme.spacing(1),
  }),
  toolFrameError: css({
    color: theme.colors.error.text,
  }),
  markdown: css({
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    '& > div > :first-child': {
      marginTop: 0,
    },
    '& > div > :last-child': {
      marginBottom: 0,
    },
    '& p': {
      margin: `0 0 ${theme.spacing(1)}`,
    },
    '& ul, & ol': {
      margin: `0 0 ${theme.spacing(1)} ${theme.spacing(2)}`,
      paddingLeft: theme.spacing(2),
    },
    '& li': {
      margin: `${theme.spacing(0.25)} 0`,
    },
    '& code': {
      fontFamily: theme.typography.fontFamilyMonospace,
      fontSize: theme.typography.bodySmall.fontSize,
    },
    '& pre': {
      whiteSpace: 'pre',
      overflow: 'auto',
      padding: theme.spacing(1),
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      background: theme.colors.background.primary,
    },
    '& blockquote': {
      margin: `0 0 ${theme.spacing(1)}`,
      paddingLeft: theme.spacing(1),
      borderLeft: `3px solid ${theme.colors.border.medium}`,
      color: theme.colors.text.secondary,
    },
    '& table': {
      display: 'block',
      maxWidth: '100%',
      overflowX: 'auto',
      borderCollapse: 'collapse',
    },
    '& th, & td': {
      padding: theme.spacing(0.5, 1),
      border: `1px solid ${theme.colors.border.weak}`,
    },
  }),
  streamingCursor: css({
    display: 'inline-block',
    width: 8,
    height: '1em',
    marginLeft: 2,
    verticalAlign: '-0.15em',
    background: theme.colors.primary.text,
    animation: `${blink} 1s steps(1, end) infinite`,
  }),
  toolHeader: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
    '& strong': {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  }),
  toolHeaderCompact: css({
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  toolCall: css({
    display: 'grid',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  toolCallHeader: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  collapsible: css({
    '& summary': {
      cursor: 'pointer',
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  activity: css({
    maxWidth: 980,
    display: 'grid',
    gap: theme.spacing(1),
    padding: theme.spacing(1.5),
    border: `1px dashed ${theme.colors.border.medium}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
  }),
  activityTitle: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    textTransform: 'uppercase',
  }),
  activityList: css({
    display: 'grid',
    gap: theme.spacing(1),
  }),
  activityItem: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  subagent: css({
    display: 'grid',
    gap: theme.spacing(1),
  }),
  subagentMeta: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  toolTimeline: css({
    display: 'grid',
    gap: theme.spacing(0.75),
  }),
  toolStep: css({
    padding: theme.spacing(0.75, 1),
    borderLeft: `3px solid ${theme.colors.success.border}`,
    background: theme.colors.background.primary,
    '& summary': {
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  toolStepError: css({
    borderLeftColor: theme.colors.error.border,
  }),
  toolStepText: css({
    marginTop: theme.spacing(1),
  }),
});
