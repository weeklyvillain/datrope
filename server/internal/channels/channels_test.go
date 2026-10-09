package channels_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

func names(chs []channels.Channel) []string {
	out := []string{}
	for _, c := range chs {
		out = append(out, c.Name)
	}
	return out
}

func TestDefaultChannelAndCRUD(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	base := "/api/server/channels"

	chs := bob.Channels()
	require.Equal(t, []string{"welcome", "general"}, names(chs))
	require.Equal(t, channels.TypeText, chs[1].Type)

	bob.Fail(http.MethodPost, base, map[string]any{"name": "x", "type": "text"}, http.StatusForbidden, "MISSING_PERMISSION")

	var voice channels.Channel
	alice.Do(http.MethodPost, base, map[string]any{"name": "hangout", "type": "voice"}, http.StatusCreated, &voice)
	require.Equal(t, 2, voice.Position, "a new channel goes last in its group, after welcome (0) and general (1)")

	var renamed channels.Channel
	alice.Do(http.MethodPatch, "/api/channels/"+voice.ID.String(), map[string]any{"name": "lounge"}, http.StatusOK, &renamed)
	require.Equal(t, "lounge", renamed.Name)
	bob.Fail(http.MethodPatch, "/api/channels/"+voice.ID.String(), map[string]any{"name": "x"}, http.StatusForbidden, "MISSING_PERMISSION")

	alice.Do(http.MethodDelete, "/api/channels/"+voice.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"welcome", "general"}, names(bob.Channels()))

	outsider := env.Outsider("outsider")
	outsider.Fail(http.MethodGet, base, nil, http.StatusForbidden, "NOT_A_MEMBER")
}

func TestPrivateChannel(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	c := alice.Server()

	var staff channels.Channel
	alice.Do(http.MethodPost, "/api/server/channels",
		map[string]any{"name": "staff", "type": "text"}, http.StatusCreated, &staff)
	ov := "/api/channels/" + staff.ID.String() + "/overrides/"

	// Hide it from @everyone (the @everyone role ID is the server ID).
	alice.Do(http.MethodPut, ov+"role/"+c.ID.String(), map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	require.Equal(t, []string{"welcome", "general"}, names(bob.Channels()))
	bob.Fail(http.MethodPatch, "/api/channels/"+staff.ID.String(), map[string]any{"name": "x"}, http.StatusNotFound, "NOT_FOUND")

	// A role override lets Bob see it again.
	var role communities.Role
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Staff", "permissions": 0}, http.StatusCreated, &role)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+role.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, ov+"role/"+role.ID.String(), map[string]any{"allow": uint64(perms.ViewChannel), "deny": 0}, http.StatusOK, nil)
	require.Equal(t, []string{"welcome", "general", "staff"}, names(bob.Channels()))
	require.Equal(t, []string{"welcome", "general"}, names(carol.Channels()))

	// A member override does the same for Carol, and removing it hides it again.
	alice.Do(http.MethodPut, ov+"member/"+carol.User.ID.String(), map[string]any{"allow": uint64(perms.ViewChannel), "deny": 0}, http.StatusOK, nil)
	require.Equal(t, []string{"welcome", "general", "staff"}, names(carol.Channels()))
	alice.Do(http.MethodDelete, ov+"member/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"welcome", "general"}, names(carol.Channels()))

	alice.Fail(http.MethodPut, ov+"role/"+id.New().String(), map[string]any{"allow": 0, "deny": 0}, http.StatusNotFound, "NOT_FOUND")
}

func TestOverrideEscalation(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	var role communities.Role
	alice.Do(http.MethodPost, "/api/server/roles",
		map[string]any{"name": "Perms", "permissions": uint64(perms.ManageRoles)}, http.StatusCreated, &role)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+role.ID.String(), nil, http.StatusNoContent, nil)

	ov := "/api/channels/" + bob.General().String() + "/overrides/member/" + bob.User.ID.String()
	bob.Fail(http.MethodPut, ov, map[string]any{"allow": uint64(perms.Ban), "deny": 0}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodPut, ov, map[string]any{"allow": 0, "deny": uint64(perms.Stream)}, http.StatusOK, nil)
}

func TestDMs(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Outsider("carol")

	var dm channels.Channel
	alice.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{bob.User.ID.String()}}, http.StatusOK, &dm)
	require.Equal(t, channels.TypeDM, dm.Type)
	require.Len(t, dm.Participants, 2)

	var again channels.Channel
	bob.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{alice.User.ID.String()}}, http.StatusOK, &again)
	require.Equal(t, dm.ID, again.ID, "a 1:1 DM is reused")

	alice.Fail(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{carol.User.ID.String()}}, http.StatusForbidden, "NO_SHARED_COMMUNITY")
	alice.Fail(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{alice.User.ID.String()}}, http.StatusBadRequest, "INVALID_RECIPIENTS")

	var list []channels.Channel
	bob.Do(http.MethodGet, "/api/dms", nil, http.StatusOK, &list)
	require.Len(t, list, 1)
	carol.Do(http.MethodGet, "/api/dms", nil, http.StatusOK, &list)
	require.Empty(t, list)
	alice.Fail(http.MethodPatch, "/api/channels/"+dm.ID.String(), map[string]any{"name": "x"}, http.StatusForbidden, "MISSING_PERMISSION")
}
