package messages_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

// insertReminder stores a fired reminder row, as the scheduler would have claimed it.
func insertReminder(t *testing.T, env *apptest.Env, r messages.DueReminder) {
	t.Helper()
	_, err := env.Pool.Exec(context.Background(),
		`INSERT INTO reminders (id, user_id, due_at, note, channel_id, message_id, fired_at) VALUES ($1, $2, now(), $3, $4, $5, now())`,
		r.ID, r.UserID, r.Note, r.ChannelID, r.MessageID)
	require.NoError(t, err)
}

func TestPostReminderQuotesLive(t *testing.T) {
	env, alice, bob, sid, _ := setup(t)
	ctx := context.Background()
	team := alice.CreateTextChannel("team")
	target := alice.Send(team, "review the release notes")

	r := messages.DueReminder{ID: id.New(), UserID: bob.User.ID, Note: "notes!", ChannelID: &team, MessageID: &target.ID}
	insertReminder(t, env, r)
	m, err := env.App.Messages.PostReminder(ctx, r)
	require.NoError(t, err)
	require.Equal(t, messages.KindReminder, m.Kind)
	require.Equal(t, auth.SystemUserID, m.Author.ID)
	require.True(t, m.Author.System)
	require.Equal(t, "Reminder: notes!", m.Content)
	require.Equal(t, "notes!", m.Reminder.Note)
	require.Equal(t, &messages.ReminderTarget{ChannelID: team, MessageID: target.ID}, m.Reminder.Target)
	require.Equal(t, "alice", m.Reminder.Quote.AuthorName)
	require.Equal(t, "team", m.Reminder.Quote.ChannelName)
	require.Equal(t, "review the release notes", m.Reminder.Quote.Excerpt)

	path := "/api/channels/" + m.ChannelID.String() + "/messages"
	// Bob loses access after it fired: the quote goes away, nothing leaks.
	alice.Do(http.MethodPut, "/api/channels/"+team.String()+"/overrides/role/"+sid.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	var page []messages.Message
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.True(t, page[0].Reminder.Unavailable)
	require.Nil(t, page[0].Reminder.Quote)
	require.Nil(t, page[0].Reminder.Target)

	// Nobody can reply to System.
	bob.Fail(http.MethodPost, path, map[string]any{"content": "thanks"}, http.StatusForbidden, "SYSTEM_DM")
}

func TestReminderQuoteGoneWhenDeleted(t *testing.T) {
	env, alice, _, _, general := setup(t)
	ctx := context.Background()
	target := alice.Send(general, "temporary")
	r := messages.DueReminder{ID: id.New(), UserID: alice.User.ID, ChannelID: &general, MessageID: &target.ID}
	insertReminder(t, env, r)
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+target.ID.String(), nil, http.StatusNoContent, nil)
	m, err := env.App.Messages.PostReminder(ctx, r)
	require.NoError(t, err)
	require.Equal(t, "Reminder", m.Content)
	require.True(t, m.Reminder.Unavailable)

	free := messages.DueReminder{ID: id.New(), UserID: alice.User.ID, Note: "stretch"}
	insertReminder(t, env, free)
	m, err = env.App.Messages.PostReminder(ctx, free)
	require.NoError(t, err)
	require.False(t, m.Reminder.Unavailable)
	require.Nil(t, m.Reminder.Target)
}
