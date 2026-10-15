package voice_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

func TestGoAFK(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	alice, bob := c.owner, c.member
	afk := createVoice(alice, "AFK")

	enter(t, env, cfg, bob, c.voiceID)
	bob.Fail(http.MethodPost, "/api/voice/afk", nil, http.StatusConflict, "AFK_NOT_SET")

	alice.Do(http.MethodPatch, "/api/server", map[string]any{"afk_channel_id": afk.String()}, http.StatusOK, nil)
	bobWS, _ := bob.Connect()
	bob.Do(http.MethodPost, "/api/voice/afk", nil, http.StatusNoContent, nil)
	var mv voice.VoiceMove
	bobWS.ExpectDispatch("VOICE_MOVE", &mv)
	require.Equal(t, afk, mv.ChannelID)

	// In the AFK channel nobody can publish anything, not even the owner.
	enter(t, env, cfg, bob, afk)
	requireSilent(t, cfg, afk, bob.User.ID)
	enter(t, env, cfg, alice, afk)
	requireSilent(t, cfg, afk, alice.User.ID)

	// Nor play sounds.
	snd := uploadSound(t, alice)
	alice.Fail(http.MethodPost, "/api/voice/soundboard", map[string]any{"sound_id": snd.ID}, http.StatusForbidden, "AFK_CHANNEL")

	// Already there: nothing to do.
	bob.Do(http.MethodPost, "/api/voice/afk", nil, http.StatusNoContent, nil)
	bobWS.ExpectNoDispatch("VOICE_MOVE", 300*time.Millisecond)

	// Back in a normal channel the usual permissions apply again, and Reconcile keeps AFK empty.
	enter(t, env, cfg, bob, c.voiceID)
	require.NotEmpty(t, sourcesOf(cfg, c.voiceID, bob.User.ID))
	setEveryone(alice, c.community.ID, perms.Default) // a permission change triggers Reconcile
	require.NoError(t, env.App.Voice.Sync(t.Context()))
	requireSilent(t, cfg, afk, alice.User.ID)
}

// requireSilent asserts that the user is in the channel's room and LiveKit lets them publish nothing.
func requireSilent(t *testing.T, cfg voice.Config, channelID, userID id.ID) {
	t.Helper()
	p := participantOf(cfg, channelID, userID)
	require.NotNil(t, p, "the user is in the room")
	require.False(t, p.GetPermission().GetCanPublish())
	require.Empty(t, p.GetPermission().GetCanPublishSources())
}

func TestGoAFKNotInVoice(t *testing.T) {
	env, _ := liveKitEnv(t)
	c := newClub(t, env)
	c.member.Fail(http.MethodPost, "/api/voice/afk", nil, http.StatusNotFound, "NOT_FOUND")
}
