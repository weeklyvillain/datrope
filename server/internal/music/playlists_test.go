package music_test

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/music"
)

func TestPlaylists(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	env := apptest.New(t)
	alice := env.Register("alice")
	carol := env.Register("carol")
	env.App.Music.SetResolver(fakeResolver{})
	ws, _ := carol.Connect()
	defer ws.Close()

	raw := alice.UploadForm(http.MethodPost, "/api/server/music", "tone.mp3", toneTagged(t, "2"), map[string]string{"title": "Upload"}, http.StatusCreated)
	var lt music.LibraryTrack
	require.NoError(t, json.Unmarshal(raw, &lt))

	const base = "/api/server/music/playlists"
	var created struct {
		music.PlaylistDetail
		music.PlaylistAddResult
	}
	alice.Fail(http.MethodPost, base, map[string]any{}, http.StatusBadRequest, "VALIDATION_FAILED")
	// Importing a playlist link: its title, its tracks, and how many were dropped.
	alice.Do(http.MethodPost, base, map[string]any{"from_url": "https://www.youtube.com/playlist?list=x"}, http.StatusCreated, &created)
	require.Equal(t, "Fake list", created.Title)
	require.Equal(t, 3, created.Added)
	require.Equal(t, 1, created.Dropped)
	require.Len(t, created.Items, 3)
	var upd music.MusicPlaylist
	ws.ExpectDispatch("MUSIC_PLAYLIST_UPDATE", &upd)
	require.Equal(t, created.ID, upd.ID)
	pl := base + "/" + created.ID.String()

	var res music.PlaylistAddResult
	alice.Do(http.MethodPost, pl+"/items", map[string]any{"track_id": lt.ID}, http.StatusCreated, &res)
	require.Equal(t, 1, res.Added)
	alice.Do(http.MethodPost, pl+"/items", map[string]any{"query": "lofi"}, http.StatusCreated, nil)

	get := func() music.PlaylistDetail {
		var d music.PlaylistDetail
		carol.Do(http.MethodGet, pl, nil, http.StatusOK, &d)
		return d
	}
	d := get()
	require.Equal(t, []string{"List one", "List two", "List three", "Upload", "Fake: lofi"}, itemTitles(d.Items))
	require.Equal(t, 5, d.Count)
	require.Equal(t, "upload", d.Items[3].Source)
	require.Equal(t, lt.Cover, d.Items[3].Cover, "an upload's cover comes from the library")
	require.Equal(t, "The Testers", d.Items[3].Artist)

	// Moving and removing keep the order tidy.
	alice.Do(http.MethodPut, pl+"/items/"+d.Items[3].ID.String()+"/position", map[string]any{"position": 0}, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, pl+"/items/"+d.Items[0].ID.String()+"/position", map[string]any{"position": 99}, http.StatusNoContent, nil)
	require.Equal(t, []string{"Upload", "List two", "List three", "Fake: lofi", "List one"}, itemTitles(get().Items))
	alice.Do(http.MethodDelete, pl+"/items/"+d.Items[1].ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"Upload", "List three", "Fake: lofi", "List one"}, itemTitles(get().Items))

	// Only the creator (or someone who manages expressions) changes a playlist.
	carol.Fail(http.MethodPatch, pl, map[string]any{"title": "Mine now"}, http.StatusForbidden, "MISSING_PERMISSION")
	carol.Fail(http.MethodPost, pl+"/items", map[string]any{"query": "x"}, http.StatusForbidden, "MISSING_PERMISSION")
	carol.Fail(http.MethodDelete, pl, nil, http.StatusForbidden, "MISSING_PERMISSION")
	var renamed music.MusicPlaylist
	alice.Do(http.MethodPatch, pl, map[string]any{"title": "Road trip"}, http.StatusOK, &renamed)
	require.Equal(t, "Road trip", renamed.Title)

	var mine struct{ music.PlaylistDetail }
	carol.Do(http.MethodPost, base, map[string]any{"title": "Carol's"}, http.StatusCreated, &mine)
	alice.Do(http.MethodPatch, base+"/"+mine.ID.String(), map[string]any{"title": "Moderated"}, http.StatusOK, nil)

	var list []music.MusicPlaylist
	carol.Do(http.MethodGet, base, nil, http.StatusOK, &list)
	require.Len(t, list, 2)
	require.Equal(t, "Moderated", list[0].Title)
	require.Equal(t, "Road trip", list[1].Title)
	require.Equal(t, 4, list[1].Count)
	require.Equal(t, lt.Cover, list[1].Cover, "the first track's cover")

	// Deleting a library track takes it out of playlists.
	alice.Do(http.MethodDelete, "/api/server/music/"+lt.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"List three", "Fake: lofi", "List one"}, itemTitles(get().Items))

	alice.Do(http.MethodDelete, pl, nil, http.StatusNoContent, nil)
	carol.Fail(http.MethodGet, pl, nil, http.StatusNotFound, "NOT_FOUND")
}

func itemTitles(items []music.PlaylistItem) []string {
	out := []string{}
	for _, it := range items {
		out = append(out, it.Title)
	}
	return out
}
