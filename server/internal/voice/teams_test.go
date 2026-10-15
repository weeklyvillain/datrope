package voice_test

import (
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/voice"
)

func ids(n int) []id.ID {
	out := make([]id.ID, n)
	for i := range out {
		out[i] = id.ID(i + 1)
	}
	return out
}

func TestDeal(t *testing.T) {
	noShuffle := func([]id.ID) {}
	teams, bench := voice.Deal(ids(7), 2, 0, noShuffle)
	require.Equal(t, [][]id.ID{{1, 3, 5, 7}, {2, 4, 6}}, teams, "even split, round robin")
	require.Empty(t, bench)

	teams, bench = voice.Deal(ids(7), 2, 3, noShuffle)
	require.Equal(t, [][]id.ID{{1, 3, 5}, {2, 4, 6}}, teams)
	require.Equal(t, []id.ID{7}, bench)

	teams, _ = voice.Deal(ids(10), 3, 0, voice.CryptoShuffle)
	all := slices.Concat(teams...)
	slices.Sort(all)
	require.Equal(t, ids(10), all, "everyone exactly once")
}

func TestDrawTeams(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	alice, bob := c.owner, c.member
	carol := env.Register("carol")
	carol.Join(alice.Invite())
	enter(t, env, cfg, alice, c.voiceID)
	enter(t, env, cfg, bob, c.voiceID)
	bobWS, _ := bob.Connect()
	carolWS, _ := carol.Connect()
	path := "/api/voice/" + c.voiceID.String() + "/teams"

	alice.Do(http.MethodPost, path, map[string]any{"teams": 2, "user_ids": []id.ID{alice.User.ID, bob.User.ID}}, http.StatusNoContent, nil)
	var ev voice.TeamsDraw
	bobWS.ExpectDispatch("VOICE_TEAMS", &ev)
	require.Equal(t, c.voiceID, ev.ChannelID)
	require.Equal(t, alice.User.ID, ev.By)
	require.Len(t, ev.Teams, 2)
	require.ElementsMatch(t, []id.ID{alice.User.ID, bob.User.ID}, slices.Concat(ev.Teams...))
	carolWS.ExpectNoDispatch("VOICE_TEAMS", 300*time.Millisecond)

	// One draw per 5 s per user.
	alice.Fail(http.MethodPost, path, map[string]any{"teams": 2, "user_ids": []id.ID{alice.User.ID, bob.User.ID}}, http.StatusTooManyRequests, "RATE_LIMITED")

	bob.Fail(http.MethodPost, path, map[string]any{"teams": 2, "user_ids": []id.ID{alice.User.ID, carol.User.ID}}, http.StatusBadRequest, "NOT_IN_CALL")
	carol.Fail(http.MethodPost, path, map[string]any{"teams": 2, "user_ids": []id.ID{alice.User.ID, bob.User.ID}}, http.StatusForbidden, "NOT_IN_CALL")
	alice.Fail(http.MethodPost, path, map[string]any{"teams": 2, "per_team": 2, "user_ids": []id.ID{alice.User.ID, bob.User.ID}}, http.StatusBadRequest, "TOO_FEW_PLAYERS")
	alice.Fail(http.MethodPost, path, map[string]any{"teams": 9, "user_ids": []id.ID{alice.User.ID, bob.User.ID}}, http.StatusBadRequest, "VALIDATION_FAILED")
}
