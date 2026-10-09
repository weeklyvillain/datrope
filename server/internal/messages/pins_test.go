package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/messages"
)

func TestPins(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	first := alice.Send(general, "first")
	second := alice.Send(general, "second")
	ws, _ := bob.Connect()
	pin := func(c *apptest.Client, m messages.Message, method string, want int) {
		c.Do(method, "/api/channels/"+general.String()+"/pins/"+m.ID.String(), nil, want, nil)
	}

	pin(alice, first, http.MethodPut, http.StatusNoContent)
	var ev messages.Message
	ws.ExpectDispatch("MESSAGE_UPDATE", &ev)
	require.True(t, ev.Pinned)
	require.NotNil(t, ev.PinnedAt)
	pin(alice, second, http.MethodPut, http.StatusNoContent)
	pin(alice, first, http.MethodPut, http.StatusNoContent) // already pinned: no change

	var pins []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/pins", nil, http.StatusOK, &pins)
	require.Equal(t, []string{"second", "first"}, []string{pins[0].Content, pins[1].Content})

	bob.Fail(http.MethodPut, "/api/channels/"+general.String()+"/pins/"+first.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
	pin(alice, first, http.MethodDelete, http.StatusNoContent)
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/pins", nil, http.StatusOK, &pins)
	require.Len(t, pins, 1)

	// Deleting a pinned message unpins it.
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+second.ID.String(), nil, http.StatusNoContent, nil)
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/pins", nil, http.StatusOK, &pins)
	require.Empty(t, pins)
}

func TestPinLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	_, err := env.Pool.Exec(t.Context(), `
		INSERT INTO messages (id, channel_id, author_id, content, pinned_at)
		SELECT g, $1, $2, 'p', now() FROM generate_series(1, 50) g`, general, alice.User.ID)
	require.NoError(t, err)
	m := alice.Send(general, "one more")
	alice.Fail(http.MethodPut, "/api/channels/"+general.String()+"/pins/"+m.ID.String(), nil, http.StatusBadRequest, "PIN_LIMIT")
}

func TestPinInDM(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	var dm channels.Channel
	alice.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{bob.User.ID.String()}}, http.StatusOK, &dm)
	m := alice.Send(dm.ID, "keep this")
	bob.Do(http.MethodPut, "/api/channels/"+dm.ID.String()+"/pins/"+m.ID.String(), nil, http.StatusNoContent, nil)
	var pins []messages.Message
	alice.Do(http.MethodGet, "/api/channels/"+dm.ID.String()+"/pins", nil, http.StatusOK, &pins)
	require.Len(t, pins, 1)
	bob.Do(http.MethodDelete, "/api/channels/"+dm.ID.String()+"/pins/"+m.ID.String(), nil, http.StatusNoContent, nil)
}
