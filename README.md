# Grafana Pi App

Grafana Pi App is a Grafana app plugin that embeds a Pi-powered LLM chat assistant for observability work. The assistant runs in a Grafana-native React UI, uses the current Grafana user's datasource and dashboard permissions, and calls an OpenAI-compatible LLM through the plugin backend so API keys stay server-side.

## What it does

- Discovers Prometheus datasources visible to the current user.
- Lists metric names and label values through Grafana datasource resource APIs.
- Runs PromQL through Grafana datasource query APIs.
- Creates, updates, lists, fetches, deletes, and screenshots dashboards through Grafana APIs.
- Creates app-managed dashboards from vendored Jsonnet/Grafonnet templates. These dashboards are marked as plugin-managed and should be edited through the app, not the standard Grafana dashboard editor.
- Stores chat sessions per Grafana user with plugin user storage.

## Configuration

Configure the app plugin from Grafana's plugin settings page:

- `openAIBaseUrl`: OpenAI-compatible API base URL, for example `https://api.openai.com/v1`.
- `defaultModel`: Central model ID used for all assistant requests, for example `gpt-4.1`.
- `allowedDatasourceUids`: Optional list of Prometheus datasource UIDs the assistant may discover, query, and reference in uploaded dashboards. Leave empty to allow all Prometheus datasources visible to the current Grafana user.
- `openAIAPIKey`: Secret API key stored in `secureJsonData`.

Chat users cannot override the model or datasource allow-list from the assistant page. The backend always uses the centrally configured model when proxying LLM requests, and Grafana datasource tools enforce the central allow-list before querying.

For local Docker provisioning, `provisioning/plugins/app.yaml` reads `OPENAI_API_KEY`.

Managed dashboard writes use the plugin service account declared in `plugin.json`. In local Docker, `docker-compose.yaml` enables Grafana's external service account support for this.

## Managed dashboards

The backend vendors Jsonnet libraries under `pkg/plugin/jsonnet/vendor` using the same `jsonnet-bundler` layout as `agentic-observability`. Templates live in `pkg/plugin/jsonnet/templates` and are embedded into the backend binary.

The assistant can render and sync bundled templates with:

- `grafana_list_managed_dashboard_templates`
- `grafana_list_managed_dashboards`
- `grafana_render_managed_dashboard`
- `grafana_sync_managed_dashboard`
- `search_jsonnet_libs`, `read_jsonnet_lib`, and `list_jsonnet_libs`

Synced dashboards are saved through the `dashboard.grafana.app` resource API with `grafana.app/managedBy=plugin` and `grafana.app/managerId=elohmeier-grafanapiapp-app`. The app intentionally does not set `grafana.app/managerAllowsEdits`, so normal Grafana UI edits are treated as read-only/export flows while app sync remains the source of truth.

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

Open Grafana at http://localhost:3000 and navigate to the Pi Assistant app page.
