import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { DataSourceApi, DataSourceInstanceSettings } from '@grafana/data';
import type { PiAppJsonData } from '../../../types';

export type GrafanaToolConfig = Pick<PiAppJsonData, 'allowedDatasourceUids'>;

export type GrafanaToolRuntime = {
  model: Model<any>;
  streamFn: StreamFn;
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

export type CreateGrafanaToolsOptions = GrafanaToolConfig & {
  runtime?: GrafanaToolRuntime;
  virtualJsonnetFiles?: VirtualJsonnetFileRuntime;
  includeAdHocDashboardTools?: boolean;
  includeJsonnetLibraryTools?: boolean;
  includeRawPrometheusQueryTool?: boolean;
  includeMetricsSubagentTool?: boolean;
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
};

export type ListLabelValuesParams = DatasourceParams & {
  label: string;
  match?: string;
};

export type InspectMetricSeriesParams = DatasourceParams & {
  match: string;
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

export type ManagedDashboardParams = {
  dashboard_jsonnet?: string;
  path?: string;
  sessionId?: string;
  uid?: string;
  folderUid?: string;
  tags?: string[];
  overwrite?: boolean;
};

export type ManagedDashboardSourceParams = {
  uid: string;
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

export type ManagedDashboardToolSet = {
  all: AgentTool[];
  listManaged: AgentTool;
  getSource: AgentTool;
  render: AgentTool;
  sync: AgentTool;
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
  dashboards: AgentTool[];
  managedDashboards: ManagedDashboardToolSet;
  jsonnetFiles: JsonnetFileToolSet;
  jsonnet: JsonnetLibToolSet;
  subagents: AgentTool[];
  all: AgentTool[];
};

export type DatasourceSettings = DataSourceInstanceSettings[];
