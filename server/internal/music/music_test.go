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

// toneTagged makes an MP3 with title and artist tags and a cover picture.
func toneTagged(t *testing.T, seconds string) []byte {
	t.Helper()
	cover := filepath.Join(t.TempDir(), "cover.png")
	require.NoError(t, exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64",
		"-frames:v", "1", cover).Run())
	file := filepath.Join(t.TempDir(), "tagged.mp3") // a file: written to a pipe, the tags go missing
	require.NoError(t, exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "sine=frequency=440:duration="+seconds, "-i", cover,
		"-map", "0:a", "-map", "1:v", "-c:v", "copy", "-disposition:v", "attached_pic", "-id3v2_version", "3",
		"-metadata", "title=Tagged Song", "-metadata", "artist=The Testers", file).Run())
	out, err := os.ReadFile(file)
	require.NoError(t, err)
	return out
}

type fakeResolver struct{ file string }

func (f fakeResolver) Resolve(_ context.Context, input string) (music.Resolved, error) {
	if input == "nothing" {
		return music.Resolved{}, music.ErrNotFound
	}
	return music.Resolved{Title: "Fake: " + input, URL: "https://www.youtube.com/watch?v=" + input, Duration: 3, Site: "youtube"}, nil
}

func (f fakeResolver) ResolvePlaylist(_ context.Context, link string) (music.LinkPlaylist, error) {
	if link == "https://www.youtube.com/playlist?list=none" {
		return music.LinkPlaylist{}, music.ErrNotFound
	}
	return music.LinkPlaylist{Title: "Fake list", Dropped: 1, Tracks: []music.Resolved{
		{Title: "List one", URL: "https://www.youtube.com/watch?v=l1", Duration: 3, Site: "youtube"},
		{Title: "List two", URL: "https://www.youtube.com/watch?v=l2", Duration: 3, Site: "youtube"},
		{Title: "List three", URL: "https://www.youtube.com/watch?v=l3", Duration: 3, Site: "youtube"},
	}}, nil
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
	require.Positive(t, lt.Size, "stored as Opus")
	require.Empty(t, lt.Cover)
	alice.UploadTo(http.MethodPost, "/api/server/music", "x.mp3", []byte("not audio"), http.StatusBadRequest)

	// Tags fill in the title and artist, and the embedded picture becomes the cover.
	raw = alice.UploadTo(http.MethodPost, "/api/server/music", "file-name.mp3", toneTagged(t, "2"), http.StatusCreated)
	var tagged music.LibraryTrack
	require.NoError(t, json.Unmarshal(raw, &tagged))
	require.Equal(t, "Tagged Song", tagged.Title)
	require.Equal(t, "The Testers", tagged.Artist)
	require.NotEmpty(t, tagged.Cover)
	resp, body := carol.Raw(http.MethodGet, tagged.Cover, nil, "", http.StatusOK)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.NotEmpty(t, body)
	carol.Raw(http.MethodGet, "/api/music/covers/"+lt.ID.String(), nil, "", http.StatusNotFound)

	var lib music.Library
	carol.Do(http.MethodGet, "/api/server/music", nil, http.StatusOK, &lib)
	require.Len(t, lib.Tracks, 2)
	require.Equal(t, lt.Size+tagged.Size, lib.UsedBytes)
	require.Equal(t, int64(music.DefaultLibraryBytes), lib.LimitBytes)
	carol.Fail(http.MethodDelete, "/api/server/music/"+lt.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Do(http.MethodDelete, "/api/server/music/"+tagged.ID.String(), nil, http.StatusNoContent, nil)

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
	require.Equal(t, "off", state().Repeat)
	alice.Do(http.MethodPut, base+"/repeat", map[string]any{"mode": "one"}, http.StatusNoContent, nil)
	require.Equal(t, "one", state().Repeat)
	alice.Fail(http.MethodPut, base+"/repeat", map[string]any{"mode": "sometimes"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Do(http.MethodPut, base+"/repeat", map[string]any{"mode": "off"}, http.StatusNoContent, nil)

	// YouTube (a fake yt-dlp that streams a local file).
	file := filepath.Join(t.TempDir(), "song.ogg")
	require.NoError(t, os.WriteFile(file, tone(t, "30", "ogg"), 0o600))
	env.App.Music.SetResolver(fakeResolver{file: file})
	alice.Fail(http.MethodPost, base, map[string]any{"query": "nothing"}, http.StatusNotFound, "NOT_FOUND")
	var queued music.QueueResult
	alice.Do(http.MethodPost, base, map[string]any{"query": "never gonna"}, http.StatusCreated, &queued)
	require.Len(t, queued.Tracks, 1)
	require.Equal(t, "Fake: never gonna", queued.Tracks[0].Title)
	require.Equal(t, "link", queued.Tracks[0].Source)
	require.Equal(t, "youtube", queued.Tracks[0].Site)
	alice.Do(http.MethodPost, base, map[string]any{"query": "third"}, http.StatusCreated, nil)
	require.Len(t, state().Queue, 2)

	var third music.QueueResult
	alice.Do(http.MethodPost, base, map[string]any{"query": "fourth"}, http.StatusCreated, &third)
	alice.Do(http.MethodDelete, base+"/queue/"+third.Tracks[0].ID.String(), nil, http.StatusNoContent, nil)
	require.Len(t, state().Queue, 2)

	// A playlist link: every track, or none when it can't be read.
	var list music.QueueResult
	alice.Do(http.MethodPost, base, map[string]any{"query": "https://www.youtube.com/watch?v=l1&list=x", "playlist": true}, http.StatusCreated, &list)
	require.Len(t, list.Tracks, 3)
	require.Equal(t, 1, list.Dropped)
	require.Len(t, state().Queue, 5)
	alice.Fail(http.MethodPost, base, map[string]any{"query": "https://www.youtube.com/playlist?list=none", "playlist": true}, http.StatusNotFound, "NOT_FOUND")
	alice.Fail(http.MethodPost, base, map[string]any{"query": "file:///etc/passwd"}, http.StatusBadRequest, "BAD_QUERY")

	// Shuffle keeps the tracks; replace swaps the queue; clear empties it but the song plays on.
	alice.Do(http.MethodPost, base+"/shuffle", nil, http.StatusNoContent, nil)
	require.Len(t, state().Queue, 5)
	alice.Do(http.MethodPost, base, map[string]any{"query": "https://www.youtube.com/playlist?list=x", "playlist": true, "replace": true}, http.StatusCreated, nil)
	require.Equal(t, []string{"List one", "List two", "List three"}, titles(state().Queue))
	alice.Do(http.MethodDelete, base+"/queue", nil, http.StatusNoContent, nil)
	require.Empty(t, state().Queue)
	require.NotNil(t, state().Current)
	carol.Fail(http.MethodDelete, base+"/queue", nil, http.StatusForbidden, "NOT_IN_VOICE")
	// A saved playlist queues all its tracks, shuffled when asked.
	var saved struct{ music.PlaylistDetail }
	alice.Do(http.MethodPost, "/api/server/music/playlists", map[string]any{"from_url": "https://www.youtube.com/playlist?list=x"}, http.StatusCreated, &saved)
	alice.Do(http.MethodPost, base, map[string]any{"playlist_id": saved.ID, "shuffle": true}, http.StatusCreated, &list)
	require.Len(t, list.Tracks, 3)
	require.ElementsMatch(t, []string{"List one", "List two", "List three"}, titles(state().Queue))
	// "Save queue as playlist" takes what plays and the queue.
	var fromQueue music.PlaylistAddResult
	alice.Do(http.MethodPost, "/api/server/music/playlists/"+saved.ID.String()+"/items", map[string]any{"from_channel": ch.ID}, http.StatusCreated, &fromQueue)
	require.GreaterOrEqual(t, fromQueue.Added, 3) // the queue, and the current track unless it is between tracks
	alice.Do(http.MethodDelete, base+"/queue", nil, http.StatusNoContent, nil)

	alice.Do(http.MethodPost, base, map[string]any{"query": "never gonna"}, http.StatusCreated, nil)
	alice.Do(http.MethodPost, base, map[string]any{"query": "third"}, http.StatusCreated, nil)

	alice.Do(http.MethodPost, base+"/skip", nil, http.StatusNoContent, nil)
	require.Eventually(t, func() bool { c := state().Current; return c != nil && c.Title == "Fake: never gonna" }, settle, poll)

	alice.Do(http.MethodPost, base+"/stop", nil, http.StatusNoContent, nil)
	require.Eventually(t, botGone(cfg, ch.ID), settle, poll, "stop makes the bot leave")
	require.Eventually(t, func() bool { s := state(); return s.Current == nil && len(s.Queue) == 0 }, settle, poll)

	alice.Do(http.MethodDelete, "/api/server/music/"+lt.ID.String(), nil, http.StatusNoContent, nil)
}

func titles(ts []music.MusicTrack) []string {
	out := []string{}
	for _, t := range ts {
		out = append(out, t.Title)
	}
	return out
}
