package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	agentContractVersion                 = "1"
	agentContractSampleWorkspaceKind     = "sample-resource-workspace"
	agentContractSampleWorkspaceRoot     = "/workspace"
	agentContractSampleWorkspaceFilePath = "/workspace/platform/shop/prod/virtual-machines.json"
	agentContractSampleSchemaID          = "virtual-machine.v1"
	agentContractSampleSchemaPath        = "/schemas/virtual-machine.v1.schema.json"
	agentContractSampleContextPath       = "/context/resource.json"
)

const agentContractSampleWorkspaceContent = `{
  "resources": {
    "web-01": {
      "kind": "VirtualMachine",
      "cpu": 2,
      "memoryMiB": 4096
    }
  }
}
`

const agentContractSampleContextContent = `{"resourceId":"vm/web-01","resourceName":"web-01","goal":"Evaluate coding-agent app contract workspace editing."}
`

const agentContractSampleSchemaContent = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "virtual-machine.v1",
  "title": "Virtual machine",
  "type": "object",
  "required": ["kind", "cpu", "memoryMiB"],
  "additionalProperties": false,
  "properties": {
    "kind": {
      "const": "VirtualMachine"
    },
    "cpu": {
      "type": "integer",
      "minimum": 1,
      "maximum": 64
    },
    "memoryMiB": {
      "type": "integer",
      "minimum": 512,
      "maximum": 262144,
      "multipleOf": 128
    }
  }
}
`

type agentContractSampleStore struct {
	mu         sync.Mutex
	pluginID   string
	nextID     int
	workspaces map[string]*agentContractSampleWorkspace
}

type agentContractSampleWorkspace struct {
	ID          string
	Kind        string
	DisplayName string
	BaseVersion string
	SaveCount   int
	Files       map[string]agentContractSampleFile
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type agentContractSampleFile struct {
	Path      string
	Content   string
	Language  string
	Version   string
	ReadOnly  bool
	UpdatedAt time.Time
}

type agentContractLaunchRequest struct {
	WorkspaceKind string         `json:"workspaceKind"`
	WorkspaceRef  map[string]any `json:"workspaceRef,omitempty"`
	ContextID     string         `json:"contextId,omitempty"`
}

type agentContractOverlayPayload struct {
	BaseVersion string                     `json:"baseVersion,omitempty"`
	Files       []agentContractOverlayFile `json:"files,omitempty"`
	Operations  []map[string]any           `json:"operations,omitempty"`
}

type agentContractOverlayFile struct {
	Path        string `json:"path"`
	BaseVersion string `json:"baseVersion,omitempty"`
	Content     string `json:"content"`
	Checksum    string `json:"checksum,omitempty"`
}

type agentContractValidationResponse struct {
	Status      string                         `json:"status"`
	Findings    []agentContractSampleFinding   `json:"findings"`
	WorkspaceID string                         `json:"workspaceId,omitempty"`
	BaseVersion string                         `json:"baseVersion,omitempty"`
	CheckedAt   string                         `json:"checkedAt"`
	Summary     string                         `json:"summary"`
	Details     map[string]agentVMResourceSpec `json:"details,omitempty"`
}

type agentContractSampleFinding struct {
	Severity   string `json:"severity"`
	Message    string `json:"message"`
	SourcePath string `json:"sourcePath,omitempty"`
	Line       int    `json:"line,omitempty"`
}

type agentContractPreviewResponse struct {
	Status       string                           `json:"status"`
	WorkspaceID  string                           `json:"workspaceId"`
	BaseVersion  string                           `json:"baseVersion"`
	ChangedFiles []agentContractChangedFile       `json:"changedFiles"`
	Diff         string                           `json:"diff"`
	Validation   *agentContractValidationResponse `json:"validation,omitempty"`
}

type agentContractSaveResponse struct {
	Status       string                          `json:"status"`
	WorkspaceID  string                          `json:"workspaceId"`
	SavedVersion string                          `json:"savedVersion"`
	ChangedFiles []agentContractChangedFile      `json:"changedFiles"`
	Diff         string                          `json:"diff"`
	Validation   agentContractValidationResponse `json:"validation"`
	Audit        agentContractAuditMetadata      `json:"audit"`
}

type agentContractAuditMetadata struct {
	Action    string `json:"action"`
	Provider  string `json:"provider"`
	CreatedAt string `json:"createdAt"`
}

type agentContractChangedFile struct {
	Path          string `json:"path"`
	BaseVersion   string `json:"baseVersion"`
	Checksum      string `json:"checksum"`
	AddedLines    int    `json:"addedLines"`
	RemovedLines  int    `json:"removedLines"`
	FirstChanged  int    `json:"firstChangedLine,omitempty"`
	PreviousBytes int    `json:"previousBytes"`
	CurrentBytes  int    `json:"currentBytes"`
}

type agentContractToolRequest struct {
	Overlay agentContractOverlayPayload `json:"overlay"`
	Args    map[string]any              `json:"args"`
}

type agentContractToolResponse struct {
	Summary    string                          `json:"summary"`
	Files      []agentContractOverlayFile      `json:"files"`
	Operation  map[string]any                  `json:"operation"`
	Validation agentContractValidationResponse `json:"validation"`
	Diff       string                          `json:"diff"`
}

type agentVMDocument struct {
	Resources map[string]agentVMResourceSpec `json:"resources"`
}

type agentVMResourceSpec struct {
	Kind      string `json:"kind"`
	CPU       int    `json:"cpu"`
	MemoryMiB int    `json:"memoryMiB"`
}

func newAgentContractSampleStore(pluginID string) *agentContractSampleStore {
	return &agentContractSampleStore{
		pluginID:   pluginID,
		workspaces: map[string]*agentContractSampleWorkspace{},
	}
}

func (a *App) handleAgentContractSampleCapabilities(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, a.agentSample.capabilities())
}

func (a *App) handleAgentContractSampleWorkspaces(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body agentContractLaunchRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	snapshot, err := a.agentSample.createWorkspace(body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (a *App) handleAgentContractSampleWorkspaceResource(w http.ResponseWriter, req *http.Request) {
	suffix := strings.TrimPrefix(req.URL.Path, "/agent/workspaces/")
	parts := strings.Split(strings.Trim(suffix, "/"), "/")
	if len(parts) < 2 || parts[0] == "" {
		writeJSONError(w, http.StatusNotFound, "workspace resource not found")
		return
	}

	workspaceID := parts[0]
	switch {
	case len(parts) == 2 && parts[1] == "snapshot":
		if req.Method != http.MethodGet {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		snapshot, err := a.agentSample.snapshot(workspaceID)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	case len(parts) == 3 && parts[1] == "schemas":
		if req.Method != http.MethodGet {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		schema, err := a.agentSample.schema(workspaceID, parts[2])
		if err != nil {
			writeJSONError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, schema)
	case len(parts) == 2 && parts[1] == "validate":
		if req.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		overlay, ok := decodeAgentContractOverlay(w, req)
		if !ok {
			return
		}
		validation, err := a.agentSample.validate(workspaceID, overlay)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, validation)
	case len(parts) == 2 && parts[1] == "preview":
		if req.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		overlay, ok := decodeAgentContractOverlay(w, req)
		if !ok {
			return
		}
		preview, err := a.agentSample.preview(workspaceID, overlay, false)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, preview)
	case len(parts) == 2 && parts[1] == "save":
		if req.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		overlay, ok := decodeAgentContractOverlay(w, req)
		if !ok {
			return
		}
		save, err := a.agentSample.save(workspaceID, overlay)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, save)
	case len(parts) == 3 && parts[1] == "tools" && parts[2] == "upsert-resource":
		if req.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var body agentContractToolRequest
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
			return
		}
		result, err := a.agentSample.upsertResource(workspaceID, body)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, result)
	default:
		writeJSONError(w, http.StatusNotFound, "workspace resource not found")
	}
}

func decodeAgentContractOverlay(w http.ResponseWriter, req *http.Request) (agentContractOverlayPayload, bool) {
	var overlay agentContractOverlayPayload
	if err := json.NewDecoder(req.Body).Decode(&overlay); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return overlay, false
	}
	return overlay, true
}

func (s *agentContractSampleStore) capabilities() map[string]any {
	return map[string]any{
		"contractVersion": agentContractVersion,
		"provider": map[string]any{
			"pluginId":    s.pluginID,
			"displayName": "Assistant contract sample provider",
		},
		"workspaceKinds": []map[string]any{
			{
				"kind":         agentContractSampleWorkspaceKind,
				"displayName":  "Sample resource workspace",
				"snapshotPath": "/agent/workspaces",
				"validatePath": "/agent/workspaces/{workspaceId}/validate",
				"previewPath":  "/agent/workspaces/{workspaceId}/preview",
				"savePath":     "/agent/workspaces/{workspaceId}/save",
				"supportedTools": []string{
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
				},
				"optionalTools": []string{"bash"},
				"semanticTools": []map[string]any{
					{
						"name":        "upsert_resource",
						"label":       "Create or update resource",
						"description": "Create or update one virtual-machine resource in the sample workspace.",
						"parameters": map[string]any{
							"type":                 "object",
							"required":             []string{"schemaId", "resourceName", "document"},
							"additionalProperties": false,
							"properties": map[string]any{
								"schemaId":     map[string]any{"type": "string", "const": agentContractSampleSchemaID},
								"resourceName": map[string]any{"type": "string", "minLength": 1},
								"document": map[string]any{
									"type":                 "object",
									"required":             []string{"kind", "cpu", "memoryMiB"},
									"additionalProperties": false,
									"properties": map[string]any{
										"kind":      map[string]any{"type": "string", "const": "VirtualMachine"},
										"cpu":       map[string]any{"type": "integer", "minimum": 1, "maximum": 64},
										"memoryMiB": map[string]any{"type": "integer", "minimum": 512, "maximum": 262144, "multipleOf": 128},
									},
								},
							},
						},
						"execution": map[string]any{
							"method": "POST",
							"path":   "/agent/workspaces/{workspaceId}/tools/upsert-resource",
						},
						"effect":   "overlayMutation",
						"approval": "notRequired",
					},
				},
			},
		},
		"limits": map[string]any{
			"maxFileBytes":       262144,
			"maxWorkspaceBytes":  5242880,
			"maxReadLines":       200,
			"maxToolOutputBytes": 65536,
			"maxShellRuntimeMs":  5000,
		},
	}
}

func (s *agentContractSampleStore) createWorkspace(request agentContractLaunchRequest) (map[string]any, error) {
	if request.WorkspaceKind != "" && request.WorkspaceKind != agentContractSampleWorkspaceKind {
		return nil, fmt.Errorf("unsupported workspaceKind %q", request.WorkspaceKind)
	}

	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextID++
	id := "sample_wks_" + strconv.Itoa(s.nextID)
	file := agentContractSampleFile{
		Path:      agentContractSampleWorkspaceFilePath,
		Content:   agentContractSampleWorkspaceContent,
		Language:  "json",
		Version:   checksumBytes([]byte(agentContractSampleWorkspaceContent)),
		UpdatedAt: now,
	}
	workspace := &agentContractSampleWorkspace{
		ID:          id,
		Kind:        agentContractSampleWorkspaceKind,
		DisplayName: "Sample VM workspace",
		BaseVersion: "sample-main:" + file.Version,
		Files: map[string]agentContractSampleFile{
			file.Path: file,
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.workspaces[id] = workspace
	return workspaceSnapshot(workspace), nil
}

func (s *agentContractSampleStore) snapshot(workspaceID string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, err := s.workspaceLocked(workspaceID)
	if err != nil {
		return nil, err
	}
	return workspaceSnapshot(workspace), nil
}

func (s *agentContractSampleStore) schema(workspaceID string, schemaID string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.workspaceLocked(workspaceID); err != nil {
		return nil, err
	}
	if schemaID != agentContractSampleSchemaID {
		return nil, fmt.Errorf("schema %q not found", schemaID)
	}
	return map[string]any{
		"schemaId": agentContractSampleSchemaID,
		"path":     agentContractSampleSchemaPath,
		"language": "json",
		"content":  agentContractSampleSchemaContent,
		"checksum": checksumBytes([]byte(agentContractSampleSchemaContent)),
	}, nil
}

func (s *agentContractSampleStore) validate(workspaceID string, overlay agentContractOverlayPayload) (agentContractValidationResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, err := s.workspaceLocked(workspaceID)
	if err != nil {
		return agentContractValidationResponse{}, err
	}
	return s.validateLocked(workspace, overlay)
}

func (s *agentContractSampleStore) preview(workspaceID string, overlay agentContractOverlayPayload, includeValidation bool) (agentContractPreviewResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, err := s.workspaceLocked(workspaceID)
	if err != nil {
		return agentContractPreviewResponse{}, err
	}
	changed, diff, err := s.diffLocked(workspace, overlay)
	if err != nil {
		return agentContractPreviewResponse{}, err
	}
	response := agentContractPreviewResponse{
		Status:       previewStatus(changed),
		WorkspaceID:  workspace.ID,
		BaseVersion:  workspace.BaseVersion,
		ChangedFiles: changed,
		Diff:         diff,
	}
	if includeValidation {
		validation, err := s.validateLocked(workspace, overlay)
		if err != nil {
			return agentContractPreviewResponse{}, err
		}
		response.Validation = &validation
	}
	return response, nil
}

func (s *agentContractSampleStore) save(workspaceID string, overlay agentContractOverlayPayload) (agentContractSaveResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, err := s.workspaceLocked(workspaceID)
	if err != nil {
		return agentContractSaveResponse{}, err
	}
	validation, err := s.validateLocked(workspace, overlay)
	if err != nil {
		return agentContractSaveResponse{}, err
	}
	if validation.Status == "error" {
		return agentContractSaveResponse{}, errors.New("workspace validation failed; fix errors before saving")
	}
	changed, diff, err := s.diffLocked(workspace, overlay)
	if err != nil {
		return agentContractSaveResponse{}, err
	}
	if len(changed) == 0 {
		return agentContractSaveResponse{}, errors.New("no workspace changes to save")
	}

	now := time.Now().UTC()
	overlayFiles := overlayFilesByPath(overlay)
	for _, changedFile := range changed {
		overlayFile := overlayFiles[changedFile.Path]
		workspace.Files[changedFile.Path] = agentContractSampleFile{
			Path:      changedFile.Path,
			Content:   normalizeAgentContractLineEndings(overlayFile.Content),
			Language:  "json",
			Version:   changedFile.Checksum,
			UpdatedAt: now,
		}
	}
	workspace.SaveCount++
	workspace.UpdatedAt = now
	workspace.BaseVersion = "sample-save:" + strconv.Itoa(workspace.SaveCount)

	return agentContractSaveResponse{
		Status:       "saved",
		WorkspaceID:  workspace.ID,
		SavedVersion: workspace.BaseVersion,
		ChangedFiles: changed,
		Diff:         diff,
		Validation:   validation,
		Audit: agentContractAuditMetadata{
			Action:    "save_changes",
			Provider:  s.pluginID,
			CreatedAt: now.Format(time.RFC3339Nano),
		},
	}, nil
}

func (s *agentContractSampleStore) upsertResource(workspaceID string, request agentContractToolRequest) (agentContractToolResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, err := s.workspaceLocked(workspaceID)
	if err != nil {
		return agentContractToolResponse{}, err
	}

	schemaID, _ := request.Args["schemaId"].(string)
	if schemaID != agentContractSampleSchemaID {
		return agentContractToolResponse{}, fmt.Errorf("unsupported schemaId %q", schemaID)
	}
	resourceName, _ := request.Args["resourceName"].(string)
	resourceName = strings.TrimSpace(resourceName)
	if resourceName == "" {
		return agentContractToolResponse{}, errors.New("resourceName is required")
	}
	documentValue, ok := request.Args["document"]
	if !ok {
		return agentContractToolResponse{}, errors.New("document is required")
	}

	current, _, err := s.currentFileLocked(workspace, request.Overlay, agentContractSampleWorkspaceFilePath)
	if err != nil {
		return agentContractToolResponse{}, err
	}
	var vmDoc agentVMDocument
	if err := json.Unmarshal([]byte(current.Content), &vmDoc); err != nil {
		return agentContractToolResponse{}, fmt.Errorf("workspace file is not valid JSON: %w", err)
	}
	if vmDoc.Resources == nil {
		vmDoc.Resources = map[string]agentVMResourceSpec{}
	}
	var spec agentVMResourceSpec
	documentBytes, _ := json.Marshal(documentValue)
	if err := json.Unmarshal(documentBytes, &spec); err != nil {
		return agentContractToolResponse{}, fmt.Errorf("document does not match %s: %w", agentContractSampleSchemaID, err)
	}
	vmDoc.Resources[resourceName] = spec

	nextContent, err := json.MarshalIndent(vmDoc, "", "  ")
	if err != nil {
		return agentContractToolResponse{}, err
	}
	nextContent = append(nextContent, '\n')
	overlayFile := agentContractOverlayFile{
		Path:        agentContractSampleWorkspaceFilePath,
		BaseVersion: current.Version,
		Content:     string(nextContent),
		Checksum:    checksumBytes(nextContent),
	}
	nextOverlay := request.Overlay
	nextOverlay.Files = upsertOverlayFile(nextOverlay.Files, overlayFile)
	validation, err := s.validateLocked(workspace, nextOverlay)
	if err != nil {
		return agentContractToolResponse{}, err
	}
	_, diff, err := s.diffLocked(workspace, nextOverlay)
	if err != nil {
		return agentContractToolResponse{}, err
	}
	return agentContractToolResponse{
		Summary: fmt.Sprintf("Upserted %s %q in %s.", agentContractSampleSchemaID, resourceName, agentContractSampleWorkspaceFilePath),
		Files:   []agentContractOverlayFile{overlayFile},
		Operation: map[string]any{
			"type":         "upsert_resource",
			"schemaId":     schemaID,
			"resourceName": resourceName,
		},
		Validation: validation,
		Diff:       diff,
	}, nil
}

func (s *agentContractSampleStore) workspaceLocked(workspaceID string) (*agentContractSampleWorkspace, error) {
	workspace, ok := s.workspaces[workspaceID]
	if !ok {
		return nil, fmt.Errorf("workspace %q not found", workspaceID)
	}
	return workspace, nil
}

func (s *agentContractSampleStore) validateLocked(workspace *agentContractSampleWorkspace, overlay agentContractOverlayPayload) (agentContractValidationResponse, error) {
	file, _, err := s.currentFileLocked(workspace, overlay, agentContractSampleWorkspaceFilePath)
	if err != nil {
		return agentContractValidationResponse{}, err
	}

	var document agentVMDocument
	findings := []agentContractSampleFinding{}
	if err := json.Unmarshal([]byte(file.Content), &document); err != nil {
		findings = append(findings, agentContractSampleFinding{
			Severity:   "error",
			Message:    fmt.Sprintf("virtual-machines.json is invalid JSON: %s", err),
			SourcePath: file.Path,
			Line:       jsonErrorLine(file.Content, err),
		})
		return validationResponse(workspace, "error", findings, nil), nil
	}
	if len(document.Resources) == 0 {
		findings = append(findings, agentContractSampleFinding{
			Severity:   "error",
			Message:    "resources must contain at least one virtual machine",
			SourcePath: file.Path,
			Line:       2,
		})
	}
	for name, spec := range document.Resources {
		resourcePath := file.Path
		switch {
		case strings.TrimSpace(name) == "":
			findings = append(findings, sampleFinding("error", "resource names must not be empty", resourcePath))
		case spec.Kind != "VirtualMachine":
			findings = append(findings, sampleFinding("error", fmt.Sprintf("%s.kind must be VirtualMachine", name), resourcePath))
		case spec.CPU < 1 || spec.CPU > 64:
			findings = append(findings, sampleFinding("error", fmt.Sprintf("%s.cpu must be between 1 and 64", name), resourcePath))
		case spec.MemoryMiB < 512 || spec.MemoryMiB > 262144:
			findings = append(findings, sampleFinding("error", fmt.Sprintf("%s.memoryMiB must be between 512 and 262144", name), resourcePath))
		case spec.MemoryMiB%128 != 0:
			findings = append(findings, sampleFinding("error", fmt.Sprintf("%s.memoryMiB must be a multiple of 128", name), resourcePath))
		case spec.MemoryMiB > 65536:
			findings = append(findings, sampleFinding("warning", fmt.Sprintf("%s.memoryMiB is unusually high for the sample environment", name), resourcePath))
		}
	}
	status := "valid"
	for _, finding := range findings {
		if finding.Severity == "error" {
			status = "error"
			break
		}
		if finding.Severity == "warning" && status != "error" {
			status = "warning"
		}
	}
	return validationResponse(workspace, status, findings, document.Resources), nil
}

func validationResponse(workspace *agentContractSampleWorkspace, status string, findings []agentContractSampleFinding, details map[string]agentVMResourceSpec) agentContractValidationResponse {
	summary := "Workspace is valid."
	switch status {
	case "warning":
		summary = "Workspace is valid with warnings."
	case "error":
		summary = "Workspace has validation errors."
	}
	return agentContractValidationResponse{
		Status:      status,
		Findings:    findings,
		WorkspaceID: workspace.ID,
		BaseVersion: workspace.BaseVersion,
		CheckedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		Summary:     summary,
		Details:     details,
	}
}

func sampleFinding(severity string, message string, sourcePath string) agentContractSampleFinding {
	return agentContractSampleFinding{
		Severity:   severity,
		Message:    message,
		SourcePath: sourcePath,
	}
}

func (s *agentContractSampleStore) diffLocked(workspace *agentContractSampleWorkspace, overlay agentContractOverlayPayload) ([]agentContractChangedFile, string, error) {
	overlayFiles := overlayFilesByPath(overlay)
	changed := make([]agentContractChangedFile, 0, len(overlayFiles))
	var diffParts []string
	for filePath, overlayFile := range overlayFiles {
		if !strings.HasPrefix(filePath, agentContractSampleWorkspaceRoot+"/") {
			return nil, "", fmt.Errorf("file %s is not writable in the sample workspace", filePath)
		}
		base, ok := workspace.Files[filePath]
		if !ok {
			return nil, "", fmt.Errorf("file %s is not part of the sample workspace", filePath)
		}
		currentContent := normalizeAgentContractLineEndings(overlayFile.Content)
		if currentContent == base.Content {
			continue
		}
		changedFile, fileDiff := changedFileDiff(base, currentContent)
		changed = append(changed, changedFile)
		diffParts = append(diffParts, fileDiff)
	}
	sort.Slice(changed, func(i, j int) bool { return changed[i].Path < changed[j].Path })
	return changed, strings.Join(diffParts, "\n"), nil
}

func (s *agentContractSampleStore) currentFileLocked(workspace *agentContractSampleWorkspace, overlay agentContractOverlayPayload, filePath string) (agentContractSampleFile, bool, error) {
	if overlayFile, ok := overlayFilesByPath(overlay)[filePath]; ok {
		base, exists := workspace.Files[filePath]
		if !exists {
			return agentContractSampleFile{}, false, fmt.Errorf("file %s is not part of the sample workspace", filePath)
		}
		return agentContractSampleFile{
			Path:      overlayFile.Path,
			Content:   normalizeAgentContractLineEndings(overlayFile.Content),
			Language:  base.Language,
			Version:   checksumBytes([]byte(normalizeAgentContractLineEndings(overlayFile.Content))),
			ReadOnly:  base.ReadOnly,
			UpdatedAt: time.Now().UTC(),
		}, true, nil
	}
	file, ok := workspace.Files[filePath]
	if !ok {
		return agentContractSampleFile{}, false, fmt.Errorf("file %s is not part of the sample workspace", filePath)
	}
	return file, false, nil
}

func workspaceSnapshot(workspace *agentContractSampleWorkspace) map[string]any {
	files := make([]map[string]any, 0, len(workspace.Files))
	paths := make([]string, 0, len(workspace.Files))
	for filePath := range workspace.Files {
		paths = append(paths, filePath)
	}
	sort.Strings(paths)
	for _, filePath := range paths {
		file := workspace.Files[filePath]
		files = append(files, sampleFileSnapshot(file))
	}
	return map[string]any{
		"workspaceId":   workspace.ID,
		"workspaceKind": workspace.Kind,
		"displayName":   workspace.DisplayName,
		"baseVersion":   workspace.BaseVersion,
		"rootPath":      agentContractSampleWorkspaceRoot,
		"files":         files,
		"contextFiles": []map[string]any{
			{
				"path":     agentContractSampleContextPath,
				"content":  agentContractSampleContextContent,
				"language": "json",
				"readOnly": true,
				"checksum": checksumBytes([]byte(agentContractSampleContextContent)),
			},
		},
		"schemas": []map[string]any{
			{
				"schemaId":  agentContractSampleSchemaID,
				"path":      agentContractSampleSchemaPath,
				"rootTypes": []string{"virtual_machine"},
			},
		},
		"workspaceSchemaVersion": "sample.vm.v1",
	}
}

func sampleFileSnapshot(file agentContractSampleFile) map[string]any {
	return map[string]any{
		"path":      file.Path,
		"content":   file.Content,
		"language":  file.Language,
		"version":   file.Version,
		"checksum":  checksumBytes([]byte(file.Content)),
		"readOnly":  file.ReadOnly,
		"updatedAt": file.UpdatedAt.Format(time.RFC3339Nano),
	}
}

func overlayFilesByPath(overlay agentContractOverlayPayload) map[string]agentContractOverlayFile {
	files := map[string]agentContractOverlayFile{}
	for _, file := range overlay.Files {
		if strings.TrimSpace(file.Path) == "" {
			continue
		}
		file.Path = normalizeAgentContractPath(file.Path)
		file.Content = normalizeAgentContractLineEndings(file.Content)
		if file.Checksum == "" {
			file.Checksum = checksumBytes([]byte(file.Content))
		}
		files[file.Path] = file
	}
	return files
}

func upsertOverlayFile(files []agentContractOverlayFile, next agentContractOverlayFile) []agentContractOverlayFile {
	out := append([]agentContractOverlayFile{}, files...)
	for index := range out {
		if normalizeAgentContractPath(out[index].Path) == normalizeAgentContractPath(next.Path) {
			out[index] = next
			return out
		}
	}
	return append(out, next)
}

func changedFileDiff(base agentContractSampleFile, currentContent string) (agentContractChangedFile, string) {
	oldLines := splitAgentContractLines(base.Content)
	newLines := splitAgentContractLines(currentContent)
	firstChanged := firstChangedLine(oldLines, newLines)
	removed, added := changedLineCounts(oldLines, newLines)
	diff := renderSampleUnifiedDiff(base.Path, oldLines, newLines)
	return agentContractChangedFile{
		Path:          base.Path,
		BaseVersion:   base.Version,
		Checksum:      checksumBytes([]byte(currentContent)),
		AddedLines:    added,
		RemovedLines:  removed,
		FirstChanged:  firstChanged,
		PreviousBytes: len([]byte(base.Content)),
		CurrentBytes:  len([]byte(currentContent)),
	}, diff
}

func renderSampleUnifiedDiff(filePath string, oldLines []string, newLines []string) string {
	var builder strings.Builder
	builder.WriteString("--- ")
	builder.WriteString(filePath)
	builder.WriteString("\n+++ ")
	builder.WriteString(filePath)
	builder.WriteString("\n@@ sample diff @@\n")
	for _, line := range oldLines {
		builder.WriteString("-")
		builder.WriteString(line)
		builder.WriteString("\n")
	}
	for _, line := range newLines {
		builder.WriteString("+")
		builder.WriteString(line)
		builder.WriteString("\n")
	}
	return builder.String()
}

func firstChangedLine(oldLines []string, newLines []string) int {
	limit := min(len(oldLines), len(newLines))
	for index := 0; index < limit; index++ {
		if oldLines[index] != newLines[index] {
			return index + 1
		}
	}
	if len(oldLines) != len(newLines) {
		return limit + 1
	}
	return 0
}

func changedLineCounts(oldLines []string, newLines []string) (int, int) {
	commonPrefix := 0
	for commonPrefix < len(oldLines) && commonPrefix < len(newLines) && oldLines[commonPrefix] == newLines[commonPrefix] {
		commonPrefix++
	}
	commonSuffix := 0
	for commonSuffix < len(oldLines)-commonPrefix &&
		commonSuffix < len(newLines)-commonPrefix &&
		oldLines[len(oldLines)-1-commonSuffix] == newLines[len(newLines)-1-commonSuffix] {
		commonSuffix++
	}
	return len(oldLines) - commonPrefix - commonSuffix, len(newLines) - commonPrefix - commonSuffix
}

func splitAgentContractLines(content string) []string {
	normalized := normalizeAgentContractLineEndings(content)
	trimmed := strings.TrimSuffix(normalized, "\n")
	if trimmed == "" {
		return []string{}
	}
	return strings.Split(trimmed, "\n")
}

func normalizeAgentContractLineEndings(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
}

func normalizeAgentContractPath(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	for strings.Contains(value, "//") {
		value = strings.ReplaceAll(value, "//", "/")
	}
	if value != "/" {
		value = strings.TrimRight(value, "/")
	}
	return value
}

func previewStatus(changed []agentContractChangedFile) string {
	if len(changed) == 0 {
		return "unchanged"
	}
	return "changed"
}

func jsonErrorLine(content string, err error) int {
	var syntaxErr *json.SyntaxError
	if errors.As(err, &syntaxErr) {
		offset := int(syntaxErr.Offset)
		if offset <= 0 || offset > len(content) {
			return 0
		}
		return strings.Count(content[:offset], "\n") + 1
	}
	return 0
}
