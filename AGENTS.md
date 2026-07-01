## Project knowledge

This repository contains a **Grafana plugin**. You must Read @./.config/AGENTS/instructions.md before doing changes.

## Local development

- Work with the sidebar-capable `grafana-assistant-app` variant first unless the task specifically requires the default `g42-pi-app` plugin ID. Use `mise run dev:reload:variant` to build the variant, start the `assistant-variant` Docker Compose profile, and test the Grafana extension sidebar integration on http://localhost:3001.
- Use `mise run dev:reload:variant:seed` when you need the sidebar-capable variant plus stable manual-test fixtures. It reloads http://localhost:3001 and seeds the Assistant Dev Samples folder with dashboard editing, stale dashboard context, dashboard metric discovery, and panel-linked alert troubleshooting samples.
- Use `mise run dev:reload:variant:fresh` when Prometheus demo data must be regenerated too. This runs `docker compose down -v --remove-orphans`, so it deletes local Grafana and Prometheus Compose volumes before rebuilding, reseeding Prometheus history, and reseeding the Grafana samples. Prefer the non-fresh seed task unless you intentionally want to reset local state.
- Use `npm run dev:seed:samples` to reseed only the Grafana dashboard/alert samples against an already-running stack. It defaults to `GRAFANA_URL=http://localhost:3001`; set `GRAFANA_URL=http://localhost:3000` only when intentionally targeting the default plugin stack.
- Use `mise run dev:reload` only when you specifically need the default plugin ID stack. It rebuilds the frontend (`npm run build`) and backend (`mage -v build:linux`) plugin artifacts, then starts or reloads the local Docker stack (`docker compose up -d --build --remove-orphans` followed by `docker compose restart grafana`).
- Use `npm run benchmark:dashboard-editing` to run the local Qwen/sidebar benchmark for approved typed live dashboard edits, failed-edit recovery, and unavailable-runtime fallback through Grafana's restricted dashboard mutation API.
- The default local LLM config expects an OpenAI-compatible llama-server running on the host with Qwen3.6 on port 8080. Start or verify that llama-server before local assistant testing, benchmarks, or flows that need model responses. See the `llama-server` invocation in @README.md for the exact flags (Qwen3.6-35B model, port 8080, speculative draft-mtp decoding).
- For local Grafana testing, use the `agent-browser` skill to drive http://localhost:3001: open pages, inspect snapshots, click through sidebar flows, capture screenshots, and verify behavior interactively.

## Reference sources

- Grafana source code is checked out at `$HOME/repos/github.com/grafana/grafana`. Grep or read it when you need to confirm current Grafana API behavior rather than relying on stale training data.

## Commit conventions

Use semantic commit messages following Conventional Commits, for example `fix: escape search PromQL regexes`.
