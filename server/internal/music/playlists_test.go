package music_test

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/music"
	"github.com/datrope/datrope/server/internal/perms"
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

func TestPlaylistFiles(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	srv := alice.Server()
	secret := alice.CreateTextChannel("secret")
	alice.Do(http.MethodPut, "/api/channels/"+secret.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)

	open := alice.Upload(general, "open-song.mp3", tone(t, "2", "mp3"), http.StatusCreated)
	alice.SendWith(general, "", open.ID)
	hidden := alice.Upload(secret, "secret-song.mp3", tone(t, "2", "mp3"), http.StatusCreated)
	hm := alice.SendWith(secret, "", hidden.ID)
	notes := alice.Upload(general, "notes.txt", []byte("words"), http.StatusCreated)
	alice.SendWith(general, "", notes.ID)

	var created struct{ music.PlaylistDetail }
	alice.Do(http.MethodPost, "/api/server/music/playlists", map[string]any{"title": "Mix"}, http.StatusCreated, &created)
	pl := "/api/server/music/playlists/" + created.ID.String()
	alice.Do(http.MethodPost, pl+"/items", map[string]any{"attachment_id": open.ID}, http.StatusCreated, nil)
	alice.Do(http.MethodPost, pl+"/items", map[string]any{"attachment_id": hidden.ID}, http.StatusCreated, nil)
	alice.Fail(http.MethodPost, pl+"/items", map[string]any{"attachment_id": notes.ID}, http.StatusBadRequest, "NOT_AUDIO")
	// An expired file can no longer be added.
	gone := alice.Upload(general, "gone-song.mp3", tone(t, "2", "mp3"), http.StatusCreated)
	alice.SendWith(general, "", gone.ID)
	alice.Do(http.MethodDelete, "/api/attachments/"+gone.ID.String(), nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodPost, pl+"/items", map[string]any{"attachment_id": gone.ID}, http.StatusNotFound, "NOT_FOUND")
	// bob may not add a file he cannot read, even to his own playlist.
	var bobs struct{ music.PlaylistDetail }
	bob.Do(http.MethodPost, "/api/server/music/playlists", map[string]any{"title": "Bob's"}, http.StatusCreated, &bobs)
	bob.Fail(http.MethodPost, "/api/server/music/playlists/"+bobs.ID.String()+"/items",
		map[string]any{"attachment_id": hidden.ID}, http.StatusNotFound, "NOT_FOUND")

	var mine, his music.PlaylistDetail
	alice.Do(http.MethodGet, pl, nil, http.StatusOK, &mine)
	require.Equal(t, []string{"open-song", "secret-song"}, itemTitles(mine.Items))
	require.Equal(t, "file", mine.Items[0].Source)
	require.Equal(t, general, *mine.Items[0].ChannelID)
	require.Equal(t, open.ID, *mine.Items[0].AttachmentID)
	require.Greater(t, mine.Items[0].Duration, 0)
	require.Zero(t, mine.Hidden)

	bob.Do(http.MethodGet, pl, nil, http.StatusOK, &his)
	require.Equal(t, []string{"open-song"}, itemTitles(his.Items))
	require.Equal(t, 1, his.Hidden)

	// Deleting the message deletes its attachment, which removes the item.
	alice.Do(http.MethodDelete, "/api/channels/"+secret.String()+"/messages/"+hm.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodGet, pl, nil, http.StatusOK, &mine)
	require.Equal(t, []string{"open-song"}, itemTitles(mine.Items))
}
