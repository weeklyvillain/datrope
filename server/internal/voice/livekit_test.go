package voice_test

import (
	"context"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/lktest"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

var (
	mic    = livekit.TrackSource_MICROPHONE
	camera = livekit.TrackSource_CAMERA
	screen = livekit.TrackSource_SCREEN_SHARE
	sound  = livekit.TrackSource_SCREEN_SHARE_AUDIO
)

func TestSources(t *testing.T) {
	for _, tc := range []struct {
		name       string
		p          perms.Perms
		serverMute bool
		want       []livekit.TrackSource
	}{
		{"nothing", perms.ViewChannel | perms.ConnectVoice, false, []livekit.TrackSource{}},
		{"speak", perms.Speak, false, []livekit.TrackSource{mic}},
		{"speak, server muted", perms.Speak, true, []livekit.TrackSource{}},
		{"stream", perms.Stream, false, []livekit.TrackSource{camera, screen, sound}},
		{"defaults", perms.Default, false, []livekit.TrackSource{mic, camera, screen, sound}},
		{"defaults, server muted", perms.Default, true, []livekit.TrackSource{camera, screen, sound}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, voice.Sources(tc.p, tc.serverMute))
		})
	}
}

// grants verifies a token with the config's secret and returns its claims.
func grants(t *testing.T, cfg voice.Config, token string) *lkauth.ClaimGrants {
	t.Helper()
	v, err := lkauth.ParseAPIToken(token)
	require.NoError(t, err)
	_, g, err := v.Verify(cfg.APISecret)
	require.NoError(t, err)
	return g
}

func TestJoinToken(t *testing.T) {
	cfg := voice.Config{APIKey: "key", APISecret: "secret-secret-secret-secret-secret"}
	token, err := cfg.JoinToken(id.ID(7), id.ID(42), "Alice", voice.Sources(perms.Speak, false),
		voice.Attrs{SessionID: id.ID(9), SelfMute: true})
	require.NoError(t, err)
	g := grants(t, cfg, token)
	require.Equal(t, "9", g.Attributes["datrope.session"], "the session that joined")
	require.Equal(t, "1", g.Attributes["datrope.self_mute"])
	require.Equal(t, "0", g.Attributes["datrope.self_deaf"])
	require.Equal(t, "42", g.Identity)
	require.Equal(t, "Alice", g.Name)
	require.True(t, g.Video.RoomJoin)
	require.Equal(t, "7", g.Video.Room)
	require.True(t, g.Video.GetCanSubscribe())
	require.True(t, g.Video.GetCanPublishSource(mic))
	require.False(t, g.Video.GetCanPublishSource(camera))
	require.False(t, g.Video.GetCanPublishData())
	require.False(t, g.Video.RoomAdmin)

	token, err = cfg.JoinToken(id.ID(7), id.ID(42), "Alice", voice.Sources(0, false), voice.Attrs{})
	require.NoError(t, err)
	g = grants(t, cfg, token)
	require.False(t, g.Video.GetCanPublish(), "no SPEAK or STREAM: nothing may be published")
	require.True(t, g.Video.GetCanSubscribe(), "listening needs no permission beyond CONNECT_VOICE")
}

func TestRoomsAgainstLiveKit(t *testing.T) {
	cfg := lktest.New(t)
	rooms := voice.NewRooms(cfg)
	ctx := context.Background()
	ch, user := id.New(), id.New()

	require.NoError(t, rooms.Ensure(ctx, ch))
	require.NoError(t, rooms.Ensure(ctx, ch), "ensuring an existing room is fine")
	names, err := rooms.List(ctx)
	require.NoError(t, err)
	require.Contains(t, names, ch.String())

	token, err := cfg.JoinToken(ch, user, "Alice", voice.Sources(perms.Speak, false), voice.Attrs{})
	require.NoError(t, err)
	lktest.Connect(t, cfg, token)
	ps, err := rooms.Participants(ctx, ch.String())
	require.NoError(t, err)
	require.Len(t, ps, 1)
	require.Equal(t, user.String(), ps[0].Identity)
	require.Equal(t, []livekit.TrackSource{mic}, ps[0].GetPermission().GetCanPublishSources())

	require.NoError(t, rooms.SetSources(ctx, ch, user, voice.Sources(perms.Speak|perms.Stream, false)))
	ps, err = rooms.Participants(ctx, ch.String())
	require.NoError(t, err)
	require.Equal(t, []livekit.TrackSource{mic, camera, screen, sound}, ps[0].GetPermission().GetCanPublishSources())

	require.NoError(t, rooms.SetAttributes(ctx, ch, user, map[string]string{"datrope.self_mute": "1"}))
	ps, err = rooms.Participants(ctx, ch.String())
	require.NoError(t, err)
	require.Equal(t, "1", ps[0].GetAttributes()["datrope.self_mute"])
	require.NotEmpty(t, ps[0].GetAttributes()["datrope.issued"], "other attributes stay")
	require.Equal(t, []livekit.TrackSource{mic, camera, screen, sound}, ps[0].GetPermission().GetCanPublishSources(),
		"updating attributes leaves permissions alone")

	require.NoError(t, rooms.Remove(ctx, ch, user))
	require.Eventually(t, func() bool {
		ps, err := rooms.Participants(ctx, ch.String())
		return err == nil && len(ps) == 0
	}, 5*time.Second, 100*time.Millisecond)
	require.NoError(t, rooms.Remove(ctx, ch, user), "removing someone who left is fine")
	require.NoError(t, rooms.SetSources(ctx, ch, user, nil), "updating someone who left is fine")
	require.NoError(t, rooms.SetAttributes(ctx, ch, user, map[string]string{"datrope.self_mute": "0"}), "so is setting their attributes")

	require.NoError(t, rooms.Delete(ctx, ch))
	require.NoError(t, rooms.Delete(ctx, ch), "deleting a missing room is fine")
	ps, err = rooms.Participants(ctx, ch.String())
	require.NoError(t, err)
	require.Empty(t, ps, "a missing room has no participants")

	down := voice.NewRooms(voice.Config{URL: "http://127.0.0.1:1", APIKey: lktest.APIKey, APISecret: lktest.APISecret})
	require.Error(t, down.Ensure(ctx, ch), "an unreachable LiveKit is an error")
}
