import type { AgentTool } from '@earendil-works/pi-agent-core';
import { config } from '@grafana/runtime';
import { Type } from 'typebox';
import { backendFetch } from './client';
import { getDisallowedDashboardDatasourceUids } from './dashboardPolicy';
import { textResult, throwIfAborted, truncateText } from './result';
import type { DashboardSearchResult, DashboardUidParams, GrafanaToolConfig, ListDashboardsParams, ScreenshotParams, UploadDashboardParams } from './types';

const REQUIRED_DASHBOARD_TAG = 'genai';

export function createDashboardTools(toolConfig: GrafanaToolConfig, includeAdHocWrites = false): AgentTool[] {
  const readTools = [grafanaGetDashboardTool, grafanaListDashboardsTool, grafanaScreenshotTool];
  if (!includeAdHocWrites) {
    return readTools;
  }
  return [makeGrafanaUploadDashboardTool(toolConfig), ...readTools, grafanaDeleteDashboardTool];
}

function makeGrafanaUploadDashboardTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'upload_dashboard',
    label: 'Upload dashboard',
    description: 'Create or update a Grafana dashboard JSON model as the current user.',
    parameters: Type.Object({
      dashboard_json: Type.String({ description: 'Grafana dashboard JSON object as a string.' }),
      overwrite: Type.Optional(Type.Boolean({ description: 'Whether to overwrite an existing dashboard UID. Defaults to true.' })),
      folderUid: Type.Optional(Type.String({ description: 'Optional target folder UID.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as UploadDashboardParams;
      throwIfAborted(signal);
      const dashboard = parseDashboard(args.dashboard_json);
      if (!dashboard.title) {
        throw new Error('Dashboard JSON must include a title');
      }
      const disallowedDatasourceUids = getDisallowedDashboardDatasourceUids(dashboard, toolConfig);
      if (disallowedDatasourceUids.length > 0) {
        throw new Error(`Dashboard references datasource UIDs not available to the assistant: ${disallowedDatasourceUids.join(', ')}`);
      }

      dashboard.uid = normalizeDashboardUid(dashboard.uid, String(dashboard.title));
      dashboard.tags = ensureRequiredTag(dashboard.tags);
      delete dashboard.id;

      const result = await backendFetch<{ uid: string; url: string; status: string }>('/api/dashboards/db', {
        method: 'POST',
        data: {
          dashboard,
          folderUid: args.folderUid,
          overwrite: args.overwrite ?? true,
        },
      });

      const absoluteUrl = new URL(result.url, window.location.origin).toString();
      return textResult(`Dashboard uploaded: ${absoluteUrl}\nUID: ${result.uid}\nStatus: ${result.status}`, {
        uid: result.uid,
        url: absoluteUrl,
        status: result.status,
      });
    },
  };
}

const grafanaGetDashboardTool: AgentTool = {
  name: 'get_dashboard',
  label: 'Get dashboard',
  description: 'Fetch a dashboard by UID as the current user.',
  parameters: Type.Object({
    uid: Type.String({ description: 'Dashboard UID.' }),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as DashboardUidParams;
    throwIfAborted(signal);
    const result = await backendFetch<unknown>(`/api/dashboards/uid/${encodeURIComponent(args.uid)}`);
    return textResult(truncateText(JSON.stringify(result, null, 2), 120000), { uid: args.uid });
  },
};

const grafanaListDashboardsTool: AgentTool = {
  name: 'list_dashboards',
  label: 'List dashboards',
  description: 'Search dashboards visible to the current user.',
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: 'Optional dashboard title search text.' })),
    tag: Type.Optional(Type.String({ description: 'Optional dashboard tag filter.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as ListDashboardsParams;
    throwIfAborted(signal);
    const result = await backendFetch<DashboardSearchResult[]>('/api/search', {
      params: {
        type: 'dash-db',
        query: args.query,
        tag: args.tag,
        limit: 100,
      },
    });

    const dashboards = result.map((dash) => ({
      ...dash,
      url: new URL(dash.url, window.location.origin).toString(),
    }));

    return textResult(JSON.stringify(dashboards, null, 2), { count: dashboards.length });
  },
};

const grafanaDeleteDashboardTool: AgentTool = {
  name: 'delete_dashboard',
  label: 'Delete dashboard',
  description: 'Delete a dashboard by UID as the current user.',
  parameters: Type.Object({
    uid: Type.String({ description: 'Dashboard UID.' }),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as DashboardUidParams;
    throwIfAborted(signal);
    const result = await backendFetch<unknown>(`/api/dashboards/uid/${encodeURIComponent(args.uid)}`, {
      method: 'DELETE',
    });
    return textResult(`Dashboard ${args.uid} deleted`, { uid: args.uid, result });
  },
};

const grafanaScreenshotTool: AgentTool = {
  name: 'screenshot_dashboard',
  label: 'Render dashboard screenshot',
  description: 'Render a dashboard or panel image using Grafana image rendering, if configured.',
  parameters: Type.Object({
    uid: Type.String({ description: 'Dashboard UID.' }),
    panelId: Type.Optional(Type.Number({ description: 'Optional panel ID for d-solo rendering.' })),
    from: Type.Optional(Type.String({ description: 'Render start time. Defaults to now-1h.' })),
    to: Type.Optional(Type.String({ description: 'Render end time. Defaults to now.' })),
    width: Type.Optional(Type.Number({ description: 'Image width. Defaults to 1200.' })),
    height: Type.Optional(Type.Number({ description: 'Image height. Defaults to 700.' })),
    theme: Type.Optional(Type.Union([Type.Literal('dark'), Type.Literal('light')], { description: 'Render theme.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as ScreenshotParams;
    throwIfAborted(signal);
    const dashboard = await backendFetch<{ meta: { slug: string } }>(`/api/dashboards/uid/${encodeURIComponent(args.uid)}`);
    const width = clamp(args.width ?? 1200, 300, 2400);
    const height = clamp(args.height ?? 700, 200, 2400);
    const renderPath =
      typeof args.panelId === 'number'
        ? `/render/d-solo/${encodeURIComponent(args.uid)}/${encodeURIComponent(dashboard.meta.slug)}`
        : `/render/d/${encodeURIComponent(args.uid)}/${encodeURIComponent(dashboard.meta.slug)}`;
    const renderUrl = new URL(renderPath, window.location.origin);
    renderUrl.searchParams.set('orgId', String(config.bootData.user.orgId || 1));
    renderUrl.searchParams.set('from', args.from ?? 'now-1h');
    renderUrl.searchParams.set('to', args.to ?? 'now');
    renderUrl.searchParams.set('width', String(width));
    renderUrl.searchParams.set('height', String(height));
    renderUrl.searchParams.set('theme', args.theme ?? 'dark');
    renderUrl.searchParams.set('kiosk', '1');
    if (typeof args.panelId === 'number') {
      renderUrl.searchParams.set('panelId', String(args.panelId));
    }

    const response = await fetch(renderUrl.toString(), { signal });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Grafana render failed (${response.status}). Is image rendering configured? ${errorText}`);
    }

    const data = arrayBufferToBase64(await response.arrayBuffer());
    return {
      content: [
        { type: 'text', text: `Rendered ${args.uid}${args.panelId ? ` panel ${args.panelId}` : ''}.` },
        { type: 'image', data, mimeType: response.headers.get('content-type') || 'image/png' },
      ],
      details: {
        uid: args.uid,
        panelId: args.panelId,
        width,
        height,
      },
    };
  },
};

function parseDashboard(source: string): Record<string, any> {
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Dashboard JSON must be an object');
  }
  return parsed as Record<string, any>;
}

function normalizeDashboardUid(uid: unknown, title: string): string {
  const raw =
    typeof uid === 'string' && uid.trim()
      ? uid.trim()
      : title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');

  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function ensureRequiredTag(tags: unknown): string[] {
  const next = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
  if (!next.includes(REQUIRED_DASHBOARD_TAG)) {
    next.push(REQUIRED_DASHBOARD_TAG);
  }
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
