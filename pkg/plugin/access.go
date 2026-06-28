package plugin

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/grafana/authlib/authz"
	"github.com/grafana/authlib/cache"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"
)

const (
	grafanaIDHeader = "X-Grafana-Id"

	accessModeAll    = "all"
	accessModeAdmins = "admins"
	accessModeUsers  = "users"
	accessModeRBAC   = "rbac"
)

func (a *App) withAppAccess(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		allowed, err := a.hasAppAccess(req)
		if err != nil {
			writeJSONError(w, http.StatusForbidden, "permission denied")
			return
		}
		if !allowed {
			writeJSONError(w, http.StatusForbidden, "permission denied")
			return
		}

		handler(w, req)
	}
}

func (a *App) hasAppAccess(req *http.Request) (bool, error) {
	mode := normalizeAccessMode(a.settings.AccessMode)
	if mode == accessModeAll {
		return true, nil
	}

	user := backend.UserFromContext(req.Context())
	if user == nil {
		return false, nil
	}

	switch mode {
	case accessModeAdmins:
		return isOrgAdmin(user), nil
	case accessModeUsers:
		return isOrgAdmin(user) || isAllowedUser(user, a.settings.AllowedUsers), nil
	case accessModeRBAC:
		if isOrgAdmin(user) {
			return true, nil
		}
		return a.hasRBACAccess(req, appAccessAction())
	default:
		return false, nil
	}
}

func appAccessAction() string {
	return pluginID + ".app:access"
}

func (a *App) hasRBACAccess(req *http.Request, action string) (bool, error) {
	idToken := req.Header.Get(grafanaIDHeader)
	if idToken == "" {
		return false, nil
	}

	authzClient, err := a.getAuthZClient(req)
	if err != nil {
		return false, err
	}

	return authzClient.HasAccess(req.Context(), idToken, action)
}

func (a *App) getAuthZClient(req *http.Request) (authz.EnforcementClient, error) {
	cfg := config.GrafanaConfigFromContext(req.Context())
	if cfg == nil {
		return nil, errors.New("grafana config not found")
	}

	saToken, err := cfg.PluginAppClientSecret()
	if err != nil || saToken == "" {
		if err == nil {
			err = errors.New("service account token not found")
		}
		return nil, err
	}

	a.authzMu.Lock()
	defer a.authzMu.Unlock()

	if a.authzClient != nil && a.authzToken == saToken {
		return a.authzClient, nil
	}

	grafanaURL, err := cfg.AppURL()
	if err != nil {
		return nil, err
	}
	grafanaURL = strings.TrimRight(grafanaURL, "/")

	client, err := authz.NewEnforcementClient(
		authz.Config{
			APIURL:  grafanaURL,
			Token:   saToken,
			JWKsURL: grafanaURL + "/api/signing-keys/keys",
		},
		authz.WithSearchByPrefix(pluginID),
		authz.WithCache(cache.NewLocalCache(cache.Config{
			Expiry:          30 * time.Second,
			CleanupInterval: time.Minute,
		})),
	)
	if err != nil {
		return nil, err
	}

	a.authzToken = saToken
	a.authzClient = client
	return client, nil
}

func normalizeAccessMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case accessModeAll, accessModeAdmins, accessModeUsers, accessModeRBAC:
		return strings.ToLower(strings.TrimSpace(mode))
	default:
		return accessModeAll
	}
}

func normalizeAllowedUsers(users []string) []string {
	seen := map[string]struct{}{}
	normalized := make([]string, 0, len(users))
	for _, user := range users {
		principal := normalizePrincipal(user)
		if principal == "" {
			continue
		}
		if _, exists := seen[principal]; exists {
			continue
		}
		seen[principal] = struct{}{}
		normalized = append(normalized, principal)
	}
	return normalized
}

func isOrgAdmin(user *backend.User) bool {
	return user != nil && strings.EqualFold(strings.TrimSpace(user.Role), "Admin")
}

func isAllowedUser(user *backend.User, allowedUsers []string) bool {
	if user == nil {
		return false
	}
	allowed := map[string]struct{}{}
	for _, value := range allowedUsers {
		if principal := normalizePrincipal(value); principal != "" {
			allowed[principal] = struct{}{}
		}
	}
	_, loginAllowed := allowed[normalizePrincipal(user.Login)]
	_, emailAllowed := allowed[normalizePrincipal(user.Email)]
	return loginAllowed || emailAllowed
}

func normalizePrincipal(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
