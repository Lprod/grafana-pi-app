# Grafana Pi App

Grafana Pi App is a Grafana app plugin that embeds a Pi-powered LLM chat assistant for observability work. The assistant runs in a Grafana-native React UI, uses the current Grafana user's datasource and dashboard permissions, and calls an OpenAI-compatible LLM through the plugin backend so API keys stay server-side.

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
- `allowedDatasourceUids`: Optional list of Prometheus datasource UIDs the assistant may discover, query, and reference in uploaded dashboards. Leave empty to allow all Prometheus datasources visible to the current Grafana user.
- `openAIAPIKey`: Secret API key stored in `secureJsonData`.

Chat users cannot override the model or datasource allow-list from the assistant page. The backend always uses the centrally configured model when proxying LLM requests, and Grafana datasource tools enforce the central allow-list before querying.

For local Docker provisioning, `provisioning/plugins/app.yaml` reads `OPENAI_API_KEY`.
The local demo config points Grafana at `http://host.docker.internal:8080/v1`, sets the model to the Qwen llama-server model, and limits assistant datasource access to the provisioned `prometheus` datasource.
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

Synced dashboards are saved through the `dashboard.grafana.app` resource API with `grafana.app/managedBy=plugin`, `grafana.app/managerId=elohmeier-grafanapiapp-app`, the source checksum, and the exact Jsonnet source. The app intentionally does not set `grafana.app/managerAllowsEdits`, so normal Grafana UI edits are treated as read-only/export flows while stored Jsonnet remains the source of truth.

The default chat toolset does not expose raw dashboard JSON upload/delete tools, raw Prometheus data-frame output, direct vendored Jsonnet file browsing, or a Jsonnet subagent. Dashboard writes go through the Jsonnet-backed managed dashboard sync path.

## Subagents

The default chat toolset includes `explore_metrics` as a high-level fallback for broad metric and PromQL reconnaissance. It starts a nested Pi agent with a narrow tool allow-list: the metrics subagent can only discover datasources, inspect Prometheus metadata, and validate PromQL. Dashboard write tools stay available only to the parent assistant.

## Development

Install frontend dependencies:

```bash
npm install
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

Open Grafana at http://localhost:3000 and navigate to the Pi Assistant app page.
