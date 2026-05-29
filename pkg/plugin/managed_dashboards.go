package plugin

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const (
	pluginID = "g42-pi-app"

	annotationFolder         = "grafana.app/folder"
	annotationManagedBy      = "grafana.app/managedBy"
	annotationManagerID      = "grafana.app/managerId"
	annotationSourcePath     = "grafana.app/sourcePath"
	annotationSourceChecksum = "grafana.app/sourceChecksum"
	annotationSourceTS       = "grafana.app/sourceTimestamp"
	annotationJsonnetSource  = "g42.piapp/jsonnetSource"

	maxManagedDashboardJsonnetSourceBytes = 200 * 1024
)

type managedDashboardRequest struct {
	DashboardJsonnet string   `json:"dashboard_jsonnet"`
	SessionID        string   `json:"sessionId,omitempty"`
	Path             string   `json:"path,omitempty"`
	UID              string   `json:"uid,omitempty"`
	FolderUID        string   `json:"folderUid,omitempty"`
	Tags             []string `json:"tags,omitempty"`
	Overwrite        *bool    `json:"overwrite,omitempty"`
	SourcePath       string   `json:"-"`
}

type managedDashboardSourceRequest struct {
	UID string `json:"uid"`
}

type managedDashboardSourceResponse struct {
	UID                  string            `json:"uid"`
	Title                string            `json:"title"`
	URL                  string            `json:"url"`
	FolderUID            string            `json:"folderUid,omitempty"`
	SourceChecksum       string            `json:"sourceChecksum,omitempty"`
	DashboardJsonnet     string            `json:"dashboard_jsonnet"`
	DashboardJsonnetSize int               `json:"dashboardJsonnetSize"`
	Annotations          map[string]string `json:"annotations"`
}

type managedDashboardRenderResponse struct {
	Dashboard        map[string]any          `json:"dashboard"`
	Resource         dashboardResource       `json:"resource"`
	SourceChecksum   string                  `json:"sourceChecksum"`
	AutoRepaired     bool                    `json:"autoRepaired,omitempty"`
	Repairs          []string                `json:"repairs,omitempty"`
	JsonnetFile      *managedJsonnetFileInfo `json:"jsonnetFile,omitempty"`
	DashboardJsonnet string                  `json:"dashboard_jsonnet,omitempty"`
	Request          managedDashboardRequest `json:"-"`
}

type managedDashboardSyncResponse struct {
	UID              string                  `json:"uid"`
	URL              string                  `json:"url"`
	Status           string                  `json:"status"`
	Dashboard        map[string]any          `json:"dashboard"`
	Resource         map[string]any          `json:"resource"`
	SourceChecksum   string                  `json:"sourceChecksum"`
	AutoRepaired     bool                    `json:"autoRepaired,omitempty"`
	Repairs          []string                `json:"repairs,omitempty"`
	JsonnetFile      *managedJsonnetFileInfo `json:"jsonnetFile,omitempty"`
	DashboardJsonnet string                  `json:"dashboard_jsonnet,omitempty"`
}

type managedDashboardListResponse struct {
	Dashboards []managedDashboardListItem `json:"dashboards"`
}

type managedDashboardListItem struct {
	UID                  string            `json:"uid"`
	Title                string            `json:"title"`
	URL                  string            `json:"url"`
	FolderUID            string            `json:"folderUid,omitempty"`
	SourcePath           string            `json:"sourcePath,omitempty"`
	SourceChecksum       string            `json:"sourceChecksum,omitempty"`
	HasJsonnetSource     bool              `json:"hasJsonnetSource"`
	DashboardJsonnetSize int               `json:"dashboardJsonnetSize,omitempty"`
	Annotations          map[string]string `json:"annotations"`
}

type managedJsonnetFileInfo struct {
	Path                 string `json:"path"`
	Version              int    `json:"version"`
	Checksum             string `json:"checksum"`
	LineCount            int    `json:"lineCount"`
	DashboardJsonnetSize int    `json:"dashboardJsonnetSize"`
}

type dashboardResourceList struct {
	Items []dashboardResource `json:"items"`
}

type dashboardResource struct {
	Kind       string                    `json:"kind"`
	APIVersion string                    `json:"apiVersion"`
	Metadata   dashboardResourceMetadata `json:"metadata"`
	Spec       map[string]any            `json:"spec"`
}

type dashboardResourceMetadata struct {
	Name        string            `json:"name"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

var (
	dashboardUIDPattern = regexp.MustCompile(`[^a-z0-9-]+`)
)

func (a *App) handleManagedDashboardList(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	responseBody, err := a.grafanaAPI(req, http.MethodGet, "/apis/dashboard.grafana.app/v1/namespaces/default/dashboards?limit=1000", nil)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}

	var list dashboardResourceList
	if err := json.Unmarshal(responseBody, &list); err != nil {
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("invalid Grafana API response: %s", err))
		return
	}

	items := make([]managedDashboardListItem, 0)
	for _, resource := range list.Items {
		annotations := resource.Metadata.Annotations
		if annotations[annotationManagedBy] != "plugin" || annotations[annotationManagerID] != pluginID {
			continue
		}
		source := annotations[annotationJsonnetSource]

		items = append(items, managedDashboardListItem{
			UID:                  resource.Metadata.Name,
			Title:                fmt.Sprint(resource.Spec["title"]),
			URL:                  a.dashboardURL(req, resource.Metadata.Name),
			FolderUID:            annotations[annotationFolder],
			SourcePath:           annotations[annotationSourcePath],
			SourceChecksum:       annotations[annotationSourceChecksum],
			HasJsonnetSource:     source != "",
			DashboardJsonnetSize: len([]byte(source)),
			Annotations:          publicDashboardAnnotations(annotations),
		})
	}

	writeJSON(w, http.StatusOK, managedDashboardListResponse{Dashboards: items})
}

func (a *App) handleManagedDashboardSource(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body managedDashboardSourceRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	uid := strings.TrimSpace(body.UID)
	if uid == "" {
		writeJSONError(w, http.StatusBadRequest, "uid is required")
		return
	}

	resource, err := a.getDashboardResource(req, uid)
	if err != nil {
		var grafanaErr grafanaAPIError
		if errors.As(err, &grafanaErr) && grafanaErr.status == http.StatusNotFound {
			writeJSONError(w, http.StatusNotFound, "managed dashboard not found")
			return
		}
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	annotations := resource.Metadata.Annotations
	if annotations[annotationManagedBy] != "plugin" || annotations[annotationManagerID] != pluginID {
		writeJSONError(w, http.StatusNotFound, "dashboard is not managed by this app")
		return
	}
	source := annotations[annotationJsonnetSource]
	if source == "" {
		writeJSONError(w, http.StatusNotFound, "managed dashboard does not have stored Jsonnet source")
		return
	}

	writeJSON(w, http.StatusOK, managedDashboardSourceResponse{
		UID:                  resource.Metadata.Name,
		Title:                fmt.Sprint(resource.Spec["title"]),
		URL:                  a.dashboardURL(req, resource.Metadata.Name),
		FolderUID:            annotations[annotationFolder],
		SourceChecksum:       annotations[annotationSourceChecksum],
		DashboardJsonnet:     source,
		DashboardJsonnetSize: len([]byte(source)),
		Annotations:          publicDashboardAnnotations(annotations),
	})
}

func (a *App) handleManagedDashboardRender(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	rendered, err := a.renderManagedDashboardRequest(req.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, rendered)
}

func (a *App) handleManagedDashboardSync(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	rendered, err := a.renderManagedDashboardRequest(req.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	exists, err := a.dashboardResourceExists(req, rendered.Resource.Metadata.Name)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	if exists && !requestAllowsOverwrite(rendered) {
		writeJSONError(w, http.StatusConflict, "dashboard already exists and overwrite is false")
		return
	}

	method := http.MethodPost
	resourcePath := "/apis/dashboard.grafana.app/v1/namespaces/default/dashboards"
	if exists {
		method = http.MethodPut
		resourcePath += "/" + url.PathEscape(rendered.Resource.Metadata.Name)
	}

	payload, err := json.Marshal(rendered.Resource)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	responseBody, err := a.grafanaAPI(req, method, resourcePath, payload)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}

	var resource map[string]any
	if err := json.Unmarshal(responseBody, &resource); err != nil {
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("invalid Grafana API response: %s", err))
		return
	}

	writeJSON(w, http.StatusOK, managedDashboardSyncResponse{
		UID:              rendered.Resource.Metadata.Name,
		URL:              a.dashboardURL(req, rendered.Resource.Metadata.Name),
		Status:           map[bool]string{true: "updated", false: "created"}[exists],
		Dashboard:        rendered.Dashboard,
		Resource:         resource,
		SourceChecksum:   rendered.SourceChecksum,
		AutoRepaired:     rendered.AutoRepaired,
		Repairs:          rendered.Repairs,
		JsonnetFile:      rendered.JsonnetFile,
		DashboardJsonnet: rendered.DashboardJsonnet,
	})
}

func (a *App) renderManagedDashboardRequest(body io.Reader) (*managedDashboardRenderResponse, error) {
	var request managedDashboardRequest
	if err := json.NewDecoder(body).Decode(&request); err != nil {
		return nil, fmt.Errorf("invalid request body: %w", err)
	}
	request = normalizeManagedDashboardRequest(request)

	sourceFromVirtualFile := false
	var jsonnetFile *managedJsonnetFileInfo
	if strings.TrimSpace(request.DashboardJsonnet) == "" {
		file, err := a.jsonnetFiles.get(jsonnetFileReference{SessionID: request.SessionID, Path: request.Path})
		if err != nil {
			return nil, fmt.Errorf("dashboard_jsonnet is required unless a virtual Jsonnet file is available: %w", err)
		}
		request.DashboardJsonnet = file.Content
		request.Path = file.Path
		request.SourcePath = file.Path
		sourceFromVirtualFile = true
		jsonnetFile = managedJsonnetFileInfoFromVirtualFile(file)
	}
	if len([]byte(request.DashboardJsonnet)) > maxManagedDashboardJsonnetSourceBytes {
		return nil, fmt.Errorf("dashboard_jsonnet is too large: %d bytes exceeds %d bytes", len([]byte(request.DashboardJsonnet)), maxManagedDashboardJsonnetSourceBytes)
	}

	rendered, err := renderJsonnetSource(request.DashboardJsonnet)
	if err != nil {
		if sourceFromVirtualFile {
			repairResponse, repairErr := a.jsonnetFiles.repair(jsonnetFileRepairRequest{
				SessionID: request.SessionID,
				Path:      request.Path,
			})
			if repairErr != nil {
				return nil, jsonnetCompilationError(request.DashboardJsonnet, err, repairErr)
			}

			request.DashboardJsonnet = repairResponse.DashboardJsonnet
			request.Path = repairResponse.Path
			request.SourcePath = repairResponse.Path
			jsonnetFile = managedJsonnetFileInfoFromFileResponse(repairResponse)
			rendered, err = renderJsonnetSource(request.DashboardJsonnet)
			if err != nil {
				return nil, jsonnetCompilationError(request.DashboardJsonnet, err, nil)
			}
			return a.managedDashboardRenderResponse(request, rendered, true, repairResponse.Repairs, jsonnetFile)
		}
		return nil, jsonnetCompilationError(request.DashboardJsonnet, err, nil)
	}

	return a.managedDashboardRenderResponse(request, rendered, false, nil, jsonnetFile)
}

func (a *App) managedDashboardRenderResponse(request managedDashboardRequest, rendered []byte, autoRepaired bool, repairs []string, jsonnetFile *managedJsonnetFileInfo) (*managedDashboardRenderResponse, error) {
	var dashboard map[string]any
	if err := json.Unmarshal(rendered, &dashboard); err != nil {
		return nil, fmt.Errorf("compiled Jsonnet is not valid dashboard JSON: %w", err)
	}
	if dashboard["title"] == nil || strings.TrimSpace(fmt.Sprint(dashboard["title"])) == "" {
		return nil, errors.New("compiled dashboard must include a title")
	}
	if request.UID == "" {
		if uid, ok := dashboard["uid"].(string); ok {
			request.UID = uid
		}
	}
	request.UID = normalizeManagedDashboardUID(request.UID, fmt.Sprint(dashboard["title"]))
	dashboard["uid"] = request.UID
	dashboard["editable"] = false
	requiredTags := append(append([]string{}, request.Tags...), "genai", "managed-by-observability-analyst")
	dashboard["tags"] = ensureStringTags(dashboard["tags"], requiredTags...)
	delete(dashboard, "id")

	disallowed := a.disallowedDatasourceUIDs(dashboard)
	if len(disallowed) > 0 {
		return nil, fmt.Errorf("dashboard references datasource UIDs not available to the app: %s", strings.Join(disallowed, ", "))
	}

	sourceChecksum := checksumBytes([]byte(request.DashboardJsonnet))

	resource := dashboardResource{
		Kind:       "Dashboard",
		APIVersion: "dashboard.grafana.app/v1",
		Metadata: dashboardResourceMetadata{
			Name:        request.UID,
			Annotations: managedDashboardAnnotations(request, sourceChecksum),
		},
		Spec: dashboard,
	}

	response := &managedDashboardRenderResponse{
		Dashboard:      dashboard,
		Resource:       resource,
		SourceChecksum: sourceChecksum,
		AutoRepaired:   autoRepaired,
		Repairs:        repairs,
		JsonnetFile:    jsonnetFile,
		Request:        request,
	}
	if autoRepaired {
		response.DashboardJsonnet = request.DashboardJsonnet
	}
	return response, nil
}

func jsonnetCompilationError(source string, compileErr error, repairErr error) error {
	message := fmt.Sprintf("jsonnet compilation failed: %s", compileErr)
	if repairErr != nil {
		message += fmt.Sprintf("\nauto-repair failed: %s", repairErr)
	}
	if sourceWindow := sourceWindowForJsonnetError(source, compileErr); sourceWindow != "" {
		message += "\n" + sourceWindow
	}
	return errors.New(message)
}

func managedJsonnetFileInfoFromVirtualFile(file virtualJsonnetFile) *managedJsonnetFileInfo {
	lines, _ := splitJsonnetLines(file.Content)
	return &managedJsonnetFileInfo{
		Path:                 file.Path,
		Version:              file.Version,
		Checksum:             checksumBytes([]byte(file.Content)),
		LineCount:            len(lines),
		DashboardJsonnetSize: len([]byte(file.Content)),
	}
}

func managedJsonnetFileInfoFromFileResponse(response jsonnetFileResponse) *managedJsonnetFileInfo {
	return &managedJsonnetFileInfo{
		Path:                 response.Path,
		Version:              response.Version,
		Checksum:             response.Checksum,
		LineCount:            response.LineCount,
		DashboardJsonnetSize: response.DashboardJsonnetSize,
	}
}

func normalizeManagedDashboardRequest(request managedDashboardRequest) managedDashboardRequest {
	request.FolderUID = strings.TrimSpace(request.FolderUID)
	request.UID = strings.TrimSpace(request.UID)
	request.Path = strings.TrimSpace(request.Path)
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.Tags = normalizeTags(request.Tags)
	return request
}

func normalizeManagedDashboardUID(uid string, title string) string {
	raw := strings.TrimSpace(uid)
	if raw == "" {
		raw = "observability-" + strings.ToLower(title)
	}
	raw = strings.ToLower(raw)
	raw = dashboardUIDPattern.ReplaceAllString(raw, "-")
	raw = strings.Trim(raw, "-")
	raw = strings.Join(strings.FieldsFunc(raw, func(r rune) bool { return r == '-' }), "-")
	if raw == "" {
		raw = "observability-dashboard"
	}
	if len(raw) > 40 {
		raw = strings.TrimRight(raw[:40], "-")
	}
	return raw
}

func normalizeTags(tags []string) []string {
	result := make([]string, 0, len(tags))
	seen := map[string]bool{}
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true
		result = append(result, tag)
	}
	return result
}

func managedDashboardAnnotations(request managedDashboardRequest, sourceChecksum string) map[string]string {
	sourcePath := request.SourcePath
	if sourcePath == "" {
		sourcePath = "inline-jsonnet"
	}
	annotations := map[string]string{
		annotationManagedBy:      "plugin",
		annotationManagerID:      pluginID,
		annotationSourcePath:     sourcePath,
		annotationSourceChecksum: sourceChecksum,
		annotationSourceTS:       fmt.Sprintf("%d", time.Now().UnixMilli()),
		annotationJsonnetSource:  request.DashboardJsonnet,
	}
	if request.FolderUID != "" {
		annotations[annotationFolder] = request.FolderUID
	}
	return annotations
}

func requestAllowsOverwrite(rendered *managedDashboardRenderResponse) bool {
	return rendered.Request.Overwrite == nil || *rendered.Request.Overwrite
}

func (a *App) disallowedDatasourceUIDs(dashboard any) []string {
	allowed := a.allowedDatasourceSet()
	if len(allowed) == 0 {
		return nil
	}
	found := collectDatasourceUIDs(dashboard, map[string]bool{})
	disallowed := make([]string, 0)
	for uid := range found {
		if !allowed[uid] {
			disallowed = append(disallowed, uid)
		}
	}
	sort.Strings(disallowed)
	return disallowed
}

func (a *App) allowedDatasourceSet() map[string]bool {
	result := map[string]bool{}
	for _, uid := range a.settings.AllowedDatasourceUIDs {
		uid = strings.TrimSpace(uid)
		if uid != "" {
			result[uid] = true
		}
	}
	return result
}

func collectDatasourceUIDs(value any, result map[string]bool) map[string]bool {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			collectDatasourceUIDs(item, result)
		}
	case map[string]any:
		if datasource, ok := typed["datasource"]; ok {
			addDatasourceUID(datasource, result)
		}
		for _, item := range typed {
			collectDatasourceUIDs(item, result)
		}
	}
	return result
}

func addDatasourceUID(value any, result map[string]bool) {
	var uid string
	switch typed := value.(type) {
	case string:
		uid = typed
	case map[string]any:
		if raw, ok := typed["uid"].(string); ok {
			uid = raw
		}
	}
	uid = strings.TrimSpace(uid)
	if uid == "" || isBuiltinDatasourceUID(uid) {
		return
	}
	result[uid] = true
}

func isBuiltinDatasourceUID(uid string) bool {
	switch uid {
	case "__expr__", "-- Mixed --", "-- Dashboard --", "mixed", "grafana", "dashboard", "-100":
		return true
	default:
		return false
	}
}

func publicDashboardAnnotations(annotations map[string]string) map[string]string {
	result := map[string]string{}
	for key, value := range annotations {
		if key == annotationJsonnetSource {
			continue
		}
		result[key] = value
	}
	return result
}

func ensureStringTags(raw any, required ...string) []string {
	result := []string{}
	seen := map[string]bool{}
	if tags, ok := raw.([]any); ok {
		for _, tag := range tags {
			value, ok := tag.(string)
			if ok && value != "" && !seen[value] {
				seen[value] = true
				result = append(result, value)
			}
		}
	}
	for _, value := range required {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func checksumBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (a *App) getDashboardResource(req *http.Request, uid string) (dashboardResource, error) {
	responseBody, err := a.grafanaAPI(req, http.MethodGet, "/apis/dashboard.grafana.app/v1/namespaces/default/dashboards/"+url.PathEscape(uid), nil)
	if err != nil {
		return dashboardResource{}, err
	}
	var resource dashboardResource
	if err := json.Unmarshal(responseBody, &resource); err != nil {
		return dashboardResource{}, fmt.Errorf("invalid Grafana API response: %w", err)
	}
	return resource, nil
}

func (a *App) dashboardResourceExists(req *http.Request, uid string) (bool, error) {
	_, err := a.getDashboardResource(req, uid)
	if err == nil {
		return true, nil
	}
	var grafanaErr grafanaAPIError
	if errors.As(err, &grafanaErr) && grafanaErr.status == http.StatusNotFound {
		return false, nil
	}
	return false, err
}

type grafanaAPIError struct {
	status int
	body   string
}

func (e grafanaAPIError) Error() string {
	return fmt.Sprintf("Grafana API error (%d): %s", e.status, e.body)
}

func (a *App) grafanaAPI(req *http.Request, method string, apiPath string, body []byte) ([]byte, error) {
	cfg := backend.GrafanaConfigFromContext(req.Context())
	appURL, err := cfg.AppURL()
	if err != nil {
		return nil, err
	}
	token, err := cfg.PluginAppClientSecret()
	if err != nil {
		return nil, err
	}

	apiURL, err := joinGrafanaURL(appURL, apiPath)
	if err != nil {
		return nil, err
	}
	apiReq, err := http.NewRequestWithContext(req.Context(), method, apiURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	apiReq.Header.Set("Authorization", "Bearer "+token)
	apiReq.Header.Set("Accept", "application/json")
	if body != nil {
		apiReq.Header.Set("Content-Type", "application/json")
	}

	res, err := a.httpClient.Do(apiReq)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	responseBody, _ := io.ReadAll(io.LimitReader(res.Body, 2_000_000))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, grafanaAPIError{status: res.StatusCode, body: string(responseBody)}
	}
	return responseBody, nil
}

func joinGrafanaURL(appURL string, apiPath string) (string, error) {
	base, err := url.Parse(strings.TrimRight(appURL, "/") + "/")
	if err != nil {
		return "", err
	}
	relative, err := url.Parse(strings.TrimLeft(apiPath, "/"))
	if err != nil {
		return "", err
	}
	return base.ResolveReference(relative).String(), nil
}

func (a *App) dashboardURL(req *http.Request, uid string) string {
	cfg := backend.GrafanaConfigFromContext(req.Context())
	appURL, err := cfg.AppURL()
	if err != nil {
		return "/d/" + url.PathEscape(uid)
	}
	joined, err := url.JoinPath(strings.TrimRight(appURL, "/"), "d", uid)
	if err != nil {
		return "/d/" + url.PathEscape(uid)
	}
	return joined
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
