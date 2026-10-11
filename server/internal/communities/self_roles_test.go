package communities_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/id"
)

func TestSelfAssignRoles(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	var raid, mods communities.Role
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Raiders", "permissions": 0, "self_assignable": true}, http.StatusCreated, &raid)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Mods", "permissions": 0}, http.StatusCreated, &mods)
	mine := "/api/server/me/roles/"
	roleIDs := func(c *apptest.Client) []id.ID {
		var members []communities.Member
		alice.Do(http.MethodGet, "/api/server/members", nil, http.StatusOK, &members)
		for _, m := range members {
			if m.User.ID == c.User.ID {
				return m.RoleIDs
			}
		}
		return nil
	}

	ws, _ := bob.Connect()
	bob.Do(http.MethodPut, mine+raid.ID.String(), nil, http.StatusNoContent, nil)
	var m communities.Member
	ws.ExpectDispatch("MEMBER_UPDATE", &m)
	require.Equal(t, []id.ID{raid.ID}, m.RoleIDs)
	bob.Do(http.MethodPut, mine+raid.ID.String(), nil, http.StatusNoContent, nil) // idempotent
	ws.ExpectNoDispatch("MEMBER_UPDATE", 300*time.Millisecond)

	bob.Fail(http.MethodPut, mine+mods.ID.String(), nil, http.StatusForbidden, "NOT_SELF_ASSIGNABLE")
	bob.Fail(http.MethodPut, mine+alice.Server().ID.String(), nil, http.StatusForbidden, "NOT_SELF_ASSIGNABLE")
	bob.Fail(http.MethodPut, mine+id.New().String(), nil, http.StatusNotFound, "NOT_FOUND")

	bob.Do(http.MethodDelete, mine+raid.ID.String(), nil, http.StatusNoContent, nil)
	require.Empty(t, roleIDs(bob))
	bob.Do(http.MethodDelete, mine+raid.ID.String(), nil, http.StatusNoContent, nil) // idempotent

	// Unflagged: holders keep the role but can no longer change it themselves.
	bob.Do(http.MethodPut, mine+raid.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPatch, "/api/server/roles/"+raid.ID.String(), map[string]any{"self_assignable": false}, http.StatusOK, nil)
	require.Equal(t, []id.ID{raid.ID}, roleIDs(bob))
	bob.Fail(http.MethodDelete, mine+raid.ID.String(), nil, http.StatusForbidden, "NOT_SELF_ASSIGNABLE")
}

func TestSelfAssignBlockedForGuestsAndGated(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var raid communities.Role
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Raiders", "permissions": 0, "self_assignable": true}, http.StatusCreated, &raid)
	path := "/api/server/me/roles/" + raid.ID.String()

	guest := env.JoinAsGuest(alice.GuestInvite(3600), "visitor")
	guest.Fail(http.MethodPut, path, nil, http.StatusForbidden, "MISSING_PERMISSION")

	alice.Do(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "Rules: be nice.", "rules_gate": true}, http.StatusOK, nil)
	carol := env.Register("carol")
	carol.Fail(http.MethodPut, path, nil, http.StatusForbidden, "RULES_NOT_ACCEPTED")
	carol.Do(http.MethodPost, "/api/server/welcome/accept", nil, http.StatusNoContent, nil)
	carol.Do(http.MethodPut, path, nil, http.StatusNoContent, nil)
}
