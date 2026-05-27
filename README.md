# Grafana Pi App

Grafana Pi App is a Grafana app plugin that embeds a Pi-powered LLM chat assistant for observability work. The assistant runs in a Grafana-native React UI, uses the current Grafana user's datasource and dashboard permissions, and calls an OpenAI-compatible LLM through the plugin backend so API keys stay server-side.

## What it does

- Discovers Prometheus datasources visible to the current user.
- Lists metric names and label values through Grafana datasource resource APIs.
- Runs PromQL through Grafana datasource query APIs.
- Creates, updates, lists, fetches, deletes, and screenshots dashboards through Grafana APIs.
- Creates app-managed dashboards from vendored Jsonnet/Grafonnet templates. These dashboards are marked as plugin-managed and should be edited through the app, not the standard Grafana dashboard editor.
- Delegates broad metric and Jsonnet reconnaissance to restricted subagents with isolated chat context.
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

Managed dashboard writes use the plugin service account declared in `plugin.json`. In local Docker, `docker-compose.yaml` enables Grafana's external service account support for this.

## Managed dashboards

The backend vendors Jsonnet libraries under `pkg/plugin/jsonnet/vendor` using the same `jsonnet-bundler` layout as `agentic-observability`. Templates live in `pkg/plugin/jsonnet/templates` and are embedded into the backend binary.

The assistant can render and sync bundled templates with:

- `grafana_explore_jsonnet`
- `grafana_list_managed_dashboard_templates`
- `grafana_list_managed_dashboards`
- `grafana_render_managed_dashboard`
- `grafana_sync_managed_dashboard`
- `read_managed_dashboard_template`
- `search_jsonnet_libs`, `read_jsonnet_lib`, and `list_jsonnet_libs`

Synced dashboards are saved through the `dashboard.grafana.app` resource API with `grafana.app/managedBy=plugin` and `grafana.app/managerId=elohmeier-grafanapiapp-app`. The app intentionally does not set `grafana.app/managerAllowsEdits`, so normal Grafana UI edits are treated as read-only/export flows while app sync remains the source of truth.

## Subagents

The chat registers `grafana_explore_metrics` and `grafana_explore_jsonnet` as high-level tools. Each starts a nested Pi agent with a narrow tool allow-list: the metrics subagent can only discover datasources, inspect Prometheus metadata, and validate PromQL; the Jsonnet subagent can only inspect bundled templates, search/read vendored Jsonnet libraries, and render managed dashboards without saving them. Dashboard write tools stay available only to the parent assistant.

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

Open Grafana at http://localhost:3000 and navigate to the Pi Assistant app page.
