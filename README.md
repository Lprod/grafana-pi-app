# Grafana Pi App

Grafana Pi App is a Grafana app plugin that embeds a Pi-powered LLM chat assistant for observability work. The assistant runs in a Grafana-native React UI, uses the current Grafana user's datasource and dashboard permissions, and calls an OpenAI-compatible LLM through the plugin backend so API keys stay server-side.

## What it does

- Discovers Prometheus datasources visible to the current user.
- Lists metric names and label values through Grafana datasource resource APIs.
- Runs PromQL through Grafana datasource query APIs.
- Creates, updates, lists, fetches, deletes, and screenshots dashboards through Grafana APIs.
- Stores chat sessions per Grafana user with plugin user storage.

## Configuration

Configure the app plugin from Grafana's plugin settings page:

- `openAIBaseUrl`: OpenAI-compatible API base URL, for example `https://api.openai.com/v1`.
- `defaultModel`: Central model ID used for all assistant requests, for example `gpt-4.1`.
- `allowedDatasourceUids`: Optional list of Prometheus datasource UIDs the assistant may discover, query, and reference in uploaded dashboards. Leave empty to allow all Prometheus datasources visible to the current Grafana user.
- `openAIAPIKey`: Secret API key stored in `secureJsonData`.

Chat users cannot override the model or datasource allow-list from the assistant page. The backend always uses the centrally configured model when proxying LLM requests, and Grafana datasource tools enforce the central allow-list before querying.

For local Docker provisioning, `provisioning/plugins/app.yaml` reads `OPENAI_API_KEY`.

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
