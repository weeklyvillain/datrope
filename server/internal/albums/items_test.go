package albums_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
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

func uploadTo(t *testing.T, c *apptest.Client, albumID, name string, want int) files.Attachment {
	t.Helper()
	raw := c.UploadTo(http.MethodPost, "/api/attachments?album_id="+albumID, name, []byte("hello "+name), want)
	var a files.Attachment
	if want == http.StatusCreated {
		require.NoError(t, jsonUnmarshal(raw, &a))
	}
	return a
}

func TestAlbumChannelFiles(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	srv := alice.Server()
	secret := alice.CreateTextChannel("secret")
	alice.Do(http.MethodPut, "/api/channels/"+secret.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)
	pub := alice.Upload(general, "public.txt", []byte("hi"), http.StatusCreated)
	alice.SendWith(general, "caption words", pub.ID)
	hid := alice.Upload(secret, "hidden.txt", []byte("psst"), http.StatusCreated)
	alice.SendWith(secret, "", hid.ID)
	unsent := alice.Upload(general, "unsent.txt", []byte("x"), http.StatusCreated)

	trip := create(t, alice, "Trip", "server")
	path := "/api/albums/" + trip.ID.String() + "/files/"
	alice.Do(http.MethodPut, path+pub.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, path+pub.ID.String(), nil, http.StatusNoContent, nil) // again: no change
	alice.Do(http.MethodPut, path+hid.ID.String(), nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodPut, path+unsent.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodPut, path+pub.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")

	require.Equal(t, []string{"hidden.txt", "public.txt"}, names(albumFiles(t, alice, trip.ID.String(), nil)))
	got := albumFiles(t, bob, trip.ID.String(), nil)
	require.Equal(t, []string{"public.txt"}, names(got), "bob can't read #secret")
	require.Equal(t, "caption words", got.Items[0].Message.Content)
	require.Equal(t, "general", got.Items[0].Channel.Name)
	require.Equal(t, alice.User.ID, got.Items[0].UploaderID)
	require.Equal(t, []string{"public.txt"}, names(albumFiles(t, alice, trip.ID.String(), url.Values{"q": {"caption"}})))

	var a struct {
		ItemCount int `json:"item_count"`
	}
	bob.Do(http.MethodGet, "/api/albums/"+trip.ID.String(), nil, http.StatusOK, &a)
	require.Equal(t, 2, a.ItemCount, "the count includes files bob can't see")

	// Removing a channel file takes it out of the album but keeps the file.
	alice.Do(http.MethodDelete, "/api/albums/"+trip.ID.String()+"/files/"+pub.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"hidden.txt"}, names(albumFiles(t, alice, trip.ID.String(), nil)))
	alice.Do(http.MethodGet, pub.URL, nil, http.StatusOK, nil) // removing a channel file keeps the file
}

func TestAlbumUploads(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	trip := create(t, alice, "Trip", "private")
	aid := trip.ID.String()
	alice.Do(http.MethodPut, "/api/albums/"+aid+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)

	up := uploadTo(t, bob, aid, "beach.txt", http.StatusCreated)
	require.NotNil(t, up.AlbumID)
	require.Nil(t, up.ChannelID)
	carol.UploadTo(http.MethodPost, "/api/attachments?album_id="+aid, "nope.txt", []byte("x"), http.StatusNotFound)

	got := albumFiles(t, alice, aid, nil)
	require.Equal(t, []string{"beach.txt"}, names(got))
	require.Nil(t, got.Items[0].Message)
	require.Nil(t, got.Items[0].Channel)
	require.Equal(t, bob.User.ID, got.Items[0].UploaderID)

	// Downloads follow the album, also after visibility changes.
	alice.Do(http.MethodGet, up.URL, nil, http.StatusOK, nil)
	carol.Fail(http.MethodGet, up.URL, nil, http.StatusNotFound, "NOT_FOUND")
	alice.Do(http.MethodPatch, "/api/albums/"+aid, map[string]any{"visibility": "server"}, http.StatusOK, nil)
	carol.Do(http.MethodGet, up.URL, nil, http.StatusOK, nil)
	alice.Do(http.MethodPatch, "/api/albums/"+aid, map[string]any{"visibility": "private"}, http.StatusOK, nil)
	carol.Fail(http.MethodGet, up.URL, nil, http.StatusNotFound, "NOT_FOUND")

	// Never in the global gallery, and never swept.
	var all messages.FilesPage
	alice.Do(http.MethodGet, "/api/files", nil, http.StatusOK, &all)
	require.Empty(t, all.Items)
	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now().Add(48*time.Hour)))
	alice.Do(http.MethodGet, up.URL, nil, http.StatusOK, nil)

	// Kicked from the server: no more access, even as a listed collaborator.
	alice.Do(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodGet, up.URL, nil, http.StatusNotFound, "NOT_FOUND")

	// Removing an album upload deletes the file.
	alice.Do(http.MethodDelete, "/api/albums/"+aid+"/files/"+up.ID.String(), nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodGet, up.URL, nil, http.StatusNotFound, "NOT_FOUND")

	// Deleting the album deletes its uploads.
	second := uploadTo(t, alice, aid, "second.txt", http.StatusCreated)
	alice.Do(http.MethodDelete, "/api/albums/"+aid, nil, http.StatusNoContent, nil)
	var n int
	require.NoError(t, env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM attachments WHERE id = $1`, second.ID).Scan(&n))
	require.Zero(t, n)
}

func TestAlbumItemEvents(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	trip := create(t, alice, "Trip", "private")
	ws, _ := bob.Connect()
	defer ws.Close()

	uploadTo(t, alice, trip.ID.String(), "a.txt", http.StatusCreated)
	ws.ExpectNoDispatch("ALBUM_ITEMS_UPDATE", 300*time.Millisecond) // private: bob isn't told

	alice.Do(http.MethodPatch, "/api/albums/"+trip.ID.String(), map[string]any{"visibility": "server"}, http.StatusOK, nil)
	var upd struct {
		ID string `json:"id"`
	}
	ws.ExpectDispatch("ALBUM_UPDATE", &upd)
	require.Equal(t, trip.ID.String(), upd.ID)
	uploadTo(t, alice, trip.ID.String(), "b.txt", http.StatusCreated)
	var items struct {
		AlbumID string `json:"album_id"`
	}
	ws.ExpectDispatch("ALBUM_ITEMS_UPDATE", &items)
	require.Equal(t, trip.ID.String(), items.AlbumID)

	alice.Do(http.MethodPatch, "/api/albums/"+trip.ID.String(), map[string]any{"visibility": "private"}, http.StatusOK, nil)
	var del struct {
		ID string `json:"id"`
	}
	ws.ExpectDispatch("ALBUM_DELETE", &del)
	require.Equal(t, trip.ID.String(), del.ID)
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
