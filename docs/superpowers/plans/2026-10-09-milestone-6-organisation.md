# Milestone 6: Organisation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Organise a growing server:
- channel categories (create, rename, delete, collapse per device, drag to reorder categories and channels);
- channel topics in the header;
- pinned messages with a pins panel;
- threads in a side panel;
- a side chat for voice channels;
- a "New messages" line with jump to the first unread message.

**Architecture:**
- **Categories:** a new `categories` table in the `channels` package; channels gain `category_id` and `topic`.
- **Reordering:** moving a channel or category is a single PATCH. The server renumbers the siblings inside a transaction that locks the server row, as role ordering does in M4.
- **Threads:** channels of a new type `thread` with `parent_channel_id` and `parent_message_id`. They take every permission from their parent channel. The `messages` package creates them, attaches a thread summary to the parent message and publishes `THREAD_UPDATE`.
- **Pins:** columns on `messages`.
- **Client-only features:**
  - the voice side chat: voice channels already accept messages;
  - the unread line, built from the read states the client already has;
  - collapsed categories, stored per device.

**Tech Stack:** Go (Huma, pgx, goose) · `@datrope/core` · React 18 + shadcn/ui · `@dnd-kit/core` 6.3.1 + `@dnd-kit/sortable` 10.0.0 + `@dnd-kit/utilities` 3.2.2 (keyboard-accessible drag and drop; the controller installs them before Task 5) · Vitest · Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-one-server-design.md`:
- §3 Category; channel types incl. `thread`;
- §4 permissions;
- §5 `/api/server/categories`, READY categories, events `CATEGORY_CREATE/UPDATE/DELETE` and `THREAD_UPDATE`;
- §6 M6;
- §7 threads with a deleted parent;
- §8 the M6 e2e: reply in a thread.

**Mockups:**
- `docs/superpowers/mockups/Main.dc.html`: channel header buttons "Threads" and "Pinned messages"; the "New messages" divider; the Thread side panel (`aside aria-label="Thread"`, "Close thread", composer "Reply in thread"); the thread summary on a parent message ("4 replies · Last reply 10 min ago" with participant avatars).
- `docs/superpowers/mockups/VoiceStage.dc.html`: header button "Channel chat".

## Global Constraints

- **Never commit.** (AGENTS.md §5.) Each task ends with a *Checkpoint*: the controller reviews and stages; nobody commits.
- **Categories:**
  - managed with `MANAGE_CHANNELS`; names 1–100 characters;
  - deleting a category moves its channels to "no category", keeping their order after the uncategorised channels;
  - collapsing is a per-device client setting.
- **Order:**
  - uncategorised channels come first, then categories by `position`;
  - inside each group, channels go by `position`;
  - the welcome channel always stays first and uncategorised;
  - positions are dense and unique per group (0, 1, 2…).
- **Topic:** up to 1024 characters, edited with `MANAGE_CHANNELS`, rendered with the message Markdown.
- **Pins:**
  - pin and unpin need `MANAGE_MESSAGES`; in DMs, any participant can;
  - at most **50 pins per channel** (`400 PIN_LIMIT`);
  - pinned messages are listed newest pin first.
- **Threads:**
  - start one from a message in a text or voice channel with `CREATE_THREADS` (+ `SEND_MESSAGES`);
  - one thread per message;
  - no threads in DMs, the welcome channel or threads;
  - a thread uses its parent channel's permissions for everything;
  - deleting the parent message keeps the thread readable ("Original message deleted");
  - deleting the parent channel deletes its threads.
  - The thread summary on the parent message is `{id, name, message_count, last_message_at, participants (≤3)}`.
- **Unread line:**
  - "New messages" sits before the first message newer than the read marker as it was when the channel was opened, and not your own;
  - "Jump to first unread" shows while that line is above the view;
  - reaching the bottom marks the channel read, as today.
- **Web UI:** shadcn/ui first (AGENTS.md §6; hand-write registry components if the CLI cannot run); tokens only; dark only; keep accessible names stable (e2e uses role + name).
- **Dev environment:**
  - the user's dev servers run on :8081/:5173; implementers never start or stop them;
  - implementers never run `pnpm install`/`add`, because Vite locks native binaries; the controller installs packages;
  - Go tests run from PowerShell with `$env:GOTOOLCHAIN='local'`;
  - a local e2e run needs the LiveKit port override (the dev LiveKit holds 7881).
- **Out of scope:** thread notifications and inbox, mention badges (M8); archiving threads; per-category permission overrides.

## Decisions this plan makes

1. **Categories have no permissions.** A category whose channels are all hidden from you is not shown, unless you have `MANAGE_CHANNELS`.
2. **One move per drag.** A drag sends one `PATCH /api/channels/{id}` with `{category_id, position}` (or `PATCH /api/server/categories/{id}` with `{position}`). The server renumbers and publishes `CHANNEL_UPDATE` for every channel whose position or category changed, each to the people who can see it; categories get `CATEGORY_UPDATE`.
3. **Thread channels:**
   - never listed in the sidebar;
   - opened from the parent message's summary or the channel's Threads list (`GET /api/channels/{id}/threads`, most recent activity first);
   - a thread's name defaults to the first line of the parent message, cut to 40 characters (or "Thread");
   - renaming uses the normal channel rename route, so it needs `MANAGE_CHANNELS` on the parent.
4. **Thread messages** go through the existing message routes on the thread's channel ID. Posting or deleting in a thread publishes `THREAD_UPDATE` `{channel_id (parent channel), message_id (parent message), thread}`.
5. **Voice side chat** is the voice channel's own messages, shown in the same side panel component as threads. No threads are started from voice side-chat messages, to keep the side panel single-level.
6. **Pin updates** publish `MESSAGE_UPDATE` with `pinned` and `pinned_at`.

## File Structure

```
server/internal/db/migrations/00015_categories_topics.sql   categories, channels.category_id, channels.topic
server/internal/db/migrations/00016_pins.sql               messages.pinned_at, pinned_by
server/internal/db/migrations/00017_threads.sql            channel type thread, parent_channel_id, parent_message_id
server/internal/channels/   categories.go (+test), order.go (renumbering), threads.go (thread channels, perms via parent)
server/internal/messages/   pins.go (+test), threads.go (+test: create, summary, THREAD_UPDATE)
server/internal/app/        READY categories, schemas
clients/core/src/           categories, topic, pins, threads state and API
clients/web/src/app/        sidebar/ (CategoryList, SortableChannel, CategoryDialog), PinsPanel.tsx, side-panel/ (SidePanel, ThreadPanel, ThreadsList), UnreadDivider
clients/web/e2e/chat.spec.ts
```

---

### Task 1: Categories, topics and ordering (server)

**Files:**
- Create: `server/internal/db/migrations/00015_categories_topics.sql`, `server/internal/channels/categories.go`, `server/internal/channels/order.go`, `server/internal/channels/categories_test.go`
- Modify: `server/internal/channels/channels.go` (`Channel.CategoryID`, `Channel.Topic`, cols/scan), `handlers.go` (update-channel gains `topic`, `category_id`, `clear_category`, `position` with renumbering; create-channel accepts `category_id`), `server/internal/app/realtime.go` (READY `server.categories`, event schemas)

**Interfaces:**
- **Channel fields:** `Channel.CategoryID *id.ID` (JSON `category_id,omitempty`); `Channel.Topic string` (JSON `topic`).
- **Category type:** `type Category struct{ ID id.ID; Name string; Position int }` (JSON `id`, `name`, `position`); `(*Service).Categories(ctx, serverID) ([]Category, error)`.
- **Routes** (all `MANAGE_CHANNELS` except list, which any ungated member may call):
  - `list-categories` `GET /api/server/categories`;
  - `create-category` `POST /api/server/categories` `{name}` → 201 `Category`, at the end;
  - `update-category` `PATCH /api/server/categories/{categoryID}` `{name?, position?}`;
  - `delete-category` `DELETE /api/server/categories/{categoryID}` → 204.
- **Events:** `CATEGORY_CREATE` / `CATEGORY_UPDATE` (`Category`), `CATEGORY_DELETE` (`{id}`), scoped to the server; `CHANNEL_UPDATE` per channel moved.
- **Channel requests:**
  - `UpdateChannelRequest` gains `Topic *string` (maxLength 1024), `CategoryID *id.ID`, `ClearCategory bool`; `Position` keeps its meaning but is now an index inside the target group (clamped).
  - `CreateChannelRequest` gains `CategoryID *id.ID`; new channels go last in their group.
- **READY:** `ReadyServer.Categories []channels.Category` (JSON `categories`). Gated members get only the categories that contain a channel they can see, which is none.
- **Errors:** `400 WELCOME_STAYS` (moving the welcome channel into a category or away from position 0); `404` for an unknown category.

- [ ] **Step 1: Write the failing tests** — `server/internal/channels/categories_test.go`:

```go
package channels_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
)

func names(chs []channels.Channel, category *channels.Category) []string {
	out := []string{}
	for _, c := range chs {
		if (category == nil && c.CategoryID == nil) || (category != nil && c.CategoryID != nil && *c.CategoryID == category.ID) {
			out = append(out, c.Name)
		}
	}
	return out
}

func TestCategoriesAndOrdering(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var games channels.Category
	alice.Do(http.MethodPost, "/api/server/categories", map[string]any{"name": "Games"}, http.StatusCreated, &games)
	ws.ExpectDispatch("CATEGORY_CREATE", nil)
	bob.Fail(http.MethodPost, "/api/server/categories", map[string]any{"name": "Mine"}, http.StatusForbidden, "MISSING_PERMISSION")

	a := alice.CreateTextChannel("a")
	b := alice.CreateTextChannel("b")
	c := alice.CreateTextChannel("c")
	for _, ch := range []any{a, b, c} {
		alice.Do(http.MethodPatch, "/api/channels/"+idString(ch), map[string]any{"category_id": games.ID.String()}, http.StatusOK, nil)
	}
	require.Equal(t, []string{"a", "b", "c"}, names(alice.Channels(), &games))
	require.Equal(t, []string{"welcome", "general"}, names(alice.Channels(), nil))

	// Move c to the top of the category; positions stay dense.
	alice.Do(http.MethodPatch, "/api/channels/"+idString(c), map[string]any{"position": 0}, http.StatusOK, nil)
	require.Equal(t, []string{"c", "a", "b"}, names(alice.Channels(), &games))
	seen := map[int]bool{}
	for _, ch := range alice.Channels() {
		if ch.CategoryID != nil {
			require.False(t, seen[ch.Position])
			seen[ch.Position] = true
		}
	}

	// Topic.
	var updated channels.Channel
	alice.Do(http.MethodPatch, "/api/channels/"+idString(a), map[string]any{"topic": "Board games **only**"}, http.StatusOK, &updated)
	require.Equal(t, "Board games **only**", updated.Topic)

	// The welcome channel stays first and uncategorised.
	var welcome channels.Channel
	for _, ch := range alice.Channels() {
		if ch.Type == "welcome" {
			welcome = ch
		}
	}
	alice.Fail(http.MethodPatch, "/api/channels/"+welcome.ID.String(), map[string]any{"category_id": games.ID.String()}, http.StatusBadRequest, "WELCOME_STAYS")

	// Deleting a category moves its channels to the end of the uncategorised list.
	alice.Do(http.MethodDelete, "/api/server/categories/"+games.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"welcome", "general", "c", "a", "b"}, names(alice.Channels(), nil))

	_, ready := bob.Connect()
	require.Empty(t, ready.Server.Categories)
}

func TestCategoryRenameAndReorder(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var one, two channels.Category
	alice.Do(http.MethodPost, "/api/server/categories", map[string]any{"name": "One"}, http.StatusCreated, &one)
	alice.Do(http.MethodPost, "/api/server/categories", map[string]any{"name": "Two"}, http.StatusCreated, &two)
	require.Equal(t, 0, one.Position)
	require.Equal(t, 1, two.Position)
	alice.Do(http.MethodPatch, "/api/server/categories/"+two.ID.String(), map[string]any{"position": 0, "name": "Second"}, http.StatusOK, &two)
	var list []channels.Category
	alice.Do(http.MethodGet, "/api/server/categories", nil, http.StatusOK, &list)
	require.Equal(t, "Second", list[0].Name)
	require.Equal(t, "One", list[1].Name)
}
```

`idString` is a test helper: `func idString(v any) string { return fmt.Sprint(v) }`. `CreateTextChannel` (M5) returns an `id.ID`, whose `String()` is its decimal form. Use `x.String()` directly if the types make the helper unnecessary.

- [ ] **Step 2: Run to verify they fail** — PowerShell: `$env:GOTOOLCHAIN='local'; go -C server test ./internal/channels/ -run 'TestCategor'`. Expected: compile errors.

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00015_categories_topics.sql`:

```sql
-- +goose Up
CREATE TABLE categories (
    id           BIGINT PRIMARY KEY,
    community_id BIGINT NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     INT NOT NULL DEFAULT 0
);
CREATE INDEX categories_community_idx ON categories (community_id, position);

ALTER TABLE channels
    ADD COLUMN category_id BIGINT REFERENCES categories (id) ON DELETE SET NULL,
    ADD COLUMN topic TEXT NOT NULL DEFAULT '';

-- Dense positions per group: the welcome channel first, then the rest in their current order.
UPDATE channels ch SET position = o.n - 1
FROM (SELECT id, row_number() OVER (PARTITION BY community_id ORDER BY (type = 'welcome') DESC, position, id) AS n
      FROM channels WHERE community_id IS NOT NULL) o
WHERE ch.id = o.id;

-- +goose Down
ALTER TABLE channels DROP COLUMN topic, DROP COLUMN category_id;
DROP TABLE categories;
```

(`ON DELETE SET NULL` leaves the moved channels' positions to the delete handler, which renumbers them; see Step 5.)

- [ ] **Step 4: Ordering helpers** — `server/internal/channels/order.go`:

```go
package channels

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/id"
)

// lockOrder serialises everything that changes channel or category order
// for a server; take it first in the transaction.
func lockOrder(ctx context.Context, tx pgx.Tx, serverID id.ID) error {
	_, err := tx.Exec(ctx, `SELECT 1 FROM communities WHERE id = $1 FOR UPDATE`, serverID)
	return err
}

// groupIDs returns the channel IDs of one group (a category, or nil for
// uncategorised) in order, excluding exclude.
func groupIDs(ctx context.Context, tx pgx.Tx, serverID id.ID, categoryID *id.ID, exclude id.ID) ([]id.ID, error) {
	rows, err := tx.Query(ctx, `
		SELECT id FROM channels
		WHERE community_id = $1 AND type <> 'thread' AND id <> $3
		  AND (($2::bigint IS NULL AND category_id IS NULL) OR category_id = $2)
		ORDER BY (type = 'welcome') DESC, position, id`, serverID, categoryID, exclude)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}

// placeChannel puts channel chID into group categoryID at index pos
// (clamped) and renumbers both the old and the new group densely. It returns
// every channel whose category or position may have changed.
func placeChannel(ctx context.Context, tx pgx.Tx, serverID, chID id.ID, oldCategory, newCategory *id.ID, pos int) ([]id.ID, error) {
	target, err := groupIDs(ctx, tx, serverID, newCategory, chID)
	if err != nil {
		return nil, err
	}
	pos = max(0, min(pos, len(target)))
	ordered := append(append(append([]id.ID{}, target[:pos]...), chID), target[pos:]...)
	changed := map[id.ID]bool{}
	for i, cid := range ordered {
		if _, err := tx.Exec(ctx, `UPDATE channels SET category_id = $2, position = $3 WHERE id = $1`, cid, newCategory, i); err != nil {
			return nil, err
		}
		changed[cid] = true
	}
	if !sameCategory(oldCategory, newCategory) {
		old, err := groupIDs(ctx, tx, serverID, oldCategory, chID)
		if err != nil {
			return nil, err
		}
		for i, cid := range old {
			if _, err := tx.Exec(ctx, `UPDATE channels SET position = $2 WHERE id = $1`, cid, i); err != nil {
				return nil, err
			}
			changed[cid] = true
		}
	}
	out := make([]id.ID, 0, len(changed))
	for cid := range changed {
		out = append(out, cid)
	}
	return out, nil
}

func sameCategory(a, b *id.ID) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
```

(The function updates every row in the target group even when only one moved. Groups are small, so the simplicity is worth it. The returned list drives `CHANNEL_UPDATE` events, and publishing an unchanged channel is harmless.)

- [ ] **Step 5: Categories** — `server/internal/channels/categories.go`:

```go
package channels

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type Category struct {
	ID       id.ID  `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
}

type CategoryDeleted struct {
	ID id.ID `json:"id"`
}

type CategoryRequest struct {
	Name     *string `json:"name,omitempty" minLength:"1" maxLength:"100"`
	Position *int    `json:"position,omitempty" minimum:"0"`
}

func (s *Service) Categories(ctx context.Context, serverID id.ID) ([]Category, error) {
	rows, err := s.db.Query(ctx, `SELECT id, name, position FROM categories WHERE community_id = $1 ORDER BY position, id`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Category{}
	for rows.Next() {
		var c Category
		if err := rows.Scan(&c.ID, &c.Name, &c.Position); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// requireManage returns the server ID when the caller may manage channels.
func (s *Service) requireManage(ctx context.Context) (id.ID, error) {
	sid, err := s.serverID(ctx)
	if err != nil {
		return 0, err
	}
	m, err := s.communities.PermMember(ctx, sid, auth.Current(ctx).User.ID)
	if errors.Is(err, communities.ErrNotMember) {
		return 0, errNotMember()
	}
	if err != nil {
		return 0, err
	}
	if m.Gated || !perms.Base(m.Perms).Has(perms.ManageChannels) {
		return 0, httpx.MissingPermission()
	}
	return sid, nil
}

func (s *Service) category(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, serverID id.ID, raw string) (*Category, error) {
	cid, err := httpx.ParseID(raw, "category")
	if err != nil {
		return nil, err
	}
	var c Category
	err = q.QueryRow(ctx, `SELECT id, name, position FROM categories WHERE id = $1 AND community_id = $2`, cid, serverID).
		Scan(&c.ID, &c.Name, &c.Position)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("category")
	}
	return &c, err
}

func (s *Service) publishCategory(typ string, serverID id.ID, data any) {
	s.bus.Publish(events.Event{Type: typ, Data: data, Scope: events.Scope{CommunityID: serverID}})
}

func registerCategories(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("list-categories", http.MethodGet, "/api/server/categories", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Category }, error) {
			sid, err := s.serverID(ctx)
			if err != nil {
				return nil, err
			}
			if _, err := s.communities.PermMember(ctx, sid, auth.Current(ctx).User.ID); errors.Is(err, communities.ErrNotMember) {
				return nil, errNotMember()
			} else if err != nil {
				return nil, err
			}
			cs, err := s.Categories(ctx, sid)
			return &struct{ Body []Category }{cs}, err
		})

	huma.Register(api, op("create-category", http.MethodPost, "/api/server/categories", http.StatusCreated),
		func(ctx context.Context, in *struct {
			Body struct {
				Name string `json:"name" minLength:"1" maxLength:"100"`
			}
		}) (*struct{ Body *Category }, error) {
			sid, err := s.requireManage(ctx)
			if err != nil {
				return nil, err
			}
			c := &Category{ID: id.New(), Name: strings.TrimSpace(in.Body.Name)}
			if c.Name == "" {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "a category needs a name")
			}
			if err := s.db.QueryRow(ctx, `
				INSERT INTO categories (id, community_id, name, position)
				VALUES ($1, $2, $3, (SELECT COALESCE(max(position), -1) + 1 FROM categories WHERE community_id = $2))
				RETURNING position`, c.ID, sid, c.Name).Scan(&c.Position); err != nil {
				return nil, err
			}
			s.publishCategory("CATEGORY_CREATE", sid, c)
			return &struct{ Body *Category }{c}, nil
		})

	huma.Register(api, op("update-category", http.MethodPatch, "/api/server/categories/{categoryID}", 0),
		func(ctx context.Context, in *struct {
			CategoryID string `path:"categoryID"`
			Body       CategoryRequest
		}) (*struct{ Body *Category }, error) {
			sid, err := s.requireManage(ctx)
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if err := lockOrder(ctx, tx, sid); err != nil {
				return nil, err
			}
			c, err := s.category(ctx, tx, sid, in.CategoryID)
			if err != nil {
				return nil, err
			}
			if in.Body.Name != nil {
				c.Name = strings.TrimSpace(*in.Body.Name)
				if c.Name == "" {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "a category needs a name")
				}
				if _, err := tx.Exec(ctx, `UPDATE categories SET name = $2 WHERE id = $1`, c.ID, c.Name); err != nil {
					return nil, err
				}
			}
			var moved []Category
			if in.Body.Position != nil {
				rows, err := tx.Query(ctx, `SELECT id FROM categories WHERE community_id = $1 AND id <> $2 ORDER BY position, id`, sid, c.ID)
				if err != nil {
					return nil, err
				}
				others, err := pgx.CollectRows(rows, pgx.RowTo[id.ID])
				if err != nil {
					return nil, err
				}
				pos := max(0, min(*in.Body.Position, len(others)))
				ordered := append(append(append([]id.ID{}, others[:pos]...), c.ID), others[pos:]...)
				for i, cid := range ordered {
					if _, err := tx.Exec(ctx, `UPDATE categories SET position = $2 WHERE id = $1`, cid, i); err != nil {
						return nil, err
					}
				}
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			all, err := s.Categories(ctx, sid)
			if err != nil {
				return nil, err
			}
			for _, x := range all {
				if x.ID == c.ID {
					*c = x
				}
				if in.Body.Position != nil || x.ID == c.ID {
					moved = append(moved, x)
				}
			}
			for _, x := range moved {
				s.publishCategory("CATEGORY_UPDATE", sid, x)
			}
			return &struct{ Body *Category }{c}, nil
		})

	huma.Register(api, op("delete-category", http.MethodDelete, "/api/server/categories/{categoryID}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			CategoryID string `path:"categoryID"`
		}) (*struct{}, error) {
			sid, err := s.requireManage(ctx)
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if err := lockOrder(ctx, tx, sid); err != nil {
				return nil, err
			}
			c, err := s.category(ctx, tx, sid, in.CategoryID)
			if err != nil {
				return nil, err
			}
			// Its channels go to the end of the uncategorised list, in their order.
			uncategorised, err := groupIDs(ctx, tx, sid, nil, 0)
			if err != nil {
				return nil, err
			}
			members, err := groupIDs(ctx, tx, sid, &c.ID, 0)
			if err != nil {
				return nil, err
			}
			for i, cid := range members {
				if _, err := tx.Exec(ctx, `UPDATE channels SET category_id = NULL, position = $2 WHERE id = $1`, cid, len(uncategorised)+i); err != nil {
					return nil, err
				}
			}
			if _, err := tx.Exec(ctx, `DELETE FROM categories WHERE id = $1`, c.ID); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE categories SET position = o.n - 1
				FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS n FROM categories WHERE community_id = $1) o
				WHERE categories.id = o.id`, sid); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.publishCategory("CATEGORY_DELETE", sid, CategoryDeleted{ID: c.ID})
			for _, cid := range members {
				if err := s.publishVisibility(ctx, cid, nil); err != nil {
					return nil, err
				}
			}
			return nil, nil
		})
}
```

Notes:
- `publishVisibility(ctx, channelID, before)` (M2/M4) publishes `CHANNEL_UPDATE` to the current viewers. Passing `nil` for `before` means "no one lost access". Use it to announce moved channels to the people who can see each one.
- Call `registerCategories(api, s, op)` from `Register`.
- Remaining categories after a delete also changed position. Publish `CATEGORY_UPDATE` for them as well (re-read `Categories` after the commit and publish each).

- [ ] **Step 6: Channels** — in `channels.go`:
- `Channel` gains `CategoryID *id.ID \`json:"category_id,omitempty"\`` and `Topic string \`json:"topic"\``.
- `channelCols` gains `category_id, topic`, and `scanChannel` scans them.
- `ListVisible` orders by `category_id NULLS FIRST, (type = 'welcome') DESC, position, id`. The client groups channels itself, so this order only needs to be stable.

In `handlers.go`:

```go
type CreateChannelRequest struct {
	Name       string `json:"name" minLength:"1" maxLength:"100"`
	Type       string `json:"type" enum:"text,voice"`
	CategoryID *id.ID `json:"category_id,omitempty"`
}

type UpdateChannelRequest struct {
	Name          *string `json:"name,omitempty" minLength:"1" maxLength:"100"`
	Topic         *string `json:"topic,omitempty" maxLength:"1024"`
	CategoryID    *id.ID  `json:"category_id,omitempty" doc:"Move into this category"`
	ClearCategory bool    `json:"clear_category,omitempty" doc:"Move out of any category"`
	Position      *int    `json:"position,omitempty" minimum:"0" doc:"Index inside the channel's (new) group"`
}
```

**create-channel:** validate the category, if given, with `s.category(ctx, s.db, cid, id.String())`. Insert inside a transaction with `lockOrder`, at `position = len(groupIDs(...))` in that group.

**update-channel:**
1. After the access check, load the channel `c`.
2. Rename and topic go in one UPDATE (trim the topic).
3. If any of `CategoryID`, `ClearCategory` or `Position` is set:
   - begin a transaction and take `lockOrder`;
   - work out the new category: `CategoryID`, nil if `ClearCategory`, otherwise unchanged; validate it belongs to the server;
   - refuse to move the welcome channel: a category, or a position other than 0 → `400 WELCOME_STAYS` "the welcome channel stays at the top";
   - the target index is `Position` if set, otherwise the end of the target group;
   - call `placeChannel` and commit;
   - call `publishVisibility(ctx, id, nil)` for each changed ID except `c.ID`.
4. Publish `CHANNEL_UPDATE` for `c` as today.

- [ ] **Step 7: READY** — `ReadyServer` gains `Categories []channels.Category \`json:"categories"\``. Fill it for members with `channels.Categories`, but for gated members set it to `[]`. `registerEventSchemas` adds `channels.Category{}` and `channels.CategoryDeleted{}`.

- [ ] **Step 8: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...` (PowerShell). Expected: PASS. Older tests that assert channel order may need adjusting to the dense renumbering; keep their intent. `gofmt -l server` empty.

- [ ] **Step 9: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(channels): categories, topics and drag ordering`

---

### Task 2: Pinned messages (server)

**Files:**
- Create: `server/internal/db/migrations/00016_pins.sql`, `server/internal/messages/pins.go`, `server/internal/messages/pins_test.go`
- Modify: `server/internal/messages/messages.go` (`Message.Pinned`, `PinnedAt`, cols/scan), `handlers.go` (register; deleting a message unpins it)

**Interfaces:**
- **Message fields:** `Message.Pinned bool` (JSON `pinned`); `Message.PinnedAt *time.Time` (JSON `pinned_at,omitempty`).
- **Routes:**
  - `pin-message` `PUT /api/channels/{id}/pins/{messageID}` → 204;
  - `unpin-message` `DELETE /api/channels/{id}/pins/{messageID}` → 204;
  - `list-pins` `GET /api/channels/{id}/pins` → `[]Message`, newest pin first, max 50.
- **Rules:** pinning needs `MANAGE_MESSAGES`, except in DMs, where participants may pin. Listing needs `READ_HISTORY`.
- **Event:** `MESSAGE_UPDATE` with the hydrated message.
- **Errors:** `400 PIN_LIMIT` ("a channel can have at most 50 pinned messages"); 404 for a deleted or unknown message.

- [ ] **Step 1: Write the failing test** — `server/internal/messages/pins_test.go`:

```go
package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/messages"
)

func TestPins(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	first := alice.Send(general, "first")
	second := alice.Send(general, "second")
	ws, _ := bob.Connect()
	pin := func(c *apptest.Client, m messages.Message, method string, want int) {
		c.Do(method, "/api/channels/"+general.String()+"/pins/"+m.ID.String(), nil, want, nil)
	}

	pin(alice, first, http.MethodPut, http.StatusNoContent)
	var ev messages.Message
	ws.ExpectDispatch("MESSAGE_UPDATE", &ev)
	require.True(t, ev.Pinned)
	require.NotNil(t, ev.PinnedAt)
	pin(alice, second, http.MethodPut, http.StatusNoContent)
	pin(alice, first, http.MethodPut, http.StatusNoContent) // already pinned: no change

	var pins []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/pins", nil, http.StatusOK, &pins)
	require.Equal(t, []string{"second", "first"}, []string{pins[0].Content, pins[1].Content})

	bob.Fail(http.MethodPut, "/api/channels/"+general.String()+"/pins/"+first.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
	pin(alice, first, http.MethodDelete, http.StatusNoContent)
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/pins", nil, http.StatusOK, &pins)
	require.Len(t, pins, 1)

	// Deleting a pinned message unpins it.
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+second.ID.String(), nil, http.StatusNoContent, nil)
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/pins", nil, http.StatusOK, &pins)
	require.Empty(t, pins)
}

func TestPinLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	_, err := env.Pool.Exec(t.Context(), `
		INSERT INTO messages (id, channel_id, author_id, content, pinned_at)
		SELECT g, $1, $2, 'p', now() FROM generate_series(1, 50) g`, general, alice.User.ID)
	require.NoError(t, err)
	m := alice.Send(general, "one more")
	alice.Fail(http.MethodPut, "/api/channels/"+general.String()+"/pins/"+m.ID.String(), nil, http.StatusBadRequest, "PIN_LIMIT")
}
```

Also add a DM case: in a DM, bob, who has no `MANAGE_MESSAGES`, can pin. Use the DM-creation helper or route the channels tests use.

- [ ] **Step 2: Run to verify it fails** — `go -C server test ./internal/messages/ -run TestPin`. Expected: compile errors.

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00016_pins.sql`:

```sql
-- +goose Up
ALTER TABLE messages
    ADD COLUMN pinned_at TIMESTAMPTZ,
    ADD COLUMN pinned_by BIGINT REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX messages_pins_idx ON messages (channel_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;

-- +goose Down
DROP INDEX messages_pins_idx;
ALTER TABLE messages DROP COLUMN pinned_by, DROP COLUMN pinned_at;
```

- [ ] **Step 4: Implement** — `server/internal/messages/pins.go`:

```go
package messages

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/perms"
)

const maxPins = 50

func registerPins(api huma.API, s *Service, op func(string, string, string, int) huma.Operation, access accessFunc) {
	pinAccess := func(ctx context.Context, raw string) (*channels.Channel, error) {
		ch, have, err := access(ctx, raw, perms.ReadHistory)
		if err != nil {
			return nil, err
		}
		if ch.Type != channels.TypeDM && !have.Has(perms.ManageMessages) {
			return nil, httpx.MissingPermission()
		}
		return ch, nil
	}

	huma.Register(api, op("pin-message", http.MethodPut, "/api/channels/{id}/pins/{messageID}", http.StatusNoContent),
		func(ctx context.Context, in *messagePath) (*struct{}, error) {
			ch, err := pinAccess(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('pins:' || $1::text, 0))`, ch.ID); err != nil {
				return nil, err
			}
			var count int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM messages WHERE channel_id = $1 AND pinned_at IS NOT NULL AND NOT deleted`, ch.ID).Scan(&count); err != nil {
				return nil, err
			}
			tag, err := tx.Exec(ctx, `UPDATE messages SET pinned_at = now(), pinned_by = $2 WHERE id = $1 AND pinned_at IS NULL`,
				m.ID, auth.Current(ctx).User.ID)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, nil // already pinned
			}
			if count >= maxPins {
				return nil, httpx.BadRequest("PIN_LIMIT", "a channel can have at most 50 pinned messages")
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.publishUpdated(ctx, ch.ID, m.ID)
			return nil, nil
		})

	huma.Register(api, op("unpin-message", http.MethodDelete, "/api/channels/{id}/pins/{messageID}", http.StatusNoContent),
		func(ctx context.Context, in *messagePath) (*struct{}, error) {
			ch, err := pinAccess(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			tag, err := s.db.Exec(ctx, `UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1 AND pinned_at IS NOT NULL`, m.ID)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() > 0 {
				s.publishUpdated(ctx, ch.ID, m.ID)
			}
			return nil, nil
		})

	huma.Register(api, op("list-pins", http.MethodGet, "/api/channels/{id}/pins", 0),
		func(ctx context.Context, in *channelPath) (*struct{ Body []Message }, error) {
			ch, _, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			rows, err := s.db.Query(ctx, `SELECT `+messageCols+` FROM messages
				WHERE channel_id = $1 AND pinned_at IS NOT NULL AND NOT deleted ORDER BY pinned_at DESC LIMIT $2`, ch.ID, maxPins)
			if err != nil {
				return nil, err
			}
			defer rows.Close()
			out := []Message{}
			for rows.Next() {
				m, err := scanMessage(rows)
				if err != nil {
					return nil, err
				}
				out = append(out, *m)
			}
			if err := rows.Err(); err != nil {
				return nil, err
			}
			return &struct{ Body []Message }{out}, s.hydrate(ctx, out)
		})
}
```

(The count check comes after the conditional UPDATE so that re-pinning an already pinned message at the limit stays a no-op. If the limit is exceeded, returning before commit rolls the pin back.)

In `messages.go`:
- `Message` gains `Pinned bool \`json:"pinned"\`` and `PinnedAt *time.Time \`json:"pinned_at,omitempty"\``.
- `messageCols` gains `pinned_at`; `scanMessage` sets `Pinned = PinnedAt != nil`.
- The delete handler also sets `pinned_at = NULL, pinned_by = NULL`.
- Call `registerPins(api, s, op, access)` from `Register`.

- [ ] **Step 5: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...`. Expected: PASS. `gofmt -l server` empty.

- [ ] **Step 6: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(messages): pinned messages`

---

### Task 3: Threads (server)

**Files:**
- Create: `server/internal/db/migrations/00017_threads.sql`, `server/internal/channels/threads.go`, `server/internal/messages/threads.go`, `server/internal/messages/threads_test.go`
- Modify: `server/internal/channels/channels.go` (`TypeThread`, `Channel.ParentChannelID`, `ParentMessageID`, cols/scan; `permsIn` and `viewersOf` resolve threads through the parent; `ListVisible` excludes threads), `server/internal/messages/messages.go` (`Message.Thread`, `hydrate` adds summaries; posting or deleting in a thread publishes `THREAD_UPDATE`), `handlers.go`, `server/internal/app/realtime.go` (schemas)

**Interfaces:**
- **Package `channels`:**
  - `TypeThread = "thread"`; `Channel.ParentChannelID *id.ID` (JSON `parent_channel_id,omitempty`), `Channel.ParentMessageID *id.ID` (JSON `parent_message_id,omitempty`); the `Type` enum adds `thread`.
  - `(*Service).CreateThread(ctx, parent *Channel, messageID, creatorID id.ID, name string) (*Channel, bool /*created*/, error)`, idempotent per message.
  - `(*Service).ThreadsOf(ctx, parentID) ([]Channel, error)`.
  - `(*Service).Get(ctx, channelID) (*Channel, error)`, exported for messages.
- **Package `messages`:**
  - `type ThreadSummary struct{ ID id.ID; Name string; MessageCount int; LastMessageAt *time.Time; Participants []auth.PublicUser }` (JSON `id`, `name`, `message_count`, `last_message_at,omitempty`, `participants`; at most 3, the earliest posters).
  - `Message.Thread *ThreadSummary` (JSON `thread,omitempty`).
  - `type ThreadUpdate struct{ ChannelID, MessageID id.ID; Thread ThreadSummary }` (JSON `channel_id`, `message_id`, `thread`).
- **Routes:**
  - `create-thread` `POST /api/channels/{id}/messages/{messageID}/thread` `{name?}` → 201 `Channel` (200 with the existing thread if one exists). It needs `CREATE_THREADS` and `SEND_MESSAGES` on the parent, and the parent must be `text` or `voice`.
  - `list-threads` `GET /api/channels/{id}/threads` → `[]ThreadListItem{channel: Channel, parent_message_id, summary: ThreadSummary}`, sorted by last activity.
  - `get-channel` `GET /api/channels/{id}` → `Channel` (`VIEW_CHANNEL`).
- **Events:** `THREAD_UPDATE` on thread creation and on every post or delete in a thread, scoped to the parent channel. Messages in a thread use the normal `MESSAGE_*` events, scoped to the thread channel, whose viewers are the parent's.
- **Errors:** `400 NO_THREADS_HERE` (DM, welcome or thread parent).

- [ ] **Step 1: Write the failing tests** — `server/internal/messages/threads_test.go`:

```go
package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestThreads(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	parent := alice.Send(general, "Saturday: board games at mine?")
	ws, _ := bob.Connect()

	var thread channels.Channel
	alice.Do(http.MethodPost, "/api/channels/"+general.String()+"/messages/"+parent.ID.String()+"/thread",
		map[string]any{}, http.StatusCreated, &thread)
	require.Equal(t, "thread", thread.Type)
	require.Equal(t, "Saturday: board games at mine?", thread.Name)
	var up messages.ThreadUpdate
	ws.ExpectDispatch("THREAD_UPDATE", &up)
	require.Equal(t, parent.ID, up.MessageID)
	require.Equal(t, 0, up.Thread.MessageCount)

	// Starting it again returns the same thread.
	var again channels.Channel
	bob.Do(http.MethodPost, "/api/channels/"+general.String()+"/messages/"+parent.ID.String()+"/thread",
		map[string]any{}, http.StatusOK, &again)
	require.Equal(t, thread.ID, again.ID)

	bob.Send(thread.ID, "I'm in")
	alice.Send(thread.ID, "great")
	ws.ExpectDispatch("THREAD_UPDATE", &up)
	ws.ExpectDispatch("THREAD_UPDATE", &up)
	require.Equal(t, 2, up.Thread.MessageCount)
	require.Len(t, up.Thread.Participants, 2)

	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &page)
	var p messages.Message
	for _, m := range page {
		if m.ID == parent.ID {
			p = m
		}
	}
	require.NotNil(t, p.Thread)
	require.Equal(t, 2, p.Thread.MessageCount)

	// Threads are not in the channel list but are in the channel's thread list.
	for _, ch := range bob.Channels() {
		require.NotEqual(t, "thread", ch.Type)
	}
	var list []struct {
		Channel channels.Channel `json:"channel"`
	}
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/threads", nil, http.StatusOK, &list)
	require.Len(t, list, 1)

	// The parent can be deleted; the thread stays readable.
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+parent.ID.String(), nil, http.StatusNoContent, nil)
	bob.Do(http.MethodGet, "/api/channels/"+thread.ID.String()+"/messages", nil, http.StatusOK, &page)
	require.Len(t, page, 2)
}

func TestThreadPermissions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	parent := alice.Send(general, "x")
	var thread channels.Channel
	alice.Do(http.MethodPost, "/api/channels/"+general.String()+"/messages/"+parent.ID.String()+"/thread", map[string]any{"name": "Plans"}, http.StatusCreated, &thread)
	require.Equal(t, "Plans", thread.Name)

	// Hiding the parent from @everyone hides the thread.
	srv := alice.Server()
	alice.Do(http.MethodPut, "/api/channels/"+general.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)
	bob.Fail(http.MethodGet, "/api/channels/"+thread.ID.String()+"/messages", nil, http.StatusNotFound, "NOT_FOUND")

	// No threads in threads.
	m := alice.Send(thread.ID, "y")
	alice.Fail(http.MethodPost, "/api/channels/"+thread.ID.String()+"/messages/"+m.ID.String()+"/thread", map[string]any{}, http.StatusBadRequest, "NO_THREADS_HERE")
}
```

`apptest.Client.Send` posts to any channel ID, threads included. If the welcome-channel or DM cases are easy to add, add them too: both return `NO_THREADS_HERE`.

- [ ] **Step 2: Run to verify they fail** — `go -C server test ./internal/messages/ -run TestThread`. Expected: compile errors.

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00017_threads.sql`:

```sql
-- +goose Up
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'welcome', 'dm', 'thread'));
ALTER TABLE channels
    ADD COLUMN parent_channel_id BIGINT REFERENCES channels (id) ON DELETE CASCADE,
    ADD COLUMN parent_message_id BIGINT REFERENCES messages (id) ON DELETE SET NULL,
    ADD COLUMN created_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
    ADD CONSTRAINT thread_has_parent CHECK ((type = 'thread') = (parent_channel_id IS NOT NULL));
CREATE UNIQUE INDEX channels_thread_message_idx ON channels (parent_message_id) WHERE type = 'thread';
CREATE INDEX channels_thread_parent_idx ON channels (parent_channel_id) WHERE type = 'thread';

-- +goose Down
DELETE FROM channels WHERE type = 'thread';
ALTER TABLE channels DROP CONSTRAINT thread_has_parent, DROP COLUMN created_by, DROP COLUMN parent_message_id, DROP COLUMN parent_channel_id;
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'welcome', 'dm'));
```

(The parent message's FK is `ON DELETE SET NULL`. Messages are only soft-deleted, so in practice the reference stays, and the thread shows "Original message deleted" because the parent row is marked deleted.)

- [ ] **Step 4: Channels** — in `channels.go`:
- `TypeThread = "thread"`; add `ParentChannelID` and `ParentMessageID` to `Channel`, with JSON tags as above.
- `channelCols` gains `parent_channel_id, parent_message_id`, and `scanChannel` reads them.
- `loadOverrides` skips threads, because they use the parent's overrides.
- Export `Get` as a wrapper for `get`.
- Exclude threads from `ListVisible` and `groupIDs` (`type <> 'thread'`).

Permissions through the parent:

```go
// permsIn returns userID's permissions in c. A thread uses its parent's.
func (s *Service) permsIn(ctx context.Context, userID id.ID, c *Channel) (perms.Perms, error) {
	if c.Type == TypeThread {
		parent, err := s.get(ctx, *c.ParentChannelID)
		if err != nil {
			return 0, err
		}
		return s.permsIn(ctx, userID, parent)
	}
	// … the existing DM and community logic …
}
```

`viewersOf` does the same: for a thread, return `viewersOf(parent)`.

`server/internal/channels/threads.go`:

```go
package channels

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/id"
)

// CreateThread starts the thread on a message, or returns the existing one.
func (s *Service) CreateThread(ctx context.Context, parent *Channel, messageID, creatorID id.ID, name string) (*Channel, bool, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Thread"
	}
	if r := []rune(name); len(r) > 100 {
		name = string(r[:100])
	}
	newID := id.New()
	tag, err := s.db.Exec(ctx, `
		INSERT INTO channels (id, community_id, type, name, position, parent_channel_id, parent_message_id, created_by)
		VALUES ($1, $2, 'thread', $3, 0, $4, $5, $6)
		ON CONFLICT (parent_message_id) WHERE type = 'thread' DO NOTHING`,
		newID, parent.CommunityID, name, parent.ID, messageID, creatorID)
	if err != nil {
		return nil, false, err
	}
	created := tag.RowsAffected() > 0
	var tid id.ID
	if err := s.db.QueryRow(ctx, `SELECT id FROM channels WHERE parent_message_id = $1 AND type = 'thread'`, messageID).Scan(&tid); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, ErrNotFound
		}
		return nil, false, err
	}
	c, err := s.get(ctx, tid)
	return c, created, err
}

// ThreadsOf lists a channel's threads.
func (s *Service) ThreadsOf(ctx context.Context, parentID id.ID) ([]Channel, error) {
	chs, err := s.query(ctx, `SELECT `+channelCols+` FROM channels WHERE parent_channel_id = $1 AND type = 'thread'`, parentID)
	if err != nil {
		return nil, err
	}
	out := make([]Channel, 0, len(chs))
	for _, c := range chs {
		out = append(out, *c)
	}
	return out, nil
}
```

Register `get-channel` in `handlers.go`: `GET /api/channels/{id}` returns the channel after `Access(…, ViewChannel)`.

- [ ] **Step 5: Messages** — `server/internal/messages/threads.go`:

```go
package messages

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type ThreadSummary struct {
	ID            id.ID             `json:"id"`
	Name          string            `json:"name"`
	MessageCount  int               `json:"message_count"`
	LastMessageAt *time.Time        `json:"last_message_at,omitempty"`
	Participants  []auth.PublicUser `json:"participants" doc:"Up to three of the first people who posted"`
}

type ThreadUpdate struct {
	ChannelID id.ID         `json:"channel_id" doc:"The parent channel"`
	MessageID id.ID         `json:"message_id" doc:"The parent message"`
	Thread    ThreadSummary `json:"thread"`
}

type ThreadListItem struct {
	Channel         channels.Channel `json:"channel"`
	ParentMessageID *id.ID           `json:"parent_message_id,omitempty"`
	Summary         ThreadSummary    `json:"summary"`
}

type CreateThreadRequest struct {
	Name string `json:"name,omitempty" maxLength:"100"`
}

// summaries computes thread summaries for threads keyed by thread ID.
func (s *Service) summaries(ctx context.Context, threads map[id.ID]string) (map[id.ID]*ThreadSummary, error) {
	out := map[id.ID]*ThreadSummary{}
	if len(threads) == 0 {
		return out, nil
	}
	ids := make([]id.ID, 0, len(threads))
	for tid, name := range threads {
		ids = append(ids, tid)
		out[tid] = &ThreadSummary{ID: tid, Name: name, Participants: []auth.PublicUser{}}
	}
	rows, err := s.db.Query(ctx, `
		SELECT channel_id, count(*) FILTER (WHERE NOT deleted), max(id) FILTER (WHERE NOT deleted),
		       (array_agg(author_id ORDER BY id) FILTER (WHERE NOT deleted))
		FROM messages WHERE channel_id = ANY($1) GROUP BY channel_id`, id.Int64s(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var authors []id.ID
	firstPosters := map[id.ID][]id.ID{}
	for rows.Next() {
		var tid id.ID
		var count int
		var last *int64
		var all []int64
		if err := rows.Scan(&tid, &count, &last, &all); err != nil {
			return nil, err
		}
		sm := out[tid]
		sm.MessageCount = count
		if last != nil {
			t := id.ID(*last).Time()
			sm.LastMessageAt = &t
		}
		seen := map[id.ID]bool{}
		for _, a := range all {
			if uid := id.ID(a); !seen[uid] && len(firstPosters[tid]) < 3 {
				seen[uid] = true
				firstPosters[tid] = append(firstPosters[tid], uid)
				authors = append(authors, uid)
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	users, err := s.users.PublicUsers(ctx, authors)
	if err != nil {
		return nil, err
	}
	for tid, us := range firstPosters {
		for _, u := range us {
			out[tid].Participants = append(out[tid].Participants, users[u])
		}
	}
	return out, nil
}

// withThreads fills Message.Thread for parent messages.
func (s *Service) withThreads(ctx context.Context, ms []Message) error {
	if len(ms) == 0 {
		return nil
	}
	ids := make([]id.ID, 0, len(ms))
	for _, m := range ms {
		ids = append(ids, m.ID)
	}
	rows, err := s.db.Query(ctx, `SELECT id, name, parent_message_id FROM channels WHERE type = 'thread' AND parent_message_id = ANY($1)`, id.Int64s(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	names := map[id.ID]string{}
	byParent := map[id.ID]id.ID{}
	for rows.Next() {
		var tid, pid id.ID
		var name string
		if err := rows.Scan(&tid, &name, &pid); err != nil {
			return err
		}
		names[tid] = name
		byParent[pid] = tid
	}
	if err := rows.Err(); err != nil {
		return err
	}
	sums, err := s.summaries(ctx, names)
	if err != nil {
		return err
	}
	for i := range ms {
		if tid, ok := byParent[ms[i].ID]; ok {
			ms[i].Thread = sums[tid]
		}
	}
	return nil
}

// publishThread sends THREAD_UPDATE for a thread channel to its parent channel.
func (s *Service) publishThread(ctx context.Context, thread *channels.Channel) {
	if thread.Type != channels.TypeThread || thread.ParentMessageID == nil {
		return
	}
	sums, err := s.summaries(ctx, map[id.ID]string{thread.ID: thread.Name})
	if err != nil {
		return
	}
	s.publish("THREAD_UPDATE", *thread.ParentChannelID,
		ThreadUpdate{ChannelID: *thread.ParentChannelID, MessageID: *thread.ParentMessageID, Thread: *sums[thread.ID]})
}

func registerThreads(api huma.API, s *Service, op func(string, string, string, int) huma.Operation, access accessFunc) {
	huma.Register(api, op("create-thread", http.MethodPost, "/api/channels/{id}/messages/{messageID}/thread", http.StatusCreated),
		func(ctx context.Context, in *struct {
			ID        string `path:"id"`
			MessageID string `path:"messageID"`
			Body      CreateThreadRequest
		}) (*struct {
			Status int
			Body   *channels.Channel
		}, error) {
			ch, _, err := access(ctx, in.ID, perms.CreateThreads|perms.SendMessages)
			if err != nil {
				return nil, err
			}
			if ch.Type != channels.TypeText && ch.Type != channels.TypeVoice {
				return nil, httpx.BadRequest("NO_THREADS_HERE", "threads can only be started in text and voice channels")
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			name := in.Body.Name
			if name == "" {
				name = firstLine(m.Content, 40)
			}
			thread, created, err := s.threads.CreateThread(ctx, ch, m.ID, auth.Current(ctx).User.ID, name)
			if err != nil {
				return nil, err
			}
			status := http.StatusOK
			if created {
				status = http.StatusCreated
				s.publishThread(ctx, thread)
			}
			return &struct {
				Status int
				Body   *channels.Channel
			}{status, thread}, nil
		})

	huma.Register(api, op("list-threads", http.MethodGet, "/api/channels/{id}/threads", 0),
		func(ctx context.Context, in *channelPath) (*struct{ Body []ThreadListItem }, error) {
			ch, _, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			list, err := s.threads.ThreadsOf(ctx, ch.ID)
			if err != nil {
				return nil, err
			}
			names := map[id.ID]string{}
			for _, t := range list {
				names[t.ID] = t.Name
			}
			sums, err := s.summaries(ctx, names)
			if err != nil {
				return nil, err
			}
			out := make([]ThreadListItem, 0, len(list))
			for _, t := range list {
				out = append(out, ThreadListItem{Channel: t, ParentMessageID: t.ParentMessageID, Summary: *sums[t.ID]})
			}
			sort.Slice(out, func(i, j int) bool {
				a, b := out[i].Summary.LastMessageAt, out[j].Summary.LastMessageAt
				switch {
				case a == nil && b == nil:
					return out[i].Channel.ID > out[j].Channel.ID
				case a == nil:
					return false
				case b == nil:
					return true
				}
				return a.After(*b)
			})
			return &struct{ Body []ThreadListItem }{out}, nil
		})
}

// firstLine returns the first line of s, cut to n runes ("Thread" if empty).
func firstLine(s string, n int) string {
	for i, r := range s {
		if r == '\n' {
			s = s[:i]
			break
		}
	}
	if r := []rune(s); len(r) > n {
		s = string(r[:n])
	}
	if s == "" {
		return "Thread"
	}
	return s
}
```

Wiring:
- Add `type Threads interface { CreateThread(...); ThreadsOf(...) }` to `messages` and a `threads Threads` field, set via `SetThreads` in `app.go` with `chanSvc`.
- `hydrate` calls `withThreads`.
- Register the routes.
- Huma's dynamic status: when a response struct has a `Status int` field, it is used as the status code. If that isn't supported, return 201 always and document it; the test then needs adjusting to 201 for the repeat call.
- After a send or delete in a channel whose `Type == channels.TypeThread`, call `s.publishThread(ctx, ch)`. The `access` helper already returns the channel.
- `registerEventSchemas` adds `messages.ThreadUpdate{}`.

- [ ] **Step 6: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...`. Expected: PASS. Make sure gateway fan-out for thread messages works: `channels.Viewers` resolves through the parent. The test's `ExpectDispatch` for bob proves it. `gofmt -l server` empty.

- [ ] **Step 7: Regenerate the API client** — `pnpm -C clients/core run gen`, from PowerShell with `$env:GOTOOLCHAIN='local'`. Only `openapi.json` and `schema.d.ts` change under `clients/`.

- [ ] **Step 8: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(threads): thread channels with summaries on the parent message`

---
### Task 4: Core client — categories, topics, pins, threads

**Files:**
- Modify: `clients/core/src/types.ts`, `store.ts`, `client.ts` and their tests

**Interfaces:**
- **Consumes:** the regenerated schema from Task 3 (`Category`, `CategoryDeleted`, `Channel.category_id`/`topic`/`parent_channel_id`/`parent_message_id`, `Message.pinned`/`pinned_at`/`thread`, `ThreadSummary`, `ThreadUpdate`, `ThreadListItem`, READY `server.categories`).
- **Types:** `Category`, `ThreadSummary`, `ThreadUpdate`, `ThreadListItem`. `EventMap` gains `CATEGORY_CREATE`, `CATEGORY_UPDATE`, `CATEGORY_DELETE` and `THREAD_UPDATE`.
- **Store:**
  - `ServerState.categories: Record<string, Category>`, filled from READY.
  - `CATEGORY_*` events keep it current. On `CATEGORY_DELETE`, channels in that category get `category_id` cleared; the server's `CHANNEL_UPDATE`s follow with the real positions.
  - `THREAD_UPDATE` sets `thread` on the parent message in `messages[channel_id]`, if loaded.
  - `CHANNEL_CREATE`/`CHANNEL_UPDATE` for a `thread` channel are stored in `channels` but never added to `server.channelIds`. The same applies to `setChannels`.
- **Selector:** `channelGroups(s): { uncategorised: string[]; categories: { category: Category; channelIds: string[] }[] }`. Visible channels are grouped and sorted by position; categories are sorted by position, and empty ones are included. It returns new objects, so call it with `useShallow` or `useMemo` over its inputs.
- **Client:**
  - `createCategory(name)`, `updateCategory(id, {name?, position?})`, `deleteCategory(id)`;
  - `moveChannel(id, {categoryId: string | null, position: number})`, which sends `category_id`, or `clear_category` when null, plus `position`;
  - `setTopic(id, topic)`;
  - `pin(channelId, messageId)`, `unpin(...)`, `listPins(channelId): Promise<Message[]>`;
  - `createThread(channelId, messageId, name?): Promise<Channel>`, which also stores the thread channel in `channels`;
  - `listThreads(channelId): Promise<ThreadListItem[]>`;
  - `getChannel(id): Promise<Channel>`, which stores the result.

- [ ] **Step 1: Write the failing tests** — add to `store.test.ts`:
- READY with two categories and channels assigned → `channelGroups` returns uncategorised `["welcome", "general"]`, then the categories in order with their channel IDs.
- `CATEGORY_DELETE` clears `category_id` on its channels.
- `CHANNEL_CREATE` of a `thread` channel does not change `server.channelIds`.
- `THREAD_UPDATE` sets `thread.message_count` on a loaded parent message and ignores unloaded channels.

Add to `client.test.ts`:
- `moveChannel("5", {categoryId: null, position: 2})` sends `{clear_category: true, position: 2}`.
- `pin("1","2")` sends PUT to `/api/channels/1/pins/2`.

- [ ] **Step 2: Run to verify they fail** — `pnpm -C clients/core exec vitest run`. Expected: FAIL.

- [ ] **Step 3: Implement** — `channelGroups`:

```ts
export function channelGroups(s: State): { uncategorised: string[]; categories: { category: Category; channelIds: string[] }[] } {
  const sv = s.server;
  if (!sv) return { uncategorised: [], categories: [] };
  const byPos = (a: string, b: string) => {
    const x = s.channels[a], y = s.channels[b];
    return Number(y?.type === "welcome") - Number(x?.type === "welcome") || (x?.position ?? 0) - (y?.position ?? 0) || compareIds(a, b);
  };
  const groups = new Map<string, string[]>();
  const uncategorised: string[] = [];
  for (const id of sv.channelIds) {
    const cat = s.channels[id]?.category_id;
    if (cat && sv.categories[cat]) (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(id);
    else uncategorised.push(id);
  }
  const categories = Object.values(sv.categories)
    .sort((a, b) => a.position - b.position || compareIds(a.id, b.id))
    .map((category) => ({ category, channelIds: (groups.get(category.id) ?? []).sort(byPos) }));
  return { uncategorised: uncategorised.sort(byPos), categories };
}
```

The remaining store and client changes follow the interface list above. For `THREAD_UPDATE`, use `updateMessages(s, d.channel_id, (items) => items.map((m) => (m.id === d.message_id ? { ...m, thread: d.thread } : m)))`.

- [ ] **Step 4: Run** — `pnpm -C clients/core exec vitest run`, `pnpm -C clients/core exec tsc --noEmit`, `pnpm -C clients/web run typecheck`. Fix web type errors only where the core shapes changed. Expected: PASS.

- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(core): categories, topics, pins and threads`

---

### Task 5: Web — sidebar categories, drag ordering, topics

**Files:**
- Create: `clients/web/src/app/sidebar/ChannelTree.tsx`, `clients/web/src/app/sidebar/CategoryHeader.tsx`, `clients/web/src/app/dialogs/CategoryDialog.tsx`, `clients/web/src/lib/collapsed.ts`, `clients/web/src/lib/collapsed.test.ts`
- Modify: `clients/web/package.json` (`@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2; **the controller installs them before dispatch**), `clients/web/src/app/ServerSidebar.tsx` (the channel list becomes `ChannelTree`; the header menu gains "Create category"), `clients/web/src/app/dialogs/CreateChannelDialog.tsx` (category select), `clients/web/src/app/dialogs/ChannelSettingsDialog.tsx` (topic `Textarea`, max 1024; category select), `clients/web/src/app/ChannelView.tsx` (topic in the header)

**Interfaces:**
- **Consumes:** Task 4 (`channelGroups`, `createCategory`, `updateCategory`, `deleteCategory`, `moveChannel`, `setTopic`).
- **Produces:**
  - `collapsed.ts`: `isCollapsed(id): boolean`, `setCollapsed(id, v): void` and `useCollapsed(id): [boolean, (v: boolean) => void]`, stored in `localStorage` under the key `datrope.collapsedCategories`. Every read and write is wrapped in try/catch, and a store failure falls back to in-memory state.
  - `ChannelTree`: the sidebar channel list.

Build from `Main.dc.html` (sidebar) with these rules:
- **Layout:**
  - Uncategorised channels come first, with no header; the welcome channel stays first.
  - Each category header is a small uppercase muted label with a chevron. Click or Enter toggles collapse. While collapsed, the category still shows any channel that has unread messages or is the current channel.
  - Hide empty categories from people without `MANAGE_CHANNELS`. People with it see empty categories, with a "Drop channels here" hint while dragging.
- **Category header menu** (`MANAGE_CHANNELS`): a `DropdownMenu` on hover with "Create channel" (preselects the category), "Rename category" (`CategoryDialog`) and "Delete category" (a confirm `Dialog`: "Its channels move out of the category.").
- **Drag and drop** (`MANAGE_CHANNELS` only), with dnd-kit:
  - Channels are sortable within and across groups; categories are sortable among themselves.
  - Use the keyboard sensor as well, so a focused row can be picked up with Space and moved with the arrow keys; dnd-kit's announcements give the screen-reader text.
  - On drop, call `moveChannel` / `updateCategory({position})` with the index in the target group, and update the store optimistically. On error, reload the channels (`client.loadChannels()`) and show `ErrorText` under the list for a few seconds.
  - The welcome channel is not draggable, and dropping above it is clamped below it.
- **Topic:** the channel header shows the topic after the channel name: muted, one line, truncated. Click opens a `Dialog` with the full topic rendered by `<Markdown>`, and an "Edit" button for `MANAGE_CHANNELS` that opens channel settings.
- **Accessible names:** category headers are buttons named `<Name>`, with `aria-expanded`; the menu trigger is "Category options"; dialogs use "Create category" / "Rename category" / "Delete category".

- [ ] **Step 1: Write the failing test** — `clients/web/src/lib/collapsed.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { isCollapsed, setCollapsed } from "./collapsed";

describe("collapsed categories", () => {
  beforeEach(() => localStorage.clear());

  it("remembers per category", () => {
    expect(isCollapsed("1")).toBe(false);
    setCollapsed("1", true);
    expect(isCollapsed("1")).toBe(true);
    expect(JSON.parse(localStorage.getItem("datrope.collapsedCategories")!)).toEqual(["1"]);
    setCollapsed("1", false);
    expect(isCollapsed("1")).toBe(false);
  });

  it("survives a broken store", () => {
    localStorage.setItem("datrope.collapsedCategories", "{not json");
    expect(isCollapsed("1")).toBe(false);
    setCollapsed("2", true);
    expect(isCollapsed("2")).toBe(true);
  });
});
```

If vitest runs in the `node` environment, add `// @vitest-environment jsdom` at the top of the file only if `jsdom` is already installed. Otherwise stub `localStorage` with a tiny in-memory object in the test.

- [ ] **Step 2: Run to verify it fails** — `pnpm -C clients/web exec vitest run src/lib/collapsed.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `collapsed.ts` and the UI above. Keep every behaviour the sidebar has today: unread state, voice members under voice channels, the channel settings gear, active channel highlight, the gate.

- [ ] **Step 4: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS.

- [ ] **Step 5: Checkpoint** — stop. The controller reviews and checks in the browser: create a category, drag channels into it and reorder, collapse and reload, rename and delete, set a topic. Then it stages. Suggested message: `feat(web): channel categories with drag ordering, and topics`

---

### Task 6: Web — pins

**Files:**
- Create: `clients/web/src/app/PinsPanel.tsx`
- Modify: `clients/web/src/app/MessageToolbar.tsx` ("Pin message" / "Unpin message"), `clients/web/src/app/ChannelView.tsx` (the header button "Pinned messages" opens the panel)

**Interfaces:**
- **Consumes:** Task 4 (`pin`, `unpin`, `listPins`, `Message.pinned`).
- **Produces:** `<PinsPanel channelId onJump(messageId) />`.

**Behaviour:**
- The header's "Pinned messages" icon button (lucide `Pin`) opens a shadcn `Popover`, about 420 px wide and up to 60 vh tall, scrolling. It lists pinned messages, newest pin first: author, time, the Markdown body, attachments as file chips, and a "Jump" button. The jump uses Task 7 of M5's `jumpTo`, which loads older pages when needed.
- "Unpin" icon buttons are shown with `MANAGE_MESSAGES`, or in DMs.
- Empty state: "No pinned messages yet."
- The list reloads when the panel opens, and when a `MESSAGE_UPDATE` changes `pinned` for this channel while it is open. Subscribe with `client.onEvent`.
- **Toolbar:** "Pin message" or "Unpin message", per the message's `pinned`, with the same permission rule. A pinned message shows a small pin icon next to its time (`aria-label="Pinned"`).
- **Errors:** `PIN_LIMIT` and others show via `ErrorText` in the row.

- [ ] **Step 1: Build** the above.
- [ ] **Step 2: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS.
- [ ] **Step 3: Checkpoint** — stop. The controller reviews and checks in the browser, then stages. Suggested message: `feat(web): pinned messages`

---

### Task 7: Web — threads and the voice channel side chat

**Files:**
- Create: `clients/web/src/app/side-panel/SidePanel.tsx` (shell), `clients/web/src/app/side-panel/ThreadPanel.tsx`, `clients/web/src/app/side-panel/ThreadsList.tsx`, `clients/web/src/app/ThreadSummary.tsx`
- Modify: `clients/web/src/app/ChannelView.tsx` (side-panel state: none, thread `{threadId}` or threads list; the header "Threads" button), `clients/web/src/app/MessageList.tsx` (`ThreadSummary` under messages that have `thread`), `clients/web/src/app/MessageToolbar.tsx` ("Create thread", or "Open thread" when one exists), `clients/web/src/app/voice/VoiceChannelView.tsx` (header "Channel chat" toggles a `SidePanel` with the voice channel's own `MessageList` + `Composer`)

**Interfaces:**
- **Consumes:** Task 4 (`createThread`, `listThreads`, `getChannel`, `Message.thread`, the `THREAD_UPDATE` store handling); M5 `MessageList` / `Composer` (they take a `channelId`, so they work for a thread or voice channel unchanged); `client.loadOlder` and `ack` for the panel's channel.
- **Produces:** `<SidePanel title subtitle onClose children />`, an `aside` with `aria-label` = title, the card surface, a left border and 340–380 px width, as in `Main.dc.html`. Also `<ThreadPanel threadId parentChannelId onClose />`.

Build from `Main.dc.html` (the Thread aside) and `VoiceStage.dc.html` ("Channel chat"):
- **Thread summary** (under a parent message): up to 3 participant initials, then "N replies" (primary, semibold) or "Open thread" when there are 0, and "Last reply <relative time>". It is a link-style button that opens the thread panel.
- **ThreadPanel:**
  - Header "Thread", with the subtitle "in #<parent>" and "Close thread".
  - The parent message on top, rendered with `<Markdown>`. If it is deleted, or not loaded and not fetchable, show "Original message deleted". Below that, a divider "N replies".
  - The thread's `MessageList` (no "Reply" or "Create thread" actions inside a thread; reactions and edit/delete still work) and a `Composer` with the placeholder and label "Reply in thread".
  - The panel loads the thread with `client.getChannel(threadId)` if it is not in the store, and messages with `loadOlder`.
- **Create thread:** the toolbar action (needs `CREATE_THREADS` + `SEND_MESSAGES`; text channels only, never in DMs, threads or voice side chats) calls `client.createThread` and opens the panel.
- **Threads list:** the header "Threads" button opens `ThreadsList` in the side panel. It shows threads by recent activity, each with its name, the summary line and a click to open; empty state "No threads yet."
- **Voice side chat:** in `VoiceChannelView`, the header "Channel chat" toggle opens a `SidePanel` titled "Chat", with the subtitle `#<voice channel name>`, its `MessageList` and a `Composer` labelled "Message #<name>". The side chat is not available while the user can't read the channel.
- **Panel layout:** only one side panel at a time per view; opening another replaces it. The panel closes on channel change. On narrow screens (under 900 px) the panel overlays the message list. The member list hides while a side panel is open, as in the mockup.

- [ ] **Step 1: Build** the above.
- [ ] **Step 2: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS.
- [ ] **Step 3: Checkpoint** — stop. The controller reviews and checks in the browser: create a thread, reply, see the summary update live, open it from the Threads list, and chat in a voice channel. Then it stages. Suggested message: `feat(web): threads in a side panel and voice channel chat`

---

### Task 8: Web — "New messages" line and jump to first unread

**Files:**
- Create: `clients/web/src/app/unread.ts`, `clients/web/src/app/unread.test.ts`
- Modify: `clients/web/src/app/MessageList.tsx` (divider, jump bar, marking read)

**Interfaces:**
- **Consumes:** `state.readStates[channelId].lastReadId` and `lastMessageId`, `client.ack`, `client.loadOlder`, `jumpTo` (M5).
- **Produces:** `firstUnreadIndex(items: { id: string; author: { id: string }; pending?: boolean }[], lastReadId: string | undefined, meId: string | undefined): number`. It returns the index of the first non-pending message with `compareIds(id, lastReadId) > 0` whose author is not me, or -1. When `lastReadId` is undefined, every message is unread and the result is the first not-mine.

**Behaviour:**
- When a channel is opened, `MessageList` captures `lastReadId` once, as a snapshot per mount. The divider uses that snapshot, so acking does not move it. The divider is the mockup's red "New messages" line, in the destructive colour, inserted before `firstUnreadIndex`.
- **Jump bar:** if the divider row is above the viewport, or the first unread message is older than the loaded page (`lastReadId` is older than the oldest loaded message and `hasMore`), show a bar pinned to the top of the list: "New messages since <time>", with "Jump to first unread" and "Mark as read" buttons.
  - "Jump" loads older pages until the first unread message is loaded (at most 5 pages; otherwise it scrolls to the oldest loaded message), then scrolls to the divider.
  - "Mark as read" acks the newest message and hides the bar and the divider.
- **Opening a channel with unread messages** scrolls so the divider is near the top, instead of to the bottom. With no unread messages, it scrolls to the bottom as today.
- **Marking read** happens when the bottom of the list is visible (an IntersectionObserver on the bottom sentinel) and the window has focus. This replaces any existing "ack on new message" logic only if that logic acks while scrolled up. Keep acking own messages.
- **New messages arriving** while you are at the bottom keep you at the bottom; while scrolled up, they don't move you.

- [ ] **Step 1: Write the failing test** — `clients/web/src/app/unread.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { firstUnreadIndex } from "./unread";

const m = (id: string, author = "2", pending = false) => ({ id, author: { id: author }, pending });

describe("firstUnreadIndex", () => {
  it.each([
    [[m("10"), m("11"), m("12")], "10", "1", 1],
    [[m("10"), m("11", "1"), m("12")], "10", "1", 2], // my own message is not "new"
    [[m("10"), m("11")], "11", "1", -1],
    [[m("10"), m("11")], undefined, "1", 0],
    [[m("9"), m("100")], "99", "1", 1], // numeric order, not string order
    [[m("10"), m("11", "2", true)], "10", "1", -1], // pending is ignored
  ])("case %#", (items, lastRead, me, want) => {
    expect(firstUnreadIndex(items, lastRead as string | undefined, me)).toBe(want);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm -C clients/web exec vitest run src/app/unread.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `unread.ts` (using core's `compareIds`) and the behaviour above.
- [ ] **Step 4: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS.
- [ ] **Step 5: Checkpoint** — stop. The controller reviews and checks in the browser: send messages from another account while away, then come back and see the divider and the jump bar. Then it stages. Suggested message: `feat(web): new messages line and jump to first unread`

---

### Task 9: End-to-end test and docs

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts`, `deploy/README.md` (features)

- [ ] **Step 1: Extend the e2e** — after the M5 part:
  1. Alice creates the category "Hangouts" from the header menu ("Create category") and moves `#general` into it. Use channel settings' category select rather than a drag, for reliability. Both browsers show `#general` under "Hangouts".
  2. Alice sets the topic of `#general` to "Plans and memes". The header shows it.
  3. Alice hovers bob's "me!" message, clicks "Create thread", and replies "pizza at 7?" in the panel ("Reply in thread"). Bob sees "1 reply" under the message, opens it, and sees alice's reply; bob answers "deal". Alice sees "2 replies".
  4. Alice pins "who wants pizza? @bob" ("Pin message"). Bob opens "Pinned messages" and sees it.

  Keep the earlier parts working.
- [ ] **Step 2: Run** — the `datrope-e2e` stack as in M5 Task 10. While the dev LiveKit runs, use the port override: a scratchpad copy of `compose.local-ports.yml`, which moves LiveKit to 17881/17882. Run `pnpm --filter @datrope/web e2e`, then `down -v`. Never touch other containers or the user's dev servers. Expected: PASS.
- [ ] **Step 3: Docs** — `deploy/README.md` features: categories, topics, pins, threads, voice channel chat, the unread line.
- [ ] **Step 4: Full verification** — Go vet and test (PowerShell), `gofmt`, core vitest, web vitest, web build, e2e. Expected: all PASS.
- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `test(e2e): categories, topics, threads and pins; docs`
