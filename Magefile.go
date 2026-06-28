//go:build mage
// +build mage

package main

import (
	"os"

	// mage:import
	build "github.com/grafana/grafana-plugin-sdk-go/build"
)

func init() {
	_ = build.SetBeforeBuildCallback(func(cfg build.Config) (build.Config, error) {
		pluginID := os.Getenv("GRAFANA_PLUGIN_ID")
		if pluginID == "" {
			return cfg, nil
		}

		if cfg.CustomVars == nil {
			cfg.CustomVars = map[string]string{}
		}
		cfg.CustomVars["github.com/elohmeier/grafana-pi-app/pkg/plugin.pluginID"] = pluginID

		return cfg, nil
	})
}

// Default configures the default target.
var Default = build.BuildAll
