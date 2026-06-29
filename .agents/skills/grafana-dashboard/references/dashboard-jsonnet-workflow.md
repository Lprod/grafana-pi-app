# Dashboard Jsonnet Workflow

Use this sequence for Jsonnet dashboards:

1. `read_skill_resource` for `references/example.md` or `templates/prometheus.md` when you need a concrete helper example
2. `write_jsonnet` with Jsonnet that evaluates to a classic Grafana dashboard object
3. `render_dashboard`
4. Repair material validation warnings from render output
5. `save_dashboard` for create or update requests unless the user asked for a draft or preview only

For new dashboards, prefer the bundled helper library:

```jsonnet
local d = import 'github.com/g42/pi-dashboard/main.libsonnet';
```

Use `d.dashboard.new(title=..., uid=..., rows=[...])`, `d.row`, `d.layout.full`, `d.layout.twoUp`, `d.layout.threeUp`, `d.layout.fourUp`, `d.layout.statStrip`, `d.panel.timeseries`, `d.panel.stat`, `d.panel.table`, and `d.prom.query`.

Do not import Grafonnet and do not use constructor chains such as `grafana.dashboard.new()` or `.with_*` methods. If you write raw panels instead of helper calls, write a plain object with explicit `panels`, `targets`, and `gridPos` fields.

If variables are needed, use a plain Grafana templating object:

```jsonnet
+ {
  templating: {
    list: [
      d.variable.query(
        name='job',
        datasourceUid='prometheus',
        query='label_values(up, job)',
        label='Job',
        includeAll=true,
        multi=true,
      ),
    ],
  },
}
```

For tables, pass explicit `columns=[...]` and `rename={...}` to `d.panel.table` so the generated panel filters and organizes visible columns.

Prefer short file names that match the dashboard subject, for example `node-overview.jsonnet` or `service-latency.jsonnet`.

When updating a dashboard:

- Read the current Jsonnet file first.
- Preserve the existing style and helper usage.
- Keep edits scoped to the requested panels or variables.
- Render before reporting completion.
