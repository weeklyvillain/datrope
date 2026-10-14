package gateway_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/gateway"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

// pair returns alice (the owner) and bob, both members of the server.
func pair(t *testing.T, env *apptest.Env) (*apptest.Client, *apptest.Client, communities.ServerWithRoles) {
	alice := env.Register("alice")
	bob := env.Register("bob")
	return alice, bob, alice.Server()
}

func TestReady(t *testing.T) {
	env := apptest.New(t)
	alice, _, c := pair(t, env)
	general := alice.General()
	hello := alice.Send(general, "hello")

	_, ready := alice.Connect()
	require.Equal(t, alice.User.ID, ready.User.ID)
	require.NotEmpty(t, ready.SessionID)
	require.NotNil(t, ready.Server)
	rs := ready.Server
	require.Equal(t, c.ID, rs.ID)
	require.Equal(t, "Datrope", rs.Name)
	require.Len(t, rs.Members, 2)
	require.Len(t, rs.Channels, 2) // #welcome and #general
	require.Len(t, rs.Roles, 1)
	require.Len(t, ready.ReadStates, 2) // #welcome (always empty) and #general
	found := false
	for _, st := range ready.ReadStates {
		if st.ChannelID == general {
			found = true
			require.NotNil(t, st.LastMessageID)
			require.Equal(t, hello.ID, *st.LastReadID, "my own message is read")
		}
	}
	require.True(t, found)
}

func TestMessagesReachViewersOnly(t *testing.T) {
	env := apptest.New(t)
	alice, bob, c := pair(t, env)
	carol := env.Outsider("carol")
	aliceWS, _ := alice.Connect()
	bobWS, _ := bob.Connect()
	carolWS, _ := carol.Connect()

	ch := alice.General()
	alice.Do(http.MethodPost, "/api/channels/"+ch.String()+"/messages",
		map[string]any{"content": "hi", "nonce": "abc"}, http.StatusCreated, nil)

	var m messages.Message
	bobWS.ExpectDispatch("MESSAGE_CREATE", &m)
	require.Equal(t, "hi", m.Content)
	aliceWS.ExpectDispatch("MESSAGE_CREATE", &m)
	require.Equal(t, "abc", m.Nonce, "the sender matches its pending message by nonce")
	carolWS.ExpectNoDispatch("MESSAGE_CREATE", 300*time.Millisecond)

	// Hiding the channel from @everyone removes it for Bob and stops delivery.
	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+c.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	bobWS.ExpectDispatch("CHANNEL_DELETE", nil)
	alice.Send(ch, "secret")
	bobWS.ExpectNoDispatch("MESSAGE_CREATE", 300*time.Millisecond)
}

func TestTypingAndMembershipEvents(t *testing.T) {
	env := apptest.New(t)
	alice, bob, _ := pair(t, env)
	carol := env.Outsider("carol")
	aliceWS, _ := alice.Connect()
	bobWS, _ := bob.Connect()

	alice.Do(http.MethodPost, "/api/channels/"+alice.General().String()+"/typing", nil, http.StatusNoContent, nil)
	var typing messages.TypingStart
	bobWS.ExpectDispatch("TYPING_START", &typing)
	require.Equal(t, alice.User.ID, typing.UserID)

	carolWS, _ := carol.Connect()
	carol.Join(alice.Invite())
	carolWS.ExpectDispatch("MEMBER_ADD", nil)
	aliceWS.ExpectDispatch("MEMBER_ADD", nil)

	alice.Do(http.MethodDelete, "/api/server/members/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)
	carolWS.ExpectDispatch("MEMBER_REMOVE", nil)
}

func TestBadTokenClosesWith4001(t *testing.T) {
	env := apptest.New(t)
	w := env.Dial(nil)
	w.Send(gateway.OpIdentify, gateway.Identify{Token: "nope"})
	require.Equal(t, gateway.CloseSessionInvalid, w.ExpectClose())
}

func TestMustIdentifyFirst(t *testing.T) {
	env := apptest.New(t)
	w := env.Dial(nil)
	w.Send(gateway.OpHeartbeat, nil)
	w.Expect(gateway.OpHeartbeatAck)
	w.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: "idle"})
	require.Equal(t, gateway.CloseNotIdentified, w.ExpectClose())
}

func TestCookieOnlyFromOwnOrigin(t *testing.T) {
	env := apptest.New(t)
	env.Register("alice")
	resp := env.Anon().Do(http.MethodPost, "/api/auth/login",
		map[string]any{"login": "alice", "password": "password123", "device_name": "browser", "client": "web"}, http.StatusOK, nil)
	var cookie string
	for _, ck := range resp.Cookies() {
		if ck.Name == auth.CookieName {
			cookie = ck.Name + "=" + ck.Value
		}
	}

	ok := env.Dial(http.Header{"Cookie": {cookie}, "Origin": {apptest.PublicURL}})
	ok.Send(gateway.OpIdentify, gateway.Identify{})
	ok.Expect(gateway.OpReady)

	evil := env.Dial(http.Header{"Cookie": {cookie}, "Origin": {"https://evil.example"}})
	evil.Send(gateway.OpIdentify, gateway.Identify{})
	require.Equal(t, gateway.CloseSessionInvalid, evil.ExpectClose())
}

func TestResume(t *testing.T) {
	env := apptest.New(t)
	alice, bob, _ := pair(t, env)
	ch := alice.General()
	w, ready := bob.Connect()
	alice.Send(ch, "one")
	w.ExpectDispatch("MESSAGE_CREATE", nil)
	seq := w.Seq
	w.Close()

	alice.Send(ch, "two") // sent while Bob is away

	w2 := env.Dial(nil)
	w2.Send(gateway.OpResume, gateway.Resume{SessionID: ready.SessionID, Seq: seq, Token: bob.Token})
	w2.Expect(gateway.OpResumed)
	var m messages.Message
	w2.ExpectDispatch("MESSAGE_CREATE", &m)
	require.Equal(t, "two", m.Content)
}

func TestResumeUnknownSessionThenIdentify(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	w := env.Dial(nil)
	w.Send(gateway.OpResume, gateway.Resume{SessionID: "nope", Seq: 3, Token: alice.Token})
	w.Expect(gateway.OpInvalidSession)
	w.Send(gateway.OpIdentify, gateway.Identify{Token: alice.Token})
	w.Expect(gateway.OpReady)
}

func TestLogoutClosesSocket(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	w, _ := alice.Connect()
	alice.Do(http.MethodPost, "/api/auth/logout", nil, http.StatusNoContent, nil)
	require.Equal(t, gateway.CloseSessionInvalid, w.ExpectClose())
}

func TestHeartbeatTimeout(t *testing.T) {
	env := apptest.NewWithConfig(t, func(c *app.Config) {
		c.Gateway = gateway.Options{HeartbeatInterval: 100 * time.Millisecond, HeartbeatTimeout: 300 * time.Millisecond}
	})
	alice := env.Register("alice")
	w, _ := alice.Connect()
	w.Send(gateway.OpHeartbeat, nil)
	w.Expect(gateway.OpHeartbeatAck)
	code := w.ExpectClose() // we stop sending; the server gives up after 300ms
	require.NotEqual(t, gateway.CloseSessionInvalid, code, "a timeout must not force a re-login")
}

func TestRateLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	w, _ := alice.Connect()
	for i := 0; i < 40; i++ {
		if w.TrySend(gateway.OpHeartbeat, nil) != nil {
			break // the server is already closing the connection
		}
	}
	require.Equal(t, gateway.CloseRateLimited, w.ExpectClose())
}

func waitPresence(w *apptest.WS, user id.ID) string {
	for {
		var p gateway.PresenceUpdate
		w.ExpectDispatch("PRESENCE_UPDATE", &p)
		if p.UserID == user {
			return p.Status
		}
	}
}

func TestPresence(t *testing.T) {
	env := apptest.New(t)
	alice, bob, _ := pair(t, env)
	aliceWS, _ := alice.Connect()

	bobWS, _ := bob.Connect()
	require.Equal(t, gateway.StatusOnline, waitPresence(aliceWS, bob.User.ID))

	_, ready := alice.Connect() // a second Alice connection sees Bob in READY
	found := false
	for _, p := range ready.Presences {
		if p.UserID == bob.User.ID {
			found = p.Status == gateway.StatusOnline
		}
	}
	require.True(t, found)

	bobWS.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: gateway.StatusIdle})
	require.Equal(t, gateway.StatusIdle, waitPresence(aliceWS, bob.User.ID))
	bobWS.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: gateway.StatusInvisible})
	require.Equal(t, gateway.StatusOffline, waitPresence(aliceWS, bob.User.ID))
	bobWS.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: gateway.StatusOnline})
	require.Equal(t, gateway.StatusOnline, waitPresence(aliceWS, bob.User.ID))
	bobWS.Close()
	require.Equal(t, gateway.StatusOffline, waitPresence(aliceWS, bob.User.ID))
}

func TestActive(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	gw := env.App.Gateway
	require.False(t, gw.Active(alice.User.ID), "no connection")

	ws, _ := alice.Connect()
	require.Eventually(t, func() bool { return gw.Active(alice.User.ID) }, 2*time.Second, 10*time.Millisecond)

	ws.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: "idle"})
	require.Eventually(t, func() bool { return !gw.Active(alice.User.ID) }, 2*time.Second, 10*time.Millisecond, "idle is not active")

	ws.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: "invisible"})
	require.Eventually(t, func() bool { return gw.Active(alice.User.ID) }, 2*time.Second, 10*time.Millisecond, "invisible is still using the app")

	ws.Close()
	require.Eventually(t, func() bool { return !gw.Active(alice.User.ID) }, 2*time.Second, 10*time.Millisecond, "a dropped connection is not active")
}
