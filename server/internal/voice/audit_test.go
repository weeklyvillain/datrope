package voice_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/audit"
)

func TestVoiceModerationIsRecorded(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	games := createVoice(c.owner, "Games")
	bob := c.member.User.ID
	enter(t, env, cfg, c.member, c.voiceID)

	c.owner.Do(http.MethodPost, memberPath(bob)+"/mute", map[string]any{"muted": true}, http.StatusNoContent, nil)
	c.owner.Do(http.MethodPost, memberPath(bob)+"/mute", map[string]any{"muted": true}, http.StatusNoContent, nil) // no change
	c.owner.Do(http.MethodPost, memberPath(bob)+"/move", map[string]any{"channel_id": games}, http.StatusNoContent, nil)
	c.owner.Do(http.MethodDelete, memberPath(bob), nil, http.StatusNoContent, nil)

	var p audit.LogPage
	c.owner.Do(http.MethodGet, "/api/server/audit-log?limit=4", nil, http.StatusOK, &p)
	require.Len(t, p.Entries, 4)
	disconnect, move, mute := p.Entries[0], p.Entries[1], p.Entries[2]
	require.Equal(t, audit.ChannelCreate, p.Entries[3].Action, "muting again changed nothing and was not recorded")

	require.Equal(t, audit.VoiceDisconnect, disconnect.Action)
	require.Equal(t, &audit.LogRef{ID: c.voiceID, Name: "Lounge"}, disconnect.Details.Channel, "the move only tells bob's clients to rejoin")

	require.Equal(t, audit.VoiceMove, move.Action)
	require.Equal(t, bob, *move.TargetID)
	require.Equal(t, c.owner.User.ID, move.ActorID)
	require.Equal(t, &audit.LogRef{ID: c.voiceID, Name: "Lounge"}, move.Details.From)
	require.Equal(t, &audit.LogRef{ID: games, Name: "Games"}, move.Details.To)

	require.Equal(t, audit.VoiceMute, mute.Action)
	require.Equal(t, &audit.LogRef{ID: c.voiceID, Name: "Lounge"}, mute.Details.Channel)
}
