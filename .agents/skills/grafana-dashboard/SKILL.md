---
name: grafana-dashboard
description: Design, generate, review, and sync Grafana dashboards using Jsonnet-managed plugin resources.
---

# Grafana Dashboard Skill

Use this skill when the user asks for a dashboard, panel, row, variable, Jsonnet change, managed dashboard sync, or dashboard review.

## Operating Rules

- Treat dashboard generation as a persistent artifact. Only create or update dashboard files when the user explicitly asks for a dashboard or dashboard change.
- Inspect available metrics before selecting panel queries. Use the metric tools or `explore_metrics` for query discovery.
- Prefer managed Jsonnet dashboards for durable changes.
- Use dashboard read tools to inspect existing dashboards before updating them when the user references an existing dashboard.
- Keep generated dashboards focused. A small useful dashboard is better than a broad dashboard with speculative panels.
- For a create or update dashboard request, render and sync the managed dashboard after the Jsonnet compiles unless the user explicitly asks for a draft, preview, or no-sync workflow.

## Jsonnet Workflow

1. List existing Jsonnet dashboard files before deciding whether to create or update one.
2. Read nearby examples and reuse local structure, helper functions, and naming conventions.
3. For new dashboards, write a self-contained plain Jsonnet object that evaluates directly to a Grafana dashboard object.
4. Render the dashboard after writing.
5. Sync the rendered dashboard for create or update requests unless the user explicitly asked for a draft or preview only.

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
