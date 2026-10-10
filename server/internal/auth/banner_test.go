package auth_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"math/rand"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

func TestBanner(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()
	put := func(c *apptest.Client, name string, data []byte, status int) []byte {
		return c.UploadTo(http.MethodPut, "/api/users/@me/banner", name, data, status)
	}
	fail := func(name string, data []byte, status int, code string) {
		t.Helper()
		var e httpx.Error
		require.NoError(t, json.Unmarshal(put(alice, name, data, status), &e))
		require.Equal(t, code, e.Code)
	}

	var me auth.User
	require.NoError(t, json.Unmarshal(put(alice, "b.png", pngOf(t, 960, 320), http.StatusOK), &me))
	require.True(t, strings.HasPrefix(me.BannerURL, "/api/banners/"+alice.User.ID.String()+"?v="), me.BannerURL)
	require.Empty(t, me.AvatarURL) // the avatar is untouched
	var ev auth.PublicUser
	ws.ExpectDispatch("USER_UPDATE", &ev)
	require.Equal(t, me.BannerURL, ev.BannerURL)

	// Anyone can fetch it without a session.
	resp, body := env.Anon().Raw(http.MethodGet, me.BannerURL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
	require.Contains(t, resp.Header.Get("Cache-Control"), "immutable")
	require.NotEmpty(t, body)

	fail("wide.png", pngOf(t, 3000, 100), http.StatusBadRequest, "IMAGE_TOO_BIG")
	fail("a.txt", []byte("not an image"), http.StatusBadRequest, "NOT_AN_IMAGE")
	fail("huge.png", bytes.Repeat([]byte{0}, 5300<<10), http.StatusRequestEntityTooLarge, "TOO_LARGE")

	// Another user's delete only touches their own banner.
	var other auth.User
	bob.Do(http.MethodDelete, "/api/users/@me/banner", nil, http.StatusOK, &other)
	env.Anon().Raw(http.MethodGet, me.BannerURL, nil, "", http.StatusOK)

	// Remove goes back to the colour fallback.
	me = auth.User{}
	alice.Do(http.MethodDelete, "/api/users/@me/banner", nil, http.StatusOK, &me)
	require.Empty(t, me.BannerURL)
	env.Anon().Raw(http.MethodGet, "/api/banners/"+alice.User.ID.String(), nil, "", http.StatusNotFound)
	alice.Do(http.MethodDelete, "/api/users/@me/banner", nil, http.StatusOK, &me) // already gone: still 200
}

func TestProfileLinks(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var me auth.User
	alice.Do(http.MethodPatch, "/api/users/@me",
		map[string]any{"links": []string{" https://github.com/alice ", "", "https://github.com/alice", "https://example.com"}}, http.StatusOK, &me)
	require.Equal(t, []string{"https://github.com/alice", "https://example.com"}, me.Links)
	var ev auth.PublicUser
	ws.ExpectDispatch("USER_UPDATE", &ev)
	require.Equal(t, me.Links, ev.Links)

	// Other fields leave the links alone.
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"pronouns": "she/her"}, http.StatusOK, &me)
	require.Len(t, me.Links, 2)

	// READY carries them.
	_, ready := bob.Connect()
	for _, m := range ready.Server.Members {
		if m.User.ID == alice.User.ID {
			require.Equal(t, me.Links, m.User.Links)
		}
	}

	alice.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"links": []string{"http://example.com"}}, http.StatusBadRequest, "BAD_LINK")
	alice.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"links": []string{"https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com", "https://f.com"}}, http.StatusBadRequest, "BAD_LINK")
	alice.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"links": make([]string, 11)}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"links": []string{"https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com", ""}}, http.StatusOK, &me)
	require.Len(t, me.Links, 5)

	// An empty list clears them.
	me = auth.User{}
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"links": []string{}}, http.StatusOK, &me)
	require.Empty(t, me.Links)
}

// noisePNG is incompressible, so its size is close to w*h*4 bytes.
func noisePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	rand.New(rand.NewSource(1)).Read(img.Pix)
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, img))
	return b.Bytes()
}

func TestBannerLimits(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	put := func(c *apptest.Client, data []byte, status int) []byte {
		return c.UploadTo(http.MethodPut, "/api/users/@me/banner", "b.png", data, status)
	}

	// Bigger than an avatar may be (> 2 MB, > 1024 px), within the banner limits.
	big := noisePNG(t, 2000, 300)
	require.Greater(t, len(big), auth.MaxAvatarBytes)
	require.Less(t, len(big), auth.MaxBannerBytes)
	put(alice, big, http.StatusOK)

	var e httpx.Error
	require.NoError(t, json.Unmarshal(put(alice, pngOf(t, 2049, 10), http.StatusBadRequest), &e))
	require.Equal(t, "IMAGE_TOO_BIG", e.Code)

	// Not signed in.
	put(env.Anon(), pngOf(t, 960, 320), http.StatusUnauthorized)
	env.Anon().Do(http.MethodDelete, "/api/users/@me/banner", nil, http.StatusUnauthorized, nil)
}
