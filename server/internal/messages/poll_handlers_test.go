package messages_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func pollURL(chID, msgID id.ID, rest string) string {
	return "/api/channels/" + chID.String() + "/messages/" + msgID.String() + "/poll/" + rest
}

func vote(t *testing.T, c *apptest.Client, chID, msgID id.ID, positions ...int) messages.Poll {
	t.Helper()
	if positions == nil {
		positions = []int{}
	}
	var p messages.Poll
	c.Do(http.MethodPut, pollURL(chID, msgID, "vote"), map[string]any{"positions": positions}, http.StatusOK, &p)
	return p
}

func optionCounts(p messages.Poll) []int {
	out := make([]int, len(p.Options))
	for i, o := range p.Options {
		out[i] = o.Count
	}
	return out
}

func voterNames(us []auth.PublicUser) []string {
	out := make([]string, len(us))
	for i, u := range us {
		out[i] = u.Username
	}
	return out
}

func TestPollVoting(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	m := sendPoll(t, alice, ch, samplePoll(nil))
	ws, _ := alice.Connect()

	p := vote(t, bob, ch, m.ID, 0)
	require.Equal(t, []int{0}, p.MyVotes)
	require.Equal(t, []int{1, 0}, optionCounts(p))
	require.Equal(t, 1, p.TotalVoters)
	var up messages.PollUpdate
	ws.ExpectDispatch("POLL_UPDATE", &up)
	require.Equal(t, messages.PollUpdate{ChannelID: ch, MessageID: m.ID,
		Options: []messages.PollOptionCount{{Count: 1}, {Count: 0}}, TotalVoters: 1}, up)

	// A new vote replaces the old one.
	p = vote(t, bob, ch, m.ID, 1)
	require.Equal(t, []int{1}, p.MyVotes)
	require.Equal(t, []int{0, 1}, optionCounts(p))

	// A single-answer poll takes at most one position, and only real ones.
	for _, bad := range [][]int{{0, 1}, {2}, {-1}} {
		bob.Fail(http.MethodPut, pollURL(ch, m.ID, "vote"), map[string]any{"positions": bad}, http.StatusBadRequest, "INVALID_VOTE")
	}

	p = vote(t, alice, ch, m.ID, 1)
	require.Equal(t, []int{0, 2}, optionCounts(p))
	require.Equal(t, 2, p.TotalVoters)

	// An empty list removes the vote.
	p = vote(t, bob, ch, m.ID)
	require.Empty(t, p.MyVotes)
	require.Equal(t, []int{0, 1}, optionCounts(p))
	require.Equal(t, 1, p.TotalVoters)

	// Reading the channel gives each user their own votes only.
	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+ch.String()+"/messages", nil, http.StatusOK, &page)
	require.Empty(t, page[0].Poll.MyVotes)
	alice.Do(http.MethodGet, "/api/channels/"+ch.String()+"/messages", nil, http.StatusOK, &page)
	require.Equal(t, []int{1}, page[0].Poll.MyVotes)
	require.Equal(t, []int{0, 1}, optionCounts(*page[0].Poll))

	// Multiple answers: positions come back sorted, a voter counts once, duplicates are refused.
	multi := sendPoll(t, alice, ch, samplePoll(map[string]any{"multi": true, "options": pollOptions("A", "B", "C")}))
	p = vote(t, bob, ch, multi.ID, 2, 0)
	require.Equal(t, []int{0, 2}, p.MyVotes)
	require.Equal(t, []int{1, 0, 1}, optionCounts(p))
	require.Equal(t, 1, p.TotalVoters)
	bob.Fail(http.MethodPut, pollURL(ch, multi.ID, "vote"), map[string]any{"positions": []int{1, 1}}, http.StatusBadRequest, "INVALID_VOTE")
	p = vote(t, alice, ch, multi.ID, 0)
	require.Equal(t, []int{2, 0, 1}, optionCounts(p))
	require.Equal(t, 2, p.TotalVoters)

	// Only polls take votes; deleted messages and outsiders get 404.
	plain := alice.Send(ch, "not a poll")
	bob.Fail(http.MethodPut, pollURL(ch, plain.ID, "vote"), map[string]any{"positions": []int{0}}, http.StatusNotFound, "NOT_FOUND")
	env.Outsider("eve").Fail(http.MethodPut, pollURL(ch, m.ID, "vote"), map[string]any{"positions": []int{0}}, http.StatusNotFound, "NOT_FOUND")
	alice.Do(http.MethodDelete, "/api/channels/"+ch.String()+"/messages/"+multi.ID.String(), nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodPut, pollURL(ch, multi.ID, "vote"), map[string]any{"positions": []int{0}}, http.StatusNotFound, "NOT_FOUND")
}

func TestPollEnding(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	carol, dave := env.Register("carol"), env.Register("dave")
	var mod struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Moderator", "permissions": uint64(perms.ManageMessages)}, http.StatusCreated, &mod)
	alice.Do(http.MethodPut, "/api/server/members/"+dave.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusNoContent, nil)

	m := sendPoll(t, bob, ch, samplePoll(nil))
	ws, _ := carol.Connect()
	vote(t, carol, ch, m.ID, 1)
	var up messages.PollUpdate
	ws.ExpectDispatch("POLL_UPDATE", &up) // the vote's own event, so the next one is the end's

	// The author ends it; others without MANAGE_MESSAGES cannot.
	carol.Fail(http.MethodPost, pollURL(ch, m.ID, "end"), nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodPost, pollURL(ch, m.ID, "end"), nil, http.StatusNoContent, nil)
	ws.ExpectDispatch("POLL_UPDATE", &up)
	require.True(t, up.Ended)
	require.Equal(t, []messages.PollOptionCount{{Count: 0}, {Count: 1}}, up.Options, "the final counts")
	carol.Fail(http.MethodPut, pollURL(ch, m.ID, "vote"), map[string]any{"positions": []int{0}}, http.StatusConflict, "POLL_ENDED")
	bob.Fail(http.MethodPost, pollURL(ch, m.ID, "end"), nil, http.StatusConflict, "POLL_ENDED")
	var page []messages.Message
	carol.Do(http.MethodGet, "/api/channels/"+ch.String()+"/messages", nil, http.StatusOK, &page)
	require.True(t, page[0].Poll.Ended)
	require.Equal(t, []int{1}, page[0].Poll.MyVotes, "votes stay after the end")

	// A moderator can end anyone's poll.
	other := sendPoll(t, bob, ch, samplePoll(nil))
	dave.Do(http.MethodPost, pollURL(ch, other.ID, "end"), nil, http.StatusNoContent, nil)

	// A timed poll ends by itself once ends_at passes; nothing has to run.
	timed := sendPoll(t, bob, ch, samplePoll(map[string]any{"duration": "1h"}))
	vote(t, carol, ch, timed.ID, 0)
	_, err := env.Pool.Exec(context.Background(), `UPDATE polls SET ends_at = now() - interval '1 second' WHERE message_id = $1`, timed.ID)
	require.NoError(t, err)
	carol.Do(http.MethodGet, "/api/channels/"+ch.String()+"/messages", nil, http.StatusOK, &page)
	require.Equal(t, timed.ID, page[0].ID)
	require.True(t, page[0].Poll.Ended)
	carol.Fail(http.MethodPut, pollURL(ch, timed.ID, "vote"), map[string]any{"positions": []int{1}}, http.StatusConflict, "POLL_ENDED")
	bob.Fail(http.MethodPost, pollURL(ch, timed.ID, "end"), nil, http.StatusConflict, "POLL_ENDED")

	plain := bob.Send(ch, "no poll")
	bob.Fail(http.MethodPost, pollURL(ch, plain.ID, "end"), nil, http.StatusNotFound, "NOT_FOUND")
}

func TestPollVoters(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	carol := env.Register("carol")
	m := sendPoll(t, alice, ch, samplePoll(nil))
	vote(t, alice, ch, m.ID, 0)
	vote(t, bob, ch, m.ID, 0)
	vote(t, carol, ch, m.ID, 1)

	var voters []auth.PublicUser
	carol.Do(http.MethodGet, pollURL(ch, m.ID, "options/0/voters"), nil, http.StatusOK, &voters)
	require.Equal(t, []string{"alice", "bob"}, voterNames(voters))
	carol.Do(http.MethodGet, pollURL(ch, m.ID, "options/1/voters"), nil, http.StatusOK, &voters)
	require.Equal(t, []string{"carol"}, voterNames(voters))
	carol.Fail(http.MethodGet, pollURL(ch, m.ID, "options/2/voters"), nil, http.StatusNotFound, "NOT_FOUND")
	env.Outsider("eve").Fail(http.MethodGet, pollURL(ch, m.ID, "options/0/voters"), nil, http.StatusNotFound, "NOT_FOUND")
}

func TestPollVotersNeedReadHistory(t *testing.T) {
	_, alice, bob, serverID, ch := setup(t)
	m := sendPoll(t, alice, ch, samplePoll(nil))
	vote(t, alice, ch, m.ID, 0)
	bob.Do(http.MethodGet, pollURL(ch, m.ID, "options/0/voters"), nil, http.StatusOK, nil)

	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+serverID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ReadHistory)}, http.StatusOK, nil)
	bob.Fail(http.MethodGet, pollURL(ch, m.ID, "options/0/voters"), nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestAnonymousPollHidesVoters(t *testing.T) {
	_, alice, bob, _, ch := setup(t)
	m := sendPoll(t, alice, ch, samplePoll(map[string]any{"anonymous": true}))
	ws, _ := alice.Connect()
	secret := bob.User.ID.String() // bob only votes, so his ID has no other reason to appear

	var raw json.RawMessage
	bob.Do(http.MethodPut, pollURL(ch, m.ID, "vote"), map[string]any{"positions": []int{0}}, http.StatusOK, &raw)
	require.NotContains(t, string(raw), secret)
	ws.ExpectDispatch("POLL_UPDATE", &raw)
	require.NotContains(t, string(raw), secret)

	bob.Fail(http.MethodGet, pollURL(ch, m.ID, "options/0/voters"), nil, http.StatusNotFound, "NOT_FOUND")
	alice.Fail(http.MethodGet, pollURL(ch, m.ID, "options/0/voters"), nil, http.StatusNotFound, "NOT_FOUND")

	_, body := alice.Raw(http.MethodGet, "/api/channels/"+ch.String()+"/messages", nil, "", http.StatusOK)
	require.NotContains(t, string(body), secret)
	var page []messages.Message
	require.NoError(t, json.Unmarshal(body, &page))
	require.Equal(t, []int{1, 0}, optionCounts(*page[0].Poll), "counts are public")

	// Broadcasts never carry anyone's own votes: alice votes, then pins; MESSAGE_UPDATE has my_votes empty.
	vote(t, alice, ch, m.ID, 1)
	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/pins/"+m.ID.String(), nil, http.StatusNoContent, nil)
	ws.ExpectDispatch("MESSAGE_UPDATE", &raw)
	require.NotContains(t, string(raw), secret)
	var updated messages.Message
	require.NoError(t, json.Unmarshal(raw, &updated))
	require.Empty(t, updated.Poll.MyVotes)
	require.Equal(t, []int{1, 1}, optionCounts(*updated.Poll))
}

func TestPollVoteRateLimit(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	m := sendPoll(t, alice, ch, samplePoll(nil))
	for i := 0; i < 10; i++ {
		vote(t, alice, ch, m.ID, i%2)
	}
	alice.Fail(http.MethodPut, pollURL(ch, m.ID, "vote"), map[string]any{"positions": []int{0}}, http.StatusTooManyRequests, "RATE_LIMITED")
}
