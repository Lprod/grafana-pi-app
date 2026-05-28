local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';

local cfg = std.extVar('config');
local datasourceUid = cfg.datasourceUid;
local title = std.get(cfg, 'title', 'Prometheus Dashboard');
local uid = std.get(cfg, 'uid', '');
local from = std.get(cfg, 'from', 'now-6h');
local to = std.get(cfg, 'to', 'now');
local configuredPanels = std.get(cfg, 'panels', []);
local panels =
  if std.length(configuredPanels) > 0 then configuredPanels else [
    {
      type: 'text',
      title: 'Dashboard',
      content: 'No panels were configured for this managed dashboard.',
      h: 5,
      w: 24,
      x: 0,
      y: 0,
    },
  ];

local panelTitle(panel, fallback) = std.get(panel, 'title', fallback);
local panelX(panel, index) = std.get(panel, 'x', (index % 2) * 12);
local panelY(panel, index) = std.get(panel, 'y', std.floor(index / 2) * 8);
local panelW(panel) = std.get(panel, 'w', 12);
local panelH(panel) = std.get(panel, 'h', 8);

local grid(panel, index) =
  {
    h: panelH(panel),
    w: panelW(panel),
    x: panelX(panel, index),
    y: panelY(panel, index),
  };

local prom(panel) =
  g.query.prometheus.new(datasourceUid, panel.expr)
  + g.query.prometheus.withRefId(std.get(panel, 'refId', 'A'))
  + g.query.prometheus.withRange(true)
  + g.query.prometheus.withEditorMode('code')
  + (if std.get(panel, 'legend', '') == '' then {} else g.query.prometheus.withLegendFormat(panel.legend));

local standardOptions(panel, builder) =
  builder
  + g.panel.timeSeries.standardOptions.withUnit(std.get(panel, 'unit', 'none'))
  + (if std.objectHas(panel, 'decimals') then g.panel.timeSeries.standardOptions.withDecimals(panel.decimals) else {});

local timeseries(panel, index) =
  standardOptions(
    panel,
    g.panel.timeSeries.new(panelTitle(panel, 'Time series'))
    + g.panel.timeSeries.panelOptions.withGridPos(h=grid(panel, index).h, w=grid(panel, index).w, x=grid(panel, index).x, y=grid(panel, index).y)
    + g.panel.timeSeries.queryOptions.withDatasource('prometheus', datasourceUid)
    + g.panel.timeSeries.queryOptions.withTargets([prom(panel)])
    + g.panel.timeSeries.queryOptions.withInterval(std.get(panel, 'interval', '30s'))
  );

local text(panel, index) =
  g.panel.text.new(panelTitle(panel, 'Text'))
  + g.panel.text.panelOptions.withGridPos(h=grid(panel, index).h, w=grid(panel, index).w, x=grid(panel, index).x, y=grid(panel, index).y)
  + g.panel.text.options.withMode(std.get(panel, 'mode', 'markdown'))
  + g.panel.text.options.withContent(std.get(panel, 'content', ''));

local renderPanel(panel, index) =
  if std.get(panel, 'type', 'timeseries') == 'text'
  then text(panel, index)
  else timeseries(panel, index);

{}
+ g.dashboard.withTitle(title)
+ g.dashboard.withUid(uid)
+ g.dashboard.withTags(['genai', 'managed-by-pi', 'prometheus-dashboard'])
+ g.dashboard.withSchemaVersion(41)
+ g.dashboard.withRefresh('30s')
+ g.dashboard.withEditable(false)
+ g.dashboard.time.withFrom(from)
+ g.dashboard.time.withTo(to)
+ g.dashboard.withPanels(std.mapWithIndex(function(index, panel) renderPanel(panel, index), panels))
