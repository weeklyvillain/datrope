package messages_test

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func reactPath(chID, msgID id.ID, emoji string) string {
	return "/api/channels/" + chID.String() + "/messages/" + msgID.String() + "/reactions/" + url.PathEscape(emoji)
}

func TestReactions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	m := alice.Send(general, "react to me")
	ws, _ := alice.Connect()

	bob.Do(http.MethodPut, reactPath(general, m.ID, "👍"), nil, http.StatusNoContent, nil)
	var ev messages.ReactionEvent
	ws.ExpectDispatch("MESSAGE_REACTION_ADD", &ev)
	require.Equal(t, "👍", ev.Emoji)
	require.Equal(t, bob.User.ID, ev.UserID)

	alice.Do(http.MethodPut, reactPath(general, m.ID, "👍"), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, reactPath(general, m.ID, "👍"), nil, http.StatusNoContent, nil) // idempotent
	ws.ExpectDispatch("MESSAGE_REACTION_ADD", nil)
	ws.ExpectNoDispatch("MESSAGE_REACTION_ADD", 200*time.Millisecond) // the repeat changed nothing

	var page []messages.Message
	alice.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &page)
	require.Len(t, page[0].Reactions, 1)
	require.Equal(t, "👍", page[0].Reactions[0].Emoji)
	require.Equal(t, 2, page[0].Reactions[0].Count)
	require.Equal(t, []id.ID{bob.User.ID, alice.User.ID}, page[0].Reactions[0].UserIDs)

	bob.Do(http.MethodDelete, reactPath(general, m.ID, "👍"), nil, http.StatusNoContent, nil)
	ws.ExpectDispatch("MESSAGE_REACTION_REMOVE", &ev)
	require.Equal(t, bob.User.ID, ev.UserID)
	bob.Do(http.MethodDelete, reactPath(general, m.ID, "👍"), nil, http.StatusNoContent, nil) // already gone

	bob.Fail(http.MethodPut, reactPath(general, m.ID, "lol"), nil, http.StatusBadRequest, "INVALID_EMOJI")
	bob.Fail(http.MethodPut, reactPath(general, m.ID, "custom:123"), nil, http.StatusBadRequest, "INVALID_EMOJI")

	// Deleting the message drops its reactions.
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+m.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &page)
	require.Empty(t, page[0].Reactions)
}

func TestReactionPermissionsAndLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	m := alice.Send(general, "x")
	alice.Do(http.MethodPut, reactPath(general, m.ID, "🎉"), nil, http.StatusNoContent, nil)

	// Without ADD_REACTIONS you can join an existing reaction but not start one.
	srv := alice.Server()
	alice.Do(http.MethodPatch, "/api/server/roles/"+srv.ID.String(),
		map[string]any{"permissions": perms.Default &^ perms.AddReactions}, http.StatusOK, nil)
	bob.Do(http.MethodPut, reactPath(general, m.ID, "🎉"), nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodPut, reactPath(general, m.ID, "🥳"), nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestReactionRateLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	m := alice.Send(general, "x")
	emoji := []string{"😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊"}
	for _, e := range emoji {
		alice.Do(http.MethodPut, reactPath(general, m.ID, e), nil, http.StatusNoContent, nil)
	}
	alice.Fail(http.MethodPut, reactPath(general, m.ID, "😋"), nil, http.StatusTooManyRequests, "RATE_LIMITED")
}
