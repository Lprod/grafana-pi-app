# Observability Analyst Architecture

This repository is a Grafana app plugin that embeds a Pi-powered LLM agent for
observability work. The plugin runs inside Grafana, uses Grafana permissions and
datasources, and proxies LLM calls through a Go backend so API keys stay on the
server side.

The app is easiest to understand as four layers:

```text
Grafana plugin shell
  -> React and Grafana Scenes chat UI
  -> Pi agent runtime in the browser
  -> Go backend resources for secrets, Jsonnet, and managed dashboard writes
```

## What An Agent Is

An agent is a model loop with tools.

A normal chat app sends messages to an LLM and renders the answer. An agent adds
three more pieces:

- A system prompt: durable instructions that define the assistant's role and
  rules.
- Tools: typed functions the model may ask the app to run.
- A loop: when the model asks for a tool, the app validates the request, runs
  the tool, appends the result to the conversation, and asks the model to
  continue.

In this app the loop is provided by `@earendil-works/pi-agent-core`. The central
class is `Agent`, created in `src/pages/Chat/ChatSceneObject.tsx`. The important
inputs are:

- `systemPrompt`: built from `src/pages/Chat/systemPrompt.ts` plus active
  skills.
- `model`: an OpenAI-compatible model object from `src/pages/Chat/model.ts`.
- `tools`: the tool list selected for the current prompt.
- `streamFn`: a Pi `streamProxy` call that posts to the plugin backend.
- `beforeToolCall`: a hook that can block tool execution before it happens.
- `afterToolCall`: a hook that can transform tool results after they run.

The model never directly touches Grafana, Prometheus, files, or dashboards. It
only emits tool-call JSON. The app decides which tools exist, validates their
arguments, runs the implementation code, and sends back a tool result.

## Repository Map

The main implementation areas are:

- `src/plugin.json`: Grafana plugin manifest. It declares an app plugin with a
  Go backend and one navigable page at `/a/g42-pi-app/chat`.
- `src/module.tsx`: Grafana frontend entry point. It registers the app root page
  and the plugin configuration page with `new AppPlugin().setRootPage(...)`.
- `src/components/App/App.tsx`: App shell. It checks app access and mounts a
  `SceneApp`.
- `src/pages/Chat/`: Chat UI, agent setup, skills, prompts, tools, and tests.
- `pkg/main.go`: Go backend entry point. Grafana starts this binary as the
  plugin backend process.
- `pkg/plugin/`: Backend resource routes, LLM proxy, access checks, Jsonnet
  rendering, managed dashboard sync, and Jsonnet library browsing.
- `.agents/skills/`: Repo-local skills bundled into the frontend.
- `scripts/generate-bundled-skills.mjs`: Converts `.agents/skills/**/SKILL.md`
  into `src/pages/Chat/skills/bundledSkills.generated.ts`.
- `provisioning/`: Local Grafana provisioning for datasources and plugin
  settings.
- `demo/prometheus/`: Synthetic Prometheus demo data.
- `tests/`: Playwright and benchmark-style e2e tests.

Local source lookups used while writing this document:

- `h grafana/grafana` resolves to the local Grafana checkout. It was used to
  confirm `AppPlugin`, `setRootPage`, and `addConfigPage` behavior.
- `h earendil-works/pi` resolves to the local Pi checkout. It was used to
  confirm `Agent`, `streamProxy`, tool execution modes, and tool hooks.

## Grafana Plugin Shell

Grafana discovers the plugin through `src/plugin.json`.

Key manifest choices:

- `"type": "app"` makes this a Grafana app plugin, not a panel or datasource.
- `"backend": true` and `"executable": "gpx_g42_pi_app"` tell Grafana to start
  the Go backend binary.
- `includes` adds the app page to Grafana navigation.
- `roles` defines the `g42-pi-app.app:access` action.
- `iam.permissions` grants the plugin service account enough rights to create,
  read, and write dashboards and folders through Grafana APIs.
- `grafanaDependency` is `>=13.0.0`.

Frontend registration happens in `src/module.tsx`:

- `initPluginTranslations(pluginJson.id, [loadResources])` initializes Grafana
  and Scenes translations before the app loads.
- `LazyApp` is registered with `setRootPage`, so Grafana renders it under
  `/a/<plugin-id>/*`.
- `LazyAppConfig` is registered with `addConfigPage`, so admins can configure
  model, access, datasource, and skill settings.

The local Grafana source confirms that `AppPlugin.root` is the component shown
under `/a/${plugin-id}/*`, and `addConfigPage` adds tabs on the plugin settings
page.

## Frontend App Shape

The UI follows the Grafana Scenes app pattern, but the page body is a custom
React chat application rather than a dashboard-like scene graph.

Flow:

```text
src/module.tsx
  -> AppPlugin.setRootPage(App)
  -> src/components/App/App.tsx
  -> SceneApp with one SceneAppPage
  -> src/pages/Chat/chatPage.ts
  -> src/pages/Chat/chatScene.ts
  -> ChatSceneObject
  -> ChatApp React component
```

Important patterns:

- `useSceneApp(getSceneApp)` memoizes the `SceneApp`. Recreating a scene app on
  every render would reset navigation and URL state.
- `chatPage` defines the title, subtitle, URL, route path, and scene factory.
- `chatScene` returns an `EmbeddedScene` containing one `ChatSceneObject`.
- `ChatSceneObject` is a minimal `SceneObjectBase` wrapper whose renderer mounts
  the React chat UI.

This lets the plugin participate in Grafana app routing and breadcrumbs while
keeping the chat experience as normal React state.

## Chat And Agent Lifecycle

The main file is `src/pages/Chat/ChatSceneObject.tsx`.

On load:

1. The UI reads plugin metadata and configuration with `usePluginMeta()`.
2. It builds an OpenAI-compatible Pi model object from central admin settings.
3. It creates a Pi `streamFn` with `streamProxy`.
4. It creates a new chat session and `Agent`.
5. It loads the saved session index from Grafana plugin user storage.

When a user submits a prompt:

1. `submitPrompt` trims the input and creates a session title if needed.
2. `buildSkillRuntime(prompt)` selects active skills and tool groups.
3. The agent's `systemPrompt` and `tools` are replaced for this turn.
4. `agent.prompt(prompt)` starts the Pi loop.
5. The agent streams model events, tool calls, tool results, and final text.
6. On `agent_end`, the chat session is saved to plugin user storage.

Sessions store:

- agent messages,
- model ID,
- virtual Jsonnet file snapshots,
- investigation report state,
- artifacts,
- artifact counter.

Storage is per Grafana user through `usePluginUserStorage()`. The app also
supports chat import and export as JSON.

## LLM Streaming Boundary

The browser does not call the LLM provider directly.

`ChatSceneObject.tsx` defines:

```text
streamProxy(..., proxyUrl: /api/plugins/g42-pi-app/resources/llm)
```

Pi's `streamProxy` appends `/api/stream`, so the backend keeps an alias route:

```text
/llm/api/stream -> handleLLMStream
```

The backend implementation is in `pkg/plugin/resources.go`.

The backend:

- requires app access through `withAppAccess`,
- rejects requests when the secure API key is missing,
- ignores the client model ID and uses `settings.DefaultModel`,
- appends the admin-configured `systemPromptAddendum`,
- translates Pi proxy messages into OpenAI-compatible chat-completions
  messages,
- translates Pi tool schemas into OpenAI-compatible function tools,
- applies configured thinking format:
  - OpenAI: `reasoning_effort`,
  - Qwen: `enable_thinking`,
  - Qwen chat template: `chat_template_kwargs.enable_thinking`,
- relays upstream server-sent events back to Pi proxy events.

This is the main secret boundary. The OpenAI-compatible API key lives in
Grafana `secureJsonData`, is decrypted only for the backend plugin, and is never
put into frontend `jsonData`.

## Tool System

Tools are defined as Pi `AgentTool` objects. Each tool has:

- `name`: what the model calls.
- `label`: human-readable UI label.
- `description`: model-facing instructions for when to call it.
- `parameters`: TypeBox schema used to validate arguments.
- `execute`: code that runs after validation.

The registry is in `src/pages/Chat/tools/index.ts`.

Tool groups:

- `metrics`: Prometheus datasource discovery, metric metadata, label values,
  series inspection, and summarized PromQL queries.
- `dashboardRead`: list, fetch, inspect, and screenshot dashboards.
- `jsonnetFiles`: session virtual Jsonnet write, edit, fix, and read tools.
- `managedDashboards`: list managed dashboards, fetch source, render, and sync.
- `investigation`: update the structured investigation report.
- `subagents`: run focused child agents.
- `skillResources`: read resources attached to active skills.
- `jsonnetLibraries`: browse bundled Jsonnet libraries when enabled.
- `adHocDashboards`: raw dashboard upload/delete when explicitly enabled.
- `artifacts`: store and inspect bulky tool results.

The app does not give every tool to the model all the time. Instead,
`createGrafanaToolsForSkillGroups` selects tools based on active skills and
intent.

## Skills

Skills are model-facing instructions that activate for a turn.

Bundled skills live under `.agents/skills/`:

- `grafana-dashboard`: dashboard, panel, Jsonnet, render, and sync workflow.
- `investigation`: evidence-based incident investigation workflow.

`npm run generate:skills` runs `scripts/generate-bundled-skills.mjs`, which:

- validates each `SKILL.md`,
- reads text resources from `references/`, `templates/`, and `assets/`,
- writes `src/pages/Chat/skills/bundledSkills.generated.ts`.

Skill selection is in `src/pages/Chat/skills/selection.ts`.

Activation rules:

- Users can explicitly name a skill with `$skill-name`.
- Dashboard keywords activate `grafana-dashboard`.
- investigation/root-cause/incident keywords activate `investigation`.
- Admin-configured custom skills can activate by keyword or regex unless they
  are `explicitOnly`.

The rendered system prompt lists available skills, includes active skill
content, and exposes active skill resources through `read_skill_resource`.

Custom skills are stored in `jsonData`. They are non-secret configuration and
are sent to the model when active.

## Specialist Subagents

The top-level assistant is a supervisor. It can delegate work to child agents
through subagent tools in `src/pages/Chat/tools/subagents.ts`.

Specialists:

- `run_query_agent`: Prometheus discovery and PromQL validation.
- `run_dashboard_agent`: dashboard design, Jsonnet, render, and sync workflow.
- `run_investigation_agent`: incident/root-cause analysis and report updates.
- `run_support_agent`: Grafana and observability explanations.
- `run_navigation_agent`: safe Grafana navigation and link building.

Each specialist is another Pi `Agent` created by
`src/pages/Chat/tools/subagentRunner.ts`, but with:

- a narrow system prompt,
- a narrow tool allow-list,
- the same central model and backend `streamFn`,
- the same write-approval hook,
- a per-specialist child tool-call budget.

Tool-call budgets:

- query: 14,
- dashboard: 24,
- investigation: 20,
- support: 6,
- navigation: 4.

Dashboard specialists also get follow-up nudges when a create/update task has
not completed the expected `write_jsonnet` or `edit_jsonnet`,
`render_dashboard`, and `sync_dashboard` sequence.

This pattern keeps the top-level agent focused and makes broad tasks safer:
specialists can only use the tools needed for their job.

## Metrics And Prometheus Tools

Metrics tools are in `src/pages/Chat/tools/metrics.ts`.

They use Grafana's frontend datasource service, so they run as the current
Grafana user and respect datasource visibility.

Main tools:

- `list_datasources`: list visible and allowed Prometheus datasources.
- `list_metrics`: list metric names, optionally by prefix.
- `list_label_values`: list values for a label, optionally scoped by selector.
- `inspect_metric_series`: inspect label names and example series.
- `query_prometheus`: run instant or range PromQL through Grafana and return a
  compact validation summary.

Important safety and cost controls:

- Datasources are filtered by `allowedPrometheusDatasourceUids` when configured.
- The default query tool returns min/max/last/sample summaries, not full raw
  data frames.
- Raw Prometheus data frames are behind `query_prometheus_raw`, which is only
  enabled for developer/debug workflows.
- Lists and query results are truncated.
- Range queries use bounded `maxDataPoints`.
- Tool descriptions instruct the model to inspect metrics and labels before
  inventing selectors.

## Dashboard Architecture

The app supports two dashboard paths:

1. Read-only dashboard inspection.
2. Managed dashboard creation/update through Jsonnet.

Read tools are in `src/pages/Chat/tools/dashboards.ts`:

- `list_dashboards`,
- `get_dashboard`,
- `screenshot_dashboard`,
- typed dashboard context inspection through `dashboardContext`.

Raw dashboard writes exist but are not part of the default chat toolset:

- `upload_dashboard`,
- `delete_dashboard`.

The preferred durable write path is managed Jsonnet.

Managed dashboard frontend tools are in
`src/pages/Chat/tools/managedDashboards.ts`:

- `list_managed_dashboards`,
- `get_dashboard_source`,
- `render_dashboard`,
- `sync_dashboard`.

Session virtual Jsonnet files are handled by
`src/pages/Chat/tools/jsonnetFiles.ts`:

- `write_jsonnet`,
- `edit_jsonnet`,
- `fix_jsonnet`,
- `read_jsonnet`.

Backend dashboard resource code is in `pkg/plugin/managed_dashboards.go` and
`pkg/plugin/virtual_jsonnet_files.go`.

Managed dashboard flow:

```text
model asks for dashboard
  -> dashboard skill activates
  -> dashboard specialist validates metrics
  -> write_jsonnet creates session dashboard.jsonnet
  -> render_dashboard compiles Jsonnet without saving
  -> sync_dashboard saves through dashboard.grafana.app API
  -> dashboard source and checksum are stored as annotations
```

Backend behavior:

- Jsonnet is compiled with `go-jsonnet`.
- Vendored Jsonnet libraries are embedded under `pkg/plugin/jsonnet/vendor`.
- Jsonnet source is limited to 200 KiB.
- Virtual Jsonnet file paths must be relative and end with `.jsonnet` or
  `.libsonnet`.
- Edits are transactional, version-aware, line-based, and must compile.
- Common invalid Grafonnet constructor shapes can be auto-repaired.
- Managed dashboards are saved through `dashboard.grafana.app/v1`.
- The backend stores annotations:
  - `grafana.app/managedBy=plugin`,
  - `grafana.app/managerId=g42-pi-app`,
  - source path,
  - source checksum,
  - source timestamp,
  - `g42.piapp/jsonnetSource`.
- The backend sets `editable=false` and adds `genai` and
  `managed-by-observability-analyst` tags.
- Datasource UIDs in dashboard JSON are checked against the configured allow
  list on the backend before sync.

## Guardrails

The app uses several overlapping guardrails. Prompts help guide behavior, but
real safety comes from tool selection, runtime hooks, backend checks, and
Grafana permissions.

### Access Control

Frontend access is checked in `src/components/App/App.tsx` through
`canUserAccessApp` from `src/utils/access.ts`.

Backend resource access is checked in `pkg/plugin/access.go` with
`withAppAccess`.

Modes:

- `all`: no extra app-level restriction.
- `admins`: org admins only.
- `users`: org admins plus configured logins/emails.
- `rbac`: org admins or users with `g42-pi-app.app:access`.

All backend resource routes are wrapped with `withAppAccess`.

### Secret Handling

- API keys are entered with `SecretInput`.
- The key is stored in Grafana `secureJsonData`.
- The frontend only stores `isOpenAIAPIKeySet`.
- The Go backend reads `settings.DecryptedSecureJSONData["openAIAPIKey"]`.
- The browser never sends the provider API key.

### Central Model Configuration

Chat users cannot choose arbitrary models or base URLs from the chat page.

Admins configure:

- OpenAI-compatible base URL,
- default model,
- thinking level,
- thinking format,
- system prompt addendum.

The backend uses the configured model even though the client sends a model
object for Pi compatibility.

### Tool Least Privilege

Every prompt rebuilds the tool list.

Before a user prompt is submitted, the newly created agent has only subagent and
artifact tools. For normal prompts, the base tool groups are metrics,
subagents, and artifacts. Direct dashboard read, Jsonnet, and managed-dashboard
tools are added to the parent agent only when dashboard skills are active.

The dashboard specialist subagent is available as a delegation route, but it has
its own narrow prompt, tool-call budget, write-approval hook, and backend checks.
Raw dashboard upload and delete tools are not exposed unless the
`adHocDashboards` group is enabled.

### Explicit Write Approval

`beforeToolCall` in `ChatSceneObject.tsx` opens a confirmation modal for
persistent write tools:

- `sync_dashboard`,
- `upload_dashboard`,
- `delete_dashboard`.

If the user denies the modal, the tool call is blocked and the model receives a
tool error result.

### Datasource Allow-List

Admins can restrict Prometheus datasource UIDs.

The allow-list is enforced in two places:

- frontend metric tools only discover/query allowed Prometheus datasources,
- backend managed dashboard sync rejects dashboard JSON that references
  disallowed datasource UIDs.

### Prompt Guardrails

The base system prompt in `src/pages/Chat/systemPrompt.ts` says to:

- use only tool-returned or user-provided datasource UIDs, dashboard UIDs,
  metric names, label keys, and label values,
- prefer focused tool calls over speculation,
- avoid persistent dashboard changes unless explicitly requested,
- present specialist results as concise answers.

Specialist prompts add narrower rules for query, dashboard, investigation,
support, and navigation work.

### Data Volume Controls

- Query tools summarize data instead of returning raw frames by default.
- Tool results are truncated.
- Large outputs can be stored as artifacts.
- `read_artifact` lets the model inspect slices, fields, or `jq` results rather
  than re-reading bulky payloads.
- Session artifacts are capped by count and byte size.

### Jsonnet Controls

- Virtual Jsonnet writes require a chat session ID.
- Paths are normalized and restricted.
- Edits can include `baseVersion` and `expectedText`.
- Edited and repaired Jsonnet must compile before being accepted.
- `render_dashboard` previews a dashboard resource without saving.
- `sync_dashboard` is the only normal managed-dashboard persistence step.

## Backend Architecture

The backend is a Grafana Go app plugin.

Entry point:

```text
pkg/main.go -> app.Manage("g42-pi-app", plugin.NewApp, ...)
```

`pkg/plugin/app.go` creates an `App` instance with:

- loaded plugin settings,
- HTTP client,
- in-memory virtual Jsonnet file store,
- authz client cache,
- HTTP resource mux.

Routes are registered in `pkg/plugin/resources.go`:

```text
/llm/stream
/llm/api/stream
/managed-dashboards
/managed-dashboards/source
/managed-dashboards/render
/managed-dashboards/sync
/managed-dashboards/jsonnet-files/write
/managed-dashboards/jsonnet-files/edit
/managed-dashboards/jsonnet-files/repair
/managed-dashboards/jsonnet-files/read
/jsonnet-libs/search
/jsonnet-libs/read
/jsonnet-libs/list
```

The backend uses Grafana's plugin app client secret when it needs server-side
Grafana API access, for example the `dashboard.grafana.app` resource API.
That means managed dashboard writes are controlled by app access, the plugin
service account permissions in `plugin.json`, explicit write approval, and the
backend validation checks. By contrast, frontend tools that call Grafana through
`getBackendSrv()` or `getDataSourceSrv()` run with the current Grafana user's
normal permissions.

The health check returns an error when the LLM API key is not configured and OK
when the proxy can be configured.

## Build And Development Tooling

Frontend:

- Node dependency manager: npm.
- Node version: `package.json` requires `>=22`.
- Build: `npm run build`.
- Dev watch: `npm run dev`.
- Typecheck: `npm run typecheck`.
- Lint: `npm run lint`.
- Unit tests: `npm run test:ci`.
- Bundler: webpack through `.config/webpack/webpack.config.ts`.

Backend:

- Go module: `go.mod`.
- Go version: `1.26.3`.
- Grafana plugin SDK build: Mage.
- Linux build scripts:
  - `npm run backend:build:linux-amd64`,
  - `npm run backend:build:linux-arm64`.

Combined/local:

- `mise run dev:reload` runs:
  - `npm run build`,
  - `npm run backend:build:linux-arm64`,
  - `docker compose up -d --build --remove-orphans`,
  - `docker compose restart grafana`.
- `npm run server` runs `docker compose up --build`.
- `npm run validate` packages `dist` and runs the Grafana plugin validator.

Local Docker stack:

- Grafana 13.0.1 by default.
- Prometheus with synthetic demo metrics.
- Grafana image renderer for screenshots.
- Plugin provisioning with a local OpenAI-compatible base URL.
- Prometheus datasource UID `prometheus`.

Benchmarks and e2e tests:

- `npm run benchmark:agent`,
- `npm run benchmark:analysis`,
- `npm run benchmark:dashboard-context`,
- `npm run benchmark:explore-metrics`,
- `npm run e2e`.

## Patterns To Follow When Changing The App

Use these patterns when extending the app:

- Add new model capabilities as tools, not as direct model access to APIs.
- Give tools tight TypeBox schemas and bounded outputs.
- Put persistent or privileged behavior behind `beforeToolCall` or backend
  checks.
- Keep datasource and dashboard write checks on the backend when possible.
- Add tools to a named tool group, then activate that group through skills or
  specialist agents.
- Keep specialist agents narrow. Give them only the tools needed for the task.
- Prefer managed Jsonnet dashboards for durable dashboard changes.
- Keep custom skills non-secret and small enough to fit into model context.
- Regenerate bundled skills after changing `.agents/skills`.
- Use Grafana source or official docs when Grafana API behavior is unclear.
- Use Pi source when agent event, stream, tool hook, or execution behavior is
  unclear.

## First Files To Read

For a quick onboarding path:

1. `README.md`: product behavior and local development.
2. `src/plugin.json`: what Grafana registers.
3. `src/module.tsx`: how the frontend enters Grafana.
4. `src/components/App/App.tsx`: access check and Scenes app shell.
5. `src/pages/Chat/ChatSceneObject.tsx`: chat UI, agent lifecycle, sessions,
   approvals.
6. `src/pages/Chat/systemPrompt.ts`: top-level behavior rules.
7. `src/pages/Chat/tools/index.ts`: capability groups.
8. `src/pages/Chat/tools/subagents.ts`: specialist routing.
9. `pkg/plugin/resources.go`: LLM proxy and resource routes.
10. `pkg/plugin/managed_dashboards.go`: managed dashboard render/sync path.
11. `pkg/plugin/access.go`: backend access guard.

## Important Limits

This app reduces risk, but it does not make LLM output inherently trustworthy.
Treat the LLM as a planner that can be wrong. The trustworthy parts are the
checks around it:

- typed tool schemas,
- Grafana user permissions,
- app access checks,
- datasource allow-lists,
- explicit write approvals,
- backend dashboard validation,
- bounded query output,
- render-before-sync workflow.

When adding new capabilities, enforce safety in code and backend permissions,
not only in prompts.
