import React, { useMemo } from 'react';
import { css, cx, keyframes } from '@emotion/css';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { renderMarkdown, type GrafanaTheme2 } from '@grafana/data';
import { Badge, Spinner, useStyles2 } from '@grafana/ui';
import type { SubagentRunDetails, SubagentToolCall } from './tools';
import {
  highlightJsonnetLines,
  partialJsonStringField,
  shouldHighlightJsonnet,
  utf8ByteLength,
  type CodeToken,
  type CodeTokenKind,
} from './jsonnetRendering';

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
  const structuredResult = renderStructuredToolResult(toolName, details, content);

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
      {structuredResult ?? <ContentBlocks content={content} />}
      {!structuredResult && hasDetails(details) && (
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
                {renderStructuredToolCall(run.name, run.args, undefined, run.status === 'running') ?? (
                  <pre className={styles.toolCallJson}>{formatJson(run.args)}</pre>
                )}
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
  const structuredToolCall = renderStructuredToolCall(name, args, partialJson, Boolean(isStreaming));
  return (
    <div className={styles.toolCall}>
      <div className={styles.toolCallHeader}>
        <Badge text={isStreaming ? 'preparing' : 'tool call'} color="blue" />
        <strong>{name}</strong>
      </div>
      {structuredToolCall ?? (
        <pre className={styles.toolCallJson}>{partialJson && isStreaming ? partialJson : formatJson(args)}</pre>
      )}
    </div>
  );
}

function renderStructuredToolCall(
  name: string,
  args: unknown,
  partialJson: string | undefined,
  isStreaming: boolean
): React.ReactNode | undefined {
  const jsonnetWrite = asJsonnetWriteToolCall(name, args, partialJson, isStreaming);
  if (jsonnetWrite) {
    return <JsonnetWriteToolCallView call={jsonnetWrite} />;
  }

  return undefined;
}

type JsonnetWriteToolCall = {
  path: string;
  content: string;
  partial: boolean;
};

const DEFAULT_TOOL_CALL_JSONNET_PATH = 'dashboard.jsonnet';

function JsonnetWriteToolCallView({ call }: { call: JsonnetWriteToolCall }) {
  const styles = useStyles2(getToolStyles);
  const lines = call.content ? textToCodeLines(call.content) : [];
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>
        {call.partial ? 'Writing' : 'Created'} <code>{call.path}</code>
      </div>
      <ResultMetaGrid
        items={[
          { label: 'Path', value: <code>{call.path}</code> },
          { label: 'Lines', value: lines.length > 0 ? formatCount(lines.length) : undefined },
          { label: 'Source', value: formatBytes(utf8ByteLength(call.content)) },
          { label: 'Status', value: call.partial ? 'streaming' : 'ready' },
        ]}
      />
      {lines.length > 0 ? <CodeViewer lines={lines} /> : <div className={styles.emptyState}>Waiting for source.</div>}
    </div>
  );
}

function asJsonnetWriteToolCall(
  name: string,
  args: unknown,
  partialJson: string | undefined,
  isStreaming: boolean
): JsonnetWriteToolCall | undefined {
  if (name !== 'write_jsonnet' && name !== 'grafana_write_jsonnet_file') {
    return undefined;
  }

  const partial = partialJson ? jsonnetWriteToolCallFromPartialJson(partialJson) : undefined;
  const complete = jsonnetWriteToolCallFromArgs(args);
  if (partial && (isStreaming || !complete)) {
    return partial;
  }
  return complete;
}

function jsonnetWriteToolCallFromArgs(args: unknown): JsonnetWriteToolCall | undefined {
  if (!isRecord(args)) {
    return undefined;
  }

  const content = stringField(args, 'content') ?? stringField(args, 'dashboard_jsonnet');
  if (content === undefined) {
    return undefined;
  }

  return {
    path: stringField(args, 'path') ?? DEFAULT_TOOL_CALL_JSONNET_PATH,
    content,
    partial: false,
  };
}

function jsonnetWriteToolCallFromPartialJson(partialJson: string): JsonnetWriteToolCall | undefined {
  try {
    return jsonnetWriteToolCallFromArgs(JSON.parse(partialJson));
  } catch {
    const content =
      partialJsonStringField(partialJson, 'content') ?? partialJsonStringField(partialJson, 'dashboard_jsonnet');
    if (content === undefined) {
      return undefined;
    }

    return {
      path: partialJsonStringField(partialJson, 'path') ?? DEFAULT_TOOL_CALL_JSONNET_PATH,
      content,
      partial: true,
    };
  }
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

function renderStructuredToolResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): React.ReactNode | undefined {
  const datasources = asDatasourceResult(toolName, details, content);
  if (datasources) {
    return <DatasourceResultView datasources={datasources} />;
  }

  const lineList = asLineListResult(toolName, details, content);
  if (lineList) {
    return <LineListResultView result={lineList} />;
  }

  const metricSeries = asMetricSeriesInspection(toolName, details, content);
  if (metricSeries) {
    return <MetricSeriesInspectionView result={metricSeries} />;
  }

  const prometheusQuery = asPrometheusQuerySummary(toolName, content);
  if (prometheusQuery) {
    return <PrometheusQueryResultView result={prometheusQuery} />;
  }

  const rawPrometheusQuery = asRawPrometheusQuery(toolName, details);
  if (rawPrometheusQuery) {
    return <RawPrometheusQueryResultView content={content} result={rawPrometheusQuery} />;
  }

  const screenshot = asScreenshotResult(toolName, details);
  if (screenshot) {
    return <ScreenshotResultView content={content} result={screenshot} />;
  }

  const dashboardList = asDashboardList(toolName, content);
  if (dashboardList) {
    return <DashboardListView result={dashboardList} />;
  }

  const managedDashboardList = asManagedDashboardList(toolName, content);
  if (managedDashboardList) {
    return <ManagedDashboardListView result={managedDashboardList} />;
  }

  const jsonnetSearch = asJsonnetSearchResult(toolName, content);
  if (jsonnetSearch) {
    return <JsonnetSearchResultView result={jsonnetSearch} />;
  }

  const jsonnetList = asJsonnetListResult(toolName, content);
  if (jsonnetList) {
    return <JsonnetListResultView result={jsonnetList} />;
  }

  const jsonnetRead = asJsonnetReadResult(toolName, content);
  if (jsonnetRead) {
    return <JsonnetReadResultView result={jsonnetRead} />;
  }

  const managedSource = asManagedDashboardSource(toolName, content);
  if (managedSource) {
    return <ManagedDashboardSourceView result={managedSource} />;
  }

  const jsonnetFile = asJsonnetFileResult(toolName, details, content);
  if (jsonnetFile) {
    return <JsonnetFileResultView result={jsonnetFile} />;
  }

  const dashboardSummary = asDashboardSummary(toolName, details, content);
  if (dashboardSummary) {
    return <DashboardSummaryView result={dashboardSummary} />;
  }

  const action = asDashboardAction(toolName, details);
  if (action) {
    return <DashboardActionView action={action} />;
  }

  return undefined;
}

type DatasourceResult = {
  name: string;
  uid: string;
  type: string;
  isDefault: boolean;
};

function DatasourceResultView({ datasources }: { datasources: DatasourceResult[] }) {
  const styles = useStyles2(getToolStyles);
  const summary = `${datasources.length} Prometheus datasource${datasources.length === 1 ? '' : 's'} available`;

  if (datasources.length === 0) {
    return <div className={styles.emptyState}>No Prometheus datasources are available to this assistant.</div>;
  }

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summary}</div>
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Name</th>
              <th>UID</th>
              <th>Type</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            {datasources.map((datasource) => (
              <tr key={`${datasource.type}:${datasource.uid}`}>
                <td>{datasource.name}</td>
                <td className={styles.monospace}>{datasource.uid}</td>
                <td>{datasource.type}</td>
                <td>
                  {datasource.isDefault ? (
                    <Badge text="default" color="green" />
                  ) : (
                    <span className={styles.muted}>-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type LineListResult = {
  title: string;
  datasourceUid?: string;
  count?: number;
  truncated?: boolean;
  items: string[];
};

function LineListResultView({ result }: { result: LineListResult }) {
  const styles = useStyles2(getToolStyles);
  const summaryParts = [formatCount(result.count ?? result.items.length), result.title.toLowerCase()];
  if (result.datasourceUid) {
    summaryParts.push(`from ${result.datasourceUid}`);
  }
  if (result.truncated) {
    summaryParts.push('truncated');
  }

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summaryParts.join(' | ')}</div>
      <div className={styles.scrollList}>
        {result.items.length === 0 ? (
          <span className={styles.muted}>No results</span>
        ) : (
          result.items.map((item) => (
            <div className={styles.listItem} key={item}>
              {item}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

type MetricSeriesInspection = {
  datasourceUid?: string;
  match: string;
  labelNames: string[];
  totalSeries: number;
  truncated: boolean;
  examples: Array<Record<string, string>>;
};

function MetricSeriesInspectionView({ result }: { result: MetricSeriesInspection }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Selector', value: <code>{result.match}</code> },
          { label: 'Datasource', value: result.datasourceUid },
          { label: 'Series', value: formatCount(result.totalSeries) },
          {
            label: 'Examples',
            value: result.truncated ? `${result.examples.length} shown` : String(result.examples.length),
          },
        ]}
      />
      <StringChips values={result.labelNames} />
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Series</th>
              <th>Labels</th>
            </tr>
          </thead>
          <tbody>
            {result.examples.map((example, index) => (
              <tr key={`${result.match}:${index}`}>
                <td>{index + 1}</td>
                <td>
                  <LabelPills labels={example} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type PrometheusQuerySummaryView = {
  datasourceUid: string;
  query: string;
  queryType: string;
  interval: string;
  range?: {
    from?: string;
    to?: string;
  };
  frameCount: number;
  totalSeries: number;
  truncatedSeries: boolean;
  notices: QueryNoticeView[];
  executedQueryStrings: string[];
  series: SeriesSummaryView[];
};

type QueryNoticeView = {
  severity?: string;
  text?: string;
};

type SeriesSummaryView = {
  name: string;
  labels: Record<string, string>;
  points: number;
  nonNullPoints: number;
  nullPoints: number;
  last?: SummaryPointView;
  min?: SummaryPointView;
  max?: SummaryPointView;
  mean?: number;
  delta?: number;
  deltaPercent?: number;
};

type SummaryPointView = {
  time?: string;
  value: number | null;
};

function PrometheusQueryResultView({ result }: { result: PrometheusQuerySummaryView }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Datasource', value: result.datasourceUid },
          { label: 'Type', value: result.queryType },
          { label: 'Interval', value: result.interval },
          { label: 'Frames', value: formatCount(result.frameCount) },
          {
            label: 'Series',
            value: result.truncatedSeries
              ? `${formatCount(result.series.length)} of ${formatCount(result.totalSeries)}`
              : formatCount(result.totalSeries),
          },
        ]}
      />
      <pre className={styles.queryBlock}>{result.query}</pre>
      {result.notices.length > 0 && (
        <div className={styles.noticeList}>
          {result.notices.map((notice, index) => (
            <div className={styles.notice} key={`${notice.severity ?? 'notice'}:${index}`}>
              <strong>{notice.severity ?? 'notice'}</strong>
              <span>{notice.text ?? ''}</span>
            </div>
          ))}
        </div>
      )}
      {result.executedQueryStrings.length > 0 && (
        <details className={styles.collapsible}>
          <summary>Executed query</summary>
          {result.executedQueryStrings.map((query, index) => (
            <pre className={styles.queryBlock} key={`${query}:${index}`}>
              {query}
            </pre>
          ))}
        </details>
      )}
      <div className={styles.tableWrap}>
        <table className={cx(styles.dataTable, styles.wideTable)}>
          <thead>
            <tr>
              <th>Series</th>
              <th>Labels</th>
              <th>Points</th>
              <th>Last</th>
              <th>Min</th>
              <th>Max</th>
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            {result.series.map((series, index) => (
              <tr key={`${series.name}:${index}`}>
                <td className={styles.textClip} title={series.name}>
                  {series.name}
                </td>
                <td>
                  <LabelPills labels={series.labels} limit={6} />
                </td>
                <td>{formatCount(series.points)}</td>
                <td>{formatPoint(series.last)}</td>
                <td>{formatPoint(series.min)}</td>
                <td>{formatPoint(series.max)}</td>
                <td>{formatDelta(series.delta, series.deltaPercent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type RawPrometheusQueryResult = {
  datasourceUid?: string;
  query?: string;
  interval?: string;
  frames?: number;
};

function RawPrometheusQueryResultView({ result, content }: { result: RawPrometheusQueryResult; content: unknown }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Datasource', value: result.datasourceUid },
          { label: 'Interval', value: result.interval },
          { label: 'Frames', value: result.frames === undefined ? undefined : formatCount(result.frames) },
        ]}
      />
      {result.query && <pre className={styles.queryBlock}>{result.query}</pre>}
      <details className={styles.collapsible}>
        <summary>Raw frames</summary>
        <ContentBlocks content={content} />
      </details>
    </div>
  );
}

type ScreenshotResult = {
  uid?: string;
  panelId?: number;
  width?: number;
  height?: number;
};

function ScreenshotResultView({ result, content }: { result: ScreenshotResult; content: unknown }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Dashboard', value: result.uid ? <code>{result.uid}</code> : undefined },
          { label: 'Panel', value: result.panelId === undefined ? undefined : String(result.panelId) },
          { label: 'Size', value: result.width && result.height ? `${result.width} x ${result.height}` : undefined },
        ]}
      />
      <ContentBlocks content={content} />
    </div>
  );
}

type DashboardListResult = {
  dashboards: DashboardListItem[];
};

type DashboardListItem = {
  title: string;
  uid: string;
  url?: string;
  folderTitle?: string;
  folderUid?: string;
};

function DashboardListView({ result }: { result: DashboardListResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{formatCount(result.dashboards.length)} dashboards</div>
      <DashboardTable dashboards={result.dashboards} />
    </div>
  );
}

type ManagedDashboardListResult = {
  dashboards: ManagedDashboardListItem[];
};

type ManagedDashboardListItem = DashboardListItem & {
  sourceChecksum?: string;
  hasJsonnetSource?: boolean;
  dashboardJsonnetSize?: number;
};

function ManagedDashboardListView({ result }: { result: ManagedDashboardListResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{formatCount(result.dashboards.length)} managed dashboards</div>
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Title</th>
              <th>UID</th>
              <th>Folder</th>
              <th>Source</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            {result.dashboards.map((dashboard) => (
              <tr key={dashboard.uid}>
                <td>{dashboard.title}</td>
                <td className={styles.monospace}>{dashboard.uid}</td>
                <td>{dashboard.folderUid || <span className={styles.muted}>-</span>}</td>
                <td>
                  {dashboard.hasJsonnetSource ? (
                    <span title={dashboard.sourceChecksum}>
                      {formatBytes(dashboard.dashboardJsonnetSize) ?? 'stored'} Jsonnet
                    </span>
                  ) : (
                    <span className={styles.muted}>missing</span>
                  )}
                </td>
                <td>
                  {dashboard.url ? (
                    <ExternalLink href={dashboard.url}>Open</ExternalLink>
                  ) : (
                    <span className={styles.muted}>-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DashboardTable({ dashboards }: { dashboards: DashboardListItem[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <thead>
          <tr>
            <th>Title</th>
            <th>UID</th>
            <th>Folder</th>
            <th>Open</th>
          </tr>
        </thead>
        <tbody>
          {dashboards.map((dashboard) => (
            <tr key={dashboard.uid}>
              <td>{dashboard.title}</td>
              <td className={styles.monospace}>{dashboard.uid}</td>
              <td>{dashboard.folderTitle || dashboard.folderUid || <span className={styles.muted}>-</span>}</td>
              <td>
                {dashboard.url ? (
                  <ExternalLink href={dashboard.url}>Open</ExternalLink>
                ) : (
                  <span className={styles.muted}>-</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type JsonnetSearchResult = {
  total: number;
  capped: boolean;
  matches: JsonnetSearchMatch[];
};

type JsonnetSearchMatch = {
  file: string;
  line: number;
  text: string;
};

function JsonnetSearchResultView({ result }: { result: JsonnetSearchResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>
        {formatCount(result.total)} matches{result.capped ? ' | capped' : ''}
      </div>
      <div className={styles.tableWrap}>
        <table className={cx(styles.dataTable, styles.wideTable)}>
          <thead>
            <tr>
              <th>File</th>
              <th>Line</th>
              <th>Text</th>
            </tr>
          </thead>
          <tbody>
            {result.matches.map((match, index) => (
              <tr key={`${match.file}:${match.line}:${index}`}>
                <td className={styles.monospace}>{match.file}</td>
                <td>{match.line}</td>
                <td className={styles.codeTextCell}>{match.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type JsonnetListResult = {
  basePath: string;
  files: string[];
};

function JsonnetListResultView({ result }: { result: JsonnetListResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Base path', value: <code>{result.basePath}</code> },
          { label: 'Files', value: formatCount(result.files.length) },
        ]}
      />
      <div className={styles.scrollList}>
        {result.files.map((file) => (
          <div className={styles.listItem} key={file}>
            {file}
          </div>
        ))}
      </div>
    </div>
  );
}

type JsonnetReadResult = {
  path: string;
  totalLines: number;
  lines: CodeLine[];
};

type CodeLine = {
  line: number;
  text: string;
};

function JsonnetReadResultView({ result }: { result: JsonnetReadResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Path', value: <code>{result.path}</code> },
          {
            label: 'Lines',
            value: `${result.lines[0]?.line ?? 0}-${result.lines[result.lines.length - 1]?.line ?? 0} of ${result.totalLines}`,
          },
        ]}
      />
      <CodeViewer lines={result.lines} />
    </div>
  );
}

type JsonnetFileResult = {
  action?: string;
  path: string;
  version?: number;
  checksum?: string;
  lineCount?: number;
  dashboardJsonnetSize?: number;
  changedRanges: Array<{ startLine: number; endLine: number; newLines: number }>;
  diff?: string;
  firstChangedLine?: number;
  totalLines?: number;
  lines: CodeLine[];
  repairs?: string[];
};

function JsonnetFileResultView({ result }: { result: JsonnetFileResult }) {
  const styles = useStyles2(getToolStyles);
  const range =
    result.lines.length > 0
      ? `${result.lines[0].line}-${result.lines[result.lines.length - 1].line} of ${result.totalLines ?? result.lineCount ?? result.lines.length}`
      : undefined;

  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Action', value: result.action },
          { label: 'Path', value: <code>{result.path}</code> },
          { label: 'Version', value: result.version === undefined ? undefined : String(result.version) },
          {
            label: 'Lines',
            value: range ?? (result.lineCount === undefined ? undefined : formatCount(result.lineCount)),
          },
          { label: 'Source', value: formatBytes(result.dashboardJsonnetSize) },
          { label: 'Changed', value: formatChangedRanges(result.changedRanges) },
          { label: 'Repairs', value: result.repairs?.slice(0, 2).join(', ') },
          { label: 'Checksum', value: result.checksum ? <code>{shortChecksum(result.checksum)}</code> : undefined },
        ]}
      />
      {result.lines.length > 0 && <CodeViewer lines={result.lines} />}
      {result.diff && <DiffViewer diff={result.diff} />}
    </div>
  );
}

type ManagedDashboardSourceResult = {
  uid: string;
  title: string;
  url?: string;
  folderUid?: string;
  sourceChecksum?: string;
  dashboardJsonnet: string;
  dashboardJsonnetSize?: number;
};

function ManagedDashboardSourceView({ result }: { result: ManagedDashboardSourceResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Title', value: result.title },
          { label: 'UID', value: <code>{result.uid}</code> },
          { label: 'Folder', value: result.folderUid },
          { label: 'Source', value: formatBytes(result.dashboardJsonnetSize) },
          {
            label: 'Checksum',
            value: result.sourceChecksum ? <code>{shortChecksum(result.sourceChecksum)}</code> : undefined,
          },
          { label: 'Open', value: result.url ? <ExternalLink href={result.url}>Open</ExternalLink> : undefined },
        ]}
      />
      <CodeViewer lines={textToCodeLines(result.dashboardJsonnet)} />
    </div>
  );
}

type DashboardSummaryResult = {
  title: string;
  uid?: string;
  url?: string;
  folder?: string;
  tags: string[];
  sourceChecksum?: string;
  sourceBytes?: number;
  panels: DashboardPanelSummary[];
};

type DashboardPanelSummary = {
  id?: string;
  title: string;
  type: string;
};

function DashboardSummaryView({ result }: { result: DashboardSummaryResult }) {
  const styles = useStyles2(getToolStyles);
  const typeCounts = countBy(result.panels.map((panel) => panel.type || 'unknown'));
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Title', value: result.title },
          { label: 'UID', value: result.uid ? <code>{result.uid}</code> : undefined },
          { label: 'Folder', value: result.folder },
          { label: 'Panels', value: formatCount(result.panels.length) },
          { label: 'Source', value: result.sourceBytes ? formatBytes(result.sourceBytes) : undefined },
          {
            label: 'Checksum',
            value: result.sourceChecksum ? <code>{shortChecksum(result.sourceChecksum)}</code> : undefined,
          },
          { label: 'Open', value: result.url ? <ExternalLink href={result.url}>Open</ExternalLink> : undefined },
        ]}
      />
      {result.tags.length > 0 && <StringChips values={result.tags} />}
      {typeCounts.length > 0 && (
        <div className={styles.chipList}>
          {typeCounts.map(({ key, count }) => (
            <span className={styles.chip} key={key}>
              {key}: {count}
            </span>
          ))}
        </div>
      )}
      {result.panels.length > 0 && (
        <details className={styles.collapsible}>
          <summary>Panels</summary>
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {result.panels.slice(0, 30).map((panel, index) => (
                  <tr key={`${panel.id ?? index}:${panel.title}`}>
                    <td>{panel.id ?? <span className={styles.muted}>-</span>}</td>
                    <td>{panel.title}</td>
                    <td>{panel.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

type DashboardAction = {
  title: string;
  status?: string;
  uid?: string;
  url?: string;
  sourceChecksum?: string;
};

function DashboardActionView({ action }: { action: DashboardAction }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.actionCard}>
      <div className={styles.actionTitle}>{action.title}</div>
      <ResultMetaGrid
        items={[
          { label: 'Status', value: action.status },
          { label: 'UID', value: action.uid ? <code>{action.uid}</code> : undefined },
          {
            label: 'Source',
            value: action.sourceChecksum ? <code>{shortChecksum(action.sourceChecksum)}</code> : undefined,
          },
          { label: 'Open', value: action.url ? <ExternalLink href={action.url}>Open</ExternalLink> : undefined },
        ]}
      />
    </div>
  );
}

function ResultMetaGrid({ items }: { items: Array<{ label: string; value?: React.ReactNode }> }) {
  const styles = useStyles2(getToolStyles);
  const visible = items.filter((item) => item.value !== undefined && item.value !== '');
  if (visible.length === 0) {
    return null;
  }

  return (
    <div className={styles.metaGrid}>
      {visible.map((item) => (
        <div className={styles.metaItem} key={item.label}>
          <span className={styles.metaLabel}>{item.label}</span>
          <span className={styles.metaValue}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function StringChips({ values }: { values: string[] }) {
  const styles = useStyles2(getToolStyles);
  if (values.length === 0) {
    return null;
  }

  return (
    <div className={styles.chipList}>
      {values.map((value) => (
        <span className={styles.chip} key={value}>
          {value}
        </span>
      ))}
    </div>
  );
}

function LabelPills({ labels, limit = 12 }: { labels: Record<string, string>; limit?: number }) {
  const styles = useStyles2(getToolStyles);
  const entries = Object.entries(labels).filter(([, value]) => value !== undefined && value !== '');
  if (entries.length === 0) {
    return <span className={styles.muted}>-</span>;
  }

  const visible = entries.slice(0, limit);
  return (
    <div className={styles.chipList}>
      {visible.map(([key, value]) => (
        <span className={styles.chip} key={`${key}:${value}`}>
          <span className={styles.labelKey}>{key}</span>={value}
        </span>
      ))}
      {entries.length > visible.length && <span className={styles.muted}>+{entries.length - visible.length}</span>}
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  const styles = useStyles2(getToolStyles);
  return (
    <a className={styles.externalLink} href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

function CodeViewer({ lines, language = 'jsonnet' }: { lines: CodeLine[]; language?: 'jsonnet' | 'plain' }) {
  const styles = useStyles2(getToolStyles);
  const highlighted = useMemo(
    () => (language === 'jsonnet' && shouldHighlightJsonnet(lines) ? highlightJsonnetLines(lines) : undefined),
    [language, lines]
  );
  return (
    <pre className={styles.codeViewer}>
      {lines.map((line, index) => (
        <div className={styles.codeLine} key={line.line}>
          <span className={styles.lineNumber}>{line.line}</span>
          <span className={styles.codeText}>
            <CodeLineText text={line.text} tokens={highlighted?.[index]} />
          </span>
        </div>
      ))}
    </pre>
  );
}

function CodeLineText({ text, tokens }: { text: string; tokens?: CodeToken[] }) {
  const styles = useStyles2(getToolStyles);
  if (!tokens) {
    return <>{text || ' '}</>;
  }

  return (
    <>
      {tokens.length > 0
        ? tokens.map((token, index) => (
            <span className={codeTokenClass(styles, token.kind)} key={`${index}:${token.text}`}>
              {token.text}
            </span>
          ))
        : ' '}
    </>
  );
}

function codeTokenClass(styles: ReturnType<typeof getToolStyles>, kind: CodeTokenKind | undefined) {
  switch (kind) {
    case 'comment':
      return styles.syntaxComment;
    case 'keyword':
      return styles.syntaxKeyword;
    case 'string':
      return styles.syntaxString;
    case 'number':
      return styles.syntaxNumber;
    case 'builtin':
      return styles.syntaxBuiltin;
    case 'key':
      return styles.syntaxKey;
    case 'operator':
      return styles.syntaxOperator;
    case 'punctuation':
      return styles.syntaxPunctuation;
    default:
      return undefined;
  }
}

function DiffViewer({ diff }: { diff: string }) {
  const styles = useStyles2(getToolStyles);
  return (
    <pre className={styles.diffViewer}>
      {diff.split('\n').map((line, index) => (
        <div
          className={cx(
            styles.diffLine,
            line.startsWith('+') && styles.diffAdd,
            line.startsWith('-') && styles.diffDelete,
            line.startsWith('@@') && styles.diffMeta
          )}
          key={`${index}:${line}`}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function asSubagentDetails(details: unknown): SubagentRunDetails | undefined {
  if (!details || typeof details !== 'object') {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  return record.type === 'subagent' ? (details as SubagentRunDetails) : undefined;
}

function asDatasourceResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): DatasourceResult[] | undefined {
  if (toolName !== 'list_datasources' && toolName !== 'grafana_get_datasources') {
    return undefined;
  }

  const detailsDatasources = isRecord(details) ? asDatasourceArray(details.datasources) : undefined;
  if (detailsDatasources) {
    return detailsDatasources;
  }

  const contentText = getSingleTextContent(content);
  if (!contentText) {
    return undefined;
  }

  try {
    return asDatasourceArray(JSON.parse(contentText));
  } catch {
    return undefined;
  }
}

function asDatasourceArray(value: unknown): DatasourceResult[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const datasources = value.map(asDatasource);
  return datasources.every(Boolean) ? (datasources as DatasourceResult[]) : undefined;
}

function asDatasource(value: unknown): DatasourceResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { name, uid, type, isDefault } = value;
  if (typeof name !== 'string' || typeof uid !== 'string' || typeof type !== 'string') {
    return undefined;
  }

  return {
    name,
    uid,
    type,
    isDefault: Boolean(isDefault),
  };
}

function asLineListResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): LineListResult | undefined {
  if (toolName !== 'list_metrics' && toolName !== 'list_label_values') {
    return undefined;
  }

  const contentText = getSingleTextContent(content);
  if (!contentText) {
    return undefined;
  }

  const detailRecord = isRecord(details) ? details : {};
  const items = contentText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('... '));

  return {
    title:
      toolName === 'list_metrics'
        ? 'Metrics'
        : `Label values${typeof detailRecord.label === 'string' ? `: ${detailRecord.label}` : ''}`,
    datasourceUid: stringField(detailRecord, 'datasourceUid'),
    count: numberField(detailRecord, 'count'),
    truncated: booleanField(detailRecord, 'truncated'),
    items,
  };
}

function asMetricSeriesInspection(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): MetricSeriesInspection | undefined {
  if (toolName !== 'inspect_metric_series') {
    return undefined;
  }

  const record = isRecord(details) ? details : parseJsonRecord(content);
  if (!record) {
    return undefined;
  }

  const match = stringField(record, 'match');
  const labelNames = stringArrayField(record, 'labelNames');
  const examples = recordsField(record, 'examples').map(stringRecord);
  if (!match || !labelNames) {
    return undefined;
  }

  return {
    datasourceUid: stringField(record, 'datasourceUid'),
    match,
    labelNames,
    totalSeries: numberField(record, 'totalSeries') ?? examples.length,
    truncated: booleanField(record, 'truncated') ?? false,
    examples,
  };
}

function asPrometheusQuerySummary(
  toolName: string | undefined,
  content: unknown
): PrometheusQuerySummaryView | undefined {
  if (toolName !== 'query_prometheus') {
    return undefined;
  }

  const record = parseJsonRecord(content);
  if (!record) {
    return undefined;
  }

  const datasourceUid = stringField(record, 'datasourceUid');
  const query = stringField(record, 'query');
  const seriesRecords = recordsField(record, 'series');
  if (!datasourceUid || !query) {
    return undefined;
  }

  const range = recordField(record, 'range');
  return {
    datasourceUid,
    query,
    queryType: stringField(record, 'queryType') ?? 'query',
    interval: stringField(record, 'interval') ?? '-',
    range: range
      ? {
          from: stringField(range, 'from'),
          to: stringField(range, 'to'),
        }
      : undefined,
    frameCount: numberField(record, 'frameCount') ?? 0,
    totalSeries: numberField(record, 'totalSeries') ?? seriesRecords.length,
    truncatedSeries: booleanField(record, 'truncatedSeries') ?? false,
    notices: recordsField(record, 'notices').map((notice) => ({
      severity: stringField(notice, 'severity'),
      text: stringField(notice, 'text'),
    })),
    executedQueryStrings: stringArrayField(record, 'executedQueryStrings') ?? [],
    series: seriesRecords.map(asSeriesSummary).filter((series): series is SeriesSummaryView => Boolean(series)),
  };
}

function asSeriesSummary(record: Record<string, unknown>): SeriesSummaryView | undefined {
  const name = stringField(record, 'name');
  if (!name) {
    return undefined;
  }

  return {
    name,
    labels: stringRecord(recordField(record, 'labels')),
    points: numberField(record, 'points') ?? 0,
    nonNullPoints: numberField(record, 'nonNullPoints') ?? 0,
    nullPoints: numberField(record, 'nullPoints') ?? 0,
    last: pointField(record, 'last'),
    min: pointField(record, 'min'),
    max: pointField(record, 'max'),
    mean: numberField(record, 'mean'),
    delta: numberField(record, 'delta'),
    deltaPercent: numberField(record, 'deltaPercent'),
  };
}

function asRawPrometheusQuery(toolName: string | undefined, details: unknown): RawPrometheusQueryResult | undefined {
  if (toolName !== 'query_prometheus_raw' || !isRecord(details)) {
    return undefined;
  }

  return {
    datasourceUid: stringField(details, 'datasourceUid'),
    query: stringField(details, 'query'),
    interval: stringField(details, 'interval'),
    frames: numberField(details, 'frames'),
  };
}

function asScreenshotResult(toolName: string | undefined, details: unknown): ScreenshotResult | undefined {
  if (toolName !== 'screenshot_dashboard' && toolName !== 'grafana_screenshot') {
    return undefined;
  }
  if (!isRecord(details)) {
    return undefined;
  }

  return {
    uid: stringField(details, 'uid'),
    panelId: numberField(details, 'panelId'),
    width: numberField(details, 'width'),
    height: numberField(details, 'height'),
  };
}

function asDashboardList(toolName: string | undefined, content: unknown): DashboardListResult | undefined {
  if (toolName !== 'list_dashboards' && toolName !== 'grafana_list_dashboards') {
    return undefined;
  }

  const dashboards = parseJsonArray(content)
    ?.map(asDashboardListItem)
    .filter((item): item is DashboardListItem => Boolean(item));
  return dashboards ? { dashboards } : undefined;
}

function asDashboardListItem(record: unknown): DashboardListItem | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  const title = stringField(record, 'title');
  const uid = stringField(record, 'uid');
  if (!title || !uid) {
    return undefined;
  }
  return {
    title,
    uid,
    url: stringField(record, 'url'),
    folderTitle: stringField(record, 'folderTitle'),
    folderUid: stringField(record, 'folderUid'),
  };
}

function asManagedDashboardList(
  toolName: string | undefined,
  content: unknown
): ManagedDashboardListResult | undefined {
  if (toolName !== 'list_managed_dashboards' && toolName !== 'grafana_list_managed_dashboards') {
    return undefined;
  }

  const dashboards = parseJsonArray(content)
    ?.map(asManagedDashboardListItem)
    .filter((item): item is ManagedDashboardListItem => Boolean(item));
  return dashboards ? { dashboards } : undefined;
}

function asManagedDashboardListItem(record: unknown): ManagedDashboardListItem | undefined {
  const dashboard = asDashboardListItem(record);
  if (!dashboard || !isRecord(record)) {
    return undefined;
  }
  return {
    ...dashboard,
    sourceChecksum: stringField(record, 'sourceChecksum'),
    hasJsonnetSource: booleanField(record, 'hasJsonnetSource'),
    dashboardJsonnetSize: numberField(record, 'dashboardJsonnetSize'),
  };
}

function asJsonnetSearchResult(toolName: string | undefined, content: unknown): JsonnetSearchResult | undefined {
  if (toolName !== 'search_grafonnet' && toolName !== 'search_jsonnet_libs') {
    return undefined;
  }

  const record = parseJsonRecord(content);
  if (!record) {
    return undefined;
  }

  const matches = recordsField(record, 'result')
    .map(asJsonnetSearchMatch)
    .filter((match): match is JsonnetSearchMatch => Boolean(match));
  return {
    total: numberField(record, 'total') ?? matches.length,
    capped: booleanField(record, 'capped') ?? false,
    matches,
  };
}

function asJsonnetSearchMatch(record: Record<string, unknown>): JsonnetSearchMatch | undefined {
  const file = stringField(record, 'file');
  const line = numberField(record, 'line');
  const text = stringField(record, 'text');
  return file && line !== undefined && text !== undefined ? { file, line, text } : undefined;
}

function asJsonnetListResult(toolName: string | undefined, content: unknown): JsonnetListResult | undefined {
  if (toolName !== 'list_grafonnet' && toolName !== 'list_jsonnet_libs') {
    return undefined;
  }

  const record = parseJsonRecord(content);
  const files = record ? stringArrayField(record, 'result') : undefined;
  const basePath = record ? stringField(record, 'basePath') : undefined;
  return record && files && basePath ? { basePath, files } : undefined;
}

function asJsonnetReadResult(toolName: string | undefined, content: unknown): JsonnetReadResult | undefined {
  if (toolName !== 'read_grafonnet' && toolName !== 'read_jsonnet_lib') {
    return undefined;
  }

  const record = parseJsonRecord(content);
  if (!record) {
    return undefined;
  }

  const path = stringField(record, 'path');
  const lines = recordsField(record, 'result')
    .map(asCodeLine)
    .filter((line): line is CodeLine => Boolean(line));
  if (!path) {
    return undefined;
  }

  return {
    path,
    totalLines: numberField(record, 'totalLines') ?? lines.length,
    lines,
  };
}

function asManagedDashboardSource(
  toolName: string | undefined,
  content: unknown
): ManagedDashboardSourceResult | undefined {
  if (toolName !== 'get_dashboard_source' && toolName !== 'grafana_get_managed_dashboard_source') {
    return undefined;
  }

  const record = parseJsonRecord(content);
  if (!record) {
    return undefined;
  }

  const uid = stringField(record, 'uid');
  const title = stringField(record, 'title');
  const dashboardJsonnet = stringField(record, 'dashboard_jsonnet');
  if (!uid || !title || dashboardJsonnet === undefined) {
    return undefined;
  }

  return {
    uid,
    title,
    url: stringField(record, 'url'),
    folderUid: stringField(record, 'folderUid'),
    sourceChecksum: stringField(record, 'sourceChecksum'),
    dashboardJsonnet,
    dashboardJsonnetSize: numberField(record, 'dashboardJsonnetSize') ?? dashboardJsonnet.length,
  };
}

function asJsonnetFileResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): JsonnetFileResult | undefined {
  if (
    toolName !== 'grafana_write_jsonnet_file' &&
    toolName !== 'grafana_edit_jsonnet_file' &&
    toolName !== 'grafana_read_jsonnet_file' &&
    toolName !== 'write_jsonnet' &&
    toolName !== 'edit_jsonnet' &&
    toolName !== 'fix_jsonnet' &&
    toolName !== 'read_jsonnet'
  ) {
    return undefined;
  }

  const record = isRecord(details) ? details : parseJsonRecord(content);
  if (!record) {
    return undefined;
  }
  const path = stringField(record, 'path');
  if (!path) {
    return undefined;
  }

  return {
    action: stringField(record, 'action'),
    path,
    version: numberField(record, 'version'),
    checksum: stringField(record, 'checksum'),
    lineCount: numberField(record, 'lineCount'),
    dashboardJsonnetSize: numberField(record, 'dashboardJsonnetSize'),
    changedRanges: recordsField(record, 'changedRanges')
      .map((range) => ({
        startLine: numberField(range, 'startLine') ?? 0,
        endLine: numberField(range, 'endLine') ?? 0,
        newLines: numberField(range, 'newLines') ?? 0,
      }))
      .filter((range) => range.startLine > 0),
    diff: stringField(record, 'diff'),
    firstChangedLine: numberField(record, 'firstChangedLine'),
    totalLines: numberField(record, 'totalLines'),
    repairs: stringArrayField(record, 'repairs'),
    lines: recordsField(record, 'lines')
      .map(asCodeLine)
      .filter((line): line is CodeLine => Boolean(line)),
  };
}

function asDashboardSummary(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): DashboardSummaryResult | undefined {
  if (
    toolName !== 'render_dashboard' &&
    toolName !== 'get_dashboard' &&
    toolName !== 'grafana_render_managed_dashboard' &&
    toolName !== 'grafana_get_dashboard'
  ) {
    return undefined;
  }

  const record = parseJsonRecord(content);
  if (!record) {
    return undefined;
  }

  const dashboard = recordField(record, 'dashboard') ?? record;
  const meta = recordField(record, 'meta');
  const title = stringField(dashboard, 'title');
  if (!title) {
    return undefined;
  }

  const resource = recordField(record, 'resource');
  const metadata = resource ? recordField(resource, 'metadata') : undefined;
  const detailRecord = isRecord(details) ? details : {};
  return {
    title,
    uid: stringField(dashboard, 'uid') ?? stringField(metadata, 'name') ?? stringField(detailRecord, 'uid'),
    url: stringField(meta, 'url'),
    folder: stringField(meta, 'folderTitle') ?? stringField(meta, 'folderUid'),
    tags: stringArrayField(dashboard, 'tags') ?? [],
    sourceChecksum: stringField(record, 'sourceChecksum'),
    sourceBytes: numberField(detailRecord, 'sourceBytes'),
    panels: panelsFromDashboard(dashboard),
  };
}

function asDashboardAction(toolName: string | undefined, details: unknown): DashboardAction | undefined {
  if (!isRecord(details)) {
    return undefined;
  }

  if (toolName === 'upload_dashboard' || toolName === 'grafana_upload_dashboard') {
    return {
      title: 'Dashboard uploaded',
      status: stringField(details, 'status'),
      uid: stringField(details, 'uid'),
      url: stringField(details, 'url'),
    };
  }

  if (toolName === 'sync_dashboard' || toolName === 'grafana_sync_managed_dashboard') {
    const status = stringField(details, 'status');
    return {
      title: `Managed dashboard ${status ?? 'synced'}`,
      status,
      uid: stringField(details, 'uid'),
      url: stringField(details, 'url'),
      sourceChecksum: stringField(details, 'sourceChecksum'),
    };
  }

  if (toolName === 'delete_dashboard' || toolName === 'grafana_delete_dashboard') {
    return {
      title: 'Dashboard deleted',
      status: 'deleted',
      uid: stringField(details, 'uid'),
    };
  }

  return undefined;
}

function panelsFromDashboard(dashboard: Record<string, unknown>): DashboardPanelSummary[] {
  return recordsField(dashboard, 'panels').map((panel, index) => ({
    id: stringOrNumberField(panel, 'id'),
    title: stringField(panel, 'title') ?? `Panel ${index + 1}`,
    type: stringField(panel, 'type') ?? 'unknown',
  }));
}

function asCodeLine(record: Record<string, unknown>): CodeLine | undefined {
  const line = numberField(record, 'line');
  const text = stringField(record, 'text');
  return line !== undefined && text !== undefined ? { line, text } : undefined;
}

function pointField(record: Record<string, unknown>, key: string): SummaryPointView | undefined {
  const point = recordField(record, key);
  if (!point) {
    return undefined;
  }
  const rawValue = point.value;
  const value =
    rawValue === null ? null : typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : undefined;
  if (value === undefined) {
    return undefined;
  }
  return {
    time: stringField(point, 'time'),
    value,
  };
}

function getSingleTextContent(content: unknown) {
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }

  const block = content[0];
  return isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

function parseJsonRecord(content: unknown): Record<string, unknown> | undefined {
  const parsed = parseSingleJsonContent(content);
  return isRecord(parsed) ? parsed : undefined;
}

function parseJsonArray(content: unknown): unknown[] | undefined {
  const parsed = parseSingleJsonContent(content);
  return Array.isArray(parsed) ? parsed : undefined;
}

function parseSingleJsonContent(content: unknown): unknown {
  const contentText = getSingleTextContent(content);
  if (!contentText) {
    return undefined;
  }

  try {
    return JSON.parse(contentText);
  } catch {
    return undefined;
  }
}

function recordField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return record && isRecord(record[key]) ? record[key] : undefined;
}

function recordsField(record: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function stringOrNumberField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function stringRecord(record: Record<string, unknown> | undefined): Record<string, string> {
  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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

function formatPoint(point: SummaryPointView | undefined) {
  return point ? formatNumber(point.value) : '-';
}

function formatDelta(delta: number | undefined, deltaPercent: number | undefined) {
  if (delta === undefined) {
    return '-';
  }
  const percent = deltaPercent === undefined ? '' : ` (${formatNumber(deltaPercent)}%)`;
  return `${formatNumber(delta)}${percent}`;
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return '-';
  }
  if (value === 0) {
    return '0';
  }
  const abs = Math.abs(value);
  if (abs >= 1000000 || abs < 0.0001) {
    return value.toExponential(3);
  }
  if (abs >= 1000) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return Number(value.toPrecision(5)).toString();
}

function formatBytes(value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatChangedRanges(ranges: JsonnetFileResult['changedRanges']) {
  if (ranges.length === 0) {
    return undefined;
  }
  return ranges
    .slice(0, 3)
    .map((range) =>
      range.endLine < range.startLine
        ? `${range.startLine} insert`
        : `${range.startLine}-${range.endLine || range.startLine}`
    )
    .join(', ');
}

function shortChecksum(value: string) {
  return value.length > 20 ? `${value.slice(0, 19)}...` : value;
}

function textToCodeLines(value: string): CodeLine[] {
  return value.split('\n').map((text, index) => ({
    line: index + 1,
    text,
  }));
}

function countBy(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => left.key.localeCompare(right.key));
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
  toolCallJson: css({
    margin: 0,
    overflow: 'auto',
    whiteSpace: 'pre',
  }),
  structuredResult: css({
    display: 'grid',
    gap: theme.spacing(1),
  }),
  resultSummary: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  emptyState: css({
    padding: theme.spacing(1),
    color: theme.colors.text.secondary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  tableWrap: css({
    maxWidth: '100%',
    overflowX: 'auto',
  }),
  dataTable: css({
    width: '100%',
    minWidth: 520,
    borderCollapse: 'collapse',
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    '& th, & td': {
      padding: theme.spacing(0.75, 1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      textAlign: 'left',
      verticalAlign: 'middle',
    },
    '& th': {
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
      background: theme.colors.background.secondary,
    },
    '& tbody tr:last-child td': {
      borderBottom: 0,
    },
  }),
  wideTable: css({
    minWidth: 860,
  }),
  metaGrid: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: theme.spacing(1),
  }),
  metaItem: css({
    display: 'grid',
    gap: theme.spacing(0.25),
    minWidth: 0,
    padding: theme.spacing(0.75, 1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  metaLabel: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  metaValue: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '& code': {
      fontFamily: theme.typography.fontFamilyMonospace,
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  queryBlock: css({
    margin: 0,
    padding: theme.spacing(1),
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  chipList: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
    minWidth: 0,
  }),
  chip: css({
    display: 'inline-flex',
    maxWidth: '100%',
    alignItems: 'center',
    padding: theme.spacing(0.25, 0.75),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    fontSize: theme.typography.bodySmall.fontSize,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  labelKey: css({
    color: theme.colors.text.secondary,
  }),
  scrollList: css({
    maxHeight: 280,
    overflow: 'auto',
    display: 'grid',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  listItem: css({
    padding: theme.spacing(0.35, 1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    '&:last-child': {
      borderBottom: 0,
    },
  }),
  noticeList: css({
    display: 'grid',
    gap: theme.spacing(0.5),
  }),
  notice: css({
    display: 'flex',
    gap: theme.spacing(1),
    padding: theme.spacing(0.75, 1),
    borderLeft: `3px solid ${theme.colors.warning.border}`,
    background: theme.colors.background.primary,
    '& strong': {
      color: theme.colors.warning.text,
      textTransform: 'uppercase',
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  textClip: css({
    maxWidth: 260,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  codeTextCell: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    whiteSpace: 'pre-wrap',
  }),
  actionCard: css({
    display: 'grid',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.success.border}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  actionTitle: css({
    fontWeight: theme.typography.fontWeightMedium,
  }),
  externalLink: css({
    color: theme.colors.text.link,
  }),
  codeViewer: css({
    margin: 0,
    maxHeight: 520,
    overflow: 'auto',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  codeLine: css({
    display: 'grid',
    gridTemplateColumns: '4.5em minmax(0, 1fr)',
    minWidth: 0,
  }),
  lineNumber: css({
    userSelect: 'none',
    padding: theme.spacing(0, 1),
    color: theme.colors.text.secondary,
    textAlign: 'right',
    borderRight: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.secondary,
  }),
  codeText: css({
    padding: theme.spacing(0, 1),
    whiteSpace: 'pre',
  }),
  syntaxComment: css({
    color: theme.colors.text.secondary,
    fontStyle: 'italic',
  }),
  syntaxKeyword: css({
    color: theme.colors.primary.text,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  syntaxString: css({
    color: theme.colors.success.text,
  }),
  syntaxNumber: css({
    color: theme.colors.warning.text,
  }),
  syntaxBuiltin: css({
    color: theme.colors.text.link,
  }),
  syntaxKey: css({
    color: theme.colors.text.link,
  }),
  syntaxOperator: css({
    color: theme.colors.text.secondary,
  }),
  syntaxPunctuation: css({
    color: theme.colors.text.secondary,
  }),
  diffViewer: css({
    margin: 0,
    maxHeight: 420,
    overflow: 'auto',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  diffLine: css({
    padding: theme.spacing(0, 1),
    whiteSpace: 'pre',
  }),
  diffAdd: css({
    background: theme.colors.success.transparent,
  }),
  diffDelete: css({
    background: theme.colors.error.transparent,
  }),
  diffMeta: css({
    color: theme.colors.text.secondary,
    background: theme.colors.background.secondary,
  }),
  monospace: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  muted: css({
    color: theme.colors.text.secondary,
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
