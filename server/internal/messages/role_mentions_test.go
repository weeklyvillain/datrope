package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestRoleMentions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice") // owner: holds MentionRoles
	bob := env.Register("bob")
	carol := env.Register("carol")
	general := alice.General()
	var open, closed struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Raiders", "permissions": 0, "mentionable": true}, http.StatusCreated, &open)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Staff", "permissions": 0}, http.StatusCreated, &closed)
	tok := func(r id.ID) string { return "<@&" + r.String() + ">" }

	// Anyone may ping a mentionable role; only MentionRoles holders may ping the rest.
	m := bob.Send(general, "raid tonight "+tok(open.ID)+" "+tok(closed.ID))
	require.Equal(t, []id.ID{open.ID}, m.MentionRoles)
	m = alice.Send(general, tok(closed.ID)+" meeting")
	require.Equal(t, []id.ID{closed.ID}, m.MentionRoles)

	// Threads resolve against their server too.
	th := startThread(t, bob, general, m)
	require.Equal(t, []id.ID{open.ID}, bob.Send(th.ID, tok(open.ID)).MentionRoles)

	// Granting MentionRoles in this channel only, through an @everyone override.
	alice.Do(http.MethodPut, "/api/channels/"+general.String()+"/overrides/role/"+alice.Server().ID.String(),
		map[string]any{"allow": uint64(perms.MentionRoles), "deny": 0}, http.StatusOK, nil)
	require.Equal(t, []id.ID{closed.ID}, carol.Send(general, tok(closed.ID)).MentionRoles)

	// @everyone, unknown roles and code never resolve, and never fail the send.
	m = alice.Send(general, tok(alice.Server().ID)+" "+tok(id.New())+" `"+tok(open.ID)+"`")
	require.Empty(t, m.MentionRoles)
	require.NotNil(t, m.MentionRoles, "always an array")

	// Not in DMs.
	require.Empty(t, alice.Send(dm(t, alice, bob).ID, tok(open.ID)).MentionRoles)

	// Edits re-resolve.
	var edited messages.Message
	alice.Do(http.MethodPatch, "/api/channels/"+general.String()+"/messages/"+m.ID.String(),
		map[string]any{"content": "now " + tok(open.ID)}, http.StatusOK, &edited)
	require.Equal(t, []id.ID{open.ID}, edited.MentionRoles)
}
