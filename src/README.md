# Observability Analyst

Observability Analyst adds an LLM analyst to Grafana for metric exploration, dashboard-derived metric discovery, PromQL validation, investigations, and dashboard authoring.

The assistant uses the current Grafana user's datasource and dashboard permissions. LLM requests are proxied through the app plugin backend with an OpenAI-compatible API key stored in secure plugin settings.
The default chat toolset exposes supervisor delegation tools (`run_query_agent`, `run_dashboard_agent`, `run_investigation_agent`, `run_support_agent`, and `run_navigation_agent`). Specialist agents receive the direct Grafana tools they need for their domain; dashboard writes still require the existing in-chat confirmation before saving, uploading, or deleting persistent Grafana artifacts.

## Requirements

- Grafana 13.0 or newer.
- At least one Prometheus datasource for metric exploration.
- An OpenAI-compatible chat completions endpoint and API key.
- Grafana image rendering if dashboard screenshot verification is required.
- Grafana external service accounts for dashboard saves through the plugin backend.

## Getting started

1. Enable the app plugin.
2. Open the plugin configuration page.
3. Set the OpenAI-compatible base URL, central model, API key, optional thinking mode, optional system prompt addendum, optional Prometheus datasource allow-list, and optional custom skills.
4. Open **Observability Analyst** from the app navigation.
5. Ask the assistant to inspect metrics, validate PromQL, or create dashboards.

The assistant page does not expose model, thinking, system prompt, datasource policy, or custom skill controls; all requests use the model, thinking mode, prompt addendum, datasource allow-list, and custom skill catalog configured in the plugin settings.

Jsonnet dashboards are compiled from model-authored source in the backend. During chat, the assistant keeps that source in a session-scoped virtual Jsonnet file so it can render, edit, auto-repair common invalid Grafonnet-style constructor output during render, and save editable Grafana dashboards without resending unchanged source.

For existing dashboards, the assistant can use `inspect_dashboard_metric_usage`, `search_dashboard_metric_usage`, and `get_metric_neighborhood` to extract Prometheus metric usage, labels, grouping labels, functions, and panel co-usage from dashboards before broader metric scans. The dashboard specialist also uses `inspect_dashboard_context` to read typed dashboard structure, current-variable-substituted panel queries, layout and field config, and best-effort Prometheus validation summaries.
