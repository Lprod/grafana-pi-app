## Project knowledge

This repository contains a **Grafana plugin**. You must Read @./.config/AGENTS/instructions.md before doing changes.

## Local development

- Use `mise run dev:reload` (defined in @mise.toml) to rebuild the frontend (`npm run build`) and backend (`mage -v build:linux`) plugin artifacts, then start or reload the local Docker stack (`docker compose up -d --build --remove-orphans` followed by `docker compose restart grafana`).
- Use `mise run dev:reload:variant` to build the alternate `grafana-assistant-app` plugin ID variant, start the `assistant-variant` Docker Compose profile, and test the Grafana extension sidebar integration on http://localhost:3001.
- Use `npm run benchmark:dashboard-editing` to run the local Qwen/sidebar benchmark for approved typed live dashboard edits, failed-edit recovery, and unavailable-runtime fallback through Grafana's restricted dashboard mutation API.
- The default local LLM config expects an OpenAI-compatible llama-server running on the host. See the `llama-server` invocation in @README.md for the exact flags (Qwen3.6-35B model, port 8080, speculative draft-mtp decoding).

## Reference sources

- Grafana source code is checked out at `$HOME/repos/github.com/grafana/grafana`. Grep or read it when you need to confirm current Grafana API behavior rather than relying on stale training data.

## Commit conventions

Use semantic commit messages following Conventional Commits, for example `fix: escape search PromQL regexes`.
