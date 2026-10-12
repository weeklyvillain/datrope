package webhooks_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/id"
)

type auditEntry struct {
	Action  audit.Action
	Target  id.ID
	Details audit.LogDetails
}

// webhookAudit lists the webhook.* entries, oldest first.
func webhookAudit(t *testing.T, env *apptest.Env) []auditEntry {
	t.Helper()
	rows, err := env.Pool.Query(t.Context(), `SELECT action, coalesce(target_id, 0), details FROM audit_log WHERE action LIKE 'webhook.%' ORDER BY id`)
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

func TestWebhookAuditLog(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	ch := webhookChannel(t, alice, "alerts")
	w, _ := newWebhook(t, alice, ch, "CI")
	hook := "/api/webhooks/" + w.ID.String()

	alice.Do(http.MethodPatch, hook, map[string]any{"name": "CI"}, http.StatusOK, nil) // unchanged: not logged
	alice.Do(http.MethodPatch, hook, map[string]any{"name": "Deploys"}, http.StatusOK, nil)
	alice.Do(http.MethodPost, hook+"/token", nil, http.StatusOK, nil)
	alice.UploadTo(http.MethodPut, hook+"/avatar", "a.png", pngOf(t, 16, 16), http.StatusOK)
	alice.Do(http.MethodDelete, hook+"/avatar", nil, http.StatusOK, nil)
	alice.Do(http.MethodDelete, hook+"/avatar", nil, http.StatusOK, nil) // none left: not logged
	alice.Do(http.MethodDelete, hook, nil, http.StatusNoContent, nil)

	where := &audit.LogRef{ID: ch, Name: "alerts"}
	entry := func(a audit.Action, name string, cs ...audit.LogChange) auditEntry {
		return auditEntry{Action: a, Target: w.ID, Details: audit.LogDetails{Name: name, Channel: where, Changes: cs}}
	}
	require.Equal(t, []auditEntry{
		entry(audit.WebhookCreate, "CI"),
		entry(audit.WebhookUpdate, "Deploys", audit.LogChange{Field: "name", Old: "CI", New: "Deploys"}),
		entry(audit.WebhookUpdate, "Deploys", audit.LogChange{Field: "token"}),
		entry(audit.WebhookUpdate, "Deploys", audit.LogChange{Field: "avatar"}),
		entry(audit.WebhookUpdate, "Deploys", audit.LogChange{Field: "avatar"}),
		entry(audit.WebhookDelete, "Deploys"),
	}, webhookAudit(t, env))
}
