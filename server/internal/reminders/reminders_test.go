package reminders_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/reminders"
)

// in is an instant d from now, to the nanosecond: whole seconds could round "in 1 s" into the past.
func in(d time.Duration) string { return time.Now().Add(d).UTC().Format(time.RFC3339Nano) }

func TestCreateListDelete(t *testing.T) {
	env := apptest.New(t)
	alice, bob := env.Register("alice"), env.Register("bob")
	general := alice.General()
	m := alice.Send(general, "review the release notes")

	var later, sooner reminders.Reminder
	bob.Do(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(2 * time.Hour), "note": "  dentist  "}, http.StatusCreated, &later)
	require.Equal(t, "dentist", later.Note)
	bob.Do(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(time.Hour), "channel_id": general.String(), "message_id": m.ID.String()}, http.StatusCreated, &sooner)
	require.Equal(t, "alice", sooner.Quote.AuthorName)

	var list reminders.ReminderList
	bob.Do(http.MethodGet, "/api/reminders", nil, http.StatusOK, &list)
	require.Len(t, list.Reminders, 2)
	require.Equal(t, sooner.ID, list.Reminders[0].ID, "soonest first")
	require.Equal(t, "general", list.Reminders[0].Quote.ChannelName)

	alice.Do(http.MethodGet, "/api/reminders", nil, http.StatusOK, &list)
	require.Empty(t, list.Reminders, "only your own")
	alice.Fail(http.MethodDelete, "/api/reminders/"+later.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
	bob.Do(http.MethodDelete, "/api/reminders/"+later.ID.String(), nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodDelete, "/api/reminders/"+later.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
}

func TestCreateValidation(t *testing.T) {
	env := apptest.New(t)
	alice, bob := env.Register("alice"), env.Register("bob")
	secret := alice.CreatePrivateChannel("secret")
	hush := alice.Send(secret, "hush")

	bob.Fail(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(-time.Minute)}, http.StatusBadRequest, "INVALID_DUE_AT")
	bob.Fail(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(367 * 24 * time.Hour)}, http.StatusBadRequest, "INVALID_DUE_AT")
	bob.Fail(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(time.Hour), "note": strings.Repeat("a", 501)}, http.StatusBadRequest, "VALIDATION_FAILED")
	bob.Fail(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(time.Hour), "message_id": hush.ID.String()}, http.StatusBadRequest, "VALIDATION_FAILED")
	bob.Fail(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(time.Hour), "channel_id": secret.String(), "message_id": hush.ID.String()}, http.StatusNotFound, "NOT_FOUND")

	for i := 0; i < reminders.MaxPending; i++ {
		bob.Do(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(time.Hour)}, http.StatusCreated, nil)
	}
	bob.Fail(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(time.Hour)}, http.StatusBadRequest, "TOO_MANY_REMINDERS")
}

func TestRemindersUpdateEvent(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	ws, _ := alice.Connect()
	defer ws.Close()
	alice.Do(http.MethodPost, "/api/reminders", map[string]any{"due_at": in(time.Hour)}, http.StatusCreated, nil)
	ws.ExpectDispatch("REMINDERS_UPDATE", nil)
}
