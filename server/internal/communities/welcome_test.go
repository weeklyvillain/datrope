package communities_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
)

func TestWelcomePage(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var w communities.Welcome
	bob.Do(http.MethodGet, "/api/server/welcome", nil, http.StatusOK, &w)
	require.Equal(t, "", w.Markdown)
	require.False(t, w.RulesGate)

	alice.Fail(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "  ", "rules_gate": true}, http.StatusBadRequest, "WELCOME_EMPTY")
	alice.Fail(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": strings.Repeat("a", 50001), "rules_gate": false}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Do(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "# Hi\nBe nice.", "rules_gate": false}, http.StatusOK, &w)
	var ev communities.Welcome
	ws.ExpectDispatch("WELCOME_UPDATE", &ev)
	require.Equal(t, "# Hi\nBe nice.", ev.Markdown)
	bob.Fail(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "mine"}, http.StatusForbidden, "MISSING_PERMISSION")

	// The welcome channel is listed, has no messages and cannot be deleted.
	var welcomeID string
	for _, ch := range bob.Channels() {
		if ch.Type == "welcome" {
			welcomeID = ch.ID.String()
		}
	}
	require.Equal(t, w.ChannelID.String(), welcomeID)
	bob.Fail(http.MethodPost, "/api/channels/"+welcomeID+"/messages", map[string]any{"content": "hi"}, http.StatusBadRequest, "NO_MESSAGES_HERE")
	alice.Fail(http.MethodDelete, "/api/channels/"+welcomeID, nil, http.StatusBadRequest, "CANNOT_DELETE_WELCOME")
	alice.Fail(http.MethodPost, "/api/server/channels", map[string]any{"name": "w2", "type": "welcome"}, http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestRulesGate(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob") // joined before the gate: not gated
	alice.Do(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "Rules: be nice.", "rules_gate": true}, http.StatusOK, nil)
	require.True(t, alice.Server().RulesGate)

	carol := env.Register("carol")
	chans := carol.Channels()
	require.Len(t, chans, 1, "a gated member sees only the welcome channel")
	require.Equal(t, "welcome", chans[0].Type)
	var w communities.Welcome
	carol.Do(http.MethodGet, "/api/server/welcome", nil, http.StatusOK, &w)
	require.Equal(t, "Rules: be nice.", w.Markdown)
	carol.Fail(http.MethodGet, "/api/server/members", nil, http.StatusForbidden, "RULES_NOT_ACCEPTED")
	carol.Fail(http.MethodPost, "/api/server/invites", map[string]any{}, http.StatusForbidden, "RULES_NOT_ACCEPTED")
	carol.Fail(http.MethodGet, "/api/channels/"+bob.General().String()+"/messages", nil, http.StatusNotFound, "NOT_FOUND")
	carol.Fail(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{bob.User.ID.String()}}, http.StatusForbidden, "NO_SHARED_COMMUNITY")
	bob.Fail(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{carol.User.ID.String()}}, http.StatusForbidden, "NO_SHARED_COMMUNITY")
	_, ready := carol.Connect()
	require.NotNil(t, ready.Server)
	require.Len(t, ready.Server.Channels, 1)
	require.Empty(t, ready.Server.Members)
	require.Empty(t, ready.Presences)

	require.Len(t, bob.Channels(), 2, "bob accepted implicitly by joining before the gate")

	ws, _ := alice.Connect()
	carol.Do(http.MethodPost, "/api/server/welcome/accept", nil, http.StatusNoContent, nil)
	var m communities.Member
	ws.ExpectDispatch("MEMBER_UPDATE", &m)
	require.Equal(t, carol.User.ID, m.User.ID)
	require.NotNil(t, m.AcceptedRulesAt)
	require.Len(t, carol.Channels(), 2)
	carol.Do(http.MethodGet, "/api/server/members", nil, http.StatusOK, nil)
}
