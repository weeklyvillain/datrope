package reminders_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/reminders"
)

// systemMessages returns c's messages from System, newest first; none before the conversation exists.
func systemMessages(c *apptest.Client) []messages.Message {
	var dms []channels.Channel
	c.Do(http.MethodGet, "/api/dms", nil, http.StatusOK, &dms)
	for _, d := range dms {
		for _, p := range d.Participants {
			if p.ID == auth.SystemUserID {
				var ms []messages.Message
				c.Do(http.MethodGet, "/api/channels/"+d.ID.String()+"/messages", nil, http.StatusOK, &ms)
				return ms
			}
		}
	}
	return nil
}

func TestFiresOnceWhenDue(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	ctx := context.Background()
	alice.Do(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(time.Hour), "note": "stretch"}, http.StatusCreated, nil)

	require.NoError(t, env.App.Reminders.FireDue(ctx))
	require.Empty(t, systemMessages(alice), "not due yet")

	start := time.Now()
	env.App.Reminders.SetClock(func() time.Time { return start.Add(2 * time.Hour) })
	require.Eventually(t, func() bool { return len(systemMessages(alice)) == 1 }, 5*time.Second, 50*time.Millisecond)
	require.NoError(t, env.App.Reminders.FireDue(ctx))
	ms := systemMessages(alice)
	require.Len(t, ms, 1, "a reminder fires once")
	require.Equal(t, messages.KindReminder, ms[0].Kind)
	require.Equal(t, "stretch", ms[0].Reminder.Note)

	var list reminders.ReminderList
	alice.Do(http.MethodGet, "/api/reminders", nil, http.StatusOK, &list)
	require.Empty(t, list.Reminders)
}

func TestFiresOnTimeInRealTime(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	ws, _ := alice.Connect()
	defer ws.Close()
	alice.Do(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(time.Second)}, http.StatusCreated, nil)
	var m messages.Message
	ws.ExpectDispatch("MESSAGE_CREATE", &m) // within ExpectDispatch's 5 s: the scheduler woke for it
	require.Equal(t, messages.KindReminder, m.Kind)
}

func TestOverdueFiresOnStart(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	_, err := env.Pool.Exec(context.Background(),
		`INSERT INTO reminders (id, user_id, due_at, note) VALUES ($1, $2, $3, 'missed while down')`,
		id.New(), alice.User.ID, time.Now().Add(-time.Hour))
	require.NoError(t, err)

	// A fresh service stands in for the server coming back up. The app's own scheduler
	// is asleep for up to a minute, so a message within seconds comes from this one.
	svc := reminders.NewService(env.Pool, env.App.Bus, env.App.Messages)
	svc.Start()
	t.Cleanup(svc.Close)
	require.Eventually(t, func() bool { return len(systemMessages(alice)) == 1 }, 5*time.Second, 50*time.Millisecond)
	require.Equal(t, "missed while down", systemMessages(alice)[0].Reminder.Note)
}
