package plugin

import (
	"encoding/json"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestLoadSettingsReadsPrometheusDatasourceAllowList(t *testing.T) {
	jsonData, _ := json.Marshal(map[string]any{
		"allowedPrometheusDatasourceUids": []string{"prometheus"},
	})

	settings := loadSettings(backend.AppInstanceSettings{JSONData: jsonData})

	if len(settings.AllowedPrometheusDatasourceUIDs) != 1 || settings.AllowedPrometheusDatasourceUIDs[0] != "prometheus" {
		t.Fatalf("expected Prometheus allow-list, got %#v", settings.AllowedPrometheusDatasourceUIDs)
	}
}

func TestLoadSettingsPreservesEmptyPrometheusDatasourceAllowList(t *testing.T) {
	jsonData, _ := json.Marshal(map[string]any{
		"allowedPrometheusDatasourceUids": []string{},
	})

	settings := loadSettings(backend.AppInstanceSettings{JSONData: jsonData})

	if settings.AllowedPrometheusDatasourceUIDs == nil {
		t.Fatal("expected explicit empty Prometheus allow-list to be preserved")
	}
	if len(settings.AllowedPrometheusDatasourceUIDs) != 0 {
		t.Fatalf("expected explicit empty Prometheus allow-list, got %#v", settings.AllowedPrometheusDatasourceUIDs)
	}
}
