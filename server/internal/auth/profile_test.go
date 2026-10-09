package auth_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

func pngOf(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 99, 255})
		}
	}
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, img))
	return b.Bytes()
}

func TestProfileFields(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var me auth.User
	alice.Do(http.MethodPatch, "/api/users/@me",
		map[string]any{"pronouns": " she/her ", "about_me": "Board games, synths and too many houseplants."}, http.StatusOK, &me)
	require.Equal(t, "she/her", me.Pronouns)
	require.Equal(t, "Board games, synths and too many houseplants.", me.AboutMe)
	var ev auth.PublicUser
	ws.ExpectDispatch("USER_UPDATE", &ev)
	require.Equal(t, "she/her", ev.Pronouns)
	require.Equal(t, me.AboutMe, ev.AboutMe)

	// Limits count characters, not bytes.
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"about_me": strings.Repeat("é", 190)}, http.StatusOK, &me)
	alice.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"about_me": strings.Repeat("a", 191)}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"pronouns": strings.Repeat("a", 41)}, http.StatusBadRequest, "VALIDATION_FAILED")

	// Changing one field keeps the others; empty clears.
	me = auth.User{} // omitempty: a cleared field is absent, so decode into a fresh value
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"pronouns": ""}, http.StatusOK, &me)
	require.Empty(t, me.Pronouns)
	require.Equal(t, strings.Repeat("é", 190), me.AboutMe)

	// READY members carry the profile.
	_, ready := bob.Connect()
	found := false
	for _, m := range ready.Server.Members {
		if m.User.ID == alice.User.ID {
			found = true
			require.Equal(t, me.AboutMe, m.User.AboutMe)
		}
	}
	require.True(t, found)
}

func TestAvatar(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()
	put := func(name string, data []byte, status int) []byte {
		return alice.UploadTo(http.MethodPut, "/api/users/@me/avatar", name, data, status)
	}
	fail := func(name string, data []byte, status int, code string) {
		t.Helper()
		var e httpx.Error
		require.NoError(t, json.Unmarshal(put(name, data, status), &e))
		require.Equal(t, code, e.Code)
	}

	var me auth.User
	require.NoError(t, json.Unmarshal(put("me.png", pngOf(t, 256, 256), http.StatusOK), &me))
	require.True(t, strings.HasPrefix(me.AvatarURL, "/api/avatars/"+alice.User.ID.String()+"?v="), me.AvatarURL)
	var ev auth.PublicUser
	ws.ExpectDispatch("USER_UPDATE", &ev)
	require.Equal(t, me.AvatarURL, ev.AvatarURL)

	// Anyone can fetch it without a session; the versioned URL is immutable.
	resp, body := env.Anon().Raw(http.MethodGet, me.AvatarURL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Contains(t, resp.Header.Get("Cache-Control"), "immutable")
	require.NotEmpty(t, body)

	// A new image gets a new URL.
	old := me.AvatarURL
	require.NoError(t, json.Unmarshal(put("me2.png", pngOf(t, 128, 128), http.StatusOK), &me))
	require.NotEqual(t, old, me.AvatarURL)

	fail("wide.png", pngOf(t, 1025, 4), http.StatusBadRequest, "IMAGE_TOO_BIG")
	fail("a.txt", []byte("not an image"), http.StatusBadRequest, "NOT_AN_IMAGE")
	fail("huge.png", bytes.Repeat([]byte{0}, 600<<10), http.StatusRequestEntityTooLarge, "TOO_LARGE")

	// Remove goes back to initials.
	me = auth.User{} // omitempty: a removed avatar is absent
	alice.Do(http.MethodDelete, "/api/users/@me/avatar", nil, http.StatusOK, &me)
	require.Empty(t, me.AvatarURL)
	env.Anon().Raw(http.MethodGet, "/api/avatars/"+alice.User.ID.String(), nil, "", http.StatusNotFound)
	alice.Do(http.MethodDelete, "/api/users/@me/avatar", nil, http.StatusOK, &me) // already gone: still 200
}
