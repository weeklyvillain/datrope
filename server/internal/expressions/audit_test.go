package expressions_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/expressions"
	"github.com/datrope/datrope/server/internal/id"
)

type auditEntry struct {
	Action  audit.Action
	Target  id.ID
	Details audit.LogDetails
}

func auditLog(t *testing.T, env *apptest.Env) []auditEntry {
	t.Helper()
	rows, err := env.Pool.Query(t.Context(), `SELECT action, coalesce(target_id, 0), details FROM audit_log ORDER BY id`)
	require.NoError(t, err)
	defer rows.Close()
	var out []auditEntry
	for rows.Next() {
		var e auditEntry
		var raw []byte
		require.NoError(t, rows.Scan(&e.Action, &e.Target, &raw))
		require.NoError(t, json.Unmarshal(raw, &e.Details))
		out = append(out, e)
	}
	require.NoError(t, rows.Err())
	return out
}

func TestEmojiAuditLog(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")

	var e expressions.Emoji
	require.NoError(t, json.Unmarshal(upload(t, alice, "parrot", pngBytes(t, 8), http.StatusCreated), &e))
	upload(t, alice, "PARROT", pngBytes(t, 8), http.StatusConflict) // refused: not logged
	path := "/api/server/emoji/" + e.ID.String()
	alice.Do(http.MethodPatch, path, map[string]any{"name": "party_parrot"}, http.StatusOK, nil)
	alice.Do(http.MethodPatch, path, map[string]any{"name": "party_parrot"}, http.StatusOK, nil) // no change: not logged
	alice.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil)

	require.Equal(t, []auditEntry{
		{audit.EmojiCreate, e.ID, audit.LogDetails{Name: "parrot"}},
		{audit.EmojiUpdate, e.ID, audit.LogDetails{Name: "party_parrot", Changes: []audit.LogChange{{Field: "name", Old: "parrot", New: "party_parrot"}}}},
		{audit.EmojiDelete, e.ID, audit.LogDetails{Name: "party_parrot"}},
	}, auditLog(t, env))
}

func TestSoundAuditLog(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")

	var s expressions.Sound
	require.NoError(t, json.Unmarshal(uploadSound(t, alice, "Airhorn", "🎺", expressions.WAV(time.Second), http.StatusCreated), &s))
	path := "/api/server/sounds/" + s.ID.String()
	alice.Do(http.MethodPatch, path, map[string]any{"name": "Horn", "emoji": "📯"}, http.StatusOK, nil)
	alice.Do(http.MethodPatch, path, map[string]any{"emoji": "📯"}, http.StatusOK, nil) // no change: not logged
	alice.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil)

	require.Equal(t, []auditEntry{
		{audit.SoundCreate, s.ID, audit.LogDetails{Name: "Airhorn"}},
		{audit.SoundUpdate, s.ID, audit.LogDetails{Name: "Horn", Changes: []audit.LogChange{
			{Field: "name", Old: "Airhorn", New: "Horn"},
			{Field: "emoji", Old: "🎺", New: "📯"},
		}}},
		{audit.SoundDelete, s.ID, audit.LogDetails{Name: "Horn"}},
	}, auditLog(t, env))
}
