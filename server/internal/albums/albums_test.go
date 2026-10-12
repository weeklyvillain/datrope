package albums_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/albums"
	"github.com/datrope/datrope/server/internal/apptest"
)

func create(t *testing.T, c *apptest.Client, title, visibility string) albums.Album {
	t.Helper()
	var a albums.Album
	c.Do(http.MethodPost, "/api/albums", map[string]any{"title": title, "visibility": visibility}, http.StatusCreated, &a)
	return a
}

func list(t *testing.T, c *apptest.Client) []albums.Album {
	t.Helper()
	var out []albums.Album
	c.Do(http.MethodGet, "/api/albums", nil, http.StatusOK, &out)
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
	trip := create(t, alice, "Trip", "private")
	memes := create(t, alice, "Memes", "server")
	path := "/api/albums/" + trip.ID.String()

	require.Equal(t, "owner", trip.Role)
	require.Equal(t, []string{"Memes", "Trip"}, titles(list(t, alice)), "most recently changed first")
	require.Equal(t, []string{"Memes"}, titles(list(t, bob)))
	bob.Fail(http.MethodGet, path, nil, http.StatusNotFound, "NOT_FOUND")

	alice.Do(http.MethodPut, path+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	var got albums.Album
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &got)
	require.Equal(t, "collaborator", got.Role)
	carol.Do(http.MethodGet, "/api/albums/"+memes.ID.String(), nil, http.StatusOK, &got)
	require.Equal(t, "viewer", got.Role)

	// Only the owner renames; a collaborator gets 403, a stranger 404.
	bob.Fail(http.MethodPatch, path, map[string]any{"title": "Mine"}, http.StatusForbidden, "MISSING_PERMISSION")
	carol.Fail(http.MethodPatch, path, map[string]any{"title": "Mine"}, http.StatusNotFound, "NOT_FOUND")
	alice.Do(http.MethodPatch, path, map[string]any{"title": "Lofoten", "visibility": "server"}, http.StatusOK, &got)
	require.Equal(t, "Lofoten", got.Title)
	carol.Do(http.MethodGet, path, nil, http.StatusOK, &got)

	// A collaborator can leave; then the album is just server-visible to them.
	bob.Do(http.MethodDelete, path+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &got)
	require.Equal(t, "viewer", got.Role)
}

func TestAlbumNeedsServerMembership(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	trip := create(t, alice, "Trip", "private")
	path := "/api/albums/" + trip.ID.String()
	alice.Do(http.MethodPut, path+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)

	alice.Do(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil) // kick
	bob.Fail(http.MethodGet, path, nil, http.StatusNotFound, "NOT_FOUND")
	require.Empty(t, list(t, bob))
}

func TestAlbumModerationDelete(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice") // owner of the server: has ManageMessages
	bob := env.Register("bob")
	shared := create(t, bob, "Shared", "server")
	private := create(t, bob, "Private", "private")

	alice.Fail(http.MethodDelete, "/api/albums/"+private.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
	alice.Do(http.MethodDelete, "/api/albums/"+shared.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"Private"}, titles(list(t, bob)))

	var log struct {
		Entries []struct {
			Action string `json:"action"`
		} `json:"entries"`
	}
	alice.Do(http.MethodGet, "/api/server/audit-log", nil, http.StatusOK, &log)
	require.NotEmpty(t, log.Entries)
	require.Equal(t, "album.delete", log.Entries[0].Action)
}

func TestAlbumLimitsAndValidation(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	// huma validation failures are mapped to 400 by httpx.
	alice.Fail(http.MethodPost, "/api/albums", map[string]any{"title": "", "visibility": "private"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPost, "/api/albums", map[string]any{"title": "x", "visibility": "public"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPost, "/api/albums", map[string]any{"title": "   ", "visibility": "private"}, http.StatusBadRequest, "VALIDATION_FAILED")
	a := create(t, alice, "  Trip  ", "private")
	require.Equal(t, "Trip", a.Title)
	alice.Fail(http.MethodPatch, "/api/albums/"+a.ID.String(), map[string]any{"title": " 	 "}, http.StatusBadRequest, "VALIDATION_FAILED")
	for i := 0; i < 99; i++ {
		create(t, alice, "a", "private")
	}
	alice.Fail(http.MethodPost, "/api/albums", map[string]any{"title": "one more", "visibility": "private"}, http.StatusBadRequest, "ALBUMS_FULL")
}

func TestAlbumEventAudiences(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	bws, _ := bob.Connect()
	cws, _ := carol.Connect()
	trip := create(t, alice, "Trip", "private")
	path := "/api/albums/" + trip.ID.String()
	alice.Do(http.MethodPut, path+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)

	var ev map[string]any
	bws.ExpectDispatch("ALBUM_UPDATE", &ev) // added as collaborator
	alice.Do(http.MethodPatch, path, map[string]any{"title": "Lofoten"}, http.StatusOK, nil)
	var got albums.Album
	bws.ExpectDispatch("ALBUM_UPDATE", &got)
	require.Equal(t, "Lofoten", got.Title)
	require.Nil(t, got.Cover)
	cws.ExpectNoDispatch("ALBUM_UPDATE", 300*time.Millisecond)

	// private -> server: everyone hears the update; server -> private: those who lose it hear a delete.
	alice.Do(http.MethodPatch, path, map[string]any{"visibility": "server"}, http.StatusOK, nil)
	cws.ExpectDispatch("ALBUM_UPDATE", &got)
	alice.Do(http.MethodPatch, path, map[string]any{"visibility": "private"}, http.StatusOK, nil)
	cws.ExpectDispatch("ALBUM_DELETE", &ev)
	bws.ExpectDispatch("ALBUM_UPDATE", &got) // bob also got the visibility changes; drain them
	bws.ExpectDispatch("ALBUM_UPDATE", &got)

	// A kicked collaborator hears nothing more.
	alice.Do(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPatch, path, map[string]any{"title": "Again"}, http.StatusOK, nil)
	bws.ExpectNoDispatch("ALBUM_UPDATE", 300*time.Millisecond)
}
