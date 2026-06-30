## Project knowledge

This repository contains a **Grafana plugin**. You must Read @./.config/AGENTS/instructions.md before doing changes.

## Local development

- Work with the sidebar-capable `grafana-assistant-app` variant first unless the task specifically requires the default `g42-pi-app` plugin ID. Use `mise run dev:reload:variant` to build the variant, start the `assistant-variant` Docker Compose profile, and test the Grafana extension sidebar integration on http://localhost:3001.
- Use `mise run dev:reload` only when you specifically need the default plugin ID stack. It rebuilds the frontend (`npm run build`) and backend (`mage -v build:linux`) plugin artifacts, then starts or reloads the local Docker stack (`docker compose up -d --build --remove-orphans` followed by `docker compose restart grafana`).
- Use `npm run benchmark:dashboard-editing` to run the local Qwen/sidebar benchmark for approved typed live dashboard edits, failed-edit recovery, and unavailable-runtime fallback through Grafana's restricted dashboard mutation API.
- The default local LLM config expects an OpenAI-compatible llama-server running on the host with Qwen3.6 on port 8080. Start or verify that llama-server before local assistant testing, benchmarks, or flows that need model responses. See the `llama-server` invocation in @README.md for the exact flags (Qwen3.6-35B model, port 8080, speculative draft-mtp decoding).
- For local Grafana testing, use the `agent-browser` skill to drive http://localhost:3001: open pages, inspect snapshots, click through sidebar flows, capture screenshots, and verify behavior interactively.

## Reference sources

- Grafana source code is checked out at `$HOME/repos/github.com/grafana/grafana`. Grep or read it when you need to confirm current Grafana API behavior rather than relying on stale training data.

## Commit conventions

Use semantic commit messages following Conventional Commits, for example `fix: escape search PromQL regexes`.
