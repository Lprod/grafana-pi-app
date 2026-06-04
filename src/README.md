# Observability Analyst

Observability Analyst adds an LLM analyst to Grafana for metric exploration, PromQL validation, read-only rqlite SQL, and dashboard authoring.

The assistant uses the current Grafana user's datasource and dashboard permissions. LLM requests are proxied through the app plugin backend with an OpenAI-compatible API key stored in secure plugin settings.
The default chat toolset keeps `explore_metrics` available for broad metric reconnaissance and `design_dashboard` available for design-only dashboard planning. Dashboard writes stay in the parent assistant; no Jsonnet writer subagent is exposed.

## Requirements

- Grafana 13.0 or newer.
- At least one Prometheus datasource for metric exploration.
- Optionally, at least one rqlite datasource for SQL exploration.
- An OpenAI-compatible chat completions endpoint and API key.
- Grafana image rendering if dashboard screenshot verification is required.
- Grafana external service accounts for app-managed dashboard sync.

## Getting started

1. Enable the app plugin.
2. Open the plugin configuration page.
3. Set the OpenAI-compatible base URL, central model, API key, optional thinking mode, optional system prompt addendum, optional Prometheus and rqlite datasource allow-lists, and optional custom skills.
4. Open **Observability Analyst** from the app navigation.
5. Ask the assistant to inspect metrics, validate PromQL, or create dashboards.

The assistant page does not expose model, thinking, system prompt, datasource policy, or custom skill controls; all requests use the model, thinking mode, prompt addendum, datasource allow-list, and custom skill catalog configured in the plugin settings.

Managed dashboards are compiled from model-authored Jsonnet source in the backend. During chat, the assistant keeps that source in a session-scoped virtual Jsonnet file so it can render, edit, auto-repair common invalid Grafonnet-style constructor output during render, and sync dashboards without resending unchanged source. The source is stored on the plugin-managed dashboard resource and should be changed by fetching, editing, and re-syncing through the app.
