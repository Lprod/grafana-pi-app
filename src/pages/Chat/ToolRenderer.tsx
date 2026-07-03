import React, { useMemo, useState } from 'react';
import { css, cx, keyframes } from '@emotion/css';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { renderMarkdown, type GrafanaTheme2, type IconName } from '@grafana/data';
import { config } from '@grafana/runtime';
import {
  EmbeddedScene,
  PanelBuilders,
  SceneFlexItem,
  SceneFlexLayout,
  SceneQueryRunner,
  SceneTimeRange,
} from '@grafana/scenes';
import { Badge, Button, Icon, LinkButton, Spinner, type BadgeColor, useStyles2 } from '@grafana/ui';
import { structuredPatch } from 'diff';
import type { ArtifactPreview, ArtifactRef, SubagentRunDetails, SubagentToolCall } from './tools';
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

export type DashboardAction = {
  title: string;
  status?: string;
  uid?: string;
  url?: string;
  sourceChecksum?: string;
};

export type DashboardOpenHandler = (action: DashboardAction) => void;

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
    return <pre className={styles.toolCallJson}>{formatJson(content)}</pre>;
  }

  return (
    <>
      {content.map((block, index) => {
        if (!block || typeof block !== 'object') {
          return (
            <pre className={styles.toolCallJson} key={index}>
              {formatJson(block)}
            </pre>
          );
        }
        const typedBlock = block as Record<string, any>;
        if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
          return markdown ? (
            <MarkdownText isStreaming={isStreaming} key={index} text={typedBlock.text} />
          ) : (
            <div key={index}>{typedBlock.text}</div>
          );
        }
        if (typedBlock.type === 'thinking' && typeof typedBlock.thinking === 'string') {
          return (
            <details className={styles.collapsible} key={index}>
              <summary>Thinking</summary>
              <pre>{typedBlock.thinking}</pre>
            </details>
          );
        }
        if (typedBlock.type === 'toolCall' && typeof typedBlock.name === 'string') {
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
        return (
          <pre className={styles.toolCallJson} key={index}>
            {formatJson(typedBlock)}
          </pre>
        );
      })}
    </>
  );
}

export function ToolResultMessageBody({
  toolName,
  content,
  details,
  isError,
  onOpenDashboard,
}: {
  toolName?: string;
  content: unknown;
  details: unknown;
  isError?: boolean;
  onOpenDashboard?: DashboardOpenHandler;
}) {
  const styles = useStyles2(getToolStyles);
  const subagentDetails = asSubagentDetails(details);
  const artifactResult = isError ? undefined : asArtifactResult(details);
  const showArtifactCard = Boolean(artifactResult && !isArtifactReadResult(toolName, details));
  const structuredResult = isError
    ? undefined
    : renderStructuredToolResult(toolName, details, content, undefined, onOpenDashboard);
  const error = isError ? extractToolError(toolName, details, content) : undefined;

  if (subagentDetails) {
    return (
      <div className={cx(styles.toolFrame, subagentDetails.status === 'failed' && styles.toolFrameError)}>
        <ToolHeader name={toolName ?? subagentDetails.agent} status={subagentDetails.status} />
        {subagentDetails.status === 'failed' && <ToolErrorView error={extractToolError(toolName, details, content)} />}
        <SubagentResultView content={content} details={subagentDetails} />
        <SubagentDetailsView details={subagentDetails} onOpenDashboard={onOpenDashboard} />
      </div>
    );
  }

  return (
    <div className={cx(styles.toolFrame, isError && styles.toolFrameError)}>
      <ToolHeader name={toolName ?? 'tool'} status={isError ? 'failed' : 'completed'} />
      {showArtifactCard && artifactResult && (
        <ArtifactResultView artifact={artifactResult.ref} preview={artifactResult.preview} />
      )}
      {error ? (
        <ToolErrorView content={content} details={details} error={error} />
      ) : (
        (structuredResult ?? (!showArtifactCard ? <ContentBlocks content={content} /> : null))
      )}
      {!error && !structuredResult && !showArtifactCard && hasDetails(details) && (
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
        {runs.map((run) => {
          const subagentDetails = asSubagentDetails(run.partialResult?.details);
          return (
            <div className={styles.activityItem} key={run.id}>
              <ToolHeader name={run.name} status={run.status} compact />
              {subagentDetails ? (
                <SubagentDetailsView details={subagentDetails} compact />
              ) : (
                <>
                  {renderStructuredToolCall(run.name, run.args, undefined, run.status === 'running') ?? (
                    <pre className={styles.toolCallJson}>{formatJson(run.args)}</pre>
                  )}
                  {run.partialResult && <ContentBlocks content={run.partialResult.content} isStreaming />}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MarkdownText({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const styles = useStyles2(getToolStyles);
  const html = useMemo(
    () => hardenMarkdownHtml(renderMarkdown(completeOpenMarkdownFences(text), { breaks: true }).trim()),
    [text]
  );

  return (
    <div className={styles.markdown}>
      {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : isStreaming ? null : <span />}
      {isStreaming && <span className={styles.streamingCursor} aria-hidden="true" />}
    </div>
  );
}

// Grafana's markdown sanitizer blocks scripts but still allows remote images and
// sandboxed iframes, both zero-click exfiltration channels for prompt-injected
// model output. Keep only inline data-URI images.
function hardenMarkdownHtml(html: string): string {
  if (!html || typeof document === 'undefined') {
    return html;
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  for (const iframe of Array.from(template.content.querySelectorAll('iframe'))) {
    iframe.remove();
  }
  for (const image of Array.from(template.content.querySelectorAll('img'))) {
    const src = image.getAttribute('src')?.trim().toLowerCase() ?? '';
    if (!src.startsWith('data:image/')) {
      image.remove();
    }
  }
  return template.innerHTML;
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
  const icon = toolIconName(name);
  const shouldCollapse = shouldCollapseToolCallBlock(name, Boolean(isStreaming));
  const collapsedSummary = toolCallCollapsedSummary(name, args, partialJson, Boolean(isStreaming));

  if (shouldCollapse) {
    return (
      <details className={styles.toolCallCollapsed}>
        <summary className={styles.toolCallCollapsedSummary}>
          <Badge text="tool call" color="blue" />
          {icon && <Icon aria-hidden className={styles.toolTypeIcon} name={icon} />}
          <strong>{name}</strong>
          {collapsedSummary && <span className={styles.toolCallSummaryText}>{collapsedSummary}</span>}
        </summary>
        <div className={styles.toolCallCollapsedBody}>
          {structuredToolCall ?? (
            <pre className={styles.toolCallJson}>{partialJson && isStreaming ? partialJson : formatJson(args)}</pre>
          )}
        </div>
      </details>
    );
  }

  return (
    <div className={styles.toolCall}>
      <div className={styles.toolCallHeader}>
        <Badge text={isStreaming ? 'preparing' : 'tool call'} color="blue" />
        {icon && <Icon aria-hidden className={styles.toolTypeIcon} name={icon} />}
        <strong>{name}</strong>
      </div>
      {structuredToolCall ?? (
        <pre className={styles.toolCallJson}>{partialJson && isStreaming ? partialJson : formatJson(args)}</pre>
      )}
    </div>
  );
}

function shouldCollapseToolCallBlock(name: string, isStreaming: boolean) {
  return !isStreaming && WORKSPACE_TOOL_NAMES.has(name);
}

function toolCallCollapsedSummary(name: string, args: unknown, partialJson: string | undefined, isStreaming: boolean) {
  const simpleCall = asSimpleToolCallSummary(name, args, partialJson, isStreaming);
  return simpleCall?.summary;
}

function renderStructuredToolCall(
  name: string,
  args: unknown,
  partialJson: string | undefined,
  isStreaming: boolean
): React.ReactNode | undefined {
  const prometheusQuery = asPrometheusQueryToolCall(name, args, partialJson, isStreaming);
  if (prometheusQuery) {
    return <PrometheusQueryToolCallView call={prometheusQuery} />;
  }

  const simpleCall = asSimpleToolCallSummary(name, args, partialJson, isStreaming);
  if (simpleCall) {
    return <SimpleToolCallSummaryView call={simpleCall} />;
  }

  const jsonnetWrite = asJsonnetWriteToolCall(name, args, partialJson, isStreaming);
  if (jsonnetWrite) {
    return <JsonnetWriteToolCallView call={jsonnetWrite} />;
  }

  return undefined;
}

type PrometheusQueryToolCall = {
  datasourceUid?: string;
  queries: PrometheusQueryToolCallQuery[];
  partial: boolean;
};

type PrometheusQueryToolCallQuery = {
  query: string;
  type: string;
  start?: string;
  end?: string;
  interval?: string;
};

function PrometheusQueryToolCallView({ call }: { call: PrometheusQueryToolCall }) {
  const styles = useStyles2(getToolStyles);
  const commonType = commonPrometheusQueryToolCallType(call.queries);
  const commonRange = commonPrometheusQueryToolCallRange(call.queries);
  const queryCount = call.queries.length;
  const querySummary = commonType
    ? `${formatCount(queryCount)} ${commonType} ${queryCount === 1 ? 'query' : 'queries'}`
    : `${formatCount(queryCount)} queries`;
  const summaryParts = [
    querySummary,
    commonRange,
    call.datasourceUid ? `datasource ${call.datasourceUid}` : 'default datasource',
    call.partial ? 'streaming' : undefined,
  ].filter(Boolean);

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summaryParts.join(' | ')}</div>
      <div className={styles.prometheusQueryPlanList}>
        {call.queries.map((query, index) => (
          <div className={styles.prometheusQueryPlanRow} key={`${index}:${query.query}`}>
            <span className={styles.prometheusQueryPlanIndex}>Query {index + 1}</span>
            <span className={styles.prometheusQueryPlanMeta}>{formatPrometheusQueryToolCallMeta(query)}</span>
            <code className={styles.prometheusQueryPlanExpression} title={query.query}>
              {query.query}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

function asPrometheusQueryToolCall(
  name: string,
  args: unknown,
  partialJson: string | undefined,
  isStreaming: boolean
): PrometheusQueryToolCall | undefined {
  if (name !== 'query_prometheus' && name !== 'query_prometheus_raw') {
    return undefined;
  }

  const partial = partialJson ? prometheusQueryToolCallFromPartialJson(partialJson) : undefined;
  const complete = prometheusQueryToolCallFromArgs(args, false);
  if (partial && (isStreaming || !complete)) {
    return partial;
  }
  return complete;
}

function prometheusQueryToolCallFromPartialJson(partialJson: string): PrometheusQueryToolCall | undefined {
  try {
    return prometheusQueryToolCallFromArgs(JSON.parse(partialJson), true);
  } catch {
    const query = partialJsonStringField(partialJson, 'query') ?? partialJsonStringField(partialJson, 'expr');
    if (query === undefined) {
      return undefined;
    }

    const start = partialJsonStringField(partialJson, 'start') ?? partialJsonStringField(partialJson, 'from');
    const end = partialJsonStringField(partialJson, 'end') ?? partialJsonStringField(partialJson, 'to');
    return {
      datasourceUid: partialJsonStringField(partialJson, 'datasourceUid'),
      queries: [
        {
          query,
          type:
            partialJsonStringField(partialJson, 'type') ??
            partialJsonStringField(partialJson, 'queryType') ??
            (start || end ? 'range' : 'instant'),
          start,
          end,
          interval: partialJsonStringField(partialJson, 'interval') ?? partialJsonStringField(partialJson, 'step'),
        },
      ],
      partial: true,
    };
  }
}

function prometheusQueryToolCallFromArgs(args: unknown, partial: boolean): PrometheusQueryToolCall | undefined {
  if (!isRecord(args)) {
    return undefined;
  }

  const queryRecords = recordsField(args, 'queries');
  const queries =
    queryRecords.length > 0
      ? queryRecords
          .map((queryRecord) => prometheusQueryToolCallQueryFromRecord(queryRecord, args))
          .filter((query): query is PrometheusQueryToolCallQuery => Boolean(query))
      : [prometheusQueryToolCallQueryFromRecord(args, args)].filter((query): query is PrometheusQueryToolCallQuery =>
          Boolean(query)
        );

  if (queries.length === 0) {
    return undefined;
  }

  return {
    datasourceUid: stringField(args, 'datasourceUid'),
    queries,
    partial,
  };
}

function prometheusQueryToolCallQueryFromRecord(
  record: Record<string, unknown>,
  defaults: Record<string, unknown>
): PrometheusQueryToolCallQuery | undefined {
  const query = stringField(record, 'query') ?? stringField(record, 'expr');
  if (!query) {
    return undefined;
  }

  const range = recordField(record, 'range');
  const rawRange = recordField(range, 'raw');
  const defaultRange = recordField(defaults, 'range');
  const defaultRawRange = recordField(defaultRange, 'raw');
  const start =
    stringField(record, 'start') ??
    stringField(record, 'from') ??
    stringField(range, 'from') ??
    stringField(rawRange, 'from') ??
    stringField(defaults, 'start') ??
    stringField(defaults, 'from') ??
    stringField(defaultRange, 'from') ??
    stringField(defaultRawRange, 'from');
  const end =
    stringField(record, 'end') ??
    stringField(record, 'to') ??
    stringField(range, 'to') ??
    stringField(rawRange, 'to') ??
    stringField(defaults, 'end') ??
    stringField(defaults, 'to') ??
    stringField(defaultRange, 'to') ??
    stringField(defaultRawRange, 'to');
  const type =
    stringField(record, 'type') ??
    stringField(record, 'queryType') ??
    stringField(defaults, 'type') ??
    stringField(defaults, 'queryType') ??
    (start || end ? 'range' : 'instant');

  return {
    query,
    type,
    start,
    end,
    interval: stringField(record, 'interval') ?? stringField(record, 'step') ?? stringField(defaults, 'interval'),
  };
}

function commonPrometheusQueryToolCallType(queries: PrometheusQueryToolCallQuery[]) {
  const firstType = queries[0]?.type;
  return firstType && queries.every((query) => query.type === firstType) ? firstType : undefined;
}

function commonPrometheusQueryToolCallRange(queries: PrometheusQueryToolCallQuery[]) {
  const firstRange = formatPrometheusQueryToolCallRange(queries[0]);
  return firstRange && queries.every((query) => formatPrometheusQueryToolCallRange(query) === firstRange)
    ? firstRange
    : undefined;
}

function formatPrometheusQueryToolCallMeta(query: PrometheusQueryToolCallQuery) {
  return [query.type, formatPrometheusQueryToolCallRange(query), query.interval].filter(Boolean).join(' | ');
}

function formatPrometheusQueryToolCallRange(query: PrometheusQueryToolCallQuery | undefined) {
  if (!query) {
    return undefined;
  }
  if (query.start && query.end) {
    return `${query.start} -> ${query.end}`;
  }
  if (query.start) {
    return `from ${query.start}`;
  }
  if (query.end) {
    return `to ${query.end}`;
  }
  return undefined;
}

type SimpleToolCallSummary = {
  summary: string;
  items?: Array<{ label: string; value?: React.ReactNode }>;
  code?: string;
};

function SimpleToolCallSummaryView({ call }: { call: SimpleToolCallSummary }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{call.summary}</div>
      {call.items && <ResultMetaGrid items={call.items} />}
      {call.code && <pre className={styles.queryBlock}>{call.code}</pre>}
    </div>
  );
}

function asSimpleToolCallSummary(
  name: string,
  args: unknown,
  partialJson: string | undefined,
  isStreaming: boolean
): SimpleToolCallSummary | undefined {
  const record = toolCallArgsRecord(args, partialJson, isStreaming) ?? {};

  switch (name) {
    case 'list_datasources':
    case 'grafana_get_datasources':
      return { summary: 'Discover Prometheus datasources' };
    case 'list_metrics':
      return listMetricsToolCallSummary(record);
    case 'list_label_values':
      return labelValuesToolCallSummary(record);
    case 'inspect_metric_series':
      return inspectMetricSeriesToolCallSummary(record);
    case 'run_query_agent':
      return specialistToolCallSummary('query agent', record, [
        { label: 'Task', key: 'task' },
        { label: 'Datasource', key: 'datasourceUid' },
        { label: 'Metric prefix', key: 'metricPrefix' },
      ]);
    case 'run_dashboard_agent':
      return specialistToolCallSummary('dashboard agent', record, [
        { label: 'Task', key: 'task' },
        { label: 'Intent', key: 'intent' },
        { label: 'Datasource', key: 'datasourceUid' },
        { label: 'Dashboard', key: 'existingDashboardUid' },
      ]);
    case 'run_investigation_agent':
      return specialistToolCallSummary('investigation agent', record, [
        { label: 'Task', key: 'task' },
        { label: 'Datasource', key: 'datasourceUid' },
        { label: 'Time range', key: 'timeRange' },
      ]);
    case 'run_alert_agent':
      return specialistToolCallSummary('alert agent', record, [
        { label: 'Task', key: 'task' },
        { label: 'Datasource', key: 'datasourceUid' },
        { label: 'Dashboard', key: 'dashboardUid' },
        { label: 'Panel', key: 'panelId' },
        { label: 'Time range', key: 'timeRange' },
      ]);
    case 'run_support_agent':
      return specialistToolCallSummary('support agent', record, [
        { label: 'Task', key: 'task' },
        { label: 'Audience', key: 'audience' },
      ]);
    case 'run_navigation_agent':
      return specialistToolCallSummary('navigation agent', record, [
        { label: 'Task', key: 'task' },
        { label: 'Destination', key: 'destinationHint' },
      ]);
    case 'navigate':
      return navigateToolCallSummary(record);
    case 'update_report':
      return updateReportToolCallSummary(record);
    case 'read_artifact':
      return readArtifactToolCallSummary(record);
    case 'workspace_info':
      return { summary: 'Inspect workspace' };
    case 'ls':
      return workspacePathToolCallSummary('List workspace files', record);
    case 'find':
      return workspacePathToolCallSummary('Find workspace files', record, 'pattern');
    case 'grep':
      return workspaceGrepToolCallSummary(record);
    case 'read':
      return workspaceReadToolCallSummary(record);
    case 'edit':
      return workspaceEditToolCallSummary(record);
    case 'write':
      return workspaceWriteToolCallSummary(record);
    case 'get_schema':
      return workspaceSchemaToolCallSummary(record);
    case 'validate_workspace':
      return { summary: 'Validate workspace overlay' };
    case 'preview_diff':
      return { summary: 'Preview workspace diff' };
    case 'save_changes':
      return { summary: 'Save workspace changes' };
    case 'bash':
      return workspaceBashToolCallSummary(record);
    case 'upsert_resource':
      return workspaceSemanticToolCallSummary('Create or update resource', record);
    case 'list_dashboards':
    case 'grafana_list_dashboards':
      return { summary: 'List dashboards' };
    case 'get_dashboard':
    case 'grafana_get_dashboard':
      return dashboardToolCallSummary('Get dashboard', record);
    case 'inspect_dashboard_context':
      return dashboardToolCallSummary('Inspect dashboard context', record);
    case 'inspect_dashboard_metric_usage':
      return dashboardToolCallSummary('Inspect dashboard metric usage', record);
    case 'find_panel_alert_rules':
      return findPanelAlertRulesToolCallSummary(record);
    case 'get_alert_rule':
      return getAlertRuleToolCallSummary(record);
    case 'search_dashboard_metric_usage':
      return dashboardMetricSearchToolCallSummary(record);
    case 'get_metric_neighborhood':
      return metricNeighborhoodToolCallSummary(record);
    case 'list_live_dashboard_panels':
      return liveDashboardToolCallSummary('List live dashboard panels', record);
    case 'get_live_dashboard_layout':
      return liveDashboardToolCallSummary('Get live dashboard layout', record);
    case 'get_live_dashboard_info':
      return liveDashboardToolCallSummary('Get live dashboard info', record);
    case 'list_live_dashboard_variables':
      return liveDashboardToolCallSummary('List live dashboard variables', record);
    case 'get_live_dashboard_mutation_schema':
      return liveDashboardToolCallSummary('Get live dashboard mutation schema', record);
    case 'rename_live_dashboard_panel':
      return liveDashboardToolCallSummary('Rename live dashboard panel', record);
    case 'update_live_dashboard_panel_query':
      return liveDashboardToolCallSummary('Update live dashboard panel query', record);
    case 'add_live_dashboard_panel':
      return liveDashboardToolCallSummary('Add live dashboard panel', record);
    case 'move_or_resize_live_dashboard_panel':
      return liveDashboardToolCallSummary('Move or resize live dashboard panel', record);
    case 'update_live_dashboard_settings':
      return liveDashboardToolCallSummary('Update live dashboard settings', record);
    case 'add_live_dashboard_variable':
      return liveDashboardToolCallSummary('Add live dashboard variable', record);
    case 'update_live_dashboard_variable':
      return liveDashboardToolCallSummary('Update live dashboard variable', record);
    case 'apply_live_dashboard_mutation':
      return liveDashboardToolCallSummary('Apply live dashboard mutation', record);
    case 'render_dashboard':
      return dashboardToolCallSummary('Render dashboard', record);
    case 'save_dashboard':
      return dashboardToolCallSummary('Save dashboard', record);
    case 'upload_dashboard':
    case 'grafana_upload_dashboard':
      return dashboardToolCallSummary('Upload dashboard', record);
    case 'delete_dashboard':
    case 'grafana_delete_dashboard':
      return dashboardToolCallSummary('Delete dashboard', record);
    case 'screenshot_dashboard':
    case 'grafana_screenshot':
      return screenshotDashboardToolCallSummary(record);
    case 'list_grafonnet':
    case 'list_jsonnet_libs':
      return { summary: 'List Jsonnet library files' };
    case 'search_grafonnet':
    case 'search_jsonnet_libs':
      return jsonnetSearchToolCallSummary(record);
    case 'read_grafonnet':
    case 'read_jsonnet_lib':
    case 'read_jsonnet':
    case 'grafana_read_jsonnet_file':
      return jsonnetPathToolCallSummary('Read Jsonnet source', record);
    case 'read_skill_resource':
      return readSkillResourceToolCallSummary(record);
    case 'edit_jsonnet':
    case 'grafana_edit_jsonnet_file':
      return jsonnetPathToolCallSummary('Edit Jsonnet source', record);
    case 'fix_jsonnet':
      return jsonnetPathToolCallSummary('Repair Jsonnet source', record);
    default:
      return undefined;
  }
}

function labelValuesToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const label = stringField(record, 'label') ?? stringField(record, 'labelName') ?? stringField(record, 'name');
  const selector = stringField(record, 'match') ?? stringField(record, 'selector') ?? stringField(record, 'metric');
  return {
    summary: summaryLine(['List label values', label ? `label ${label}` : undefined, formatDatasourceSummary(record)]),
    items: [
      { label: 'Label', value: label },
      { label: 'Datasource', value: formatDatasourceMetaValue(record) },
      { label: 'Selector', value: selector ? <code>{selector}</code> : undefined },
    ],
  };
}

function listMetricsToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const prefix = stringField(record, 'prefix');
  const prefixes = stringArrayField(record, 'prefixes') ?? [];
  const prefixSummary =
    prefixes.length > 0 ? `${formatCount(prefixes.length)} prefixes` : prefix ? `prefix ${prefix}` : undefined;
  const prefixCode = prefixes.length > 0 ? prefixes.join('\n') : prefix;

  return {
    summary: summaryLine(['List metric names', prefixSummary, formatDatasourceSummary(record)]),
    items: [
      { label: 'Datasource', value: formatDatasourceMetaValue(record) },
      {
        label: 'Prefixes',
        value: prefixCode ? <code>{prefixes.length > 0 ? prefixes.join(', ') : prefix}</code> : undefined,
      },
    ],
    code: prefixCode,
  };
}

function inspectMetricSeriesToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const selector = stringField(record, 'match') ?? stringField(record, 'selector') ?? stringField(record, 'metric');
  const selectors = stringArrayField(record, 'matches') ?? [];
  const selectorSummary =
    selectors.length > 0 ? `${formatCount(selectors.length)} selectors` : selector ? 'selector provided' : undefined;
  const selectorCode = selectors.length > 0 ? selectors.join('\n') : selector;

  return {
    summary: summaryLine(['Inspect metric series', selectorSummary, formatDatasourceSummary(record)]),
    items: [
      { label: 'Datasource', value: formatDatasourceMetaValue(record) },
      {
        label: selectors.length > 0 ? 'Selectors' : 'Selector',
        value: selectorCode ? <code>{selectors.length > 0 ? selectors.join(', ') : selector}</code> : undefined,
      },
    ],
  };
}

function specialistToolCallSummary(
  label: string,
  record: Record<string, unknown>,
  fields: Array<{ label: string; key: string }>
): SimpleToolCallSummary {
  const datasourceUid = stringField(record, 'datasourceUid');
  const metricPrefix = stringField(record, 'metricPrefix');
  const intent = stringField(record, 'intent');
  const destinationHint = stringField(record, 'destinationHint');

  return {
    summary: summaryLine([
      `Run ${label}`,
      intent,
      metricPrefix ? `prefix ${metricPrefix}` : undefined,
      datasourceUid ? `datasource ${datasourceUid}` : undefined,
      destinationHint,
    ]),
    items: fields.map((field) => ({
      label: field.label,
      value: formatSummaryFieldValue(record, field.key),
    })),
  };
}

function navigateToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const type = stringField(record, 'type');
  const uid = stringField(record, 'uid');
  const path = stringField(record, 'path');
  const query = stringField(record, 'query');
  return {
    summary: summaryLine(['Navigate', type, uid ?? path ?? query]),
    items: [
      { label: 'Type', value: type },
      { label: 'Dashboard', value: uid ? <code>{uid}</code> : undefined },
      { label: 'Datasource', value: formatSummaryFieldValue(record, 'datasourceUid') },
      { label: 'Query', value: query ? <code>{query}</code> : undefined },
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
    ],
  };
}

function updateReportToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const patchCount = recordsField(record, 'patch').length;
  return {
    summary: summaryLine(['Update investigation report', stringField(record, 'title'), formatPatchCount(patchCount)]),
    items: [
      { label: 'Title', value: stringField(record, 'title') },
      { label: 'Patch count', value: patchCount > 0 ? formatCount(patchCount) : undefined },
    ],
  };
}

function readArtifactToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const id = stringField(record, 'id');
  const path = stringField(record, 'path');
  const jq = stringField(record, 'jq');
  const mode = stringField(record, 'mode') ?? (jq ? 'jq' : path ? 'field' : 'preview');
  const offset = numberField(record, 'offset');
  const limit = numberField(record, 'limit');

  return {
    summary: summaryLine(['Read artifact', id, mode]),
    items: [
      { label: 'Artifact', value: id ? <code>{id}</code> : undefined },
      { label: 'Mode', value: mode },
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      {
        label: 'Slice',
        value: offset !== undefined || limit !== undefined ? `${offset ?? 0}:${limit ?? ''}` : undefined,
      },
      { label: 'jq', value: jq ? <code>{jq}</code> : undefined },
    ],
    code: jq,
  };
}

function workspacePathToolCallSummary(
  action: string,
  record: Record<string, unknown>,
  selectorKey = 'path'
): SimpleToolCallSummary {
  const selector = stringField(record, selectorKey);
  const path = stringField(record, 'path');
  return {
    summary: action,
    items: [
      { label: selectorKey === 'pattern' ? 'Pattern' : 'Path', value: selector ? <code>{selector}</code> : undefined },
      { label: 'Path', value: selectorKey !== 'path' && path ? <code>{path}</code> : undefined },
    ],
  };
}

function workspaceGrepToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const pattern = stringField(record, 'pattern');
  const path = stringField(record, 'path');
  return {
    summary: 'Search workspace files',
    items: [
      { label: 'Pattern', value: pattern ? <code>{pattern}</code> : undefined },
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      { label: 'Case sensitive', value: booleanLabel(record, 'caseSensitive') },
    ],
  };
}

function workspaceReadToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const path = stringField(record, 'path');
  const offset = numberField(record, 'offset');
  const limit = numberField(record, 'limit');
  return {
    summary: 'Read workspace file',
    items: [
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      {
        label: 'Lines',
        value: offset !== undefined || limit !== undefined ? `${offset ?? 1}:${limit ?? ''}` : undefined,
      },
    ],
  };
}

function workspaceEditToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const path = stringField(record, 'path');
  const edits = recordsField(record, 'edits');
  return {
    summary: summaryLine(['Edit workspace file', edits.length ? formatPatchCount(edits.length) : undefined]),
    items: [
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      { label: 'Base version', value: formatSummaryFieldValue(record, 'baseVersion') },
      { label: 'Edits', value: edits.length ? formatCount(edits.length) : undefined },
    ],
  };
}

function workspaceWriteToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const path = stringField(record, 'path');
  const content = stringField(record, 'content');
  return {
    summary: summaryLine(['Write workspace file', content ? formatBytes(utf8ByteLength(content)) : undefined]),
    items: [
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      { label: 'Base version', value: formatSummaryFieldValue(record, 'baseVersion') },
      { label: 'Content', value: content ? formatBytes(utf8ByteLength(content)) : undefined },
    ],
  };
}

function workspaceSchemaToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const schemaId = stringField(record, 'schemaId');
  const path = stringField(record, 'path');
  return {
    summary: 'Read workspace schema',
    items: [
      { label: 'Schema', value: schemaId ? <code>{schemaId}</code> : undefined },
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
    ],
  };
}

function workspaceBashToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const command = stringField(record, 'command');
  return {
    summary: 'Run workspace bash',
    items: [
      { label: 'Timeout', value: stringOrNumberField(record, 'timeoutMs') },
      { label: 'Stdin', value: stringField(record, 'stdin') ? 'provided' : undefined },
    ],
    code: command,
  };
}

function workspaceSemanticToolCallSummary(action: string, record: Record<string, unknown>): SimpleToolCallSummary {
  const schemaId = stringField(record, 'schemaId');
  const resourceName = stringField(record, 'resourceName') ?? stringField(record, 'name');
  return {
    summary: action,
    items: [
      { label: 'Schema', value: schemaId ? <code>{schemaId}</code> : undefined },
      { label: 'Resource', value: resourceName ? <code>{resourceName}</code> : undefined },
      { label: 'Document', value: record.document !== undefined ? formatShortValue(record.document) : undefined },
    ],
    code: record.document !== undefined ? formatJson(record.document) : undefined,
  };
}

function formatSummaryFieldValue(record: Record<string, unknown>, key: string) {
  const value = stringOrNumberField(record, key);
  return value ? <code>{value}</code> : undefined;
}

function formatPatchCount(count: number) {
  return count > 0 ? `${formatCount(count)} ${count === 1 ? 'patch' : 'patches'}` : undefined;
}

function dashboardToolCallSummary(action: string, record: Record<string, unknown>): SimpleToolCallSummary {
  const dashboard = dashboardToolCallIdentifier(record);
  const path = stringField(record, 'path') ?? stringField(record, 'file');
  const folder =
    stringField(record, 'folderUid') ?? stringField(record, 'folder') ?? stringField(record, 'folderTitle');
  return {
    summary: summaryLine([action, dashboard]),
    items: [
      { label: 'Dashboard', value: dashboard ? <code>{dashboard}</code> : undefined },
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      { label: 'Folder', value: folder },
      { label: 'Panel', value: stringOrNumberField(record, 'panelId') },
      { label: 'Dry run', value: booleanLabel(record, 'dryRun') },
    ],
  };
}

function dashboardMetricSearchToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const query = stringField(record, 'query');
  const tag = stringField(record, 'tag');
  const seed = stringField(record, 'seedMetric');
  const seeds = stringArrayField(record, 'seedMetrics') ?? [];
  const seedCode = seeds.length > 0 ? seeds.join('\n') : seed;

  return {
    summary: summaryLine(['Search dashboard metric usage', query, tag ? `tag ${tag}` : undefined]),
    items: [
      { label: 'Query', value: query },
      { label: 'Tag', value: tag },
      { label: 'Datasource', value: formatDatasourceMetaValue(record) },
      {
        label: seeds.length > 0 ? 'Seed metrics' : 'Seed metric',
        value: seedCode ? <code>{seedCode}</code> : undefined,
      },
      { label: 'Max dashboards', value: stringOrNumberField(record, 'maxDashboards') },
    ],
    code: seedCode,
  };
}

function findPanelAlertRulesToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const dashboardUid = stringField(record, 'dashboardUid');
  const panelId = stringOrNumberField(record, 'panelId');
  const panelTitle = stringField(record, 'panelTitle');
  const ruleName = stringField(record, 'ruleName');
  const query = stringField(record, 'query');
  const namespace = stringField(record, 'namespace');

  return {
    summary: summaryLine([
      'Find panel alert rules',
      dashboardUid ? `dashboard ${dashboardUid}` : undefined,
      panelId ? `panel ${panelId}` : panelTitle,
      ruleName ? `rule ${ruleName}` : query,
    ]),
    items: [
      { label: 'Dashboard', value: dashboardUid ? <code>{dashboardUid}</code> : undefined },
      { label: 'Panel', value: panelId },
      { label: 'Panel title', value: panelTitle },
      { label: 'Rule', value: ruleName ? <code>{ruleName}</code> : undefined },
      { label: 'Query', value: query },
      { label: 'Namespace', value: namespace ? <code>{namespace}</code> : undefined },
      { label: 'Max rules', value: stringOrNumberField(record, 'maxRules') },
    ],
  };
}

function getAlertRuleToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const name = stringField(record, 'name');
  const namespace = stringField(record, 'namespace');
  return {
    summary: summaryLine(['Get alert rule', name, namespace ? `namespace ${namespace}` : undefined]),
    items: [
      { label: 'Rule', value: name ? <code>{name}</code> : undefined },
      { label: 'Namespace', value: namespace ? <code>{namespace}</code> : undefined },
    ],
  };
}

function metricNeighborhoodToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const metric = stringField(record, 'metric');
  const metrics = stringArrayField(record, 'metrics') ?? [];
  const seedCode = metrics.length > 0 ? metrics.join('\n') : metric;

  return {
    summary: summaryLine([
      'Get metric neighborhood',
      metric ?? (metrics.length > 0 ? `${metrics.length} seeds` : undefined),
    ]),
    items: [
      {
        label: metrics.length > 0 ? 'Seed metrics' : 'Seed metric',
        value: seedCode ? <code>{seedCode}</code> : undefined,
      },
      { label: 'Dashboard', value: formatSummaryFieldValue(record, 'dashboardUid') },
      { label: 'Query', value: stringField(record, 'query') },
      { label: 'Datasource', value: formatDatasourceMetaValue(record) },
      { label: 'Max results', value: stringOrNumberField(record, 'maxResults') },
    ],
    code: seedCode,
  };
}

function liveDashboardToolCallSummary(action: string, record: Record<string, unknown>): SimpleToolCallSummary {
  const query = stringField(record, 'queryExpression') ?? stringField(record, 'query');
  const command = stringField(record, 'type') ?? stringField(record, 'command');
  const element = stringField(record, 'elementName');
  const elements = liveDashboardElementsSummary(record);
  const title = stringField(record, 'title');
  const variable = stringField(record, 'name');
  const code = liveDashboardToolCallCode(record);
  return {
    summary: summaryLine([action, element ?? elements ?? title ?? variable ?? command]),
    items: [
      { label: 'Command', value: command },
      { label: 'Element', value: formatSummaryFieldValue(record, 'elementName') },
      { label: 'Elements', value: elements ? <code>{elements}</code> : undefined },
      { label: 'Title', value: title },
      { label: 'Description', value: stringField(record, 'description') },
      { label: 'Variable', value: variable ? <code>{variable}</code> : undefined },
      { label: 'New variable', value: formatSummaryFieldValue(record, 'newName') },
      { label: 'Visualization', value: stringField(record, 'visualizationType') },
      { label: 'Variable type', value: stringField(record, 'variableType') },
      { label: 'Parent path', value: formatSummaryFieldValue(record, 'parentPath') },
      { label: 'Datasource', value: liveDashboardDatasourceSummary(record) },
      { label: 'Ref ID', value: formatSummaryFieldValue(record, 'refId') },
      { label: 'Hidden', value: booleanLabel(record, 'hidden') },
      { label: 'Query', value: query ? <code>{query}</code> : undefined },
      { label: 'Unit', value: formatSummaryFieldValue(record, 'unit') },
      { label: 'Grid', value: liveDashboardGridSummary(record) },
      { label: 'Time range', value: liveDashboardTimeRangeSummary(record) },
      { label: 'Refresh', value: stringField(record, 'autoRefresh') },
      { label: 'Timezone', value: stringField(record, 'timezone') },
      { label: 'Cursor sync', value: stringField(record, 'cursorSync') },
      { label: 'Editable', value: booleanLabel(record, 'editable') },
      { label: 'Live now', value: booleanLabel(record, 'liveNow') },
      { label: 'Preload', value: booleanLabel(record, 'preload') },
      { label: 'Current', value: stringField(record, 'current') },
      { label: 'Position', value: stringOrNumberField(record, 'position') },
      { label: 'Multi', value: booleanLabel(record, 'multi') },
      { label: 'Include all', value: booleanLabel(record, 'includeAll') },
      { label: 'Tags', value: stringArraySummary(record, 'tags') },
      { label: 'Options', value: stringArraySummary(record, 'options') },
      { label: 'Evaluate variables', value: booleanLabel(record, 'evaluateVariables') },
      { label: 'Include status', value: booleanLabel(record, 'includeStatus') },
    ],
    code,
  };
}

function liveDashboardElementsSummary(record: Record<string, unknown>) {
  const elements = stringArrayField(record, 'elements');
  return elements?.length ? elements.join(', ') : undefined;
}

function liveDashboardDatasourceSummary(record: Record<string, unknown>) {
  const datasourceType = stringField(record, 'datasourceType');
  const datasourceName = stringField(record, 'datasourceName');
  if (datasourceType && datasourceName) {
    return `${datasourceType}/${datasourceName}`;
  }
  return datasourceName ?? datasourceType;
}

function liveDashboardGridSummary(record: Record<string, unknown>) {
  const fields = ['x', 'y', 'width', 'height']
    .map((key) => {
      const value = stringOrNumberField(record, key);
      return value ? `${key} ${value}` : undefined;
    })
    .filter(Boolean);
  return fields.length > 0 ? fields.join(', ') : undefined;
}

function liveDashboardTimeRangeSummary(record: Record<string, unknown>) {
  const from = stringField(record, 'from');
  const to = stringField(record, 'to');
  if (from && to) {
    return `${from} -> ${to}`;
  }
  return from ?? to;
}

function stringArraySummary(record: Record<string, unknown>, key: string) {
  const values = stringArrayField(record, key);
  return values?.length ? values.join(', ') : undefined;
}

function liveDashboardToolCallCode(record: Record<string, unknown>) {
  if (record.payload !== undefined) {
    return formatJson(record.payload);
  }
  if (record.querySpec !== undefined) {
    return formatJson(record.querySpec);
  }
  return undefined;
}

function screenshotDashboardToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const dashboard = dashboardToolCallIdentifier(record);
  const width = numberField(record, 'width');
  const height = numberField(record, 'height');
  return {
    summary: summaryLine(['Capture dashboard screenshot', dashboard]),
    items: [
      { label: 'Dashboard', value: dashboard ? <code>{dashboard}</code> : undefined },
      { label: 'Panel', value: stringOrNumberField(record, 'panelId') },
      { label: 'Size', value: width && height ? `${width} x ${height}` : undefined },
    ],
  };
}

function jsonnetSearchToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const query =
    stringField(record, 'query') ??
    stringField(record, 'pattern') ??
    stringField(record, 'search') ??
    stringField(record, 'term');
  return {
    summary: summaryLine(['Search Jsonnet libraries', query]),
    items: [
      { label: 'Query', value: query ? <code>{query}</code> : undefined },
      { label: 'Base path', value: stringField(record, 'basePath') },
    ],
    code: query,
  };
}

function jsonnetPathToolCallSummary(action: string, record: Record<string, unknown>): SimpleToolCallSummary {
  const path = jsonnetToolCallPath(record);
  const lineRange = formatToolCallLineRange(record);
  const instructions =
    stringField(record, 'instructions') ?? stringField(record, 'prompt') ?? stringField(record, 'description');
  return {
    summary: summaryLine([action, path]),
    items: [
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      { label: 'Lines', value: lineRange },
      { label: 'Instructions', value: instructions },
    ],
  };
}

function readSkillResourceToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const skill = stringField(record, 'skill');
  const path = stringField(record, 'path');
  return {
    summary: summaryLine(['Read skill resource', skill, path]),
    items: [
      { label: 'Skill', value: skill ? <code>{skill}</code> : undefined },
      { label: 'Resource', value: path ? <code>{path}</code> : undefined },
    ],
  };
}

function toolCallArgsRecord(
  args: unknown,
  partialJson: string | undefined,
  isStreaming: boolean
): Record<string, unknown> | undefined {
  if (isStreaming && partialJson) {
    try {
      const parsed = JSON.parse(partialJson);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      return isRecord(args) ? args : undefined;
    }
  }

  return isRecord(args) ? args : undefined;
}

function formatDatasourceSummary(record: Record<string, unknown>) {
  const datasourceUid = stringField(record, 'datasourceUid');
  return datasourceUid ? `datasource ${datasourceUid}` : 'default datasource';
}

function formatDatasourceMetaValue(record: Record<string, unknown>) {
  return stringField(record, 'datasourceUid') ?? 'default';
}

function dashboardToolCallIdentifier(record: Record<string, unknown>) {
  return (
    stringField(record, 'uid') ??
    stringField(record, 'dashboardUid') ??
    stringField(record, 'name') ??
    stringField(record, 'title')
  );
}

function jsonnetToolCallPath(record: Record<string, unknown>) {
  return (
    stringField(record, 'path') ??
    stringField(record, 'file') ??
    stringField(record, 'resource') ??
    stringField(record, 'uri')
  );
}

function formatToolCallLineRange(record: Record<string, unknown>) {
  const start = numberField(record, 'startLine') ?? numberField(record, 'line');
  const end = numberField(record, 'endLine');
  if (start !== undefined && end !== undefined && end !== start) {
    return `${start}-${end}`;
  }
  return start !== undefined ? String(start) : undefined;
}

function booleanLabel(record: Record<string, unknown>, key: string) {
  const value = booleanField(record, key);
  return value === undefined ? undefined : value ? 'yes' : 'no';
}

function summaryLine(parts: Array<string | undefined>) {
  return parts.filter(Boolean).join(' | ');
}

type JsonnetWriteToolCall = {
  path: string;
  content: string;
  partial: boolean;
};

const DEFAULT_TOOL_CALL_JSONNET_PATH = 'dashboard.jsonnet';

function JsonnetWriteToolCallView({ call }: { call: JsonnetWriteToolCall }) {
  const styles = useStyles2(getToolStyles);
  const lines = useMemo(() => (call.content ? textToCodeLines(call.content) : []), [call.content]);
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
  const icon = toolIconName(name);
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
      {icon && <Icon aria-hidden className={styles.toolTypeIcon} name={icon} />}
      <strong>{name}</strong>
    </div>
  );
}

type ToolErrorViewModel = {
  toolName?: string;
  message: string;
};

function ToolErrorView({
  error,
  details,
  content,
}: {
  error: ToolErrorViewModel;
  details?: unknown;
  content?: unknown;
}) {
  const styles = useStyles2(getToolStyles);
  const showDetails = hasDetails(details);
  const showContent = hasUsefulErrorContent(content, error.message);

  return (
    <div className={styles.errorCard} data-testid="tool-error">
      <div className={styles.errorTitle}>{error.toolName ? `${error.toolName} failed` : 'Tool failed'}</div>
      <div className={styles.errorMessage}>{error.message}</div>
      {(showDetails || showContent) && (
        <details className={styles.collapsible}>
          <summary>Details</summary>
          {showDetails && <pre className={styles.queryBlock}>{formatJson(details)}</pre>}
          {showContent && <pre className={styles.queryBlock}>{formatJson(content)}</pre>}
        </details>
      )}
    </div>
  );
}

function extractToolError(toolName: string | undefined, details: unknown, content: unknown): ToolErrorViewModel {
  const message =
    extractExplicitErrorMessage(details) ??
    extractErrorMessageFromText(extractToolText(content)) ??
    extractErrorMessage(content) ??
    'Tool failed without a readable error message.';

  return {
    toolName,
    message,
  };
}

function extractToolText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();

  return text || undefined;
}

function extractExplicitErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return extractErrorMessageFromText(extractToolText(value));
  }

  const record = value as Record<string, unknown>;
  for (const key of ['error', 'message', 'reason', 'detail', 'details']) {
    const message = extractErrorMessage(record[key]);
    if (message) {
      return message;
    }
  }

  return undefined;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return extractErrorMessageFromText(value);
  }
  if (!value || typeof value !== 'object') {
    // Non-string primitives like `false` or `0` are not readable error
    // messages; the raw details stay available in the Details section.
    return undefined;
  }
  if (Array.isArray(value)) {
    return extractErrorMessageFromText(extractToolText(value));
  }

  const record = value as Record<string, unknown>;
  for (const key of ['error', 'message', 'status', 'reason', 'detail', 'details']) {
    const nested = record[key];
    const message = extractErrorMessage(nested);
    if (message) {
      return message;
    }
  }

  return undefined;
}

function extractErrorMessageFromText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const message = extractErrorMessage(parsed);
    return message || trimmed;
  } catch {
    return trimmed;
  }
}

function hasUsefulErrorContent(content: unknown, message: string) {
  if (content === undefined || content === null) {
    return false;
  }
  const contentText = extractToolText(content);
  return !contentText || contentText.trim() !== message.trim();
}

const TOOL_ICONS: Record<string, IconName> = {
  list_datasources: 'database',
  grafana_get_datasources: 'database',
  list_metrics: 'list-ul',
  list_label_values: 'list-ul',
  inspect_metric_series: 'search',
  query_prometheus: 'gf-prometheus',
  query_prometheus_raw: 'gf-prometheus',
  run_query_agent: 'database',
  run_dashboard_agent: 'apps',
  run_investigation_agent: 'search',
  run_alert_agent: 'bell',
  run_support_agent: 'question-circle',
  run_navigation_agent: 'compass',
  navigate: 'compass',
  read_artifact: 'file-alt',
  workspace_info: 'folder-open',
  ls: 'list-ul',
  find: 'search',
  grep: 'search',
  read: 'file-alt',
  edit: 'file-edit-alt',
  write: 'file-edit-alt',
  get_schema: 'book',
  validate_workspace: 'check-circle',
  preview_diff: 'file-alt',
  save_changes: 'save',
  bash: 'brackets-curly',
  upsert_resource: 'upload',
  write_jsonnet: 'brackets-curly',
  grafana_write_jsonnet_file: 'brackets-curly',
  edit_jsonnet: 'file-edit-alt',
  grafana_edit_jsonnet_file: 'file-edit-alt',
  fix_jsonnet: 'bug',
  read_jsonnet: 'file-alt',
  grafana_read_jsonnet_file: 'file-alt',
  search_grafonnet: 'search',
  search_jsonnet_libs: 'search',
  read_grafonnet: 'book-open',
  read_jsonnet_lib: 'book-open',
  list_grafonnet: 'list-ul',
  list_jsonnet_libs: 'list-ul',
  list_dashboards: 'dashboard',
  grafana_list_dashboards: 'dashboard',
  get_dashboard: 'dashboard',
  grafana_get_dashboard: 'dashboard',
  inspect_dashboard_context: 'dashboard',
  inspect_dashboard_metric_usage: 'dashboard',
  find_panel_alert_rules: 'bell',
  get_alert_rule: 'bell',
  search_dashboard_metric_usage: 'search',
  get_metric_neighborhood: 'search',
  list_live_dashboard_panels: 'list-ul',
  get_live_dashboard_layout: 'dashboard',
  get_live_dashboard_info: 'dashboard',
  list_live_dashboard_variables: 'list-ul',
  get_live_dashboard_mutation_schema: 'book',
  rename_live_dashboard_panel: 'edit',
  update_live_dashboard_panel_query: 'search',
  add_live_dashboard_panel: 'plus',
  move_or_resize_live_dashboard_panel: 'dashboard',
  update_live_dashboard_settings: 'cog',
  add_live_dashboard_variable: 'plus',
  update_live_dashboard_variable: 'edit',
  apply_live_dashboard_mutation: 'dashboard',
  render_dashboard: 'dashboard',
  save_dashboard: 'save',
  upload_dashboard: 'upload',
  grafana_upload_dashboard: 'upload',
  delete_dashboard: 'trash-alt',
  grafana_delete_dashboard: 'trash-alt',
  screenshot_dashboard: 'camera',
  grafana_screenshot: 'camera',
  read_skill_resource: 'book',
};

function toolIconName(name: string): IconName | undefined {
  return TOOL_ICONS[name];
}

function SubagentResultView({ content, details }: { content: unknown; details: SubagentRunDetails }) {
  const styles = useStyles2(getToolStyles);
  const [isOpen, setIsOpen] = useState(false);
  return (
    <details className={styles.subagentResult} data-testid="subagent-result" open={isOpen}>
      <summary
        aria-expanded={isOpen}
        className={styles.subagentResultSummary}
        onClick={(event) => {
          event.preventDefault();
          setIsOpen((open) => !open);
        }}
      >
        <Icon aria-hidden className={styles.queryResultChevron} name={isOpen ? 'angle-down' : 'angle-right'} />
        <span>{subagentResultLabel(details)}</span>
      </summary>
      <div className={styles.subagentResultBody}>
        <ContentBlocks content={content} />
      </div>
    </details>
  );
}

function subagentResultLabel(details: SubagentRunDetails) {
  const agentLabel = subagentLabel(details.agent);
  if (details.status === 'failed') {
    return `${agentLabel} error`;
  }
  if (details.status === 'running') {
    return `${agentLabel} output`;
  }
  return `${agentLabel} result`;
}

function SubagentDetailsView({
  details,
  compact,
  onOpenDashboard,
}: {
  details: SubagentRunDetails;
  compact?: boolean;
  onOpenDashboard?: DashboardOpenHandler;
}) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.subagent}>
      <div className={styles.subagentMeta}>
        <span>{subagentLabel(details.agent)}</span>
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
        {details.toolCalls.map((call, index) => (
          <SubagentToolCallRow
            agent={details.agent}
            call={call}
            key={`${call.id}:${index}`}
            onOpenDashboard={onOpenDashboard}
          />
        ))}
      </div>
    </div>
  );
}

function subagentLabel(agent: SubagentRunDetails['agent']) {
  switch (agent) {
    case 'query':
      return 'Query agent';
    case 'dashboard':
      return 'Dashboard agent';
    case 'investigation':
      return 'Investigation agent';
    case 'alerts':
      return 'Alert agent';
    case 'support':
      return 'Support agent';
    case 'navigation':
      return 'Navigation agent';
    default:
      return 'Specialist agent';
  }
}

function SubagentToolCallRow({
  agent,
  call,
  onOpenDashboard,
}: {
  agent: SubagentRunDetails['agent'];
  call: SubagentToolCall;
  onOpenDashboard?: DashboardOpenHandler;
}) {
  const styles = useStyles2(getToolStyles);
  const shouldAutoOpen = shouldExpandSubagentToolCall(call, agent);
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined);
  const isOpen = manualOpen ?? shouldAutoOpen;
  const toolResult = call.result ?? call.partialResult;
  const resultContent = toolResult?.content ?? contentFromLegacyToolText(call.text);
  const resultDetails = toolResult?.details;
  const isStreaming = call.status === 'running';
  const artifactResult = call.isError ? undefined : asArtifactResult(resultDetails);
  const showArtifactCard = Boolean(artifactResult && !isArtifactReadResult(call.name, resultDetails));
  const error = call.isError ? extractToolError(call.name, resultDetails, resultContent) : undefined;

  return (
    <details className={cx(styles.toolStep, call.status === 'failed' && styles.toolStepError)} open={isOpen}>
      <summary
        aria-expanded={isOpen}
        onClick={(event) => {
          event.preventDefault();
          setManualOpen((open) => !(open ?? shouldAutoOpen));
        }}
      >
        <span>{call.status === 'running' ? 'Running' : call.status === 'failed' ? 'Failed' : 'Done'}</span>
        <strong>{call.name}</strong>
      </summary>
      {isOpen && (
        <div className={styles.toolStepBody}>
          {renderStructuredToolCall(call.name, call.args, undefined, isStreaming) ?? (
            <pre className={styles.toolCallJson}>{formatJson(call.args)}</pre>
          )}
          {(resultContent || error) && (
            <div className={cx(styles.toolStepResult, call.isError && styles.toolStepResultError)}>
              {showArtifactCard && artifactResult && (
                <ArtifactResultView artifact={artifactResult.ref} preview={artifactResult.preview} />
              )}
              {error ? (
                <ToolErrorView content={resultContent} details={resultDetails} error={error} />
              ) : (
                (renderStructuredToolResult(call.name, resultDetails, resultContent, call.args, onOpenDashboard) ??
                (!showArtifactCard ? (
                  <>
                    <ContentBlocks content={resultContent} isStreaming={isStreaming} />
                    {hasDetails(resultDetails) && (
                      <details className={styles.collapsible}>
                        <summary>Details</summary>
                        <pre>{formatJson(resultDetails)}</pre>
                      </details>
                    )}
                  </>
                ) : null))
              )}
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function shouldExpandSubagentToolCall(call: SubagentToolCall, agent: SubagentRunDetails['agent']) {
  return (
    call.status === 'failed' ||
    call.isError ||
    (agent === 'alerts' && call.status === 'completed' && !call.isError && ALERT_EVIDENCE_TOOL_NAMES.has(call.name)) ||
    (call.status === 'completed' && !call.isError && call.name === 'save_dashboard')
  );
}

const ALERT_EVIDENCE_TOOL_NAMES = new Set(['find_panel_alert_rules', 'get_alert_rule', 'query_prometheus']);

function contentFromLegacyToolText(text: string | undefined) {
  return text ? [{ type: 'text', text }] : undefined;
}

function renderStructuredToolResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown,
  args?: unknown,
  onOpenDashboard?: DashboardOpenHandler
): React.ReactNode | undefined {
  const artifactResult = asArtifactResult(details);
  const workspaceResult = asWorkspaceToolResult(toolName, details, content);
  if (workspaceResult) {
    return workspaceResult;
  }

  const artifactRead = asArtifactReadResult(toolName, details, content);
  if (artifactRead) {
    return <ArtifactReadResultView result={artifactRead} />;
  }

  const datasources = asDatasourceResult(toolName, details, content);
  if (datasources) {
    return <DatasourceResultView datasources={datasources} />;
  }

  const lineListBatch = asLineListBatchResult(toolName, details, content);
  if (lineListBatch) {
    return <LineListBatchResultView result={lineListBatch} />;
  }

  const lineList = asLineListResult(toolName, details, content);
  if (lineList) {
    return <LineListResultView result={lineList} />;
  }

  const metricSeries = asMetricSeriesInspection(toolName, details, content);
  if (metricSeries) {
    return <MetricSeriesInspectionView result={metricSeries} />;
  }

  const metricSeriesBatch = asMetricSeriesInspectionBatch(toolName, details, content);
  if (metricSeriesBatch) {
    return <MetricSeriesInspectionBatchView result={metricSeriesBatch} />;
  }

  const prometheusBatchQuery = asPrometheusBatchQuerySummary(toolName, details, content, args);
  if (prometheusBatchQuery) {
    return <PrometheusBatchQueryResultView result={prometheusBatchQuery} />;
  }

  const prometheusQuery = asPrometheusQuerySummary(toolName, details, content, args);
  if (prometheusQuery) {
    return (
      <PrometheusQueryResultView
        result={prometheusQuery}
        visualization={
          prometheusQuery.visualization ??
          asPrometheusTimeseriesVisualization(toolName, details) ??
          prometheusTimeseriesVisualizationFromSummary(prometheusQuery)
        }
      />
    );
  }

  const rawPrometheusQuery = asRawPrometheusQuery(toolName, details);
  if (rawPrometheusQuery) {
    return <RawPrometheusQueryResultView content={artifactResult ? undefined : content} result={rawPrometheusQuery} />;
  }

  const alertRuleMatches = asAlertRuleMatchesResult(toolName, details, content);
  if (alertRuleMatches) {
    return <AlertRuleMatchesResultView result={alertRuleMatches} />;
  }

  const alertRule = asAlertRuleResult(toolName, details, content);
  if (alertRule) {
    return <AlertRuleResultView result={alertRule} />;
  }

  const screenshot = asScreenshotResult(toolName, details);
  if (screenshot) {
    return <ScreenshotResultView content={artifactResult ? undefined : content} result={screenshot} />;
  }

  const skillResource = asSkillResourceReadResult(toolName, details, content);
  if (skillResource) {
    return <SkillResourceReadResultView result={skillResource} />;
  }

  const liveSchema = asLiveDashboardMutationSchemaResult(toolName, details, content);
  if (liveSchema) {
    return <LiveDashboardMutationSchemaResultView result={liveSchema} />;
  }

  const liveMutation = asLiveDashboardMutationResult(toolName, details);
  if (liveMutation) {
    return <LiveDashboardMutationResultView result={liveMutation} />;
  }

  const dashboardList = asDashboardList(toolName, details, content);
  if (dashboardList) {
    return <DashboardListView result={dashboardList} />;
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
    return <DashboardActionView action={action} onOpenDashboard={onOpenDashboard} />;
  }

  return undefined;
}

type ArtifactReadResult = {
  artifact?: ArtifactRef;
  mode?: string;
  path?: string;
  jq?: string;
  exitCode?: number;
  truncated?: boolean;
  text?: string;
  emptyKind?: 'null' | 'undefined';
  json?: unknown;
};

function ArtifactReadResultView({ result }: { result: ArtifactReadResult }) {
  const styles = useStyles2(getToolStyles);
  const summary = summaryLine([
    'Artifact read',
    result.mode,
    result.artifact?.title,
    result.truncated ? 'truncated' : undefined,
  ]);

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summary}</div>
      <ResultMetaGrid
        items={[
          { label: 'Artifact', value: result.artifact ? <code>{result.artifact.id}</code> : undefined },
          { label: 'Tool', value: result.artifact?.toolName },
          { label: 'Mode', value: result.mode },
          { label: 'Path', value: result.path ? <code>{result.path}</code> : undefined },
          { label: 'jq', value: result.jq ? <code>{result.jq}</code> : undefined },
          { label: 'Exit code', value: result.exitCode === undefined ? undefined : String(result.exitCode) },
          { label: 'Truncated', value: formatBoolean(result.truncated) },
        ]}
      />
      {result.emptyKind ? (
        <div className={styles.emptyState}>{artifactReadEmptyMessage(result)}</div>
      ) : result.json !== undefined ? (
        <ArtifactReadJsonView result={result} />
      ) : result.text ? (
        <ContentBlocks content={[{ type: 'text', text: result.text }]} />
      ) : (
        <div className={styles.emptyState}>Artifact read returned no output.</div>
      )}
    </div>
  );
}

function asArtifactReadResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): ArtifactReadResult | undefined {
  if (!isArtifactReadResult(toolName, details) || !isRecord(details)) {
    return undefined;
  }

  const text = extractToolText(content);
  const trimmed = text?.trim();
  return {
    artifact: asArtifactRef(recordField(details, 'artifactRef')),
    mode: stringField(details, 'mode'),
    path: stringField(details, 'path'),
    jq: stringField(details, 'jq'),
    exitCode: numberField(details, 'exitCode'),
    truncated: booleanField(details, 'truncated'),
    text,
    emptyKind: trimmed === 'null' || trimmed === 'undefined' ? trimmed : undefined,
    json: parseArtifactReadJson(trimmed),
  };
}

function parseArtifactReadJson(text: string | undefined): unknown {
  if (!text || text === 'null' || text === 'undefined') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function artifactReadEmptyMessage(result: ArtifactReadResult) {
  const selected = result.mode === 'jq' ? 'jq result' : 'Selected artifact field';
  return `${selected} is ${result.emptyKind}.`;
}

function ArtifactReadJsonView({ result }: { result: ArtifactReadResult }) {
  const styles = useStyles2(getToolStyles);
  const json = result.json;
  const isFullRead = result.mode === 'full';

  return (
    <div className={styles.jsonSummary}>
      {isRecord(json) && <ArtifactReadJsonSummary value={json} />}
      <details className={styles.collapsible} open={!isFullRead}>
        <summary>{isFullRead ? 'Full artifact JSON' : 'Artifact JSON'}</summary>
        <pre className={styles.queryBlock}>{formatJson(json)}</pre>
      </details>
    </div>
  );
}

function ArtifactReadJsonSummary({ value }: { value: Record<string, unknown> }) {
  const panels = liveDashboardPanelsFromArtifact(value);
  const command = stringField(value, 'command');
  const success = booleanField(value, 'success');
  const availableCommands = Array.isArray(value.availableCommands) ? value.availableCommands.length : undefined;

  return (
    <>
      <ResultMetaGrid
        items={[
          { label: 'Command', value: command },
          { label: 'Success', value: formatBoolean(success) },
          { label: 'Panels', value: panels ? formatCount(panels.length) : undefined },
          {
            label: 'Available commands',
            value: availableCommands === undefined ? undefined : formatCount(availableCommands),
          },
        ]}
      />
      {panels && panels.length > 0 && <ArtifactDashboardPanelsList panels={panels} />}
    </>
  );
}

type ArtifactDashboardPanelSummary = {
  title?: string;
  type?: string;
  grid?: string;
  queryCount?: number;
};

function ArtifactDashboardPanelsList({ panels }: { panels: ArtifactDashboardPanelSummary[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.queryResultList}>
      {panels.slice(0, 6).map((panel, index) => (
        <div className={styles.compactResult} key={`${panel.title ?? 'panel'}:${index}`}>
          <div className={styles.compactResultSummary}>
            <span className={styles.queryResultIndex}>{index + 1}</span>
            <span className={styles.compactResultText}>{panel.title ?? 'Untitled panel'}</span>
          </div>
          <div className={styles.compactResultBody}>
            <ResultMetaGrid
              items={[
                { label: 'Type', value: panel.type },
                { label: 'Grid', value: panel.grid },
                { label: 'Queries', value: panel.queryCount === undefined ? undefined : formatCount(panel.queryCount) },
              ]}
            />
          </div>
        </div>
      ))}
      {panels.length > 6 && (
        <div className={styles.emptyState}>{formatCount(panels.length - 6)} more panels hidden.</div>
      )}
    </div>
  );
}

function liveDashboardPanelsFromArtifact(value: Record<string, unknown>): ArtifactDashboardPanelSummary[] | undefined {
  const data = recordField(value, 'data');
  const elements = data ? recordsField(data, 'elements') : [];
  if (elements.length === 0) {
    return undefined;
  }

  return elements.map((entry) => {
    const element = recordField(entry, 'element');
    const spec = recordField(element, 'spec');
    const layoutItem = recordField(entry, 'layoutItem');
    const layoutSpec = recordField(layoutItem, 'spec');
    const queryGroup = recordField(recordField(spec, 'data'), 'spec');
    const queries = queryGroup ? recordsField(queryGroup, 'queries') : [];
    const vizConfig = recordField(spec, 'vizConfig');
    return {
      title: stringField(spec, 'title'),
      type: stringField(vizConfig, 'group'),
      grid: formatGridSummary(layoutSpec),
      queryCount: queries.length,
    };
  });
}

function formatGridSummary(layoutSpec: Record<string, unknown> | undefined) {
  if (!layoutSpec) {
    return undefined;
  }
  const width = numberField(layoutSpec, 'width');
  const height = numberField(layoutSpec, 'height');
  const x = numberField(layoutSpec, 'x');
  const y = numberField(layoutSpec, 'y');
  const size = width !== undefined && height !== undefined ? `${width}x${height}` : undefined;
  const position = x !== undefined && y !== undefined ? `at ${x},${y}` : undefined;
  if (size && position) {
    return `${size} ${position}`;
  }
  return size ?? position;
}

type AlertRuleMatchesResult = {
  namespace?: string;
  query?: AlertRuleSearchQuery;
  dashboardPanel?: AlertDashboardPanelSummary;
  ruleCount: number;
  matchCount: number;
  exactPanelMatchCount: number;
  matches: AlertRuleMatchView[];
  guidance: string[];
  contentAvailable: boolean;
};

type AlertRuleSearchQuery = {
  dashboardUid?: string;
  panelId?: string;
  panelTitle?: string;
  ruleName?: string;
  query?: string;
};

type AlertDashboardPanelSummary = {
  id?: string;
  title?: string;
  type?: string;
  datasourceUid?: string;
  datasourceType?: string;
  targets: AlertPanelTargetSummary[];
  thresholds?: unknown;
};

type AlertPanelTargetSummary = {
  refId?: string;
  datasourceUid?: string;
  datasourceType?: string;
  query?: string;
  legendFormat?: string;
  hidden?: boolean;
};

type AlertRuleMatchView = {
  score: number;
  reasons: string[];
  rule: AlertRuleView;
};

type AlertRuleResult = {
  namespace?: string;
  rule?: AlertRuleView;
  rawStatus?: unknown;
  guidance: string[];
  name?: string;
  title?: string;
  prometheusChecks?: number;
  contentAvailable: boolean;
};

type AlertRuleView = {
  name: string;
  title: string;
  viewUrl?: string;
  apiPath?: string;
  folderUid?: string;
  panelLink?: AlertRulePanelLinkView;
  for?: string;
  keepFiringFor?: string;
  noDataState?: string;
  execErrState?: string;
  paused?: boolean;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  conditionRef?: string;
  expressions: AlertExpressionView[];
  alertCondition?: AlertConditionView;
  prometheusChecks: AlertPrometheusCheckView[];
};

type AlertRulePanelLinkView = {
  dashboardUID: string;
  panelID: string;
  source?: string;
};

type AlertExpressionView = {
  refId: string;
  source?: boolean;
  queryType?: string;
  datasourceUid?: string;
  expressionType?: string;
  expression?: string;
  reducer?: string;
  evaluator?: AlertEvaluatorView;
  relativeTimeRange?: AlertRelativeTimeRangeView;
};

type AlertConditionView = {
  sourceRefId?: string;
  expression?: string;
  evaluator?: AlertEvaluatorView;
  reducer?: string;
};

type AlertEvaluatorView = {
  type?: string;
  params?: unknown[];
};

type AlertRelativeTimeRangeView = {
  from?: number;
  to?: number;
};

type AlertPrometheusCheckView = {
  refId: string;
  datasourceUid: string;
  query: string;
  type?: string;
  start?: string;
  end?: string;
  relativeTimeRange?: AlertRelativeTimeRangeView;
};

function AlertRuleMatchesResultView({ result }: { result: AlertRuleMatchesResult }) {
  const styles = useStyles2(getToolStyles);
  const summaryParts = [
    formatLabeledCount(result.matchCount, 'matched alert rule', 'matched alert rules'),
    formatLabeledCount(result.exactPanelMatchCount, 'exact panel link', 'exact panel links'),
    `${formatCount(result.ruleCount)} scanned`,
  ];

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summaryParts.join(' | ')}</div>
      <ResultMetaGrid
        items={[
          { label: 'Namespace', value: result.namespace ? <code>{result.namespace}</code> : undefined },
          {
            label: 'Dashboard',
            value: result.query?.dashboardUid ? <code>{result.query.dashboardUid}</code> : undefined,
          },
          { label: 'Panel', value: result.query?.panelId },
          { label: 'Panel title', value: result.query?.panelTitle ?? result.dashboardPanel?.title },
          { label: 'Rules scanned', value: formatCount(result.ruleCount) },
          { label: 'Matches', value: formatCount(result.matchCount) },
          { label: 'Exact links', value: formatCount(result.exactPanelMatchCount) },
        ]}
      />
      {!result.contentAvailable && (
        <div className={styles.emptyState}>
          The alert rule search completed, but the detailed result text was unavailable.
        </div>
      )}
      {result.dashboardPanel && <AlertPanelEvidenceView panel={result.dashboardPanel} />}
      {result.matches.length > 0 ? (
        <AlertRuleMatchesList matches={result.matches} />
      ) : (
        result.contentAvailable && <div className={styles.emptyState}>No alert rules matched this panel context.</div>
      )}
    </div>
  );
}

function AlertPanelEvidenceView({ panel }: { panel: AlertDashboardPanelSummary }) {
  const styles = useStyles2(getToolStyles);
  return (
    <details className={styles.collapsible} open>
      <summary>Panel evidence</summary>
      <ResultMetaGrid
        items={[
          { label: 'Panel', value: panel.id },
          { label: 'Title', value: panel.title },
          { label: 'Type', value: panel.type },
          { label: 'Datasource', value: panel.datasourceUid ?? panel.datasourceType },
          { label: 'Targets', value: formatCount(panel.targets.length) },
        ]}
      />
      {panel.targets.length > 0 && <AlertPanelTargetsList targets={panel.targets} />}
      {panel.thresholds !== undefined && (
        <details className={styles.collapsible}>
          <summary>Panel thresholds</summary>
          <pre className={styles.queryBlock}>{formatJson(panel.thresholds)}</pre>
        </details>
      )}
    </details>
  );
}

function AlertPanelTargetsList({ targets }: { targets: AlertPanelTargetSummary[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.queryResultList}>
      {targets.map((target, index) => (
        <AlertPanelTargetItem
          defaultOpen={index === 0}
          index={index}
          key={`${target.refId ?? index}:${target.query ?? ''}`}
          target={target}
        />
      ))}
    </div>
  );
}

function AlertPanelTargetItem({
  defaultOpen,
  index,
  target,
}: {
  defaultOpen: boolean;
  index: number;
  target: AlertPanelTargetSummary;
}) {
  const styles = useStyles2(getToolStyles);
  const [open, setOpen] = useState(defaultOpen);
  const title = target.legendFormat ?? target.query ?? 'Panel query';
  const visibility = target.hidden ? 'hidden' : 'visible';

  return (
    <details className={styles.queryResultItem} onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
      <summary className={styles.queryResultSummary}>
        <Icon className={styles.queryResultChevron} name={open ? 'angle-down' : 'angle-right'} />
        <span className={styles.queryResultIndex}>{target.refId ?? index + 1}</span>
        <span className={target.query ? styles.queryResultExpression : styles.queryResultTitle} title={title}>
          {title}
        </span>
        <span className={styles.queryResultMeta}>{visibility}</span>
      </summary>
      <ResultMetaGrid
        items={[
          { label: 'Datasource', value: target.datasourceUid ?? target.datasourceType },
          { label: 'Legend', value: target.legendFormat },
          { label: 'Hidden', value: formatBoolean(target.hidden) },
        ]}
      />
      {target.query && <pre className={styles.queryBlock}>{target.query}</pre>}
    </details>
  );
}

function AlertRuleMatchesList({ matches }: { matches: AlertRuleMatchView[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.queryResultList}>
      {matches.map((match, index) => (
        <AlertRuleMatchItem defaultOpen={index === 0} index={index} key={`${match.rule.name}:${index}`} match={match} />
      ))}
    </div>
  );
}

function AlertRuleMatchItem({
  defaultOpen,
  index,
  match,
}: {
  defaultOpen: boolean;
  index: number;
  match: AlertRuleMatchView;
}) {
  const styles = useStyles2(getToolStyles);
  const [open, setOpen] = useState(defaultOpen);
  const rule = match.rule;
  const query = firstAlertPrometheusQuery(rule);
  const condition = formatAlertCondition(rule.alertCondition);

  return (
    <details className={styles.queryResultItem} onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
      <summary className={styles.queryResultSummary}>
        <Icon className={styles.queryResultChevron} name={open ? 'angle-down' : 'angle-right'} />
        <span className={styles.queryResultIndex}>{index + 1}</span>
        <span className={styles.queryResultTitle} title={rule.title}>
          {rule.title}
        </span>
        <span className={styles.queryResultMeta}>
          {match.score > 0 ? `score ${match.score}` : (condition ?? 'match')}
        </span>
      </summary>
      <ResultMetaGrid
        items={[
          { label: 'Rule', value: <code>{rule.name}</code> },
          { label: 'Score', value: match.score > 0 ? String(match.score) : undefined },
          { label: 'Link', value: <AlertPanelLinkHealth link={rule.panelLink} /> },
          { label: 'Condition', value: condition },
          { label: 'For', value: rule.for },
          { label: 'No data', value: rule.noDataState },
          { label: 'Exec error', value: rule.execErrState },
          { label: 'Folder', value: rule.folderUid ? <code>{rule.folderUid}</code> : undefined },
          {
            label: 'View',
            value: rule.viewUrl ? <ExternalLink href={rule.viewUrl}>Open rule</ExternalLink> : undefined,
          },
        ]}
      />
      {query && <pre className={styles.queryBlock}>{query}</pre>}
      {match.reasons.length > 0 && <StringChips values={match.reasons} />}
      {Object.keys(rule.labels).length > 0 && (
        <details className={styles.collapsible}>
          <summary>Labels</summary>
          <LabelPills labels={rule.labels} />
        </details>
      )}
      {Object.keys(rule.annotations).length > 0 && (
        <details className={styles.collapsible}>
          <summary>Annotations</summary>
          <LabelPills labels={rule.annotations} />
        </details>
      )}
    </details>
  );
}

function AlertRuleResultView({ result }: { result: AlertRuleResult }) {
  const styles = useStyles2(getToolStyles);
  const rule = result.rule;
  if (!rule) {
    return (
      <div className={styles.structuredResult}>
        <div className={styles.resultSummary}>Alert rule loaded</div>
        <ResultMetaGrid
          items={[
            { label: 'Namespace', value: result.namespace ? <code>{result.namespace}</code> : undefined },
            { label: 'Rule', value: result.name ? <code>{result.name}</code> : undefined },
            { label: 'Title', value: result.title },
            { label: 'Prometheus checks', value: result.prometheusChecks },
          ]}
        />
        <div className={styles.emptyState}>The alert rule completed, but the detailed result text was unavailable.</div>
      </div>
    );
  }

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summaryLine(['Alert rule', rule.title, rule.name])}</div>
      <ResultMetaGrid
        items={[
          { label: 'Namespace', value: result.namespace ? <code>{result.namespace}</code> : undefined },
          { label: 'Rule', value: <code>{rule.name}</code> },
          { label: 'Folder', value: rule.folderUid ? <code>{rule.folderUid}</code> : undefined },
          { label: 'Condition', value: formatAlertCondition(rule.alertCondition) },
          { label: 'For', value: rule.for },
          { label: 'Keep firing', value: rule.keepFiringFor },
          { label: 'No data', value: rule.noDataState },
          { label: 'Exec error', value: rule.execErrState },
          { label: 'Paused', value: formatBoolean(rule.paused) },
          { label: 'Panel link', value: <AlertPanelLinkHealth link={rule.panelLink} /> },
        ]}
      />
      {rule.viewUrl && (
        <div>
          <LinkButton href={rule.viewUrl} icon="bell" rel="noreferrer" size="sm" target="_blank" variant="secondary">
            View alert rule
          </LinkButton>
        </div>
      )}
      {(Object.keys(rule.labels).length > 0 || Object.keys(rule.annotations).length > 0) && (
        <details className={styles.collapsible}>
          <summary>Labels and annotations</summary>
          {Object.keys(rule.labels).length > 0 && (
            <>
              <div className={styles.resultSummary}>Labels</div>
              <LabelPills labels={rule.labels} />
            </>
          )}
          {Object.keys(rule.annotations).length > 0 && (
            <>
              <div className={styles.resultSummary}>Annotations</div>
              <LabelPills labels={rule.annotations} />
            </>
          )}
        </details>
      )}
      <AlertExpressionChainView expressions={rule.expressions} />
      <AlertPrometheusChecksView checks={rule.prometheusChecks} />
      {result.rawStatus !== undefined && (
        <details className={styles.collapsible}>
          <summary>Raw status</summary>
          <pre className={styles.queryBlock}>{formatJson(result.rawStatus)}</pre>
        </details>
      )}
    </div>
  );
}

function AlertExpressionChainView({ expressions }: { expressions: AlertExpressionView[] }) {
  const styles = useStyles2(getToolStyles);
  if (expressions.length === 0) {
    return <div className={styles.emptyState}>No alert expressions were returned for this rule.</div>;
  }

  return (
    <details className={styles.collapsible} open>
      <summary>Expression chain</summary>
      <div className={styles.tableWrap}>
        <table className={cx(styles.dataTable, styles.wideTable)}>
          <thead>
            <tr>
              <th>Ref</th>
              <th>Kind</th>
              <th>Datasource</th>
              <th>Reducer</th>
              <th>Evaluator</th>
              <th>Window</th>
              <th>Expression</th>
            </tr>
          </thead>
          <tbody>
            {expressions.map((expression) => (
              <tr key={expression.refId}>
                <td>
                  <strong>{expression.refId}</strong>
                  {expression.source && <div className={styles.muted}>condition</div>}
                </td>
                <td>{expression.expressionType ?? expression.queryType ?? <span className={styles.muted}>-</span>}</td>
                <td>{expression.datasourceUid ?? <span className={styles.muted}>-</span>}</td>
                <td>{expression.reducer ?? <span className={styles.muted}>-</span>}</td>
                <td>{formatAlertEvaluator(expression.evaluator) ?? <span className={styles.muted}>-</span>}</td>
                <td>
                  {formatAlertRelativeTimeRange(expression.relativeTimeRange) ?? (
                    <span className={styles.muted}>-</span>
                  )}
                </td>
                <td className={styles.codeTextCell}>
                  {expression.expression ? (
                    truncateInline(expression.expression, 180)
                  ) : (
                    <span className={styles.muted}>-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function AlertPrometheusChecksView({ checks }: { checks: AlertPrometheusCheckView[] }) {
  const styles = useStyles2(getToolStyles);
  if (checks.length === 0) {
    return <div className={styles.emptyState}>No Prometheus checks are available for this alert rule.</div>;
  }

  return (
    <details className={styles.collapsible} open>
      <summary>Prometheus checks</summary>
      <div className={styles.prometheusQueryPlanList}>
        {checks.map((check, index) => (
          <div className={styles.prometheusQueryPlanRow} key={`${check.refId}:${check.query}`}>
            <span className={styles.prometheusQueryPlanIndex}>{check.refId || `Query ${index + 1}`}</span>
            <span className={styles.prometheusQueryPlanMeta}>
              {[check.type ?? 'range', check.datasourceUid, formatAlertCheckRange(check)].filter(Boolean).join(' | ')}
            </span>
            <code className={styles.prometheusQueryPlanExpression} title={check.query}>
              {check.query}
            </code>
          </div>
        ))}
      </div>
    </details>
  );
}

function AlertPanelLinkHealth({ link }: { link?: AlertRulePanelLinkView }) {
  const styles = useStyles2(getToolStyles);
  const health = alertPanelLinkHealth(link);
  return (
    <div className={styles.chipList}>
      <Badge text={health.text} color={health.color} />
      {link && (
        <span className={styles.muted}>
          {link.dashboardUID}/{link.panelID}
        </span>
      )}
      {health.hint && <span className={styles.muted}>{health.hint}</span>}
    </div>
  );
}

function asAlertRuleMatchesResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): AlertRuleMatchesResult | undefined {
  if (toolName !== 'find_panel_alert_rules') {
    return undefined;
  }

  const detailRecord = isRecord(details) ? details : {};
  const record = parseToolJsonRecord(content, details);
  if (record) {
    return alertRuleMatchesResultFromRecord(record, detailRecord, true);
  }

  const ruleCount = numberField(detailRecord, 'ruleCount');
  const matchCount = numberField(detailRecord, 'matchCount');
  if (ruleCount === undefined && matchCount === undefined) {
    return undefined;
  }

  return {
    namespace: stringField(detailRecord, 'namespace'),
    query: {
      dashboardUid: stringField(detailRecord, 'dashboardUid'),
      panelId: stringOrNumberField(detailRecord, 'panelId'),
    },
    ruleCount: ruleCount ?? 0,
    matchCount: matchCount ?? 0,
    exactPanelMatchCount: numberField(detailRecord, 'exactPanelMatchCount') ?? 0,
    matches: [],
    guidance: [],
    contentAvailable: false,
  };
}

function alertRuleMatchesResultFromRecord(
  record: Record<string, unknown>,
  details: Record<string, unknown>,
  contentAvailable: boolean
): AlertRuleMatchesResult {
  const matches = recordsField(record, 'matches')
    .map(alertRuleMatchFromRecord)
    .filter((match): match is AlertRuleMatchView => Boolean(match));

  return {
    namespace: stringField(record, 'namespace') ?? stringField(details, 'namespace'),
    query: alertRuleSearchQueryFromRecord(recordField(record, 'query')),
    dashboardPanel: alertDashboardPanelFromRecord(recordField(record, 'dashboardPanel')),
    ruleCount: numberField(record, 'ruleCount') ?? numberField(details, 'ruleCount') ?? 0,
    matchCount: numberField(record, 'matchCount') ?? numberField(details, 'matchCount') ?? matches.length,
    exactPanelMatchCount:
      numberField(record, 'exactPanelMatchCount') ?? numberField(details, 'exactPanelMatchCount') ?? 0,
    matches,
    guidance: stringArrayField(record, 'guidance') ?? [],
    contentAvailable,
  };
}

function asAlertRuleResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): AlertRuleResult | undefined {
  if (toolName !== 'get_alert_rule') {
    return undefined;
  }

  const detailRecord = isRecord(details) ? details : {};
  const record = parseToolJsonRecord(content, details);
  if (record) {
    const rule = alertRuleFromRecord(recordField(record, 'rule'));
    return {
      namespace: stringField(record, 'namespace') ?? stringField(detailRecord, 'namespace'),
      rule,
      rawStatus: record.rawStatus,
      guidance: stringArrayField(record, 'guidance') ?? [],
      name: stringField(detailRecord, 'name'),
      title: stringField(detailRecord, 'title'),
      prometheusChecks: numberField(detailRecord, 'prometheusChecks'),
      contentAvailable: true,
    };
  }

  if (!booleanField(detailRecord, 'summarized')) {
    return undefined;
  }

  return {
    namespace: stringField(detailRecord, 'namespace'),
    name: stringField(detailRecord, 'name'),
    title: stringField(detailRecord, 'title'),
    prometheusChecks: numberField(detailRecord, 'prometheusChecks'),
    guidance: [],
    contentAvailable: false,
  };
}

function alertRuleSearchQueryFromRecord(record: Record<string, unknown> | undefined): AlertRuleSearchQuery | undefined {
  if (!record) {
    return undefined;
  }

  return {
    dashboardUid: stringField(record, 'dashboardUid'),
    panelId: stringOrNumberField(record, 'panelId'),
    panelTitle: stringField(record, 'panelTitle'),
    ruleName: stringField(record, 'ruleName'),
    query: stringField(record, 'query'),
  };
}

function alertDashboardPanelFromRecord(
  record: Record<string, unknown> | undefined
): AlertDashboardPanelSummary | undefined {
  if (!record) {
    return undefined;
  }

  return {
    id: stringOrNumberField(record, 'id'),
    title: stringField(record, 'title'),
    type: stringField(record, 'type'),
    datasourceUid: stringField(record, 'datasourceUid'),
    datasourceType: stringField(record, 'datasourceType'),
    targets: recordsField(record, 'targets').map(alertPanelTargetFromRecord),
    thresholds: record.thresholds,
  };
}

function alertPanelTargetFromRecord(record: Record<string, unknown>): AlertPanelTargetSummary {
  return {
    refId: stringField(record, 'refId'),
    datasourceUid: stringField(record, 'datasourceUid'),
    datasourceType: stringField(record, 'datasourceType'),
    query: stringField(record, 'query'),
    legendFormat: stringField(record, 'legendFormat'),
    hidden: booleanField(record, 'hidden'),
  };
}

function alertRuleMatchFromRecord(record: Record<string, unknown>): AlertRuleMatchView | undefined {
  const rule = alertRuleFromRecord(recordField(record, 'rule'));
  if (!rule) {
    return undefined;
  }

  return {
    score: numberField(record, 'score') ?? 0,
    reasons: stringArrayField(record, 'reasons') ?? [],
    rule,
  };
}

function alertRuleFromRecord(record: Record<string, unknown> | undefined): AlertRuleView | undefined {
  if (!record) {
    return undefined;
  }

  const name = stringField(record, 'name') ?? stringField(record, 'title');
  const title = stringField(record, 'title') ?? name;
  if (!name || !title) {
    return undefined;
  }

  return {
    name,
    title,
    viewUrl: stringField(record, 'viewUrl'),
    apiPath: stringField(record, 'apiPath'),
    folderUid: stringField(record, 'folderUid'),
    panelLink: alertPanelLinkFromRecord(recordField(record, 'panelLink')),
    for: stringField(record, 'for'),
    keepFiringFor: stringField(record, 'keepFiringFor'),
    noDataState: stringField(record, 'noDataState'),
    execErrState: stringField(record, 'execErrState'),
    paused: booleanField(record, 'paused'),
    labels: stringRecord(recordField(record, 'labels')),
    annotations: stringRecord(recordField(record, 'annotations')),
    conditionRef: stringField(record, 'conditionRef'),
    expressions: recordsField(record, 'expressions')
      .map(alertExpressionFromRecord)
      .filter((expression): expression is AlertExpressionView => Boolean(expression)),
    alertCondition: alertConditionFromRecord(recordField(record, 'alertCondition')),
    prometheusChecks: recordsField(record, 'prometheusChecks')
      .map(alertPrometheusCheckFromRecord)
      .filter((check): check is AlertPrometheusCheckView => Boolean(check)),
  };
}

function alertPanelLinkFromRecord(record: Record<string, unknown> | undefined): AlertRulePanelLinkView | undefined {
  const dashboardUID = stringField(record, 'dashboardUID');
  const panelID = record ? stringOrNumberField(record, 'panelID') : undefined;
  if (!dashboardUID || !panelID) {
    return undefined;
  }

  return {
    dashboardUID,
    panelID,
    source: stringField(record, 'source'),
  };
}

function alertExpressionFromRecord(record: Record<string, unknown>): AlertExpressionView | undefined {
  const refId = stringField(record, 'refId');
  if (!refId) {
    return undefined;
  }

  return {
    refId,
    source: booleanField(record, 'source'),
    queryType: stringField(record, 'queryType'),
    datasourceUid: stringField(record, 'datasourceUid'),
    expressionType: stringField(record, 'expressionType'),
    expression: stringField(record, 'expression'),
    reducer: stringField(record, 'reducer'),
    evaluator: alertEvaluatorFromRecord(recordField(record, 'evaluator')),
    relativeTimeRange: alertRelativeTimeRangeFromRecord(recordField(record, 'relativeTimeRange')),
  };
}

function alertConditionFromRecord(record: Record<string, unknown> | undefined): AlertConditionView | undefined {
  if (!record) {
    return undefined;
  }

  return {
    sourceRefId: stringField(record, 'sourceRefId'),
    expression: stringField(record, 'expression'),
    evaluator: alertEvaluatorFromRecord(recordField(record, 'evaluator')),
    reducer: stringField(record, 'reducer'),
  };
}

function alertEvaluatorFromRecord(record: Record<string, unknown> | undefined): AlertEvaluatorView | undefined {
  if (!record) {
    return undefined;
  }

  const params = record.params;
  return {
    type: stringField(record, 'type'),
    params: Array.isArray(params) ? params : undefined,
  };
}

function alertRelativeTimeRangeFromRecord(
  record: Record<string, unknown> | undefined
): AlertRelativeTimeRangeView | undefined {
  if (!record) {
    return undefined;
  }

  return {
    from: numberField(record, 'from'),
    to: numberField(record, 'to'),
  };
}

function alertPrometheusCheckFromRecord(record: Record<string, unknown>): AlertPrometheusCheckView | undefined {
  const refId = stringField(record, 'refId');
  const datasourceUid = stringField(record, 'datasourceUid');
  const query = stringField(record, 'query');
  if (!refId || !datasourceUid || !query) {
    return undefined;
  }

  return {
    refId,
    datasourceUid,
    query,
    type: stringField(record, 'type'),
    start: stringField(record, 'start'),
    end: stringField(record, 'end'),
    relativeTimeRange: alertRelativeTimeRangeFromRecord(recordField(record, 'relativeTimeRange')),
  };
}

function alertPanelLinkHealth(link: AlertRulePanelLinkView | undefined): {
  text: string;
  color: BadgeColor;
  hint?: string;
} {
  switch (link?.source) {
    case 'panelRef+annotations':
      return { text: 'properly linked', color: 'green', hint: 'panel indicator should appear' };
    case 'panelRef':
      return { text: 'panelRef only', color: 'orange', hint: 'panel indicator annotations missing' };
    case 'annotations':
      return { text: 'annotations only', color: 'blue', hint: 'panel indicator metadata present' };
    default:
      return { text: 'not linked', color: 'red' };
  }
}

function firstAlertPrometheusQuery(rule: AlertRuleView) {
  return rule.prometheusChecks[0]?.query ?? rule.expressions.find((expression) => expression.expression)?.expression;
}

function formatAlertCondition(condition: AlertConditionView | undefined) {
  if (!condition) {
    return undefined;
  }

  return [condition.sourceRefId, condition.reducer, formatAlertEvaluator(condition.evaluator)]
    .filter(Boolean)
    .join(' ');
}

function formatAlertEvaluator(evaluator: AlertEvaluatorView | undefined) {
  if (!evaluator?.type) {
    return undefined;
  }
  const params = evaluator.params?.map(formatShortValue).join(', ');
  return params ? `${evaluator.type} ${params}` : evaluator.type;
}

function formatAlertRelativeTimeRange(range: AlertRelativeTimeRangeView | undefined) {
  if (!range || (range.from === undefined && range.to === undefined)) {
    return undefined;
  }
  if (range.from !== undefined && range.to !== undefined) {
    return `${range.from}s to ${range.to}s`;
  }
  return range.from !== undefined ? `from ${range.from}s` : `to ${range.to}s`;
}

function formatAlertCheckRange(check: AlertPrometheusCheckView) {
  if (check.start && check.end) {
    return `${check.start} -> ${check.end}`;
  }
  if (check.start) {
    return `from ${check.start}`;
  }
  if (check.end) {
    return `to ${check.end}`;
  }
  return formatAlertRelativeTimeRange(check.relativeTimeRange);
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
  const count = result.count ?? result.items.length;
  const title = result.title === 'Metrics' ? (count === 1 ? 'metric' : 'metrics') : result.title.toLowerCase();
  const summaryParts = [`${formatCount(count)} ${title}`];
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

type LineListBatchResult = {
  groupLabel: string;
  groupLabelPlural: string;
  groupIndexLabel: string;
  itemLabel: string;
  itemLabelPlural: string;
  datasourceUid?: string;
  groupCount: number;
  totalCount: number;
  truncated?: boolean;
  groups: LineListBatchGroup[];
  contentAvailable: boolean;
};

type LineListBatchGroup = {
  label: string;
  count: number;
  truncated: boolean;
  items: string[];
};

function LineListBatchResultView({ result }: { result: LineListBatchResult }) {
  const styles = useStyles2(getToolStyles);
  const summaryParts = [
    formatLabeledCount(result.groupCount, result.groupLabel, result.groupLabelPlural),
    formatLabeledCount(result.totalCount, result.itemLabel, result.itemLabelPlural),
    result.datasourceUid ? `from ${result.datasourceUid}` : undefined,
    result.truncated ? 'truncated' : undefined,
  ].filter(Boolean);

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summaryParts.join(' | ')}</div>
      {!result.contentAvailable && (
        <div className={styles.emptyState}>
          The metric list batch completed, but the detailed result text was unavailable.
        </div>
      )}
      <div className={styles.queryResultList}>
        {result.groups.map((group, index) => (
          <LineListBatchResultItem
            group={group}
            groupIndexLabel={result.groupIndexLabel}
            index={index}
            itemLabel={result.itemLabel}
            itemLabelPlural={result.itemLabelPlural}
            key={`${group.label}:${index}`}
          />
        ))}
      </div>
    </div>
  );
}

function LineListBatchResultItem({
  group,
  groupIndexLabel,
  index,
  itemLabel,
  itemLabelPlural,
}: {
  group: LineListBatchGroup;
  groupIndexLabel: string;
  index: number;
  itemLabel: string;
  itemLabelPlural: string;
}) {
  const styles = useStyles2(getToolStyles);
  const [isOpen, setIsOpen] = useState(index === 0);
  const meta = [formatLabeledCount(group.count, itemLabel, itemLabelPlural), group.truncated ? 'truncated' : undefined]
    .filter(Boolean)
    .join(' | ');

  return (
    <details className={styles.queryResultItem} open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary className={styles.queryResultSummary}>
        <Icon aria-hidden className={styles.queryResultChevron} name={isOpen ? 'angle-down' : 'angle-right'} />
        <span className={styles.queryResultIndex}>
          {groupIndexLabel} {index + 1}
        </span>
        <code className={styles.queryResultExpression} title={group.label}>
          {group.label}
        </code>
        <span className={styles.queryResultMeta}>{meta}</span>
      </summary>
      <div className={styles.scrollList}>
        {group.items.length === 0 ? (
          <span className={styles.muted}>No results</span>
        ) : (
          group.items.map((item) => (
            <div className={styles.listItem} key={item}>
              {item}
            </div>
          ))
        )}
      </div>
    </details>
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

type MetricSeriesInspectionBatch = {
  datasourceUid?: string;
  matchCount: number;
  truncatedMatches: boolean;
  totalSeries: number;
  results: MetricSeriesInspection[];
  contentAvailable: boolean;
};

function MetricSeriesInspectionBatchView({ result }: { result: MetricSeriesInspectionBatch }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>
        {formatCount(result.results.length || result.matchCount)} of {formatCount(result.matchCount)} metric selectors
        inspected
      </div>
      <ResultMetaGrid
        items={[
          { label: 'Datasource', value: result.datasourceUid },
          { label: 'Selectors', value: formatCount(result.matchCount) },
          { label: 'Series', value: formatCount(result.totalSeries) },
          {
            label: 'Shown',
            value: result.truncatedMatches
              ? `${formatCount(result.results.length)} of ${formatCount(result.matchCount)}`
              : formatCount(result.results.length || result.matchCount),
          },
        ]}
      />
      {!result.contentAvailable && (
        <div className={styles.emptyState}>
          The metric series inspection completed, but the detailed result text was unavailable.
        </div>
      )}
      {result.results.length > 0 && (
        <div className={styles.queryResultList}>
          {result.results.map((inspection, index) => (
            <MetricSeriesInspectionBatchItem index={index} key={`${inspection.match}:${index}`} result={inspection} />
          ))}
        </div>
      )}
    </div>
  );
}

function MetricSeriesInspectionBatchItem({ index, result }: { index: number; result: MetricSeriesInspection }) {
  const styles = useStyles2(getToolStyles);
  const [isOpen, setIsOpen] = useState(index === 0);

  return (
    <details className={styles.queryResultItem} open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary className={styles.queryResultSummary}>
        <Icon aria-hidden className={styles.queryResultChevron} name={isOpen ? 'angle-down' : 'angle-right'} />
        <span className={styles.queryResultIndex}>Selector {index + 1}</span>
        <code className={styles.queryResultExpression} title={result.match}>
          {result.match}
        </code>
        <span className={styles.queryResultMeta}>
          {formatCount(result.totalSeries)} series | {formatCount(result.labelNames.length)} labels
        </span>
      </summary>
      <MetricSeriesInspectionView result={result} />
    </details>
  );
}

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
    raw?: {
      from?: string;
      to?: string;
    };
  };
  frameCount: number;
  totalSeries: number;
  truncatedSeries: boolean;
  notices: QueryNoticeView[];
  executedQueryStrings: string[];
  series: SeriesSummaryView[];
  visualization?: PrometheusTimeseriesVisualization;
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

type PrometheusBatchQuerySummaryView = {
  datasourceUid: string;
  queryCount: number;
  truncatedQueries: boolean;
  results: PrometheusQuerySummaryView[];
  contentAvailable: boolean;
};

type PrometheusTimeseriesVisualization = {
  kind: 'prometheus-timeseries';
  datasourceUid: string;
  query: string;
  interval: string;
  maxDataPoints?: number;
  range: {
    from: string;
    to: string;
    raw?: {
      from?: string;
      to?: string;
    };
  };
};

function PrometheusBatchQueryResultView({ result }: { result: PrometheusBatchQuerySummaryView }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>
        {formatCount(result.results.length || result.queryCount)} of {formatCount(result.queryCount)} Prometheus queries
        summarized
      </div>
      <ResultMetaGrid
        items={[
          { label: 'Datasource', value: result.datasourceUid },
          { label: 'Queries', value: formatCount(result.queryCount) },
          {
            label: 'Shown',
            value: result.truncatedQueries
              ? `${formatCount(result.results.length)} of ${formatCount(result.queryCount)}`
              : formatCount(result.results.length || result.queryCount),
          },
        ]}
      />
      {!result.contentAvailable && (
        <div className={styles.emptyState}>
          The query batch completed, but the detailed result text was unavailable.
        </div>
      )}
      {result.results.length > 0 && (
        <div className={styles.queryResultList}>
          {result.results.map((queryResult, index) => (
            <PrometheusBatchQueryResultItem index={index} key={`${queryResult.query}:${index}`} result={queryResult} />
          ))}
        </div>
      )}
    </div>
  );
}

function PrometheusBatchQueryResultItem({ index, result }: { index: number; result: PrometheusQuerySummaryView }) {
  const styles = useStyles2(getToolStyles);
  const [isOpen, setIsOpen] = useState(index === 0);
  const visualization = isOpen
    ? (result.visualization ?? prometheusTimeseriesVisualizationFromSummary(result))
    : undefined;
  const summaryMeta = formatQueryResultSummaryMeta(result);

  return (
    <details className={styles.queryResultItem} open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary className={styles.queryResultSummary}>
        <Icon aria-hidden className={styles.queryResultChevron} name={isOpen ? 'angle-down' : 'angle-right'} />
        <span className={styles.queryResultIndex}>Query {index + 1}</span>
        <code className={styles.queryResultExpression} title={result.query}>
          {result.query}
        </code>
        <span className={styles.queryResultMeta}>{summaryMeta}</span>
      </summary>
      <PrometheusQueryResultView result={result} visualization={visualization} />
    </details>
  );
}

function PrometheusQueryResultView({
  result,
  visualization,
}: {
  result: PrometheusQuerySummaryView;
  visualization?: PrometheusTimeseriesVisualization;
}) {
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
      {visualization && <PrometheusTimeseriesSection visualization={visualization} />}
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

// The scene panel runs the PromQL live on mount, so it must never mount from
// merely rendering a message (loading a session with N stored query results
// would fire N queries). Mount only after the user opens the section, and stay
// mounted afterwards so toggling does not re-run the query.
function PrometheusTimeseriesSection({ visualization }: { visualization: PrometheusTimeseriesVisualization }) {
  const styles = useStyles2(getToolStyles);
  const [isOpen, setIsOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  return (
    <details className={styles.collapsible} open={isOpen}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setIsOpen((open) => !open);
          setHasOpened(true);
        }}
      >
        Chart
      </summary>
      {hasOpened && <PrometheusTimeseriesPanelView visualization={visualization} />}
    </details>
  );
}

function PrometheusTimeseriesPanelView({ visualization }: { visualization: PrometheusTimeseriesVisualization }) {
  const styles = useStyles2(getToolStyles);
  const { datasourceUid, query, interval, maxDataPoints, range } = visualization;
  const scene = useMemo(
    () =>
      createPrometheusTimeseriesScene({
        kind: 'prometheus-timeseries',
        datasourceUid,
        query,
        interval,
        maxDataPoints,
        range: {
          from: range.from,
          to: range.to,
          raw:
            range.raw?.from || range.raw?.to
              ? {
                  from: range.raw?.from,
                  to: range.raw?.to,
                }
              : undefined,
        },
      }),
    [datasourceUid, interval, maxDataPoints, query, range.from, range.raw?.from, range.raw?.to, range.to]
  );
  const SceneComponent = scene.Component;

  return (
    <div className={styles.timeseriesPanel} data-testid="prometheus-timeseries-panel">
      <SceneComponent model={scene} />
    </div>
  );
}

function createPrometheusTimeseriesScene(visualization: PrometheusTimeseriesVisualization) {
  const timeRange = new SceneTimeRange({
    from: visualization.range.from,
    to: visualization.range.to,
    timeZone: 'browser',
  });
  const datasource = {
    type: 'prometheus',
    uid: visualization.datasourceUid,
  };
  const queryRunner = new SceneQueryRunner({
    datasource,
    minInterval: visualization.interval,
    maxDataPoints: visualization.maxDataPoints ?? 1200,
    requestIdPrefix: 'observability-query-render-',
    queries: [
      {
        refId: 'A',
        datasource,
        expr: visualization.query,
        range: true,
        instant: false,
        interval: visualization.interval,
        editorMode: 'code',
      },
    ],
  });
  const exploreHref = buildPrometheusExploreHref(visualization);
  const panel = PanelBuilders.timeseries()
    .setTitle('Query result')
    .setDescription(visualization.query)
    .setColor({ mode: 'palette-classic' })
    .setNoValue('-')
    .setHeaderActions(
      <LinkButton href={exploreHref} icon="compass" rel="noreferrer" size="sm" target="_blank" variant="secondary">
        Explore
      </LinkButton>
    )
    .setData(queryRunner)
    .build();

  return new EmbeddedScene({
    $timeRange: timeRange,
    body: new SceneFlexLayout({
      direction: 'column',
      children: [
        new SceneFlexItem({
          body: panel,
          minHeight: 300,
          ySizing: 'fill',
        }),
      ],
    }),
  });
}

function buildPrometheusExploreHref(visualization: PrometheusTimeseriesVisualization) {
  const datasource = {
    type: 'prometheus',
    uid: visualization.datasourceUid,
  };
  const left = {
    datasource: visualization.datasourceUid,
    queries: [
      {
        refId: 'A',
        datasource,
        expr: visualization.query,
        range: true,
        instant: false,
        interval: visualization.interval,
        editorMode: 'code',
      },
    ],
    range: {
      from: visualization.range.raw?.from ?? visualization.range.from,
      to: visualization.range.raw?.to ?? visualization.range.to,
    },
  };

  const subUrl = config.appSubUrl?.replace(/\/+$/, '') ?? '';
  return `${subUrl}/explore?left=${encodeURIComponent(JSON.stringify(left))}`;
}

type RawPrometheusQueryResult = {
  datasourceUid?: string;
  query?: string;
  interval?: string;
  frames?: number;
};

function RawPrometheusQueryResultView({ result, content }: { result: RawPrometheusQueryResult; content?: unknown }) {
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
      {content !== undefined && (
        <details className={styles.collapsible}>
          <summary>Raw frames</summary>
          <ContentBlocks content={content} />
        </details>
      )}
    </div>
  );
}

type ScreenshotResult = {
  uid?: string;
  panelId?: number;
  width?: number;
  height?: number;
};

function ScreenshotResultView({ result, content }: { result: ScreenshotResult; content?: unknown }) {
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
      {content !== undefined && <ContentBlocks content={content} />}
    </div>
  );
}

type SkillResourceReadResult = {
  skill: string;
  path: string;
  bytes?: number;
  truncated?: boolean;
  text?: string;
};

function SkillResourceReadResultView({ result }: { result: SkillResourceReadResult }) {
  const styles = useStyles2(getToolStyles);
  const summary = summaryLine(['Skill resource loaded', result.skill, result.path]);

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summary}</div>
      <ResultMetaGrid
        items={[
          { label: 'Skill', value: <code>{result.skill}</code> },
          { label: 'Resource', value: <code>{result.path}</code> },
          { label: 'Size', value: result.bytes !== undefined ? `${result.bytes} bytes` : undefined },
          { label: 'Truncated', value: formatBoolean(result.truncated) },
        ]}
      />
      {result.text && (
        <details className={styles.collapsible}>
          <summary>Reference text</summary>
          <ContentBlocks content={[{ type: 'text', text: result.text }]} />
        </details>
      )}
    </div>
  );
}

type LiveDashboardMutationSchemaResult = {
  command?: string;
  available?: boolean;
  readOnly?: boolean;
  availableCommands: string[];
  guidance?: unknown;
};

function LiveDashboardMutationSchemaResultView({ result }: { result: LiveDashboardMutationSchemaResult }) {
  const styles = useStyles2(getToolStyles);
  const summary = summaryLine(['Live dashboard mutation schema', result.command]);

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summary}</div>
      <ResultMetaGrid
        items={[
          { label: 'Command', value: result.command ? <code>{result.command}</code> : undefined },
          { label: 'Available', value: formatBoolean(result.available) },
          { label: 'Read only', value: formatBoolean(result.readOnly) },
          { label: 'Commands', value: formatCount(result.availableCommands.length) },
        ]}
      />
      <StringChips values={result.availableCommands} />
      {result.guidance !== undefined && (
        <details className={styles.collapsible}>
          <summary>Guidance</summary>
          <pre className={styles.queryBlock}>{formatJson(result.guidance)}</pre>
        </details>
      )}
    </div>
  );
}

type LiveDashboardMutationResult = {
  command: string;
  success: boolean;
  error?: string;
  warnings: string[];
  changes: LiveDashboardMutationChange[];
  payload?: unknown;
  data?: unknown;
  availableCommands: string[];
  visualVerification?: {
    status?: string;
    error?: string;
    details?: unknown;
  };
};

type LiveDashboardMutationChange = {
  path?: string;
  previousValue?: unknown;
  newValue?: unknown;
};

const LIVE_DASHBOARD_READ_COMMANDS = new Set(['GET_DASHBOARD_INFO', 'GET_LAYOUT', 'LIST_PANELS', 'LIST_VARIABLES']);

function LiveDashboardMutationResultView({ result }: { result: LiveDashboardMutationResult }) {
  const styles = useStyles2(getToolStyles);
  const status = result.success ? 'succeeded' : 'failed';
  const resultKind = LIVE_DASHBOARD_READ_COMMANDS.has(result.command) ? 'command' : 'mutation';
  const summaryItems = liveDashboardResultSummaryItems(result);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>
        Live dashboard {resultKind} {status}
      </div>
      <ResultMetaGrid
        items={[
          { label: 'Command', value: <code>{result.command}</code> },
          { label: 'Status', value: status },
          ...summaryItems,
          { label: 'Changes', value: result.changes.length > 0 ? formatCount(result.changes.length) : undefined },
          { label: 'Warnings', value: result.warnings.length > 0 ? formatCount(result.warnings.length) : undefined },
          { label: 'Verification', value: result.visualVerification?.status },
          { label: 'Verification issue', value: result.visualVerification?.error },
        ]}
      />
      {!result.success && result.error && (
        <div className={styles.errorCard}>
          <div className={styles.errorTitle}>{result.command} failed</div>
          <div className={styles.errorMessage}>{result.error}</div>
        </div>
      )}
      {result.warnings.length > 0 && (
        <div className={styles.noticeList}>
          {result.warnings.map((warning, index) => (
            <div className={styles.notice} key={`${index}:${warning}`}>
              <strong>warning</strong>
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}
      {result.changes.length > 0 && <LiveDashboardMutationChangesTable changes={result.changes} />}
      {result.data !== undefined && (
        <details className={styles.collapsible}>
          <summary>Data</summary>
          <pre className={styles.queryBlock}>{formatJson(result.data)}</pre>
        </details>
      )}
      {result.visualVerification?.details !== undefined && (
        <details className={styles.collapsible}>
          <summary>Visual verification</summary>
          <pre className={styles.queryBlock}>{formatJson(result.visualVerification.details)}</pre>
        </details>
      )}
    </div>
  );
}

function liveDashboardResultSummaryItems(result: LiveDashboardMutationResult) {
  const payload = isRecord(result.payload) ? result.payload : undefined;
  const data = isRecord(result.data) ? result.data : undefined;
  const element = recordField(payload, 'element');
  const panel = recordField(payload, 'panel');
  const panelSpec = recordField(panel, 'spec');
  const variable = recordField(payload, 'variable');
  const variableSpec = recordField(variable, 'spec');
  const timeSettings = recordField(payload, 'timeSettings');
  const query = liveDashboardResultPanelQuery(panelSpec);
  const dataSummary = liveDashboardResultDataSummary(result.command, data);

  return [
    { label: 'Element', value: formatElementReference(element) },
    { label: 'Affected panels', value: liveDashboardAffectedPanelsSummary(payload) },
    { label: 'Panel title', value: stringField(panelSpec, 'title') },
    { label: 'Variable', value: formatSummaryRecordValue(payload, 'name') },
    { label: 'New variable', value: formatSummaryRecordValue(variableSpec, 'name') },
    {
      label: 'Parent path',
      value: formatSummaryRecordValue(payload, 'parentPath') ?? formatSummaryRecordValue(payload, 'toParent'),
    },
    { label: 'Datasource', value: query.datasource },
    { label: 'Query', value: query.expression ? <code>{query.expression}</code> : undefined },
    { label: 'Grid', value: liveDashboardResultGridSummary(payload) },
    { label: 'Dashboard title', value: stringField(payload, 'title') ?? stringField(data, 'title') },
    { label: 'Time range', value: liveDashboardTimeRangeSummary(timeSettings ?? payload ?? {}) },
    { label: 'Refresh', value: stringField(timeSettings, 'autoRefresh') },
    { label: 'Timezone', value: stringField(timeSettings, 'timezone') ?? stringField(payload, 'timezone') },
    { label: 'Tags', value: stringArraySummary(payload ?? {}, 'tags') },
    ...dataSummary,
  ];
}

function liveDashboardResultPanelQuery(panelSpec: Record<string, unknown> | undefined) {
  const data = recordField(panelSpec, 'data');
  const dataSpec = recordField(data, 'spec');
  const query = recordsField(dataSpec ?? {}, 'queries')[0];
  const querySpec = recordField(query, 'spec');
  const dataQuery = recordField(querySpec, 'query');
  const dataQuerySpec = recordField(dataQuery, 'spec');
  const datasource = recordField(dataQuery, 'datasource');
  const datasourceName = stringField(datasource, 'name');
  const datasourceGroup = stringField(dataQuery, 'group');
  const expression =
    stringField(dataQuerySpec, 'expr') ??
    stringField(dataQuerySpec, 'query') ??
    stringField(dataQuerySpec, '__grafana_string_value');

  return {
    expression,
    datasource:
      datasourceGroup && datasourceName ? `${datasourceGroup}/${datasourceName}` : (datasourceName ?? datasourceGroup),
  };
}

function liveDashboardResultGridSummary(payload: Record<string, unknown> | undefined) {
  const layoutItem = recordField(payload, 'layoutItem');
  const layoutSpec = recordField(layoutItem, 'spec');
  return liveDashboardGridSummary(layoutSpec ?? payload ?? {});
}

function liveDashboardAffectedPanelsSummary(payload: Record<string, unknown> | undefined) {
  const names = recordsField(payload ?? {}, 'elements')
    .map((element) => stringField(element, 'name'))
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(', ') : undefined;
}

function liveDashboardResultDataSummary(command: string, data: Record<string, unknown> | undefined) {
  if (command === 'LIST_PANELS') {
    const panels = recordsField(data ?? {}, 'elements');
    return [{ label: 'Panels', value: formatCount(panels.length) }];
  }
  if (command === 'LIST_VARIABLES') {
    const variables = recordsField(data ?? {}, 'variables');
    return [
      { label: 'Variables', value: formatCount(variables.length) },
      { label: 'Scope', value: formatSummaryRecordValue(data, 'scopePath') },
    ];
  }
  if (command === 'GET_DASHBOARD_INFO') {
    return [{ label: 'Dashboard', value: formatSummaryRecordValue(data, 'uid') }];
  }
  return [];
}

function formatElementReference(record: Record<string, unknown> | undefined) {
  const name = stringField(record, 'name');
  return name ? <code>{name}</code> : undefined;
}

function formatSummaryRecordValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record ? stringOrNumberField(record, key) : undefined;
  return value ? <code>{value}</code> : undefined;
}

function LiveDashboardMutationChangesTable({ changes }: { changes: LiveDashboardMutationChange[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <details className={styles.collapsible}>
      <summary>Changes</summary>
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Path</th>
              <th>Previous</th>
              <th>New</th>
            </tr>
          </thead>
          <tbody>
            {changes.slice(0, 20).map((change, index) => (
              <tr key={`${change.path ?? 'change'}:${index}`}>
                <td className={styles.monospace}>{change.path ?? '-'}</td>
                <td>{formatShortValue(change.previousValue)}</td>
                <td>{formatShortValue(change.newValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {changes.length > 20 && (
        <div className={styles.resultSummary}>{formatCount(changes.length - 20)} more changes</div>
      )}
    </details>
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

function asWorkspaceToolResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): React.ReactNode | undefined {
  if (!toolName || !WORKSPACE_TOOL_NAMES.has(toolName)) {
    return undefined;
  }

  const record = isRecord(details) ? details : parseToolJsonRecord(content, details);
  if (!record) {
    return undefined;
  }

  switch (toolName) {
    case 'workspace_info':
      return <WorkspaceInfoResultView result={workspaceInfoResultFromRecord(record)} />;
    case 'ls':
      return <WorkspaceDirectoryResultView result={workspaceDirectoryResultFromRecord(record)} />;
    case 'find':
      return <WorkspaceFindResultView result={workspaceFindResultFromRecord(record)} />;
    case 'grep':
      return <WorkspaceGrepResultView result={workspaceGrepResultFromRecord(record)} />;
    case 'read':
      return <WorkspaceReadResultView result={workspaceReadResultFromRecord(record)} />;
    case 'get_schema':
      return <WorkspaceReadResultView result={workspaceSchemaResultFromRecord(record)} />;
    case 'edit':
    case 'write':
    case 'upsert_resource':
      return <WorkspaceMutationResultView result={workspaceMutationResultFromRecord(toolName, record)} />;
    case 'validate_workspace':
      return <WorkspaceValidationResultView result={workspaceValidationResultFromRecord(record)} />;
    case 'preview_diff':
      return <WorkspaceDiffResultView result={workspaceDiffResultFromRecord(record)} />;
    case 'save_changes':
      return <WorkspaceSaveResultView result={workspaceDiffResultFromRecord(record)} />;
    case 'bash':
      return <WorkspaceBashResultView result={workspaceBashResultFromRecord(record)} />;
    default:
      return undefined;
  }
}

const WORKSPACE_TOOL_NAMES = new Set([
  'workspace_info',
  'ls',
  'find',
  'grep',
  'read',
  'edit',
  'write',
  'get_schema',
  'validate_workspace',
  'preview_diff',
  'save_changes',
  'bash',
  'upsert_resource',
]);

type WorkspaceFileRef = {
  name?: string;
  path: string;
  type?: string;
  layer?: string;
  language?: string;
  version?: string;
  checksum?: string;
  readOnly?: boolean;
};

type WorkspaceInfoResult = {
  title: string;
  provider?: string;
  workspaceId?: string;
  workspaceKind?: string;
  rootPath?: string;
  baseVersion?: string;
  files: WorkspaceFileRef[];
  schemas: WorkspaceFileRef[];
  pendingChanges: WorkspacePendingChange[];
  limits?: Record<string, unknown>;
};

type WorkspacePendingChange = {
  path: string;
  baseVersion?: string;
  checksum?: string;
  previousBytes?: number;
  currentBytes?: number;
};

function WorkspaceInfoResultView({ result }: { result: WorkspaceInfoResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Workspace', value: result.title },
          { label: 'ID', value: result.workspaceId ? <code>{result.workspaceId}</code> : undefined },
          { label: 'Kind', value: result.workspaceKind ? <code>{result.workspaceKind}</code> : undefined },
          { label: 'Provider', value: result.provider ? <code>{result.provider}</code> : undefined },
          { label: 'Root', value: result.rootPath ? <code>{result.rootPath}</code> : undefined },
          { label: 'Base', value: result.baseVersion ? <code>{shortChecksum(result.baseVersion)}</code> : undefined },
          { label: 'Files', value: formatCount(result.files.length) },
          { label: 'Pending', value: formatCount(result.pendingChanges.length) },
        ]}
      />
      <WorkspaceFileTable files={result.files} />
      {result.pendingChanges.length > 0 && <WorkspacePendingChangesView changes={result.pendingChanges} />}
      {(result.schemas.length > 0 || result.limits) && (
        <details className={styles.collapsible}>
          <summary>Workspace metadata</summary>
          {result.schemas.length > 0 && <WorkspaceFileTable files={result.schemas} title="Schemas" />}
          {result.limits && <pre className={styles.queryBlock}>{formatJson(result.limits)}</pre>}
        </details>
      )}
    </div>
  );
}

function workspaceInfoResultFromRecord(record: Record<string, unknown>): WorkspaceInfoResult {
  const provider = recordField(record, 'provider');
  return {
    title: stringField(record, 'displayName') ?? 'Workspace',
    provider: stringField(provider, 'pluginId') ?? stringField(provider, 'displayName'),
    workspaceId: stringField(record, 'workspaceId'),
    workspaceKind: stringField(record, 'workspaceKind'),
    rootPath: stringField(record, 'rootPath'),
    baseVersion: stringField(record, 'baseVersion'),
    files: recordsField(record, 'files').map(workspaceFileRefFromRecord),
    schemas: recordsField(record, 'schemas').map(workspaceSchemaRefFromRecord),
    pendingChanges: recordsField(record, 'pendingChanges').map(workspacePendingChangeFromRecord),
    limits: recordField(record, 'limits'),
  };
}

type WorkspaceDirectoryResult = {
  path?: string;
  entries: WorkspaceFileRef[];
};

function WorkspaceDirectoryResultView({ result }: { result: WorkspaceDirectoryResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>
        {formatCount(result.entries.length)} entries{result.path ? ` | ${result.path}` : ''}
      </div>
      <WorkspaceFileTable files={result.entries} />
    </div>
  );
}

function workspaceDirectoryResultFromRecord(record: Record<string, unknown>): WorkspaceDirectoryResult {
  return {
    path: stringField(record, 'path'),
    entries: recordsField(record, 'entries').map(workspaceFileRefFromRecord),
  };
}

type WorkspaceFindResult = {
  paths: string[];
};

function WorkspaceFindResultView({ result }: { result: WorkspaceFindResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{formatCount(result.paths.length)} paths</div>
      <div className={styles.scrollList}>
        {result.paths.length === 0 ? (
          <span className={styles.muted}>No matching files</span>
        ) : (
          result.paths.map((path) => (
            <div className={styles.listItem} key={path}>
              {path}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function workspaceFindResultFromRecord(record: Record<string, unknown>): WorkspaceFindResult {
  return {
    paths: stringArrayField(record, 'paths') ?? [],
  };
}

type WorkspaceGrepResult = {
  matchCount: number;
  matches: WorkspaceGrepMatch[];
};

type WorkspaceGrepMatch = {
  path: string;
  line?: number;
  text: string;
};

function WorkspaceGrepResultView({ result }: { result: WorkspaceGrepResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{formatCount(result.matchCount)} matches</div>
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
              <tr key={`${match.path}:${match.line ?? index}`}>
                <td className={styles.monospace}>{match.path}</td>
                <td>{match.line ?? <span className={styles.muted}>-</span>}</td>
                <td className={styles.codeTextCell}>{match.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function workspaceGrepResultFromRecord(record: Record<string, unknown>): WorkspaceGrepResult {
  return {
    matchCount: numberField(record, 'matchCount') ?? recordsField(record, 'matches').length,
    matches: recordsField(record, 'matches').map((match) => ({
      path: stringField(match, 'path') ?? '-',
      line: numberField(match, 'line'),
      text: stringField(match, 'text') ?? '',
    })),
  };
}

type WorkspaceReadResult = {
  path: string;
  version?: string;
  checksum?: string;
  language?: string;
  readOnly?: boolean;
  totalLines?: number;
  lines: CodeLine[];
};

function WorkspaceReadResultView({ result }: { result: WorkspaceReadResult }) {
  const styles = useStyles2(getToolStyles);
  const lineSummary = workspaceReadLineSummary(result);
  const summary = summaryLine([result.path, result.language, lineSummary]);
  const hasMetadata = result.readOnly !== undefined || Boolean(result.version) || Boolean(result.checksum);
  return (
    <details className={styles.compactResult}>
      <summary className={styles.compactResultSummary}>
        <Icon aria-hidden className={styles.toolTypeIcon} name="file-alt" />
        <span className={styles.compactResultText}>{summary}</span>
      </summary>
      <div className={styles.compactResultBody}>
        {result.lines.length > 0 ? <CodeViewer lines={result.lines} language="plain" /> : null}
        {hasMetadata && (
          <details className={styles.collapsible}>
            <summary>File metadata</summary>
            <ResultMetaGrid
              items={[
                {
                  label: 'Read only',
                  value: result.readOnly === undefined ? undefined : result.readOnly ? 'yes' : 'no',
                },
                { label: 'Version', value: result.version ? <code>{shortChecksum(result.version)}</code> : undefined },
                {
                  label: 'Checksum',
                  value: result.checksum ? <code>{shortChecksum(result.checksum)}</code> : undefined,
                },
              ]}
            />
          </details>
        )}
      </div>
    </details>
  );
}

function workspaceReadLineSummary(result: WorkspaceReadResult) {
  if (result.lines.length === 0) {
    return `${formatCount(result.totalLines ?? 0)} lines`;
  }

  return `lines ${result.lines[0].line}-${result.lines[result.lines.length - 1].line} of ${
    result.totalLines ?? result.lines.length
  }`;
}

function workspaceReadResultFromRecord(record: Record<string, unknown>): WorkspaceReadResult {
  return {
    path: stringField(record, 'path') ?? '-',
    version: stringField(record, 'version'),
    checksum: stringField(record, 'checksum'),
    language: stringField(record, 'language'),
    readOnly: booleanField(record, 'readOnly'),
    totalLines: numberField(record, 'totalLines'),
    lines: recordsField(record, 'lines')
      .map(asCodeLine)
      .filter((line): line is CodeLine => Boolean(line)),
  };
}

function workspaceSchemaResultFromRecord(record: Record<string, unknown>): WorkspaceReadResult {
  const content = stringField(record, 'content') ?? '';
  return {
    path: stringField(record, 'path') ?? stringField(record, 'schemaId') ?? '-',
    version: stringField(record, 'version'),
    checksum: stringField(record, 'checksum'),
    language: 'json',
    totalLines: content ? textToCodeLines(content).length : undefined,
    lines: content ? textToCodeLines(content) : [],
  };
}

type WorkspaceMutationResult = {
  title: string;
  summary?: string;
  status?: string;
  path?: string;
  version?: string;
  checksum?: string;
  changedRanges: Array<{ startLine: number; endLine: number; newLines: number }>;
  firstChangedLine?: number;
  changedFiles: WorkspaceChangedFile[];
  pendingChanges: WorkspacePendingChange[];
  operation?: Record<string, unknown>;
  validation?: WorkspaceValidationResult;
  diff?: string;
};

type WorkspaceChangedFile = WorkspacePendingChange & {
  addedLines?: number;
  removedLines?: number;
  firstChangedLine?: number;
};

function WorkspaceMutationResultView({ result }: { result: WorkspaceMutationResult }) {
  const styles = useStyles2(getToolStyles);
  const hasDiff = Boolean(result.diff);
  return (
    <div className={styles.structuredResult}>
      {hasDiff ? (
        result.diff && <DiffViewer defaultOpen diff={result.diff} />
      ) : (
        <>
          <div className={styles.resultSummary}>{result.summary ?? result.title}</div>
          <ResultMetaGrid
            items={[
              { label: 'Status', value: result.status ? <WorkspaceStatusBadge status={result.status} /> : undefined },
              { label: 'Changed', value: formatWorkspaceChangedRanges(result.changedRanges) },
            ]}
          />
          {result.changedFiles.length > 0 && <WorkspaceChangedFilesView files={result.changedFiles} />}
        </>
      )}
      {result.validation && <WorkspaceValidationResultView result={result.validation} compact />}
      {result.operation && (
        <details className={styles.collapsible}>
          <summary>Operation</summary>
          <pre className={styles.queryBlock}>{formatJson(result.operation)}</pre>
        </details>
      )}
    </div>
  );
}

function workspaceMutationResultFromRecord(toolName: string, record: Record<string, unknown>): WorkspaceMutationResult {
  const files = recordsField(record, 'files').map(workspaceChangedFileFromRecord);
  const changedFiles = recordsField(record, 'changedFiles').map(workspaceChangedFileFromRecord);
  const pendingChanges = recordsField(record, 'pendingChanges').map(workspacePendingChangeFromRecord);
  const operation = recordField(record, 'operation');
  const validationRecord = recordField(record, 'validation');
  const path = stringField(record, 'path') ?? files[0]?.path ?? changedFiles[0]?.path ?? pendingChanges[0]?.path;
  return {
    title: workspaceMutationTitle(toolName),
    summary: stringField(record, 'summary'),
    status: stringField(record, 'status'),
    path,
    version: stringField(record, 'version'),
    checksum: stringField(record, 'checksum'),
    changedRanges: recordsField(record, 'changedRanges').map(workspaceChangedRangeFromRecord),
    firstChangedLine: numberField(record, 'firstChangedLine'),
    changedFiles: changedFiles.length > 0 ? changedFiles : files,
    pendingChanges,
    operation,
    validation: validationRecord ? workspaceValidationResultFromRecord(validationRecord) : undefined,
    diff: stringField(record, 'diff'),
  };
}

function workspaceMutationTitle(toolName: string) {
  switch (toolName) {
    case 'write':
      return 'Workspace file written';
    case 'upsert_resource':
      return 'Workspace resource updated';
    default:
      return 'Workspace file edited';
  }
}

type WorkspaceValidationResult = {
  status: string;
  summary?: string;
  workspaceId?: string;
  baseVersion?: string;
  checkedAt?: string;
  findings: WorkspaceFinding[];
  details?: Record<string, unknown>;
};

type WorkspaceFinding = {
  severity: string;
  message: string;
  sourcePath?: string;
  line?: number;
};

function WorkspaceValidationResultView({ result, compact }: { result: WorkspaceValidationResult; compact?: boolean }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Status', value: <WorkspaceStatusBadge status={result.status} /> },
          { label: 'Summary', value: result.summary },
          { label: 'Findings', value: formatCount(result.findings.length) },
          { label: 'Workspace', value: !compact && result.workspaceId ? <code>{result.workspaceId}</code> : undefined },
          {
            label: 'Base',
            value: !compact && result.baseVersion ? <code>{shortChecksum(result.baseVersion)}</code> : undefined,
          },
        ]}
      />
      {result.findings.length > 0 && <WorkspaceFindingsTable findings={result.findings} />}
      {!compact && result.details && (
        <details className={styles.collapsible}>
          <summary>Validation details</summary>
          <pre className={styles.queryBlock}>{formatJson(result.details)}</pre>
        </details>
      )}
    </div>
  );
}

function workspaceValidationResultFromRecord(record: Record<string, unknown>): WorkspaceValidationResult {
  return {
    status: stringField(record, 'status') ?? 'unknown',
    summary: stringField(record, 'summary'),
    workspaceId: stringField(record, 'workspaceId'),
    baseVersion: stringField(record, 'baseVersion'),
    checkedAt: stringField(record, 'checkedAt'),
    findings: recordsField(record, 'findings').map((finding) => ({
      severity: stringField(finding, 'severity') ?? 'info',
      message: stringField(finding, 'message') ?? '',
      sourcePath: stringField(finding, 'sourcePath'),
      line: numberField(finding, 'line'),
    })),
    details: recordField(record, 'details'),
  };
}

type WorkspaceDiffResult = {
  status: string;
  workspaceId?: string;
  baseVersion?: string;
  savedVersion?: string;
  changedFiles: WorkspaceChangedFile[];
  validation?: WorkspaceValidationResult;
  audit?: Record<string, unknown>;
  diff?: string;
};

function WorkspaceDiffResultView({ result }: { result: WorkspaceDiffResult }) {
  const styles = useStyles2(getToolStyles);
  const hasDiff = Boolean(result.diff);
  return (
    <div className={styles.structuredResult}>
      {hasDiff ? (
        result.diff && <DiffViewer defaultOpen diff={result.diff} />
      ) : (
        <>
          <ResultMetaGrid
            items={[
              { label: 'Status', value: <WorkspaceStatusBadge status={result.status} /> },
              { label: 'Changed files', value: formatCount(result.changedFiles.length) },
            ]}
          />
          {result.changedFiles.length > 0 ? (
            <WorkspaceChangedFilesView files={result.changedFiles} />
          ) : (
            <div className={styles.emptyState}>No workspace changes.</div>
          )}
        </>
      )}
      {result.validation && <WorkspaceValidationResultView result={result.validation} compact />}
    </div>
  );
}

function WorkspaceSaveResultView({ result }: { result: WorkspaceDiffResult }) {
  const styles = useStyles2(getToolStyles);
  const hasDiff = Boolean(result.diff);
  return (
    <div className={styles.structuredResult}>
      {hasDiff ? (
        result.diff && <DiffViewer defaultOpen diff={result.diff} />
      ) : (
        <>
          <ResultMetaGrid
            items={[
              { label: 'Status', value: <WorkspaceStatusBadge status={result.status} /> },
              { label: 'Changed files', value: formatCount(result.changedFiles.length) },
            ]}
          />
          {result.changedFiles.length > 0 && <WorkspaceChangedFilesView files={result.changedFiles} />}
        </>
      )}
      {result.validation && <WorkspaceValidationResultView result={result.validation} compact />}
      {result.audit && (
        <details className={styles.collapsible}>
          <summary>Audit</summary>
          <pre className={styles.queryBlock}>{formatJson(result.audit)}</pre>
        </details>
      )}
    </div>
  );
}

function workspaceDiffResultFromRecord(record: Record<string, unknown>): WorkspaceDiffResult {
  const validation = recordField(record, 'validation');
  return {
    status: stringField(record, 'status') ?? 'unknown',
    workspaceId: stringField(record, 'workspaceId'),
    baseVersion: stringField(record, 'baseVersion'),
    savedVersion: stringField(record, 'savedVersion'),
    changedFiles: recordsField(record, 'changedFiles').map(workspaceChangedFileFromRecord),
    validation: validation ? workspaceValidationResultFromRecord(validation) : undefined,
    audit: recordField(record, 'audit'),
    diff: stringField(record, 'diff'),
  };
}

type WorkspaceBashResult = {
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
  changedFiles: WorkspaceChangedFile[];
  pendingChanges: WorkspacePendingChange[];
};

function WorkspaceBashResultView({ result }: { result: WorkspaceBashResult }) {
  const styles = useStyles2(getToolStyles);
  const status = result.timedOut ? 'timed out' : result.exitCode === 0 ? 'completed' : 'failed';
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Status', value: <WorkspaceStatusBadge status={status} /> },
          { label: 'Exit code', value: result.exitCode === undefined ? undefined : String(result.exitCode) },
          { label: 'CWD', value: result.cwd ? <code>{result.cwd}</code> : undefined },
          { label: 'Changed files', value: formatCount(result.changedFiles.length) },
          { label: 'Pending', value: formatCount(result.pendingChanges.length) },
        ]}
      />
      <pre className={styles.queryBlock}>{result.command}</pre>
      {result.stdout && (
        <details className={styles.collapsible} open>
          <summary>stdout{result.stdoutTruncated ? ' | truncated' : ''}</summary>
          <pre className={styles.queryBlock}>{result.stdout}</pre>
        </details>
      )}
      {result.stderr && (
        <details className={styles.collapsible} open={result.exitCode !== 0}>
          <summary>stderr{result.stderrTruncated ? ' | truncated' : ''}</summary>
          <pre className={styles.queryBlock}>{result.stderr}</pre>
        </details>
      )}
      {result.changedFiles.length > 0 && <WorkspaceChangedFilesView files={result.changedFiles} />}
      {result.pendingChanges.length > 0 && <WorkspacePendingChangesView changes={result.pendingChanges} />}
    </div>
  );
}

function workspaceBashResultFromRecord(record: Record<string, unknown>): WorkspaceBashResult {
  return {
    command: stringField(record, 'command') ?? '',
    cwd: stringField(record, 'cwd'),
    exitCode: numberField(record, 'exitCode'),
    stdout: stringField(record, 'stdout'),
    stderr: stringField(record, 'stderr'),
    stdoutTruncated: booleanField(record, 'stdoutTruncated'),
    stderrTruncated: booleanField(record, 'stderrTruncated'),
    timedOut: booleanField(record, 'timedOut'),
    changedFiles: recordsField(record, 'changedFiles').map(workspaceChangedFileFromRecord),
    pendingChanges: recordsField(record, 'pendingChanges').map(workspacePendingChangeFromRecord),
  };
}

function WorkspaceFileTable({ files, title }: { files: WorkspaceFileRef[]; title?: string }) {
  const styles = useStyles2(getToolStyles);
  if (files.length === 0) {
    return <div className={styles.emptyState}>{title ? `${title}: none` : 'No files.'}</div>;
  }

  return (
    <div className={styles.tableWrap}>
      <table className={cx(styles.dataTable, styles.wideTable)}>
        <thead>
          <tr>
            <th>{title ?? 'Path'}</th>
            <th>Type</th>
            <th>Layer</th>
            <th>Language</th>
            <th>Version</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file, index) => (
            <tr key={`${file.path}:${index}`}>
              <td className={styles.monospace}>{file.path}</td>
              <td>{file.type ?? (file.readOnly ? 'read-only' : 'file')}</td>
              <td>{file.layer ?? <span className={styles.muted}>-</span>}</td>
              <td>{file.language ?? <span className={styles.muted}>-</span>}</td>
              <td className={styles.monospace}>
                {(file.version ?? file.checksum) ? (
                  shortChecksum(file.version ?? file.checksum ?? '')
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

function WorkspaceChangedFilesView({ files }: { files: WorkspaceChangedFile[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.tableWrap}>
      <table className={cx(styles.dataTable, styles.wideTable)}>
        <thead>
          <tr>
            <th>File</th>
            <th>Changed</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file, index) => (
            <tr key={`${file.path}:${index}`}>
              <td className={styles.monospace}>{file.path}</td>
              <td>{workspaceChangedFileSummary(file)}</td>
              <td>{workspaceBytesSummary(file)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkspacePendingChangesView({ changes }: { changes: WorkspacePendingChange[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <details className={styles.collapsible} open={changes.length <= 3}>
      <summary>Pending changes</summary>
      <div className={styles.tableWrap}>
        <table className={cx(styles.dataTable, styles.wideTable)}>
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              <th>Checksum</th>
              <th>Base</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change, index) => (
              <tr key={`${change.path}:${index}`}>
                <td className={styles.monospace}>{change.path}</td>
                <td>{workspaceBytesSummary(change)}</td>
                <td className={styles.monospace}>
                  {change.checksum ? shortChecksum(change.checksum) : <span className={styles.muted}>-</span>}
                </td>
                <td className={styles.monospace}>
                  {change.baseVersion ? shortChecksum(change.baseVersion) : <span className={styles.muted}>-</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function WorkspaceFindingsTable({ findings }: { findings: WorkspaceFinding[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.tableWrap}>
      <table className={cx(styles.dataTable, styles.wideTable)}>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Source</th>
            <th>Line</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((finding, index) => (
            <tr key={`${finding.sourcePath ?? 'finding'}:${finding.line ?? index}:${index}`}>
              <td>
                <WorkspaceStatusBadge status={finding.severity} />
              </td>
              <td className={styles.monospace}>{finding.sourcePath ?? <span className={styles.muted}>-</span>}</td>
              <td>{finding.line ?? <span className={styles.muted}>-</span>}</td>
              <td>{finding.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkspaceStatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const color: BadgeColor =
    normalized === 'valid' || normalized === 'saved' || normalized === 'completed'
      ? 'green'
      : normalized === 'warning' || normalized === 'changed'
        ? 'orange'
        : normalized === 'error' || normalized === 'failed' || normalized === 'timed out'
          ? 'red'
          : 'blue';
  return <Badge text={status} color={color} />;
}

function workspaceFileRefFromRecord(record: Record<string, unknown>): WorkspaceFileRef {
  return {
    name: stringField(record, 'name'),
    path: stringField(record, 'path') ?? stringField(record, 'name') ?? '-',
    type: stringField(record, 'type'),
    layer: stringField(record, 'layer'),
    language: stringField(record, 'language'),
    version: stringField(record, 'version'),
    checksum: stringField(record, 'checksum'),
    readOnly: booleanField(record, 'readOnly'),
  };
}

function workspaceSchemaRefFromRecord(record: Record<string, unknown>): WorkspaceFileRef {
  return {
    path: stringField(record, 'path') ?? stringField(record, 'schemaId') ?? '-',
    type: 'schema',
    language: stringField(record, 'language'),
    version: stringField(record, 'schemaId'),
    checksum: stringField(record, 'checksum'),
    readOnly: true,
  };
}

function workspacePendingChangeFromRecord(record: Record<string, unknown>): WorkspacePendingChange {
  return {
    path: stringField(record, 'path') ?? '-',
    baseVersion: stringField(record, 'baseVersion'),
    checksum: stringField(record, 'checksum'),
    previousBytes: numberField(record, 'previousBytes'),
    currentBytes: numberField(record, 'currentBytes') ?? numberField(record, 'bytes'),
  };
}

function workspaceChangedFileFromRecord(record: Record<string, unknown>): WorkspaceChangedFile {
  return {
    ...workspacePendingChangeFromRecord(record),
    addedLines: numberField(record, 'addedLines'),
    removedLines: numberField(record, 'removedLines'),
    firstChangedLine: numberField(record, 'firstChangedLine'),
  };
}

function workspaceChangedRangeFromRecord(record: Record<string, unknown>) {
  return {
    startLine: numberField(record, 'startLine') ?? 0,
    endLine: numberField(record, 'endLine') ?? 0,
    newLines: numberField(record, 'newLines') ?? 0,
  };
}

function workspaceChangedFileSummary(file: WorkspaceChangedFile) {
  const parts = [
    file.addedLines !== undefined ? `+${file.addedLines}` : undefined,
    file.removedLines !== undefined ? `-${file.removedLines}` : undefined,
    file.firstChangedLine ? `line ${file.firstChangedLine}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' | ') : 'changed';
}

function workspaceBytesSummary(file: WorkspacePendingChange) {
  if (file.previousBytes !== undefined && file.currentBytes !== undefined) {
    return `${formatBytes(file.previousBytes)} -> ${formatBytes(file.currentBytes)}`;
  }
  return formatBytes(file.currentBytes) ?? '-';
}

function formatWorkspaceChangedRanges(ranges: WorkspaceMutationResult['changedRanges']) {
  const visible = ranges.filter((range) => range.startLine > 0);
  if (visible.length === 0) {
    return undefined;
  }
  return visible
    .slice(0, 3)
    .map((range) =>
      range.endLine < range.startLine
        ? `${range.startLine} insert`
        : `${range.startLine}-${range.endLine || range.startLine}`
    )
    .join(', ');
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
            value:
              result.lines.length > 0
                ? `${result.lines[0].line}-${result.lines[result.lines.length - 1].line} of ${result.totalLines}`
                : undefined,
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

function DashboardActionView({
  action,
  onOpenDashboard,
}: {
  action: DashboardAction;
  onOpenDashboard?: DashboardOpenHandler;
}) {
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
          {
            label: 'Open',
            value: action.url ? (
              onOpenDashboard ? (
                <Button
                  icon="external-link-alt"
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => onOpenDashboard(action)}
                >
                  Open dashboard
                </Button>
              ) : (
                <ExternalLink href={action.url}>Open dashboard</ExternalLink>
              )
            ) : undefined,
          },
        ]}
      />
    </div>
  );
}

function ArtifactResultView({ artifact, preview }: { artifact: ArtifactRef; preview?: ArtifactPreview }) {
  const styles = useStyles2(getToolStyles);

  return (
    <div className={styles.artifactCard} data-testid="artifact-result">
      <div className={styles.artifactHeader}>
        <Icon aria-hidden className={styles.toolTypeIcon} name={artifactIcon(artifact.kind)} />
        <div className={styles.artifactTitleGroup}>
          <div className={styles.artifactTitle}>{artifact.title}</div>
          <div className={styles.resultSummary}>{artifact.summary}</div>
        </div>
        <Badge text={artifact.kind} color="blue" />
      </div>
      <ResultMetaGrid
        items={[
          { label: 'ID', value: <code>{artifact.id}</code> },
          { label: 'Tool', value: artifact.toolName },
          { label: 'Size', value: formatBytes(artifact.bytes) },
          { label: 'Read', value: <code>{`read_artifact {"id":"${artifact.id}"}`}</code> },
        ]}
      />
      {preview?.type === 'text' && <ArtifactTextPreview preview={preview} />}
      {preview?.type === 'image' && (
        <img
          alt={artifact.title}
          className={styles.artifactImagePreview}
          src={`data:${preview.mimeType};base64,${preview.data}`}
        />
      )}
    </div>
  );
}

function ArtifactTextPreview({ preview }: { preview: Extract<ArtifactPreview, { type: 'text' }> }) {
  const styles = useStyles2(getToolStyles);
  return (
    <details className={cx(styles.collapsible, styles.artifactTextPreview)} open>
      <summary>Preview{preview.truncated ? ' | truncated' : ''}</summary>
      <ContentBlocks content={[{ type: 'text', text: preview.text }]} />
    </details>
  );
}

function artifactIcon(kind: ArtifactRef['kind']): IconName {
  switch (kind) {
    case 'dashboard':
      return 'dashboard';
    case 'image':
      return 'camera';
    case 'table':
      return 'table';
    case 'text':
      return 'file-alt';
    case 'json':
      return 'brackets-curly';
  }
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
  const safeHref = safeLinkHref(href);
  if (!safeHref) {
    return <>{children}</>;
  }
  return (
    <a className={styles.externalLink} href={safeHref} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

// All current callers pass server-generated URLs, but nothing enforces that
// invariant for future tool results, so reject anything that is not http(s)
// or an in-app absolute path.
function safeLinkHref(href: string): string | undefined {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed;
  }
  return undefined;
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

function DiffViewer({ diff, defaultOpen }: { diff: string; defaultOpen?: boolean }) {
  const styles = useStyles2(getToolStyles);
  const { lines, metadataFlags, summary } = useMemo(() => {
    const optimizedLines = optimizedUnifiedDiffLines(diff);
    const flags = diffMetadataFlags(optimizedLines);
    return { lines: optimizedLines, metadataFlags: flags, summary: diffSummary(optimizedLines, flags) };
  }, [diff]);
  return (
    <details className={styles.compactResult} open={defaultOpen}>
      <summary className={styles.compactResultSummary}>
        <Icon aria-hidden className={styles.toolTypeIcon} name="file-alt" />
        <span className={styles.compactResultText}>{summary}</span>
      </summary>
      <div className={styles.compactResultBody}>
        <pre className={styles.diffViewer}>
          {lines.map((line, index) => {
            const isMeta = metadataFlags[index];
            return (
              <div
                className={cx(
                  styles.diffLine,
                  isMeta && styles.diffMeta,
                  !isMeta && line.startsWith('+') && styles.diffAdd,
                  !isMeta && line.startsWith('-') && styles.diffDelete
                )}
                key={`${index}:${line}`}
              >
                {line || ' '}
              </div>
            );
          })}
        </pre>
      </div>
    </details>
  );
}

function diffSummary(lines: string[], metadataFlags: boolean[]) {
  const added = lines.filter((line, index) => !metadataFlags[index] && line.startsWith('+')).length;
  const removed = lines.filter((line, index) => !metadataFlags[index] && line.startsWith('-')).length;
  const hunks = lines.filter((line) => line.startsWith('@@')).length;
  return summaryLine([
    'Diff',
    hunks > 0 ? formatLabeledCount(hunks, 'hunk', 'hunks') : undefined,
    added > 0 || removed > 0 ? `+${formatCount(added)} / -${formatCount(removed)}` : undefined,
  ]);
}

// `---`/`+++` are file headers only in the preamble before the first hunk;
// inside a hunk they are removed/added lines whose content starts with dashes
// or pluses and must be colored and counted as changes.
function diffMetadataFlags(lines: string[]): boolean[] {
  let preamble = true;
  return lines.map((line) => {
    if (line.startsWith('@@')) {
      preamble = false;
      return true;
    }
    if (line.startsWith('Index:') || line.startsWith('diff ')) {
      preamble = true;
      return true;
    }
    return preamble && (line.startsWith('---') || line.startsWith('+++'));
  });
}

function optimizedUnifiedDiffLines(diff: string) {
  const lines = diff.split('\n');
  const optimized: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('@@')) {
      optimized.push(line);
      continue;
    }

    const hunkLines: string[] = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length && !isDiffBoundaryLine(lines[nextIndex])) {
      hunkLines.push(lines[nextIndex]);
      nextIndex += 1;
    }

    optimized.push(...optimizeFullReplacementHunk(line, hunkLines));
    index = nextIndex - 1;
  }

  return optimized;
}

function optimizeFullReplacementHunk(header: string, hunkLines: string[]) {
  const normalizedHunkLines = trimTrailingEmptyDiffLine(hunkLines);
  if (!shouldRediffHunk(normalizedHunkLines)) {
    return [header, ...hunkLines];
  }

  const oldLines = normalizedHunkLines.filter((line) => line.startsWith('-')).map((line) => line.slice(1));
  const newLines = normalizedHunkLines.filter((line) => line.startsWith('+')).map((line) => line.slice(1));
  const range = parseUnifiedDiffHunkHeader(header);
  const patch = structuredPatch('', '', diffLinesToText(oldLines), diffLinesToText(newLines), '', '', {
    context: 3,
  });
  // Without a parseable original header the true positions are unknown; keep
  // the original header instead of asserting fabricated line numbers.
  const optimizedHunkLines = patch.hunks.flatMap((hunk) => [
    range
      ? `@@ -${formatUnifiedDiffRange(range.oldStart + hunk.oldStart - 1, hunk.oldLines)} +${formatUnifiedDiffRange(
          range.newStart + hunk.newStart - 1,
          hunk.newLines
        )} @@`
      : header,
    ...hunk.lines,
  ]);

  return optimizedHunkLines.length > 0 && optimizedHunkLines.length < normalizedHunkLines.length + 1
    ? optimizedHunkLines
    : [header, ...hunkLines];
}

function trimTrailingEmptyDiffLine(lines: string[]) {
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

function shouldRediffHunk(hunkLines: string[]) {
  if (hunkLines.length < 6) {
    return false;
  }

  const hasRemoved = hunkLines.some((line) => line.startsWith('-'));
  const hasAdded = hunkLines.some((line) => line.startsWith('+'));
  const hasContext = hunkLines.some((line) => line.startsWith(' '));
  const hasUnsupportedLine = hunkLines.some((line) => !line.startsWith('-') && !line.startsWith('+'));
  return hasRemoved && hasAdded && !hasContext && !hasUnsupportedLine;
}

function parseUnifiedDiffHunkHeader(header: string) {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/.exec(header);
  if (!match) {
    return undefined;
  }

  return {
    oldStart: Number(match[1]),
    newStart: Number(match[2]),
  };
}

function diffLinesToText(lines: string[]) {
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function formatUnifiedDiffRange(start: number, lines: number) {
  return lines === 1 ? String(start) : `${start},${lines}`;
}

// `---`/`+++` are intentionally not boundaries: inside a hunk they are
// removed/added lines whose content starts with dashes or pluses.
function isDiffBoundaryLine(line: string) {
  return line.startsWith('@@') || line.startsWith('Index:') || line.startsWith('diff ');
}

// Details come from persisted or imported sessions, so every field the
// renderer dereferences must be normalized here rather than trusted.
function asSubagentDetails(details: unknown): SubagentRunDetails | undefined {
  if (!isRecord(details) || details.type !== 'subagent') {
    return undefined;
  }

  const usage = isRecord(details.usage) ? details.usage : {};
  const toolCalls = Array.isArray(details.toolCalls) ? details.toolCalls.filter(isRecord) : [];
  return {
    ...details,
    type: 'subagent',
    agent: typeof details.agent === 'string' ? details.agent : 'specialist',
    status: typeof details.status === 'string' ? details.status : 'completed',
    task: typeof details.task === 'string' ? details.task : '',
    toolCalls: toolCalls.map((call, index) => ({
      ...call,
      id: typeof call.id === 'string' && call.id ? call.id : `call-${index + 1}`,
      name: typeof call.name === 'string' && call.name ? call.name : 'tool',
      status: typeof call.status === 'string' ? call.status : 'completed',
    })),
    usage: {
      turns: numberField(usage, 'turns') ?? 0,
      input: numberField(usage, 'input') ?? 0,
      output: numberField(usage, 'output') ?? 0,
      cacheRead: numberField(usage, 'cacheRead') ?? 0,
      cacheWrite: numberField(usage, 'cacheWrite') ?? 0,
      totalTokens: numberField(usage, 'totalTokens') ?? 0,
      cost: numberField(usage, 'cost') ?? 0,
    },
  } as SubagentRunDetails;
}

function asArtifactResult(details: unknown): { ref: ArtifactRef; preview?: ArtifactPreview } | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  const ref = asArtifactRef(recordField(details, 'artifactRef'));
  if (!ref) {
    return undefined;
  }
  return {
    ref,
    preview: asArtifactPreview(recordField(details, 'artifactPreview')),
  };
}

function asArtifactRef(value: unknown): ArtifactRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringField(value, 'id');
  const kind = stringField(value, 'kind');
  const title = stringField(value, 'title');
  const toolName = stringField(value, 'toolName');
  const createdAt = stringField(value, 'createdAt');
  const summary = stringField(value, 'summary');
  const bytes = numberField(value, 'bytes');
  if (
    !id ||
    !title ||
    !toolName ||
    !createdAt ||
    !summary ||
    bytes === undefined ||
    (kind !== 'json' && kind !== 'table' && kind !== 'dashboard' && kind !== 'image' && kind !== 'text')
  ) {
    return undefined;
  }
  return {
    id,
    kind,
    title,
    toolName,
    createdAt,
    bytes,
    summary,
  };
}

function asArtifactPreview(value: unknown): ArtifactPreview | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    return {
      type: 'text',
      text: value.text,
      truncated: value.truncated === true,
    };
  }
  if (value.type === 'json') {
    return {
      type: 'json',
      data: value.data,
      truncated: value.truncated === true,
    };
  }
  if (value.type === 'image' && typeof value.mimeType === 'string' && typeof value.data === 'string') {
    return {
      type: 'image',
      mimeType: value.mimeType,
      data: value.data,
    };
  }
  return undefined;
}

function isArtifactReadResult(toolName: string | undefined, details: unknown) {
  return toolName === 'read_artifact' || (isRecord(details) && details.artifactRead === true);
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
  if (contentText === undefined) {
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

function asLineListBatchResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): LineListBatchResult | undefined {
  if (toolName !== 'list_metrics') {
    return undefined;
  }

  const detailRecord = isRecord(details) ? details : {};
  const record = parseJsonRecord(content);
  const groups = record ? recordsField(record, 'results').map(metricListBatchGroupFromRecord) : [];
  if (record && groups.length > 0) {
    const groupCount = numberField(record, 'prefixCount') ?? groups.length;
    const totalCount = numberField(detailRecord, 'count') ?? groups.reduce((sum, group) => sum + group.count, 0);

    return {
      groupLabel: 'metric prefix',
      groupLabelPlural: 'metric prefixes',
      groupIndexLabel: 'Prefix',
      itemLabel: 'metric',
      itemLabelPlural: 'metrics',
      datasourceUid: stringField(record, 'datasourceUid') ?? stringField(detailRecord, 'datasourceUid'),
      groupCount,
      totalCount,
      truncated: booleanField(detailRecord, 'truncated') ?? groups.some((group) => group.truncated),
      groups,
      contentAvailable: true,
    };
  }

  // Batch content over the truncation limit does not parse as JSON. Fall back
  // to the batch details so the truncated JSON is never rendered line-by-line
  // as metric names by the single-list view.
  if (booleanField(detailRecord, 'batch') !== true) {
    return undefined;
  }

  const prefixes = stringArrayField(detailRecord, 'prefixes') ?? [];
  const totalCount = numberField(detailRecord, 'count');
  if (prefixes.length === 0 && totalCount === undefined) {
    return undefined;
  }

  return {
    groupLabel: 'metric prefix',
    groupLabelPlural: 'metric prefixes',
    groupIndexLabel: 'Prefix',
    itemLabel: 'metric',
    itemLabelPlural: 'metrics',
    datasourceUid: stringField(detailRecord, 'datasourceUid'),
    groupCount: prefixes.length,
    totalCount: totalCount ?? 0,
    truncated: booleanField(detailRecord, 'truncated') ?? false,
    groups: [],
    contentAvailable: false,
  };
}

function metricListBatchGroupFromRecord(record: Record<string, unknown>): LineListBatchGroup {
  const prefix = stringField(record, 'prefix');
  const metrics = stringArrayField(record, 'metrics') ?? [];
  return {
    label: prefix ? `prefix ${prefix}` : 'all metrics',
    count: numberField(record, 'count') ?? metrics.length,
    truncated: booleanField(record, 'truncated') ?? false,
    items: metrics,
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

  return metricSeriesInspectionFromRecord(record);
}

function asMetricSeriesInspectionBatch(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): MetricSeriesInspectionBatch | undefined {
  if (toolName !== 'inspect_metric_series') {
    return undefined;
  }

  const record = parseJsonRecord(content);
  if (record) {
    const resultRecords = recordsField(record, 'results');
    const matchCount = numberField(record, 'matchCount');
    if (matchCount !== undefined && resultRecords.length > 0) {
      const results = resultRecords
        .map(metricSeriesInspectionFromRecord)
        .filter((result): result is MetricSeriesInspection => Boolean(result));
      return {
        datasourceUid: stringField(record, 'datasourceUid'),
        matchCount,
        truncatedMatches: booleanField(record, 'truncatedMatches') ?? false,
        totalSeries: results.reduce((sum, result) => sum + result.totalSeries, 0),
        results,
        contentAvailable: true,
      };
    }
  }

  if (!isRecord(details) || booleanField(details, 'batch') !== true) {
    return undefined;
  }

  const matchCount = numberField(details, 'matches') ?? numberField(details, 'matchCount');
  if (matchCount === undefined) {
    return undefined;
  }

  return {
    datasourceUid: stringField(details, 'datasourceUid'),
    matchCount,
    truncatedMatches: booleanField(details, 'truncatedMatches') ?? false,
    totalSeries: numberField(details, 'totalSeries') ?? 0,
    results: [],
    contentAvailable: false,
  };
}

function metricSeriesInspectionFromRecord(record: Record<string, unknown>): MetricSeriesInspection | undefined {
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
  details: unknown,
  content: unknown,
  args?: unknown
): PrometheusQuerySummaryView | undefined {
  if (toolName !== 'query_prometheus') {
    return undefined;
  }

  const record = parseToolJsonRecord(content, details);
  if (!record) {
    return undefined;
  }

  const summary = prometheusQuerySummaryFromRecord(record);
  if (!summary) {
    return undefined;
  }

  return enrichPrometheusQuerySummaryFromArgs(summary, args);
}

function asPrometheusBatchQuerySummary(
  toolName: string | undefined,
  details: unknown,
  content: unknown,
  args?: unknown
): PrometheusBatchQuerySummaryView | undefined {
  if (toolName !== 'query_prometheus') {
    return undefined;
  }

  const record = parseToolJsonRecord(content, details);
  if (record) {
    const datasourceUid = stringField(record, 'datasourceUid');
    const queryCount = numberField(record, 'queryCount');
    const resultRecords = recordsField(record, 'results');
    if (datasourceUid && queryCount !== undefined && resultRecords.length > 0) {
      const results = resultRecords
        .map((resultRecord) => {
          const summary = prometheusQuerySummaryFromRecord(resultRecord, { datasourceUid });
          return summary ? enrichPrometheusQuerySummaryFromArgs(summary, args) : undefined;
        })
        .filter((result): result is PrometheusQuerySummaryView => Boolean(result));

      return {
        datasourceUid,
        queryCount,
        truncatedQueries: booleanField(record, 'truncatedQueries') ?? false,
        results,
        contentAvailable: true,
      };
    }
  }

  if (!isRecord(details) || booleanField(details, 'batch') !== true) {
    return undefined;
  }

  const datasourceUid = stringField(details, 'datasourceUid');
  const queryCount = numberField(details, 'queries');
  if (!datasourceUid || queryCount === undefined) {
    return undefined;
  }

  return {
    datasourceUid,
    queryCount,
    truncatedQueries: false,
    results: [],
    contentAvailable: false,
  };
}

function prometheusQuerySummaryFromRecord(
  record: Record<string, unknown>,
  defaults?: { datasourceUid?: string }
): PrometheusQuerySummaryView | undefined {
  const datasourceUid = stringField(record, 'datasourceUid') ?? defaults?.datasourceUid;
  const query = stringField(record, 'query');
  const seriesRecords = recordsField(record, 'series');
  if (!datasourceUid || !query) {
    return undefined;
  }

  const range = recordField(record, 'range');
  const rawRange = recordField(range, 'raw');
  return {
    datasourceUid,
    query,
    queryType: stringField(record, 'queryType') ?? 'query',
    interval: stringField(record, 'interval') ?? '-',
    range: range
      ? {
          from: stringField(range, 'from'),
          to: stringField(range, 'to'),
          raw: rawRange
            ? {
                from: stringField(rawRange, 'from'),
                to: stringField(rawRange, 'to'),
              }
            : undefined,
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

function enrichPrometheusQuerySummaryFromArgs(
  summary: PrometheusQuerySummaryView,
  args: unknown
): PrometheusQuerySummaryView {
  const queryArg = prometheusQueryToolCallQueryForSummary(args, summary);
  const enriched = {
    ...summary,
    queryType: summary.queryType === 'query' ? (queryArg?.type ?? summary.queryType) : summary.queryType,
    interval: summary.interval === '-' ? (queryArg?.interval ?? '1m') : summary.interval,
  };

  return {
    ...enriched,
    visualization:
      prometheusTimeseriesVisualizationFromSummary(enriched) ??
      prometheusTimeseriesVisualizationFromArgs(args, enriched),
  };
}

function prometheusTimeseriesVisualizationFromSummary(
  result: PrometheusQuerySummaryView
): PrometheusTimeseriesVisualization | undefined {
  if (result.queryType !== 'range' || !result.range?.from || !result.range.to || result.interval === '-') {
    return undefined;
  }

  return {
    kind: 'prometheus-timeseries',
    datasourceUid: result.datasourceUid,
    query: result.query,
    interval: result.interval,
    range: {
      from: result.range.from,
      to: result.range.to,
      raw: result.range.raw,
    },
  };
}

function prometheusTimeseriesVisualizationFromArgs(
  args: unknown,
  result: PrometheusQuerySummaryView
): PrometheusTimeseriesVisualization | undefined {
  const queryArg = prometheusQueryToolCallQueryForSummary(args, result);
  if (!queryArg) {
    return undefined;
  }

  const range = prometheusVisualizationRangeFromQueryArg(queryArg, result);
  const interval = queryArg.interval ?? (result.interval !== '-' ? result.interval : '1m');

  return {
    kind: 'prometheus-timeseries',
    datasourceUid: result.datasourceUid,
    query: result.query,
    interval,
    range,
  };
}

function prometheusQueryToolCallQueryForSummary(
  args: unknown,
  result: PrometheusQuerySummaryView
): PrometheusQueryToolCallQuery | undefined {
  const call = prometheusQueryToolCallFromArgs(args, false);
  if (!call) {
    return undefined;
  }

  return (
    call.queries.find((query) => query.query === result.query) ??
    (call.queries.length === 1 ? call.queries[0] : undefined)
  );
}

function prometheusVisualizationRangeFromQueryArg(
  query: PrometheusQueryToolCallQuery,
  result: PrometheusQuerySummaryView
): PrometheusTimeseriesVisualization['range'] {
  if (query.start && query.end) {
    return {
      from: query.start,
      to: query.end,
      raw: { from: query.start, to: query.end },
    };
  }
  if (result.range?.from && result.range.to) {
    return {
      from: result.range.from,
      to: result.range.to,
      raw: result.range.raw,
    };
  }

  const latestTime = latestPrometheusSummaryTime(result);
  if (latestTime) {
    return {
      from: new Date(latestTime.getTime() - 6 * 60 * 60 * 1000).toISOString(),
      to: latestTime.toISOString(),
    };
  }

  return {
    from: 'now-6h',
    to: 'now',
    raw: { from: 'now-6h', to: 'now' },
  };
}

function latestPrometheusSummaryTime(result: PrometheusQuerySummaryView): Date | undefined {
  const times = result.series
    .flatMap((series) => [series.last?.time, series.min?.time, series.max?.time])
    .filter((time): time is string => Boolean(time))
    .map((time) => new Date(time))
    .filter((time) => Number.isFinite(time.getTime()));

  return times.reduce<Date | undefined>(
    (latest, time) => (!latest || time.getTime() > latest.getTime() ? time : latest),
    undefined
  );
}

function asPrometheusTimeseriesVisualization(
  toolName: string | undefined,
  details: unknown
): PrometheusTimeseriesVisualization | undefined {
  if (toolName !== 'query_prometheus' || !isRecord(details)) {
    return undefined;
  }

  const visualization = recordField(details, 'visualization');
  if (stringField(visualization, 'kind') !== 'prometheus-timeseries') {
    return undefined;
  }

  const datasourceUid = stringField(visualization, 'datasourceUid');
  const query = stringField(visualization, 'query');
  const interval = stringField(visualization, 'interval');
  const queryType = stringField(visualization, 'queryType');
  const range = recordField(visualization, 'range');
  const rawRange = recordField(range, 'raw');
  const from = stringField(range, 'from');
  const to = stringField(range, 'to');

  if (!datasourceUid || !query || !interval || queryType !== 'range' || !from || !to) {
    return undefined;
  }

  return {
    kind: 'prometheus-timeseries',
    datasourceUid,
    query,
    interval,
    maxDataPoints: numberField(visualization, 'maxDataPoints'),
    range: {
      from,
      to,
      raw: rawRange
        ? {
            from: stringField(rawRange, 'from'),
            to: stringField(rawRange, 'to'),
          }
        : undefined,
    },
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

function asSkillResourceReadResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): SkillResourceReadResult | undefined {
  if (toolName !== 'read_skill_resource' || !isRecord(details)) {
    return undefined;
  }

  const skill = stringField(details, 'skill');
  const path = stringField(details, 'path');
  if (!skill || !path) {
    return undefined;
  }

  return {
    skill,
    path,
    bytes: numberField(details, 'bytes'),
    truncated: booleanField(details, 'truncated'),
    text: extractToolText(content),
  };
}

const LIVE_DASHBOARD_TOOL_NAMES = new Set([
  'list_live_dashboard_panels',
  'get_live_dashboard_layout',
  'get_live_dashboard_info',
  'list_live_dashboard_variables',
  'get_live_dashboard_mutation_schema',
  'rename_live_dashboard_panel',
  'update_live_dashboard_panel_query',
  'add_live_dashboard_panel',
  'move_or_resize_live_dashboard_panel',
  'update_live_dashboard_settings',
  'add_live_dashboard_variable',
  'update_live_dashboard_variable',
  'apply_live_dashboard_mutation',
]);

function asLiveDashboardMutationSchemaResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): LiveDashboardMutationSchemaResult | undefined {
  if (toolName !== 'get_live_dashboard_mutation_schema') {
    return undefined;
  }

  const detailRecord = isRecord(details) ? details : {};
  const contentRecord = parseJsonRecord(content);
  const availableCommands =
    stringArrayField(detailRecord, 'availableCommands') ??
    stringArrayField(contentRecord ?? {}, 'availableCommands') ??
    [];

  return {
    command: stringField(detailRecord, 'command') ?? stringField(contentRecord, 'command'),
    available: booleanField(contentRecord, 'available'),
    readOnly: booleanField(contentRecord, 'readOnly'),
    availableCommands,
    guidance: contentRecord?.guidance,
  };
}

function asLiveDashboardMutationResult(
  toolName: string | undefined,
  details: unknown
): LiveDashboardMutationResult | undefined {
  if (!toolName || !LIVE_DASHBOARD_TOOL_NAMES.has(toolName) || toolName === 'get_live_dashboard_mutation_schema') {
    return undefined;
  }
  if (!isRecord(details)) {
    return undefined;
  }

  const command = stringField(details, 'command');
  const success = booleanField(details, 'success');
  if (!command || success === undefined) {
    return undefined;
  }

  const visualVerification = recordField(details, 'visualVerification');
  return {
    command,
    success,
    error: stringField(details, 'error'),
    warnings: stringArrayField(details, 'warnings') ?? [],
    changes: recordsField(details, 'changes').map((change) => ({
      path: stringField(change, 'path'),
      previousValue: change.previousValue,
      newValue: change.newValue,
    })),
    payload: details.payload,
    data: details.data,
    availableCommands: stringArrayField(details, 'availableCommands') ?? [],
    visualVerification: visualVerification
      ? {
          status: stringField(visualVerification, 'status'),
          error: stringField(visualVerification, 'error'),
          details: visualVerification.details,
        }
      : undefined,
  };
}

function asDashboardList(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): DashboardListResult | undefined {
  if (toolName !== 'list_dashboards' && toolName !== 'grafana_list_dashboards') {
    return undefined;
  }

  const dashboards = parseToolJsonArray(content, details)
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
  if (toolName !== 'render_dashboard' && toolName !== 'get_dashboard' && toolName !== 'grafana_get_dashboard') {
    return undefined;
  }

  const record = parseToolJsonRecord(content, details);
  if (!record) {
    return undefined;
  }

  const dashboard = recordField(record, 'dashboard') ?? record;
  const meta = recordField(record, 'meta');
  const title = stringField(dashboard, 'title');
  if (!title) {
    return undefined;
  }

  const detailRecord = isRecord(details) ? details : {};
  return {
    title,
    uid: stringField(dashboard, 'uid') ?? stringField(detailRecord, 'uid'),
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

  if (toolName === 'save_dashboard') {
    const status = stringField(details, 'status');
    if (!status) {
      return undefined;
    }
    return {
      title: status === 'success' || status === 'saved' ? 'Dashboard saved' : `Dashboard ${status}`,
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

function parseToolJsonRecord(content: unknown, details: unknown): Record<string, unknown> | undefined {
  return parseJsonRecord(content) ?? artifactPreviewJsonRecord(details);
}

function parseToolJsonArray(content: unknown, details: unknown): unknown[] | undefined {
  return parseJsonArray(content) ?? artifactPreviewJsonArray(details);
}

function artifactPreviewJsonRecord(details: unknown): Record<string, unknown> | undefined {
  const data = artifactPreviewData(details);
  return isRecord(data) ? data : undefined;
}

function artifactPreviewJsonArray(details: unknown): unknown[] | undefined {
  const data = artifactPreviewData(details);
  return Array.isArray(data) ? data : undefined;
}

function artifactPreviewData(details: unknown): unknown {
  if (!isRecord(details)) {
    return undefined;
  }

  const preview = recordField(details, 'artifactPreview');
  return preview?.data;
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
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
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

function formatLabeledCount(value: number, singular: string, plural: string) {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

function formatBoolean(value: boolean | undefined) {
  return value === undefined ? undefined : value ? 'yes' : 'no';
}

function formatShortValue(value: unknown) {
  if (value === undefined || value === null) {
    return '-';
  }
  if (typeof value === 'string') {
    return truncateInline(value, 96);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${formatCount(value.length)} items`;
  }
  if (isRecord(value)) {
    const kind = stringField(value, 'kind') ?? stringField(value, 'type');
    return kind ? truncateInline(kind, 96) : truncateInline(formatJson(value), 96);
  }
  return truncateInline(String(value), 96);
}

function truncateInline(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
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

function formatQueryResultSummaryMeta(result: PrometheusQuerySummaryView) {
  const parts = [result.queryType, `${formatCount(result.totalSeries)} series`];
  if (result.interval !== '-') {
    parts.push(result.interval);
  }
  if (result.truncatedSeries) {
    parts.push('truncated');
  }
  return parts.join(' | ');
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
    return JSON.stringify(value, null, 2) ?? String(value);
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
    minWidth: 0,
    maxWidth: '100%',
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
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    },
    '& pre': {
      whiteSpace: 'pre-wrap',
      overflow: 'auto',
      overflowWrap: 'anywhere',
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
      margin: `${theme.spacing(0.5)} 0 ${theme.spacing(1)}`,
      overflowX: 'auto',
      borderCollapse: 'collapse',
    },
    '& table + p, & table + ul, & table + ol': {
      marginTop: theme.spacing(1),
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
  toolTypeIcon: css({
    color: theme.colors.text.secondary,
    flex: '0 0 auto',
  }),
  toolCall: css({
    display: 'grid',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  toolCallCollapsed: css({
    display: 'grid',
    minWidth: 0,
    maxWidth: '100%',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    '&[open]': {
      gap: theme.spacing(1),
      paddingBottom: theme.spacing(1),
    },
  }),
  toolCallCollapsedSummary: css({
    display: 'grid',
    gridTemplateColumns: 'auto auto auto minmax(0, 1fr)',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(0.75, 1),
    cursor: 'pointer',
    listStyle: 'none',
    '&::marker': {
      content: '""',
    },
    '&::-webkit-details-marker': {
      display: 'none',
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.border}`,
      outlineOffset: theme.spacing(0.5),
      borderRadius: theme.shape.radius.default,
    },
    '& strong': {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  }),
  toolCallCollapsedBody: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(0, 1),
  }),
  toolCallSummaryText: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  toolCallHeader: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  toolCallJson: css({
    margin: 0,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }),
  structuredResult: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    maxWidth: '100%',
  }),
  artifactCard: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    maxWidth: '100%',
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
  }),
  artifactTextPreview: css({
    '& h1, & h2, & h3, & h4, & h5, & h6': {
      margin: `${theme.spacing(1)} 0 ${theme.spacing(0.5)}`,
      lineHeight: 1.35,
      fontWeight: theme.typography.fontWeightMedium,
    },
    '& h1': {
      fontSize: theme.typography.h4.fontSize,
    },
    '& h2': {
      fontSize: theme.typography.h5.fontSize,
    },
    '& h3, & h4, & h5, & h6': {
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  artifactHeader: css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  artifactTitleGroup: css({
    display: 'grid',
    gap: theme.spacing(0.25),
    minWidth: 0,
  }),
  artifactTitle: css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: theme.typography.fontWeightMedium,
  }),
  artifactImagePreview: css({
    display: 'block',
    maxWidth: '100%',
    maxHeight: 420,
    objectFit: 'contain',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  errorCard: css({
    display: 'grid',
    gap: theme.spacing(0.75),
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.error.border}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.error.transparent,
  }),
  errorTitle: css({
    color: theme.colors.error.text,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  errorMessage: css({
    color: theme.colors.text.primary,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }),
  resultSummary: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  jsonSummary: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  compactResult: css({
    display: 'grid',
    minWidth: 0,
    maxWidth: '100%',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    '&[open]': {
      gap: theme.spacing(1),
      paddingBottom: theme.spacing(1),
    },
  }),
  compactResultSummary: css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(0.75, 1),
    cursor: 'pointer',
    listStyle: 'none',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    '&::marker': {
      content: '""',
    },
    '&::-webkit-details-marker': {
      display: 'none',
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.border}`,
      outlineOffset: theme.spacing(0.5),
      borderRadius: theme.shape.radius.default,
    },
  }),
  compactResultText: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  compactResultBody: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(0, 1),
  }),
  prometheusQueryPlanList: css({
    display: 'grid',
    gap: theme.spacing(0.75),
    minWidth: 0,
  }),
  prometheusQueryPlanRow: css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    gridTemplateAreas: '"index meta" "index expression"',
    alignItems: 'center',
    columnGap: theme.spacing(1),
    rowGap: theme.spacing(0.25),
    minWidth: 0,
    padding: theme.spacing(0.75, 1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  prometheusQueryPlanIndex: css({
    gridArea: 'index',
    color: theme.colors.text.primary,
    fontSize: theme.typography.bodySmall.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    whiteSpace: 'nowrap',
  }),
  prometheusQueryPlanMeta: css({
    gridArea: 'meta',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  prometheusQueryPlanExpression: css({
    gridArea: 'expression',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
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
    minWidth: 0,
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
    minWidth: 640,
    '@media (max-width: 700px)': {
      minWidth: 520,
    },
  }),
  metaGrid: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))',
    gap: theme.spacing(1),
    minWidth: 0,
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
    minWidth: 0,
    maxWidth: '100%',
    padding: theme.spacing(1),
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  timeseriesPanel: css({
    minHeight: 320,
    height: 360,
    maxWidth: '100%',
    overflow: 'hidden',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  queryResultList: css({
    display: 'grid',
    gap: theme.spacing(1),
  }),
  queryResultItem: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    '&:hover': {
      borderColor: theme.colors.border.medium,
    },
    '&[open]': {
      borderColor: theme.colors.border.medium,
    },
    '&[open] summary': {
      marginBottom: theme.spacing(1),
    },
  }),
  queryResultSummary: css({
    display: 'grid',
    gridTemplateColumns: 'auto auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
    cursor: 'pointer',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    listStyle: 'none',
    '&::marker': {
      content: '""',
    },
    '&::-webkit-details-marker': {
      display: 'none',
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.border}`,
      outlineOffset: theme.spacing(0.5),
      borderRadius: theme.shape.radius.default,
    },
  }),
  queryResultChevron: css({
    color: theme.colors.text.secondary,
    flexShrink: 0,
  }),
  queryResultIndex: css({
    color: theme.colors.text.primary,
    fontWeight: theme.typography.fontWeightMedium,
    whiteSpace: 'nowrap',
  }),
  queryResultExpression: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  queryResultTitle: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.primary,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  queryResultMeta: css({
    color: theme.colors.text.secondary,
    whiteSpace: 'nowrap',
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
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
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
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
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
    minWidth: 0,
    maxWidth: '100%',
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
  subagentResult: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(0.75, 1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    '&[open]': {
      borderColor: theme.colors.border.medium,
    },
    '&[open] summary': {
      marginBottom: theme.spacing(0.5),
    },
  }),
  subagentResultSummary: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
    cursor: 'pointer',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    listStyle: 'none',
    '&::marker': {
      content: '""',
    },
    '&::-webkit-details-marker': {
      display: 'none',
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.border}`,
      outlineOffset: theme.spacing(0.5),
      borderRadius: theme.shape.radius.default,
    },
  }),
  subagentResultBody: css({
    minWidth: 0,
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
  toolStepBody: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    marginTop: theme.spacing(1),
  }),
  toolStepResult: css({
    minWidth: 0,
  }),
  toolStepResultError: css({
    color: theme.colors.error.text,
  }),
  toolStepText: css({
    marginTop: theme.spacing(1),
  }),
});
