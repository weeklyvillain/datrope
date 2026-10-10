package music_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/lktest"
	"github.com/datrope/datrope/server/internal/music"
	"github.com/datrope/datrope/server/internal/voice"
)

const settle, poll = 15 * time.Second, 100 * time.Millisecond

// tone makes a few seconds of audio with ffmpeg in the given format.
func tone(t *testing.T, seconds, format string) []byte {
	t.Helper()
	out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration="+seconds,
		"-f", format, "pipe:1").Output()
	require.NoError(t, err)
	return out
}

type fakeResolver struct{ file string }

func (f fakeResolver) Resolve(_ context.Context, input string) (music.Resolved, error) {
	if input == "nothing" {
		return music.Resolved{}, music.ErrNotFound
	}
	return music.Resolved{Title: "Fake: " + input, URL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", Duration: 3}, nil
}

func (f fakeResolver) Stream(context.Context, string) (string, error) { return f.file, nil }

func botPublishing(cfg voice.Config, channelID id.ID) func() bool {
	return func() bool {
		ps, err := voice.NewRooms(cfg).Participants(context.Background(), channelID.String())
		if err != nil {
			return false
		}
		return slices.ContainsFunc(ps, func(p *livekit.ParticipantInfo) bool {
			return p.Identity == "music-"+channelID.String() && len(p.GetTracks()) > 0
		})
	}
}

func botGone(cfg voice.Config, channelID id.ID) func() bool {
	return func() bool {
		ps, err := voice.NewRooms(cfg).Participants(context.Background(), channelID.String())
		return err == nil && !slices.ContainsFunc(ps, func(p *livekit.ParticipantInfo) bool { return p.Identity == "music-"+channelID.String() })
	}
}

func TestMusicBot(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	cfg := lktest.New(t)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = cfg })
	alice := env.Register("alice")
	carol := env.Register("carol")
	var ch channels.Channel
	alice.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": "Lounge", "type": "voice"}, http.StatusCreated, &ch)
	var join voice.JoinResponse
	alice.Do(http.MethodPost, "/api/voice/"+ch.ID.String()+"/join", map[string]any{}, http.StatusOK, &join)
	lktest.Connect(t, cfg, join.Token)
	require.NoError(t, env.App.Voice.Sync(context.Background()))
	base := "/api/channels/" + ch.ID.String() + "/music"
	state := func() music.MusicState {
		var st music.MusicState
		alice.Do(http.MethodGet, base, nil, http.StatusOK, &st)
		return st
	}
	require.True(t, state().Enabled)
	require.False(t, state().YouTube, "no yt-dlp in tests")

	// The library: uploads are checked to be audio.
	raw := alice.UploadForm(http.MethodPost, "/api/server/music", "tone.mp3", tone(t, "3", "mp3"), map[string]string{"title": "Beep"}, http.StatusCreated)
	var lt music.LibraryTrack
	require.NoError(t, json.Unmarshal(raw, &lt))
	require.Equal(t, "Beep", lt.Title)
	require.InDelta(t, 3, lt.Duration, 1)
	alice.UploadTo(http.MethodPost, "/api/server/music", "x.mp3", []byte("not audio"), http.StatusBadRequest)
	var lib []music.LibraryTrack
	carol.Do(http.MethodGet, "/api/server/music", nil, http.StatusOK, &lib)
	require.Len(t, lib, 1)
	carol.Fail(http.MethodDelete, "/api/server/music/"+lt.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")

	// Only people in the channel's voice control its music.
	carol.Fail(http.MethodPost, base, map[string]any{"track_id": lt.ID}, http.StatusForbidden, "NOT_IN_VOICE")
	alice.Fail(http.MethodPost, base, map[string]any{"query": "song"}, http.StatusServiceUnavailable, "MUSIC_UNAVAILABLE")

	alice.Do(http.MethodPost, base, map[string]any{"track_id": lt.ID}, http.StatusCreated, nil)
	require.Eventually(t, botPublishing(cfg, ch.ID), settle, poll, "the bot joins and publishes audio")
	st := state()
	require.Equal(t, "Beep", st.Current.Title)
	require.Equal(t, "music-"+ch.ID.String(), st.BotID)

	alice.Do(http.MethodPost, base+"/pause", nil, http.StatusNoContent, nil)
	require.True(t, state().Paused)
	alice.Do(http.MethodPost, base+"/resume", nil, http.StatusNoContent, nil)
	require.False(t, state().Paused)

	// YouTube (a fake yt-dlp that streams a local file).
	file := filepath.Join(t.TempDir(), "song.ogg")
	require.NoError(t, os.WriteFile(file, tone(t, "30", "ogg"), 0o600))
	env.App.Music.SetResolver(fakeResolver{file: file})
	alice.Fail(http.MethodPost, base, map[string]any{"query": "nothing"}, http.StatusNotFound, "NOT_FOUND")
	var queued music.MusicTrack
	alice.Do(http.MethodPost, base, map[string]any{"query": "never gonna"}, http.StatusCreated, &queued)
	require.Equal(t, "Fake: never gonna", queued.Title)
	require.Equal(t, "youtube", queued.Source)
	alice.Do(http.MethodPost, base, map[string]any{"query": "third"}, http.StatusCreated, nil)
	require.Len(t, state().Queue, 2)

	var third music.MusicTrack
	alice.Do(http.MethodPost, base, map[string]any{"query": "fourth"}, http.StatusCreated, &third)
	alice.Do(http.MethodDelete, base+"/queue/"+third.ID.String(), nil, http.StatusNoContent, nil)
	require.Len(t, state().Queue, 2)

	alice.Do(http.MethodPost, base+"/skip", nil, http.StatusNoContent, nil)
	require.Eventually(t, func() bool { c := state().Current; return c != nil && c.Title == "Fake: never gonna" }, settle, poll)

	alice.Do(http.MethodPost, base+"/stop", nil, http.StatusNoContent, nil)
	require.Eventually(t, botGone(cfg, ch.ID), settle, poll, "stop makes the bot leave")
	require.Eventually(t, func() bool { s := state(); return s.Current == nil && len(s.Queue) == 0 }, settle, poll)

	alice.Do(http.MethodDelete, "/api/server/music/"+lt.ID.String(), nil, http.StatusNoContent, nil)
}
