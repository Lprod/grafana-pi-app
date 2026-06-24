# Observability Analyst

Observability Analyst is a Grafana app plugin that embeds an LLM analyst for observability work. The analyst runs in a Grafana-native React UI, uses the current Grafana user's datasource and dashboard permissions, and calls an OpenAI-compatible LLM through the plugin backend so API keys stay server-side.

## What it does

- Discovers Prometheus datasources visible to the current user.
- Lists metric names and label values through Grafana datasource resource APIs.
- Runs PromQL through Grafana datasource query APIs, returning compact min/max/last/sample summaries for range queries by default.
- Creates app-managed dashboards from model-authored Jsonnet source. The source is stored with each dashboard so future edits can update the Jsonnet and re-sync through the app.
- Lists, fetches, and screenshots dashboards through Grafana APIs.
- Keeps broad metric reconnaissance available through a restricted metrics subagent.
- Stores chat sessions per Grafana user with plugin user storage.

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

The default chat toolset includes `explore_metrics` as a high-level fallback for broad metric and PromQL reconnaissance and `design_dashboard` as a design-only dashboard specialist. Both start nested agents with narrow tool allow-lists: the metrics subagent can only discover datasources, inspect Prometheus metadata, and validate PromQL; the dashboard designer can inspect metrics and dashboards but cannot write, render managed dashboard previews, sync, upload, delete, or otherwise persist dashboard artifacts. Dashboard write tools stay available only to the parent assistant.

## Skills

Dashboard instructions are split into repo-local skills under `.agents/skills/<skill-name>/SKILL.md`, using the same default `SKILL.md` directory shape as local agent skill installs. `npm run generate:skills` validates those files and bundles them into `src/pages/Chat/skills/bundledSkills.generated.ts` for the frontend.

The chat agent always has metric discovery tools and `explore_metrics` available. Dashboard guidance activates when the prompt asks for dashboard, panel, Jsonnet, render, or sync work, which also enables the managed dashboard and Jsonnet tool groups for that turn. New bundled skills can be added by creating another `.agents/skills/<name>/SKILL.md`; add optional text resources under `references/`, `templates/`, or `assets/`.

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

Custom skills are non-secret frontend configuration and are sent to the configured LLM when active. Supported custom skill tool groups are `metrics`, `dashboardRead`, `jsonnetFiles`, `managedDashboards`, `subagents`, and `skillResources`.
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

The local Compose stack also seeds Prometheus with six hours of synthetic RED/USE metrics derived from the `agentic-observability` demo. It includes one hour of current-query overlap by default, so short-window `now` queries remain useful during a manual demo. To refresh the generated history after it ages out, remove the demo volumes before starting Grafana again:

```bash
docker compose down -v
```

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

To benchmark only the `explore_metrics` discovery path, run:

```bash
npm run benchmark:explore-metrics
```

This benchmark requires exactly one top-level `explore_metrics` call, checks the returned metric coverage and nested tool count, and writes reports to `test-results/explore-metrics-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

Open Grafana at http://localhost:3000 and navigate to the Observability Analyst app page.
