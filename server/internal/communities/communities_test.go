package communities_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestFirstUserCreatesTheServer(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	s := alice.Server()
	require.Equal(t, "Datrope", s.Name)
	require.Equal(t, alice.User.ID, s.OwnerID)
	require.Equal(t, "emerald", s.Palette)
	require.Len(t, s.Roles, 1)
	require.Equal(t, s.ID, s.Roles[0].ID, "@everyone shares the server's ID")
	require.Equal(t, perms.Default, s.Roles[0].Permissions)

	names := []string{}
	for _, ch := range alice.Channels() {
		names = append(names, ch.Name)
	}
	require.Contains(t, names, "general")
}

func TestRegisteringJoinsTheServer(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob") // open registration in tests
	var members []communities.Member
	alice.Do(http.MethodGet, "/api/server/members", nil, http.StatusOK, &members)
	require.Len(t, members, 2)
	require.Equal(t, "bob", members[1].User.Username)
	require.Empty(t, members[1].RoleIDs)

	env.SetRegistrationMode(auth.ModeInviteOnly)
	code := bob.Invite()
	carol := env.RegisterWithInvite("carol", code)
	carol.Do(http.MethodGet, "/api/server/members", nil, http.StatusOK, &members)
	require.Len(t, members, 3)

	var preview struct {
		Code        string `json:"code"`
		ServerName  string `json:"server_name"`
		MemberCount int    `json:"member_count"`
	}
	env.Anon().Do(http.MethodGet, "/api/invites/"+code, nil, http.StatusOK, &preview)
	require.Equal(t, "Datrope", preview.ServerName)
	require.Equal(t, 3, preview.MemberCount)
}

func TestUpdateServer(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var s communities.Server
	alice.Do(http.MethodPatch, "/api/server", map[string]any{"name": "The Basement", "description": "Board games and links", "palette": "ocean"}, http.StatusOK, &s)
	require.Equal(t, "The Basement", s.Name)
	require.Equal(t, "ocean", s.Palette)
	var ev communities.Server
	ws.ExpectDispatch("SERVER_UPDATE", &ev)
	require.Equal(t, "Board games and links", ev.Description)

	bob.Fail(http.MethodPatch, "/api/server", map[string]any{"name": "Mine"}, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Fail(http.MethodPatch, "/api/server", map[string]any{"palette": "beige"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPatch, "/api/server", map[string]any{"name": "   "}, http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestKickAndRejoin(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	code := alice.Invite()

	alice.Do(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodGet, "/api/server", nil, http.StatusForbidden, "NOT_A_MEMBER")
	_, ready := bob.Connect()
	require.Nil(t, ready.Server, "READY has no server for a non-member")

	bob.Join(code)
	require.Equal(t, alice.Server().ID, bob.Server().ID)

	alice.Fail(http.MethodDelete, "/api/server/members/"+alice.User.ID.String(), nil, http.StatusBadRequest, "CANNOT_KICK_SELF")
	bob.Fail(http.MethodDelete, "/api/server/members/"+alice.User.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestBanBlocksRejoining(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	code := alice.Invite()
	alice.Do(http.MethodPut, "/api/server/bans/"+bob.User.ID.String(), map[string]any{"reason": "spam"}, http.StatusNoContent, nil)
	relogin(env, bob) // banning signs bob out; the account itself still works
	bob.Fail(http.MethodPost, "/api/invites/"+code+"/accept", nil, http.StatusForbidden, "BANNED")
}

// relogin signs c in again (after a ban revoked its sessions).
func relogin(env *apptest.Env, c *apptest.Client) {
	env.T.Helper()
	var res auth.AuthResult
	env.Anon().Do(http.MethodPost, "/api/auth/login",
		map[string]any{"login": c.User.Username, "password": "password123", "device_name": "test", "client": "native"}, http.StatusOK, &res)
	c.Token = res.Token
}

func TestNoCommunityRoutesRemain(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPost, "/api/communities", map[string]any{"name": "Second"}, http.StatusNotFound, nil)
}

// Kept from the multi-community tests: invite limits, listing, expiry and revocation.
func TestInviteLimits(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Outsider("carol")
	dave := env.Outsider("dave")

	var inv communities.Invite
	alice.Do(http.MethodPost, "/api/server/invites", map[string]any{"max_uses": 1}, http.StatusCreated, &inv)
	var invites []communities.Invite
	alice.Do(http.MethodGet, "/api/server/invites", nil, http.StatusOK, &invites)
	require.Len(t, invites, 1)
	require.Equal(t, 0, invites[0].Uses)

	carol.Join(inv.Code)
	dave.Fail(http.MethodPost, "/api/invites/"+inv.Code+"/accept", nil, http.StatusNotFound, "INVITE_INVALID")
	alice.Do(http.MethodGet, "/api/server/invites", nil, http.StatusOK, &invites)
	require.Empty(t, invites, "used-up invites are not listed")
	bob.Fail(http.MethodGet, "/api/server/invites", nil, http.StatusForbidden, "MISSING_PERMISSION")

	expiring := alice.Invite()
	_, err := env.Pool.Exec(context.Background(), `UPDATE invites SET expires_at = now() - interval '1 second' WHERE code = $1`, expiring)
	require.NoError(t, err)
	dave.Fail(http.MethodPost, "/api/invites/"+expiring+"/accept", nil, http.StatusNotFound, "INVITE_INVALID")

	revoked := alice.Invite()
	alice.Do(http.MethodDelete, "/api/invites/"+revoked, nil, http.StatusNoContent, nil)
	env.Anon().Fail(http.MethodGet, "/api/invites/"+revoked, nil, http.StatusNotFound, "INVITE_INVALID")

	env.SetRegistrationMode(auth.ModeInviteOnly)
	env.Anon().Fail(http.MethodPost, "/api/auth/register", map[string]any{
		"username": "eve", "password": "password123", "device_name": "test", "client": "native", "invite_code": "nope",
	}, http.StatusNotFound, "INVITE_INVALID")
}

// Open sign-ups do not need an invite, so a stale one still makes a member.
func TestOpenRegistrationIgnoresBadInvite(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	expired := alice.Invite()
	_, err := env.Pool.Exec(context.Background(), `UPDATE invites SET expires_at = now() - interval '1 second' WHERE code = $1`, expired)
	require.NoError(t, err)
	revoked := alice.Invite()
	alice.Do(http.MethodDelete, "/api/invites/"+revoked, nil, http.StatusNoContent, nil)

	env.RegisterWithInvite("bob", expired).Do(http.MethodGet, "/api/server", nil, http.StatusOK, nil)
	env.RegisterWithInvite("carol", revoked).Do(http.MethodGet, "/api/server", nil, http.StatusOK, nil)
}

func TestServerPreview(t *testing.T) {
	env := apptest.New(t)
	env.Anon().Fail(http.MethodGet, "/api/server/preview", nil, http.StatusNotFound, "NOT_FOUND")

	alice := env.Register("alice")
	env.Register("bob")
	var p communities.ServerPreview
	env.Anon().Do(http.MethodGet, "/api/server/preview", nil, http.StatusOK, &p)
	require.Equal(t, "Datrope", p.Name)
	require.Equal(t, "emerald", p.Palette)
	require.Equal(t, 2, p.MemberCount)
	require.Equal(t, 0, p.OnlineCount)

	ws, _ := alice.Connect()
	defer ws.Close()
	env.Anon().Do(http.MethodGet, "/api/server/preview", nil, http.StatusOK, &p)
	require.Equal(t, 1, p.OnlineCount)
}
