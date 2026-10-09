package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestThreads(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	parent := alice.Send(general, "Saturday: board games at mine?")
	ws, _ := bob.Connect()

	var thread channels.Channel
	alice.Do(http.MethodPost, "/api/channels/"+general.String()+"/messages/"+parent.ID.String()+"/thread",
		map[string]any{}, http.StatusCreated, &thread)
	require.Equal(t, "thread", thread.Type)
	require.Equal(t, "Saturday: board games at mine?", thread.Name)
	var up messages.ThreadUpdate
	ws.ExpectDispatch("THREAD_UPDATE", &up)
	require.Equal(t, parent.ID, up.MessageID)
	require.Equal(t, 0, up.Thread.MessageCount)

	// Starting it again returns the same thread.
	var again channels.Channel
	bob.Do(http.MethodPost, "/api/channels/"+general.String()+"/messages/"+parent.ID.String()+"/thread",
		map[string]any{}, http.StatusOK, &again)
	require.Equal(t, thread.ID, again.ID)

	bob.Send(thread.ID, "I'm in")
	alice.Send(thread.ID, "great")
	ws.ExpectDispatch("THREAD_UPDATE", &up)
	ws.ExpectDispatch("THREAD_UPDATE", &up)
	require.Equal(t, 2, up.Thread.MessageCount)
	require.Len(t, up.Thread.Participants, 2)

	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &page)
	var p messages.Message
	for _, m := range page {
		if m.ID == parent.ID {
			p = m
		}
	}
	require.NotNil(t, p.Thread)
	require.Equal(t, 2, p.Thread.MessageCount)

	// get-channel returns the thread with its parent.
	var got channels.Channel
	bob.Do(http.MethodGet, "/api/channels/"+thread.ID.String(), nil, http.StatusOK, &got)
	require.Equal(t, general, *got.ParentChannelID)
	require.Equal(t, parent.ID, *got.ParentMessageID)

	// Threads are not in the channel list but are in the channel's thread list.
	for _, ch := range bob.Channels() {
		require.NotEqual(t, "thread", ch.Type)
	}
	var list []struct {
		Channel channels.Channel `json:"channel"`
	}
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/threads", nil, http.StatusOK, &list)
	require.Len(t, list, 1)

	// Deleting a message in the thread updates the summary.
	m := alice.Send(thread.ID, "oops")
	ws.ExpectDispatch("THREAD_UPDATE", &up)
	require.Equal(t, 3, up.Thread.MessageCount)
	alice.Do(http.MethodDelete, "/api/channels/"+thread.ID.String()+"/messages/"+m.ID.String(), nil, http.StatusNoContent, nil)
	ws.ExpectDispatch("THREAD_UPDATE", &up)
	require.Equal(t, 2, up.Thread.MessageCount)

	// The parent can be deleted; the thread stays readable.
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+parent.ID.String(), nil, http.StatusNoContent, nil)
	bob.Do(http.MethodGet, "/api/channels/"+thread.ID.String()+"/messages", nil, http.StatusOK, &page)
	require.Len(t, page, 3) // two live messages and the deleted one
}

func TestThreadPermissions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	parent := alice.Send(general, "x")
	var thread channels.Channel
	alice.Do(http.MethodPost, "/api/channels/"+general.String()+"/messages/"+parent.ID.String()+"/thread", map[string]any{"name": "Plans"}, http.StatusCreated, &thread)
	require.Equal(t, "Plans", thread.Name)

	// Hiding the parent from @everyone hides the thread.
	srv := alice.Server()
	alice.Do(http.MethodPut, "/api/channels/"+general.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)
	bob.Fail(http.MethodGet, "/api/channels/"+thread.ID.String()+"/messages", nil, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodGet, "/api/channels/"+thread.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")

	// No threads in threads.
	m := alice.Send(thread.ID, "y")
	alice.Fail(http.MethodPost, "/api/channels/"+thread.ID.String()+"/messages/"+m.ID.String()+"/thread", map[string]any{}, http.StatusBadRequest, "NO_THREADS_HERE")

	// No threads in DMs.
	var dm channels.Channel
	alice.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{bob.User.ID.String()}}, http.StatusOK, &dm)
	dmMsg := alice.Send(dm.ID, "hi")
	alice.Fail(http.MethodPost, "/api/channels/"+dm.ID.String()+"/messages/"+dmMsg.ID.String()+"/thread", map[string]any{}, http.StatusBadRequest, "NO_THREADS_HERE")

	// No threads in the welcome channel.
	for _, ch := range alice.Channels() {
		if ch.Type == channels.TypeWelcome {
			alice.Fail(http.MethodPost, "/api/channels/"+ch.ID.String()+"/messages/"+m.ID.String()+"/thread", map[string]any{}, http.StatusBadRequest, "NO_THREADS_HERE")
		}
	}
}

func TestDeletingParentChannelDeletesThreads(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	ch := alice.CreateTextChannel("plans")
	parent := alice.Send(ch, "Trip?")
	var thread channels.Channel
	alice.Do(http.MethodPost, "/api/channels/"+ch.String()+"/messages/"+parent.ID.String()+"/thread", map[string]any{}, http.StatusCreated, &thread)
	alice.Send(thread.ID, "yes")

	alice.Do(http.MethodDelete, "/api/channels/"+ch.String(), nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodGet, "/api/channels/"+thread.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
	var n int
	require.NoError(t, env.Pool.QueryRow(t.Context(), `SELECT count(*) FROM messages WHERE channel_id = $1`, thread.ID).Scan(&n))
	require.Zero(t, n, "the thread's messages are gone")
}
