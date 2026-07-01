# Coding Agent App Contract

This document defines a browser-first contract for exposing Pi-style
coding-agent workflows from the Assistant app to other Grafana apps.

The first half is the stable provider/Assistant contract. The second half is
implementation guidance for this repository, including the local sample
provider and the current browser VFS and browser bash implementation.

## Contract Status

- Contract major version: `1`.
- Transport: Grafana plugin resource APIs plus Assistant route or sidebar
  launch context.
- Execution model: the model emits tool-call JSON; Assistant executes tools.
- Persistence model: browser-local edits are not authoritative. Provider
  backends remain authoritative for validation, persistence, and submit flows.

The contract is intentionally browser-first. The agent can see normal
coding-agent tools such as `workspace_info`, `read`, `grep`, `ls`, `edit`,
`write`, `preview_diff`, `save_changes`, and optionally `bash`, but those tools
do not need to touch a real host filesystem or OS process. They can be backed by
a browser virtual filesystem, provider app resource APIs, and an optional
browser-side shell runtime.

## Goals

- Let a Grafana app open Assistant with enough context to help users edit
  schema-backed resources.
- Give the model Pi-style coding tools while keeping implementation virtual and
  browser-local whenever possible.
- Keep provider apps authoritative for permissions, schemas, validation, save
  semantics, and submit workflows.
- Support structured resource tools and raw file-edit tools over the same
  workspace state.
- Make all persistent writes explicit, reviewable, and auditable.

## Non-goals

- Do not expose the user's local filesystem to Grafana or to the model.
- Do not run arbitrary provider app JavaScript inside Assistant.
- Do not give a browser shell secrets, Git credentials, or unrestricted network
  access.
- Do not bypass existing provider app approval, branch, review, or deployment
  workflows.
- Do not treat browser-local validation or browser-local shell execution as a
  provider authority boundary.

## Participants

- **Assistant app**: The Grafana app that owns the chat UI, Pi agent runtime,
  tool registry, approvals, session state, browser VFS, and optional browser
  shell runtime.
- **Provider app**: Any Grafana app that exposes editable resources, schemas,
  validation, and save or submit endpoints.
- **Workspace**: A logical editable tree created from provider app resources.
  It may contain source files, generated context files, schemas, and scratch
  files.
- **Browser VFS**: The in-browser filesystem used by Assistant tools. It can
  live in memory, IndexedDB, OPFS, or a combination of those stores.
- **Authoritative backend**: The provider app backend resource API. It remains
  the authority for access checks, final validation, persistence, and submit
  actions.

## Trust Boundaries

The contract assumes four separate boundaries:

1. **Model boundary**: The model only emits tool-call JSON. It does not directly
   access Grafana, plugin resources, files, schemas, or shell processes.
2. **Browser workspace boundary**: Assistant maps provider snapshots into a
   browser-local workspace. The browser workspace may contain sensitive resource
   content and must follow normal Grafana frontend data handling rules.
3. **Shell convenience boundary**: Optional browser `bash` is a convenience tool
   over the browser VFS. It is not a strong isolation boundary and is not the
   persistence authority.
4. **Provider authority boundary**: Only the provider backend can persist or
   submit changes. It must repeat access checks and validation.

Provider-supplied files, schemas, and context can contain prompt injection.
Assistant must treat them as data. Tool allow-lists, approval gates, provider
validation, and provider save endpoints are the enforcement mechanisms.

## Provider and Assistant Contract

### Launch Payload

The launch payload is the stable handoff between a provider app UI and
Assistant.

```json
{
  "contractVersion": "1",
  "sourcePluginId": "example-provider-app",
  "workspaceKind": "resource-workspace",
  "workspaceRef": {
    "repository": "platform/services",
    "path": "applications/shop/prod",
    "resourceId": "vm/web-01"
  },
  "contextId": "ctx_123",
  "intent": "edit-resource",
  "initialPrompt": "Increase the memory for web-01 and validate the change.",
  "capabilitiesPath": "/agent/capabilities",
  "returnPath": "/a/example-provider-app/resources"
}
```

Fields:

- `contractVersion`: Contract major version expected by the provider.
- `sourcePluginId`: Provider app plugin ID used for resource requests.
- `workspaceKind`: Provider-defined workspace type from the manifest.
- `workspaceRef`: Small, non-secret reference used to create the workspace.
- `contextId`: Optional short-lived reference for larger provider context.
- `intent`: Optional hint used by Assistant to choose an initial tool profile.
- `initialPrompt`: Optional first user-facing request.
- `capabilitiesPath`: Provider resource path for the capability manifest.
- `returnPath`: Optional Grafana route to return to after docking or review.

### Opening Assistant With A Workspace

The preferred in-app launch path is the Grafana extension sidebar. Provider
apps open the `grafana-assistant-app` sidebar component and pass the launch
payload as `agentWorkspaceLaunch`. The sidebar props may also include `path`,
which Assistant uses as the current route context and as a sensible dock or
return target.

```ts
getAppEvents().publish(
  new OpenExtensionSidebarEvent({
    pluginId: 'grafana-assistant-app',
    componentTitle: 'Assistant',
    props: {
      agentWorkspaceLaunch: launch,
      path: launch.returnPath,
    },
  })
);
```

If a provider needs to open the full Assistant route instead of the sidebar, it
can base64url-encode the JSON launch payload and append it as
`agentWorkspaceLaunch`:

```text
/a/grafana-assistant-app/chat?orgId=1&agentWorkspaceLaunch=<base64url-json>
```

`agentSample=vm-memory` is only the local sample fallback. Provider apps should
use the `agentWorkspaceLaunch` sidebar prop or URL parameter.

Large or sensitive launch context should not be encoded directly into URLs.
Provider apps should pass a small `contextId` and let Assistant retrieve the
full context from a provider backend endpoint, browser session storage owned by
the provider, or another explicit provider-controlled context channel.

The Assistant flow is:

```text
Provider app UI
  -> opens Assistant with launch context
Assistant app
  -> loads provider capability manifest
  -> creates browser VFS from provider snapshot
  -> runs Pi-style tools against the browser VFS
  -> asks provider backend for authoritative validation
  -> shows diff and approval UI
  -> calls provider save/submit endpoints only after approval
```

### Capability Manifest

A provider app exposes a manifest from a plugin resource endpoint. The manifest
describes what workspace kinds it supports, which generic tools are allowed, and
which backend endpoints Assistant may call.

```json
{
  "contractVersion": "1",
  "provider": {
    "pluginId": "example-provider-app",
    "displayName": "Example Provider"
  },
  "workspaceKinds": [
    {
      "kind": "resource-workspace",
      "displayName": "Resource workspace",
      "snapshotPath": "/agent/workspaces",
      "validatePath": "/agent/workspaces/{workspaceId}/validate",
      "previewPath": "/agent/workspaces/{workspaceId}/preview",
      "savePath": "/agent/workspaces/{workspaceId}/save",
      "submitPath": "/agent/workspaces/{workspaceId}/submit",
      "supportedTools": [
        "workspace_info",
        "ls",
        "find",
        "grep",
        "read",
        "edit",
        "write",
        "get_schema",
        "validate_workspace",
        "preview_diff",
        "save_changes",
        "submit_changes"
      ],
      "optionalTools": ["bash"],
      "semanticTools": []
    }
  ],
  "limits": {
    "maxFileBytes": 262144,
    "maxWorkspaceBytes": 5242880,
    "maxReadLines": 200,
    "maxToolOutputBytes": 65536,
    "maxShellRuntimeMs": 5000
  }
}
```

The manifest is not executable code. It is a declarative capability
description. Assistant owns the generic tool implementations and decides which
tools become active for a session.

`snapshotPath` normally points at the workspace create or resume endpoint,
`POST /agent/workspaces`, which returns the initial snapshot. Providers may also
expose `GET /agent/workspaces/{workspaceId}/snapshot` for refreshes.

`savePath` and `submitPath` can be omitted when the provider does not support
those persistent actions. `submit_changes` should only be listed when
`submitPath` exists.

Limits are provider-advertised policy. Assistant should enforce the relevant
limits for each generic tool it implements, and the provider must still enforce
server-side limits for all authoritative resource operations.

### Semantic Provider Tools

Provider apps may expose semantic tools in the manifest when raw file edits are
not the best user experience. These tools are still declarative. Assistant
validates the tool call against the declared schema, then executes the provider
resource route with the current workspace overlay.

```json
{
  "name": "upsert_resource",
  "label": "Create or update resource",
  "description": "Create or update one schema-backed resource in the workspace.",
  "parameters": {
    "type": "object",
    "required": ["schemaId", "resourceName", "document"],
    "additionalProperties": false,
    "properties": {
      "schemaId": { "type": "string" },
      "resourceName": { "type": "string" },
      "document": { "type": "object" }
    }
  },
  "execution": {
    "method": "POST",
    "path": "/agent/workspaces/{workspaceId}/tools/upsert-resource"
  },
  "effect": "overlayMutation",
  "approval": "notRequired"
}
```

`effect` should be one of:

- `read`: Reads provider or workspace state only.
- `overlayMutation`: Changes the browser VFS overlay but does not persist.
- `persistentMutation`: Persists or submits provider state.

`persistentMutation` tools must always require Assistant approval. Provider apps
should prefer semantic `overlayMutation` tools for common workflows, then use
`validate_workspace`, `preview_diff`, and `save_changes` for review and
persistence.

### Workspace Snapshot

The provider creates a workspace snapshot for the launch context. The snapshot
is immutable base state. Assistant keeps user and agent edits in a
browser-local overlay until a save operation is approved.

```json
{
  "workspaceId": "wks_123",
  "workspaceKind": "resource-workspace",
  "displayName": "platform/services applications/shop/prod",
  "baseVersion": "main:abc123",
  "rootPath": "/workspace",
  "files": [
    {
      "path": "/workspace/applications/shop/prod/virtual-machines.yaml",
      "content": "resources: {}\n",
      "language": "yaml",
      "version": "blob:abc123",
      "checksum": "sha256:...",
      "readOnly": false
    }
  ],
  "contextFiles": [
    {
      "path": "/context/resource.json",
      "content": "{\"resourceId\":\"vm/web-01\"}\n",
      "language": "json",
      "readOnly": true
    }
  ],
  "schemas": [
    {
      "schemaId": "virtual-machine.v1",
      "path": "/schemas/virtual-machine.v1.schema.json",
      "rootTypes": ["virtual_machine"]
    }
  ],
  "workspaceSchemaVersion": "provider-format-v1"
}
```

Assistant mounts these files into the browser VFS. A browser shell, if enabled,
sees the same virtual tree. This is not a host mount.

### Overlay Payload

`validate`, `preview`, `save`, `submit`, and semantic provider tools receive
the browser overlay as file contents, patches, or structured resource
operations. The provider must not trust browser-local validation results.

```json
{
  "baseVersion": "main:abc123",
  "files": [
    {
      "path": "/workspace/applications/shop/prod/virtual-machines.yaml",
      "baseVersion": "blob:abc123",
      "content": "resources: {}\n",
      "checksum": "sha256:..."
    }
  ],
  "operations": [
    {
      "type": "upsert_resource",
      "schemaId": "virtual-machine.v1",
      "resourceName": "web-01"
    }
  ]
}
```

Providers should treat `baseVersion`, file `baseVersion`, and checksums as
optimistic concurrency inputs, not as proof that the caller is authorized.

### Provider Resource API

Provider apps can expose any internal routes they need, but this shape is
recommended for interoperability:

```text
GET  /agent/capabilities
POST /agent/workspaces
GET  /agent/workspaces/{workspaceId}/snapshot
GET  /agent/workspaces/{workspaceId}/schemas/{schemaId}
POST /agent/workspaces/{workspaceId}/validate
POST /agent/workspaces/{workspaceId}/preview
POST /agent/workspaces/{workspaceId}/save
POST /agent/workspaces/{workspaceId}/submit
POST /agent/workspaces/{workspaceId}/tools/{toolName}
```

`POST /agent/workspaces` creates or resumes a workspace from `workspaceKind`,
`workspaceRef`, and optional `contextId`.

`snapshot` returns the current base snapshot. Providers may offer POST variants
for read endpoints when they need a request body for large context or
provider-scoped filters.

## Tool Semantics

Assistant should expose a small, selected tool profile per workspace. Tools use
Pi-style names and behavior, but browser implementations can be virtual.

### Read-only Tools

- `workspace_info`: summarize workspace, active resource, limits, and pending
  changes.
- `ls`: list VFS directory entries.
- `find`: find VFS paths by glob.
- `grep`: search VFS text files.
- `read`: read a bounded line window.
- `get_schema`: read schema metadata or schema content.

### Overlay Mutation Tools

- `edit`: exact-text or line-range edits against one VFS file.
- `write`: create or overwrite an allowed VFS file.
- `upsert_resource`: structured create/update of a schema-backed resource.
- `delete_resource`: structured deletion of a schema-backed resource, if the
  provider exposes it.

Mutation tools should require optimistic concurrency metadata when editing base
files:

```json
{
  "path": "/workspace/applications/shop/prod/virtual-machines.yaml",
  "baseVersion": "blob:abc123",
  "edits": [
    {
      "startLine": 12,
      "endLine": 14,
      "replacement": "      memory: 8192\n",
      "expectedText": "      memory: 4096"
    }
  ]
}
```

Tool results should include enough structured detail for UI renderers to show
changed ranges, diffs, validation findings, and pending changes. UI renderers
do not need to show every low-level version or checksum field by default.

### Validation and Review Tools

- `validate_workspace`: validate the current overlay. Provider backend
  validation is authoritative.
- `preview_diff`: return a compact diff and changed file list.
- `save_changes`: persist approved changes through the provider backend.
- `submit_changes`: start the provider's review, merge, deployment, or approval
  workflow when supported.

Persistent tools must be approval-gated by Assistant. Approval should show the
target provider app, action, changed files, diff, and validation findings.

### Optional Browser Bash

- `bash`: run one non-interactive command against the browser VFS.

The shell should be treated as a convenience tool, not as a trust boundary or
the persistence authority. It should have:

- no provider secrets,
- no Git credentials,
- no network by default,
- bounded CPU, memory, runtime, and output,
- access only to the VFS paths granted by the workspace,
- deterministic toolchain packages where possible.

If a shell command mutates files, those writes land in the browser VFS overlay
and still require validation and approval before save.

## Tool Result Shape

Tools should return a text summary for the model and structured details for the
UI.

```json
{
  "content": [
    {
      "type": "text",
      "text": "Edited /workspace/applications/shop/prod/virtual-machines.yaml."
    }
  ],
  "details": {
    "path": "/workspace/applications/shop/prod/virtual-machines.yaml",
    "version": "overlay:2",
    "checksum": "sha256:...",
    "changedRanges": [
      {
        "startLine": 12,
        "endLine": 14,
        "newLines": 1
      }
    ],
    "diff": "@@ ...",
    "validation": {
      "status": "warning",
      "findings": [
        {
          "severity": "warning",
          "message": "CPU request is higher than the default quota.",
          "sourcePath": "/workspace/applications/shop/prod/virtual-machines.yaml",
          "line": 18
        }
      ]
    }
  }
}
```

Errors should be actionable and include conflict details where possible:

```json
{
  "error": {
    "code": "version_conflict",
    "message": "File changed since workspace snapshot.",
    "path": "/workspace/applications/shop/prod/virtual-machines.yaml",
    "expectedVersion": "blob:abc123",
    "actualVersion": "blob:def456",
    "retryable": true
  }
}
```

## Provider Backend Responsibilities

Provider backends remain responsible for:

- authenticating the Grafana user,
- checking app and resource permissions,
- creating workspace snapshots,
- deciding allowed paths and actions,
- serving schemas and context,
- authoritative validation,
- enforcing server-side size and complexity limits,
- saving approved file or resource changes,
- creating review or submit artifacts,
- returning audit metadata.

Assistant should never infer that browser-local validation success means a
change may be persisted. It only means the workspace is ready to ask the
provider for authoritative validation or save.

## Assistant Responsibilities

Assistant is responsible for:

- maintaining the Pi agent session,
- building the browser VFS,
- exposing the selected tool profile,
- enforcing local tool limits where it owns the tool implementation,
- routing provider resource requests through Grafana APIs,
- rendering tool calls, diffs, findings, and approval UI,
- blocking persistent writes until the user approves them,
- recording enough session state to explain what the agent changed.

Assistant should not make provider-specific assumptions beyond the manifest,
workspace snapshot, schemas, and resource endpoints.

## Security Model

Provider-supplied files, schemas, and context must be treated as untrusted data.
They can contain prompt injection. The model should receive enough context to do
the task, but enforcement must stay in tool allow-lists, local limits, approval
gates, and provider backend validation.

Persistent actions require both Assistant approval and provider backend
authorization. Assistant approval is a user-experience and review boundary; it
does not replace provider access checks.

Browser shell execution is not equivalent to a microVM. It is appropriate for
formatting, searching, inspecting, and simple transformations over the browser
VFS. It is not appropriate for code that needs host isolation, secrets, network
credentials, or provider-side authority.

## Versioning

All launch payloads and manifests include `contractVersion`. Breaking changes
must increment the major version. Additive fields can be introduced without a
major version change when older Assistant versions can ignore them safely.

Provider apps should also include a provider-specific `workspaceSchemaVersion`
in snapshots when their resource format changes independently of this contract.

## Implementation Guidance

This section describes how to implement the contract in this repository. It is
not part of the provider contract unless explicitly stated above.

### Provider Backend Implementation

A provider backend should:

1. Expose `GET /agent/capabilities`.
2. Implement `POST /agent/workspaces` to create a snapshot from `workspaceKind`,
   `workspaceRef`, and optional `contextId`.
3. Serve schema content through
   `/agent/workspaces/{workspaceId}/schemas/{schemaId}`.
4. Implement authoritative `validate`, `preview`, and `save` routes.
5. Reject saves when validation status is `error`.
6. Return compact changed-file metadata and unified diffs from preview/save.
7. Keep audit metadata on persistent operations.
8. Repeat Grafana user access checks on every resource route.

The backend should not trust browser VFS state, browser shell output, or model
claims. It should parse and validate submitted overlay content using provider
code and provider permissions.

### Assistant Frontend Implementation

The current Assistant frontend flow is:

1. Parse a launch payload or local sample URL in
   `src/pages/Chat/agentWorkspace/launch.ts`.
2. Fetch the provider manifest and initial snapshot in
   `src/pages/Chat/agentWorkspace/providerClient.ts`.
3. Build an `AgentWorkspaceVFS` from the snapshot.
4. Register generic workspace tools in
   `src/pages/Chat/agentWorkspace/tools.ts`.
5. Add optional `bash` only when the manifest advertises it.
6. Build a workspace-specific system prompt and context block.
7. Approval-gate `save_changes` and `submit_changes` in
   `src/pages/Chat/ChatSceneObject.tsx`.
8. Render compact tool calls, read results, validation findings, and open diffs
   in `src/pages/Chat/ToolRenderer.tsx`.

When an agent workspace is active, Assistant replaces the normal Grafana
dashboard/Prometheus tool profile with the workspace tool profile. This keeps
the benchmark and manual sample focused on the Coding Agent App Contract tools.

### Browser VFS Implementation

The current browser VFS lives in `src/pages/Chat/agentWorkspace/vfs.ts`.

Implemented behavior:

- Maintains base files and overlay files.
- Treats context files and schema files as read-only.
- Resolves reads from overlay before base.
- Supports `workspace_info`, `ls`, `find`, `grep`, `read`, `edit`, `write`,
  `get_schema`, `validate_workspace`, `preview_diff`, and `save_changes`.
- Produces compact diffs using the `diff` package.
- Builds overlay payloads for provider validation, preview, save, and semantic
  tools.

The VFS is a browser-local working copy. Provider save endpoints decide what
paths and resource changes are actually persistable.

### Browser Bash Implementation

The current `bash` tool lives in `src/pages/Chat/agentWorkspace/shell.ts` and
runs in the browser through `just-bash/browser`.

Current boundaries:

- It is browser-side simulated bash, not Go backend bash and not host bash.
- It runs over an in-memory filesystem.
- It mounts writable `/workspace`.
- It mounts read-only `/context` and `/schemas`.
- It has an ephemeral in-memory `/tmp`.
- It disables Python and JavaScript execution.
- It uses a fixed command allow-list that excludes network tools such as
  `curl` and `wget`.
- It caps runtime with `maxShellRuntimeMs`, defaulting to `5000`.
- It caps stdout/stderr and shell string/heredoc sizes with
  `maxToolOutputBytes`, defaulting to `65536`.
- It caps synced file size with `maxFileBytes`, defaulting to `262144`.
- It rejects deletion of existing `/workspace` files during sync back into the
  overlay.

Current caveat: the manifest advertises `maxWorkspaceBytes`, but the frontend
bash sync path currently enforces per-file size rather than total workspace
size. Providers must still enforce authoritative limits server-side.

### Tool Renderer Guidance

Workspace tool rendering should optimize for reviewability, not raw JSON dumps.

Current renderer behavior:

- Workspace tool calls are collapsed by default.
- `read` results are collapsed by default and hide low-level metadata behind a
  nested metadata block.
- Diff-backed `edit`, `write`, `upsert_resource`, `preview_diff`, and
  `save_changes` render the compact diff open by default.
- Diff-backed results avoid redundant version/checksum/pending/status/file-table
  shells when the diff itself already communicates the change.
- Full-file replacement diffs are normalized into compact hunks where possible.

Tool results should still keep structured details available for debugging and
export, but the default UI should lead with the data needed to review the
change.

## Current Repository Implementation

### Backend Sample Provider

The local sample provider is implemented in:

- `pkg/plugin/app.go`: enables the sample store when
  `PI_AGENT_CONTRACT_SAMPLE` is enabled.
- `pkg/plugin/resources.go`: registers `/agent/...` resource routes when the
  sample is enabled.
- `pkg/plugin/agent_contract_sample.go`: implements capabilities, workspace
  snapshot, schema, validation, preview, save, and `upsert_resource`.

The sample provider:

- uses `sourcePluginId: grafana-assistant-app` in the assistant variant,
- exposes workspace kind `sample-resource-workspace`,
- serves a virtual-machine JSON document,
- validates `kind`, `cpu`, and `memoryMiB`,
- returns compact diffs for preview/save,
- saves only in memory,
- exposes optional `bash`,
- exposes semantic `upsert_resource`.

It is for local testing and evaluation, not real resource management.

### Frontend Workspace Implementation

The frontend implementation is split across:

- `src/pages/Chat/agentWorkspace/launch.ts`: sample launch and workspace prompt.
- `src/pages/Chat/agentWorkspace/providerClient.ts`: provider resource client.
- `src/pages/Chat/agentWorkspace/types.ts`: contract TypeScript types.
- `src/pages/Chat/agentWorkspace/vfs.ts`: browser VFS and overlay payloads.
- `src/pages/Chat/agentWorkspace/tools.ts`: generic and semantic tools.
- `src/pages/Chat/agentWorkspace/shell.ts`: optional browser bash wrapper.
- `src/pages/Chat/ChatSceneObject.tsx`: session setup, tool profile selection,
  benchmark capture, and approval gating.
- `src/pages/Chat/ToolRenderer.tsx`: workspace tool renderers.

### Local Development Flags

The local Docker Compose stacks enable the sample with:

```text
PI_AGENT_CONTRACT_SAMPLE=1
```

The sidebar-capable local variant should be used for manual testing:

```bash
mise run dev:reload:variant
```

### Manual Sample URL

Open the sidebar-capable local variant and launch the sample workspace with:

```text
http://localhost:3001/a/grafana-assistant-app/chat?orgId=1&agentSample=vm-memory
```

For benchmark-style event capture, use the single canonical benchmark flag:

```text
http://localhost:3001/a/grafana-assistant-app/chat?orgId=1&agentSample=vm-memory&piAgentBenchmark=1
```

`agentSample=vm-memory` is consumed after workspace initialization.
`piAgentBenchmark=1` remains in the URL so benchmark event capture stays active.
This sample URL is a local development fallback; provider apps should launch
Assistant with `agentWorkspaceLaunch` through the sidebar prop or URL parameter.

### Benchmark

Run the end-to-end benchmark with:

```bash
npm run benchmark:agent-contract-sample
```

The benchmark starts the local assistant variant, opens:

```text
/a/grafana-assistant-app/chat?orgId=1&agentSample=vm-memory&piAgentBenchmark=1
```

It asks the agent to:

1. call `workspace_info`,
2. call `read`,
3. call `edit`,
4. call `validate_workspace`,
5. call `preview_diff`,
6. call `save_changes`,
7. answer `AGENT_CONTRACT_SAMPLE_DONE`.

The test auto-approves `save_changes`, checks required tool usage, rejects
unrelated Grafana dashboard tools, and writes benchmark artifacts under
`test-results/agent-contract-sample-benchmark`.

## Recommended Implementation Sequence

1. Launch Assistant from a provider app with `sourcePluginId`,
   `workspaceKind`, `workspaceRef`, and `capabilitiesPath`.
2. Load a browser VFS snapshot with source files, schemas, and context files.
3. Expose read-only tools plus `edit`, `validate_workspace`, and
   `preview_diff`.
4. Add approval-gated `save_changes`.
5. Add structured semantic tools for common resources.
6. Add optional browser `bash` after the VFS, validation, and approval flow are
   stable.

This sequence gives users a real coding-agent workflow early while keeping
persistence under the provider app's existing control.
