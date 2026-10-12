package messages_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
)

type auditEntry struct {
	Action  audit.Action
	Actor   id.ID
	Target  id.ID
	Details audit.LogDetails
}

// messageAudit lists the message.* entries, oldest first.
func messageAudit(t *testing.T, env *apptest.Env) []auditEntry {
	t.Helper()
	rows, err := env.Pool.Query(t.Context(), `SELECT action, actor_id, coalesce(target_id, 0), details FROM audit_log WHERE action LIKE 'message.%' ORDER BY id`)
	require.NoError(t, err)
	defer rows.Close()
	var out []auditEntry
	for rows.Next() {
		var e auditEntry
		var raw []byte
		require.NoError(t, rows.Scan(&e.Action, &e.Actor, &e.Target, &raw))
		require.NoError(t, json.Unmarshal(raw, &e.Details))
		out = append(out, e)
	}
	require.NoError(t, rows.Err())
	return out
}

func TestMessageAuditLog(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	where := &audit.LogRef{ID: general, Name: "general"}
	msg := func(m messages.Message) string {
		return "/api/channels/" + general.String() + "/messages/" + m.ID.String()
	}
	pin := func(m messages.Message) string { return "/api/channels/" + general.String() + "/pins/" + m.ID.String() }

	// Deleting your own message is not moderation.
	own := alice.Send(general, "mine")
	alice.Do(http.MethodDelete, msg(own), nil, http.StatusNoContent, nil)
	require.Empty(t, messageAudit(t, env))

	theirs := bob.Send(general, "theirs")
	alice.Do(http.MethodPut, pin(theirs), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, pin(theirs), nil, http.StatusNoContent, nil) // already pinned: not logged again
	alice.Do(http.MethodDelete, pin(theirs), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, pin(theirs), nil, http.StatusNoContent, nil) // not pinned: not logged
	alice.Do(http.MethodDelete, msg(theirs), nil, http.StatusNoContent, nil)
	require.Equal(t, []auditEntry{
		{Action: audit.MessagePin, Actor: alice.User.ID, Target: bob.User.ID, Details: audit.LogDetails{Channel: where}},
		{Action: audit.MessageUnpin, Actor: alice.User.ID, Target: bob.User.ID, Details: audit.LogDetails{Channel: where}},
		{Action: audit.MessageDelete, Actor: alice.User.ID, Target: bob.User.ID, Details: audit.LogDetails{Channel: where}},
	}, messageAudit(t, env))

	// Pins in a DM are not server moderation.
	var dm channels.Channel
	alice.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{bob.User.ID.String()}}, http.StatusOK, &dm)
	m := bob.Send(dm.ID, "keep this")
	alice.Do(http.MethodPut, "/api/channels/"+dm.ID.String()+"/pins/"+m.ID.String(), nil, http.StatusNoContent, nil)
	require.Len(t, messageAudit(t, env), 3)
}

func TestForumPostAuditLog(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	f := forum(t, alice, false)
	newPost := func(c *apptest.Client, title string) id.ID {
		var p messages.ThreadListItem
		c.Do(http.MethodPost, "/api/channels/"+f.ID.String()+"/posts", map[string]any{"title": title, "content": "body"}, http.StatusCreated, &p)
		return p.Channel.ID
	}

	alice.Do(http.MethodDelete, "/api/channels/"+newPost(alice, "Mine").String()+"/post", nil, http.StatusNoContent, nil)
	require.Empty(t, messageAudit(t, env))

	alice.Do(http.MethodDelete, "/api/channels/"+newPost(bob, "App crashes").String()+"/post", nil, http.StatusNoContent, nil)
	require.Equal(t, []auditEntry{{Action: audit.MessageDelete, Actor: alice.User.ID, Target: bob.User.ID,
		Details: audit.LogDetails{Name: "App crashes", Channel: &audit.LogRef{ID: f.ID, Name: "help"}}}}, messageAudit(t, env))
}
