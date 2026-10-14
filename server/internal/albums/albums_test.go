package albums_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/albums"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

func create(t *testing.T, c *apptest.Client, gallery id.ID, title, visibility string) albums.Album {
	t.Helper()
	var a albums.Album
	c.Do(http.MethodPost, "/api/channels/"+gallery.String()+"/albums", map[string]any{"title": title, "visibility": visibility}, http.StatusCreated, &a)
	return a
}

func list(t *testing.T, c *apptest.Client, gallery id.ID) []albums.Album {
	t.Helper()
	var out []albums.Album
	c.Do(http.MethodGet, "/api/channels/"+gallery.String()+"/albums", nil, http.StatusOK, &out)
	return out
}

func titles(as []albums.Album) []string {
	out := []string{}
	for _, a := range as {
		out = append(out, a.Title)
	}
	return out
}

func TestAlbumVisibility(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	g := alice.CreateGallery("photos", "")
	other := alice.CreateGallery("other", "")
	trip := create(t, alice, g, "Trip", "private")
	memes := create(t, alice, g, "Memes", "gallery")
	path := "/api/albums/" + trip.ID.String()

	require.Equal(t, "owner", trip.Role)
	require.Equal(t, g, trip.GalleryID)
	require.Equal(t, []string{"Memes", "Trip"}, titles(list(t, alice, g)), "most recently changed first")
	require.Empty(t, list(t, alice, other), "albums belong to one gallery")
	require.Equal(t, []string{"Memes"}, titles(list(t, bob, g)))
	bob.Fail(http.MethodGet, path, nil, http.StatusNotFound, "NOT_FOUND")

	alice.Do(http.MethodPut, path+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	var got albums.Album
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &got)
	require.Equal(t, "collaborator", got.Role)
	carol.Do(http.MethodGet, "/api/albums/"+memes.ID.String(), nil, http.StatusOK, &got)
	require.Equal(t, "viewer", got.Role)

	bob.Fail(http.MethodPatch, path, map[string]any{"title": "Mine"}, http.StatusForbidden, "MISSING_PERMISSION")
	carol.Fail(http.MethodPatch, path, map[string]any{"title": "Mine"}, http.StatusNotFound, "NOT_FOUND")
	alice.Do(http.MethodPatch, path, map[string]any{"title": "Lofoten", "visibility": "gallery"}, http.StatusOK, &got)
	require.Equal(t, "Lofoten", got.Title)
	carol.Do(http.MethodGet, path, nil, http.StatusOK, &got)
}

func TestAlbumFollowsGalleryAccess(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	srv := alice.Server()
	g := alice.CreateGallery("photos", "")
	shared := create(t, alice, g, "Shared", "gallery")

	// Hiding the gallery from @everyone hides its albums from bob, also as a collaborator.
	alice.Do(http.MethodPut, "/api/albums/"+shared.ID.String()+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, "/api/channels/"+g.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	bob.Fail(http.MethodGet, "/api/albums/"+shared.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodGet, "/api/channels/"+g.String()+"/albums", nil, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodPost, "/api/channels/"+g.String()+"/albums", map[string]any{"title": "x", "visibility": "private"}, http.StatusNotFound, "NOT_FOUND")

	// Not a gallery.
	alice.Fail(http.MethodPost, "/api/channels/"+alice.General().String()+"/albums", map[string]any{"title": "x", "visibility": "private"}, http.StatusBadRequest, "NOT_A_GALLERY")

	// Deleting the gallery deletes its albums.
	alice.Do(http.MethodDelete, "/api/channels/"+g.String(), nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodGet, "/api/albums/"+shared.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
}

func TestAlbumModerationDelete(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice") // server owner: has ManageMessages
	bob := env.Register("bob")
	g := alice.CreateGallery("photos", "")
	shared := create(t, bob, g, "Shared", "gallery")
	private := create(t, bob, g, "Private", "private")

	alice.Fail(http.MethodDelete, "/api/albums/"+private.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
	alice.Do(http.MethodDelete, "/api/albums/"+shared.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"Private"}, titles(list(t, bob, g)))
}

func TestAlbumLimitsAndValidation(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	g := alice.CreateGallery("photos", "")
	base := "/api/channels/" + g.String() + "/albums"
	alice.Fail(http.MethodPost, base, map[string]any{"title": "", "visibility": "private"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPost, base, map[string]any{"title": "x", "visibility": "server"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPost, base, map[string]any{"title": "   ", "visibility": "private"}, http.StatusBadRequest, "VALIDATION_FAILED")
	a := create(t, alice, g, "  Trip  ", "private")
	require.Equal(t, "Trip", a.Title)
	for i := 0; i < 99; i++ {
		create(t, alice, g, "a", "private")
	}
	alice.Fail(http.MethodPost, base, map[string]any{"title": "one more", "visibility": "private"}, http.StatusBadRequest, "ALBUMS_FULL")
}

func TestAlbumEventAudiences(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	bws, _ := bob.Connect()
	cws, _ := carol.Connect()
	g := alice.CreateGallery("photos", "")
	trip := create(t, alice, g, "Trip", "private")
	path := "/api/albums/" + trip.ID.String()
	alice.Do(http.MethodPut, path+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)

	var ev map[string]any
	bws.ExpectDispatch("ALBUM_UPDATE", &ev)
	cws.ExpectNoDispatch("ALBUM_UPDATE", 300*time.Millisecond)

	alice.Do(http.MethodPatch, path, map[string]any{"visibility": "gallery"}, http.StatusOK, nil)
	var got albums.Album
	cws.ExpectDispatch("ALBUM_UPDATE", &got)
	require.Empty(t, got.Deck)
	alice.Do(http.MethodPatch, path, map[string]any{"visibility": "private"}, http.StatusOK, nil)
	cws.ExpectDispatch("ALBUM_DELETE", &ev)
}
