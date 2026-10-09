package auth_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
)

func reg(username string) map[string]any {
	return map[string]any{"username": username, "password": "password123", "device_name": "test", "client": "native"}
}

func login(name, password string) map[string]any {
	return map[string]any{"login": name, "password": password, "device_name": "test", "client": "native"}
}

func TestRegisterLoginLogout(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	require.True(t, alice.User.IsAdmin)

	var me auth.User
	alice.Do(http.MethodGet, "/api/users/@me", nil, http.StatusOK, &me)
	require.Equal(t, "alice", me.Username)

	anon := env.Anon()
	anon.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
	anon.Fail(http.MethodPost, "/api/auth/register", reg("ALICE"), http.StatusConflict, "USERNAME_TAKEN")
	anon.Fail(http.MethodPost, "/api/auth/login", login("alice", "wrong"), http.StatusUnauthorized, "INVALID_CREDENTIALS")
	anon.Fail(http.MethodPost, "/api/auth/login", login("ghost", "password123"), http.StatusUnauthorized, "INVALID_CREDENTIALS")

	var res auth.AuthResult
	anon.Do(http.MethodPost, "/api/auth/login", login("alice", "password123"), http.StatusOK, &res)
	require.NotEmpty(t, res.Token)
	second := env.Anon()
	second.Token = res.Token

	var sessions []auth.Session
	second.Do(http.MethodGet, "/api/sessions", nil, http.StatusOK, &sessions)
	require.Len(t, sessions, 2)
	current := 0
	for _, s := range sessions {
		if s.Current {
			current++
		}
	}
	require.Equal(t, 1, current)

	second.Do(http.MethodPost, "/api/auth/logout", nil, http.StatusNoContent, nil)
	second.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
	alice.Do(http.MethodGet, "/api/users/@me", nil, http.StatusOK, nil) // other sessions survive
}

func TestRevokeOtherSession(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var res auth.AuthResult
	env.Anon().Do(http.MethodPost, "/api/auth/login", login("alice", "password123"), http.StatusOK, &res)

	var sessions []auth.Session
	alice.Do(http.MethodGet, "/api/sessions", nil, http.StatusOK, &sessions)
	var other string
	for _, s := range sessions {
		if !s.Current {
			other = s.ID.String()
		}
	}
	alice.Do(http.MethodDelete, "/api/sessions/"+other, nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodDelete, "/api/sessions/"+other, nil, http.StatusNotFound, "NOT_FOUND")

	revoked := env.Anon()
	revoked.Token = res.Token
	revoked.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
}

func TestValidation(t *testing.T) {
	env := apptest.New(t)
	bad := reg("alice")
	bad["password"] = "short"
	env.Anon().Fail(http.MethodPost, "/api/auth/register", bad, http.StatusBadRequest, "VALIDATION_FAILED")
	env.Anon().Fail(http.MethodPost, "/api/auth/register", reg("no spaces"), http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestUpdateMe(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var me auth.User
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"display_name": "Alice A."}, http.StatusOK, &me)
	require.Equal(t, "Alice A.", me.DisplayName)
}

func TestWebCookieAndCSRF(t *testing.T) {
	env := apptest.New(t)
	env.Register("alice")

	var res auth.AuthResult
	resp := env.Anon().Do(http.MethodPost, "/api/auth/login",
		map[string]any{"login": "alice", "password": "password123", "device_name": "browser", "client": "web"},
		http.StatusOK, &res)
	require.Empty(t, res.Token, "web clients get a cookie, not a token")
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == auth.CookieName {
			cookie = c
		}
	}
	require.NotNil(t, cookie)
	require.True(t, cookie.HttpOnly)
	require.True(t, cookie.Secure)
	require.Equal(t, http.SameSiteLaxMode, cookie.SameSite)

	web := env.Anon()
	web.Header.Set("Cookie", auth.CookieName+"="+cookie.Value)
	web.Do(http.MethodGet, "/api/users/@me", nil, http.StatusOK, nil)
	web.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"display_name": "Al"}, http.StatusForbidden, "CSRF_FAILED")
	web.Header.Set(auth.CSRFHeader, "1")
	web.Do(http.MethodPatch, "/api/users/@me", map[string]any{"display_name": "Al"}, http.StatusOK, nil)
}

func TestRegistrationModes(t *testing.T) {
	env := apptest.New(t)
	env.SetRegistrationMode(auth.ModeAdminOnly)
	first := env.Register("admin") // the first user can always register
	require.True(t, first.User.IsAdmin)

	env.Anon().Fail(http.MethodPost, "/api/auth/register", reg("bob"), http.StatusForbidden, "REGISTRATION_CLOSED")
	env.SetRegistrationMode(auth.ModeInviteOnly)
	env.Anon().Fail(http.MethodPost, "/api/auth/register", reg("bob"), http.StatusForbidden, "INVITE_REQUIRED")
	// Registering with an invite is tested in the communities package.

	var info auth.InstanceInfo
	env.Anon().Do(http.MethodGet, "/api/instance", nil, http.StatusOK, &info)
	require.Equal(t, auth.ModeInviteOnly, info.RegistrationMode)
	require.True(t, info.HasUsers)
}

func TestLoginRateLimit(t *testing.T) {
	env := apptest.New(t)
	env.Register("alice")
	for i := 0; i < 5; i++ {
		env.Anon().Fail(http.MethodPost, "/api/auth/login", login("alice", "wrong"), http.StatusUnauthorized, "INVALID_CREDENTIALS")
	}
	env.Anon().Fail(http.MethodPost, "/api/auth/login", login("alice", "password123"), http.StatusTooManyRequests, "RATE_LIMITED")
}

func TestCustomStatus(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var me auth.User
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"custom_status": "  Playing Factorio  "}, http.StatusOK, &me)
	require.Equal(t, "Playing Factorio", me.CustomStatus)
	require.Equal(t, "alice", me.DisplayName, "display name unchanged when omitted")
	var ev auth.PublicUser
	ws.ExpectDispatch("USER_UPDATE", &ev)
	require.Equal(t, "Playing Factorio", ev.CustomStatus)

	long := strings.Repeat("x", 81)
	alice.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"custom_status": long}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"display_name": "   "}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"custom_status": ""}, http.StatusOK, &me)
	require.Equal(t, "", me.CustomStatus)
}
