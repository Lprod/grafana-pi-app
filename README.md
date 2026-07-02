# Observability Analyst

Observability Analyst is a Grafana app plugin that embeds an LLM analyst for observability work. The analyst runs in a Grafana-native React UI, uses the current Grafana user's datasource and dashboard permissions, and calls an OpenAI-compatible LLM through the plugin backend so API keys stay server-side.

## What it does

- Discovers Prometheus datasources visible to the current user.
- Lists metric names and label values through Grafana datasource resource APIs.
- Runs PromQL through Grafana datasource query APIs, returning compact min/max/last/sample summaries for range queries by default.
- Extracts Prometheus metric usage from existing dashboards, including panel co-usage, labels, grouping labels, functions, and related metric neighborhoods.
- Creates app-managed dashboards from model-authored Jsonnet source. The source is stored with each dashboard so future edits can update the Jsonnet and re-sync through the app.
- Lists, fetches, and screenshots dashboards through Grafana APIs.
- Adds dashboard panel menu actions for contextual Assistant prompts.
- Optionally runs as the `grafana-assistant-app` variant with Grafana's extension sidebar integration enabled.
- In the `grafana-assistant-app` variant, can use Grafana's restricted dashboard mutation API for approved typed live edits to the currently open dashboard, including panel rename/query/add/move, dashboard settings, and custom/query variables.
- Keeps broad metric reconnaissance available through a restricted metrics subagent.
- Stores chat sessions per Grafana user with plugin user storage.

## Plugin variants

The default plugin ID is `g42-pi-app`. This is the normal build and keeps Assistant in the app route at `/a/g42-pi-app/chat`.

Release builds also include an alternate plugin ID asset named `grafana-assistant-app-<version>.zip`. This variant is intended for self-managed Grafana instances whose admins want the extra Grafana extension sidebar behavior. The variant keeps the same Assistant implementation, but changes the plugin ID to `grafana-assistant-app` and adds the extension-sidebar declarations that Grafana requires for the global sidebar.

In the sidebar-capable variant:

- Grafana's topbar shows an `Open Assistant` button on non-Assistant routes.
- Dashboard panel menu actions such as `Explain in Assistant`, `Troubleshoot panel`, and `Suggest improvements` open Assistant in the sidebar with panel context.
- The sidebar can open the same chat on the full Assistant page.
- The full Assistant page has `Dock to side`, which saves the current chat session or dashboard-launch context, returns to the last non-Assistant route, and reopens the same chat in the sidebar.
- The Assistant app route hides its own global sidebar entry, so users do not open Assistant beside Assistant.
- When Grafana exposes `dashboardMutationAPI` to `grafana-assistant-app`, Assistant can list the currently open dashboard panels/layout/settings/variables and apply approved typed live edits such as renaming a panel, changing a query, adding or moving a panel, updating dashboard settings, and adding or updating variables. Layout-affecting typed edits attach screenshot verification when Grafana image rendering is configured.

The alternate release asset name intentionally does not include `sidebar`; the feature is implicit in the `grafana-assistant-app` plugin ID. If you install the alternate asset unsigned in a local or self-managed instance, configure Grafana to allow the `grafana-assistant-app` unsigned plugin ID. Live dashboard editing also requires Grafana's restricted plugin API feature and allow-list entry for `dashboardMutationAPI = grafana-assistant-app`; Grafana 13 defaults include that allow-list, and the local variant Compose service enables the feature toggle.

## Configuration

Configure the app plugin from Grafana's plugin settings page:

- `openAIBaseUrl`: OpenAI-compatible API base URL, for example `https://api.openai.com/v1`.
- `defaultModel`: Central model ID used for all assistant requests, for example `gpt-4.1`.
- `thinkingLevel`: Optional model reasoning effort, one of `off`, `low`, `medium`, or `high`. Defaults to `off`.
- `thinkingFormat`: OpenAI-compatible thinking parameter format, one of `openai`, `qwen`, or `qwen-chat-template`. Defaults to `openai`.
- `systemPromptAddendum`: Optional central instructions appended to the built-in system prompt. Do not include secrets because this is stored in `jsonData`.
- `allowedPrometheusDatasourceUids`: Optional list of Prometheus datasource UIDs the assistant may discover, query, and reference in uploaded dashboards. Leave empty to allow all Prometheus datasources visible to the current Grafana user.
- `customSkills`: Optional non-secret skill definitions stored in `jsonData`. Users activate explicit custom skills with `$skill-name`; admins can also configure keyword or regex activation.
- `openAIAPIKey`: Secret API key stored in `secureJsonData`.

Chat users cannot override the model, system prompt addendum, or datasource allow-list from the assistant page. The backend always uses the centrally configured model and appends the configured system prompt addendum when proxying LLM requests, and Grafana datasource tools enforce the central allow-list before querying.

For local Docker provisioning, `provisioning/plugins/app.yaml` reads `OPENAI_API_KEY`.
The local demo config points Grafana at `http://host.docker.internal:8080/v1`, sets the model to the Qwen llama-server model, enables medium `qwen-chat-template` thinking, and limits assistant datasource access to the provisioned `prometheus` datasource.
When `OPENAI_API_KEY` is unset, Compose provides a local dummy key because llama-server only needs a bearer token-shaped value.

Managed dashboard writes use the plugin service account declared in `plugin.json`. In local Docker, `docker-compose.yaml` enables Grafana's external service account support for this and starts Grafana image rendering so screenshot verification can run.

## Managed dashboards

The backend vendors Jsonnet libraries under `pkg/plugin/jsonnet/vendor` using the same `jsonnet-bundler` layout as `agentic-observability`. For new dashboards the assistant writes self-contained plain Jsonnet source to a session-scoped virtual `dashboard.jsonnet` file, applies compact edits to that file, and the backend compiles it with the embedded vendored libraries before saving the dashboard. If a model invents unsupported Grafonnet constructors, `render_dashboard` automatically attempts one transactional structural repair for common bad `g.dashboard.new(...)`, `g.dashboard.with_panels(...)`, panel constructor, and target constructor shapes. `fix_jsonnet` remains available for explicit repair after other render errors.

The assistant can render, sync, and later retrieve Jsonnet-backed dashboards with:

- `list_managed_dashboards`
- `get_dashboard_source`
- `write_jsonnet`
- `edit_jsonnet`
- `fix_jsonnet`
- `read_jsonnet`
- `render_dashboard`
- `sync_dashboard`

Synced dashboards are saved through the `dashboard.grafana.app` resource API with `grafana.app/managedBy=plugin`, `grafana.app/managerId=g42-pi-app`, the source checksum, and the exact Jsonnet source. The app intentionally does not set `grafana.app/managerAllowsEdits`, so normal Grafana UI edits are treated as read-only/export flows while stored Jsonnet remains the source of truth.

The default chat toolset does not expose raw dashboard JSON upload/delete tools, raw Prometheus data-frame output, direct vendored Jsonnet file browsing, or a Jsonnet subagent. Dashboard writes go through the Jsonnet-backed managed dashboard sync path.

## Subagents

The default chat toolset includes `run_query_agent` as a high-level fallback for broad metric and PromQL reconnaissance and `run_dashboard_agent` for dashboard work. Both start nested agents with narrow tool allow-lists: the query subagent can discover datasources, inspect Prometheus metadata, validate PromQL, and mine dashboard-derived metric context; the dashboard subagent can inspect metrics and dashboards and use managed dashboard tools, while persistent writes still require the parent assistant's existing approval flow.

## Skills

Dashboard instructions are split into repo-local skills under `.agents/skills/<skill-name>/SKILL.md`, using the same default `SKILL.md` directory shape as local agent skill installs. `npm run generate:skills` validates those files and bundles them into `src/pages/Chat/skills/bundledSkills.generated.ts` for the frontend.

The chat agent always has metric discovery tools, dashboard-derived metric context tools, and `run_query_agent` available. Dashboard guidance activates when the prompt asks for dashboard, panel, Jsonnet, render, or sync work, which also enables the managed dashboard and Jsonnet tool groups for that turn. New bundled skills can be added by creating another `.agents/skills/<name>/SKILL.md`; add optional text resources under `references/`, `templates/`, or `assets/`.

Admins can also add small instance-specific custom skills through plugin configuration:

```json
[
  {
    "name": "team-runbook",
    "description": "Use the team incident workflow and dashboard conventions.",
    "content": "# Team Runbook\n\nCheck service SLOs first. Prefer existing dashboards before creating new ones.",
    "activation": {
      "explicitOnly": true
    },
    "toolGroups": ["metrics", "skillResources"],
    "resources": [
      {
        "path": "references/team-runbook.md",
        "content": "# Team Runbook\n\nEscalate unresolved paging incidents after 15 minutes."
      }
    ]
  }
]
```

Custom skills are non-secret frontend configuration and are sent to the configured LLM when active. Supported custom skill tool groups are `metrics`, `dashboardMetricContext`, `dashboardRead`, `jsonnetFiles`, `managedDashboards`, `subagents`, and `skillResources`.
The bundled investigation skill also uses the `investigation` tool group to maintain the structured report shown in the chat workspace.

## Development

Install frontend dependencies:

```bash
npm install
```

Install pre-commit hooks with the `pre-commit` CLI:

```bash
pre-commit install
```

Build or watch the frontend:

```bash
npm run build
npm run dev
```

Build the backend after Go changes:

```bash
mage -v build:linux
```

Run checks:

```bash
npm run typecheck
npm run lint
npm run test:ci
go test ./pkg/...
```

Run Grafana with the plugin mounted:

```bash
npm run server
```

Or rebuild both plugin artifacts and start/reload the local Docker stack:

```bash
mise run dev:reload
```

To build and run the sidebar-capable variant locally on port 3001:

```bash
mise run dev:reload:variant
```

This runs `npm run package:variant`, mounts `dist` as `grafana-assistant-app`, starts the `assistant-variant` Compose profile, and reloads the `grafana-assistant-variant` service. Open the variant at http://localhost:3001.

To reload the sidebar-capable variant and seed stable manual-test samples:

```bash
mise run dev:reload:variant:seed
```

This also runs `npm run dev:seed:samples`, which upserts an `Assistant Dev Samples` folder with dashboards for alert troubleshooting, live dashboard editing, stale dashboard-context repair, and dashboard metric discovery. By default it also seeds a production-like enterprise corpus with multiple folders, dozens of dashboards, and hundreds of Grafana-managed alert rules so search and discovery tools run against realistic noise. The alert sample includes a Grafana-managed AlertRule linked to the panel through both `panelRef` and the dashboard/panel annotations used by Grafana's panel alert indicator. To seed only the Grafana resources against an already-running stack, run:

```bash
npm run dev:seed:samples
```

The seed script defaults to `GRAFANA_URL=http://localhost:3001`; set `GRAFANA_URL=http://localhost:3000` if you intentionally want to seed the default plugin stack. Set `DEV_SAMPLE_ENTERPRISE_PROFILE=0` to seed only the small stable fixtures, or tune `DEV_SAMPLE_ENTERPRISE_FOLDERS`, `DEV_SAMPLE_ENTERPRISE_DASHBOARDS`, `DEV_SAMPLE_ENTERPRISE_ALERT_RULES`, and `DEV_SAMPLE_ENTERPRISE_PANELS` for larger or smaller local corpora.

To create only the alternate plugin ID zip and checksum:

```bash
PLUGIN_VARIANT_ID=grafana-assistant-app npm run package:variant
```

The generated files are `grafana-assistant-app-<version>.zip` and `grafana-assistant-app-<version>.zip.sha1`. The packaging script temporarily rewrites `src/plugin.json` during the build and restores it before exiting.

The local Compose stack also seeds Prometheus with six hours of synthetic RED/USE, Thanos, and enterprise service metrics derived from the `agentic-observability` demo. To include future overlap for short-window `now` queries during a manual demo, start the stack with `HISTORY_FUTURE_SECONDS=3600`; the default is `0` so live Grafana and plugin scrapes can be ingested immediately. To refresh the generated history after it ages out, remove the demo volumes before starting Grafana again:

```bash
docker compose down -v
```

For a full demo reset that also reseeds Prometheus history with one hour of future overlap for short-window `now` queries, run:

```bash
mise run dev:reload:variant:fresh
```

This task deletes Compose volumes with `docker compose down -v --remove-orphans`, rebuilds/reloads the assistant variant, regenerates the Prometheus history, and then seeds the Grafana dashboard and alert samples.

For the default local LLM config, run an OpenAI-compatible llama-server on the host:

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL \
  --host 0.0.0.0 \
  --port 8080 \
  --temp 1.0 \
  --top-p 0.95 \
  --top-k 20 \
  --presence-penalty 1.5 \
  --min-p 0.00 \
  --spec-type draft-mtp \
  --spec-draft-n-max 2
```

Use a recent llama.cpp build with `draft-mtp` support; older `llama-server` builds reject that `--spec-type` value or fail to load the MTP GGUF.

Run the local agent benchmark against the configured llama-server with:

```bash
npm run benchmark:agent
```

Set `BENCH_RUNS=5` to repeat the agent run without restarting the model server. Successful runs write inspectable reports to `test-results/agent-benchmark/latest-report.txt` and `latest-events.json`.

To benchmark read-only analysis of the demo Prometheus incident, run:

```bash
npm run benchmark:analysis
```

This benchmark asks the assistant to investigate the six-hour synthetic data set without creating dashboards. It writes reports to `test-results/analysis-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

To benchmark the typed dashboard context repair path, run:

```bash
npm run benchmark:dashboard-context
```

This benchmark seeds a stale dashboard, then runs a rich-context repair that must use `inspect_dashboard_context`, render, and sync a managed dashboard copy. It writes the report to `test-results/dashboard-context-benchmark/latest-report.txt` with separate event and answer files for the run.

To benchmark approved live dashboard editing in the sidebar-capable variant, run:

```bash
npm run benchmark:dashboard-editing
```

This benchmark starts the `grafana-assistant-app` variant on http://localhost:3001 and validates three flows: typed multi-step live edits from a dashboard sidebar, recovery after an intentionally failed typed live edit, and graceful fallback when Assistant is open without an active dashboard mutation client. It writes reports to `test-results/dashboard-editing-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.
If you already have a compatible OpenAI-compatible model server running, set `BENCH_MANAGE_LLAMA=0` so the benchmark reuses it instead of starting `llama-server`.

To benchmark read-only panel-linked alert troubleshooting in the sidebar-capable variant, run:

```bash
npm run benchmark:alert-troubleshooting
```

This benchmark seeds a dashboard panel and a Grafana-managed AlertRule linked through the App Platform AlertRule API, then validates that Assistant uses the alert specialist to find the linked rule, inspect the panel, run PromQL evidence, and explain an alert-vs-panel threshold mismatch without editing alerts or dashboards. It writes reports to `test-results/alert-troubleshooting-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

To benchmark dashboard-derived metric discovery, run:

```bash
npm run benchmark:dashboard-metric-discovery
```

This benchmark seeds dashboards with overlapping HTTP, latency, node load, and CPU panels. It requires exactly one top-level `run_query_agent` call, checks that the query specialist uses `search_dashboard_metric_usage` or `get_metric_neighborhood` before validating PromQL, and writes reports to `test-results/dashboard-metric-discovery-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

To benchmark only the `run_query_agent` discovery path, run:

```bash
npm run benchmark:explore-metrics
```

This benchmark requires exactly one top-level `run_query_agent` call, checks the returned metric coverage and nested tool count, and writes reports to `test-results/explore-metrics-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

Open Grafana at http://localhost:3000 and navigate to the Observability Analyst app page.
