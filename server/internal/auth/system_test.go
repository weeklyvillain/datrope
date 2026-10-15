package auth_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
)

func TestSystemUserStaysOutOfTheWay(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	require.True(t, alice.User.IsAdmin, "System must not count as the first user")

	env.Anon().Fail(http.MethodPost, "/api/auth/login",
		map[string]any{"login": "system", "password": "!", "device_name": "t", "client": "native"},
		http.StatusUnauthorized, "INVALID_CREDENTIALS")

	// The username stays free for people, and then logs in as that person.
	sys := env.Register("system")
	require.False(t, sys.User.IsAdmin)
	var res map[string]any
	env.Anon().Do(http.MethodPost, "/api/auth/login",
		map[string]any{"login": "system", "password": "password123", "device_name": "t", "client": "native"}, http.StatusOK, &res)

	// @system mentions the person, not the System account.
	ch := alice.General()
	m := alice.Send(ch, "hi @system")
	require.Equal(t, sys.User.ID, m.Mentions[0])
}
