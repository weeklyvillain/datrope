package files_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/communities"
)

func TestServerIcon(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	icon := pngWithText(pngImage(64, 64, false), "Comment", "secret")
	alice.UploadTo(http.MethodPut, "/api/server/icon", "icon.png", icon, http.StatusOK)
	var ev communities.Server
	ws.ExpectDispatch("SERVER_UPDATE", &ev)
	require.NotNil(t, ev.IconURL)
	require.True(t, strings.HasPrefix(*ev.IconURL, "/api/server/icon?v="))

	res, data := env.Anon().Raw(http.MethodGet, *ev.IconURL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", res.Header.Get("Content-Type"))
	require.NotContains(t, string(data), "secret", "metadata is stripped")

	bob.UploadTo(http.MethodPut, "/api/server/icon", "icon.png", pngImage(8, 8, false), http.StatusForbidden)
	alice.UploadTo(http.MethodPut, "/api/server/banner", "banner.png", []byte("not an image"), http.StatusBadRequest)

	alice.UploadTo(http.MethodPut, "/api/server/banner", "banner.gif", []byte("GIF89a junk"), http.StatusBadRequest)

	alice.Raw(http.MethodDelete, "/api/server/icon", nil, "", http.StatusNoContent)
	require.Nil(t, alice.Server().IconURL)
	env.Anon().Raw(http.MethodGet, "/api/server/icon", nil, "", http.StatusNotFound)
}

func TestServerPageImages(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	raw := alice.UploadTo(http.MethodPost, "/api/server/images", "pic.png", pngImage(32, 32, false), http.StatusCreated)
	var out struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal(raw, &out))
	require.Equal(t, "/api/server/images/"+out.ID, out.URL)
	env.Anon().Raw(http.MethodGet, out.URL, nil, "", http.StatusOK)
}

func TestServerImageAuditLog(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.UploadTo(http.MethodPut, "/api/server/icon", "icon.png", pngImage(16, 16, false), http.StatusOK)
	alice.UploadTo(http.MethodPost, "/api/server/images", "pic.png", pngImage(16, 16, false), http.StatusCreated) // page image: not logged
	alice.UploadTo(http.MethodPut, "/api/server/banner", "banner.png", []byte("not an image"), http.StatusBadRequest)
	alice.Raw(http.MethodDelete, "/api/server/icon", nil, "", http.StatusNoContent)

	rows, err := env.Pool.Query(t.Context(), `SELECT action, target_id IS NULL, details FROM audit_log ORDER BY id`)
	require.NoError(t, err)
	defer rows.Close()
	var got []audit.LogDetails
	for rows.Next() {
		var action audit.Action
		var noTarget bool
		var raw []byte
		require.NoError(t, rows.Scan(&action, &noTarget, &raw))
		require.Equal(t, audit.ServerUpdate, action)
		require.True(t, noTarget)
		var d audit.LogDetails
		require.NoError(t, json.Unmarshal(raw, &d))
		got = append(got, d)
	}
	require.NoError(t, rows.Err())
	icon := audit.LogDetails{Changes: []audit.LogChange{{Field: "icon"}}}
	require.Equal(t, []audit.LogDetails{icon, icon}, got)
}

func TestServerIconAppSizes(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	env.Anon().Raw(http.MethodGet, "/api/server/icon/192.png", nil, "", http.StatusNotFound)

	alice.UploadTo(http.MethodPut, "/api/server/icon", "icon.png", pngImage(300, 200, true), http.StatusOK)
	for name, size := range map[string]int{"192.png": 192, "512.png": 512, "maskable-512.png": 512} {
		res, data := env.Anon().Raw(http.MethodGet, "/api/server/icon/"+name, nil, "", http.StatusOK)
		require.Equal(t, "image/png", res.Header.Get("Content-Type"), name)
		img, err := png.Decode(bytes.NewReader(data))
		require.NoError(t, err, name)
		require.Equal(t, image.Rect(0, 0, size, size), img.Bounds(), "%s is square at its listed size", name)
		_, _, _, a := img.At(0, 0).RGBA()
		require.Equal(t, name == "maskable-512.png", a == 0xffff, "%s: only the maskable icon has an opaque background", name)
	}
	env.Anon().Raw(http.MethodGet, "/api/server/icon/64.png", nil, "", http.StatusNotFound)
}
