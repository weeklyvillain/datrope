package channels_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
)

func TestNotifySettings(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	path := "/api/channels/" + general.String() + "/notify"

	ws, ready := bob.Connect()
	defer ws.Close()
	require.Empty(t, ready.Notify)

	var got channels.NotifySetting
	bob.Do(http.MethodPut, path, map[string]any{"level": "all", "muted": true}, http.StatusOK, &got)
	require.Equal(t, channels.NotifySetting{ChannelID: general, Level: "all", Muted: true}, got)
	var ev channels.NotifySetting
	ws.ExpectDispatch("CHANNEL_NOTIFY_UPDATE", &ev)
	require.Equal(t, got, ev, "bob's other devices follow")

	ws2, ready := bob.Connect()
	ws2.Close()
	require.Equal(t, []channels.NotifySetting{got}, ready.Notify)
	_, ready = alice.Connect()
	require.Empty(t, ready.Notify, "settings are per user")

	bob.Do(http.MethodPut, path, map[string]any{"level": "default", "muted": false}, http.StatusOK, nil)
	_, ready = bob.Connect()
	require.Empty(t, ready.Notify, "back at the default, nothing is stored")

	bob.Fail(http.MethodPut, path, map[string]any{"level": "loud"}, http.StatusBadRequest, "VALIDATION_FAILED")
	root := alice.Send(general, "start")
	thread := alice.CreateThread(general, root.ID, "plans")
	bob.Fail(http.MethodPut, "/api/channels/"+thread.String()+"/notify", map[string]any{"level": "all"}, http.StatusBadRequest, "NOTIFY_THREAD")

	staff := alice.CreatePrivateChannel("staff")
	bob.Fail(http.MethodPut, "/api/channels/"+staff.String()+"/notify", map[string]any{"level": "all"}, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodPut, "/api/channels/"+id.ID(1).String()+"/notify", map[string]any{"level": "all"}, http.StatusNotFound, "NOT_FOUND")
}
