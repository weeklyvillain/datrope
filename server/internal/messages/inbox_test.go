package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func itemIDs(items []messages.MentionItem) []id.ID {
	out := []id.ID{}
	for _, it := range items {
		out = append(out, it.Message.ID)
	}
	return out
}

func TestMentionsInbox(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	general := alice.General()
	srv := alice.Server()
	hide := func(ch id.ID) {
		alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+srv.ID.String(),
			map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)
	}
	secret := alice.CreateTextChannel("secret")
	hide(secret)

	// Sending marks a channel read for the sender, so bob talks before he is mentioned.
	bob.Send(general, "talking to myself @bob")
	inGeneral := alice.Send(general, "@bob you in?")
	alice.Send(secret, "@bob can't see this")
	thread := startThread(t, alice, general, alice.Send(general, "Saturday plan"))
	inThread := carol.Send(thread.ID, "@bob vote on the start time please")
	inDM := alice.Send(dm(t, alice, bob).ID, "are we still on for Saturday, @bob?")
	alice.Send(dm(t, alice, carol).ID, "@bob is not here")
	alice.Send(general, "no mention of anyone")

	get := func(query string) messages.MentionsPage {
		t.Helper()
		var p messages.MentionsPage
		bob.Do(http.MethodGet, "/api/users/@me/mentions"+query, nil, http.StatusOK, &p)
		return p
	}

	page := get("")
	require.Equal(t, []id.ID{inDM.ID, inThread.ID, inGeneral.ID}, itemIDs(page.Items))
	require.Equal(t, 3, *page.UnreadCount)
	require.True(t, page.Items[0].Unread)
	require.Equal(t, "dm", page.Items[0].Channel.Type)
	require.Equal(t, "thread", page.Items[1].Channel.Type)
	require.Equal(t, "general", page.Items[1].Channel.ParentName)
	require.Nil(t, page.NextCursor)

	// Reading #general up to the mention makes it read.
	bob.Do(http.MethodPost, "/api/channels/"+general.String()+"/ack", map[string]any{"message_id": inGeneral.ID.String()}, http.StatusNoContent, nil)
	page = get("")
	require.Equal(t, 2, *page.UnreadCount)
	require.False(t, page.Items[2].Unread)

	// Pages.
	page = get("?limit=2")
	require.Len(t, page.Items, 2)
	require.NotNil(t, page.NextCursor)
	older := get("?limit=2&before=" + page.NextCursor.String())
	require.Equal(t, []id.ID{inGeneral.ID}, itemIDs(older.Items))
	require.Nil(t, older.UnreadCount)

	// Mark all read: each channel up to its newest mention.
	var acked messages.AckMentionsResult
	bob.Do(http.MethodPost, "/api/users/@me/mentions/ack", nil, http.StatusOK, &acked)
	require.Len(t, acked.ReadStates, 3)
	for _, rs := range acked.ReadStates {
		require.NotNil(t, rs.LastReadID)
	}
	require.Equal(t, 0, *get("").UnreadCount)

	// Losing access to a channel hides its mentions (and its threads').
	hide(general)
	require.Equal(t, []id.ID{inDM.ID}, itemIDs(get("").Items))

	// Others never see bob's inbox.
	var carols messages.MentionsPage
	carol.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &carols)
	require.Empty(t, carols.Items)
}

func TestMentionsInboxHidesDeletedAndKicked(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()

	gone := alice.Send(general, "@bob oops wrong room")
	kept := alice.Send(general, "@bob real one")
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+gone.ID.String(), nil, http.StatusNoContent, nil)

	var p messages.MentionsPage
	bob.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &p)
	require.Equal(t, []id.ID{kept.ID}, itemIDs(p.Items))
	require.Equal(t, 1, *p.UnreadCount)

	// Mark all read acks up to the live mention, not the deleted one.
	var acked messages.AckMentionsResult
	bob.Do(http.MethodPost, "/api/users/@me/mentions/ack", nil, http.StatusOK, &acked)
	require.Len(t, acked.ReadStates, 1)
	require.Equal(t, kept.ID, *acked.ReadStates[0].LastReadID)

	// A kicked member keeps only their DMs.
	inDM := alice.Send(dm(t, alice, bob).ID, "@bob still here?")
	alice.Send(general, "@bob after the kick? no")
	alice.Do(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	bob.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &p)
	require.Equal(t, []id.ID{inDM.ID}, itemIDs(p.Items))
	require.Equal(t, 1, *p.UnreadCount)
	bob.Do(http.MethodPost, "/api/users/@me/mentions/ack", nil, http.StatusOK, &acked)
	require.Len(t, acked.ReadStates, 1)
	require.Equal(t, inDM.ChannelID, acked.ReadStates[0].ChannelID)
}

func TestMentionsAckNeverMovesBackwards(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()

	mention := alice.Send(general, "@bob first")
	newest := alice.Send(general, "plain, but newer")
	bob.Do(http.MethodPost, "/api/channels/"+general.String()+"/ack", map[string]any{"message_id": newest.ID.String()}, http.StatusNoContent, nil)

	var acked messages.AckMentionsResult
	bob.Do(http.MethodPost, "/api/users/@me/mentions/ack", nil, http.StatusOK, &acked)
	require.Len(t, acked.ReadStates, 1)
	require.Equal(t, newest.ID, *acked.ReadStates[0].LastReadID, "read position stays past the mention")

	var p messages.MentionsPage
	bob.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &p)
	require.Equal(t, []id.ID{mention.ID}, itemIDs(p.Items))
	require.False(t, p.Items[0].Unread)
	require.Equal(t, 0, *p.UnreadCount)
}

func TestMentionsInboxHeldAtRulesGate(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "Rules: be nice.", "rules_gate": true}, http.StatusOK, nil)
	dave := env.Register("dave")
	alice.Send(alice.General(), "@dave welcome")
	var p messages.MentionsPage
	dave.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &p)
	require.Empty(t, p.Items)
	require.Equal(t, 0, *p.UnreadCount)
}

func TestMentionsUnreadCountCapped(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	for i := 0; i < 105; i++ {
		alice.Send(general, "@bob ping")
	}
	var p messages.MentionsPage
	bob.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &p)
	require.Equal(t, 100, *p.UnreadCount)
	require.Len(t, p.Items, 25)
}
