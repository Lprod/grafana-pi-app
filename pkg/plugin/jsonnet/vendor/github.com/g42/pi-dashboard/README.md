# G42 Dashboard Jsonnet Helpers

Import this library for dashboard Jsonnet that should render to classic Grafana dashboard JSON:

```jsonnet
local d = import 'github.com/g42/pi-dashboard/main.libsonnet';
```

The helpers keep panel objects close to Grafana JSON while calculating row and grid positions for common 24-column layouts.

Use `d.dashboard.new(...)`, `d.row(...)`, `d.layout.full`, `d.layout.twoUp`, `d.layout.threeUp`, `d.layout.fourUp`, and `d.layout.statStrip` to avoid manual `gridPos` arithmetic.

Use `d.panel.table(...)` with `columns=[...]` and `rename={...}` for Prometheus inventory/status tables. It emits `labelsToFields`, `filterFieldsByName`, and `organize` transformations so generated tables do not expose uncontrolled label columns.
