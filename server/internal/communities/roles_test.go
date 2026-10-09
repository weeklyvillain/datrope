package communities_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestRoles(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	c := alice.Server()
	base := "/api/server"

	bob.Fail(http.MethodPost, base+"/roles", map[string]any{"name": "x", "permissions": 0}, http.StatusForbidden, "MISSING_PERMISSION")

	var mods communities.Role
	alice.Do(http.MethodPost, base+"/roles",
		map[string]any{"name": "Mods", "permissions": uint64(perms.Kick | perms.ManageRoles)}, http.StatusCreated, &mods)
	require.Equal(t, 1, mods.Position)
	alice.Do(http.MethodPut, base+"/members/"+bob.User.ID.String()+"/roles/"+mods.ID.String(), nil, http.StatusNoContent, nil)

	var members []communities.Member
	alice.Do(http.MethodGet, base+"/members", nil, http.StatusOK, &members)
	for _, m := range members {
		if m.User.ID == bob.User.ID {
			require.Len(t, m.RoleIDs, 1)
			require.Equal(t, mods.ID, m.RoleIDs[0])
		}
	}

	// Bob can now kick, and manage roles — but only with permissions he holds.
	bob.Fail(http.MethodPost, base+"/roles", map[string]any{"name": "Banners", "permissions": uint64(perms.Ban)},
		http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodPost, base+"/roles", map[string]any{"name": "Kickers", "permissions": uint64(perms.Kick)},
		http.StatusCreated, nil)
	bob.Fail(http.MethodPatch, base+"/roles/"+c.ID.String(), map[string]any{"permissions": uint64(perms.All)},
		http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodDelete, base+"/members/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)

	alice.Fail(http.MethodPatch, base+"/roles/"+c.ID.String(), map[string]any{"name": "everyone"},
		http.StatusBadRequest, "CANNOT_RENAME_EVERYONE")
	alice.Fail(http.MethodDelete, base+"/roles/"+c.ID.String(), nil, http.StatusBadRequest, "CANNOT_DELETE_EVERYONE")
	alice.Fail(http.MethodPut, base+"/members/"+bob.User.ID.String()+"/roles/"+c.ID.String(), nil,
		http.StatusBadRequest, "CANNOT_ASSIGN_EVERYONE")

	var updated communities.Role
	alice.Do(http.MethodPatch, base+"/roles/"+mods.ID.String(), map[string]any{"name": "Moderators"}, http.StatusOK, &updated)
	require.Equal(t, "Moderators", updated.Name)
	require.Equal(t, mods.Permissions, updated.Permissions, "omitted fields are unchanged")

	alice.Do(http.MethodDelete, base+"/roles/"+mods.ID.String(), nil, http.StatusNoContent, nil)
	carol.Join(alice.Invite())
	bob.Fail(http.MethodDelete, base+"/members/"+carol.User.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestUnassignRole(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	base := "/api/server"

	var r communities.Role
	alice.Do(http.MethodPost, base+"/roles", map[string]any{"name": "Kick", "permissions": uint64(perms.Kick)}, http.StatusCreated, &r)
	path := base + "/members/" + bob.User.ID.String() + "/roles/" + r.ID.String()
	alice.Do(http.MethodPut, path, nil, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodDelete, base+"/members/"+alice.User.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestBans(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	base := "/api/server"

	bob.Fail(http.MethodPut, base+"/bans/"+alice.User.ID.String(), map[string]any{}, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Fail(http.MethodPut, base+"/bans/"+alice.User.ID.String(), map[string]any{}, http.StatusBadRequest, "CANNOT_BAN_SELF")

	alice.Do(http.MethodPut, base+"/bans/"+bob.User.ID.String(), map[string]any{"reason": "spam"}, http.StatusNoContent, nil)
	bob.Fail(http.MethodGet, base, nil, http.StatusUnauthorized, "UNAUTHORIZED") // banning signs bob out
	relogin(env, bob)
	bob.Fail(http.MethodGet, base, nil, http.StatusForbidden, "NOT_A_MEMBER")
	code := alice.Invite()
	bob.Fail(http.MethodPost, "/api/invites/"+code+"/accept", nil, http.StatusForbidden, "BANNED")

	var bans []communities.Ban
	alice.Do(http.MethodGet, base+"/bans", nil, http.StatusOK, &bans)
	require.Len(t, bans, 1)
	require.Equal(t, "spam", bans[0].Reason)
	require.Equal(t, bob.User.ID, bans[0].User.ID)

	alice.Do(http.MethodDelete, base+"/bans/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	bob.Join(code)
}

func TestModerationCannotTargetHigherPermissions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	dave := env.Register("dave")
	base := "/api/server"

	var mod, admin communities.Role
	alice.Do(http.MethodPost, base+"/roles", map[string]any{"name": "Kick", "permissions": uint64(perms.Kick | perms.Ban)}, http.StatusCreated, &mod)
	alice.Do(http.MethodPost, base+"/roles", map[string]any{"name": "Admin", "permissions": uint64(perms.Admin)}, http.StatusCreated, &admin)
	alice.Do(http.MethodPut, base+"/members/"+bob.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, base+"/members/"+carol.User.ID.String()+"/roles/"+admin.ID.String(), nil, http.StatusNoContent, nil)

	bob.Fail(http.MethodDelete, base+"/members/"+carol.User.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPut, base+"/bans/"+carol.User.ID.String(), map[string]any{}, http.StatusForbidden, "MISSING_PERMISSION")

	// Plain members and non-members remain targetable.
	bob.Do(http.MethodDelete, base+"/members/"+dave.User.ID.String(), nil, http.StatusNoContent, nil)
	bob.Do(http.MethodPut, base+"/bans/"+env.Outsider("erin").User.ID.String(), map[string]any{}, http.StatusNoContent, nil)

	// The owner can act on admins.
	alice.Do(http.MethodPut, base+"/bans/"+carol.User.ID.String(), map[string]any{}, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, base+"/bans/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)
	relogin(env, carol)
	carol.Join(alice.Invite())
	alice.Do(http.MethodPut, base+"/members/"+carol.User.ID.String()+"/roles/"+admin.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, base+"/members/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)
}
