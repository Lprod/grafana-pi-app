package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/grafana/authlib/authz"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

// Make sure App implements required interfaces. This is important to do
// since otherwise we will only get a not implemented error response from plugin in
// runtime. Plugin should not implement all these interfaces - only those which are
// required for a particular task.
var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// App is an example app plugin with a backend which can respond to data queries.
type App struct {
	backend.CallResourceHandler
	settings     appSettings
	httpClient   *http.Client
	jsonnetFiles *virtualJsonnetFileStore
	agentSample  *agentContractSampleStore
	authzMu      sync.Mutex
	authzToken   string
	authzClient  authz.EnforcementClient
}

type appSettings struct {
	OpenAIBaseURL                   string   `json:"openAIBaseUrl"`
	DefaultModel                    string   `json:"defaultModel"`
	ThinkingLevel                   string   `json:"thinkingLevel"`
	ThinkingFormat                  string   `json:"thinkingFormat"`
	AccessMode                      string   `json:"accessMode"`
	AllowedUsers                    []string `json:"allowedUsers"`
	AllowedPrometheusDatasourceUIDs []string `json:"allowedPrometheusDatasourceUids"`
	SystemPromptAddendum            string   `json:"systemPromptAddendum"`
	OpenAIAPIKey                    string
	PluginID                        string `json:"pluginId"`
	EnableAgentContractSample       bool   `json:"enableAgentContractSample"`
}

const (
	thinkingLevelOff    = "off"
	thinkingLevelLow    = "low"
	thinkingLevelMedium = "medium"
	thinkingLevelHigh   = "high"

	thinkingFormatOpenAI           = "openai"
	thinkingFormatQwen             = "qwen"
	thinkingFormatQwenChatTemplate = "qwen-chat-template"
)

// NewApp creates a new example *App instance.
func NewApp(_ context.Context, settings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	app := App{
		settings:     loadSettings(settings),
		httpClient:   &http.Client{Timeout: 10 * time.Minute},
		jsonnetFiles: newVirtualJsonnetFileStore(),
	}
	if app.settings.EnableAgentContractSample {
		app.agentSample = newAgentContractSampleStore(app.settings.PluginID)
	}

	// Use a httpadapter (provided by the SDK) for resource calls. This allows us
	// to use a *http.ServeMux for resource calls, so we can map multiple routes
	// to CallResource without having to implement extra logic.
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)

	return &app, nil
}

// Dispose here tells plugin SDK that plugin wants to clean up resources when a new instance
// created.
func (a *App) Dispose() {
	// cleanup
}

// CheckHealth handles health checks sent from Grafana to the plugin.
func (a *App) CheckHealth(_ context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if a.settings.OpenAIAPIKey == "" {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "OpenAI-compatible API key is not configured",
		}, nil
	}

	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: "LLM proxy is configured",
	}, nil
}

func loadSettings(settings backend.AppInstanceSettings) appSettings {
	loaded := appSettings{
		OpenAIBaseURL: "https://api.openai.com/v1",
		DefaultModel:  "gpt-4.1",
	}

	if len(settings.JSONData) > 0 {
		_ = json.Unmarshal(settings.JSONData, &loaded)
	}

	if loaded.OpenAIBaseURL == "" {
		loaded.OpenAIBaseURL = "https://api.openai.com/v1"
	}
	loaded.OpenAIBaseURL = strings.TrimRight(loaded.OpenAIBaseURL, "/")
	if loaded.DefaultModel == "" {
		loaded.DefaultModel = "gpt-4.1"
	}
	loaded.ThinkingLevel = normalizeThinkingLevel(loaded.ThinkingLevel)
	loaded.ThinkingFormat = normalizeThinkingFormat(loaded.ThinkingFormat)
	loaded.AccessMode = normalizeAccessMode(loaded.AccessMode)
	loaded.AllowedUsers = normalizeAllowedUsers(loaded.AllowedUsers)
	loaded.OpenAIAPIKey = settings.DecryptedSecureJSONData["openAIAPIKey"]
	loaded.PluginID = strings.TrimSpace(loaded.PluginID)
	if envPluginID := strings.TrimSpace(os.Getenv("PI_PLUGIN_ID")); envPluginID != "" {
		loaded.PluginID = envPluginID
	}
	if loaded.PluginID == "" {
		loaded.PluginID = ID()
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("PI_AGENT_CONTRACT_SAMPLE"))) {
	case "1", "true", "yes":
		loaded.EnableAgentContractSample = true
	case "0", "false", "no":
		loaded.EnableAgentContractSample = false
	}

	return loaded
}

func normalizeThinkingLevel(value string) string {
	switch value {
	case thinkingLevelLow, thinkingLevelMedium, thinkingLevelHigh:
		return value
	default:
		return thinkingLevelOff
	}
}

func normalizeThinkingFormat(value string) string {
	switch value {
	case thinkingFormatQwen, thinkingFormatQwenChatTemplate:
		return value
	default:
		return thinkingFormatOpenAI
	}
}
