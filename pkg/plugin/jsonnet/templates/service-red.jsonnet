local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';

local cfg = std.extVar('config');
local datasourceUid = cfg.datasourceUid;
local title = std.get(cfg, 'title', 'Service RED');
local uid = std.get(cfg, 'uid', '');
local job = std.get(cfg, 'job', '');
local labels(extra='') =
  local entries = std.filter(function(entry) entry != '', [
    if job == '' then '' else 'job=' + std.escapeStringJson(job),
    extra,
  ]);
  if std.length(entries) == 0 then '' else '{' + std.join(',', entries) + '}';
local selector(metric, extra='') = metric + labels(extra);

local prom(refId, expr, legend='') =
  g.query.prometheus.new(datasourceUid, expr)
  + g.query.prometheus.withRefId(refId)
  + g.query.prometheus.withRange(true)
  + g.query.prometheus.withEditorMode('code')
  + (if legend == '' then {} else g.query.prometheus.withLegendFormat(legend));

local timeseries(title, x, y, expr, unit, legend='') =
  g.panel.timeSeries.new(title)
  + g.panel.timeSeries.panelOptions.withGridPos(h=8, w=12, x=x, y=y)
  + g.panel.timeSeries.queryOptions.withDatasource('prometheus', datasourceUid)
  + g.panel.timeSeries.queryOptions.withTargets([prom('A', expr, legend)])
  + g.panel.timeSeries.standardOptions.withUnit(unit);

{}
+ g.dashboard.withTitle(title)
+ g.dashboard.withUid(uid)
+ g.dashboard.withTags(['genai', 'managed-by-pi'])
+ g.dashboard.withSchemaVersion(41)
+ g.dashboard.withRefresh('30s')
+ g.dashboard.withEditable(false)
+ g.dashboard.time.withFrom('now-6h')
+ g.dashboard.time.withTo('now')
+ g.dashboard.withPanels([
  timeseries(
    'Request rate',
    0,
    0,
    'sum(rate(' + selector('http_requests_total') + '[$__rate_interval]))',
    'reqps',
    '{{method}} {{route}}'
  ),
  timeseries(
    'Error ratio',
    12,
    0,
    'sum(rate(' + selector('http_requests_total', 'status=~"5.."') + '[$__rate_interval])) / sum(rate(' + selector('http_requests_total') + '[$__rate_interval]))',
    'percentunit',
    '{{route}}'
  ),
  timeseries(
    'P95 latency',
    0,
    8,
    'histogram_quantile(0.95, sum(rate(' + selector('http_request_duration_seconds_bucket') + '[$__rate_interval])) by (le, route))',
    's',
    '{{route}}'
  ),
  timeseries(
    'Saturation',
    12,
    8,
    'avg(1 - rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval]))',
    'percentunit',
    '{{instance}}'
  ),
])
