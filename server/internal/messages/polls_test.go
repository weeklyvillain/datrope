package messages_test

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

// samplePoll is a valid single-answer poll; extra overrides its fields.
func samplePoll(extra map[string]any) map[string]any {
	p := map[string]any{
		"question": "Pizza or tacos?",
		"options":  []map[string]any{{"text": "Pizza", "emoji": "🍕"}, {"text": "Tacos"}},
	}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func pollOptions(texts ...string) []map[string]any {
	out := make([]map[string]any, len(texts))
	for i, s := range texts {
		out[i] = map[string]any{"text": s}
	}
	return out
}

func numberedOptions(n int) []map[string]any {
	texts := make([]string, n)
	for i := range texts {
		texts[i] = strconv.Itoa(i + 1)
	}
	return pollOptions(texts...)
}

func sendPoll(t *testing.T, c *apptest.Client, chID id.ID, poll map[string]any) messages.Message {
	t.Helper()
	var m messages.Message
	c.Do(http.MethodPost, "/api/channels/"+chID.String()+"/messages", map[string]any{"poll": poll}, http.StatusCreated, &m)
	return m
}

func TestPollCreateAndRead(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	ws, _ := bob.Connect()

	m := sendPoll(t, alice, ch, samplePoll(nil))
	require.Empty(t, m.Content, "a poll needs no text")
	require.NotNil(t, m.Poll)
	require.Equal(t, "Pizza or tacos?", m.Poll.Question)
	require.False(t, m.Poll.Multi)
	require.False(t, m.Poll.Anonymous)
	require.Nil(t, m.Poll.EndsAt, "no duration: the poll runs until ended")
	require.False(t, m.Poll.Ended)
	require.Equal(t, []messages.PollOption{{Text: "Pizza", Emoji: "🍕"}, {Text: "Tacos"}}, m.Poll.Options)
	require.Zero(t, m.Poll.TotalVoters)
	require.Empty(t, m.Poll.MyVotes)

	var created messages.Message
	ws.ExpectDispatch("MESSAGE_CREATE", &created)
	require.Equal(t, m.ID, created.ID)
	require.Equal(t, "Pizza or tacos?", created.Poll.Question)

	// Text goes along with a poll; question and answers are trimmed; a duration sets ends_at.
	var timed messages.Message
	alice.Do(http.MethodPost, "/api/channels/"+ch.String()+"/messages", map[string]any{"content": "vote!", "poll": samplePoll(map[string]any{
		"question": "  Movie night?  ", "options": pollOptions(" Friday ", "Saturday"), "multi": true, "anonymous": true, "duration": "24h",
	})}, http.StatusCreated, &timed)
	require.Equal(t, "vote!", timed.Content)
	require.Equal(t, "Movie night?", timed.Poll.Question)
	require.Equal(t, "Friday", timed.Poll.Options[0].Text)
	require.True(t, timed.Poll.Multi)
	require.True(t, timed.Poll.Anonymous)
	require.NotNil(t, timed.Poll.EndsAt)
	require.WithinDuration(t, timed.CreatedAt.Add(24*time.Hour), *timed.Poll.EndsAt, time.Second)

	// Reads carry the poll with its counts (votes are written directly here; Task 2 adds the endpoint).
	_, err := env.Pool.Exec(context.Background(), `INSERT INTO poll_votes (message_id, position, user_id) VALUES ($1, 1, $2)`, m.ID, bob.User.ID)
	require.NoError(t, err)
	var page []messages.Message
	alice.Do(http.MethodGet, "/api/channels/"+ch.String()+"/messages", nil, http.StatusOK, &page)
	require.Equal(t, "Movie night?", page[0].Poll.Question)
	require.Equal(t, "Pizza or tacos?", page[1].Poll.Question)
	require.Equal(t, 0, page[1].Poll.Options[0].Count)
	require.Equal(t, 1, page[1].Poll.Options[1].Count)
	require.Equal(t, 1, page[1].Poll.TotalVoters)
	require.Empty(t, page[1].Poll.MyVotes, "alice did not vote")

	require.Nil(t, alice.Send(ch, "no poll here").Poll)
}

func TestPollValidation(t *testing.T) {
	_, alice, bob, serverID, ch := setup(t)
	path := "/api/channels/" + ch.String() + "/messages"
	for _, c := range []struct {
		poll map[string]any
		code string
	}{
		{samplePoll(map[string]any{"question": ""}), "VALIDATION_FAILED"},
		{samplePoll(map[string]any{"question": "   "}), "VALIDATION_FAILED"},
		{samplePoll(map[string]any{"question": strings.Repeat("a", 301)}), "VALIDATION_FAILED"},
		{samplePoll(map[string]any{"options": pollOptions("Only one")}), "VALIDATION_FAILED"},
		{samplePoll(map[string]any{"options": numberedOptions(11)}), "VALIDATION_FAILED"},
		{samplePoll(map[string]any{"options": pollOptions("A", strings.Repeat("b", 56))}), "VALIDATION_FAILED"},
		{samplePoll(map[string]any{"options": pollOptions("A", "   ")}), "VALIDATION_FAILED"},
		{samplePoll(map[string]any{"duration": "2h"}), "VALIDATION_FAILED"},
		{samplePoll(map[string]any{"options": []map[string]any{{"text": "A", "emoji": "lol"}, {"text": "B"}}}), "INVALID_EMOJI"},
		{samplePoll(map[string]any{"options": []map[string]any{{"text": "A", "emoji": "custom:123"}, {"text": "B"}}}), "INVALID_EMOJI"},
	} {
		alice.Fail(http.MethodPost, path, map[string]any{"poll": c.poll}, http.StatusBadRequest, c.code)
	}
	alice.Fail(http.MethodPost, path, map[string]any{}, http.StatusBadRequest, "EMPTY_MESSAGE")

	// Limits count characters, not bytes; 10 answers and every listed duration are fine.
	sendPoll(t, alice, ch, samplePoll(map[string]any{
		"question": strings.Repeat("é", 300), "options": pollOptions("A", strings.Repeat("é", 55)), "duration": "1w",
	}))
	sendPoll(t, alice, ch, samplePoll(map[string]any{"options": numberedOptions(10), "duration": "1h"}))

	// A poll is a message: it needs SEND_MESSAGES.
	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+serverID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.SendMessages)}, http.StatusOK, nil)
	bob.Fail(http.MethodPost, path, map[string]any{"poll": samplePoll(nil)}, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestPollCannotBeEditedAndGoesWithItsMessage(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	m := sendPoll(t, alice, ch, samplePoll(nil))
	path := "/api/channels/" + ch.String() + "/messages/" + m.ID.String()

	alice.Fail(http.MethodPatch, path, map[string]any{"content": "changed"}, http.StatusConflict, "POLL_NOT_EDITABLE")
	bob.Fail(http.MethodPatch, path, map[string]any{"content": "changed"}, http.StatusForbidden, "MISSING_PERMISSION")

	ctx := context.Background()
	_, err := env.Pool.Exec(ctx, `INSERT INTO poll_votes (message_id, position, user_id) VALUES ($1, 0, $2)`, m.ID, bob.User.ID)
	require.NoError(t, err)

	// Messages are soft-deleted, so the poll is removed explicitly, votes and all.
	alice.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil)
	for _, table := range []string{"polls", "poll_options", "poll_votes"} {
		var n int
		require.NoError(t, env.Pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE message_id = $1`, m.ID).Scan(&n))
		require.Zero(t, n, table)
	}
	var page []messages.Message
	alice.Do(http.MethodGet, "/api/channels/"+ch.String()+"/messages", nil, http.StatusOK, &page)
	require.True(t, page[0].Deleted)
	require.Nil(t, page[0].Poll)
}
