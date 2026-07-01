import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { DashboardMutationAPI, DataSourceApi, DataSourceInstanceSettings } from '@grafana/data';
import type { PiAppJsonData, PiAppThinkingLevel } from '../../../types';
import type { SkillToolGroup } from '../skills/types';
import type { ArtifactRuntime } from './artifacts';

export type GrafanaToolConfig = Pick<PiAppJsonData, 'allowedPrometheusDatasourceUids'>;

export type GrafanaToolRuntime = {
  model: Model<any>;
  streamFn: StreamFn;
  thinkingLevel: PiAppThinkingLevel;
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  emitToolUpdate?: (update: GrafanaToolRuntimeToolUpdate) => void;
};

export type GrafanaToolRuntimeToolUpdate = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: AgentToolResult<any>;
};

export type InvestigationReportStatus = 'active' | 'complete';

export type InvestigationReport = {
  id: string;
  title: string;
  status: InvestigationReportStatus;
  scope: string[];
  evidence: string[];
  hypotheses: string[];
  ruledOut: string[];
  nextSteps: string[];
  remediation: string[];
  updatedAt: string;
};

export type InvestigationReportPatch = {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
};

export type InvestigationReportRuntime = {
  getReport: () => InvestigationReport | undefined;
  setReport: (report: InvestigationReport) => void;
};

export type VirtualJsonnetFileSnapshot = {
  path: string;
  content: string;
  version: number;
  checksum: string;
  lineCount: number;
  dashboardJsonnetSize: number;
  updatedAt?: string;
};

export type VirtualJsonnetFileRuntime = {
  getSessionId: () => string | undefined;
  getFile: (path: string) => VirtualJsonnetFileSnapshot | undefined;
  setFile: (file: VirtualJsonnetFileSnapshot, options?: { hydrated?: boolean }) => void;
  isHydrated?: (path: string, version: number) => boolean;
  markHydrated?: (path: string, version: number) => void;
};

export type DashboardSaveFolderSelection = {
  uid?: string;
  title?: string;
};

export type DashboardSaveFolderRuntime = {
  getFolderOverride: (toolCallId: string) => DashboardSaveFolderSelection | undefined;
  clearFolderOverride: (toolCallId: string) => void;
};

export type CreateGrafanaToolsOptions = GrafanaToolConfig & {
  runtime?: GrafanaToolRuntime;
  dashboardMutation?: DashboardMutationAPI;
  virtualJsonnetFiles?: VirtualJsonnetFileRuntime;
  dashboardSaveFolders?: DashboardSaveFolderRuntime;
  investigationReport?: InvestigationReportRuntime;
  artifacts?: ArtifactRuntime;
  skillTools?: AgentTool[];
  includeAdHocDashboardTools?: boolean;
  includeJsonnetLibraryTools?: boolean;
  includeRawPrometheusQueryTool?: boolean;
};

export type ResourceCapableDataSource = DataSourceApi & {
  getResource?: <T = unknown>(path: string, params?: Record<string, unknown>) => Promise<T>;
};

export type PrometheusMetadataResponse<T> = {
  status?: string;
  data?: T;
  error?: string;
};

export type DashboardSearchResult = {
  title: string;
  uid: string;
  url: string;
  folderTitle?: string;
  folderUid?: string;
};

export type DatasourceParams = {
  datasourceUid?: string;
};

export type ListMetricsParams = DatasourceParams & {
  prefix?: string;
  prefixes?: string[];
};

export type ListLabelValuesParams = DatasourceParams & {
  label: string;
  match?: string;
};

export type InspectMetricSeriesParams = DatasourceParams & {
  match?: string;
  matches?: string[];
  limit?: number;
};

export type PrometheusQuerySpec = {
  query: string;
  type?: 'instant' | 'range';
  start?: string;
  end?: string;
};

export type QueryPrometheusParams = DatasourceParams &
  Partial<PrometheusQuerySpec> & {
    queries?: PrometheusQuerySpec[];
  };

export type UploadDashboardParams = {
  dashboard_json: string;
  overwrite?: boolean;
  folderUid?: string;
};

export type JsonnetDashboardParams = {
  dashboard_jsonnet?: string;
  path?: string;
  sessionId?: string;
  uid?: string;
  folderUid?: string;
  tags?: string[];
  overwrite?: boolean;
};

export type DashboardUidParams = {
  uid: string;
};

export type ListDashboardsParams = {
  query?: string;
  tag?: string;
};

export type ScreenshotParams = DashboardUidParams & {
  panelId?: number;
  from?: string;
  to?: string;
  width?: number;
  height?: number;
  theme?: 'dark' | 'light';
};

export type JsonnetLibSearchParams = {
  pattern: string;
  path?: string;
};

export type JsonnetLibReadParams = {
  path: string;
  offset?: number;
  limit?: number;
};

export type JsonnetLibListParams = {
  path?: string;
};

export type SkillResourceReadParams = {
  skill: string;
  path: string;
};

export type JsonnetFileWriteParams = {
  path?: string;
  content: string;
};

export type JsonnetFileEditParams = {
  path?: string;
  baseVersion?: number;
  edits: JsonnetLineEdit[];
};

export type JsonnetFileRepairParams = {
  path?: string;
  baseVersion?: number;
  error?: string;
};

export type JsonnetLineEdit = {
  startLine: number;
  endLine: number;
  replacement: string;
  expectedText?: string;
};

export type JsonnetFileReadParams = {
  path?: string;
  offset?: number;
  limit?: number;
};

export type JsonnetDashboardToolSet = {
  all: AgentTool[];
  render: AgentTool;
  save: AgentTool;
};

export type JsonnetFileToolSet = {
  all: AgentTool[];
  write: AgentTool;
  edit: AgentTool;
  fix: AgentTool;
  read: AgentTool;
};

export type JsonnetLibToolSet = {
  all: AgentTool[];
  search: AgentTool;
  read: AgentTool;
  list: AgentTool;
};

export type GrafanaToolRegistry = {
  metrics: AgentTool[];
  alerts: AgentTool[];
  dashboardMetricContext: AgentTool[];
  dashboards: AgentTool[];
  liveDashboardEditing: AgentTool[];
  jsonnetDashboards: JsonnetDashboardToolSet;
  jsonnetFiles: JsonnetFileToolSet;
  investigation: AgentTool[];
  jsonnet: JsonnetLibToolSet;
  artifacts: AgentTool[];
  subagents: AgentTool[];
  skills: AgentTool[];
  all: AgentTool[];
};

export type DatasourceSettings = DataSourceInstanceSettings[];
export type { SkillToolGroup };
