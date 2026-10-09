package messages_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestHistoryAroundAndAfter(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	var sent []messages.Message
	for i := 0; i < 10; i++ {
		sent = append(sent, alice.Send(general, fmt.Sprintf("m%d", i)))
	}
	path := "/api/channels/" + general.String() + "/messages"
	names := func(ms []messages.Message) []string {
		out := []string{}
		for _, m := range ms {
			out = append(out, m.Content)
		}
		return out
	}
	var page []messages.Message
	alice.Do(http.MethodGet, path+"?around="+sent[4].ID.String()+"&limit=4", nil, http.StatusOK, &page)
	require.Equal(t, []string{"m6", "m5", "m4", "m3"}, names(page))
	alice.Do(http.MethodGet, path+"?after="+sent[7].ID.String()+"&limit=5", nil, http.StatusOK, &page)
	require.Equal(t, []string{"m9", "m8"}, names(page))
	alice.Do(http.MethodGet, path+"?after="+sent[2].ID.String()+"&limit=2", nil, http.StatusOK, &page)
	require.Equal(t, []string{"m4", "m3"}, names(page))
	alice.Fail(http.MethodGet, path+"?around="+sent[4].ID.String()+"&before="+sent[5].ID.String(), nil, http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestHistoryAroundAfterPermissions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	srv := alice.Server()
	secret := alice.CreateTextChannel("secret")
	alice.Do(http.MethodPut, "/api/channels/"+secret.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)
	m := alice.Send(secret, "hidden")
	d := dm(t, alice, bob)
	dmMsg := alice.Send(d.ID, "private")

	status := func(c *apptest.Client, ch id.ID, query string) int {
		req, err := http.NewRequest(http.MethodGet, env.Server.URL+"/api/channels/"+ch.String()+"/messages"+query, nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+c.Token)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp.StatusCode
	}
	for _, q := range []string{"", "?around=" + m.ID.String(), "?after=" + m.ID.String()} {
		require.Equal(t, status(bob, secret, ""), status(bob, secret, q), q)
		require.GreaterOrEqual(t, status(bob, secret, q), 400, q)
	}
	for _, q := range []string{"?around=" + dmMsg.ID.String(), "?after=" + dmMsg.ID.String()} {
		require.Equal(t, status(carol, d.ID, ""), status(carol, d.ID, q), q)
		require.GreaterOrEqual(t, status(carol, d.ID, q), 400, q)
	}
	// An ID from another channel finds nothing in the requested one.
	general := alice.General()
	var page []messages.Message
	alice.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages?around="+m.ID.String(), nil, http.StatusOK, &page)
	for _, got := range page {
		require.Equal(t, general, got.ChannelID)
	}
}
