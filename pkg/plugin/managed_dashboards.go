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
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const (
	pluginID = "elohmeier-grafanapiapp-app"

	annotationFolder         = "grafana.app/folder"
	annotationManagedBy      = "grafana.app/managedBy"
	annotationManagerID      = "grafana.app/managerId"
	annotationSourcePath     = "grafana.app/sourcePath"
	annotationSourceChecksum = "grafana.app/sourceChecksum"
	annotationSourceTS       = "grafana.app/sourceTimestamp"
	annotationTemplateID     = "elohmeier.grafanapiapp/templateId"
	annotationConfig         = "elohmeier.grafanapiapp/config"
	annotationConfigChecksum = "elohmeier.grafanapiapp/configChecksum"
)

type managedDashboardTemplate struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	SourcePath  string `json:"sourcePath"`
}

type managedDashboardRequest struct {
	TemplateID    string   `json:"templateId"`
	UID           string   `json:"uid,omitempty"`
	Title         string   `json:"title,omitempty"`
	FolderUID     string   `json:"folderUid,omitempty"`
	DatasourceUID string   `json:"datasourceUid"`
	Job           string   `json:"job,omitempty"`
	Tags          []string `json:"tags,omitempty"`
	Overwrite     *bool    `json:"overwrite,omitempty"`
}

type managedDashboardRenderResponse struct {
	Dashboard      map[string]any           `json:"dashboard"`
	Resource       dashboardResource        `json:"resource"`
	Template       managedDashboardTemplate `json:"template"`
	SourceChecksum string                   `json:"sourceChecksum"`
	ConfigChecksum string                   `json:"configChecksum"`
}

type managedDashboardSyncResponse struct {
	UID            string         `json:"uid"`
	URL            string         `json:"url"`
	Status         string         `json:"status"`
	Dashboard      map[string]any `json:"dashboard"`
	Resource       map[string]any `json:"resource"`
	SourceChecksum string         `json:"sourceChecksum"`
	ConfigChecksum string         `json:"configChecksum"`
}

type managedDashboardListResponse struct {
	Dashboards []managedDashboardListItem `json:"dashboards"`
}

type managedDashboardListItem struct {
	UID            string                   `json:"uid"`
	Title          string                   `json:"title"`
	URL            string                   `json:"url"`
	TemplateID     string                   `json:"templateId,omitempty"`
	FolderUID      string                   `json:"folderUid,omitempty"`
	SourcePath     string                   `json:"sourcePath,omitempty"`
	SourceChecksum string                   `json:"sourceChecksum,omitempty"`
	ConfigChecksum string                   `json:"configChecksum,omitempty"`
	Config         *managedDashboardRequest `json:"config,omitempty"`
	Annotations    map[string]string        `json:"annotations"`
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
	managedDashboardTemplates = []managedDashboardTemplate{
		{
			ID:          "service-red",
			Name:        "Service RED",
			Description: "Request rate, errors, duration, and saturation for a Prometheus-backed service.",
			SourcePath:  "service-red.jsonnet",
		},
	}
	templateByID = map[string]managedDashboardTemplate{
		"service-red": managedDashboardTemplates[0],
	}
	dashboardUIDPattern = regexp.MustCompile(`[^a-z0-9-]+`)
)

func (a *App) handleManagedDashboardTemplates(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"templates": managedDashboardTemplates})
}

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
		var config *managedDashboardRequest
		if raw := annotations[annotationConfig]; raw != "" {
			var parsed managedDashboardRequest
			if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
				config = &parsed
			}
		}

		items = append(items, managedDashboardListItem{
			UID:            resource.Metadata.Name,
			Title:          fmt.Sprint(resource.Spec["title"]),
			URL:            a.dashboardURL(req, resource.Metadata.Name),
			TemplateID:     annotations[annotationTemplateID],
			FolderUID:      annotations[annotationFolder],
			SourcePath:     annotations[annotationSourcePath],
			SourceChecksum: annotations[annotationSourceChecksum],
			ConfigChecksum: annotations[annotationConfigChecksum],
			Config:         config,
			Annotations:    annotations,
		})
	}

	writeJSON(w, http.StatusOK, managedDashboardListResponse{Dashboards: items})
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
		UID:            rendered.Resource.Metadata.Name,
		URL:            a.dashboardURL(req, rendered.Resource.Metadata.Name),
		Status:         map[bool]string{true: "updated", false: "created"}[exists],
		Dashboard:      rendered.Dashboard,
		Resource:       resource,
		SourceChecksum: rendered.SourceChecksum,
		ConfigChecksum: rendered.ConfigChecksum,
	})
}

func (a *App) renderManagedDashboardRequest(body io.Reader) (*managedDashboardRenderResponse, error) {
	var request managedDashboardRequest
	if err := json.NewDecoder(body).Decode(&request); err != nil {
		return nil, fmt.Errorf("invalid request body: %w", err)
	}
	request = normalizeManagedDashboardRequest(request)

	template, ok := templateByID[request.TemplateID]
	if !ok {
		return nil, fmt.Errorf("unknown managed dashboard template: %s", request.TemplateID)
	}
	if request.DatasourceUID == "" {
		return nil, errors.New("datasourceUid is required")
	}
	if err := a.validateDatasourceAllowed(request.DatasourceUID); err != nil {
		return nil, err
	}

	configJSON, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}

	rendered, err := renderJsonnetTemplate(template.SourcePath, configJSON)
	if err != nil {
		return nil, fmt.Errorf("jsonnet compilation failed: %w", err)
	}

	var dashboard map[string]any
	if err := json.Unmarshal(rendered, &dashboard); err != nil {
		return nil, fmt.Errorf("compiled Jsonnet is not valid dashboard JSON: %w", err)
	}
	if dashboard["title"] == nil || strings.TrimSpace(fmt.Sprint(dashboard["title"])) == "" {
		return nil, errors.New("compiled dashboard must include a title")
	}
	dashboard["uid"] = request.UID
	dashboard["tags"] = ensureStringTag(dashboard["tags"], "genai")
	delete(dashboard, "id")

	disallowed := a.disallowedDatasourceUIDs(dashboard)
	if len(disallowed) > 0 {
		return nil, fmt.Errorf("dashboard references datasource UIDs not available to the app: %s", strings.Join(disallowed, ", "))
	}

	sourceChecksum, err := jsonnetSourceChecksum(template.SourcePath, configJSON)
	if err != nil {
		return nil, err
	}
	configChecksum := checksumJSON(configJSON)

	resource := dashboardResource{
		Kind:       "Dashboard",
		APIVersion: "dashboard.grafana.app/v1",
		Metadata: dashboardResourceMetadata{
			Name:        request.UID,
			Annotations: managedDashboardAnnotations(request, template, sourceChecksum, configChecksum),
		},
		Spec: dashboard,
	}

	return &managedDashboardRenderResponse{
		Dashboard:      dashboard,
		Resource:       resource,
		Template:       template,
		SourceChecksum: sourceChecksum,
		ConfigChecksum: configChecksum,
	}, nil
}

func normalizeManagedDashboardRequest(request managedDashboardRequest) managedDashboardRequest {
	request.TemplateID = strings.TrimSpace(request.TemplateID)
	if request.TemplateID == "" {
		request.TemplateID = "service-red"
	}
	request.Title = strings.TrimSpace(request.Title)
	if request.Title == "" {
		request.Title = templateTitle(request.TemplateID)
	}
	request.DatasourceUID = strings.TrimSpace(request.DatasourceUID)
	request.FolderUID = strings.TrimSpace(request.FolderUID)
	request.Job = strings.TrimSpace(request.Job)
	request.UID = normalizeManagedDashboardUID(request.UID, request.Title)
	request.Tags = normalizeTags(request.Tags)
	return request
}

func templateTitle(templateID string) string {
	if template, ok := templateByID[templateID]; ok {
		return template.Name
	}
	return "Managed dashboard"
}

func normalizeManagedDashboardUID(uid string, title string) string {
	raw := strings.TrimSpace(uid)
	if raw == "" {
		raw = "pi-" + strings.ToLower(title)
	}
	raw = strings.ToLower(raw)
	raw = dashboardUIDPattern.ReplaceAllString(raw, "-")
	raw = strings.Trim(raw, "-")
	raw = strings.Join(strings.FieldsFunc(raw, func(r rune) bool { return r == '-' }), "-")
	if raw == "" {
		raw = "pi-dashboard"
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

func managedDashboardAnnotations(request managedDashboardRequest, template managedDashboardTemplate, sourceChecksum string, configChecksum string) map[string]string {
	annotations := map[string]string{
		annotationManagedBy:      "plugin",
		annotationManagerID:      pluginID,
		annotationSourcePath:     path.Join("jsonnet/templates", template.SourcePath),
		annotationSourceChecksum: sourceChecksum,
		annotationSourceTS:       fmt.Sprintf("%d", time.Now().UnixMilli()),
		annotationTemplateID:     template.ID,
		annotationConfigChecksum: configChecksum,
	}
	if request.FolderUID != "" {
		annotations[annotationFolder] = request.FolderUID
	}
	if config, err := json.Marshal(request); err == nil && len(config) <= 8192 {
		annotations[annotationConfig] = string(config)
	}
	return annotations
}

func requestAllowsOverwrite(rendered *managedDashboardRenderResponse) bool {
	raw := rendered.Resource.Metadata.Annotations[annotationConfig]
	if raw == "" {
		return true
	}
	var request managedDashboardRequest
	if err := json.Unmarshal([]byte(raw), &request); err != nil {
		return true
	}
	return request.Overwrite == nil || *request.Overwrite
}

func (a *App) validateDatasourceAllowed(uid string) error {
	allowed := a.allowedDatasourceSet()
	if len(allowed) == 0 {
		return nil
	}
	if !allowed[uid] {
		return fmt.Errorf("datasource is not available to the app: %s", uid)
	}
	return nil
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

func ensureStringTag(raw any, required string) []string {
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
	if !seen[required] {
		result = append(result, required)
	}
	return result
}

func checksumJSON(value []byte) string {
	sum := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (a *App) dashboardResourceExists(req *http.Request, uid string) (bool, error) {
	_, err := a.grafanaAPI(req, http.MethodGet, "/apis/dashboard.grafana.app/v1/namespaces/default/dashboards/"+url.PathEscape(uid), nil)
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
