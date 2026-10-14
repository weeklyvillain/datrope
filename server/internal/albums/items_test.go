package albums_test

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/albums"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/messages"
)

func albumFiles(t *testing.T, c *apptest.Client, albumID string, q url.Values) messages.FilesPage {
	t.Helper()
	var p messages.FilesPage
	c.Do(http.MethodGet, "/api/albums/"+albumID+"/files?"+q.Encode(), nil, http.StatusOK, &p)
	return p
}

func names(p messages.FilesPage) []string {
	out := []string{}
	for _, it := range p.Items {
		out = append(out, it.Attachment.Filename)
	}
	return out
}

func TestAlbumFilesInGalleryScope(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	memes := alice.CreateTextChannel("memes")
	secret := alice.CreatePrivateChannel("secret")
	g := alice.CreateGallery("photos", "selected", general, secret)

	pub := alice.Upload(general, "public.txt", []byte("hi"), http.StatusCreated)
	alice.SendWith(general, "caption words", pub.ID)
	hid := alice.Upload(secret, "hidden.txt", []byte("psst"), http.StatusCreated)
	alice.SendWith(secret, "", hid.ID)
	out := alice.Upload(memes, "outside.txt", []byte("x"), http.StatusCreated)
	alice.SendWith(memes, "", out.ID)
	own := alice.Upload(g, "own.png", tinyPNG(t), http.StatusCreated)
	alice.SendWith(g, "", own.ID)

	trip := create(t, alice, g, "Trip", "gallery")
	path := "/api/albums/" + trip.ID.String() + "/files/"
	alice.Do(http.MethodPut, path+pub.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, path+hid.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, path+own.ID.String(), nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodPut, path+out.ID.String(), nil, http.StatusBadRequest, "NOT_IN_GALLERY")
	bob.Fail(http.MethodPut, path+pub.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")

	require.Equal(t, []string{"own.png", "hidden.txt", "public.txt"}, names(albumFiles(t, alice, trip.ID.String(), nil)))
	got := albumFiles(t, bob, trip.ID.String(), nil)
	require.Equal(t, []string{"own.png", "public.txt"}, names(got), "bob can't read #secret")
	require.Equal(t, "caption words", got.Items[1].Message.Content)

	var listed []albums.Album
	alice.Do(http.MethodGet, "/api/channels/"+g.String()+"/albums", nil, http.StatusOK, &listed)
	require.Len(t, listed[0].Deck, 1, "only images make the deck")
	require.Equal(t, own.ID, listed[0].Deck[0].ID)

	// Removing #general as a source hides its file from the album but keeps it counted.
	alice.Do(http.MethodPatch, "/api/channels/"+g.String(), map[string]any{"source_channel_ids": []string{secret.String()}}, http.StatusOK, nil)
	require.Equal(t, []string{"own.png", "hidden.txt"}, names(albumFiles(t, alice, trip.ID.String(), nil)))
	var a albums.Album
	alice.Do(http.MethodGet, "/api/albums/"+trip.ID.String(), nil, http.StatusOK, &a)
	require.Equal(t, 3, a.ItemCount)

	// Removing an item keeps the file.
	alice.Do(http.MethodDelete, path+hid.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"own.png"}, names(albumFiles(t, alice, trip.ID.String(), nil)))
	alice.Do(http.MethodGet, hid.URL, nil, http.StatusOK, nil)
}

func TestAlbumsForFile(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	memes := alice.CreateTextChannel("memes")
	withGeneral := alice.CreateGallery("all", "all")
	onlyMemes := alice.CreateGallery("memes-only", "selected", memes)
	a := create(t, alice, withGeneral, "A", "private")
	create(t, alice, onlyMemes, "B", "private")
	f := alice.Upload(general, "f.txt", []byte("x"), http.StatusCreated)
	alice.SendWith(general, "", f.ID)
	alice.Do(http.MethodPut, "/api/albums/"+a.ID.String()+"/files/"+f.ID.String(), nil, http.StatusNoContent, nil)

	var got []albums.Album
	alice.Do(http.MethodGet, "/api/albums?contains="+f.ID.String(), nil, http.StatusOK, &got)
	require.Equal(t, []string{"A"}, titles(got), "only albums whose gallery shows the file")
	require.True(t, *got[0].Contains)
	alice.Fail(http.MethodGet, "/api/albums", nil, http.StatusBadRequest, "VALIDATION_FAILED")
}

// Deleting a message deletes its files, which takes them out of any album.
func TestDeletedMessageLeavesAlbums(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	g := alice.CreateGallery("all", "all")
	f := alice.Upload(general, "pic.txt", []byte("x"), http.StatusCreated)
	m := alice.SendWith(general, "", f.ID)
	album := create(t, alice, g, "T", "private")
	alice.Do(http.MethodPut, "/api/albums/"+album.ID.String()+"/files/"+f.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+m.ID.String(), nil, http.StatusNoContent, nil)
	require.Empty(t, albumFiles(t, alice, album.ID.String(), nil).Items)
}
