package integrations_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/integrations"
)

func TestAlertAuditLog(t *testing.T) {
	env, f, alice := setupFeeds(t)
	general := alice.General()
	alerts := "/api/channels/" + general.String() + "/alerts"
	var a integrations.StreamAlert
	alice.Do(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": f.url()}, http.StatusCreated, &a)
	alice.Do(http.MethodDelete, alerts+"/"+a.ID.String(), nil, http.StatusNoContent, nil)

	rows, err := env.Pool.Query(t.Context(), `SELECT action, actor_id, target_id, details FROM audit_log WHERE action LIKE 'alert.%' ORDER BY id`)
	require.NoError(t, err)
	defer rows.Close()
	want := audit.LogDetails{Name: f.url(), Channel: &audit.LogRef{ID: general, Name: "general"}}
	var actions []audit.Action
	for rows.Next() {
		var action audit.Action
		var actor, target id.ID
		var raw []byte
		require.NoError(t, rows.Scan(&action, &actor, &target, &raw))
		var d audit.LogDetails
		require.NoError(t, json.Unmarshal(raw, &d))
		require.Equal(t, alice.User.ID, actor)
		require.Equal(t, a.ID, target)
		require.Equal(t, want, d)
		actions = append(actions, action)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []audit.Action{audit.AlertCreate, audit.AlertDelete}, actions)
}
