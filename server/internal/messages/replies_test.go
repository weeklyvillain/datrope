package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
)

func TestReplies(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	orig := alice.Send(general, "first line\nsecond line")

	var reply messages.Message
	bob.Do(http.MethodPost, "/api/channels/"+general.String()+"/messages",
		map[string]any{"content": "agreed", "reply_to_id": orig.ID.String()}, http.StatusCreated, &reply)
	require.NotNil(t, reply.ReplyTo)
	require.Equal(t, orig.ID, reply.ReplyTo.ID)
	require.Equal(t, "alice", reply.ReplyTo.Author.Username)
	require.Equal(t, "first line\nsecond line", reply.ReplyTo.Content)

	// The reference survives in history and shows deletion.
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+orig.ID.String(), nil, http.StatusNoContent, nil)
	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &page)
	require.True(t, page[0].ReplyTo.Deleted)
	require.Empty(t, page[0].ReplyTo.Content)

	// Only live messages in the same channel.
	other := alice.CreateTextChannel("other")
	elsewhere := alice.Send(other, "x")
	bob.Fail(http.MethodPost, "/api/channels/"+general.String()+"/messages",
		map[string]any{"content": "nope", "reply_to_id": elsewhere.ID.String()}, http.StatusBadRequest, "REPLY_NOT_FOUND")
	bob.Fail(http.MethodPost, "/api/channels/"+general.String()+"/messages",
		map[string]any{"content": "nope", "reply_to_id": orig.ID.String()}, http.StatusBadRequest, "REPLY_NOT_FOUND")
}

func TestMentions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	m := alice.Send(general, "hey @BOB and @nobody, also @alice")
	require.Equal(t, []id.ID{bob.User.ID, alice.User.ID}, m.Mentions)

	var edited messages.Message
	alice.Do(http.MethodPatch, "/api/channels/"+general.String()+"/messages/"+m.ID.String(),
		map[string]any{"content": "never mind"}, http.StatusOK, &edited)
	require.NotNil(t, edited.Mentions, "mentions is [] not null")
	require.Empty(t, edited.Mentions)
}
