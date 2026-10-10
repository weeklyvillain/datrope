package communities_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestGuestInviteCreation(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")

	code := alice.GuestInvite(6 * 3600)
	var list []communities.Invite
	alice.Do(http.MethodGet, "/api/server/invites", nil, http.StatusOK, &list)
	require.Len(t, list, 1)
	require.Equal(t, 6*3600, *list[0].GuestTTLSeconds)

	var p communities.InvitePreview
	env.Anon().Do(http.MethodGet, "/api/invites/"+code, nil, http.StatusOK, &p)
	require.Equal(t, 6*3600, *p.GuestTTLSeconds)

	normal := alice.Invite()
	p = communities.InvitePreview{}
	env.Anon().Do(http.MethodGet, "/api/invites/"+normal, nil, http.StatusOK, &p)
	require.Nil(t, p.GuestTTLSeconds, "normal links are not guest links")

	alice.Fail(http.MethodPost, "/api/server/invites", map[string]any{"guest_ttl_seconds": 60}, http.StatusBadRequest, "VALIDATION_FAILED")
}

func guestRoles(sv communities.ServerWithRoles) []communities.Role {
	out := []communities.Role{}
	for _, r := range sv.Roles {
		if r.IsGuest {
			out = append(out, r)
		}
	}
	return out
}

func TestGuestJoin(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	env.SetRegistrationMode(auth.ModeAdminOnly) // guest links work regardless
	code := alice.GuestInvite(6 * 3600)
	ws, _ := alice.Connect()

	before := time.Now()
	g := env.JoinAsGuest(code, "  Robin  ")
	require.Equal(t, "Robin", g.User.DisplayName)
	require.True(t, strings.HasPrefix(g.User.Username, "guest-"))
	require.NotNil(t, g.User.GuestExpiresAt)
	require.WithinDuration(t, before.Add(6*time.Hour), *g.User.GuestExpiresAt, time.Minute)

	var added communities.Member
	ws.ExpectDispatch("MEMBER_ADD", &added)
	require.Equal(t, g.User.ID, added.User.ID)
	require.NotNil(t, added.User.GuestExpiresAt, "members carry the guest flag")

	roles := guestRoles(g.Server())
	require.Len(t, roles, 1)
	require.Equal(t, 1, roles[0].Position, "just above @everyone")
	require.Equal(t, perms.GuestDefault, roles[0].Permissions)
	require.Contains(t, added.RoleIDs, roles[0].ID)
	g.Send(g.General(), "hello")

	env.JoinAsGuest(code, "Robin") // duplicate nicks are fine
	require.Len(t, guestRoles(alice.Server()), 1, "the second guest reuses the role")

	env.Anon().Fail(http.MethodPost, "/api/invites/"+alice.Invite()+"/guest", apptest.GuestBody("x"), http.StatusNotFound, "NOT_GUEST_INVITE")
	env.Anon().Fail(http.MethodPost, "/api/invites/nope/guest", apptest.GuestBody("x"), http.StatusNotFound, "INVITE_INVALID")
}

func TestGuestNick(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	code := alice.GuestInvite(3600)
	for _, nick := range []string{"   ", "bad\x07nick", strings.Repeat("a", 33)} {
		env.Anon().Fail(http.MethodPost, "/api/invites/"+code+"/guest", apptest.GuestBody(nick), http.StatusBadRequest, "INVALID_NICK")
	}
	g := env.JoinAsGuest(code, strings.Repeat("🙂", 32)) // 32 runes, 128 bytes
	require.Equal(t, strings.Repeat("🙂", 32), g.User.DisplayName)
}

func TestUsedUpGuestLinkLeavesNoUser(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var inv communities.Invite
	alice.Do(http.MethodPost, "/api/server/invites", map[string]any{"guest_ttl_seconds": 3600, "max_uses": 1}, http.StatusCreated, &inv)
	env.JoinAsGuest(inv.Code, "First")
	count := func() (n int) {
		require.NoError(t, env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM users`).Scan(&n))
		return n
	}
	n := count()
	env.Anon().Fail(http.MethodPost, "/api/invites/"+inv.Code+"/guest", apptest.GuestBody("Second"), http.StatusNotFound, "INVITE_INVALID")
	require.Equal(t, n, count())
}

func TestGuestJoinWhileSignedIn(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	code := alice.GuestInvite(3600)
	alice.Fail(http.MethodPost, "/api/invites/"+code+"/guest", apptest.GuestBody("Alias"), http.StatusConflict, "ALREADY_SIGNED_IN")
}

func TestGuestRestrictions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	g := env.JoinAsGuest(alice.GuestInvite(3600), "Visitor")

	g.Fail(http.MethodPost, "/api/server/invites", map[string]any{}, http.StatusForbidden, "GUEST_FORBIDDEN")
	g.Fail(http.MethodGet, "/api/sessions", nil, http.StatusForbidden, "GUEST_FORBIDDEN")
	g.Fail(http.MethodDelete, "/api/sessions/1", nil, http.StatusForbidden, "GUEST_FORBIDDEN")
	var me auth.User
	g.Do(http.MethodPatch, "/api/users/@me", map[string]any{"display_name": "Visitor 2"}, http.StatusOK, &me)
	require.Equal(t, "Visitor 2", me.DisplayName)
	require.NotNil(t, me.GuestExpiresAt)

	role := guestRoles(alice.Server())[0]
	alice.Fail(http.MethodDelete, "/api/server/roles/"+role.ID.String(), nil, http.StatusConflict, "CANNOT_DELETE_GUEST_ROLE")
	alice.Do(http.MethodPatch, "/api/server/roles/"+role.ID.String(), map[string]any{"name": "Visitors"}, http.StatusOK, nil)
}

func TestGuestExpirySweep(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	code := alice.GuestInvite(3600)
	gone := env.JoinAsGuest(code, "Gone")
	stays := env.JoinAsGuest(code, "Stays")
	general := gone.General()
	gone.Send(general, "hi from a guest")
	goneWS, _ := gone.Connect()
	aliceWS, _ := alice.Connect()

	ctx := context.Background()
	_, err := env.Pool.Exec(ctx, `UPDATE users SET guest_expires_at = now() - interval '1 second' WHERE id = $1`, gone.User.ID)
	require.NoError(t, err)
	n, err := env.App.Communities.SweepGuests(ctx, time.Now())
	require.NoError(t, err)
	require.Equal(t, 1, n)

	var removed communities.MemberRemoved
	aliceWS.ExpectDispatch("MEMBER_REMOVE", &removed)
	require.Equal(t, gone.User.ID, removed.UserID)
	goneWS.ExpectClose()
	gone.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
	stays.Do(http.MethodGet, "/api/users/@me", nil, http.StatusOK, nil)
	alice.Do(http.MethodGet, "/api/users/@me", nil, http.StatusOK, nil)

	var msgs []messages.Message
	alice.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &msgs)
	var found *messages.Message
	for i := range msgs {
		if msgs[i].Content == "hi from a guest" {
			found = &msgs[i]
		}
	}
	require.NotNil(t, found, "messages stay")
	require.Equal(t, "Gone", found.Author.DisplayName)
	require.NotNil(t, found.Author.GuestExpiresAt, "and still carry the guest badge")

	n, err = env.App.Communities.SweepGuests(ctx, time.Now())
	require.NoError(t, err)
	require.Zero(t, n, "a retired guest is not swept again")
}

func TestKickOrBanRetiresGuests(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	code := alice.GuestInvite(3600)
	kicked := env.JoinAsGuest(code, "Kicked")
	banned := env.JoinAsGuest(code, "Banned")

	alice.Do(http.MethodDelete, "/api/server/members/"+kicked.User.ID.String(), nil, http.StatusNoContent, nil)
	kicked.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")

	alice.Do(http.MethodPut, "/api/server/bans/"+banned.User.ID.String(), map[string]any{}, http.StatusNoContent, nil)
	var disabled bool
	require.NoError(t, env.Pool.QueryRow(context.Background(), `SELECT disabled FROM users WHERE id = $1`, banned.User.ID).Scan(&disabled))
	require.True(t, disabled)
}
