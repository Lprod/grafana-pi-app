# Grafana Pi App

Grafana Pi App adds a Pi-powered assistant to Grafana for metric exploration, PromQL validation, and dashboard authoring.

The assistant uses the current Grafana user's datasource and dashboard permissions. LLM requests are proxied through the app plugin backend with an OpenAI-compatible API key stored in secure plugin settings.

## Requirements

- Grafana 13.0 or newer.
- At least one Prometheus datasource for metric exploration.
- An OpenAI-compatible chat completions endpoint and API key.
- Grafana image rendering if dashboard screenshot verification is required.

## Getting started

1. Enable the app plugin.
2. Open the plugin configuration page.
3. Set the OpenAI-compatible base URL, central model, and API key.
4. Open **Pi Assistant** from the app navigation.
5. Ask the assistant to inspect metrics, validate PromQL, or create dashboards.

The assistant page does not expose model selection; all requests use the model configured in the plugin settings.
