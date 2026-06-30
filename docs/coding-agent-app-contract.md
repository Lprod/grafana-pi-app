# Coding Agent App Contract

This document defines a generic contract for exposing Pi-style coding-agent
abilities from the Assistant app to other Grafana apps.

The contract is intentionally browser-first. The agent can see normal coding
tools such as `read`, `grep`, `ls`, `edit`, `write`, and optionally `bash`, but
those tools do not need to touch a real host filesystem or process. They can be
backed entirely by a browser virtual filesystem, provider app resource APIs, and
an optional WASM runtime.

## Goals

- Let a Grafana app open Assistant with enough context to help users edit
  schema-backed resources.
- Give the model Pi-style coding tools while keeping the implementation virtual
  and browser-local whenever possible.
- Keep provider apps authoritative for permissions, schemas, validation, save
  semantics, and submit workflows.
- Support structured resource tools and raw file-edit tools over the same
  workspace state.
- Make all persistent writes explicit, reviewable, and auditable.

## Non-goals

- Do not expose the user's local filesystem to Grafana or to the model.
- Do not run arbitrary provider app JavaScript inside Assistant.
- Do not give a browser WASM shell secrets, Git credentials, or unrestricted
  network access.
- Do not bypass existing provider app approval, branch, review, or deployment
  workflows.

## Participants

- **Assistant app**: The Grafana app that owns the chat UI, Pi agent runtime,
  tool registry, approvals, session state, and optional browser WASM runtime.
- **Provider app**: Any Grafana app that exposes editable resources, schemas,
  validation, and save/submit endpoints.
- **Workspace**: A logical editable tree created from provider app resources.
  It may contain source files, generated context files, schemas, and scratch
  files.
- **Browser VFS**: The in-browser filesystem used by the Assistant tools. It can
  live in memory, IndexedDB, OPFS, or a combination of those stores.
- **Authoritative backend**: The provider app backend resource API. It remains
  the authority for access checks, final validation, persistence, and submit
  actions.

## Integration Shape

The provider app starts an Assistant session by passing a launch context to the
Assistant sidebar or app route.

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
  "intent": "edit-resource",
  "initialPrompt": "Increase the memory for web-01 and validate the change.",
  "capabilitiesPath": "/agent/capabilities"
}
```

Large or sensitive launch context should not be encoded directly into URLs.
Provider apps should pass a small `contextId` and let Assistant retrieve the
full context from a provider backend endpoint, browser session storage owned by
the provider, or another explicit provider-controlled context channel.

### Launch Payload

The launch payload is the stable handoff between the provider app UI and
Assistant.

```json
{
  "contractVersion": "1",
  "sourcePluginId": "example-provider-app",
  "workspaceKind": "resource-workspace",
  "workspaceRef": {},
  "contextId": "ctx_123",
  "intent": "create-resource",
  "initialPrompt": "Create a resource using the selected schema.",
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

The Assistant uses `sourcePluginId` and `capabilitiesPath` to discover the
provider's agent capabilities. It then asks the provider backend for a workspace
snapshot, initializes the browser VFS, and exposes a selected tool profile to
the agent.

```text
Provider app UI
  -> opens Assistant with launch context
Assistant app
  -> loads provider capability manifest
  -> creates browser VFS from provider snapshot
  -> runs Pi-style tools against the browser VFS
  -> validates locally for fast feedback when possible
  -> asks provider backend for authoritative validation
  -> shows diff and approval UI
  -> calls provider save/submit endpoints only after approval
```

The model does not need to know the filesystem is virtual. It sees the same
style of tool names, schemas, and results it would see in a normal coding-agent
environment.

## Capability Manifest

A provider app exposes a manifest from a plugin resource endpoint. The manifest
describes what workspace kinds it supports, which actions are allowed, and which
backend endpoints Assistant may call.

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
      "savePath": "/agent/workspaces/{workspaceId}/save",
      "submitPath": "/agent/workspaces/{workspaceId}/submit",
      "supportedTools": [
        "read",
        "grep",
        "find",
        "ls",
        "edit",
        "write",
        "get_schema",
        "validate_workspace",
        "preview_diff",
        "save_changes",
        "submit_changes"
      ],
      "optionalTools": ["bash"],
      "semanticTools": ["upsert_resource", "delete_resource"]
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

The manifest is not executable code. It is a declarative capability description.
Assistant owns the generic tool implementations and decides which tools become
active for a session.

### Provider-specific tools

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
    "properties": {
      "schemaId": { "type": "string" },
      "resourceName": { "type": "string" },
      "document": { "type": "object" }
    },
    "additionalProperties": false
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

`persistentMutation` tools must always require Assistant approval. Provider
apps should prefer semantic `overlayMutation` tools for common workflows, then
use `validate_workspace`, `preview_diff`, and `save_changes` for review and
persistence.

## Workspace Snapshot

The provider creates a workspace snapshot for the launch context. The snapshot
is immutable base state. Assistant keeps user and agent edits in a browser-local
overlay until a save operation is approved.

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
  ]
}
```

Assistant mounts these files into the browser VFS. A WASM shell, if enabled,
sees the same tree through its preopened filesystem namespace. This is a virtual
mount only; it is not a host mount.

## Provider Resource API

Provider apps can expose any internal routes they need, but the following
resource API shape is recommended for interoperability:

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

`snapshot` returns the current base snapshot. Providers may also offer POST
variants for read endpoints when they need a request body for large context or
provider-scoped filters.

`validate`, `preview`, `save`, and `submit` receive the browser overlay as file
contents, patches, or structured resource operations. The provider must not
trust browser-local validation results.

Example overlay payload:

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

## Browser VFS Layers

The browser VFS should maintain distinct layers:

- `base`: files from the provider snapshot.
- `overlay`: edits made by tools or user UI.
- `scratch`: temporary files created by optional shell commands.
- `schemas`: schema documents and generated schema summaries.
- `context`: provider-supplied resource and workflow context.

Reads resolve `overlay` before `base`. Diffs compare `overlay` to `base`.
Scratch files are not persisted unless a tool explicitly moves them into a
persistable path and the provider allows that path.

## Tool Profiles

Assistant should expose a small, selected tool profile per workspace. Tools use
Pi-style names and behavior, but browser implementations are free to be virtual.

### Read-only tools

- `ls`: list VFS directory entries.
- `find`: find VFS paths by glob.
- `grep`: search VFS text files.
- `read`: read a bounded line window or a whole small file.
- `get_schema`: read schema metadata or schema content.
- `workspace_info`: summarize workspace, active resource, limits, and pending
  changes.

### Mutation tools

- `edit`: exact-text or line-range edits against one VFS file.
- `write`: create or overwrite an allowed VFS file.
- `upsert_resource`: structured create/update of a schema-backed resource.
- `delete_resource`: structured deletion of a schema-backed resource.

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

Tool results should include the new file version, checksum, changed ranges,
first changed line, and a compact diff.

### Validation and review tools

- `validate_workspace`: validate the current overlay. This may run local
  browser validation first, but provider backend validation is authoritative.
- `preview_diff`: return a compact diff and changed file list.
- `save_changes`: persist approved changes through the provider backend.
- `submit_changes`: start the provider's review, merge, deployment, or approval
  workflow when supported.

Persistent tools must be approval-gated by Assistant. Approval should show the
changed files, diff, validation findings, target provider app, and action.

### Optional WASM shell

- `bash`: run a non-interactive command against the browser VFS.

The shell should be treated as a convenience tool, not as a trust boundary or
the persistence authority. It should have:

- no provider secrets,
- no Git credentials,
- no network by default,
- bounded CPU, memory, runtime, and output,
- access only to the VFS paths granted by the workspace,
- deterministic toolchain packages where possible.

Useful shell commands include `jq`, `yq`, JSON schema validators, formatters,
diff helpers, and text search. If a shell command mutates files, those writes
land in the VFS overlay and still require validation and approval before save.

## Tool Result Shape

Tools should return a text summary for the model and structured details for the
UI.

```json
{
  "content": [
    {
      "type": "text",
      "text": "Edited /workspace/applications/shop/prod/virtual-machines.yaml. Validation has 1 warning."
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
- saving approved file or resource changes,
- creating review or submit artifacts,
- returning audit metadata.

Assistant should never infer that a browser-local validation success means a
change may be persisted. It only means the workspace is ready to ask the
provider for authoritative validation or save.

## Assistant Responsibilities

Assistant is responsible for:

- maintaining the Pi agent session,
- building the browser VFS,
- exposing the selected tool profile,
- enforcing local tool limits,
- routing provider resource requests through Grafana APIs,
- rendering tool calls, diffs, findings, and approval UI,
- blocking persistent writes until the user approves them,
- recording enough session state to explain what the agent changed.

Assistant should not make provider-specific assumptions beyond the manifest,
workspace snapshot, schemas, and resource endpoints.

## Security Model

The contract assumes three separate boundaries:

1. **Model boundary**: The model only emits tool-call JSON. It does not directly
   access Grafana, plugin resources, files, schemas, or shell processes.
2. **Browser sandbox boundary**: Browser VFS and optional WASM shell are
   isolated from the user's host filesystem. They may still contain sensitive
   resource content and must follow normal Grafana frontend data handling rules.
3. **Provider authority boundary**: Only the provider backend can persist or
   submit changes. It must repeat all access checks and validation.

Provider-supplied files, schemas, and context can contain prompt injection.
Assistant should treat them as data. Tool allow-lists, approval gates, backend
validation, and save endpoints are the enforcement mechanisms.

## Versioning

All launch payloads and manifests include `contractVersion`. Breaking changes
must increment the major version. Additive fields can be introduced without a
major version change when older Assistant versions can ignore them safely.

Provider apps should also include a provider-specific `workspaceSchemaVersion`
in snapshots when their resource format changes independently of this contract.

## Recommended First Implementation

1. Launch Assistant from a provider app with `sourcePluginId`,
   `workspaceKind`, `workspaceRef`, and `capabilitiesPath`.
2. Load a browser VFS snapshot with source files, schemas, and context files.
3. Expose read-only tools plus `edit`, `validate_workspace`, and
   `preview_diff`.
4. Add approval-gated `save_changes`.
5. Add structured semantic tools for common resources.
6. Add optional WASM `bash` after the VFS, validation, and approval flow are
   stable.

This sequence gives users a real coding-agent workflow early while keeping
persistence under the provider app's existing control.
