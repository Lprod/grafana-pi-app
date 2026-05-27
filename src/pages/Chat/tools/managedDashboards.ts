import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { pluginResourceFetch } from './client';
import { assertManagedDashboardDatasourceAllowed } from './dashboardPolicy';
import { textResult, throwIfAborted, truncateText } from './result';
import type { GrafanaToolConfig, ManagedDashboardParams, ManagedDashboardTemplateSourceParams, ManagedDashboardToolSet } from './types';

export function createManagedDashboardTools(toolConfig: GrafanaToolConfig): ManagedDashboardToolSet {
  const listTemplates = makeGrafanaListManagedDashboardTemplatesTool();
  const listManaged = makeGrafanaListManagedDashboardsTool();
  const render = makeGrafanaRenderManagedDashboardTool(toolConfig);
  const sync = makeGrafanaSyncManagedDashboardTool(toolConfig);
  const readTemplate = makeReadManagedDashboardTemplateTool();

  return {
    all: [listTemplates, listManaged, render, sync, readTemplate],
    listTemplates,
    listManaged,
    render,
    sync,
    readTemplate,
  };
}

function makeGrafanaListManagedDashboardTemplatesTool(): AgentTool {
  return {
    name: 'grafana_list_managed_dashboard_templates',
    label: 'List managed dashboard templates',
    description: 'List Jsonnet/Grafonnet dashboard templates bundled with this app.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      throwIfAborted(signal);
      const result = await pluginResourceFetch<{ templates: unknown[] }>('/managed-dashboards/templates');
      return textResult(JSON.stringify(result.templates, null, 2), { count: result.templates.length });
    },
  };
}

function makeGrafanaListManagedDashboardsTool(): AgentTool {
  return {
    name: 'grafana_list_managed_dashboards',
    label: 'List managed dashboards',
    description: 'List dashboards currently managed by this app plugin, including stored template configuration when available.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      throwIfAborted(signal);
      const result = await pluginResourceFetch<{ dashboards: unknown[] }>('/managed-dashboards');
      return textResult(JSON.stringify(result.dashboards, null, 2), { count: result.dashboards.length });
    },
  };
}

function makeGrafanaRenderManagedDashboardTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'grafana_render_managed_dashboard',
    label: 'Render managed dashboard',
    description: 'Render an app-managed Jsonnet/Grafonnet dashboard template without saving it.',
    parameters: managedDashboardParameters(),
    async execute(_toolCallId, params, signal) {
      const args = params as ManagedDashboardParams;
      throwIfAborted(signal);
      assertManagedDashboardDatasourceAllowed(toolConfig, args.datasourceUid);
      const result = await pluginResourceFetch<unknown>('/managed-dashboards/render', { method: 'POST', data: args });
      return textResult(truncateText(JSON.stringify(result, null, 2), 120000), {
        templateId: args.templateId ?? 'service-red',
        datasourceUid: args.datasourceUid,
      });
    },
  };
}

function makeGrafanaSyncManagedDashboardTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'grafana_sync_managed_dashboard',
    label: 'Sync managed dashboard',
    description: 'Create or update a dashboard from an app-managed Jsonnet/Grafonnet template. The Grafana UI remains read-only; future edits should go through this app.',
    parameters: managedDashboardParameters(),
    async execute(_toolCallId, params, signal) {
      const args = params as ManagedDashboardParams;
      throwIfAborted(signal);
      assertManagedDashboardDatasourceAllowed(toolConfig, args.datasourceUid);
      const result = await pluginResourceFetch<{ uid: string; url: string; status: string; sourceChecksum: string }>('/managed-dashboards/sync', {
        method: 'POST',
        data: args,
      });
      return textResult(`Managed dashboard ${result.status}: ${result.url}\nUID: ${result.uid}\nSource: ${result.sourceChecksum}`, result);
    },
  };
}

function makeReadManagedDashboardTemplateTool(): AgentTool {
  return {
    name: 'read_managed_dashboard_template',
    label: 'Read managed dashboard template',
    description: 'Read source lines from a bundled app-managed Jsonnet dashboard template.',
    parameters: Type.Object({
      templateId: Type.String({ description: 'Bundled managed dashboard template ID, such as service-red.' }),
      offset: Type.Optional(Type.Number({ description: '1-based start line. Defaults to 1.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of lines. Defaults to 200 and caps at 500.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as ManagedDashboardTemplateSourceParams;
      throwIfAborted(signal);
      const result = await pluginResourceFetch<unknown>('/managed-dashboards/template-source', { method: 'POST', data: args });
      return textResult(truncateText(JSON.stringify(result, null, 2), 80000), { templateId: args.templateId });
    },
  };
}

function managedDashboardParameters() {
  return Type.Object({
    templateId: Type.Optional(Type.String({ description: 'Bundled managed dashboard template ID. Defaults to service-red.' })),
    uid: Type.Optional(Type.String({ description: 'Optional dashboard UID. Defaults to a normalized UID from the title.' })),
    title: Type.Optional(Type.String({ description: 'Dashboard title.' })),
    datasourceUid: Type.String({ description: 'Prometheus datasource UID. Must be returned by grafana_get_datasources.' }),
    folderUid: Type.Optional(Type.String({ description: 'Optional folder UID.' })),
    job: Type.Optional(Type.String({ description: 'Optional Prometheus job label value used by the service-red template.' })),
    tags: Type.Optional(Type.Array(Type.String(), { description: 'Optional extra dashboard tags.' })),
    overwrite: Type.Optional(Type.Boolean({ description: 'Whether to update an existing dashboard with the same UID. Defaults to true.' })),
  });
}
