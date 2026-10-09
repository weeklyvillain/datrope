package auth_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
)

func TestAdminOnly(t *testing.T) {
	env := apptest.New(t)
	env.Register("admin")
	bob := env.Register("bob")
	bob.Fail(http.MethodGet, "/api/admin/settings", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodGet, "/api/admin/users", nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestAdminSettings(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	var set auth.Settings
	admin.Do(http.MethodPatch, "/api/admin/settings",
		map[string]any{"registration_mode": "admin_only"}, http.StatusOK, &set)
	require.Equal(t, auth.Settings{RegistrationMode: auth.ModeAdminOnly, MaxUploadBytes: 52428800}, set)

	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"max_upload_bytes": 2097152}, http.StatusOK, &set)
	require.Equal(t, auth.ModeAdminOnly, set.RegistrationMode, "omitted fields are unchanged")
	require.Equal(t, int64(2097152), set.MaxUploadBytes)
}

func TestAdminCreatesUserAndResetsPassword(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	env.SetRegistrationMode(auth.ModeAdminOnly)

	var u auth.User
	admin.Do(http.MethodPost, "/api/admin/users",
		map[string]any{"username": "carol", "password": "initial-pass"}, http.StatusCreated, &u)
	require.Equal(t, "carol", u.DisplayName)

	var res auth.AuthResult
	env.Anon().Do(http.MethodPost, "/api/auth/login", login("carol", "initial-pass"), http.StatusOK, &res)
	carol := env.Anon()
	carol.Token = res.Token
	carol.Do(http.MethodGet, "/api/server", nil, http.StatusOK, nil) // admin-created accounts are members

	admin.Do(http.MethodPut, "/api/admin/users/"+u.ID.String()+"/password",
		map[string]any{"password": "new-password"}, http.StatusNoContent, nil)
	carol.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
	env.Anon().Do(http.MethodPost, "/api/auth/login", login("carol", "new-password"), http.StatusOK, nil)

	var users []auth.User
	admin.Do(http.MethodGet, "/api/admin/users", nil, http.StatusOK, &users)
	require.Len(t, users, 2)
}

func TestAdminDisablesUser(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	bob := env.Register("bob")

	var u auth.User
	admin.Do(http.MethodPut, "/api/admin/users/"+bob.User.ID.String()+"/disabled",
		map[string]any{"disabled": true}, http.StatusOK, &u)
	require.True(t, u.Disabled)
	bob.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
	env.Anon().Fail(http.MethodPost, "/api/auth/login", login("bob", "password123"), http.StatusForbidden, "ACCOUNT_DISABLED")

	admin.Do(http.MethodPut, "/api/admin/users/"+bob.User.ID.String()+"/disabled",
		map[string]any{"disabled": false}, http.StatusOK, &u)
	env.Anon().Do(http.MethodPost, "/api/auth/login", login("bob", "password123"), http.StatusOK, nil)

	admin.Fail(http.MethodPut, "/api/admin/users/"+admin.User.ID.String()+"/disabled",
		map[string]any{"disabled": true}, http.StatusBadRequest, "CANNOT_DISABLE_SELF")
}

func TestUploadLimitSetting(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")

	var info auth.InstanceInfo
	env.Anon().Do(http.MethodGet, "/api/instance", nil, http.StatusOK, &info)
	require.Equal(t, int64(52428800), info.MaxUploadBytes, "50 MB by default")

	var set auth.Settings
	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"max_upload_bytes": 10485760}, http.StatusOK, &set)
	require.Equal(t, int64(10485760), set.MaxUploadBytes)
	require.Equal(t, auth.ModeOpen, set.RegistrationMode, "omitted settings are unchanged")

	env.Anon().Do(http.MethodGet, "/api/instance", nil, http.StatusOK, &info)
	require.Equal(t, int64(10485760), info.MaxUploadBytes)

	admin.Fail(http.MethodPatch, "/api/admin/settings", map[string]any{"max_upload_bytes": 1000}, http.StatusBadRequest, "VALIDATION_FAILED")
}
