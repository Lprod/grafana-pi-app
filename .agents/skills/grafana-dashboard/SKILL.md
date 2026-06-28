---
name: grafana-dashboard
description: Design, generate, review, live-edit, and sync Grafana dashboards.
---

# Grafana Dashboard Skill

Use this skill when the user asks for a dashboard, panel, row, variable, live dashboard edit, Jsonnet change, managed dashboard sync, or dashboard review.

## Operating Rules

- Treat dashboard generation as a persistent artifact. Only create, update, or live-edit dashboards when the user explicitly asks for a dashboard change.
- For create, update, review, live edit, render, or sync work, call `run_dashboard_agent`; it owns the dashboard workflow and can use either live mutation tools or the session virtual Jsonnet file.
- Inspect available metrics before selecting panel queries. Use `run_dashboard_agent` for dashboard-level planning and `run_query_agent` for narrow metric reconnaissance.
- Prefer live dashboard mutation tools for small on-the-fly edits to the currently open dashboard when those tools are available.
- Prefer managed Jsonnet dashboards for durable generated dashboards and managed copies.
- Use dashboard read tools to inspect existing dashboards before updating them when the user references an existing dashboard.
- Keep generated dashboards focused. A small useful dashboard is better than a broad dashboard with speculative panels.
- For a managed create or update dashboard request, render and sync the managed dashboard after the Jsonnet compiles unless the user explicitly asks for a draft, preview, live-edit, or no-sync workflow.

## Live Editing Workflow

1. Use live edits only for the currently open dashboard and only when live dashboard editing tools are available.
2. Call `list_live_dashboard_panels`, `get_live_dashboard_layout`, `get_live_dashboard_info`, or `list_live_dashboard_variables` before applying changes when you need exact element names, layout paths, dashboard UID, or variable names.
3. Prefer typed live tools: `rename_live_dashboard_panel`, `update_live_dashboard_panel_query`, `add_live_dashboard_panel`, `move_or_resize_live_dashboard_panel`, `update_live_dashboard_settings`, `add_live_dashboard_variable`, and `update_live_dashboard_variable`.
4. Use `apply_live_dashboard_mutation` only for advanced commands that do not have a typed tool.
5. Apply one small live edit at a time.
6. Verify with `list_live_dashboard_panels`, `get_live_dashboard_layout`, `get_live_dashboard_info`, `list_live_dashboard_variables`, or the screenshot attached by layout-affecting live edit tools.
7. If a live mutation fails, inspect panels/layout/variables again and retry with corrected element names or paths before giving up.
8. Do not call `write_jsonnet`, `render_dashboard`, or `sync_dashboard` for a live-edit request unless the user asks for a durable managed dashboard copy.

## Jsonnet Workflow

1. Call `run_dashboard_agent` with the user task, known datasource UID, existing dashboard UID, and intent when available.
2. Let the dashboard agent inspect metrics and existing dashboards, then write or edit the session virtual Jsonnet file.
3. For new dashboards, the dashboard agent should write a self-contained plain Jsonnet object that evaluates directly to a Grafana dashboard object.
4. The dashboard agent should render the dashboard after writing.
5. The dashboard agent should sync the rendered dashboard for create or update requests unless the user explicitly asked for a draft or preview only.

## Jsonnet Rules

- For new dashboards, do not import Grafonnet.
- Do not invent or use Grafonnet constructors such as `g.dashboard.new`, `grafana.dashboard.new`, `g.panel.new`, `grafana.panel.new`, `row.new`, or chained `.with_*` methods.
- Generate a plain object with `title`, stable `uid`, `tags`, `timezone`, `time`, `schemaVersion`, and `panels`.
- Use Grafana's 24-column grid with explicit `gridPos` values.
- Use the selected Prometheus datasource UID directly in panel targets. Do not use datasource variables or unlisted datasource UIDs.
- After the initial `write_jsonnet` call, do not call `write_jsonnet` again in the same session. Use `edit_jsonnet`, `fix_jsonnet`, or `read_jsonnet` for follow-up repairs.

## Panel Guidance

- Use time series panels for trends and rates.
- Use stat panels for single current values.
- Use tables for label-rich summaries.
- Add variables only when they reduce duplicated panels or make filtering materially useful.
- Make legends human-readable and stable.
- Avoid panel queries that require labels or metrics you have not verified.

## Safety

- Do not overwrite an existing managed dashboard without reading it first.
- Do not call sync tools after a draft or preview-only request unless the user explicitly asks to apply or sync.
- If a render fails, fix the Jsonnet before offering the dashboard as complete.
- If metrics are missing, state the gap instead of fabricating panels.
