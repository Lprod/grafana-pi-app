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

	"github.com/grafana/grafana-plugin-sdk-go/config"
)

var pluginID = "g42-pi-app"

// ID returns the plugin ID compiled into the backend binary.
func ID() string {
	return pluginID
}

const (
	maxJsonnetDashboardSourceBytes = 200 * 1024
)

type jsonnetDashboardRequest struct {
	DashboardJsonnet string   `json:"dashboard_jsonnet"`
	SessionID        string   `json:"sessionId,omitempty"`
	Path             string   `json:"path,omitempty"`
	UID              string   `json:"uid,omitempty"`
	FolderUID        string   `json:"folderUid,omitempty"`
	Tags             []string `json:"tags,omitempty"`
	Overwrite        *bool    `json:"overwrite,omitempty"`
	SourcePath       string   `json:"-"`
}

type jsonnetDashboardRenderResponse struct {
	Dashboard        map[string]any             `json:"dashboard"`
	SourceChecksum   string                     `json:"sourceChecksum"`
	Validation       *dashboardValidationReport `json:"validation,omitempty"`
	AutoRepaired     bool                       `json:"autoRepaired,omitempty"`
	Repairs          []string                   `json:"repairs,omitempty"`
	JsonnetFile      *jsonnetDashboardFileInfo  `json:"jsonnetFile,omitempty"`
	DashboardJsonnet string                     `json:"dashboard_jsonnet,omitempty"`
	Request          jsonnetDashboardRequest    `json:"-"`
}

type jsonnetDashboardSaveResponse struct {
	UID              string                     `json:"uid"`
	URL              string                     `json:"url"`
	Status           string                     `json:"status"`
	Dashboard        map[string]any             `json:"dashboard"`
	SaveResponse     map[string]any             `json:"saveResponse,omitempty"`
	SourceChecksum   string                     `json:"sourceChecksum"`
	Validation       *dashboardValidationReport `json:"validation,omitempty"`
	AutoRepaired     bool                       `json:"autoRepaired,omitempty"`
	Repairs          []string                   `json:"repairs,omitempty"`
	JsonnetFile      *jsonnetDashboardFileInfo  `json:"jsonnetFile,omitempty"`
	DashboardJsonnet string                     `json:"dashboard_jsonnet,omitempty"`
}

type jsonnetDashboardFileInfo struct {
	Path                 string `json:"path"`
	Version              int    `json:"version"`
	Checksum             string `json:"checksum"`
	LineCount            int    `json:"lineCount"`
	DashboardJsonnetSize int    `json:"dashboardJsonnetSize"`
}

var (
	dashboardUIDPattern = regexp.MustCompile(`[^a-z0-9-]+`)
)

func (a *App) handleJsonnetDashboardRender(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	rendered, err := a.renderJsonnetDashboardRequest(req.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, rendered)
}

func (a *App) handleJsonnetDashboardSave(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	rendered, err := a.renderJsonnetDashboardRequest(req.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	overwrite := true
	if rendered.Request.Overwrite != nil {
		overwrite = *rendered.Request.Overwrite
	}
	payload, err := json.Marshal(map[string]any{
		"dashboard": rendered.Dashboard,
		"folderUid": rendered.Request.FolderUID,
		"overwrite": overwrite,
	})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	responseBody, err := a.grafanaAPI(req, http.MethodPost, "/api/dashboards/db", payload)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}

	var saveResponse map[string]any
	if err := json.Unmarshal(responseBody, &saveResponse); err != nil {
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("invalid Grafana API response: %s", err))
		return
	}
	uid := strings.TrimSpace(stringMapField(saveResponse, "uid"))
	if uid == "" {
		uid = fmt.Sprint(rendered.Dashboard["uid"])
	}
	status := strings.TrimSpace(stringMapField(saveResponse, "status"))
	if status == "" {
		status = "saved"
	}

	writeJSON(w, http.StatusOK, jsonnetDashboardSaveResponse{
		UID:              uid,
		URL:              a.dashboardSaveURL(req, uid, stringMapField(saveResponse, "url")),
		Status:           status,
		Dashboard:        rendered.Dashboard,
		SaveResponse:     saveResponse,
		SourceChecksum:   rendered.SourceChecksum,
		Validation:       rendered.Validation,
		AutoRepaired:     rendered.AutoRepaired,
		Repairs:          rendered.Repairs,
		JsonnetFile:      rendered.JsonnetFile,
		DashboardJsonnet: rendered.DashboardJsonnet,
	})
}

func (a *App) renderJsonnetDashboardRequest(body io.Reader) (*jsonnetDashboardRenderResponse, error) {
	var request jsonnetDashboardRequest
	if err := json.NewDecoder(body).Decode(&request); err != nil {
		return nil, fmt.Errorf("invalid request body: %w", err)
	}
	request = normalizeJsonnetDashboardRequest(request)

	sourceFromVirtualFile := false
	var jsonnetFile *jsonnetDashboardFileInfo
	if strings.TrimSpace(request.DashboardJsonnet) == "" {
		file, err := a.jsonnetFiles.get(jsonnetFileReference{SessionID: request.SessionID, Path: request.Path})
		if err != nil {
			return nil, fmt.Errorf("dashboard_jsonnet is required unless a virtual Jsonnet file is available: %w", err)
		}
		request.DashboardJsonnet = file.Content
		request.Path = file.Path
		request.SourcePath = file.Path
		sourceFromVirtualFile = true
		jsonnetFile = jsonnetDashboardFileInfoFromVirtualFile(file)
	}
	if len([]byte(request.DashboardJsonnet)) > maxJsonnetDashboardSourceBytes {
		return nil, fmt.Errorf("dashboard_jsonnet is too large: %d bytes exceeds %d bytes", len([]byte(request.DashboardJsonnet)), maxJsonnetDashboardSourceBytes)
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
			jsonnetFile = jsonnetDashboardFileInfoFromFileResponse(repairResponse)
			rendered, err = renderJsonnetSource(request.DashboardJsonnet)
			if err != nil {
				return nil, jsonnetCompilationError(request.DashboardJsonnet, err, nil)
			}
			return a.buildJsonnetDashboardRenderResponse(request, rendered, true, repairResponse.Repairs, jsonnetFile)
		}
		return nil, jsonnetCompilationError(request.DashboardJsonnet, err, nil)
	}

	return a.buildJsonnetDashboardRenderResponse(request, rendered, false, nil, jsonnetFile)
}

func (a *App) buildJsonnetDashboardRenderResponse(request jsonnetDashboardRequest, rendered []byte, autoRepaired bool, repairs []string, jsonnetFile *jsonnetDashboardFileInfo) (*jsonnetDashboardRenderResponse, error) {
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
	request.UID = normalizeJsonnetDashboardUID(request.UID, fmt.Sprint(dashboard["title"]))
	dashboard["uid"] = request.UID
	dashboard["editable"] = true
	requiredTags := append(append([]string{}, request.Tags...), "genai")
	dashboard["tags"] = ensureStringTags(dashboard["tags"], requiredTags...)
	delete(dashboard, "id")
	validation := validateAndNormalizeDashboard(dashboard)

	disallowed := a.disallowedDatasourceUIDs(dashboard)
	if len(disallowed) > 0 {
		return nil, fmt.Errorf("dashboard references datasource UIDs not available to the app: %s", strings.Join(disallowed, ", "))
	}

	sourceChecksum := checksumBytes([]byte(request.DashboardJsonnet))

	response := &jsonnetDashboardRenderResponse{
		Dashboard:      dashboard,
		SourceChecksum: sourceChecksum,
		Validation:     validation,
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

func jsonnetDashboardFileInfoFromVirtualFile(file virtualJsonnetFile) *jsonnetDashboardFileInfo {
	lines, _ := splitJsonnetLines(file.Content)
	return &jsonnetDashboardFileInfo{
		Path:                 file.Path,
		Version:              file.Version,
		Checksum:             checksumBytes([]byte(file.Content)),
		LineCount:            len(lines),
		DashboardJsonnetSize: len([]byte(file.Content)),
	}
}

func jsonnetDashboardFileInfoFromFileResponse(response jsonnetFileResponse) *jsonnetDashboardFileInfo {
	return &jsonnetDashboardFileInfo{
		Path:                 response.Path,
		Version:              response.Version,
		Checksum:             response.Checksum,
		LineCount:            response.LineCount,
		DashboardJsonnetSize: response.DashboardJsonnetSize,
	}
}

func normalizeJsonnetDashboardRequest(request jsonnetDashboardRequest) jsonnetDashboardRequest {
	request.FolderUID = strings.TrimSpace(request.FolderUID)
	request.UID = strings.TrimSpace(request.UID)
	request.Path = strings.TrimSpace(request.Path)
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.Tags = normalizeTags(request.Tags)
	return request
}

func normalizeJsonnetDashboardUID(uid string, title string) string {
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
	for _, uid := range a.settings.AllowedPrometheusDatasourceUIDs {
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

type grafanaAPIError struct {
	status int
	body   string
}

func (e grafanaAPIError) Error() string {
	return fmt.Sprintf("Grafana API error (%d): %s", e.status, e.body)
}

func (a *App) grafanaAPI(req *http.Request, method string, apiPath string, body []byte) ([]byte, error) {
	cfg := config.GrafanaConfigFromContext(req.Context())
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
	defer func() {
		_ = res.Body.Close()
	}()

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
	cfg := config.GrafanaConfigFromContext(req.Context())
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

func (a *App) dashboardSaveURL(req *http.Request, uid string, savedURL string) string {
	savedURL = strings.TrimSpace(savedURL)
	if savedURL == "" {
		return a.dashboardURL(req, uid)
	}
	parsed, err := url.Parse(savedURL)
	if err == nil && parsed.IsAbs() {
		return savedURL
	}
	cfg := config.GrafanaConfigFromContext(req.Context())
	appURL, err := cfg.AppURL()
	if err != nil {
		return savedURL
	}
	joined, err := joinGrafanaURL(appURL, savedURL)
	if err != nil {
		return savedURL
	}
	return joined
}

func stringMapField(record map[string]any, field string) string {
	value, _ := record[field].(string)
	return value
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
