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

func TestLLMStreamParsesMultilineSSEAndBufferedToolArguments(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[\n"))
		_, _ = w.Write([]byte("data: {\"delta\":{\"content\":\"hello\"}}]}\n\n"))
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"arguments":"{\"query\":"}}]}}]}` + "\n\n"))
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"grafana_query"}}]}}]}` + "\n\n"))
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"up\"}"}}]},"finish_reason":"tool_calls"}]}` + "\n\n"))
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
			"context":{
				"messages":[{"role":"user","content":"Query up"}],
				"tools":[{"name":"grafana_query","description":"Query","parameters":{"type":"object"}}]
			},
			"options":{}
		}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	combined := joinBodies(sender.responses)
	for _, expected := range []string{`"delta":"hello"`, `"type":"toolcall_start"`, `"toolName":"grafana_query"`, `"type":"toolcall_end"`, `"reason":"toolUse"`} {
		if !strings.Contains(combined, expected) {
			t.Fatalf("expected stream to contain %s, got %s", expected, combined)
		}
	}

	startIndex := strings.Index(combined, `"type":"toolcall_start"`)
	bufferedArgIndex := strings.Index(combined, `"delta":"{\"query\":"`)
	laterArgIndex := strings.Index(combined, `"delta":"\"up\"}"`)
	if startIndex < 0 || bufferedArgIndex < startIndex || laterArgIndex < bufferedArgIndex {
		t.Fatalf("expected buffered tool arguments to be replayed after start and before later args, got %s", combined)
	}
}

func TestOpenAIRequestKeepsUserAndToolContentNonEmpty(t *testing.T) {
	app := App{settings: appSettings{DefaultModel: "gpt-default"}}

	payload := app.openAIRequest(proxyStreamRequest{
		Context: proxyContext{
			Messages: []proxyMessage{
				{Role: "user", Content: json.RawMessage(`""`)},
				{
					Role:       "toolResult",
					ToolCallID: "call_1",
					ToolName:   "list_label_values",
					Content:    json.RawMessage(`[{"type":"text","text":""}]`),
				},
			},
		},
	})

	if len(payload.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(payload.Messages))
	}
	if payload.Messages[0].Content == "" {
		t.Fatalf("user content should not be empty")
	}
	if payload.Messages[1].Content != "(empty tool result)" {
		t.Fatalf("unexpected tool fallback content: %q", payload.Messages[1].Content)
	}
}

func TestManagedDashboardRenderUsesVendoredJsonnetAndManagerMetadata(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';
local target =
  g.query.prometheus.new('prom-main', 'sum(rate(http_requests_total{job="api"}[$__rate_interval]))')
  + g.query.prometheus.withRefId('A')
  + g.query.prometheus.withRange(true)
  + g.query.prometheus.withEditorMode('code');

g.dashboard.new('API Service RED')
+ g.dashboard.withUid('source-api')
+ g.dashboard.withTags(['service'])
+ g.dashboard.withPanels([
  g.panel.timeSeries.new('Request rate')
  + g.panel.timeSeries.panelOptions.withGridPos(h=8, w=12, x=0, y=0)
  + g.panel.timeSeries.queryOptions.withDatasource('prometheus', 'prom-main')
  + g.panel.timeSeries.queryOptions.withTargets([target])
  + g.panel.timeSeries.standardOptions.withUnit('reqps'),
])`
	body, _ := json.Marshal(managedDashboardRequest{
		DashboardJsonnet: source,
		UID:              "direct-jsonnet-api",
		FolderUID:        "observability",
	})

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/render",
		Body:   body,
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
	if response.Resource.Metadata.Name != "direct-jsonnet-api" {
		t.Fatalf("unexpected resource name: %s", response.Resource.Metadata.Name)
	}
	if response.Dashboard["editable"] != false {
		t.Fatalf("managed dashboards should render as not editable: %#v", response.Dashboard["editable"])
	}
	if !containsTag(response.Dashboard["tags"], "service") || !containsTag(response.Dashboard["tags"], "managed-by-pi") {
		t.Fatalf("expected source and managed tags, got %#v", response.Dashboard["tags"])
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
	if annotations[annotationJsonnetSource] != source {
		t.Fatalf("stored Jsonnet source was not preserved")
	}
	if annotations[annotationSourcePath] != "inline-jsonnet" {
		t.Fatalf("unexpected source path annotation: %#v", annotations)
	}
	if !strings.HasPrefix(response.SourceChecksum, "sha256:") {
		t.Fatalf("missing source checksum: %s", response.SourceChecksum)
	}

	panels, ok := response.Dashboard["panels"].([]any)
	if !ok || len(panels) != 1 {
		t.Fatalf("expected one rendered panel, got %#v", response.Dashboard["panels"])
	}
	firstPanel := panels[0].(map[string]any)
	target := firstPanel["targets"].([]any)[0].(map[string]any)
	datasource := target["datasource"].(map[string]any)
	if datasource["uid"] != "prom-main" {
		t.Fatalf("expected target datasource prom-main, got %#v", datasource)
	}
	expr := target["expr"].(string)
	if !strings.Contains(expr, `http_requests_total{job="api"}`) {
		t.Fatalf("unexpected expression: %s", expr)
	}
}

func TestManagedDashboardRenderStoresModelAuthoredJsonnet(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `{
  title: 'Custom Prometheus Review',
  uid: 'custom-prometheus-review',
  tags: ['incident'],
  panels: [
    {
      id: 1,
      type: 'text',
      title: 'Review summary',
      gridPos: { x: 0, y: 0, w: 24, h: 5 },
      options: { mode: 'markdown', content: 'CPU saturation on vm-web-01 impacted /render/report.' },
    },
    {
      id: 2,
      type: 'timeseries',
      title: 'HTTP error ratio',
      gridPos: { x: 0, y: 5, w: 12, h: 8 },
      datasource: { type: 'prometheus', uid: 'prom-main' },
      targets: [
        {
          refId: 'A',
          datasource: { type: 'prometheus', uid: 'prom-main' },
          expr: 'sum by (vm, route) (rate(http_requests_total{job="web",status=~"5.."}[$__rate_interval])) / clamp_min(sum by (vm, route) (rate(http_requests_total{job="web"}[$__rate_interval])), 1e-9)',
        },
      ],
      fieldConfig: { defaults: { unit: 'percentunit', decimals: 3 }, overrides: [] },
      options: {},
    },
  ],
}`
	body, _ := json.Marshal(managedDashboardRequest{
		DashboardJsonnet: source,
		Tags:             []string{"reviewable"},
	})

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/render",
		Body:   body,
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
	if response.Dashboard["title"] != "Custom Prometheus Review" {
		t.Fatalf("unexpected title: %v", response.Dashboard["title"])
	}
	if response.Dashboard["editable"] != false {
		t.Fatalf("managed dashboards should render as not editable: %#v", response.Dashboard["editable"])
	}
	if !containsTag(response.Dashboard["tags"], "incident") || !containsTag(response.Dashboard["tags"], "reviewable") || !containsTag(response.Dashboard["tags"], "genai") {
		t.Fatalf("missing expected tags: %#v", response.Dashboard["tags"])
	}

	panels, ok := response.Dashboard["panels"].([]any)
	if !ok || len(panels) != 2 {
		t.Fatalf("expected two rendered panels, got %#v", response.Dashboard["panels"])
	}
	summaryPanel := panels[0].(map[string]any)
	options := summaryPanel["options"].(map[string]any)
	content := options["content"].(string)
	if !strings.Contains(content, "vm-web-01") || !strings.Contains(content, "/render/report") {
		t.Fatalf("text panel does not include expected review context: %s", content)
	}
	errorPanel := panels[1].(map[string]any)
	errorTarget := errorPanel["targets"].([]any)[0].(map[string]any)
	errorExpr := errorTarget["expr"].(string)
	if !strings.Contains(errorExpr, "clamp_min") || !strings.Contains(errorExpr, "sum by (vm, route)") {
		t.Fatalf("unexpected error ratio expression: %s", errorExpr)
	}

	annotations := response.Resource.Metadata.Annotations
	if annotations[annotationJsonnetSource] != source || annotations[annotationSourceChecksum] != response.SourceChecksum {
		t.Fatalf("missing Jsonnet source annotations: %#v", annotations)
	}
}

func TestVirtualJsonnetFileWriteEditRead(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := "{\n  title: 'Virtual Dashboard',\n  uid: 'virtual-dashboard',\n  panels: [],\n}\n"
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-a",
		Path:      "dashboard.jsonnet",
		Content:   source,
	})

	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/write",
		Body:   writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if writeSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", writeSender.responses[0].Status, string(writeSender.responses[0].Body))
	}
	var writeResponse jsonnetFileResponse
	if err := json.Unmarshal(writeSender.responses[0].Body, &writeResponse); err != nil {
		t.Fatalf("decode write response: %s", err)
	}
	if writeResponse.Version != 1 || writeResponse.LineCount != 5 || writeResponse.DashboardJsonnet != source {
		t.Fatalf("unexpected write response: %#v", writeResponse)
	}

	expectedTitle := "  title: 'Virtual Dashboard',"
	editBody, _ := json.Marshal(jsonnetFileEditRequest{
		SessionID:   "session-a",
		Path:        "dashboard.jsonnet",
		BaseVersion: &writeResponse.Version,
		Edits: []jsonnetLineEdit{
			{StartLine: 2, EndLine: 2, ExpectedText: &expectedTitle, Replacement: "  title: 'Edited Virtual Dashboard',"},
			{StartLine: 4, EndLine: 3, Replacement: "  tags: ['edited'],"},
		},
	})

	var editSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/edit",
		Body:   editBody,
	}, &editSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if editSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", editSender.responses[0].Status, string(editSender.responses[0].Body))
	}
	var editResponse jsonnetFileResponse
	if err := json.Unmarshal(editSender.responses[0].Body, &editResponse); err != nil {
		t.Fatalf("decode edit response: %s", err)
	}
	if editResponse.Version != 2 || !strings.Contains(editResponse.DashboardJsonnet, "Edited Virtual Dashboard") || !strings.Contains(editResponse.Diff, "+  tags: ['edited'],") {
		t.Fatalf("unexpected edit response: %#v", editResponse)
	}

	readBody, _ := json.Marshal(jsonnetFileReadRequest{SessionID: "session-a", Path: "dashboard.jsonnet", Offset: 2, Limit: 3})
	var readSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/read",
		Body:   readBody,
	}, &readSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	var readResponse jsonnetFileResponse
	if err := json.Unmarshal(readSender.responses[0].Body, &readResponse); err != nil {
		t.Fatalf("decode read response: %s", err)
	}
	if len(readResponse.Lines) != 3 || readResponse.Lines[0].Line != 2 || readResponse.Lines[0].Text != "  title: 'Edited Virtual Dashboard'," {
		t.Fatalf("unexpected read response: %#v", readResponse)
	}
	if readResponse.DashboardJsonnet != "" {
		t.Fatalf("read response should not include full source")
	}
}

func TestVirtualJsonnetFileEditRejectsInvalidJsonnet(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := "{\n  title: 'Virtual Dashboard',\n  uid: 'virtual-dashboard',\n  panels: [],\n}\n"
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-invalid-edit",
		Content:   source,
	})
	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/write",
		Body:   writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	editBody, _ := json.Marshal(jsonnetFileEditRequest{
		SessionID: "session-invalid-edit",
		Path:      "dashboard.jsonnet",
		Edits: []jsonnetLineEdit{
			{StartLine: 2, EndLine: 2, Replacement: "  title: 'Broken Dashboard'"},
		},
	})
	var editSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/edit",
		Body:   editBody,
	}, &editSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if editSender.responses[0].Status != http.StatusBadRequest || !strings.Contains(string(editSender.responses[0].Body), "edited Jsonnet did not compile") {
		t.Fatalf("expected invalid edit rejection, got %d: %s", editSender.responses[0].Status, string(editSender.responses[0].Body))
	}

	readBody, _ := json.Marshal(jsonnetFileReadRequest{SessionID: "session-invalid-edit", Path: "dashboard.jsonnet", Offset: 1, Limit: 5})
	var readSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/read",
		Body:   readBody,
	}, &readSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	var readResponse jsonnetFileResponse
	if err := json.Unmarshal(readSender.responses[0].Body, &readResponse); err != nil {
		t.Fatalf("decode read response: %s", err)
	}
	if readResponse.Version != 1 || readResponse.Lines[1].Text != "  title: 'Virtual Dashboard'," {
		t.Fatalf("invalid edit should not have been committed: %#v", readResponse)
	}
}

func TestVirtualJsonnetFileRepairGenericGrafonnetDashboard(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedDatasourceUIDs: []string{"prometheus"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';

g.dashboard.new(
  title='HTTP Request Rate and Errors',
  uid='http-request-rate-errors',
  tags=['http', 'errors'],
  timezone='browser',
  refresh='5s',
  panels=[
    g.panel.new(
      title='Total request rate',
      id=1,
      gridPos=g.gridPos.to_val(x=0, y=0, w=24, h=8),
      targets=[
        g.target.new(
          datasource='prometheus',
          expr='sum(rate(http_requests_total[5m])) by (job)',
          refId='A',
          legendFormat='{{job}}',
        ),
      ],
      type='timeseries',
      fieldConfigDefaults=g.panel.defaultFieldConfig.setUnit('reqps'),
    ),
    g.panel.new(
      title='Overall error rate %',
      id=2,
      gridPos=g.gridPos.to_val(x=0, y=8, w=12, h=8),
      targets=[
        g.target.new(
          datasource='prometheus',
          expr='sum(rate(http_requests_total{status=~"4..|5.."}[5m])) / sum(rate(http_requests_total[5m])) * 100',
          refId='A',
        ),
      ],
      type='stat',
      fieldConfigDefaults=g.panel.defaultFieldConfig.setUnit('percent'),
    ),
  ],
)`
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-repair",
		Content:   source,
	})
	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/write",
		Body:   writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	repairBody, _ := json.Marshal(jsonnetFileRepairRequest{
		SessionID: "session-repair",
		Path:      "dashboard.jsonnet",
	})
	var repairSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/repair",
		Body:   repairBody,
	}, &repairSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if repairSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", repairSender.responses[0].Status, string(repairSender.responses[0].Body))
	}
	var repairResponse jsonnetFileResponse
	if err := json.Unmarshal(repairSender.responses[0].Body, &repairResponse); err != nil {
		t.Fatalf("decode repair response: %s", err)
	}
	if repairResponse.Version != 2 || len(repairResponse.Repairs) == 0 {
		t.Fatalf("unexpected repair response: %#v", repairResponse)
	}
	if strings.Contains(repairResponse.DashboardJsonnet, "g.panel.new") || !strings.Contains(repairResponse.DashboardJsonnet, "fieldConfig") {
		t.Fatalf("repair did not rewrite panel constructors: %s", repairResponse.DashboardJsonnet)
	}

	renderBody, _ := json.Marshal(managedDashboardRequest{
		SessionID: "session-repair",
		Path:      "dashboard.jsonnet",
	})
	var renderSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/render",
		Body:   renderBody,
	}, &renderSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if renderSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected render 200, got %d: %s", renderSender.responses[0].Status, string(renderSender.responses[0].Body))
	}
	var renderResponse managedDashboardRenderResponse
	if err := json.Unmarshal(renderSender.responses[0].Body, &renderResponse); err != nil {
		t.Fatalf("decode render response: %s", err)
	}
	if renderResponse.Resource.Metadata.Name != "http-request-rate-errors" || len(renderResponse.Dashboard["panels"].([]any)) != 2 {
		t.Fatalf("unexpected rendered dashboard: %#v", renderResponse.Dashboard)
	}
}

func TestVirtualJsonnetFileRepairDashboardWithPanelsMixinAndLocalPanels(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedDatasourceUIDs: []string{"prometheus"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';
local reqByRoute = g.timeseries.new(
  title='Requests by route',
  id=1,
  span=24,
  datasource=g.target.defaultDatasource('prometheus'),
  targets=[
    g.target.new(
      expr='sum(rate(http_requests_total[5m])) by (route)',
      refId='A',
      legend='{{route}}',
    ),
  ],
  fieldConfig=g.panel.fieldConfig.defaults(unit='reqps'),
);

g.dashboard.new(
  title='HTTP Request Rate and Errors',
  uid='http-request-rate-errors',
  tags=['http', 'errors'],
) + g.dashboard.with_panels([reqByRoute])`
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-repair-mixin",
		Content:   source,
	})
	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/write",
		Body:   writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	repairBody, _ := json.Marshal(jsonnetFileRepairRequest{
		SessionID: "session-repair-mixin",
		Path:      "dashboard.jsonnet",
	})
	var repairSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/repair",
		Body:   repairBody,
	}, &repairSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if repairSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", repairSender.responses[0].Status, string(repairSender.responses[0].Body))
	}
	var repairResponse jsonnetFileResponse
	if err := json.Unmarshal(repairSender.responses[0].Body, &repairResponse); err != nil {
		t.Fatalf("decode repair response: %s", err)
	}
	if repairResponse.Version != 2 || !strings.Contains(repairResponse.DashboardJsonnet, "Requests by route") || strings.Contains(repairResponse.DashboardJsonnet, "with_panels") {
		t.Fatalf("unexpected repair response: %#v", repairResponse)
	}

	renderBody, _ := json.Marshal(managedDashboardRequest{
		SessionID: "session-repair-mixin",
		Path:      "dashboard.jsonnet",
	})
	var renderSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/render",
		Body:   renderBody,
	}, &renderSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if renderSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected render 200, got %d: %s", renderSender.responses[0].Status, string(renderSender.responses[0].Body))
	}
	var renderResponse managedDashboardRenderResponse
	if err := json.Unmarshal(renderSender.responses[0].Body, &renderResponse); err != nil {
		t.Fatalf("decode render response: %s", err)
	}
	panels := renderResponse.Dashboard["panels"].([]any)
	if renderResponse.Resource.Metadata.Name != "http-request-rate-errors" || len(panels) != 1 || panels[0].(map[string]any)["type"] != "timeseries" {
		t.Fatalf("unexpected rendered dashboard: %#v", renderResponse.Dashboard)
	}
}

func TestManagedDashboardRenderAutoRepairsVirtualJsonnetFile(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedDatasourceUIDs: []string{"prometheus"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';

g.dashboard.new(
  title='HTTP Request Rate and Errors',
  uid='http-request-rate-errors',
  panels=[
    g.panel.new(
      title='Request rate',
      targets=[
        g.target.new(
          datasource='prometheus',
          expr='sum(rate(http_requests_total[5m]))',
          refId='A',
        ),
      ],
      type='timeseries',
    ),
  ],
)`
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-auto-repair",
		Content:   source,
	})
	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/write",
		Body:   writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	renderBody, _ := json.Marshal(managedDashboardRequest{
		SessionID: "session-auto-repair",
		Path:      "dashboard.jsonnet",
	})
	var renderSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/render",
		Body:   renderBody,
	}, &renderSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if renderSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected render 200, got %d: %s", renderSender.responses[0].Status, string(renderSender.responses[0].Body))
	}
	var renderResponse managedDashboardRenderResponse
	if err := json.Unmarshal(renderSender.responses[0].Body, &renderResponse); err != nil {
		t.Fatalf("decode render response: %s", err)
	}
	panels := renderResponse.Dashboard["panels"].([]any)
	if !renderResponse.AutoRepaired || len(renderResponse.Repairs) == 0 || renderResponse.JsonnetFile == nil || renderResponse.JsonnetFile.Version != 2 {
		t.Fatalf("expected auto-repaired virtual file metadata, got %#v", renderResponse)
	}
	storedSource := renderResponse.Resource.Metadata.Annotations[annotationJsonnetSource]
	if strings.Contains(storedSource, "g.panel.new") || !strings.Contains(storedSource, "Request rate") {
		t.Fatalf("render did not store repaired source: %s", storedSource)
	}
	if renderResponse.Resource.Metadata.Name != "http-request-rate-errors" || len(panels) != 1 || panels[0].(map[string]any)["type"] != "timeseries" {
		t.Fatalf("unexpected rendered dashboard: %#v", renderResponse.Dashboard)
	}
}

func TestManagedDashboardRenderFromVirtualJsonnetFile(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := "{ title: 'Virtual Render', uid: 'virtual-render', panels: [] }"
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-render",
		Content:   source,
	})
	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/jsonnet-files/write",
		Body:   writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	renderBody, _ := json.Marshal(managedDashboardRequest{
		SessionID: "session-render",
		Path:      "dashboard.jsonnet",
	})
	var renderSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/render",
		Body:   renderBody,
	}, &renderSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if renderSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", renderSender.responses[0].Status, string(renderSender.responses[0].Body))
	}

	var response managedDashboardRenderResponse
	if err := json.Unmarshal(renderSender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	annotations := response.Resource.Metadata.Annotations
	if annotations[annotationJsonnetSource] != source {
		t.Fatalf("virtual source was not stored in annotations: %#v", annotations)
	}
	if annotations[annotationSourcePath] != "dashboard.jsonnet" {
		t.Fatalf("unexpected source path: %#v", annotations)
	}
}

func TestManagedDashboardRenderRejectsDisallowedDatasource(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `{
  title: 'Bad Service RED',
  panels: [
    {
      type: 'timeseries',
      title: 'Bad',
      datasource: { type: 'prometheus', uid: 'prom-other' },
      targets: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'prom-other' }, expr: 'up' }],
    },
  ],
}`
	body, _ := json.Marshal(managedDashboardRequest{DashboardJsonnet: source})

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/render",
		Body:   body,
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
	if !strings.Contains(string(sender.responses[0].Body), "dashboard references datasource UIDs not available to the app: prom-other") {
		t.Fatalf("unexpected response: %s", string(sender.responses[0].Body))
	}
}

func TestManagedDashboardSourceReturnsStoredJsonnet(t *testing.T) {
	source := "{ title: 'Stored Source', uid: 'stored-source', panels: [] }"
	grafana := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet || req.URL.Path != "/apis/dashboard.grafana.app/v1/namespaces/default/dashboards/stored-source" {
			t.Fatalf("unexpected Grafana request: %s %s", req.Method, req.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(dashboardResource{
			Kind:       "Dashboard",
			APIVersion: "dashboard.grafana.app/v1",
			Metadata: dashboardResourceMetadata{
				Name: "stored-source",
				Annotations: map[string]string{
					annotationManagedBy:      "plugin",
					annotationManagerID:      pluginID,
					annotationFolder:         "observability",
					annotationSourcePath:     "inline-jsonnet",
					annotationSourceChecksum: "sha256:test",
					annotationJsonnetSource:  source,
				},
			},
			Spec: map[string]any{"title": "Stored Source"},
		})
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
		Path:   "managed-dashboards/source",
		Body:   []byte(`{"uid":"stored-source"}`),
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

	var response managedDashboardSourceResponse
	if err := json.Unmarshal(sender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	if response.DashboardJsonnet != source || response.DashboardJsonnetSize != len([]byte(source)) {
		t.Fatalf("unexpected source response: %#v", response)
	}
	if _, exists := response.Annotations[annotationJsonnetSource]; exists {
		t.Fatalf("public annotations should not include the full source: %#v", response.Annotations)
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
	source := "{ title: 'API Service Direct', uid: 'direct-jsonnet-sync', panels: [] }"
	body, _ := json.Marshal(managedDashboardRequest{DashboardJsonnet: source})

	var sender mockCallResourceResponseSender
	err = app.CallResource(ctx, &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "managed-dashboards/sync",
		Body:   body,
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
	if saved.Metadata.Annotations[annotationJsonnetSource] != source {
		t.Fatalf("saved resource did not store Jsonnet source: %#v", saved.Metadata.Annotations)
	}

	var response managedDashboardSyncResponse
	if err := json.Unmarshal(sender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	if response.Status != "created" || response.UID != "direct-jsonnet-sync" {
		t.Fatalf("unexpected sync response: %#v", response)
	}
}

func containsTag(raw any, expected string) bool {
	tags, ok := raw.([]any)
	if !ok {
		return false
	}
	for _, tag := range tags {
		if tag == expected {
			return true
		}
	}
	return false
}

func joinBodies(responses []*backend.CallResourceResponse) string {
	var buffer bytes.Buffer
	for _, response := range responses {
		buffer.Write(response.Body)
	}
	return buffer.String()
}
