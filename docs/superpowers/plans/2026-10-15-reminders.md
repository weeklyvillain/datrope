# Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Remind me" on messages and a `/remind` command. A System account DMs you at the chosen time.

**Architecture:** A seeded System user (`users.is_system`, ID `1<<22 - 1`) owns a read-only 1:1 DM with each user. A new `internal/reminders` package stores reminders in Postgres. Its single scheduler goroutine sleeps until the next `due_at` (at most 1 min), is woken on create and cancel, claims due rows with `FOR UPDATE SKIP LOCKED`, and asks `messages.PostReminder` to post a `kind = "reminder"` message in the System DM. Messages hydrate a live `reminder` field (note, quote, target) with an access check. The web client resolves every time input to a UTC instant: presets, a wheel dialog, and the `/remind` syntax.

**Tech Stack:** Go 1.25, huma/v2, pgx/v5, goose migrations, testify + apptest/pgtest (Docker Postgres). React 18, shadcn/ui (new-york) + Tailwind v4, zustand, vitest (node environment, no DOM: test pure logic and `renderToStaticMarkup`).

**Spec:** `docs/superpowers/specs/2026-10-14-reminders-design.md`. Mockups: `docs/superpowers/mockups/Reminders.html` (setting a reminder = concept A, dialog = concept C).

## Global Constraints

- **Never commit.** AGENTS.md §5: the user makes every commit. Each task ends with "stage", not "commit".
- Migration file `server/internal/db/migrations/00043_reminders.sql`. Sibling branches may also take 00043, so renumber at merge (noted in the shared notes folder).
- The System user is `auth.SystemUserID = 1<<22 - 1` (4194303), username `system`, display name `System`, `password_hash '!'`, `disabled = TRUE`, `is_system = TRUE`. The `disabled` flag keeps it out of the `NOT disabled` owner and member queries in `communities.go`.
- Limits: note ≤ 500 characters; `due_at` must be in the future and ≤ 366 days ahead; ≤ 100 pending reminders per user; scheduler batch 50; max sleep 1 min.
- Error codes: `INVALID_DUE_AT` (400), `TOO_MANY_REMINDERS` (400), `SYSTEM_DM` (403), `NOT_FOUND` (404 via `httpx.NotFound`), `VALIDATION_FAILED` (huma).
- Event `REMINDERS_UPDATE` (empty payload) goes to the owner whenever their pending list changes (create, cancel, fire).
- Copy (English, exact): "Remind me", "In 20 minutes", "In 1 hour", "In 3 hours", "Tomorrow", "Next week", "Custom…", "Remind me about this message", "New reminder", "Set reminder", "Cancel", "Reminder set for …", "Undo", "Reminders", "No reminders. Use /remind or Remind me on a message.", "You can't reply to System.", "Jump to message", "Message unavailable — it was deleted, or you no longer have access.", "That time has passed", "System" (badge).
- `/remind` usage error, exact: `Usage: /remind <20m|2h|14:30|tomorrow 9|fri 13:00> <text>`.
- Web: dark only, tokens only (no hex), `cn()`, `@/` imports, `Button` defaults to `type="button"`. React 18: wrap in `forwardRef` before using as an `asChild` trigger. Keep accessible names stable.
- Commands are prefixed with `rtk` per the user's CLAUDE.md (`rtk go test …`, `rtk pnpm …`).

## Review Focus

1. **A user who registers first after the migration must still become admin and owner.** The System row would otherwise count as the first user. Covered in Task 1 (`count(*) … WHERE NOT is_system`; `disabled = TRUE` for the owner and member queries).
2. **A real person named "system" exists, or registers later.** Login, `@system` mentions and registration must hit that person, never the System row. Covered in Task 1 tests.
3. **A reminder targets a message the owner can no longer see.** The DM and the list must show `unavailable` and never the text. Covered in Task 3 (hydration) and Task 4 (list) tests, including access lost *after* firing.
4. **The server restarts while reminders are due.** They fire once on boot; never zero times, never twice. Covered in Task 5 (fresh-service test and fire-once test).
5. **Clock-time input near midnight, or a weekday equal to today.** `14:30` after 14:30 means tomorrow; `mon` on a Monday means next week. Covered in Task 7 tests.

---

## File Structure

Server:
- `server/internal/db/migrations/00043_reminders.sql` — new: System user, `reminders` table, `messages.reminder_id`.
- `server/internal/auth/store.go` — modify: `SystemUserID`, `PublicUser.System`, filters for the System row.
- `server/internal/auth/system_test.go` — new.
- `server/internal/channels/handlers.go` — modify: split `createDM` into validation plus `openDM`; reject System as a recipient.
- `server/internal/channels/system_dm.go` — new: `SystemDM`, `IsSystemDM`.
- `server/internal/channels/system_dm_test.go` — new.
- `server/internal/messages/reminder.go` — new: `KindReminder`, `ReminderInfo`/`ReminderTarget`/`ReminderQuote`, `DueReminder`, `PostReminder`, `Quote`, `withReminders`.
- `server/internal/messages/messages.go` — modify: `Message.Reminder`, `Kind` enum, `Channels` interface, `hydrate`.
- `server/internal/messages/handlers.go` — modify: `SYSTEM_DM` on send.
- `server/internal/messages/reminder_test.go` — new.
- `server/internal/reminders/reminders.go` — new: service, create/list/delete, scheduler.
- `server/internal/reminders/handlers.go` — new: huma routes.
- `server/internal/reminders/reminders_test.go`, `scheduler_test.go` — new.
- `server/internal/app/app.go`, `app/realtime.go` — modify: wiring, event schema.

Clients:
- `clients/core/src/schema.d.ts`, `openapi.json` — regenerated.
- `clients/core/src/types.ts`, `client.ts` — modify: types plus 3 methods.
- `clients/web/src/chat/remind-time.ts` + `.test.ts` — new: all time math (pure).
- `clients/web/src/chat/commands.ts` + `commands.test.tsx` — modify: `/remind`, `/reminders`.
- `clients/web/src/components/ui/sonner.tsx` — new (shadcn); `main.tsx` mounts `<Toaster />`.
- `clients/web/src/app/reminders/reminders.ts` — new: `isSystemDM`, `setReminder` (toast + Undo), `useReminders`.
- `clients/web/src/app/reminders/Wheel.tsx`, `ReminderDialog.tsx` — new.
- `clients/web/src/app/reminders/RemindMenuItems.tsx` — new: preset items for the dropdown and the context menu.
- `clients/web/src/app/reminders/ReminderCard.tsx`, `SystemBadge.tsx`, `RemindersPanel.tsx` — new.
- `clients/web/src/app/side-panel/panel.ts`, `panel-param.ts` (+ test) — modify: `{kind: "reminders"}`.
- `clients/web/src/app/message-actions.ts` (+ test), `MessageSheet.tsx`, `MessageToolbar.tsx`, `MessageList.tsx`, `Composer.tsx`, `ChannelView.tsx`, `forum/ForumView.tsx`, `gallery/GalleryView.tsx` — modify.
- `clients/web/src/components/user-avatar.tsx` — modify: System avatar.

---

### Task 1: Migration and System user in auth

**Files:**
- Create: `server/internal/db/migrations/00043_reminders.sql`
- Modify: `server/internal/auth/store.go` (`User`/`PublicUser` area ~L27-65, `CreateUser` count ~L121, `CountUsers` ~L140, `UserByLogin` ~L151, `ListUsers` ~L155, `PublicUsers` ~L172, `UserIDsByUsername` ~L336)
- Test: `server/internal/auth/system_test.go`

**Interfaces:**
- Produces: `auth.SystemUserID id.ID = 1<<22 - 1`; `auth.PublicUser.System bool` (`json:"system,omitempty"`); the `reminders` table; `messages.reminder_id` column.

- [ ] **Step 1: Write the migration**

```sql
-- +goose Up
-- The System account sends reminders. It cannot log in ('!' matches no bcrypt hash),
-- and disabled keeps it out of the server's owner and member queries.
ALTER TABLE users ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX users_one_system ON users (is_system) WHERE is_system;
-- A real user may already be called "system": System sits outside the username index.
DROP INDEX users_username_key;
CREATE UNIQUE INDEX users_username_key ON users (lower(username)) WHERE NOT is_system;
INSERT INTO users (id, username, display_name, password_hash, disabled, is_system)
VALUES (4194303, 'system', 'System', '!', TRUE, TRUE);

CREATE TABLE reminders (
    id         BIGINT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    due_at     TIMESTAMPTZ NOT NULL,
    note       TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
    channel_id BIGINT, -- the message reminded about; no FK: it may be deleted later
    message_id BIGINT,
    fired_at   TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((channel_id IS NULL) = (message_id IS NULL))
);
CREATE INDEX reminders_due_idx ON reminders (due_at) WHERE fired_at IS NULL;
CREATE INDEX reminders_user_idx ON reminders (user_id) WHERE fired_at IS NULL;

-- Set on kind = 'reminder' messages: the reminder they delivered.
ALTER TABLE messages ADD COLUMN reminder_id BIGINT;

-- +goose Down
ALTER TABLE messages DROP COLUMN reminder_id;
DROP TABLE reminders;
DELETE FROM users WHERE is_system;
DROP INDEX users_username_key;
CREATE UNIQUE INDEX users_username_key ON users (lower(username));
DROP INDEX users_one_system;
ALTER TABLE users DROP COLUMN is_system;
```

- [ ] **Step 2: Write the failing test** — `server/internal/auth/system_test.go`

```go
package auth_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
)

func TestSystemUserStaysOutOfTheWay(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	require.True(t, alice.User.IsAdmin, "System must not count as the first user")

	env.Anon().Fail(http.MethodPost, "/api/auth/login",
		map[string]any{"login": "system", "password": "!", "device_name": "t", "client": "native"},
		http.StatusUnauthorized, "INVALID_CREDENTIALS")

	// The username stays free for people, and then logs in as that person.
	sys := env.Register("system")
	require.False(t, sys.User.IsAdmin)
	var res map[string]any
	env.Anon().Do(http.MethodPost, "/api/auth/login",
		map[string]any{"login": "system", "password": "password123", "device_name": "t", "client": "native"}, http.StatusOK, &res)

	// @system mentions the person, not the System account.
	ch := alice.General()
	m := alice.Send(ch, "hi @system")
	require.Equal(t, sys.User.ID, m.Mentions[0])
}
```

- [ ] **Step 3: Run it to verify it fails**

Run (from `server/`): `rtk go test ./internal/auth/ -run TestSystemUserStaysOutOfTheWay -v`
Expected: FAIL. Either the migration is missing (`relation "reminders"` / no row), or `alice.User.IsAdmin` is false once the migration exists but the count filter does not.

- [ ] **Step 4: Implement the auth changes** in `server/internal/auth/store.go`

Add near the `User` type:

```go
// SystemUserID is the System account: it sends reminders and cannot log in.
const SystemUserID id.ID = 1
```

Add to `PublicUser`, after `GuestExpiresAt`:

```go
	System bool `json:"system,omitempty" doc:"The System account, which sends reminders; it cannot be messaged"`
```

`PublicUsers`: select `is_system` and scan it:

```go
	rows, err := s.db.Query(ctx, `SELECT id, username, display_name, custom_status, pronouns, about_me, avatar_sha256, banner_sha256, links, guest_expires_at, is_system FROM users WHERE id = ANY($1)`, id.Int64s(ids))
	...
		if err := rows.Scan(&p.ID, &p.Username, &p.DisplayName, &p.CustomStatus, &p.Pronouns, &p.AboutMe, &avatar, &banner, &p.Links, &p.GuestExpiresAt, &p.System); err != nil {
```

Filters (each is one line):
- In `CreateUser`: `SELECT count(*) FROM users WHERE NOT is_system`
- `CountUsers`: `SELECT count(*) FROM users WHERE NOT is_system`
- `UserByLogin`: `... FROM users u WHERE NOT u.is_system AND (lower(u.username) = lower($1) OR lower(u.email) = lower($1))`
- `ListUsers`: `SELECT `+userCols+` FROM users u WHERE NOT u.is_system ORDER BY u.id`
- `UserIDsByUsername`: `SELECT lower(username), id FROM users WHERE NOT is_system AND lower(username) = ANY($1)`

- [ ] **Step 5: Run the test and the auth package**

Run: `rtk go test ./internal/auth/ ./internal/communities/ -v -run .`
Expected: PASS (all existing tests too).

- [ ] **Step 6: Stage** (no commit)

```bash
rtk git add server/internal/db/migrations/00043_reminders.sql server/internal/auth/store.go server/internal/auth/system_test.go
```

---

### Task 2: System DM in channels

**Files:**
- Create: `server/internal/channels/system_dm.go`, `server/internal/channels/system_dm_test.go`
- Modify: `server/internal/channels/handlers.go:516-570` (`createDM`)

**Interfaces:**
- Consumes: `auth.SystemUserID`, `PublicUser.System` (Task 1).
- Produces: `func (s *Service) SystemDM(ctx context.Context, userID id.ID) (*Channel, error)`; `func IsSystemDM(c *Channel) bool`.

- [ ] **Step 1: Write the failing test** — `system_dm_test.go`

```go
package channels_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
)

func TestSystemDM(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	ctx := context.Background()

	dm, err := env.App.Channels.SystemDM(ctx, alice.User.ID)
	require.NoError(t, err)
	require.True(t, channels.IsSystemDM(dm))
	again, err := env.App.Channels.SystemDM(ctx, alice.User.ID)
	require.NoError(t, err)
	require.Equal(t, dm.ID, again.ID, "one conversation per user")

	var list []channels.Channel
	alice.Do(http.MethodGet, "/api/dms", nil, http.StatusOK, &list)
	require.Len(t, list, 1)
	var sys *auth.PublicUser
	for i, p := range list[0].Participants {
		if p.ID == auth.SystemUserID {
			sys = &list[0].Participants[i]
		}
	}
	require.NotNil(t, sys)
	require.True(t, sys.System)
	require.Equal(t, "System", sys.DisplayName)

	alice.Fail(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{auth.SystemUserID.String()}},
		http.StatusBadRequest, "INVALID_RECIPIENTS")
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk go test ./internal/channels/ -run TestSystemDM -v`
Expected: compile error, `SystemDM` undefined.

- [ ] **Step 3: Split `createDM`** in `handlers.go`. Keep the validation in `createDM`, move everything from `if len(others) == 1 { // reuse …` to the end into `openDM`, and reject System:

```go
func (s *Service) createDM(ctx context.Context, creator id.ID, recipients []id.ID) (*Channel, error) {
	others := []id.ID{}
	for _, r := range recipients {
		if r != creator && !slices.Contains(others, r) {
			others = append(others, r)
		}
	}
	if len(others) == 0 || len(others) != len(recipients) || slices.Contains(others, auth.SystemUserID) {
		return nil, httpx.BadRequest("INVALID_RECIPIENTS", "list 1 to 9 other users, without duplicates")
	}
	for _, r := range others {
		// … unchanged SharesCommunity loop …
	}
	return s.openDM(ctx, creator, others)
}

// openDM returns the 1:1 conversation between creator and others[0] when there is one,
// or creates the conversation and announces it.
func (s *Service) openDM(ctx context.Context, creator id.ID, others []id.ID) (*Channel, error) {
	// … the former body from "if len(others) == 1 {" through "return c, nil", unchanged …
}
```

(`auth` is already imported in this package; add the import to `handlers.go` if that file doesn't have it.)

- [ ] **Step 4: Create `system_dm.go`**

```go
package channels

import (
	"context"
	"slices"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
)

// SystemDM returns userID's conversation with the System account, creating it on first use.
// Unlike people, System needs no shared server.
func (s *Service) SystemDM(ctx context.Context, userID id.ID) (*Channel, error) {
	return s.openDM(ctx, userID, []id.ID{auth.SystemUserID})
}

// IsSystemDM reports whether c is a conversation with the System account, which nobody can reply to.
func IsSystemDM(c *Channel) bool {
	return c.Type == TypeDM && slices.ContainsFunc(c.Participants, func(p auth.PublicUser) bool { return p.ID == auth.SystemUserID })
}
```

- [ ] **Step 5: Run the test and the channels package**

Run: `rtk go test ./internal/channels/ -v`
Expected: PASS.

- [ ] **Step 6: Stage**

```bash
rtk git add server/internal/channels/
```

---

### Task 3: Reminder messages: post, hydrate, read-only DM

**Files:**
- Create: `server/internal/messages/reminder.go`, `server/internal/messages/reminder_test.go`
- Modify: `server/internal/messages/messages.go` (`Channels` interface L25-30, `Message` L51-77, `hydrate` L221-238), `server/internal/messages/handlers.go` (send-message, right after `access(...)` ~L131)

**Interfaces:**
- Consumes: `channels.(*Service).SystemDM`, `channels.IsSystemDM`, `auth.SystemUserID` (Tasks 1-2).
- Produces:
  - `const KindReminder = "reminder"`
  - `type DueReminder struct { ID, UserID id.ID; Note string; ChannelID, MessageID *id.ID }`
  - `func (s *Service) PostReminder(ctx context.Context, r DueReminder) (*Message, error)`
  - `func (s *Service) Quote(ctx context.Context, viewer, channelID, messageID id.ID) (*ReminderQuote, error)`: nil, nil when the viewer can't read it or it's gone.
  - `type ReminderQuote struct { AuthorName string "author_name"; ChannelName string "channel_name"; CreatedAt time.Time "created_at"; Excerpt string "excerpt" }`
  - `type ReminderTarget struct { ChannelID, MessageID id.ID }` (`channel_id`, `message_id`)
  - `type ReminderInfo struct { Note string; Target *ReminderTarget; Quote *ReminderQuote; Unavailable bool }` (`note`, `target`, `quote`, `unavailable`)
  - `Message.Reminder *ReminderInfo` (`json:"reminder,omitempty"`)

- [ ] **Step 1: Write the failing test** — `reminder_test.go`

```go
package messages_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

// insertReminder stores a fired reminder row, as the scheduler would have claimed it.
func insertReminder(t *testing.T, env *apptest.Env, r messages.DueReminder) {
	t.Helper()
	_, err := env.Pool.Exec(context.Background(),
		`INSERT INTO reminders (id, user_id, due_at, note, channel_id, message_id, fired_at) VALUES ($1, $2, now(), $3, $4, $5, now())`,
		r.ID, r.UserID, r.Note, r.ChannelID, r.MessageID)
	require.NoError(t, err)
}

func TestPostReminderQuotesLive(t *testing.T) {
	env, alice, bob, sid, _ := setup(t)
	ctx := context.Background()
	team := alice.CreateTextChannel("team")
	target := alice.Send(team, "review the release notes")

	r := messages.DueReminder{ID: id.New(), UserID: bob.User.ID, Note: "notes!", ChannelID: &team, MessageID: &target.ID}
	insertReminder(t, env, r)
	m, err := env.App.Messages.PostReminder(ctx, r)
	require.NoError(t, err)
	require.Equal(t, messages.KindReminder, m.Kind)
	require.Equal(t, auth.SystemUserID, m.Author.ID)
	require.True(t, m.Author.System)
	require.Equal(t, "Reminder: notes!", m.Content)
	require.Equal(t, "notes!", m.Reminder.Note)
	require.Equal(t, &messages.ReminderTarget{ChannelID: team, MessageID: target.ID}, m.Reminder.Target)
	require.Equal(t, "alice", m.Reminder.Quote.AuthorName)
	require.Equal(t, "team", m.Reminder.Quote.ChannelName)
	require.Equal(t, "review the release notes", m.Reminder.Quote.Excerpt)

	path := "/api/channels/" + m.ChannelID.String() + "/messages"
	// Bob loses access after it fired: the quote goes away, nothing leaks.
	alice.Do(http.MethodPut, "/api/channels/"+team.String()+"/overrides/role/"+sid.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	var page []messages.Message
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.True(t, page[0].Reminder.Unavailable)
	require.Nil(t, page[0].Reminder.Quote)
	require.Nil(t, page[0].Reminder.Target)

	// Nobody can reply to System.
	bob.Fail(http.MethodPost, path, map[string]any{"content": "thanks"}, http.StatusForbidden, "SYSTEM_DM")
}

func TestReminderQuoteGoneWhenDeleted(t *testing.T) {
	env, alice, _, _, general := setup(t)
	ctx := context.Background()
	target := alice.Send(general, "temporary")
	r := messages.DueReminder{ID: id.New(), UserID: alice.User.ID, ChannelID: &general, MessageID: &target.ID}
	insertReminder(t, env, r)
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+target.ID.String(), nil, http.StatusNoContent, nil)
	m, err := env.App.Messages.PostReminder(ctx, r)
	require.NoError(t, err)
	require.Equal(t, "Reminder", m.Content)
	require.True(t, m.Reminder.Unavailable)

	free := messages.DueReminder{ID: id.New(), UserID: alice.User.ID, Note: "stretch"}
	insertReminder(t, env, free)
	m, err = env.App.Messages.PostReminder(ctx, free)
	require.NoError(t, err)
	require.False(t, m.Reminder.Unavailable)
	require.Nil(t, m.Reminder.Target)
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk go test ./internal/messages/ -run 'Reminder' -v`
Expected: compile error, `messages.DueReminder` undefined.

- [ ] **Step 3: Edit `messages.go`**

Add `SystemDM` to the `Channels` interface:

```go
	SystemDM(ctx context.Context, userID id.ID) (*channels.Channel, error)
```

In `Message`, change the `Kind` tag and add `Reminder`:

```go
	Kind            string               `json:"kind,omitempty" enum:"member_leave,reminder" doc:"Set on system messages: member_leave means the author left the group DM; reminder is a reminder System delivered"`
	Reminder        *ReminderInfo        `json:"reminder,omitempty" doc:"Reminder messages only"`
```

In `hydrate`, replace the final `return s.withThreads(ctx, ms)` with:

```go
	if err := s.withThreads(ctx, ms); err != nil {
		return err
	}
	return s.withReminders(ctx, ms)
```

- [ ] **Step 4: Create `reminder.go`**

```go
package messages

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// KindReminder marks a reminder the System account delivered.
const KindReminder = "reminder"

const excerptLen = 200

// DueReminder is a reminder the scheduler claimed and wants delivered.
type DueReminder struct {
	ID, UserID           id.ID
	Note                 string
	ChannelID, MessageID *id.ID
}

// ReminderTarget is the message a reminder is about.
type ReminderTarget struct {
	ChannelID id.ID `json:"channel_id"`
	MessageID id.ID `json:"message_id"`
}

// ReminderQuote shows the message a reminder is about, as the reader may see it now.
type ReminderQuote struct {
	AuthorName  string    `json:"author_name" doc:"The author's display name, or a webhook's name"`
	ChannelName string    `json:"channel_name" doc:"Empty in a DM"`
	CreatedAt   time.Time `json:"created_at"`
	Excerpt     string    `json:"excerpt" doc:"Up to 200 characters; empty when the message is only attachments"`
}

// ReminderInfo is what a reminder message shows, resolved for its reader each time it is read.
type ReminderInfo struct {
	Note        string          `json:"note"`
	Target      *ReminderTarget `json:"target,omitempty" doc:"Absent for a free-text reminder, or when the message is unavailable"`
	Quote       *ReminderQuote  `json:"quote,omitempty"`
	Unavailable bool            `json:"unavailable,omitempty" doc:"The message was deleted, or the reader can no longer see it"`
}

// PostReminder delivers a reminder: a message from System in the owner's System DM.
func (s *Service) PostReminder(ctx context.Context, r DueReminder) (*Message, error) {
	dm, err := s.channels.SystemDM(ctx, r.UserID)
	if err != nil {
		return nil, err
	}
	content := "Reminder"
	if r.Note != "" {
		content += ": " + r.Note
	}
	m := &Message{ID: id.New(), ChannelID: dm.ID, Author: &auth.PublicUser{ID: auth.SystemUserID}, Content: content,
		Mentions: []id.ID{}, MentionRoles: []id.ID{}, Kind: KindReminder}
	m.CreatedAt = m.ID.Time()
	if _, err := s.db.Exec(ctx, `INSERT INTO messages (id, channel_id, author_id, content, kind, reminder_id) VALUES ($1, $2, $3, $4, $5, $6)`,
		m.ID, dm.ID, auth.SystemUserID, content, KindReminder, r.ID); err != nil {
		return nil, err
	}
	one := []Message{*m}
	if err := s.hydrate(ctx, one); err != nil {
		return nil, err
	}
	s.publish("MESSAGE_CREATE", dm.ID, &one[0])
	return &one[0], nil
}

// Quote shows a message to viewer, or returns nil when it is deleted or viewer cannot read its channel.
func (s *Service) Quote(ctx context.Context, viewer, channelID, messageID id.ID) (*ReminderQuote, error) {
	ch, _, err := s.channels.Access(ctx, viewer, channelID, perms.ViewChannel|perms.ReadHistory)
	var denied *httpx.Error
	if errors.As(err, &denied) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m, err := scanMessage(s.db.QueryRow(ctx,
		`SELECT `+messageCols+` FROM messages WHERE id = $1 AND channel_id = $2 AND NOT deleted`, messageID, channelID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	one := []Message{*m}
	if err := s.withAuthors(ctx, one); err != nil {
		return nil, err
	}
	q := &ReminderQuote{ChannelName: ch.Name, CreatedAt: one[0].CreatedAt, Excerpt: excerpt(one[0].Content)}
	switch a := one[0].Author; {
	case a != nil && a.DisplayName != "":
		q.AuthorName = a.DisplayName
	case a != nil:
		q.AuthorName = a.Username
	case one[0].Webhook != nil:
		q.AuthorName = one[0].Webhook.Name
	}
	return q, nil
}

func excerpt(s string) string {
	r := []rune(s)
	if len(r) <= excerptLen {
		return s
	}
	return string(r[:excerptLen]) + "…"
}

// withReminders fills Reminder on reminder messages. Only the owner reads their System DM,
// so the quote is resolved as the owner sees it now.
func (s *Service) withReminders(ctx context.Context, ms []Message) error {
	var ids []id.ID
	for _, m := range ms {
		if m.Kind == KindReminder && !m.Deleted {
			ids = append(ids, m.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT m.id, r.user_id, r.note, r.channel_id, r.message_id
		FROM messages m JOIN reminders r ON r.id = m.reminder_id WHERE m.id = ANY($1)`, id.Int64s(ids))
	if err != nil {
		return err
	}
	type row struct {
		owner     id.ID
		note      string
		ch, msg   *id.ID
	}
	got := map[id.ID]row{}
	for rows.Next() {
		var mid id.ID
		var r row
		var ch, msg *int64
		if err := rows.Scan(&mid, &r.owner, &r.note, &ch, &msg); err != nil {
			rows.Close()
			return err
		}
		r.ch, r.msg = id.FromNullable(ch), id.FromNullable(msg)
		got[mid] = r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range ms {
		r, ok := got[ms[i].ID]
		if !ok {
			continue
		}
		info := &ReminderInfo{Note: r.note}
		if r.ch != nil && r.msg != nil {
			q, err := s.Quote(ctx, r.owner, *r.ch, *r.msg)
			if err != nil {
				return err
			}
			if q == nil {
				info.Unavailable = true
			} else {
				info.Quote, info.Target = q, &ReminderTarget{ChannelID: *r.ch, MessageID: *r.msg}
			}
		}
		ms[i].Reminder = info
	}
	return nil
}
```

- [ ] **Step 5: Reject replies in `handlers.go`** (send-message), right after `ch, have, err := access(ctx, in.ID, need)` and its error check:

```go
			if channels.IsSystemDM(ch) {
				return nil, httpx.E(http.StatusForbidden, "SYSTEM_DM", "you can't reply to System")
			}
```

- [ ] **Step 6: Run the tests**

Run: `rtk go test ./internal/messages/ -v`
Expected: PASS. If `IsSystemDM` is false because `Access` returned a channel without `Participants`, load them in `IsSystemDM`'s caller with `s.channels.Get(ctx, ch.ID)` (which fills participants) before the check, and re-run.

- [ ] **Step 7: Stage**

```bash
rtk git add server/internal/messages/
```

---

### Task 4: `internal/reminders` service and API

**Files:**
- Create: `server/internal/reminders/reminders.go`, `server/internal/reminders/handlers.go`, `server/internal/reminders/reminders_test.go`
- Modify: `server/internal/app/app.go` (`App` struct ~L36-58; after `a.Messages = msgSvc` ~L154), `server/internal/app/realtime.go:186-194` (event schema list)

**Interfaces:**
- Consumes: `messages.(*Service).Quote`, `.PostReminder`, `messages.DueReminder`, `messages.ReminderQuote` (Task 3).
- Produces:
  - `reminders.NewService(db *pgxpool.Pool, bus *events.Bus, m Messages) *Service`
  - `reminders.Register(api huma.API, s *Service)`
  - `type Reminder struct { ID id.ID; DueAt time.Time; Note string; ChannelID, MessageID *id.ID; Quote *messages.ReminderQuote }` (JSON `id, due_at, note, channel_id, message_id, quote`)
  - `type List struct { Reminders []Reminder "reminders" }`
  - `type RemindersUpdate struct{}`; `App.Reminders *reminders.Service`
  - (Task 5 adds `Start`, `Close`, `FireDue`, `SetClock`.)

- [ ] **Step 1: Write the failing test** — `reminders_test.go`

```go
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

	var list reminders.List
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk go test ./internal/reminders/ -v`
Expected: FAIL, package `reminders` doesn't exist.

- [ ] **Step 3: Create `reminders.go`** (scheduler fields included; Task 5 adds the loop)

```go
// Package reminders stores reminders and delivers them as DMs from the System account when they are due.
package reminders

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
)

const (
	MaxPending = 100                  // pending reminders per user
	MaxAhead   = 366 * 24 * time.Hour // how far ahead a reminder may be set
	batch      = 50                   // reminders claimed per query
	maxWait    = time.Minute          // the scheduler looks again at least this often
)

// Messages is what this package needs from messages.
type Messages interface {
	Quote(ctx context.Context, viewer, channelID, messageID id.ID) (*messages.ReminderQuote, error)
	PostReminder(ctx context.Context, r messages.DueReminder) (*messages.Message, error)
}

type Reminder struct {
	ID        id.ID                   `json:"id"`
	DueAt     time.Time               `json:"due_at"`
	Note      string                  `json:"note"`
	ChannelID *id.ID                  `json:"channel_id,omitempty"`
	MessageID *id.ID                  `json:"message_id,omitempty"`
	Quote     *messages.ReminderQuote `json:"quote,omitempty" doc:"The message, as I may see it now; absent for free text or when unavailable"`
}

type List struct {
	Reminders []Reminder `json:"reminders" doc:"Pending reminders, soonest first"`
}

type CreateRequest struct {
	DueAt     time.Time `json:"due_at" doc:"When to remind; in the future, at most 366 days ahead"`
	Note      string    `json:"note,omitempty" maxLength:"500"`
	ChannelID *id.ID    `json:"channel_id,omitempty" doc:"With message_id: the message to be reminded about"`
	MessageID *id.ID    `json:"message_id,omitempty"`
}

// RemindersUpdate tells a user their pending reminders changed; clients refetch the list.
type RemindersUpdate struct{}

type Service struct {
	db       *pgxpool.Pool
	bus      *events.Bus
	messages Messages
	wake     chan struct{} // nudges the scheduler: a reminder was added or removed
	done     chan struct{}
	stop     sync.Once
	wg       sync.WaitGroup
	mu       sync.Mutex
	clock    func() time.Time
}

func NewService(db *pgxpool.Pool, bus *events.Bus, m Messages) *Service {
	return &Service{db: db, bus: bus, messages: m, wake: make(chan struct{}, 1), done: make(chan struct{}), clock: time.Now}
}

func (s *Service) now() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.clock()
}

func (s *Service) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Service) changed(userID id.ID) {
	s.bus.Publish(events.Event{Type: "REMINDERS_UPDATE", Data: RemindersUpdate{}, Scope: events.Scope{UserIDs: []id.ID{userID}}})
}

func (s *Service) create(ctx context.Context, userID id.ID, req CreateRequest) (*Reminder, error) {
	now := s.now()
	if !req.DueAt.After(now) || req.DueAt.After(now.Add(MaxAhead)) {
		return nil, httpx.BadRequest("INVALID_DUE_AT", "pick a time in the future, at most a year ahead")
	}
	if (req.ChannelID == nil) != (req.MessageID == nil) {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "give both channel_id and message_id, or neither")
	}
	r := &Reminder{ID: id.New(), DueAt: req.DueAt.UTC(), Note: strings.TrimSpace(req.Note), ChannelID: req.ChannelID, MessageID: req.MessageID}
	if r.MessageID != nil {
		q, err := s.messages.Quote(ctx, userID, *r.ChannelID, *r.MessageID)
		if err != nil {
			return nil, err
		}
		if q == nil {
			return nil, httpx.NotFound("message")
		}
		r.Quote = q
	}
	tag, err := s.db.Exec(ctx, `
		INSERT INTO reminders (id, user_id, due_at, note, channel_id, message_id)
		SELECT $1, $2, $3, $4, $5, $6
		WHERE (SELECT count(*) FROM reminders WHERE user_id = $2 AND fired_at IS NULL) < $7`,
		r.ID, userID, r.DueAt, r.Note, r.ChannelID, r.MessageID, MaxPending)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, httpx.BadRequest("TOO_MANY_REMINDERS", "you have 100 pending reminders; cancel one first")
	}
	s.changed(userID)
	s.poke()
	return r, nil
}

func (s *Service) list(ctx context.Context, userID id.ID) ([]Reminder, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, due_at, note, channel_id, message_id FROM reminders
		WHERE user_id = $1 AND fired_at IS NULL ORDER BY due_at, id`, userID)
	if err != nil {
		return nil, err
	}
	out := []Reminder{}
	for rows.Next() {
		var r Reminder
		var ch, msg *int64
		if err := rows.Scan(&r.ID, &r.DueAt, &r.Note, &ch, &msg); err != nil {
			rows.Close()
			return nil, err
		}
		r.ChannelID, r.MessageID = id.FromNullable(ch), id.FromNullable(msg)
		out = append(out, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, r := range out {
		if r.MessageID == nil {
			continue
		}
		q, err := s.messages.Quote(ctx, userID, *r.ChannelID, *r.MessageID)
		if err != nil {
			return nil, err
		}
		out[i].Quote = q
	}
	return out, nil
}

func (s *Service) delete(ctx context.Context, userID, reminderID id.ID) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM reminders WHERE id = $1 AND user_id = $2 AND fired_at IS NULL`, reminderID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("reminder")
	}
	s.changed(userID)
	s.poke()
	return nil
}
```

- [ ] **Step 4: Create `handlers.go`**

```go
package reminders

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

func Register(api huma.API, s *Service) {
	tags := []string{"reminders"}
	huma.Register(api, huma.Operation{OperationID: "create-reminder", Method: http.MethodPost, Path: "/api/reminders",
		DefaultStatus: http.StatusCreated, Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, in *struct{ Body CreateRequest }) (*struct{ Body *Reminder }, error) {
			r, err := s.create(ctx, auth.Current(ctx).User.ID, in.Body)
			return &struct{ Body *Reminder }{r}, err
		})
	huma.Register(api, huma.Operation{OperationID: "list-reminders", Method: http.MethodGet, Path: "/api/reminders",
		Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, _ *struct{}) (*struct{ Body List }, error) {
			rs, err := s.list(ctx, auth.Current(ctx).User.ID)
			return &struct{ Body List }{List{Reminders: rs}}, err
		})
	huma.Register(api, huma.Operation{OperationID: "delete-reminder", Method: http.MethodDelete, Path: "/api/reminders/{id}",
		DefaultStatus: http.StatusNoContent, Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			rid, err := httpx.ParseID(in.ID, "reminder")
			if err != nil {
				return nil, err
			}
			return nil, s.delete(ctx, auth.Current(ctx).User.ID, rid)
		})
}
```

- [ ] **Step 5: Wire it in `app/app.go`**

Add the field to `App`: `Reminders *reminders.Service // nil when built without a database; tests call FireDue and SetClock`. Import `github.com/datrope/datrope/server/internal/reminders`. Right after `a.closers = append(a.closers, msgSvc.Wait)`:

```go
	remSvc := reminders.NewService(pool, a.Bus, msgSvc)
	reminders.Register(api, remSvc)
	if pool != nil { // nil only for `datrope openapi`
		a.Reminders = remSvc
	}
```

(Task 5 adds `Start` and `Close` here.) In `realtime.go`'s `registerEventSchemas` list, add `reminders.RemindersUpdate{},` after `watch.WatchUpdate{},` and import the package.

- [ ] **Step 6: Run the tests**

Run: `rtk go test ./internal/reminders/ ./internal/app/ -v`
Expected: PASS.

- [ ] **Step 7: Stage**

```bash
rtk git add server/internal/reminders/ server/internal/app/
```

---

### Task 5: Scheduler with restart recovery

**Files:**
- Modify: `server/internal/reminders/reminders.go` (append), `server/internal/app/app.go` (the block from Task 4)
- Test: `server/internal/reminders/scheduler_test.go`

**Interfaces:**
- Produces: `func (s *Service) Start()`, `func (s *Service) Close()`, `func (s *Service) FireDue(ctx context.Context) error`, `func (s *Service) SetClock(now func() time.Time)`.

- [ ] **Step 1: Write the failing test** — `scheduler_test.go`

```go
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

	var list reminders.List
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk go test ./internal/reminders/ -run 'Fire' -v`
Expected: compile error, `FireDue` undefined.

- [ ] **Step 3: Append the scheduler to `reminders.go`** (imports gain `log/slog`, `github.com/jackc/pgx/v5`)

```go
// SetClock replaces the clock; tests move time forward with it.
func (s *Service) SetClock(now func() time.Time) {
	s.mu.Lock()
	s.clock = now
	s.mu.Unlock()
	s.poke()
}

// Start delivers due reminders until Close: at once (catching up after downtime), then whenever
// the next one is due, a reminder is added or removed, or a minute has passed.
func (s *Service) Start() {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx := context.Background()
		for {
			if err := s.FireDue(ctx); err != nil {
				slog.Error("reminders: fire", "err", err)
			}
			t := time.NewTimer(s.untilNext(ctx))
			select {
			case <-s.done:
				t.Stop()
				return
			case <-s.wake:
			case <-t.C:
			}
			t.Stop()
		}
	}()
}

func (s *Service) Close() {
	s.stop.Do(func() { close(s.done) })
	s.wg.Wait()
}

// untilNext is how long to sleep: until the next reminder is due, at most maxWait.
func (s *Service) untilNext(ctx context.Context) time.Duration {
	var next *time.Time
	if err := s.db.QueryRow(ctx, `SELECT min(due_at) FROM reminders WHERE fired_at IS NULL`).Scan(&next); err != nil {
		slog.Error("reminders: next", "err", err)
		return maxWait
	}
	if next == nil {
		return maxWait
	}
	return min(max(next.Sub(s.now()), 0), maxWait)
}

// FireDue delivers every reminder that is due. Each is marked fired before it is delivered,
// so one whose DM fails is dropped rather than retried forever; two servers never both deliver one.
func (s *Service) FireDue(ctx context.Context) error {
	for {
		rows, err := s.db.Query(ctx, `
			UPDATE reminders SET fired_at = $1
			WHERE id IN (SELECT id FROM reminders WHERE fired_at IS NULL AND due_at <= $1
			             ORDER BY due_at LIMIT $2 FOR UPDATE SKIP LOCKED)
			RETURNING id, user_id, note, channel_id, message_id`, s.now(), batch)
		if err != nil {
			return err
		}
		due, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (messages.DueReminder, error) {
			var r messages.DueReminder
			var ch, msg *int64
			err := row.Scan(&r.ID, &r.UserID, &r.Note, &ch, &msg)
			r.ChannelID, r.MessageID = id.FromNullable(ch), id.FromNullable(msg)
			return r, err
		})
		if err != nil {
			return err
		}
		for _, r := range due {
			if _, err := s.messages.PostReminder(ctx, r); err != nil {
				slog.Error("reminders: deliver", "reminder", r.ID, "err", err)
				continue
			}
			s.changed(r.UserID)
		}
		if len(due) < batch {
			return nil
		}
	}
}
```

- [ ] **Step 4: Start it in `app.go`.** Change the Task 4 block to:

```go
	if pool != nil { // nil only for `datrope openapi`
		remSvc.Start()
		a.closers = append(a.closers, remSvc.Close)
		a.Reminders = remSvc
	}
```

- [ ] **Step 5: Run the reminders tests, then the whole server suite**

Run: `rtk go test ./internal/reminders/ -v -race`, then `rtk go test ./...`
Expected: PASS, with no data race reported.

- [ ] **Step 6: Stage**

```bash
rtk git add server/internal/reminders/ server/internal/app/app.go
```

---

### Task 6: Core client: schema and API methods

**Files:**
- Modify: `clients/core/openapi.json`, `clients/core/src/schema.d.ts` (generated), `clients/core/src/types.ts` (near L61), `clients/core/src/client.ts` (after `listPins` ~L194)

**Interfaces:**
- Produces: types `Reminder`, `ReminderInfo`, `ReminderQuote`, `ReminderTarget`, `CreateReminderBody`; `client.createReminder(body): Promise<Reminder>`, `client.listReminders(): Promise<Reminder[]>`, `client.deleteReminder(id): Promise<void>`; `PublicUser.system?: boolean` and `Message.reminder?: ReminderInfo` via the schema.

- [ ] **Step 1: Regenerate the schema**

Run (from `clients/core`): `rtk pnpm gen`
Expected: `schema.d.ts` gains `/api/reminders`, `Reminder`, `ReminderInfo`, `ReminderQuote`, `ReminderTarget`, `PublicUser.system`, `Message.reminder`, and `kind` `"member_leave" | "reminder"`.

- [ ] **Step 2: Add the types** in `types.ts`, beside the other schema aliases:

```ts
export type Reminder = Schemas["Reminder"];
export type ReminderInfo = Schemas["ReminderInfo"];
export type ReminderQuote = Schemas["ReminderQuote"];
export type ReminderTarget = Schemas["ReminderTarget"];
export type CreateReminderBody = Schemas["CreateRequest"];
```

(If huma named the request schema differently, use the name `schema.d.ts` shows for the `/api/reminders` POST body.)

- [ ] **Step 3: Add the methods** in `client.ts`, after `listPins` (import the types from `./types`):

```ts
  /** Sets a reminder: System DMs me at `due_at` (an ISO instant). */
  async createReminder(body: CreateReminderBody): Promise<Reminder> {
    return unwrap(this.api.POST("/api/reminders", { body }));
  }

  /** My pending reminders, soonest first. */
  async listReminders(): Promise<Reminder[]> {
    return (await unwrap(this.api.GET("/api/reminders"))).reminders ?? [];
  }

  async deleteReminder(id: string) {
    await unwrap(this.api.DELETE("/api/reminders/{id}", { params: { path: { id } } }));
  }
```

- [ ] **Step 4: Typecheck and test core**

Run: `rtk pnpm --filter @datrope/core typecheck` and `rtk pnpm --filter @datrope/core test`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
rtk git add clients/core/
```

---

### Task 7: Time math (`remind-time.ts`)

**Files:**
- Create: `clients/web/src/chat/remind-time.ts`, `clients/web/src/chat/remind-time.test.ts`

**Interfaces:**
- Produces:
  - `presets(now: Date): { label: string; due: Date }[]` (5 items, labels per Global Constraints)
  - `parseWhen(text: string, now: Date): { due: Date; rest: string } | null`
  - `whenLabel(due: Date, now: Date, locale?: string): string`: "Today 15:04" / "Tomorrow 09:00" / "Thu 09:00" (within 6 days) / "17 Oct 13:30" (same year) / "3 Jan 2027 09:00"
  - `menuTime(due: Date, now: Date, locale?: string): string`: clock only on the same day, otherwise `whenLabel`
  - `relative(due: Date, now: Date): string | null`: "in 5 min", "in 18 h 58 min", "in 2 d 3 h"; null when not in the future
  - `type Pick = { day: number; hour: number; minute: number }` (day = days from today 0..13; minute a multiple of 5)
  - `DAYS = 14`; `dayLabels(now: Date, locale?: string): string[]` ("Today", "Tomorrow", then "Fri 17 Oct" …)
  - `defaultPick(now: Date): Pick`: the next full quarter hour plus 1 h
  - `pickToDate(now: Date, p: Pick): Date`; `pickFor(now: Date, due: Date): Pick` (minute rounded up to 5, day clamped to DAYS-1)

- [ ] **Step 1: Write the failing tests** — `remind-time.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { dayLabels, defaultPick, menuTime, parseWhen, pickFor, pickToDate, presets, relative, whenLabel } from "./remind-time";

// Wednesday 14 Oct 2026, 14:02 local time.
const now = new Date(2026, 9, 14, 14, 2, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0);

describe("parseWhen", () => {
  it.each([
    ["20m stretch", new Date(now.getTime() + 20 * 60_000), "stretch"],
    ["2h call mom", new Date(now.getTime() + 2 * 3_600_000), "call mom"],
    ["1h30m tea", new Date(now.getTime() + 90 * 60_000), "tea"],
    ["1d x", new Date(now.getTime() + 86_400_000), "x"],
    ["14:30 standup", at(14, 14, 30), "standup"],
    ["9:05 coffee", at(15, 9, 5), "coffee"], // passed today → tomorrow
    ["14:02 now-ish", at(15, 14, 2), "now-ish"], // exactly now counts as passed
    ["tomorrow dentist", at(15, 9), "dentist"],
    ["tomorrow 9 dentist", at(15, 9), "dentist"],
    ["tomorrow 14:30 dentist", at(15, 14, 30), "dentist"],
    ["fri 13:00 release", at(16, 13), "release"],
    ["friday release", at(16, 9), "release"],
    ["wed sync", at(21, 9), "sync"], // today is Wednesday → next week
    ["mon 8 gym", at(19, 8), "gym"],
  ])("%j", (text, due, rest) => {
    expect(parseWhen(text, now)).toEqual({ due, rest });
  });

  it("keeps a missing text empty", () => expect(parseWhen("20m", now)?.rest).toBe(""));
  it.each(["", "soon do it", "0m x", "25:00 x", "9 x", "14:61 x", "tomorrow 24 x", "funday x"])("rejects %j", (text) => {
    expect(parseWhen(text, now)).toBeNull();
  });
});

describe("presets", () => {
  it("resolves each preset", () => {
    expect(presets(now).map((p) => [p.label, p.due])).toEqual([
      ["In 20 minutes", new Date(now.getTime() + 20 * 60_000)],
      ["In 1 hour", new Date(now.getTime() + 3_600_000)],
      ["In 3 hours", new Date(now.getTime() + 3 * 3_600_000)],
      ["Tomorrow", at(15, 9)],
      ["Next week", at(19, 9)], // the next Monday
    ]);
  });
  it("next week from a Monday is a week out", () =>
    expect(presets(new Date(2026, 9, 19, 8, 0)).at(-1)!.due).toEqual(at(26, 9)));
});

describe("labels", () => {
  it("whenLabel", () => {
    expect(whenLabel(at(14, 15, 4), now, "en-GB")).toBe("Today 15:04");
    expect(whenLabel(at(15, 9), now, "en-GB")).toBe("Tomorrow 09:00");
    expect(whenLabel(at(16, 13), now, "en-GB")).toBe("Fri 13:00");
    expect(whenLabel(at(30, 13, 30), now, "en-GB")).toBe("30 Oct 13:30");
    expect(whenLabel(new Date(2027, 0, 3, 9), now, "en-GB")).toBe("3 Jan 2027 09:00");
  });
  it("menuTime drops Today", () => expect(menuTime(at(14, 14, 22), now, "en-GB")).toBe("14:22"));
  it("relative", () => {
    expect(relative(new Date(now.getTime() + 5 * 60_000), now)).toBe("in 5 min");
    expect(relative(new Date(now.getTime() + (18 * 60 + 58) * 60_000), now)).toBe("in 18 h 58 min");
    expect(relative(new Date(now.getTime() + (51 * 60) * 60_000), now)).toBe("in 2 d 3 h");
    expect(relative(now, now)).toBeNull();
  });
});

describe("wheel picks", () => {
  it("defaults to the next quarter hour plus an hour", () =>
    expect(defaultPick(now)).toEqual({ day: 0, hour: 15, minute: 15 }));
  it("rolls over midnight", () =>
    expect(defaultPick(new Date(2026, 9, 14, 23, 50))).toEqual({ day: 1, hour: 1, minute: 0 }));
  it("round-trips", () => {
    expect(pickToDate(now, { day: 1, hour: 9, minute: 0 })).toEqual(at(15, 9));
    expect(pickFor(now, new Date(now.getTime() + 20 * 60_000))).toEqual({ day: 0, hour: 14, minute: 25 });
    expect(pickFor(now, at(30, 9))).toEqual({ day: 13, hour: 9, minute: 0 }); // clamped to the last day
  });
  it("labels days", () => {
    const d = dayLabels(now, "en-GB");
    expect(d).toHaveLength(14);
    expect(d.slice(0, 3)).toEqual(["Today", "Tomorrow", "Fri 16 Oct"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `clients/web`): `rtk vitest run src/chat/remind-time.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `remind-time.ts`**

```ts
// Turns what someone types or picks into the instant a reminder is due, in local time.
// Pure: callers pass `now`.

import { clockTime } from "@/lib/message-time";

const MIN = 60_000;
// Three-letter and full English day names.
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
export const DAYS = 14; // the wheel dialog's day choices

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const atTime = (day: Date, h: number, m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
const dayDiff = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);
/** The next `weekday` (0 = Sunday) after today: a week out when today is that day. */
const nextWeekday = (now: Date, weekday: number) => addDays(startOfDay(now), (weekday - now.getDay() + 7) % 7 || 7);

export function presets(now: Date): { label: string; due: Date }[] {
  return [
    { label: "In 20 minutes", due: new Date(now.getTime() + 20 * MIN) },
    { label: "In 1 hour", due: new Date(now.getTime() + 60 * MIN) },
    { label: "In 3 hours", due: new Date(now.getTime() + 180 * MIN) },
    { label: "Tomorrow", due: atTime(addDays(startOfDay(now), 1), 9, 0) },
    { label: "Next week", due: atTime(nextWeekday(now, 1), 9, 0) },
  ];
}

const DURATION = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/i;
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const HOUR = /^(\d{1,2})(?::(\d{2}))?$/;

function clock(h: number, m: number): [number, number] | null {
  return h < 24 && m < 60 ? [h, m] : null;
}

/** `/remind`'s <when>: 20m, 2h, 1h30m, 1d, 14:30, tomorrow [9|14:30], mon–sun [9|14:30]; the rest is the text. */
export function parseWhen(text: string, now: Date): { due: Date; rest: string } | null {
  const words = text.trim().split(/\s+/);
  const [first = "", second = ""] = words;
  const rest = (n: number) => words.slice(n).join(" ");

  const d = DURATION.exec(first);
  if (first && d) {
    const mins = Number(d[1] ?? 0) * 1440 + Number(d[2] ?? 0) * 60 + Number(d[3] ?? 0);
    return mins > 0 ? { due: new Date(now.getTime() + mins * MIN), rest: rest(1) } : null;
  }
  const c = CLOCK.exec(first);
  if (c) {
    const t = clock(Number(c[1]), Number(c[2]));
    if (!t) return null;
    let due = atTime(now, ...t);
    if (due <= now) due = atTime(addDays(startOfDay(now), 1), ...t);
    return { due, rest: rest(1) };
  }
  const lower = first.toLowerCase();
  const weekday = WEEKDAYS[lower] ?? -1;
  const day = lower === "tomorrow" ? addDays(startOfDay(now), 1) : weekday >= 0 ? nextWeekday(now, weekday) : null;
  if (!day) return null;
  const h = HOUR.exec(second);
  if (h) {
    const t = clock(Number(h[1]), Number(h[2] ?? 0));
    return t ? { due: atTime(day, ...t), rest: rest(2) } : null;
  }
  return { due: atTime(day, 9, 0), rest: rest(1) };
}

const fmt = (locale: string | undefined, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, opts);

/** "Today 15:04", "Tomorrow 09:00", "Fri 13:00", "30 Oct 13:30", "3 Jan 2027 09:00". */
export function whenLabel(due: Date, now: Date, locale?: string): string {
  const time = clockTime(due, locale);
  const days = dayDiff(now, due);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${fmt(locale, { weekday: "short" }).format(due)} ${time}`;
  const sameYear = due.getFullYear() === now.getFullYear();
  return `${fmt(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(due)} ${time}`;
}

/** The time beside a preset: just the clock today. */
export const menuTime = (due: Date, now: Date, locale?: string) =>
  dayDiff(now, due) === 0 ? clockTime(due, locale) : whenLabel(due, now, locale);

/** "in 5 min", "in 18 h 58 min", "in 2 d 3 h"; null unless due is in the future. */
export function relative(due: Date, now: Date): string | null {
  const mins = Math.ceil((due.getTime() - now.getTime()) / MIN);
  if (mins <= 0) return null;
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `in ${d} d${h ? ` ${h} h` : ""}`;
  if (h > 0) return `in ${h} h${m ? ` ${m} min` : ""}`;
  return `in ${m} min`;
}

export type Pick = { day: number; hour: number; minute: number };

export function dayLabels(now: Date, locale?: string): string[] {
  const f = fmt(locale, { weekday: "short", day: "numeric", month: "short" });
  return Array.from({ length: DAYS }, (_, i) => (i === 0 ? "Today" : i === 1 ? "Tomorrow" : f.format(addDays(startOfDay(now), i)).replace(",", "")));
}

export const pickToDate = (now: Date, p: Pick) => atTime(addDays(startOfDay(now), p.day), p.hour, p.minute);

/** The wheel position for `due`: minutes rounded up to 5, at most the last day. */
export function pickFor(now: Date, due: Date): Pick {
  const up = new Date(Math.ceil(due.getTime() / (5 * MIN)) * 5 * MIN);
  const day = dayDiff(now, up);
  if (day > DAYS - 1) return { day: DAYS - 1, hour: up.getHours(), minute: up.getMinutes() };
  return { day: Math.max(0, day), hour: up.getHours(), minute: up.getMinutes() };
}

/** The next full quarter hour, plus an hour. */
export function defaultPick(now: Date): Pick {
  const q = 15 * MIN;
  return pickFor(now, new Date(Math.floor(now.getTime() / q) * q + q + 60 * MIN));
}
```


- [ ] **Step 4: Run the tests**

Run: `rtk vitest run src/chat/remind-time.test.ts`
Expected: PASS. The test machine's timezone doesn't matter: inputs and expectations both use local `Date` constructors.

- [ ] **Step 5: Stage**

```bash
rtk git add clients/web/src/chat/remind-time.ts clients/web/src/chat/remind-time.test.ts
```

---

### Task 8: Toasts, `setReminder`, `/remind` and `/reminders`

**Files:**
- Create: `clients/web/src/components/ui/sonner.tsx` (shadcn), `clients/web/src/app/reminders/reminders.ts`
- Modify: `clients/web/src/main.tsx`, `clients/web/src/chat/commands.ts`, `clients/web/src/chat/commands.test.tsx`, `clients/web/src/app/Composer.tsx` (ctx ~L54-63, modal ~L362-370), `clients/web/src/app/side-panel/panel.ts`, `panel-param.ts`, `panel-param.test.ts`

**Interfaces:**
- Consumes: `client.createReminder`/`deleteReminder`/`listReminders` (Task 6); `parseWhen`, `whenLabel` (Task 7).
- Produces:
  - `reminders.ts`: `isSystemDM(ch?: Channel): boolean`; `setReminder(body: CreateReminderBody): Promise<void>` (creates, then shows the toast "Reminder set for {whenLabel}" with Undo; shows the error toast and rethrows on failure); `useReminders(): { reminders: Reminder[]; loading: boolean; error?: string }`
  - `CommandContext.setReminder: (body: { due_at: string; note: string }) => Promise<unknown>`; `CommandContext.openReminders?: () => void`; `ModalKind` gains `"reminder"`
  - `Panel` gains `{ kind: "reminders" }`; param `reminders`

- [ ] **Step 1: Add sonner.** From `clients/web`: `rtk pnpm dlx shadcn@latest add sonner`. If the CLI fails (exFAT), follow AGENTS.md's fallback: fetch `https://ui.shadcn.com/r/styles/new-york-v4/sonner.json` and add `sonner` to `package.json`. Then edit `src/components/ui/sonner.tsx` so it is dark-only, with no `next-themes`:

```tsx
import { Toaster as Sonner, type ToasterProps } from "sonner";

/** Toasts, bottom centre, in the app's colours. */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner theme="dark" position="bottom-center" className="toaster group"
      style={{ "--normal-bg": "var(--popover)", "--normal-text": "var(--popover-foreground)", "--normal-border": "var(--border)" } as React.CSSProperties}
      {...props} />
  );
}
```

If `next-themes` was added to `package.json`, remove it. Mount `<Toaster />` in `main.tsx` inside `TooltipProvider`, after `<RouterProvider …/>`.

- [ ] **Step 2: Write the failing command tests** — in `commands.test.tsx`, extend the `ctx()` helper and add a block:

```tsx
const ctx = (): CommandContext & { statuses: string[]; reminders: { due_at: string; note: string }[]; panels: number } => {
  const statuses: string[] = [];
  const reminders: { due_at: string; note: string }[] = [];
  const c = {
    statuses, reminders, panels: 0, gifsEnabled: true, canAttach: true,
    setStatus: async (t: string) => { statuses.push(t); },
    setReminder: async (b: { due_at: string; note: string }) => { reminders.push(b); },
    openReminders: () => { c.panels++; },
  };
  return c;
};

describe("/remind", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 14, 14, 2)); });
  afterEach(() => vi.useRealTimers());

  it("sets a reminder from the compact syntax", async () => {
    const c = ctx();
    expect(await runCommand("/remind tomorrow 9 call the dentist", c)).toEqual({ done: true });
    expect(c.reminders).toEqual([{ due_at: new Date(2026, 9, 15, 9).toISOString(), note: "call the dentist" }]);
  });
  it("opens the dialog when bare", async () =>
    expect(await runCommand("/remind", ctx())).toEqual({ open: "reminder" }));
  it.each(["/remind soon stuff", "/remind 20m"])("explains usage for %j", async (text) =>
    expect(await runCommand(text, ctx())).toEqual({ error: "Usage: /remind <20m|2h|14:30|tomorrow 9|fri 13:00> <text>" }));
  it("/reminders opens the panel", async () => {
    const c = ctx();
    expect(await runCommand("/reminders", c)).toEqual({ done: true });
    expect(c.panels).toBe(1);
  });
  it("/reminders is unavailable without a panel", () =>
    expect(availableCommands({ ...ctx(), openReminders: undefined }).map((x) => x.name)).not.toContain("reminders"));
});
```

(Add `beforeEach`, `afterEach` to the vitest import.)

- [ ] **Step 3: Run it to verify it fails**

Run: `rtk vitest run src/chat/commands.test.tsx`
Expected: FAIL. `/remind` is an unknown command, and the type error on `setReminder` is reported by typecheck.

- [ ] **Step 4: Implement the commands** in `commands.ts`

```ts
import { parseWhen } from "./remind-time";

export type ModalKind = "gif" | "poll" | "reminder";
// in CommandContext:
  /** Sets a reminder for an ISO instant and confirms it. */
  setReminder: (body: { due_at: string; note: string }) => Promise<unknown>;
  /** Opens the Reminders side panel; absent where no side panel shows it (a voice channel's chat). */
  openReminders?: () => void;

const REMIND_USAGE = "Usage: /remind <20m|2h|14:30|tomorrow 9|fri 13:00> <text>";

// in COMMANDS, after "status":
  {
    name: "remind", args: "<when> <text>", description: "Reminds you later in a DM from System",
    run: async (a, ctx) => {
      if (!a) return { open: "reminder" };
      const when = parseWhen(a, new Date());
      if (!when || !when.rest) return { error: REMIND_USAGE };
      await ctx.setReminder({ due_at: when.due.toISOString(), note: when.rest });
      return { done: true };
    },
  },
  {
    name: "reminders", description: "Lists your pending reminders",
    available: (ctx) => !!ctx.openReminders,
    run: (_a, ctx) => { ctx.openReminders!(); return { done: true }; },
  },
```

- [ ] **Step 5: Add the panel kind.** In `panel.ts` add `| { kind: "reminders" }` to `Panel` and update the doc comment. In `panel-param.ts`: `case "threads": case "search": case "reminders": return p.kind;`, and in `paramToPanel`: `if (kind === "threads" || kind === "search" || kind === "reminders") return { kind };`. Add a round-trip case to `panel-param.test.ts`, mirroring its existing `threads` case:

```ts
  it("round-trips reminders", () => expect(paramToPanel(panelToParam({ kind: "reminders" }))).toEqual({ kind: "reminders" }));
```

- [ ] **Step 6: Create `app/reminders/reminders.ts`**

```ts
import type { Channel, CreateReminderBody, Reminder } from "@datrope/core";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { whenLabel } from "@/chat/remind-time";
import { client, errorText } from "../../session";

/** A conversation with the System account: read-only, where reminders arrive. */
export const isSystemDM = (ch?: Channel) => ch?.type === "dm" && !!ch.participants?.some((p) => p.system);

/** Sets a reminder and confirms it with an Undo toast; a failure shows as a toast and rethrows. */
export async function setReminder(body: CreateReminderBody): Promise<void> {
  try {
    const r = await client.createReminder(body);
    toast(`Reminder set for ${whenLabel(new Date(r.due_at), new Date())}`, {
      action: { label: "Undo", onClick: () => void client.deleteReminder(r.id).catch((e) => toast.error(errorText(e))) },
    });
  } catch (e) {
    toast.error(errorText(e));
    throw e;
  }
}

/** My pending reminders, refetched whenever they change. */
export function useReminders() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    client.listReminders().then((rs) => { setReminders(rs); setError(undefined); }, (e) => setError(errorText(e))).finally(() => setLoading(false));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => client.onEvent((type) => { if (type === "REMINDERS_UPDATE") reload(); }), [reload]);
  return { reminders, loading, error };
}
```

- [ ] **Step 7: Wire the Composer.** In the `ctx` `useMemo` add:

```ts
      setReminder: (body) => setReminder(body),
      openReminders: isVoice ? undefined : () => openPanel({ kind: "reminders" }),
```

(imports: `setReminder` from `./reminders/reminders`, `openPanel` from `./side-panel/panel`). `ReminderDialog` is built in Task 9, so this line is added there (Task 9 Step 5), not now.

- [ ] **Step 8: Run the tests and typecheck**

Run: `rtk vitest run src/chat/ src/app/side-panel/` and `rtk pnpm --filter @datrope/web typecheck`
Expected: PASS.

- [ ] **Step 9: Stage**

```bash
rtk git add clients/web/
```

---

### Task 9: Wheel dialog

**Files:**
- Create: `clients/web/src/app/reminders/Wheel.tsx`, `clients/web/src/app/reminders/ReminderDialog.tsx`, `clients/web/src/app/reminders/ReminderDialog.test.tsx`
- Modify: `clients/web/src/app/Composer.tsx` (the modal line from Task 8 Step 7)

**Interfaces:**
- Consumes: `defaultPick`, `pickToDate`, `pickFor`, `dayLabels`, `relative`, `DAYS`, `type Pick` (Task 7); `setReminder` (Task 8).
- Produces: `<ReminderDialog message?: { id: string; channel_id: string; authorName: string; excerpt: string; channelName?: string } onClose: () => void now?: Date />`; `<Wheel label: string items: string[] index: number onChange: (i: number) => void className?: string />`.

- [ ] **Step 1: Write the failing test** — `ReminderDialog.test.tsx` (static markup: dialogs render in a portal, so test the dialog's body)

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Wheel } from "./Wheel";
import { ReminderForm } from "./ReminderDialog";

vi.mock("../../session", () => ({ client: {}, errorText: String }));

const now = new Date(2026, 9, 14, 14, 2);

describe("Wheel", () => {
  it("is a spinbutton showing its neighbours", () => {
    const html = renderToStaticMarkup(<Wheel label="Hour" items={["08", "09", "10"]} index={1} onChange={() => {}} />);
    expect(html).toContain('role="spinbutton"');
    expect(html).toContain('aria-label="Hour"');
    expect(html).toContain('aria-valuetext="09"');
    expect(html).toContain(">08<");
    expect(html).toContain(">10<");
  });
});

describe("ReminderForm", () => {
  it("previews the default time and quotes the message", () => {
    const html = renderToStaticMarkup(<ReminderForm now={now} initial={{ day: 0, hour: 15, minute: 15 }}
      message={{ id: "1", channel_id: "2", authorName: "Maja", channelName: "general", excerpt: "Review the notes?" }} onClose={() => {}} />);
    expect(html).toContain("in 1 h 13 min");
    expect(html).toContain("Maja · #general");
    expect(html).not.toContain("disabled=\"\"");
  });
  it("disables Set for a time that has passed", () => {
    const html = renderToStaticMarkup(<ReminderForm now={now} initial={{ day: 0, hour: 9, minute: 0 }} onClose={() => {}} />);
    expect(html).toContain("That time has passed");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Set reminder/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk vitest run src/app/reminders/`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `Wheel.tsx`**

```tsx
import { ChevronDown, ChevronUp } from "lucide-react";
import type { KeyboardEvent, WheelEvent } from "react";
import { cn } from "@/lib/utils";

/** A scroll wheel: the chosen item between its neighbours. Arrow keys, the mouse wheel and the neighbours move it. */
export function Wheel({ label, items, index, onChange, className }:
  { label: string; items: string[]; index: number; onChange: (i: number) => void; className?: string }) {
  const go = (i: number) => onChange(Math.min(items.length - 1, Math.max(0, i)));
  const keys = (e: KeyboardEvent) => {
    const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[e.key];
    if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (step) go(index + step);
    else return;
    e.preventDefault();
  };
  const wheel = (e: WheelEvent) => { if (e.deltaY) go(index + Math.sign(e.deltaY)); };
  return (
    <div role="spinbutton" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={items.length - 1}
      aria-valuenow={index} aria-valuetext={items[index]} onKeyDown={keys} onWheel={wheel}
      className={cn("flex w-16 flex-col items-stretch overflow-hidden rounded-lg border text-center tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}>
      <button type="button" tabIndex={-1} aria-hidden className="py-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => go(index - 1)}>
        {items[index - 1] ?? <ChevronUp className="mx-auto size-4 opacity-40" />}
      </button>
      <span className="bg-accent py-1.5 text-title font-semibold text-foreground">{items[index]}</span>
      <button type="button" tabIndex={-1} aria-hidden className="py-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => go(index + 1)}>
        {items[index + 1] ?? <ChevronDown className="mx-auto size-4 opacity-40" />}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Implement `ReminderDialog.tsx`**

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { dayLabels, defaultPick, pickFor, pickToDate, relative, type Pick } from "@/chat/remind-time";
import { setReminder } from "./reminders";
import { Wheel } from "./Wheel";

export type ReminderTarget = { id: string; channel_id: string; authorName: string; excerpt: string; channelName?: string };

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));
const CHIPS = [["+20m", 20], ["+1h", 60], ["+3h", 180]] as const;

/** The dialog's body; split out so it renders (and tests) without the portal. */
export function ReminderForm({ message, onClose, now = new Date(), initial }:
  { message?: ReminderTarget; onClose: () => void; now?: Date; initial?: Pick }) {
  const [pick, setPick] = useState<Pick>(() => initial ?? defaultPick(now));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const due = pickToDate(now, pick);
  const preview = relative(due, now);
  const submit = async () => {
    setBusy(true);
    try {
      await setReminder({ due_at: due.toISOString(), note: note.trim(), ...(message && { channel_id: message.channel_id, message_id: message.id }) });
      onClose();
    } catch {
      setBusy(false); // the toast said why
    }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (preview) void submit(); }} className="flex flex-col gap-4">
      {message && (
        <div className="rounded-lg border bg-background px-3 py-2 text-sm">
          <p className="m-0 text-xs text-muted-foreground">{message.authorName}{message.channelName && ` · #${message.channelName}`}</p>
          <p className="m-0 line-clamp-2 wrap-anywhere">{message.excerpt || "Attachment"}</p>
        </div>
      )}
      <div className="flex items-center justify-center gap-2">
        <Wheel label="Day" className="w-32" items={dayLabels(now)} index={pick.day} onChange={(day) => setPick({ ...pick, day })} />
        <Wheel label="Hour" items={HOURS} index={pick.hour} onChange={(hour) => setPick({ ...pick, hour })} />
        <span aria-hidden className="font-semibold">:</span>
        <Wheel label="Minute" items={MINUTES} index={pick.minute / 5} onChange={(i) => setPick({ ...pick, minute: i * 5 })} />
      </div>
      <p className="m-0 text-center text-sm text-primary" aria-live="polite">{preview ?? <span className="text-destructive">That time has passed</span>}</p>
      <div className="flex justify-center gap-2">
        {CHIPS.map(([label, mins]) => (
          <Button key={label} variant="outline" size="sm" className="rounded-full"
            onClick={() => setPick(pickFor(now, new Date(Date.now() + mins * 60_000)))}>{label}</Button>
        ))}
      </div>
      <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)" aria-label="Note" />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={!preview || busy}>Set reminder</Button>
      </DialogFooter>
    </form>
  );
}

/** Custom… and bare /remind: pick a day and time on wheels, up to two weeks ahead. */
export function ReminderDialog({ message, onClose }: { message?: ReminderTarget; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[400px]" onContextMenu={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{message ? "Remind me about this message" : "New reminder"}</DialogTitle>
          <DialogDescription className="sr-only">Pick when System should send you a reminder.</DialogDescription>
        </DialogHeader>
        <ReminderForm message={message} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}
```

Free-text `/remind` via the dialog has no text field other than the note, which is the reminder text, so the note isn't required.

- [ ] **Step 5: Mount it in Composer** (the Task 8 Step 7 line): `{modal?.open === "reminder" && <ReminderDialog onClose={() => setModal(null)} />}`, importing from `./reminders/ReminderDialog`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `rtk vitest run src/app/reminders/` and `rtk pnpm --filter @datrope/web typecheck`
Expected: PASS.

- [ ] **Step 7: Stage**

```bash
rtk git add clients/web/src/app/reminders/ clients/web/src/app/Composer.tsx
```

---

### Task 10: "Remind me" on messages (desktop menus, phone sheet)

**Files:**
- Create: `clients/web/src/app/reminders/RemindMenuItems.tsx`
- Modify: `clients/web/src/app/MessageToolbar.tsx` (props L14-29, `hasMenu` L35, menu L66-77), `clients/web/src/app/MessageList.tsx` (`MessageRowView` ~L606-720, toolbar ~L870-881, context menu ~L888-911, sheet ~L940-951), `clients/web/src/app/message-actions.ts` (+ test), `clients/web/src/app/MessageSheet.tsx`

**Interfaces:**
- Consumes: `presets`, `menuTime` (Task 7); `setReminder`, `isSystemDM` (Task 8); `ReminderDialog`, `ReminderTarget` (Task 9).
- Produces: `<RemindMenuItems message={Message} kind="dropdown" | "context" onCustom={() => void} />`; `MessageToolbar` prop `remindItems?: ReactNode`; `MessageAction` gains `"remind"`; `messageActions` `can.remind: boolean`; `MessageSheet` prop `onRemind: () => void`.

- [ ] **Step 1: Write the failing test** — in `message-actions.test.ts`, add `remind: true` to `all` and to the all-false object, then update the expectations:

```ts
const all = { reply: true, react: true, thread: true, hasThread: false, edit: true, pin: true, pinned: false, album: true, remind: true, delete: true };
// "lists everything for a normal message":
    expect(messageActions({ content: "hi", attachments: [{}] }, all)).toEqual(["react", "reply", "thread", "edit", "copy", "pin", "remind", "album", "delete"]));
// "respects permissions": add remind: false to the override and keep the same expected list.
  it("offers Remind me only when allowed", () =>
    expect(messageActions({ content: "x" }, { ...all, remind: false })).not.toContain("remind"));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk vitest run src/app/message-actions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `message-actions.ts`**: add `"remind"` to the union and `remind: boolean` to `can`, and after the `pin` push add `if (can.remind) out.push("remind");`.

- [ ] **Step 4: Create `RemindMenuItems.tsx`**

```tsx
import type { Message } from "@datrope/core";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { menuTime, presets } from "@/chat/remind-time";
import { setReminder } from "./reminders";

/** The "Remind me" submenu: presets with their times, then Custom…. */
export function RemindMenuItems({ message, kind, onCustom }: { message: Message; kind: "dropdown" | "context"; onCustom: () => void }) {
  const Item = kind === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
  const now = new Date();
  return (
    <>
      {presets(now).map((p) => (
        <Item key={p.label} onSelect={() => void setReminder({ due_at: p.due.toISOString(), channel_id: message.channel_id, message_id: message.id }).catch(() => undefined)}>
          {p.label}<span className="ml-auto pl-4 text-xs text-muted-foreground">{menuTime(p.due, now)}</span>
        </Item>
      ))}
      <Separator />
      <Item onSelect={onCustom}>Custom…</Item>
    </>
  );
}
```

- [ ] **Step 5: `MessageToolbar.tsx`**: import `AlarmClock`; add the prop `/** The "Remind me" submenu's items. */ remindItems?: ReactNode;`; include it in `hasMenu`; render it after the Copy item:

```tsx
          {remindItems && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><AlarmClock />Remind me</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">{remindItems}</DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
```

- [ ] **Step 6: `MessageList.tsx` `MessageRowView`**
  - State: `const [reminding, setReminding] = useState(false);`
  - `const canRemind = useApp((s) => !isSystemDM(s.channels[m.channel_id])) && !m.kind;`
  - Pass `remind: canRemind` in the `messageActions` call.
  - No pinning in the System DM (its toolbar keeps only react and copy): in the `canPin` selector, change the return to `return type !== "voice" && !isSystemDM(s.channels[m.channel_id]) && (canManage || type === "dm");`.
  - Toolbar: `remindItems={canRemind ? <RemindMenuItems message={m} kind="dropdown" onCustom={() => setReminding(true)} /> : undefined}`
  - Context menu, after the Copy item:
    ```tsx
      {canRemind && (
        <ContextMenuSub>
          <ContextMenuSubTrigger><AlarmClock />Remind me</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-60"><RemindMenuItems message={m} kind="context" onCustom={() => setReminding(true)} /></ContextMenuSubContent>
        </ContextMenuSub>
      )}
    ```
  - Dialog, after the delete `Dialog`:
    ```tsx
      {reminding && <ReminderDialog onClose={() => setReminding(false)}
        message={{ id: m.id, channel_id: m.channel_id, authorName: name, excerpt: m.content, channelName }} />}
    ```
    with, among the other hooks at the top of `MessageRowView`:
    ```tsx
    const channelName = useApp((s) => (s.channels[m.channel_id]?.type === "dm" ? undefined : s.channels[m.channel_id]?.name));
    ```
  - Sheet: pass `onRemind={() => setReminding(true)}`.

- [ ] **Step 7: `MessageSheet.tsx`**: add the `onRemind: () => void` prop, and in the switch:

```tsx
            case "remind": return <ActionSheetItem key={a} icon={<AlarmClock />} onSelect={run(onRemind)}>Remind me</ActionSheetItem>;
```

- [ ] **Step 8: Run the tests, typecheck and lint**

Run: `rtk vitest run src/app/`, `rtk pnpm --filter @datrope/web typecheck`, `rtk lint`
Expected: PASS.

- [ ] **Step 9: Stage**

```bash
rtk git add clients/web/src/app/
```

---

### Task 11: System DM rendering and the Reminders panel

**Files:**
- Create: `clients/web/src/app/reminders/SystemBadge.tsx`, `ReminderCard.tsx`, `RemindersPanel.tsx`, `ReminderCard.test.tsx`
- Modify: `clients/web/src/components/user-avatar.tsx`, `clients/web/src/app/MessageList.tsx` (header ~L780-797, body chain ~L800-850), `clients/web/src/app/ChannelView.tsx`, `clients/web/src/app/forum/ForumView.tsx:140`, `clients/web/src/app/gallery/GalleryView.tsx:243`

**Interfaces:**
- Consumes: `ReminderInfo`, `Reminder` (Task 6); `whenLabel` (Task 7); `isSystemDM`, `useReminders` (Task 8); `openMessage` (`app/jump.ts`), `channelRef` (`@datrope/core`).
- Produces: `<SystemBadge />`, `<ReminderCard info={ReminderInfo} />` (testable as `ReminderCardView` with an `onJump` prop), `<RemindersPanel onClose />`.

- [ ] **Step 1: Write the failing test** — `ReminderCard.test.tsx`

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReminderCardView } from "./ReminderCard";

vi.mock("../../session", () => ({ client: {} }));

describe("ReminderCardView", () => {
  it("shows the note and the live quote", () => {
    const html = renderToStaticMarkup(<ReminderCardView onJump={() => {}} info={{
      note: "review release notes", target: { channel_id: "1", message_id: "2" },
      quote: { author_name: "Maja", channel_name: "general", created_at: "2026-10-14T12:02:00Z", excerpt: "Can someone review?" },
    }} />);
    expect(html).toContain("Reminder: <strong");
    expect(html).toContain("review release notes");
    expect(html).toContain("Maja · #general");
    expect(html).toContain("Jump to message");
  });
  it("says when the message is unavailable", () => {
    const html = renderToStaticMarkup(<ReminderCardView onJump={() => {}} info={{ note: "", unavailable: true }} />);
    expect(html).toContain("Message unavailable — it was deleted, or you no longer have access.");
    expect(html).not.toContain("Jump to message");
  });
  it("a free-text reminder is just the note", () => {
    const html = renderToStaticMarkup(<ReminderCardView onJump={() => {}} info={{ note: "stretch" }} />);
    expect(html).not.toContain("Message unavailable");
    expect(html).not.toContain("Jump to message");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk vitest run src/app/reminders/ReminderCard.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Create `SystemBadge.tsx`** (same look as `WebhookBadge`)

```tsx
import { Badge } from "@/components/ui/badge";

export function SystemBadge() {
  return <Badge className="h-4 self-center rounded px-1 text-caption font-bold uppercase tracking-wide">System</Badge>;
}
```

- [ ] **Step 4: Create `ReminderCard.tsx`**

```tsx
import { channelRef, type ReminderInfo, type ReminderTarget } from "@datrope/core";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { headStamp } from "@/lib/message-time";
import { client } from "../../session";
import { openMessage } from "../jump";

export function ReminderCardView({ info, onJump }: { info: ReminderInfo; onJump: (t: ReminderTarget) => void }) {
  const { quote, target } = info;
  return (
    <div>
      <p className="m-0">Reminder{info.note && <>: <strong className="font-semibold text-foreground">{info.note}</strong></>}</p>
      {info.unavailable ? (
        <p className="m-0 mt-1 max-w-md rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
          <em>Message unavailable — it was deleted, or you no longer have access.</em>
        </p>
      ) : quote && target && (
        <div className="mt-1 max-w-md rounded-lg border bg-card px-3 py-2 text-sm">
          <p className="m-0 text-xs text-muted-foreground">
            {quote.author_name}{quote.channel_name && ` · #${quote.channel_name}`} · {headStamp(new Date(quote.created_at))}
          </p>
          <p className="m-0 line-clamp-3 wrap-anywhere">{quote.excerpt || "Attachment"}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => onJump(target)}>Jump to message</Button>
        </div>
      )}
    </div>
  );
}

/** The body of a reminder System delivered: the note, then the message it is about, as I may see it now. */
export function ReminderCard({ info }: { info: ReminderInfo }) {
  const navigate = useNavigate();
  return <ReminderCardView info={info}
    onJump={(t) => void openMessage(navigate, channelRef(client.store.getState(), t.channel_id), t.message_id)} />;
}
```

- [ ] **Step 5: Create `RemindersPanel.tsx`**

```tsx
import { channelRef } from "@datrope/core";
import { AlarmClock, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/error-text";
import { whenLabel } from "@/chat/remind-time";
import { client, errorText } from "../../session";
import { openMessage } from "../jump";
import { SidePanel } from "../side-panel/SidePanel";
import { useReminders } from "./reminders";

/** My pending reminders, soonest first; each can be cancelled, and one about a message jumps to it. */
export function RemindersPanel({ onClose }: { onClose: () => void }) {
  const { reminders, loading, error } = useReminders();
  const navigate = useNavigate();
  const now = new Date();
  return (
    <SidePanel title="Reminders" icon={<AlarmClock />} onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ErrorText error={error} />
        {!loading && !error && reminders.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">No reminders. Use /remind or Remind me on a message.</p>
        )}
        <ul className="m-0 list-none p-0">
          {reminders.map((r) => {
            const when = whenLabel(new Date(r.due_at), now);
            const jump = r.channel_id && r.message_id && r.quote
              ? () => void openMessage(navigate, channelRef(client.store.getState(), r.channel_id!), r.message_id!) : undefined;
            return (
              <li key={r.id} className="flex items-start gap-1 rounded-md px-2 py-2 hover:bg-accent">
                <button type="button" disabled={!jump} onClick={jump} className="flex min-w-0 flex-1 gap-3 text-left disabled:cursor-default">
                  <span className="w-28 flex-none pt-0.5 text-xs tabular-nums text-primary">{when}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{r.note || "—"}</span>
                    {r.quote && <span className="block truncate text-xs text-muted-foreground">{r.quote.author_name}{r.quote.channel_name && ` · #${r.quote.channel_name}`}</span>}
                  </span>
                </button>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Cancel reminder ${when}`}
                  onClick={() => void client.deleteReminder(r.id).catch((e) => toast.error(errorText(e)))}>
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
      </div>
    </SidePanel>
  );
}
```

- [ ] **Step 6: System avatar** in `user-avatar.tsx`: widen the `user` prop type with `system?: boolean`, and at the top of `UserAvatar`, before `const avatar = …`:

```tsx
  if (user.system) {
    return (
      <Avatar className={cn(sizes[size], className)}>
        <AvatarFallback aria-hidden className="bg-primary text-primary-foreground"><AlarmClock className="size-1/2" /></AvatarFallback>
      </Avatar>
    );
  }
```

(Import `AlarmClock` from `lucide-react`.)

- [ ] **Step 7: `MessageList.tsx` header and body**
  - Header: wrap the name. When `m.author?.system`, render `<span id={`message-${m.id}-name`} className="font-semibold">{name}</span>` instead of the `ProfilePopover`. Replace the badge line with `{hook ? <WebhookBadge /> : m.author?.system ? <SystemBadge /> : m.author && <GuestBadge user={m.author} />}`.
  - Avatar button: make `onClick` a no-op for System (`onClick={() => !m.author?.system && setProfileOpen((o) => !o)}`).
  - Body chain: before the `wheel ? (` branch insert
    ```tsx
        ) : m.reminder ? (
          <div id={`message-${m.id}-text`}><ReminderCard info={m.reminder} /></div>
    ```

- [ ] **Step 8: `ChannelView.tsx`**
  - `const systemDM = isSystemDM(ch);` (after the `if (!ch) return …` guard).
  - Hide calls: change both `ch.type === "dm" && !here && inCall === 0` conditions (phone action and button) to also require `!systemDM`.
  - Phone actions: `...(systemDM ? [{ label: "Reminders", icon: <AlarmClock />, onSelect: () => openPanel({ kind: "reminders" }) }] : []),`
  - Header button, next to `PinsPanel`:
    ```tsx
            {systemDM && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex">
                    <Button variant="ghost" size="icon-sm" aria-label="Reminders" aria-pressed={panel?.kind === "reminders"}
                      className={panel?.kind === "reminders" ? "text-foreground" : "text-muted-foreground"}
                      onClick={() => (panel?.kind === "reminders" ? closePanel() : openPanel({ kind: "reminders" }))}>
                      <AlarmClock />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Reminders</TooltipContent>
              </Tooltip>
            )}
    ```
  - MessageList: `canReply={hasPerm(perms, Perm.SendMessages) && !systemDM}`.
  - Composer: `canSend={canPost(ch, perms) && !systemDM}`, `readOnlyText={systemDM ? "You can't reply to System." : ch.type === "webhook" ? "Only webhooks can post in this channel." : undefined}`.
  - Panels: before `panel?.kind === "search" ?` add `panel?.kind === "reminders" ? (<RemindersPanel onClose={closePanel} />) :`.
- [ ] **Step 9: ForumView and GalleryView**: add the same `panel?.kind === "reminders" ? <RemindersPanel onClose={closePanel} /> :` branch before their `panel?.kind === "search"` branch, so `/reminders` from a forum post's or gallery's composer has somewhere to open.

- [ ] **Step 10: Run the tests, typecheck and lint**

Run: `rtk vitest run`, `rtk pnpm --filter @datrope/web typecheck`, `rtk lint`
Expected: PASS.

- [ ] **Step 11: Stage**

```bash
rtk git add clients/web/
```

---

### Task 12: End-to-end check in the browser preview

**Files:** none (verification). Fix anything found in the owning task's files.

- [ ] **Step 1: Run the full suites**

Run (from repo root): `rtk go test ./...` (in `server/`), `rtk pnpm test`, `rtk pnpm typecheck`, `rtk pnpm lint`
Expected: all PASS.

- [ ] **Step 2: Start the preview**: `preview_start` with `datrope-server`, then `datrope-web` (from `.claude/launch.json`). The dev database must run migration 00043; the server migrates on start.

- [ ] **Step 3: Exercise the flow** in the browser pane, signed in to the dev instance:
  1. Hover a message → More actions → Remind me. The submenu shows 5 presets with times and Custom….
  2. Pick **In 20 minutes**. The toast "Reminder set for Today HH:MM" shows with Undo. Click Undo, then type `/reminders`: the panel is empty.
  3. Custom… → the wheel dialog: arrows move the wheels, chips change the preview, a past time disables Set reminder.
  4. Type `/remind 1m stretch`. Within ~70 s a DM from **System** appears in the DM list. It shows the SYSTEM badge, the alarm avatar and "Reminder: **stretch**", and its composer reads "You can't reply to System.".
  5. Set a reminder on a message with a 1-minute custom time. When it fires, the quote card shows author · #channel; **Jump to message** opens and highlights it.
  6. Check `read_console_messages` for errors and `read_network_requests` for `/api/reminders`.
- [ ] **Step 4: Screenshot** the System DM with a fired reminder and the open Reminders panel, and send both with `SendUserFile`.
- [ ] **Step 5: Stage everything** (`rtk git add -A`, after reviewing `rtk git status`) and hand over. The user commits. Mention the 00043 migration number collision risk in the hand-over.
