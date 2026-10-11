package communities_test

import (
	"fmt"
	"net/http"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/perms"
)

// staff sets up: alice (owner), bob (Moderator: kick, ban, manage roles),
// carol (Helper: kick), dave (no roles). Moderator ranks above Helper.
func staff(t *testing.T) (env *apptest.Env, alice, bob, carol, dave *apptest.Client, mod, helper communities.Role) {
	env = apptest.New(t)
	alice, bob, carol, dave = env.Register("alice"), env.Register("bob"), env.Register("carol"), env.Register("dave")
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Helper", "permissions": perms.Kick}, http.StatusCreated, &helper)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Moderator", "permissions": perms.Kick | perms.Ban | perms.ManageRoles,
		"color": "#4aa3ff", "hoist": true}, http.StatusCreated, &mod)
	alice.Do(http.MethodPatch, "/api/server/roles/"+mod.ID.String(), map[string]any{"position": 2}, http.StatusOK, &mod)
	alice.Do(http.MethodPatch, "/api/server/roles/"+helper.ID.String(), map[string]any{"position": 1}, http.StatusOK, &helper)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, "/api/server/members/"+carol.User.ID.String()+"/roles/"+helper.ID.String(), nil, http.StatusNoContent, nil)
	return
}

func TestRoleColourAndHoist(t *testing.T) {
	_, alice, _, _, _, mod, _ := staff(t)
	require.Equal(t, "#4aa3ff", *mod.Color)
	require.True(t, mod.Hoist)
	alice.Fail(http.MethodPatch, "/api/server/roles/"+mod.ID.String(), map[string]any{"color": "#123456"}, http.StatusBadRequest, "VALIDATION_FAILED")
	var r communities.Role
	alice.Do(http.MethodPatch, "/api/server/roles/"+mod.ID.String(), map[string]any{"clear_color": true}, http.StatusOK, &r)
	require.Nil(t, r.Color)
}

func TestModerationFollowsHierarchy(t *testing.T) {
	_, _, bob, carol, dave, _, _ := staff(t)
	carol.Fail(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION") // helper < moderator
	bob.Do(http.MethodDelete, "/api/server/members/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)                    // moderator > helper
	bob.Do(http.MethodDelete, "/api/server/members/"+dave.User.ID.String(), nil, http.StatusNoContent, nil)
}

func TestRoleEditingFollowsHierarchy(t *testing.T) {
	_, alice, bob, _, _, mod, helper := staff(t)
	bob.Fail(http.MethodPatch, "/api/server/roles/"+mod.ID.String(), map[string]any{"name": "Boss"}, http.StatusForbidden, "MISSING_PERMISSION")   // own top role
	bob.Do(http.MethodPatch, "/api/server/roles/"+helper.ID.String(), map[string]any{"name": "Trial helper"}, http.StatusOK, nil)                  // below
	bob.Fail(http.MethodPatch, "/api/server/roles/"+helper.ID.String(), map[string]any{"position": 2}, http.StatusForbidden, "MISSING_PERMISSION") // not up to his own rank
	var created communities.Role
	bob.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Regular", "permissions": 0}, http.StatusCreated, &created)
	require.Equal(t, 2, created.Position, "a new role goes directly below the creator's highest role")
	bob.Fail(http.MethodPut, "/api/server/members/"+alice.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")

	roles := alice.Server().Roles
	seen := map[int]bool{}
	for _, r := range roles {
		require.False(t, seen[r.Position], "positions stay unique")
		seen[r.Position] = true
	}
}

func TestBanRevokesSessions(t *testing.T) {
	_, alice, _, _, dave, _, _ := staff(t)
	alice.Do(http.MethodPut, "/api/server/bans/"+dave.User.ID.String(), map[string]any{}, http.StatusNoContent, nil)
	dave.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
}

func TestMovingRolesKeepsPositionsDense(t *testing.T) {
	_, alice, _, _, _, mod, helper := staff(t)
	ws, _ := alice.Connect()
	var moved communities.Role
	alice.Do(http.MethodPatch, "/api/server/roles/"+helper.ID.String(), map[string]any{"position": 2}, http.StatusOK, &moved)
	require.Equal(t, 2, moved.Position)
	got := map[string]int{}
	for range 2 {
		var r communities.Role
		ws.ExpectDispatch("ROLE_UPDATE", &r)
		got[r.Name] = r.Position
	}
	require.Equal(t, map[string]int{"Helper": 2, "Moderator": 1}, got, "every role that moved is announced")

	alice.Do(http.MethodDelete, "/api/server/roles/"+mod.ID.String(), nil, http.StatusNoContent, nil)
	positions := []int{}
	for _, r := range alice.Server().Roles {
		positions = append(positions, r.Position)
	}
	require.Equal(t, []int{1, 0}, positions, "deleting closes the gap; highest first")

	everyone := alice.Server().ID.String()
	alice.Fail(http.MethodPatch, "/api/server/roles/"+everyone, map[string]any{"hoist": true}, http.StatusBadRequest, "CANNOT_STYLE_EVERYONE")
	alice.Fail(http.MethodPatch, "/api/server/roles/"+everyone, map[string]any{"position": 3}, http.StatusBadRequest, "CANNOT_MOVE_EVERYONE")
}

func TestConcurrentMovesKeepPositionsUnique(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	ids := make([]string, 5)
	for i := range ids {
		var r communities.Role
		alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": fmt.Sprint("r", i), "permissions": 0}, http.StatusCreated, &r)
		ids[i] = r.ID.String()
	}
	var wg sync.WaitGroup
	for round := range 4 {
		for i, rid := range ids {
			wg.Add(1)
			go func() {
				defer wg.Done()
				alice.Do(http.MethodPatch, "/api/server/roles/"+rid, map[string]any{"position": (i+round)%len(ids) + 1}, http.StatusOK, nil)
			}()
		}
	}
	wg.Wait()
	seen := map[int]bool{}
	for _, r := range alice.Server().Roles {
		require.False(t, seen[r.Position], "positions stay unique: %d repeats", r.Position)
		seen[r.Position] = true
	}
	require.Len(t, seen, len(ids)+1)
}

// A self-assignable role carries no authority: holding one, however high it
// sits, must not shield a member from moderators.
func TestSelfAssignableRoleDoesNotRaiseRank(t *testing.T) {
	_, alice, bob, _, dave, _, helper := staff(t)
	var top communities.Role
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Raiders", "permissions": 0, "self_assignable": true}, http.StatusCreated, &top)
	require.Greater(t, top.Position, helper.Position+1) // above Moderator too
	alice.Do(http.MethodPut, "/api/server/members/"+dave.User.ID.String()+"/roles/"+helper.ID.String(), nil, http.StatusNoContent, nil)
	dave.Do(http.MethodPut, "/api/server/me/roles/"+top.ID.String(), nil, http.StatusNoContent, nil)

	// bob (Moderator) still outranks dave and can take his Helper role away, then kick him.
	bob.Do(http.MethodDelete, "/api/server/members/"+dave.User.ID.String()+"/roles/"+helper.ID.String(), nil, http.StatusNoContent, nil)
	bob.Do(http.MethodDelete, "/api/server/members/"+dave.User.ID.String(), nil, http.StatusNoContent, nil)
}
