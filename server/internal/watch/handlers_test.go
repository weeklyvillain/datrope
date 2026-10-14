package watch_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/watch"
)

func TestWatchHTTP(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var lounge channels.Channel
	alice.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": "Lounge", "type": "voice"}, http.StatusCreated, &lounge)
	base := "/api/channels/" + lounge.ID.String() + "/watch"

	var u watch.WatchUpdate
	alice.Do(http.MethodGet, base, nil, http.StatusOK, &u)
	require.Equal(t, lounge.ID, u.ChannelID)
	require.Nil(t, u.State)
	require.NotZero(t, u.ServerNow)

	// Controls need the caller in the call; alice only looks at the channel.
	alice.Fail(http.MethodPost, base, map[string]any{"url": "https://youtu.be/dQw4w9WgXcQ"}, http.StatusForbidden, "NOT_IN_VOICE")
	alice.Fail(http.MethodPost, base+"/pause", nil, http.StatusForbidden, "NOT_IN_VOICE")
	alice.Fail(http.MethodPost, base+"/seek", map[string]any{"position": 3}, http.StatusForbidden, "NOT_IN_VOICE")
	alice.Fail(http.MethodDelete, base, nil, http.StatusForbidden, "NOT_IN_VOICE")

	alice.Fail(http.MethodGet, "/api/channels/"+alice.General().String()+"/watch", nil, http.StatusBadRequest, "NOT_VOICE_CHANNEL")
}
