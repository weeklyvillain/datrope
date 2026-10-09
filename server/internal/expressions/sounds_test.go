package expressions_test

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/expressions"
	"github.com/datrope/datrope/server/internal/httpx"
)

func uploadSound(t *testing.T, c *apptest.Client, name, emoji string, data []byte, want int) []byte {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	require.NoError(t, mw.WriteField("name", name))
	require.NoError(t, mw.WriteField("emoji", emoji))
	fw, err := mw.CreateFormFile("file", "sound.wav")
	require.NoError(t, err)
	_, _ = fw.Write(data)
	require.NoError(t, mw.Close())
	_, raw := c.Raw(http.MethodPost, "/api/server/sounds", &body, mw.FormDataContentType(), want)
	return raw
}

func uploadSoundFail(t *testing.T, c *apptest.Client, name, emoji string, data []byte, want int, code string) {
	t.Helper()
	var e httpx.Error
	require.NoError(t, json.Unmarshal(uploadSound(t, c, name, emoji, data, want), &e))
	require.Equal(t, code, e.Code)
}

func TestSoundLifecycle(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var s expressions.Sound
	require.NoError(t, json.Unmarshal(uploadSound(t, alice, "Airhorn", "🎺", expressions.WAV(time.Second), http.StatusCreated), &s))
	require.Equal(t, "Airhorn", s.Name)
	require.Equal(t, "🎺", s.Emoji)
	require.InDelta(t, 1000, s.DurationMs, 10)
	require.Equal(t, "/api/sounds/"+s.ID.String(), s.URL)
	require.NotNil(t, s.CreatorID)
	var ev expressions.SoundUpdate
	ws.ExpectDispatch("SOUND_UPDATE", &ev)
	require.Len(t, ev.Sounds, 1)

	res, _ := env.Anon().Raw(http.MethodGet, s.URL, nil, "", http.StatusOK)
	require.Equal(t, "audio/wav", res.Header.Get("Content-Type"))

	var list []expressions.Sound
	bob.Do(http.MethodGet, "/api/server/sounds", nil, http.StatusOK, &list)
	require.Len(t, list, 1)
	_, ready := bob.Connect()
	require.Len(t, ready.Sounds, 1)

	uploadSoundFail(t, alice, "Long", "🎺", expressions.WAV(6*time.Second), http.StatusBadRequest, "TOO_LONG")
	uploadSoundFail(t, alice, "Text", "🎺", []byte("hello, not audio"), http.StatusBadRequest, "NOT_AUDIO")
	uploadSoundFail(t, alice, "Big", "🎺", bytes.Repeat([]byte{0}, 600<<10), http.StatusRequestEntityTooLarge, "TOO_LARGE")
	uploadSoundFail(t, alice, "Lol", "lol", expressions.WAV(time.Second), http.StatusBadRequest, "INVALID_EMOJI")
	uploadSoundFail(t, alice, "  ", "🎺", expressions.WAV(time.Second), http.StatusBadRequest, "VALIDATION_FAILED")
	uploadSoundFail(t, alice, "abcdefghijklmnopqrstuvwxyz0123456", "🎺", expressions.WAV(time.Second), http.StatusBadRequest, "VALIDATION_FAILED")
	uploadSound(t, bob, "Mine", "🎺", expressions.WAV(time.Second), http.StatusForbidden)

	path := "/api/server/sounds/" + s.ID.String()
	alice.Do(http.MethodPatch, path, map[string]any{"name": "Horn"}, http.StatusOK, &s)
	require.Equal(t, "Horn", s.Name)
	require.Equal(t, "🎺", s.Emoji)
	ws.ExpectDispatch("SOUND_UPDATE", &ev)
	require.Equal(t, "Horn", ev.Sounds[0].Name)
	alice.Do(http.MethodPatch, path, map[string]any{"emoji": "📯"}, http.StatusOK, &s)
	require.Equal(t, "Horn", s.Name)
	require.Equal(t, "📯", s.Emoji)
	ws.ExpectDispatch("SOUND_UPDATE", &ev)
	require.Equal(t, "📯", ev.Sounds[0].Emoji)
	alice.Do(http.MethodPatch, path, map[string]any{}, http.StatusOK, &s) // nothing to change: no broadcast
	require.Equal(t, "Horn", s.Name)
	ws.ExpectNoDispatch("SOUND_UPDATE", 300*time.Millisecond)
	alice.Fail(http.MethodPatch, path, map[string]any{"emoji": "lol"}, http.StatusBadRequest, "INVALID_EMOJI")
	alice.Fail(http.MethodPatch, path, map[string]any{"name": " "}, http.StatusBadRequest, "VALIDATION_FAILED")
	bob.Fail(http.MethodPatch, path, map[string]any{"name": "Bob"}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodDelete, path, nil, http.StatusForbidden, "MISSING_PERMISSION")

	alice.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil)
	ws.ExpectDispatch("SOUND_UPDATE", &ev)
	require.Empty(t, ev.Sounds)
	env.Anon().Raw(http.MethodGet, s.URL, nil, "", http.StatusNotFound)
	alice.Fail(http.MethodDelete, path, nil, http.StatusNotFound, "NOT_FOUND")
	bob.Do(http.MethodGet, "/api/server/sounds", nil, http.StatusOK, &list)
	require.Empty(t, list)
}

func TestSoundLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	_, err := env.Pool.Exec(t.Context(), `
		INSERT INTO sounds (id, name, emoji, sha256, content_type, duration_ms, creator_id)
		SELECT g, 's' || g, '🎺', repeat('a', 64), 'audio/wav', 1000, $1 FROM generate_series(1, 100) g`, alice.User.ID)
	require.NoError(t, err)
	uploadSoundFail(t, alice, "One more", "🎺", expressions.WAV(time.Second), http.StatusBadRequest, "SOUND_LIMIT")
}
