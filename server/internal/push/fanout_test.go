package push_test

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/push"
)

type sent struct {
	Endpoint string
	Payload  push.Payload
	Urgent   bool
}

type fakeSender struct {
	mu     sync.Mutex
	got    []sent
	status int // 0 → 201
}

func (f *fakeSender) Send(_ context.Context, sub push.Subscription, payload []byte, urgent bool) (int, error) {
	var p push.Payload
	if err := json.Unmarshal(payload, &p); err != nil {
		return 0, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, sent{sub.Endpoint, p, urgent})
	if f.status != 0 {
		return f.status, nil
	}
	return http.StatusCreated, nil
}

func (f *fakeSender) take() []sent {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.got
	f.got = nil
	return out
}

func newEnv(t *testing.T) (*apptest.Env, *fakeSender) {
	f := &fakeSender{}
	env := apptest.NewWithConfig(t, func(c *app.Config) {
		c.Push = push.Options{Sender: f, Inline: true, AllowedHosts: []string{"push.example"}}
	})
	return env, f
}

func subscribe(c *apptest.Client, endpoint, level string) {
	c.Do(http.MethodPut, "/api/push/subscription", sub(endpoint, level), http.StatusNoContent, nil)
}

func TestLevels(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	dave := env.Register("dave")
	subscribe(bob, "https://push.example/bob", "all")
	subscribe(carol, "https://push.example/carol", "mentions")
	subscribe(dave, "https://push.example/dave", "nothing")
	general := alice.General()

	alice.Send(general, "plain hello")
	got := f.take()
	require.Len(t, got, 1)
	require.Equal(t, "https://push.example/bob", got[0].Endpoint)
	require.Equal(t, "alice in #general", got[0].Payload.Title)
	require.Equal(t, "plain hello", got[0].Payload.Body)
	require.False(t, got[0].Urgent)

	alice.Send(general, "hey @carol")
	got = f.take()
	require.ElementsMatch(t, []string{"https://push.example/carol"}, endpoints(got),
		"bob's 10 s cap on #general holds back the second push; carol is mentioned")
	require.True(t, got[0].Urgent)
}

func TestIcon(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "all")

	// No server icon: the service worker falls back to Datrope's.
	alice.Send(alice.General(), "one")
	got := f.take()
	require.Len(t, got, 1)
	require.Empty(t, got[0].Payload.Icon)

	alice.UploadTo(http.MethodPut, "/api/server/icon", "icon.png", testPNG(t, 300, 300), http.StatusOK)
	alice.Send(alice.CreateTextChannel("news"), "two") // a new channel: the 10 s cap holds #general
	got = f.take()
	require.Len(t, got, 1)
	require.Regexp(t, `^/api/server/icon/192\.png\?v=[0-9a-f]{12}$`, got[0].Payload.Icon)
	env.Anon().Raw(http.MethodGet, got[0].Payload.Icon, nil, "", http.StatusOK)
}

func TestAuthorAndActiveAreSkipped(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(alice, "https://push.example/alice", "all")
	subscribe(bob, "https://push.example/bob", "all")

	ws, _ := bob.Connect()
	require.Eventually(t, func() bool { return env.App.Gateway.Active(bob.User.ID) }, 2*time.Second, 10*time.Millisecond)
	alice.Send(alice.General(), "hi")
	require.Empty(t, f.take(), "alice wrote it; bob is active")

	ws.Close()
	require.Eventually(t, func() bool { return !env.App.Gateway.Active(bob.User.ID) }, 2*time.Second, 10*time.Millisecond)
	alice.Send(alice.CreateTextChannel("other"), "hi again")
	require.Equal(t, []string{"https://push.example/bob"}, endpoints(f.take()))
}

func TestRoleAndEveryoneMentions(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "mentions")

	var role struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Crew", "permissions": 0, "mentionable": true}, http.StatusCreated, &role)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+role.ID.String(), nil, http.StatusNoContent, nil)

	alice.Send(alice.General(), "<@&"+role.ID.String()+"> meeting")
	require.Len(t, f.take(), 1, "role mention")

	alice.Send(alice.CreateTextChannel("news"), "@everyone big news")
	require.Len(t, f.take(), 1, "@everyone from the owner")
}

func TestDMCountsAsMention(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "mentions")
	dm := alice.OpenDM(bob.User.ID)
	alice.Send(dm, "psst")
	got := f.take()
	require.Len(t, got, 1)
	require.Equal(t, "alice (direct message)", got[0].Payload.Title)
	require.Equal(t, "/messages/"+dm.String(), got[0].Payload.URL)
	require.True(t, got[0].Urgent)
}

func TestPushThreadOpensParent(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "all")
	general := alice.General()
	root := alice.Send(general, "start")
	f.take()
	thread := alice.CreateThread(general, root.ID, "plans")
	alice.Send(thread, "in the thread")
	got := f.take()
	require.Len(t, got, 1)
	require.Equal(t, "alice in #general", got[0].Payload.Title)
	require.Equal(t, "/channels/"+general.String(), got[0].Payload.URL)
}

func TestRateCap(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "all")
	general := alice.General()
	for i := 0; i < 5; i++ {
		alice.Send(general, "spam")
	}
	require.Len(t, f.take(), 1, "one push per channel per 10 s")
	alice.Send(alice.CreateTextChannel("other"), "elsewhere")
	require.Len(t, f.take(), 1, "the cap is per channel")
}

func TestMentionIsNotCappedByPlainMessage(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "all")
	general := alice.General()
	alice.Send(general, "plain")
	require.Len(t, f.take(), 1)
	alice.Send(general, "hey @bob")
	got := f.take()
	require.Len(t, got, 1, "a mention gets through a slot used by a plain message")
	require.True(t, got[0].Urgent)
	alice.Send(general, "plain again")
	require.Empty(t, f.take(), "the third is capped")
}

func TestGoneSubscriptionIsPruned(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "all")
	f.status = http.StatusGone
	alice.Send(alice.General(), "hi")
	require.Equal(t, 0, count(t, env, "true"))
}

func TestNoAccessNoPush(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "all")
	private := alice.CreatePrivateChannel("secret") // denies ViewChannel to @everyone
	alice.Send(private, "hidden")
	require.Empty(t, f.take())
}

func endpoints(s []sent) []string {
	out := make([]string, len(s))
	for i, x := range s {
		out[i] = x.Endpoint
	}
	return out
}

func TestReminderPushesToItsOwner(t *testing.T) {
	env, f := newEnv(t)
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "mentions")

	r := messages.DueReminder{ID: id.New(), UserID: bob.User.ID, Note: "stand up"}
	_, err := env.Pool.Exec(context.Background(),
		`INSERT INTO reminders (id, user_id, due_at, note, fired_at) VALUES ($1, $2, now(), $3, now())`, r.ID, r.UserID, r.Note)
	require.NoError(t, err)
	_, err = env.App.Messages.PostReminder(context.Background(), r)
	require.NoError(t, err)

	got := f.take()
	require.Len(t, got, 1, "a reminder is a DM, so it pushes even at the mentions level")
	require.Equal(t, "https://push.example/bob", got[0].Endpoint)
	require.Contains(t, got[0].Payload.Body, "stand up")
}
