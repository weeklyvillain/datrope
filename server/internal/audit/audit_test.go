package audit_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

func logOf(c *apptest.Client, query string) audit.LogPage {
	var p audit.LogPage
	c.Do(http.MethodGet, "/api/server/audit-log"+query, nil, http.StatusOK, &p)
	return p
}

func actions(p audit.LogPage) []audit.Action {
	out := make([]audit.Action, len(p.Entries))
	for i, e := range p.Entries {
		out[i] = e.Action
	}
	return out
}

func TestAuditLogNeedsPermission(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	bob.Fail(http.MethodGet, "/api/server/audit-log", nil, http.StatusForbidden, "MISSING_PERMISSION")

	var role struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Auditors", "permissions": uint64(perms.ViewAuditLog)},
		http.StatusCreated, &role)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+role.ID.String(), nil, http.StatusNoContent, nil)
	p := logOf(bob, "")
	require.Equal(t, []audit.Action{audit.MemberRoleAdd, audit.RoleCreate}, actions(p), "newest first")
	add := p.Entries[0]
	require.Equal(t, alice.User.ID, add.ActorID)
	require.Equal(t, bob.User.ID, *add.TargetID)
	require.Equal(t, &audit.LogRef{ID: role.ID, Name: "Auditors"}, add.Details.Role)
	require.Equal(t, "alice", p.Users[alice.User.ID.String()].Username)
	require.Equal(t, "bob", p.Users[bob.User.ID.String()].Username)
}

func TestModerationIsRecorded(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")

	alice.Do(http.MethodPut, "/api/server/bans/"+bob.User.ID.String(), map[string]any{"reason": "spam"}, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, "/api/server/bans/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, "/api/server/members/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)

	p := logOf(alice, "")
	require.Equal(t, []audit.Action{audit.MemberKick, audit.MemberUnban, audit.MemberBan}, actions(p))
	require.Equal(t, carol.User.ID, *p.Entries[0].TargetID)
	require.Equal(t, bob.User.ID, *p.Entries[2].TargetID)
	require.Equal(t, "spam", p.Entries[2].Details.Reason)
}

func TestChannelChangesAreRecorded(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")

	var games channels.Category
	alice.Do(http.MethodPost, "/api/server/categories", map[string]any{"name": "Games"}, http.StatusCreated, &games)
	chID := alice.CreateTextChannel("minecraft")
	alice.Do(http.MethodPatch, "/api/channels/"+chID.String(), map[string]any{"category_id": games.ID}, http.StatusOK, nil)
	alice.Do(http.MethodPatch, "/api/channels/"+chID.String(), map[string]any{"name": "mc", "topic": "blocks"}, http.StatusOK, nil)
	alice.Do(http.MethodDelete, "/api/server/categories/"+games.ID.String(), nil, http.StatusNoContent, nil)

	p := logOf(alice, "")
	require.Equal(t, []audit.Action{audit.CategoryDelete, audit.ChannelUpdate, audit.ChannelUpdate, audit.ChannelCreate, audit.CategoryCreate},
		actions(p))
	require.Equal(t, "Games", p.Entries[0].Details.Name, "a deleted category keeps its name in the log")
	require.Equal(t, []audit.LogChange{{Field: "name", Old: "minecraft", New: "mc"}, {Field: "topic", Old: "", New: "blocks"}},
		p.Entries[1].Details.Changes)
	require.Equal(t, []audit.LogChange{{Field: "category", Old: "", New: "Games"}}, p.Entries[2].Details.Changes)
	require.Equal(t, chID, *p.Entries[2].TargetID)
	require.Equal(t, "minecraft", p.Entries[3].Details.Name)

	// An update that changes nothing is not recorded.
	alice.Do(http.MethodPatch, "/api/channels/"+chID.String(), map[string]any{"name": "mc"}, http.StatusOK, nil)
	require.Len(t, logOf(alice, "").Entries, 5)
}

func TestAuditLogPages(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	for _, name := range []string{"a", "b", "c", "d", "e"} {
		alice.Do(http.MethodPost, "/api/server/categories", map[string]any{"name": name}, http.StatusCreated, nil)
	}
	first := logOf(alice, "?limit=2")
	require.Len(t, first.Entries, 2)
	require.Equal(t, "e", first.Entries[0].Details.Name)
	next := logOf(alice, "?limit=2&before="+first.Entries[1].ID.String())
	require.Equal(t, "c", next.Entries[0].Details.Name)
	require.Equal(t, "b", next.Entries[1].Details.Name)
	last := logOf(alice, "?limit=2&before="+next.Entries[1].ID.String())
	require.Len(t, last.Entries, 1)
	require.Equal(t, "a", last.Entries[0].Details.Name)
}

func TestPrune(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPost, "/api/server/categories", map[string]any{"name": "a"}, http.StatusCreated, nil)

	n, err := env.App.Audit.Prune(context.Background(), time.Now())
	require.NoError(t, err)
	require.Zero(t, n, "a fresh entry stays")
	n, err = env.App.Audit.Prune(context.Background(), time.Now().Add(audit.Retention+time.Minute))
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	require.Empty(t, logOf(alice, "").Entries)
}
