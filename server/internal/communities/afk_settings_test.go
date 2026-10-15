package communities_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
)

func TestAFKSettings(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var voice channels.Channel
	alice.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": "AFK", "type": "voice"}, http.StatusCreated, &voice)

	var sv communities.Server
	alice.Do(http.MethodGet, "/api/server", nil, http.StatusOK, &sv)
	require.Nil(t, sv.AFKChannelID)
	require.Equal(t, 900, sv.AFKTimeoutSeconds)

	alice.Do(http.MethodPatch, "/api/server", map[string]any{"afk_channel_id": voice.ID.String(), "afk_timeout_seconds": 300}, http.StatusOK, &sv)
	require.Equal(t, voice.ID, *sv.AFKChannelID)
	require.Equal(t, 300, sv.AFKTimeoutSeconds)

	alice.Do(http.MethodPatch, "/api/server", map[string]any{"afk_timeout_seconds": 1800}, http.StatusOK, &sv)
	require.Equal(t, voice.ID, *sv.AFKChannelID, "a PATCH without afk_channel_id keeps it")
	require.Equal(t, 1800, sv.AFKTimeoutSeconds)

	alice.Fail(http.MethodPatch, "/api/server", map[string]any{"afk_channel_id": alice.General().String()}, http.StatusBadRequest, "NOT_VOICE_CHANNEL")
	alice.Fail(http.MethodPatch, "/api/server", map[string]any{"afk_timeout_seconds": 60}, http.StatusBadRequest, "VALIDATION_FAILED")

	var cleared communities.Server // a fresh value: decoding into sv would keep the old pointer when the field is omitted
	alice.Do(http.MethodPatch, "/api/server", map[string]any{"afk_channel_id": ""}, http.StatusOK, &cleared)
	require.Nil(t, cleared.AFKChannelID)
	require.Equal(t, 1800, cleared.AFKTimeoutSeconds, "clearing the channel keeps the timeout")

	bob := env.Register("bob")
	bob.Join(alice.Invite())
	bob.Fail(http.MethodPatch, "/api/server", map[string]any{"afk_timeout_seconds": 300}, http.StatusForbidden, "MISSING_PERMISSION")
}
