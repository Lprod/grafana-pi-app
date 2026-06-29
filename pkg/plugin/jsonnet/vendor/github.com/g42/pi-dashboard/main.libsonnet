local refIds = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
];

local has(object, field) = std.objectHas(object, field);
local ceilDiv(value, divisor) = std.floor((value + divisor - 1) / divisor);
local range(length) = if length <= 0 then [] else std.range(0, length - 1);
local sum(values) = std.foldl(function(total, value) total + value, values, 0);
local datasource(uid) = { type: 'prometheus', uid: uid };
local withField(object, field, value) = if value == null then object else object + { [field]: value };

local assignTargetRefs(targets) = [
  targets[index] + {
    refId: if has(targets[index], 'refId') && targets[index].refId != null
    then targets[index].refId
    else refIds[index],
  }
  for index in range(std.length(targets))
];

local panelBase(type, title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={}) =
  local assignedTargets = assignTargetRefs(targets);
  {
    title: title,
    type: type,
    datasource: datasource(datasourceUid),
    targets: assignedTargets,
    fieldConfig: {
      defaults: withField(withField({}, 'unit', unit), 'decimals', decimals) + (if has(fieldConfig, 'defaults') then fieldConfig.defaults else {}),
      overrides: if has(fieldConfig, 'overrides') then fieldConfig.overrides else [],
    },
    options: options,
  };

local group(panels, height) = { panels: panels, height: height };
local layoutFull(panel, h=8) = group([panel + { gridPos: { x: 0, y: 0, w: 24, h: h } }], h);
local layoutTwoUp(panels, h=8) = group([
  panels[index] + { gridPos: { x: (index % 2) * 12, y: std.floor(index / 2) * h, w: 12, h: h } }
  for index in range(std.length(panels))
], ceilDiv(std.length(panels), 2) * h);
local layoutThreeUp(panels, h=8) = group([
  panels[index] + { gridPos: { x: (index % 3) * 8, y: std.floor(index / 3) * h, w: 8, h: h } }
  for index in range(std.length(panels))
], ceilDiv(std.length(panels), 3) * h);
local layoutFourUp(panels, h=8) = group([
  panels[index] + { gridPos: { x: (index % 4) * 6, y: std.floor(index / 4) * h, w: 6, h: h } }
  for index in range(std.length(panels))
], ceilDiv(std.length(panels), 4) * h);
local asGroup(value) = if std.isObject(value) && has(value, 'panels') && has(value, 'height') then value else layoutFull(value);
local shiftPanel(panel, dy) = panel + { gridPos: panel.gridPos + { y: panel.gridPos.y + dy } };
local rowGroupY(groups, index) = sum([groups[groupIndex].height for groupIndex in range(index)]);
local rowHeight(groups) = 1 + sum([group.height for group in groups]);

local rowContentPanels(groups) = std.flattenArrays([
  [shiftPanel(panel, 1 + rowGroupY(groups, groupIndex)) for panel in groups[groupIndex].panels]
  for groupIndex in range(std.length(groups))
]);

local shiftRowPanel(panel, dy) = panel + { gridPos: panel.gridPos + { y: panel.gridPos.y + dy } };
local expandedRowPanels(row, rowY) =
  local rowPanel = {
    title: row.title,
    type: 'row',
    collapsed: row.collapsed,
    gridPos: { x: 0, y: rowY, w: 24, h: 1 },
  };
  if row.collapsed then [rowPanel + { panels: [shiftRowPanel(panel, rowY) for panel in row.panels] }]
  else [rowPanel] + [shiftRowPanel(panel, rowY) for panel in row.panels];

local rowY(rows, index) = sum([rows[rowIndex].height for rowIndex in range(index)]);
local withPanelIds(panels) = [
  panels[index] + {
    id: if has(panels[index], 'id') && panels[index].id != null then panels[index].id else index + 1,
  }
  for index in range(std.length(panels))
];
local tableLabelsToFields() = { id: 'labelsToFields', options: { mode: 'columns' } };
local tableFilterFields(names) = { id: 'filterFieldsByName', options: { include: { names: names } } };
local tableOrganize(order, rename={}) = {
  id: 'organize',
  options: {
    indexByName: { [order[index]]: index for index in range(std.length(order)) },
    renameByName: rename,
  },
};
local slugifyTitle(title) =
  local lower = std.asciiLower(title);
  local replaced = std.foldl(
    function(text, char) std.strReplace(text, char, '-'),
    [' ', '&', '/', '\\', ':', '.', ',', '(', ')', '[', ']', '{', '}', '|'],
    lower
  );
  std.strReplace(std.strReplace(replaced, '--', '-'), '--', '-');
local queryVariable(name, query='', datasourceUid=null, label=null, includeAll=false, multi=false, current=null, refresh=1) =
  withField(
    {
      type: 'query',
      name: name,
      label: if label == null then name else label,
      query: query,
      includeAll: includeAll,
      multi: multi,
      refresh: refresh,
      current: if current == null then null else { text: current, value: current },
    },
    'datasource',
    if datasourceUid == null then null else datasource(datasourceUid)
  );

{
  dashboard: {
    new(title, uid=null, tags=[], timezone='browser', time={ from: 'now-6h', to: 'now' }, refresh='30s', rows=[]):: (
      local expandedRows = [expandedRowPanels(rows[index], rowY(rows, index)) for index in range(std.length(rows))];
      local panels = withPanelIds(std.flattenArrays(expandedRows));
      {
        title: title,
        uid: if uid == null || uid == '' then slugifyTitle(title) else uid,
        tags: tags,
        timezone: timezone,
        time: time,
        refresh: refresh,
        schemaVersion: 39,
        panels: panels,
      }
    ),

    with_time_range(from='now-6h', to='now'):: { time: { from: from, to: to } },
    withTimeRange(from='now-6h', to='now'):: self.with_time_range(from, to),

    with_tags(tags):: { tags: tags },
    withTags(tags):: self.with_tags(tags),

    with_timezone(timezone='browser'):: { timezone: timezone },
    withTimezone(timezone='browser'):: self.with_timezone(timezone),

    with_templating(list):: { templating: { list: list } },
    withTemplating(list):: self.with_templating(list),
    withtemplating(list):: self.with_templating(list),
    with_template(list):: self.with_templating(list),
    with_variables(list):: self.with_templating(list),
  },

  row(title, panels, collapsed=false):: (
    local groups = [asGroup(panelOrGroup) for panelOrGroup in panels];
    {
      title: title,
      collapsed: collapsed,
      height: rowHeight(groups),
      panels: rowContentPanels(groups),
    }
  ),

  layout: {
    full(panel, h=8):: layoutFull(panel, h=h),

    twoUp(panels, h=8):: layoutTwoUp(panels, h=h),

    threeUp(panels, h=8):: layoutThreeUp(panels, h=h),

    fourUp(panels, h=8):: layoutFourUp(panels, h=h),

    statStrip(panels, h=4):: layoutFourUp(panels, h=h),
  },

  prom: {
    datasource(uid):: datasource(uid),

    query(expr, datasourceUid, refId=null, legend='', instant=false, format='time_series'):: (
      local base = {
        datasource: datasource(datasourceUid),
        expr: expr,
        instant: instant,
        range: !instant,
        format: format,
        editorMode: 'code',
      };
      withField(withField(base, 'refId', refId), 'legendFormat', if legend == '' then null else legend)
    ),
  },

  table: {
    labelsToFields():: tableLabelsToFields(),

    filterFields(names):: tableFilterFields(names),

    organize(order, rename={}):: tableOrganize(order, rename),
  },

  templating: {
    list: {
      new(name, datasourceUid=null, query='', label=null, includeAll=false, multi=false, current=null, refresh=1)::
        queryVariable(name, query, datasourceUid, label, includeAll, multi, current, refresh),
    },
  },

  variable: {
    query(name, query='', datasourceUid=null, label=null, includeAll=false, multi=false, current=null, refresh=1)::
      queryVariable(name, query, datasourceUid, label, includeAll, multi, current, refresh),

    datasource(name='datasource', type='prometheus', label=null, current=null)::
      {
        type: 'datasource',
        name: name,
        label: if label == null then name else label,
        query: type,
        current: if current == null then null else { text: current, value: current },
      },
  },

  panel: {
    timeseries(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={}):: (
      panelBase('timeseries', title, datasourceUid, targets, unit, decimals, options, fieldConfig)
    ),

    stat(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={}):: (
      panelBase('stat', title, datasourceUid, targets, unit, decimals, options, fieldConfig)
    ),

    table(title, datasourceUid, targets=[], columns=[], rename={}, transformations=[], options={}, fieldConfig={}):: (
      local controlledTransforms =
        if std.length(columns) == 0 then []
        else [tableLabelsToFields(), tableFilterFields(columns), tableOrganize(columns, rename)];
      panelBase('table', title, datasourceUid, targets, null, null, options, fieldConfig) + {
        transformations: controlledTransforms + transformations,
      }
    ),
  },
}
