package voice_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/livekit/protocol/livekit"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/lktest"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

func TestJoinWhenVoiceIsOff(t *testing.T) {
	env := apptest.New(t)
	c := newClub(t, env)
	c.owner.Fail(http.MethodPost, joinPath(c.voiceID), map[string]any{}, http.StatusServiceUnavailable, "VOICE_UNAVAILABLE")
}

func TestJoinWhenLiveKitIsDown(t *testing.T) {
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = offline(t) })
	c := newClub(t, env)
	c.owner.Fail(http.MethodPost, joinPath(c.voiceID), map[string]any{}, http.StatusServiceUnavailable, "VOICE_UNAVAILABLE")
	c.owner.Send(c.textID, "text chat keeps working")
}

func TestJoinChecksPermissions(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	eve := env.Outsider("eve")

	c.owner.Fail(http.MethodPost, joinPath(c.textID), map[string]any{}, http.StatusBadRequest, "NOT_VOICE_CHANNEL")
	eve.Fail(http.MethodPost, joinPath(c.voiceID), map[string]any{}, http.StatusNotFound, "NOT_FOUND")
	c.owner.Fail(http.MethodPost, joinPath(id.New()), map[string]any{}, http.StatusNotFound, "NOT_FOUND")

	deny(c.owner, c.voiceID, c.community.ID, perms.ConnectVoice)
	c.member.Fail(http.MethodPost, joinPath(c.voiceID), map[string]any{}, http.StatusForbidden, "MISSING_PERMISSION")
	c.owner.Do(http.MethodDelete, "/api/channels/"+c.voiceID.String()+"/overrides/role/"+c.community.ID.String(),
		nil, http.StatusNoContent, nil)

	res := join(c.owner, c.voiceID)
	require.Equal(t, cfg.PublicURL, res.URL)
	g := grants(t, cfg, res.Token)
	require.Equal(t, c.voiceID.String(), g.Video.Room)
	require.Equal(t, c.owner.User.ID.String(), g.Identity)
	require.Equal(t, "alice", g.Name)
	for _, src := range []livekit.TrackSource{mic, camera, screen, sound} {
		require.True(t, g.Video.GetCanPublishSource(src), src.String())
	}

	// Without STREAM the token allows the microphone only, and LiveKit agrees.
	setEveryone(c.owner, c.community.ID, perms.Default&^perms.Stream)
	res = join(c.member, c.voiceID)
	g = grants(t, cfg, res.Token)
	require.True(t, g.Video.GetCanPublishSource(mic))
	require.False(t, g.Video.GetCanPublishSource(camera))
	require.False(t, g.Video.GetCanPublishSource(screen))
	lktest.Connect(t, cfg, res.Token)
	ps, err := voice.NewRooms(cfg).Participants(context.Background(), c.voiceID.String())
	require.NoError(t, err)
	require.Len(t, ps, 1)
	require.Equal(t, []livekit.TrackSource{mic}, ps[0].GetPermission().GetCanPublishSources())
}

func TestJoinDMCall(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	carol := env.Register("carol")
	var dm channels.Channel
	c.owner.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []id.ID{c.member.User.ID}}, http.StatusOK, &dm)

	g := grants(t, cfg, join(c.member, dm.ID).Token)
	require.Equal(t, dm.ID.String(), g.Video.Room)
	require.True(t, g.Video.GetCanPublishSource(mic), "DM participants may speak")
	require.True(t, g.Video.GetCanPublishSource(camera), "DM participants may stream")
	carol.Fail(http.MethodPost, joinPath(dm.ID), map[string]any{}, http.StatusNotFound, "NOT_FOUND")
}

func TestJoinRefusesWelcomeChannel(t *testing.T) {
	env, _ := liveKitEnv(t)
	c := newClub(t, env)
	var welcomeID id.ID
	for _, ch := range c.owner.Channels() {
		if ch.Type == "welcome" {
			welcomeID = ch.ID
		}
	}
	require.NotZero(t, welcomeID)
	c.owner.Fail(http.MethodPost, joinPath(welcomeID), map[string]any{}, http.StatusBadRequest, "NOT_VOICE_CHANNEL")
}
