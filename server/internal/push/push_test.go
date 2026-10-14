package push_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/push"
)

// newPushEnv allows the fake push host used across these tests.
func newPushEnv(t *testing.T) *apptest.Env {
	return apptest.NewWithConfig(t, func(c *app.Config) { c.Push = push.Options{AllowedHosts: []string{"push.example"}} })
}

type key struct {
	PublicKey string `json:"public_key"`
}

func sub(endpoint, level string) map[string]any {
	return map[string]any{
		"endpoint": endpoint,
		"keys":     map[string]string{"p256dh": "BPk", "auth": "au"},
		"level":    level,
	}
}

func count(t *testing.T, env *apptest.Env, where string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, env.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_subscriptions WHERE "+where, args...).Scan(&n))
	return n
}

func TestPublicKeyIsStable(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var a, b key
	alice.Do(http.MethodGet, "/api/push/key", nil, http.StatusOK, &a)
	alice.Do(http.MethodGet, "/api/push/key", nil, http.StatusOK, &b)
	require.NotEmpty(t, a.PublicKey)
	require.Equal(t, a.PublicKey, b.PublicKey)
	env.Anon().Fail(http.MethodGet, "/api/push/key", nil, http.StatusUnauthorized, "UNAUTHORIZED")
}

func TestPutAndDeleteSubscription(t *testing.T) {
	env := newPushEnv(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPut, "/api/push/subscription", sub("https://push.example/a", "mentions"), http.StatusNoContent, nil)
	require.Equal(t, 1, count(t, env, "level = 'mentions'"))

	alice.Do(http.MethodPut, "/api/push/subscription", sub("https://push.example/a", "all"), http.StatusNoContent, nil)
	require.Equal(t, 1, count(t, env, "level = 'all'"), "same endpoint updates in place")

	alice.Fail(http.MethodPut, "/api/push/subscription", sub("https://push.example/a", "loud"), http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPut, "/api/push/subscription", sub("http://push.example/a", "all"), http.StatusBadRequest, "VALIDATION_FAILED")

	bob := env.Register("bob")
	bob.Do(http.MethodDelete, "/api/push/subscription", map[string]any{"endpoint": "https://push.example/a"}, http.StatusNoContent, nil)
	require.Equal(t, 1, count(t, env, "true"), "bob cannot delete alice's subscription")

	alice.Do(http.MethodDelete, "/api/push/subscription", map[string]any{"endpoint": "https://push.example/a"}, http.StatusNoContent, nil)
	require.Equal(t, 0, count(t, env, "true"))
}

func TestSubscriptionMovesToNewUser(t *testing.T) {
	env := newPushEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	alice.Do(http.MethodPut, "/api/push/subscription", sub("https://push.example/shared", "all"), http.StatusNoContent, nil)
	bob.Do(http.MethodPut, "/api/push/subscription", sub("https://push.example/shared", "all"), http.StatusNoContent, nil)
	require.Equal(t, 0, count(t, env, "user_id = $1", alice.User.ID))
	require.Equal(t, 1, count(t, env, "user_id = $1", bob.User.ID))
}

func TestLogoutDeletesSubscriptions(t *testing.T) {
	env := newPushEnv(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPut, "/api/push/subscription", sub("https://push.example/a", "all"), http.StatusNoContent, nil)
	alice.Do(http.MethodPost, "/api/auth/logout", nil, http.StatusNoContent, nil)
	require.Equal(t, 0, count(t, env, "true"))
}

func TestManifest(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPatch, "/api/server", map[string]any{"name": "Lofoten Crew"}, http.StatusOK, nil)

	res, raw := env.Anon().Raw(http.MethodGet, "/manifest.webmanifest", nil, "", http.StatusOK)
	require.Equal(t, "application/manifest+json", res.Header.Get("Content-Type"))
	var m struct {
		Name      string `json:"name"`
		ShortName string `json:"short_name"`
		StartURL  string `json:"start_url"`
		Display   string `json:"display"`
		Scope     string `json:"scope"`
		Icons     []struct {
			Src     string `json:"src"`
			Sizes   string `json:"sizes"`
			Type    string `json:"type"`
			Purpose string `json:"purpose"`
		} `json:"icons"`
	}
	require.NoError(t, json.Unmarshal(raw, &m))
	require.Equal(t, "Lofoten Crew", m.Name)
	require.Equal(t, "Lofoten Crew", m.ShortName)
	require.Equal(t, "/", m.StartURL)
	require.Equal(t, "standalone", m.Display)
	require.Equal(t, "/icons/pwa-192x192.png", m.Icons[0].Src)
}

func TestEndpointMustBeKnownPushService(t *testing.T) {
	env := newPushEnv(t)
	alice := env.Register("alice")
	for _, ep := range []string{"https://evil.example/x", "https://user@push.example/x", "https://notpush.example/x", "https:///x", "http://push.example/x"} {
		alice.Fail(http.MethodPut, "/api/push/subscription", sub(ep, "all"), http.StatusBadRequest, "VALIDATION_FAILED")
	}
	require.Equal(t, 0, count(t, env, "true"))
	alice.Do(http.MethodPut, "/api/push/subscription", sub("https://eu.PUSH.example:443/x", "all"), http.StatusNoContent, nil)
	require.Equal(t, 1, count(t, env, "true"), "subdomains, any case and a port are fine")
}

func TestDefaultPushHostsAreEnforced(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.Fail(http.MethodPut, "/api/push/subscription", sub("https://push.example/a", "all"), http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Do(http.MethodPut, "/api/push/subscription", sub("https://fcm.googleapis.com/fcm/send/abc", "all"), http.StatusNoContent, nil)
}

func TestSubscriptionsAreCappedPerUser(t *testing.T) {
	env := newPushEnv(t)
	alice := env.Register("alice")
	for i := 0; i < 12; i++ {
		alice.Do(http.MethodPut, "/api/push/subscription", sub(fmt.Sprintf("https://push.example/%d", i), "all"), http.StatusNoContent, nil)
	}
	require.Equal(t, 10, count(t, env, "user_id = $1", alice.User.ID))
	require.Equal(t, 0, count(t, env, "endpoint IN ('https://push.example/0', 'https://push.example/1')"), "the two oldest are gone")
	require.Equal(t, 1, count(t, env, "endpoint = 'https://push.example/11'"))
}
