# Dashboard Jsonnet Workflow

Use this sequence for managed dashboards:

1. `list_jsonnet_files`
2. `read_jsonnet_file` for relevant examples
3. `write_jsonnet_file` with a self-contained plain Jsonnet dashboard object
4. `render_jsonnet_file`
5. `sync_dashboard` for create or update requests unless the user asked for a draft or preview only

For new dashboards, do not import Grafonnet and do not use constructor chains such as `grafana.dashboard.new()` or `.with_*` methods. Write a plain object with explicit `panels`, `targets`, and `gridPos` fields.

Prefer short file names that match the dashboard subject, for example `node-overview.jsonnet` or `service-latency.jsonnet`.

When updating a dashboard:

- Read the current Jsonnet file first.
- Preserve the existing style and helper usage.
- Keep edits scoped to the requested panels or variables.
- Render before reporting completion.
