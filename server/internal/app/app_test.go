package app_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
)

func TestHealthz(t *testing.T) {
	env := apptest.New(t)
	resp, err := http.Get(env.Server.URL + "/healthz")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.NotEmpty(t, resp.Header.Get("X-Request-ID"))
	var body struct {
		Build string `json:"build"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Equal(t, "dev", body.Build)
}

func TestOpenAPIIsServed(t *testing.T) {
	env := apptest.New(t)
	var doc map[string]any
	env.Anon().Do(http.MethodGet, "/api/openapi.json", nil, http.StatusOK, &doc)
	require.Equal(t, "3.1.0", doc["openapi"])
}

func TestOpenAPIHasEventSchemas(t *testing.T) {
	b, err := json.Marshal(app.New(nil, app.Config{}).API.OpenAPI())
	require.NoError(t, err)
	var doc struct {
		Components struct {
			Schemas map[string]any `json:"schemas"`
		} `json:"components"`
	}
	require.NoError(t, json.Unmarshal(b, &doc))
	for _, name := range []string{"Ready", "ReadyServer", "Hello", "PresenceUpdate", "PublicUser", "Message",
		"MessageDeleted", "TypingStart", "ChannelDeleted", "MemberRemoved", "RoleDeleted", "Server", "VoiceState", "VoiceMove"} {
		_, ok := doc.Components.Schemas[name]
		require.True(t, ok, "missing schema %s", name)
	}
}
