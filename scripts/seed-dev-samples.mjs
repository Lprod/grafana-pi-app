#!/usr/bin/env node

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const GRAFANA_URL = (process.env.GRAFANA_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const GRAFANA_USER = process.env.GRAFANA_USER ?? 'admin';
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD ?? 'admin';
const ALERT_NAMESPACE = process.env.ALERT_NAMESPACE ?? 'default';
const PROMETHEUS_UID = process.env.PROMETHEUS_UID ?? 'prometheus';
const FOLDER_UID = process.env.DEV_SAMPLE_FOLDER_UID ?? 'assistant-dev-samples';
const FOLDER_TITLE = process.env.DEV_SAMPLE_FOLDER_TITLE ?? 'Assistant Dev Samples';

const authHeader = `Basic ${Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASSWORD}`).toString('base64')}`;

const samples = {
  alertDashboardUid: 'alert-troubleshooting-demo',
  alertRuleName: 'alert-troubleshooting-demo-5xx',
  dashboardEditingUid: 'dashboard-editing-demo',
  dashboardContextUid: 'dashboard-context-demo',
  metricServiceUid: 'metric-discovery-service-demo',
  metricInfraUid: 'metric-discovery-infra-demo',
};

await main();

async function main() {
  await waitForGrafana();
  await seedFolder(FOLDER_UID, FOLDER_TITLE);
  await seedAlertTroubleshootingSample();
  await seedDashboardEditingSample();
  await seedDashboardContextSample();
  await seedDashboardMetricDiscoverySamples();
  await verifyPrometheusSample();

  log('Seeded development samples:');
  log(`- Alert troubleshooting: ${dashboardUrl(samples.alertDashboardUid, 'alert-troubleshooting', 'viewPanel=1')}`);
  log(`- Alert rule: ${GRAFANA_URL}/alerting/grafana/${samples.alertRuleName}/view`);
  log(`- Dashboard editing: ${dashboardUrl(samples.dashboardEditingUid, 'dashboard-editing')}`);
  log(`- Dashboard context: ${dashboardUrl(samples.dashboardContextUid, 'dashboard-context')}`);
  log(`- Metric discovery service: ${dashboardUrl(samples.metricServiceUid, 'metric-discovery-service')}`);
  log(`- Metric discovery infra: ${dashboardUrl(samples.metricInfraUid, 'metric-discovery-infra')}`);
}

async function waitForGrafana() {
  const timeoutMs = readPositiveInteger(process.env.GRAFANA_START_TIMEOUT_MS, 120_000);
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await grafanaFetch('/api/health');
      if (response.ok) {
        return;
      }
      lastError = new Error(`Grafana health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(1000);
  }

  throw new Error(`Grafana at ${GRAFANA_URL} did not become healthy: ${lastError?.message ?? 'timed out'}`);
}

async function seedFolder(uid, title) {
  const response = await grafanaFetch('/api/folders', {
    method: 'POST',
    body: { uid, title },
  });

  if (response.status === 409 || response.status === 412) {
    log(`Folder ${uid} already exists.`);
    return;
  }

  await expectOk(response, `create folder ${uid}`);
  log(`Seeded folder ${uid}.`);
}

async function seedAlertTroubleshootingSample() {
  const dashboardUid = samples.alertDashboardUid;
  const ruleName = samples.alertRuleName;

  await upsertDashboard({
    folderUid: FOLDER_UID,
    dashboard: {
      uid: dashboardUid,
      title: 'Alert troubleshooting demo',
      tags: ['assistant-dev-sample', 'alert-troubleshooting'],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-1h', to: 'now' },
      panels: [
        {
          id: 1,
          title: '5xx rate panel',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          fieldConfig: {
            defaults: {
              unit: 'reqps',
              thresholds: {
                mode: 'absolute',
                steps: [
                  { color: 'green', value: null },
                  { color: 'yellow', value: 100 },
                ],
              },
            },
            overrides: [],
          },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
              legendFormat: '5xx request rate',
            },
          ],
        },
      ],
    },
  });

  await deleteAlertRule(ruleName);
  await createAlertRule({
    name: ruleName,
    title: 'High 5xx alert',
    dashboardUid,
    panelId: 1,
    folderUid: FOLDER_UID,
    labels: { severity: 'warning', sample: 'alert-troubleshooting' },
    expressions: {
      A: {
        datasourceUID: PROMETHEUS_UID,
        queryType: '',
        relativeTimeRange: { from: '600s', to: '0s' },
        model: {
          datasource: prometheusDatasource(),
          refId: 'A',
          expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
          range: true,
          instant: false,
        },
      },
      B: {
        datasourceUID: '__expr__',
        queryType: '',
        model: { type: 'reduce', reducer: 'last', expression: 'A', refId: 'B' },
      },
      C: {
        datasourceUID: '__expr__',
        queryType: '',
        source: true,
        model: {
          type: 'threshold',
          expression: 'B',
          conditions: [{ evaluator: { type: 'gt', params: [0] }, reducer: { type: 'last' } }],
          refId: 'C',
        },
      },
    },
  });

  log(`Seeded alert troubleshooting sample ${dashboardUid}.`);
}

async function seedDashboardEditingSample() {
  await upsertDashboard({
    folderUid: FOLDER_UID,
    dashboard: {
      uid: samples.dashboardEditingUid,
      title: 'Dashboard editing demo',
      tags: ['assistant-dev-sample', 'dashboard-editing'],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-6h', to: 'now' },
      panels: [
        {
          id: 1,
          title: 'Request rate panel',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          fieldConfig: { defaults: { unit: 'reqps' }, overrides: [] },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'sum(rate(http_requests_total[5m]))',
              legendFormat: 'requests',
            },
          ],
        },
      ],
    },
  });

  log(`Seeded dashboard editing sample ${samples.dashboardEditingUid}.`);
}

async function seedDashboardContextSample() {
  await upsertDashboard({
    folderUid: FOLDER_UID,
    dashboard: {
      uid: samples.dashboardContextUid,
      title: 'Dashboard context stale demo',
      tags: ['assistant-dev-sample', 'dashboard-context', 'stale'],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-6h', to: 'now' },
      templating: {
        list: [
          {
            name: 'route',
            type: 'custom',
            query: '/,/api/orders,/render/report',
            current: { text: '/render/report', value: '/render/report' },
            options: [
              { text: '/', value: '/' },
              { text: '/api/orders', value: '/api/orders' },
              { text: '/render/report', value: '/render/report', selected: true },
            ],
          },
        ],
      },
      panels: [
        {
          id: 1,
          title: 'Request rate by path',
          type: 'timeseries',
          description: 'Intentionally stale: metric and path label no longer match demo Prometheus data.',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          fieldConfig: { defaults: { unit: 'bytes' }, overrides: [] },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'sum by (path) (rate(http_request_total{job="web",path="$route"}[5m]))',
              legendFormat: '{{path}}',
            },
          ],
        },
        {
          id: 2,
          title: 'HTTP error ratio by path',
          type: 'timeseries',
          description: 'Intentionally stale: status_code/path labels are wrong for the demo data.',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 8, w: 24, h: 8 },
          fieldConfig: { defaults: { unit: 'percentunit' }, overrides: [] },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'sum by (vm,path) (rate(http_request_total{job="web",path="$route",status_code=~"5.."}[5m])) / clamp_min(sum by (vm,path) (rate(http_request_total{job="web",path="$route"}[5m])), 1e-9)',
              legendFormat: '{{vm}} {{path}}',
            },
          ],
        },
        {
          id: 3,
          title: 'p95 latency',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 16, w: 24, h: 8 },
          fieldConfig: { defaults: { unit: 's' }, overrides: [] },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'histogram_quantile(0.95, sum by (le, vm, route) (rate(http_request_duration_seconds_bucket{job="web",route="$route"}[5m])))',
              legendFormat: '{{vm}} {{route}}',
            },
          ],
        },
      ],
    },
  });

  log(`Seeded dashboard context sample ${samples.dashboardContextUid}.`);
}

async function seedDashboardMetricDiscoverySamples() {
  await upsertDashboard({
    folderUid: FOLDER_UID,
    dashboard: {
      uid: samples.metricServiceUid,
      title: 'Metric discovery service demo',
      tags: ['assistant-dev-sample', 'dashboard-metric-discovery'],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-6h', to: 'now' },
      panels: [
        {
          id: 1,
          title: 'HTTP errors and host load',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'sum by (vm, route, status) (rate(http_requests_total{status=~"5.."}[5m]))',
              legendFormat: '{{vm}} {{route}} {{status}}',
            },
            {
              refId: 'B',
              datasource: prometheusDatasource(),
              expr: 'avg by(instance) (node_load1{job="node"})',
              legendFormat: '{{instance}} load',
            },
          ],
        },
        {
          id: 2,
          title: 'Route p95 latency',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 8, w: 24, h: 8 },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'histogram_quantile(0.95, sum by (le, vm, route) (rate(http_request_duration_seconds_bucket[5m])))',
              legendFormat: '{{vm}} {{route}}',
            },
          ],
        },
      ],
    },
  });

  await upsertDashboard({
    folderUid: FOLDER_UID,
    dashboard: {
      uid: samples.metricInfraUid,
      title: 'Metric discovery infra demo',
      tags: ['assistant-dev-sample', 'dashboard-metric-discovery'],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-6h', to: 'now' },
      panels: [
        {
          id: 1,
          title: 'CPU busy by instance',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
              legendFormat: '{{instance}} CPU busy',
            },
          ],
        },
      ],
    },
  });

  log(`Seeded metric discovery samples ${samples.metricServiceUid} and ${samples.metricInfraUid}.`);
}

async function upsertDashboard({ folderUid, dashboard }) {
  const response = await grafanaFetch('/api/dashboards/db', {
    method: 'POST',
    body: {
      folderUid,
      overwrite: true,
      dashboard,
    },
  });
  await expectOk(response, `upsert dashboard ${dashboard.uid}`);
}

async function deleteAlertRule(name) {
  const response = await grafanaFetch(
    `/apis/rules.alerting.grafana.app/v0alpha1/namespaces/${encodeURIComponent(ALERT_NAMESPACE)}/alertrules/${encodeURIComponent(name)}`,
    { method: 'DELETE' }
  );
  if (response.status !== 404) {
    await expectOk(response, `delete alert rule ${name}`);
  }
}

async function createAlertRule({ name, title, dashboardUid, panelId, folderUid, labels, expressions }) {
  const response = await grafanaFetch(
    `/apis/rules.alerting.grafana.app/v0alpha1/namespaces/${encodeURIComponent(ALERT_NAMESPACE)}/alertrules`,
    {
      method: 'POST',
      body: {
        apiVersion: 'rules.alerting.grafana.app/v0alpha1',
        kind: 'AlertRule',
        metadata: {
          name,
          annotations: { 'grafana.app/folder': folderUid },
        },
        spec: {
          title,
          trigger: { interval: '1m' },
          for: '2m',
          noDataState: 'NoData',
          execErrState: 'Error',
          labels,
          annotations: {
            __dashboardUid__: dashboardUid,
            __panelId__: String(panelId),
          },
          panelRef: { dashboardUID: dashboardUid, panelID: panelId },
          expressions,
        },
      },
    }
  );

  await expectOk(response, `create alert rule ${name}`);
}

async function verifyPrometheusSample() {
  const query = 'sum(rate(http_requests_total{status=~"5.."}[5m]))';
  const path = `/api/datasources/uid/${encodeURIComponent(PROMETHEUS_UID)}/resources/api/v1/query?query=${encodeURIComponent(query)}`;
  const response = await grafanaFetch(path);
  if (!response.ok) {
    log(`Prometheus sample query failed with ${response.status}; dashboards were still seeded.`);
    return;
  }

  const body = await response.json();
  const value = body?.data?.result?.[0]?.value?.[1];
  log(value === undefined ? 'Prometheus sample query returned no current series.' : `Prometheus sample query value: ${value}.`);
}

async function grafanaFetch(path, options = {}) {
  const headers = {
    Authorization: authHeader,
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...options.headers,
  };

  return fetch(`${GRAFANA_URL}${path}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function expectOk(response, action) {
  if (response.ok) {
    return;
  }
  const text = await response.text().catch(() => '');
  throw new Error(`${action} failed with HTTP ${response.status}${text ? `: ${text}` : ''}`);
}

function prometheusDatasource() {
  return { uid: PROMETHEUS_UID, type: 'prometheus' };
}

function dashboardUrl(uid, slug, extraQuery) {
  const query = ['orgId=1', 'from=now-1h', 'to=now', extraQuery].filter(Boolean).join('&');
  return `${GRAFANA_URL}/d/${uid}/${slug}?${query}`;
}

function readPositiveInteger(rawValue, fallback) {
  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function log(message) {
  console.log(`[seed-dev-samples] ${message}`);
}
