package plugin

import (
	"strings"
	"testing"
)

func TestAgentContractSampleWorkspaceLifecycle(t *testing.T) {
	store := newAgentContractSampleStore("grafana-assistant-app")
	snapshot, err := store.createWorkspace(agentContractLaunchRequest{WorkspaceKind: agentContractSampleWorkspaceKind})
	if err != nil {
		t.Fatalf("create workspace failed: %s", err)
	}
	workspaceID, _ := snapshot["workspaceId"].(string)
	baseVersion, _ := snapshot["baseVersion"].(string)
	if workspaceID == "" || baseVersion == "" {
		t.Fatalf("snapshot missing identity: %#v", snapshot)
	}

	updated := strings.Replace(agentContractSampleWorkspaceContent, `"memoryMiB": 4096`, `"memoryMiB": 8192`, 1)
	overlay := agentContractOverlayPayload{
		BaseVersion: baseVersion,
		Files: []agentContractOverlayFile{
			{
				Path:        agentContractSampleWorkspaceFilePath,
				BaseVersion: checksumBytes([]byte(agentContractSampleWorkspaceContent)),
				Content:     updated,
			},
		},
	}

	validation, err := store.validate(workspaceID, overlay)
	if err != nil {
		t.Fatalf("validate failed: %s", err)
	}
	if validation.Status != "valid" {
		t.Fatalf("expected valid workspace, got %#v", validation)
	}

	preview, err := store.preview(workspaceID, overlay, false)
	if err != nil {
		t.Fatalf("preview failed: %s", err)
	}
	if preview.Status != "changed" || len(preview.ChangedFiles) != 1 {
		t.Fatalf("expected one changed file, got %#v", preview)
	}
	if !strings.Contains(preview.Diff, `"memoryMiB": 4096`) || !strings.Contains(preview.Diff, `"memoryMiB": 8192`) {
		t.Fatalf("diff did not show memory change:\n%s", preview.Diff)
	}

	save, err := store.save(workspaceID, overlay)
	if err != nil {
		t.Fatalf("save failed: %s", err)
	}
	if save.Status != "saved" || save.SavedVersion == "" {
		t.Fatalf("unexpected save response: %#v", save)
	}

	afterSave, err := store.preview(workspaceID, agentContractOverlayPayload{}, false)
	if err != nil {
		t.Fatalf("preview after save failed: %s", err)
	}
	if afterSave.Status != "unchanged" {
		t.Fatalf("expected saved workspace to be unchanged, got %#v", afterSave)
	}
}

func TestAgentContractSampleUpsertResourceMutatesOverlay(t *testing.T) {
	store := newAgentContractSampleStore("grafana-assistant-app")
	snapshot, err := store.createWorkspace(agentContractLaunchRequest{WorkspaceKind: agentContractSampleWorkspaceKind})
	if err != nil {
		t.Fatalf("create workspace failed: %s", err)
	}
	workspaceID, _ := snapshot["workspaceId"].(string)

	result, err := store.upsertResource(workspaceID, agentContractToolRequest{
		Args: map[string]any{
			"schemaId":     agentContractSampleSchemaID,
			"resourceName": "worker-01",
			"document": map[string]any{
				"kind":      "VirtualMachine",
				"cpu":       4,
				"memoryMiB": 16384,
			},
		},
	})
	if err != nil {
		t.Fatalf("upsert failed: %s", err)
	}
	if len(result.Files) != 1 {
		t.Fatalf("expected one overlay file, got %#v", result.Files)
	}
	if !strings.Contains(result.Files[0].Content, `"worker-01"`) || !strings.Contains(result.Files[0].Content, `"memoryMiB": 16384`) {
		t.Fatalf("upsert result did not include worker resource:\n%s", result.Files[0].Content)
	}
	if result.Validation.Status != "valid" {
		t.Fatalf("expected valid upsert result, got %#v", result.Validation)
	}
}

func TestAgentContractSampleValidationRejectsInvalidMemory(t *testing.T) {
	store := newAgentContractSampleStore("grafana-assistant-app")
	snapshot, err := store.createWorkspace(agentContractLaunchRequest{WorkspaceKind: agentContractSampleWorkspaceKind})
	if err != nil {
		t.Fatalf("create workspace failed: %s", err)
	}
	workspaceID, _ := snapshot["workspaceId"].(string)
	updated := strings.Replace(agentContractSampleWorkspaceContent, `"memoryMiB": 4096`, `"memoryMiB": 777`, 1)

	validation, err := store.validate(workspaceID, agentContractOverlayPayload{
		Files: []agentContractOverlayFile{{Path: agentContractSampleWorkspaceFilePath, Content: updated}},
	})
	if err != nil {
		t.Fatalf("validate failed: %s", err)
	}
	if validation.Status != "error" {
		t.Fatalf("expected validation error, got %#v", validation)
	}
	if len(validation.Findings) == 0 || !strings.Contains(validation.Findings[0].Message, "multiple of 128") {
		t.Fatalf("expected multiple-of finding, got %#v", validation.Findings)
	}
}
