import type { AgentTool } from '@earendil-works/pi-agent-core';
import { locationService } from '@grafana/runtime';
import { Type } from 'typebox';
import { PLUGIN_BASE_URL } from '../../../constants';
import { textResult, throwIfAborted } from './result';

type NavigateParams = {
  type: 'dashboard' | 'prometheus_explore' | 'app_chat' | 'relative';
  uid?: string;
  slug?: string;
  datasourceUid?: string;
  query?: string;
  start?: string;
  end?: string;
  path?: string;
};

export function createNavigationTools(): AgentTool[] {
  return [navigateTool];
}

const navigateTool: AgentTool = {
  name: 'navigate',
  label: 'Navigate',
  description:
    'Navigate to safe Grafana-relative destinations: dashboards by UID, Prometheus Explore for a query, this app chat, or an explicit relative Grafana path.',
  parameters: Type.Object({
    type: Type.Union(
      [
        Type.Literal('dashboard'),
        Type.Literal('prometheus_explore'),
        Type.Literal('app_chat'),
        Type.Literal('relative'),
      ],
      { description: 'Destination type.' }
    ),
    uid: Type.Optional(Type.String({ description: 'Dashboard UID for dashboard navigation.' })),
    slug: Type.Optional(Type.String({ description: 'Optional dashboard URL slug.' })),
    datasourceUid: Type.Optional(Type.String({ description: 'Prometheus datasource UID for Explore navigation.' })),
    query: Type.Optional(Type.String({ description: 'PromQL expression for Explore navigation.' })),
    start: Type.Optional(Type.String({ description: 'Explore start time. Defaults to now-1h.' })),
    end: Type.Optional(Type.String({ description: 'Explore end time. Defaults to now.' })),
    path: Type.Optional(Type.String({ description: 'Safe relative Grafana path for relative navigation.' })),
  }),
  async execute(_toolCallId, params, signal) {
    throwIfAborted(signal);
    const args = params as NavigateParams;
    const path = buildNavigationPath(args);

    locationService.push(path);

    return textResult(`Opened ${path}`, { path, type: args.type });
  },
};

export function buildNavigationPath(args: NavigateParams) {
  switch (args.type) {
    case 'dashboard':
      return dashboardPath(args);
    case 'prometheus_explore':
      return prometheusExplorePath(args);
    case 'app_chat':
      return `${PLUGIN_BASE_URL}/chat`;
    case 'relative':
      return safeRelativePath(args.path);
  }
}

function dashboardPath(args: NavigateParams) {
  const uid = requiredString(args.uid, 'uid');
  const slug = normalizeSlug(args.slug ?? uid) || uid;
  return `/d/${encodeURIComponent(uid)}/${encodeURIComponent(slug)}`;
}

function prometheusExplorePath(args: NavigateParams) {
  const datasourceUid = requiredString(args.datasourceUid, 'datasourceUid');
  const query = requiredString(args.query, 'query');
  const datasource = {
    type: 'prometheus',
    uid: datasourceUid,
  };
  const left = {
    datasource: datasourceUid,
    queries: [
      {
        refId: 'A',
        datasource,
        expr: query,
        range: true,
        instant: false,
        editorMode: 'code',
      },
    ],
    range: {
      from: args.start ?? 'now-1h',
      to: args.end ?? 'now',
    },
  };

  return `/explore?left=${encodeURIComponent(JSON.stringify(left))}`;
}

function safeRelativePath(path: string | undefined) {
  const value = requiredString(path, 'path');
  if (!value.startsWith('/') || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error('navigate relative path must be a Grafana-relative path starting with /.');
  }
  return value;
}

function requiredString(value: string | undefined, field: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`navigate requires ${field} for this destination type.`);
  }
  return trimmed;
}

function normalizeSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
