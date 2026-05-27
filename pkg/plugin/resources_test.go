package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

type mockCallResourceResponseSender struct {
	responses []*backend.CallResourceResponse
}

func (s *mockCallResourceResponseSender) Send(response *backend.CallResourceResponse) error {
	s.responses = append(s.responses, response)
	return nil
}

func TestLLMStreamRequiresConfiguredAPIKey(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "llm/stream",
		Body:   []byte(`{"model":{"id":"gpt-test"},"context":{"messages":[]}}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", sender.responses[0].Status)
	}
}

func TestLLMStreamRelaysOpenAICompatibleChunks(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/chat/completions" {
			t.Fatalf("unexpected path: %s", req.URL.Path)
		}
		if req.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("missing authorization header")
		}

		var payload openAIChatRequest
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %s", err)
		}
		if payload.Model != "gpt-default" {
			t.Fatalf("expected centrally configured model gpt-default, got %s", payload.Model)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"finish_reason\":\"stop\",\"delta\":{}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4,\"total_tokens\":7}}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer upstream.Close()

	jsonData, _ := json.Marshal(appSettings{OpenAIBaseURL: upstream.URL, DefaultModel: "gpt-default"})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData: jsonData,
		DecryptedSecureJSONData: map[string]string{
			"openAIAPIKey": "secret",
		},
	})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "llm/stream",
		Body: []byte(`{
			"model":{"id":"gpt-user-supplied"},
			"context":{
				"systemPrompt":"You help.",
				"messages":[{"role":"user","content":"Say hello"}]
			},
			"options":{}
		}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	combined := joinBodies(sender.responses)
	for _, expected := range []string{`"type":"start"`, `"type":"text_start"`, `"delta":"hello"`, `"type":"done"`, `"totalTokens":7`} {
		if !strings.Contains(combined, expected) {
			t.Fatalf("expected stream to contain %s, got %s", expected, combined)
		}
	}
}

func TestManagedDashboardRenderUsesVendoredJsonnetAndManagerMetadata(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/render",
		Body: []byte(`{
			"templateId": "service-red",
			"uid": "service-red-api",
			"title": "API Service RED",
			"datasourceUid": "prom-main",
			"folderUid": "observability",
			"job": "api"
		}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}

	var response managedDashboardRenderResponse
	if err := json.Unmarshal(sender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	if response.Dashboard["title"] != "API Service RED" {
		t.Fatalf("unexpected title: %v", response.Dashboard["title"])
	}
	if response.Resource.Metadata.Name != "service-red-api" {
		t.Fatalf("unexpected resource name: %s", response.Resource.Metadata.Name)
	}
	if response.Dashboard["editable"] != false {
		t.Fatalf("managed dashboards should render as not editable: %#v", response.Dashboard["editable"])
	}
	annotations := response.Resource.Metadata.Annotations
	if annotations[annotationManagedBy] != "plugin" || annotations[annotationManagerID] != pluginID {
		t.Fatalf("missing plugin manager annotations: %#v", annotations)
	}
	if _, exists := annotations["grafana.app/managerAllowsEdits"]; exists {
		t.Fatalf("managerAllowsEdits should not be set: %#v", annotations)
	}
	if annotations[annotationFolder] != "observability" {
		t.Fatalf("missing folder annotation: %#v", annotations)
	}
	if !strings.HasPrefix(response.SourceChecksum, "sha256:") || !strings.HasPrefix(response.ConfigChecksum, "sha256:") {
		t.Fatalf("missing checksums: source=%s config=%s", response.SourceChecksum, response.ConfigChecksum)
	}

	panels, ok := response.Dashboard["panels"].([]any)
	if !ok || len(panels) != 4 {
		t.Fatalf("expected four rendered panels, got %#v", response.Dashboard["panels"])
	}
	firstPanel := panels[0].(map[string]any)
	target := firstPanel["targets"].([]any)[0].(map[string]any)
	datasource := target["datasource"].(map[string]any)
	if datasource["uid"] != "prom-main" {
		t.Fatalf("expected target datasource prom-main, got %#v", datasource)
	}
	errorPanel := panels[1].(map[string]any)
	errorTarget := errorPanel["targets"].([]any)[0].(map[string]any)
	errorExpr := errorTarget["expr"].(string)
	if strings.Contains(errorExpr, "}{") || !strings.Contains(errorExpr, `http_requests_total{job="api",status=~"5.."}`) {
		t.Fatalf("unexpected error ratio expression: %s", errorExpr)
	}
}

func TestManagedDashboardRenderRejectsDisallowedDatasource(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/render",
		Body: []byte(`{
			"templateId": "service-red",
			"title": "Bad Service RED",
			"datasourceUid": "prom-other"
		}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", sender.responses[0].Status)
	}
	if !strings.Contains(string(sender.responses[0].Body), "datasource is not available to the app: prom-other") {
		t.Fatalf("unexpected response: %s", string(sender.responses[0].Body))
	}
}

func TestManagedDashboardDatasourceAllowListRejectsVariables(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	disallowed := app.disallowedDatasourceUIDs(map[string]any{
		"panels": []any{
			map[string]any{
				"datasource": map[string]any{"type": "prometheus", "uid": "$datasource"},
			},
		},
	})
	if len(disallowed) != 1 || disallowed[0] != "$datasource" {
		t.Fatalf("expected datasource variable to be disallowed, got %#v", disallowed)
	}
}

func TestManagedDashboardSyncWritesDashboardResource(t *testing.T) {
	var requestedMethod string
	var requestedPath string
	var authHeader string
	var saved dashboardResource

	grafana := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requestedMethod = req.Method
		requestedPath = req.URL.Path
		authHeader = req.Header.Get("Authorization")
		switch req.Method {
		case http.MethodGet:
			http.NotFound(w, req)
		case http.MethodPost:
			if err := json.NewDecoder(req.Body).Decode(&saved); err != nil {
				t.Fatalf("decode saved resource: %s", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(saved)
		default:
			t.Fatalf("unexpected method: %s", req.Method)
		}
	}))
	defer grafana.Close()

	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	ctx := backend.WithGrafanaConfig(context.Background(), backend.NewGrafanaCfg(map[string]string{
		backend.AppURL:          grafana.URL,
		backend.AppClientSecret: "service-account-token",
	}))

	var sender mockCallResourceResponseSender
	err = app.CallResource(ctx, &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/sync",
		Body: []byte(`{
			"templateId": "service-red",
			"uid": "service-red-api",
			"title": "API Service RED",
			"datasourceUid": "prom-main"
		}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}
	if requestedMethod != http.MethodPost || requestedPath != "/apis/dashboard.grafana.app/v1/namespaces/default/dashboards" {
		t.Fatalf("unexpected Grafana request: %s %s", requestedMethod, requestedPath)
	}
	if authHeader != "Bearer service-account-token" {
		t.Fatalf("unexpected auth header: %s", authHeader)
	}
	if saved.Metadata.Annotations[annotationManagedBy] != "plugin" || saved.Metadata.Annotations[annotationManagerID] != pluginID {
		t.Fatalf("saved resource is not plugin managed: %#v", saved.Metadata.Annotations)
	}

	var response managedDashboardSyncResponse
	if err := json.Unmarshal(sender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	if response.Status != "created" || response.UID != "service-red-api" {
		t.Fatalf("unexpected sync response: %#v", response)
	}
}

func joinBodies(responses []*backend.CallResourceResponse) string {
	var buffer bytes.Buffer
	for _, response := range responses {
		buffer.Write(response.Body)
	}
	return buffer.String()
}
