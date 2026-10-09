package expressions_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/expressions"
)

func pngBytes(t *testing.T, size int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func upload(t *testing.T, c *apptest.Client, name string, data []byte, want int) []byte {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	require.NoError(t, mw.WriteField("name", name))
	fw, err := mw.CreateFormFile("file", name+".png")
	require.NoError(t, err)
	_, _ = fw.Write(data)
	require.NoError(t, mw.Close())
	_, raw := c.Raw(http.MethodPost, "/api/server/emoji", &body, mw.FormDataContentType(), want)
	return raw
}

func TestEmojiLifecycle(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var e expressions.Emoji
	require.NoError(t, json.Unmarshal(upload(t, alice, "party_parrot", pngBytes(t, 32), http.StatusCreated), &e))
	require.Equal(t, "party_parrot", e.Name)
	require.Equal(t, "/api/emoji/"+e.ID.String(), e.URL)
	var ev expressions.EmojiUpdate
	ws.ExpectDispatch("EMOJI_UPDATE", &ev)
	require.Len(t, ev.Emoji, 1)

	res, _ := env.Anon().Raw(http.MethodGet, e.URL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", res.Header.Get("Content-Type"))

	var list []expressions.Emoji
	bob.Do(http.MethodGet, "/api/server/emoji", nil, http.StatusOK, &list)
	require.Len(t, list, 1)
	_, ready := bob.Connect()
	require.Len(t, ready.Emoji, 1)

	// Names: valid, unique case-insensitively.
	upload(t, alice, "bad name", pngBytes(t, 8), http.StatusBadRequest)
	upload(t, alice, "PARTY_parrot", pngBytes(t, 8), http.StatusConflict)
	upload(t, bob, "mine", pngBytes(t, 8), http.StatusForbidden)
	upload(t, alice, "big", bytes.Repeat([]byte{0}, 300<<10), http.StatusRequestEntityTooLarge)
	upload(t, alice, "text", []byte("hello"), http.StatusBadRequest)

	alice.Do(http.MethodPatch, "/api/server/emoji/"+e.ID.String(), map[string]any{"name": "parrot"}, http.StatusOK, &e)
	require.Equal(t, "parrot", e.Name)

	// Reactions with the custom emoji, and their removal with it.
	general := alice.General()
	m := alice.Send(general, "nice")
	path := "/api/channels/" + general.String() + "/messages/" + m.ID.String() + "/reactions/" + url.PathEscape("custom:"+e.ID.String())
	bob.Do(http.MethodPut, path, nil, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, "/api/server/emoji/"+e.ID.String(), nil, http.StatusNoContent, nil)
	var page []struct {
		Reactions []any `json:"reactions"`
	}
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &page)
	require.Empty(t, page[0].Reactions)
	bob.Fail(http.MethodPut, path, nil, http.StatusBadRequest, "INVALID_EMOJI")
	env.Anon().Raw(http.MethodGet, e.URL, nil, "", http.StatusNotFound)
}

func TestEmojiLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	_, err := env.Pool.Exec(t.Context(), `
		INSERT INTO emoji (id, name, sha256, content_type, creator_id)
		SELECT g, 'e' || g, repeat('a', 64), 'image/png', $1 FROM generate_series(1, 200) g`, alice.User.ID)
	require.NoError(t, err)
	upload(t, alice, "one_more", pngBytes(t, 8), http.StatusBadRequest)
}
