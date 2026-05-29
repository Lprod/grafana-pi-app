package plugin

import (
	"encoding/json"
	"strings"
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

func TestLoadSettingsNormalizesAccessPolicy(t *testing.T) {
	jsonData, _ := json.Marshal(map[string]any{
		"accessMode":   "Users",
		"allowedUsers": []string{" Alice@example.com ", "alice@example.com", "bob"},
	})

	settings := loadSettings(backend.AppInstanceSettings{JSONData: jsonData})

	if settings.AccessMode != accessModeUsers {
		t.Fatalf("expected users access mode, got %q", settings.AccessMode)
	}
	expected := []string{"alice@example.com", "bob"}
	if strings.Join(settings.AllowedUsers, ",") != strings.Join(expected, ",") {
		t.Fatalf("expected normalized allowed users %#v, got %#v", expected, settings.AllowedUsers)
	}
}

func TestLoadSettingsDefaultsToAllAccess(t *testing.T) {
	settings := loadSettings(backend.AppInstanceSettings{})

	if settings.AccessMode != accessModeAll {
		t.Fatalf("expected all access mode, got %q", settings.AccessMode)
	}
}
