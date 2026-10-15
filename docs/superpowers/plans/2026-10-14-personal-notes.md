# Personal Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Private, server-synced, rich-text notes per user at `/notes`, reached from a third sidebar tab (desktop) and the You page (phones).

**Architecture:** New Go domain `server/internal/notes` (raw pgx + huma, owner-only, events scoped to the owner's sessions) on a new `notes` table. Core client gets typed methods from the regenerated OpenAPI schema. The web feature lives in `clients/web/src/app/notes/`: pure model (reducers, helpers), a zustand store fed by `client.onEvent`, an autosaver, a Tiptap v3 editor, and the views.

**Tech Stack:** Go 1.25, huma/v2, pgx/v5, goose, testify + apptest (testcontainers, needs Docker); React 18, react-router v6, zustand, shadcn/ui, Tailwind v4, Tiptap 3.32.0, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-personal-notes-design.md`

## Global Constraints

- Never commit, push, amend, tag or merge: the user commits. "Checkpoint" steps below only run the checks.
- Migration number `00046` (renumbered from 00043 at merge); may collide with sibling branches. Renumber at merge.
- JSON field names are snake_case (`updated_at`, `created_at`).
- Limits: 500 notes per user; title ≤100 runes (trimmed); content JSON ≤200 KB; text ≤200 KB; preview = first 140 runes of text, whitespace collapsed; `q` ≤100 runes.
- Another user's note → `404 NOT_FOUND` via `httpx.NotFound("note")`.
- Error codes: `NOTE_TITLE_TOO_LONG`, `NOTE_INVALID_CONTENT`, `NOTE_TOO_LARGE`, `NOTE_LIMIT`.
- Events `NOTE_CREATE` (NoteSummary), `NOTE_UPDATE` (Note), `NOTE_DELETE` (`{id}`), `Scope{UserIDs: []id.ID{me}}`.
- Tiptap packages pinned exactly at `3.32.0`.
- UI: shadcn components from `src/components/ui/`; tokens only (no hex in components); dark-only (no `dark:`); `cn()` from `@/lib/utils`; `@/` imports; stable accessible names.
- Autosave debounce 800 ms; flush on blur, route change, unmount.
- Prefix shell commands with `rtk` (user's global rule).

## Review Focus

1. **Typing fast, then navigating to another note within 800 ms**: the pending save must flush to the *old* note, never to the new one. Test: Task 4 `flush on switch` test.
2. **Remote NOTE_UPDATE while typing**: must not replace the editor's content. Test: Task 3 `keeps dirty note` reducer test.
3. **Search with `%`, `_` or `\`**: literal match, not wildcard. Test: Task 1 `TestNoteSearch`.
4. **Empty/whitespace title**: stored as `""`, shown as "Untitled" in list and top bar. Test: Task 1 create with `"   "` title; Task 3 `displayTitle` test.
5. **Note deleted on another device while open**: open view leaves to `/notes`; a later save 404 drops local edits without an error loop. Test: Task 3 `NOTE_DELETE removes` + Task 4 `404 stops` test.

---

### Task 1: Server notes domain

**Files:**
- Create: `server/internal/db/migrations/00046_notes.sql`
- Create: `server/internal/notes/notes.go`
- Create: `server/internal/notes/handlers.go`
- Create: `server/internal/notes/notes_test.go`
- Modify: `server/internal/app/app.go` (next to `albums.Register`, ~line 236)

**Interfaces:**
- Produces HTTP: `GET /api/notes?q=` → `[]NoteSummary`; `POST /api/notes` (201) → `Note`; `GET|PATCH /api/notes/{noteID}` → `Note`; `DELETE /api/notes/{noteID}` (204). OperationIDs: `list-notes`, `create-note`, `get-note`, `update-note`, `delete-note`.
- Produces Go types (schema names): `NoteSummary`, `Note`, `NoteCreate`, `NoteUpdate`, `NoteDeleted`.

- [ ] **Step 1: Migration**

```sql
-- +goose Up
-- Personal notes: private rich-text notes, visible only to their owner (spec: personal notes).
CREATE TABLE notes (
    id         BIGINT PRIMARY KEY, -- snowflake; created_at is its time
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    content    JSONB NOT NULL,     -- Tiptap/ProseMirror doc
    text       TEXT NOT NULL DEFAULT '', -- plain text of content, sent by the client, for previews and search
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notes_user_idx ON notes (user_id, updated_at DESC);

-- +goose Down
DROP TABLE notes;
```

- [ ] **Step 2: Write the failing tests** (`notes_test.go`)

```go
package notes_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/notes"
)

func doc(text string) map[string]any {
	return map[string]any{"type": "doc", "content": []any{
		map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": text}}},
	}}
}

func create(t *testing.T, c *apptest.Client, title, text string) notes.Note {
	t.Helper()
	var n notes.Note
	c.Do(http.MethodPost, "/api/notes", map[string]any{"title": title, "content": doc(text), "text": text}, http.StatusCreated, &n)
	return n
}

func list(t *testing.T, c *apptest.Client, q string) []notes.NoteSummary {
	t.Helper()
	var out []notes.NoteSummary
	path := "/api/notes"
	if q != "" {
		path += "?q=" + q
	}
	c.Do(http.MethodGet, path, nil, http.StatusOK, &out)
	return out
}

func titles(ns []notes.NoteSummary) []string {
	out := []string{}
	for _, n := range ns {
		out = append(out, n.Title)
	}
	return out
}

func TestNoteCRUD(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")

	var blank notes.Note
	alice.Do(http.MethodPost, "/api/notes", map[string]any{"title": "   "}, http.StatusCreated, &blank)
	require.Equal(t, "", blank.Title)
	require.Equal(t, "doc", blank.Content["type"], "missing content becomes an empty doc")
	require.Equal(t, blank.ID.Time().UnixMilli(), blank.CreatedAt.UnixMilli())

	a := create(t, alice, " Raid ", "tank: kalle\n\n  healer   x2")
	require.Equal(t, "Raid", a.Title)
	require.Equal(t, []string{"Raid", ""}, titles(list(t, alice, "")), "newest first")
	require.Equal(t, "tank: kalle healer x2", list(t, alice, "")[0].Preview)

	path := "/api/notes/" + a.ID.String()
	var got notes.Note
	alice.Do(http.MethodGet, path, nil, http.StatusOK, &got)
	require.Equal(t, a.Text, got.Text)

	time.Sleep(5 * time.Millisecond)
	alice.Do(http.MethodPatch, "/api/notes/"+blank.ID.String(), map[string]any{"title": "Movies"}, http.StatusOK, &got)
	require.Equal(t, "Movies", got.Title)
	require.True(t, got.UpdatedAt.After(blank.UpdatedAt))
	require.Equal(t, []string{"Movies", "Raid"}, titles(list(t, alice, "")), "an edit moves it to the top")

	alice.Do(http.MethodPatch, path, map[string]any{"content": doc("long"), "text": "long"}, http.StatusOK, &got)
	require.Equal(t, "long", got.Text)
	require.Equal(t, "Raid", got.Title, "title kept when not sent")

	alice.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodGet, path, nil, http.StatusNotFound, "NOT_FOUND")
	require.Equal(t, []string{"Movies"}, titles(list(t, alice, "")))
}

func TestNotesArePrivate(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	a := create(t, alice, "secret", "shh")
	path := "/api/notes/" + a.ID.String()

	require.Empty(t, list(t, bob, ""))
	bob.Fail(http.MethodGet, path, nil, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodPatch, path, map[string]any{"title": "mine"}, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodDelete, path, nil, http.StatusNotFound, "NOT_FOUND")
	require.Equal(t, []string{"secret"}, titles(list(t, alice, "")))
}

func TestNoteValidation(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	a := create(t, alice, "ok", "")
	path := "/api/notes/" + a.ID.String()

	alice.Fail(http.MethodPost, "/api/notes", map[string]any{"title": strings.Repeat("é", 101)}, http.StatusBadRequest, "NOTE_TITLE_TOO_LONG")
	alice.Do(http.MethodPost, "/api/notes", map[string]any{"title": strings.Repeat("é", 100)}, http.StatusCreated, nil)
	alice.Fail(http.MethodPatch, path, map[string]any{"content": map[string]any{"type": "paragraph"}, "text": ""}, http.StatusBadRequest, "NOTE_INVALID_CONTENT")
	alice.Fail(http.MethodPatch, path, map[string]any{"content": doc("x")}, http.StatusBadRequest, "NOTE_INVALID_CONTENT")
	alice.Fail(http.MethodPatch, path, map[string]any{"text": "x"}, http.StatusBadRequest, "NOTE_INVALID_CONTENT")
	big := strings.Repeat("a", 200*1024+1)
	alice.Fail(http.MethodPatch, path, map[string]any{"content": doc(big), "text": "a"}, http.StatusBadRequest, "NOTE_TOO_LARGE")
	alice.Fail(http.MethodPatch, path, map[string]any{"content": doc("a"), "text": big}, http.StatusBadRequest, "NOTE_TOO_LARGE")
}

func TestNoteLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	for i := 0; i < 500; i++ {
		alice.Do(http.MethodPost, "/api/notes", map[string]any{}, http.StatusCreated, nil)
	}
	alice.Fail(http.MethodPost, "/api/notes", map[string]any{}, http.StatusBadRequest, "NOTE_LIMIT")
}

func TestNoteSearch(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	create(t, alice, "Raid roster", "tank kalle")
	create(t, alice, "Movies", "Dune, ARRIVAL")
	create(t, alice, "Percent", "100% sure")
	create(t, alice, "Plain", "100 sure")

	require.Equal(t, []string{"Raid roster"}, titles(list(t, alice, "raid")))
	require.Equal(t, []string{"Movies"}, titles(list(t, alice, "arrival")), "text, case-insensitive")
	require.Equal(t, []string{"Percent"}, titles(list(t, alice, "100%25")), "% is literal")
	require.Empty(t, list(t, alice, "_ure"), "_ is literal")
}

func TestNoteEventsReachOnlyTheOwner(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	aws, _ := alice.Connect()
	bws, _ := bob.Connect()

	a := create(t, alice, "n", "")
	var sum notes.NoteSummary
	aws.ExpectDispatch("NOTE_CREATE", &sum)
	require.Equal(t, a.ID, sum.ID)

	alice.Do(http.MethodPatch, "/api/notes/"+a.ID.String(), map[string]any{"title": "m"}, http.StatusOK, nil)
	var upd notes.Note
	aws.ExpectDispatch("NOTE_UPDATE", &upd)
	require.Equal(t, "m", upd.Title)

	alice.Do(http.MethodDelete, "/api/notes/"+a.ID.String(), nil, http.StatusNoContent, nil)
	var del notes.NoteDeleted
	aws.ExpectDispatch("NOTE_DELETE", &del)
	require.Equal(t, a.ID, del.ID)

	bws.ExpectNoDispatch("NOTE_CREATE", 200*time.Millisecond)
	bws.ExpectNoDispatch("NOTE_UPDATE", 100*time.Millisecond)
	bws.ExpectNoDispatch("NOTE_DELETE", 100*time.Millisecond)
}
```

- [ ] **Step 3: Run to verify failure**

Run: `rtk go -C server test ./internal/notes/...`
Expected: FAIL (package `notes` has no non-test Go files / undefined types).

- [ ] **Step 4: Implement `notes.go`**

```go
// Package notes is personal notes: private rich-text notes only their owner sees (spec: personal notes).
package notes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

const (
	maxNotes     = 500
	maxTitle     = 100
	maxBytes     = 200 * 1024
	maxQuery     = 100
	previewRunes = 140
)

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// NoteSummary is a note in the list.
type NoteSummary struct {
	ID        id.ID     `json:"id"`
	Title     string    `json:"title"`
	Preview   string    `json:"preview" doc:"The start of the note's text"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Note is a whole note; it is also the NOTE_UPDATE event.
type Note struct {
	ID        id.ID          `json:"id"`
	Title     string         `json:"title"`
	Content   map[string]any `json:"content" doc:"A Tiptap (ProseMirror) document"`
	Text      string         `json:"text" doc:"The plain text of content"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// NoteDeleted is the NOTE_DELETE event.
type NoteDeleted struct {
	ID id.ID `json:"id"`
}

type NoteCreate struct {
	Title   *string        `json:"title,omitempty"`
	Content map[string]any `json:"content,omitempty" doc:"Sent together with text"`
	Text    *string        `json:"text,omitempty" doc:"Sent together with content"`
}

type NoteUpdate struct {
	Title   *string        `json:"title,omitempty"`
	Content map[string]any `json:"content,omitempty" doc:"Sent together with text"`
	Text    *string        `json:"text,omitempty" doc:"Sent together with content"`
}

type Service struct {
	db  *pgxpool.Pool
	bus *events.Bus
}

func NewService(pool *pgxpool.Pool, bus *events.Bus) *Service {
	return &Service{db: pool, bus: bus}
}

var emptyDoc = []byte(`{"type":"doc","content":[{"type":"paragraph"}]}`)

// fields is a validated create or update body; nil means "not sent".
type fields struct {
	title   *string
	content []byte
	text    *string
}

func validate(title *string, content map[string]any, text *string) (fields, error) {
	var f fields
	if title != nil {
		t := strings.TrimSpace(*title)
		if utf8.RuneCountInString(t) > maxTitle {
			return f, httpx.BadRequest("NOTE_TITLE_TOO_LONG", fmt.Sprintf("a title has at most %d characters", maxTitle))
		}
		f.title = &t
	}
	if (content == nil) != (text == nil) {
		return f, httpx.BadRequest("NOTE_INVALID_CONTENT", "content and text are sent together")
	}
	if content == nil {
		return f, nil
	}
	if content["type"] != "doc" {
		return f, httpx.BadRequest("NOTE_INVALID_CONTENT", "content must be a document")
	}
	b, err := json.Marshal(content)
	if err != nil {
		return f, httpx.BadRequest("NOTE_INVALID_CONTENT", "content must be a document")
	}
	if len(b) > maxBytes || len(*text) > maxBytes {
		return f, httpx.BadRequest("NOTE_TOO_LARGE", "the note is too long")
	}
	f.content, f.text = b, text
	return f, nil
}

func preview(text string) string {
	s := strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(s) <= previewRunes {
		return s
	}
	return string([]rune(s)[:previewRunes])
}

func (s *Service) list(ctx context.Context, userID id.ID, q string) ([]NoteSummary, error) {
	q = strings.TrimSpace(q)
	if utf8.RuneCountInString(q) > maxQuery {
		q = string([]rune(q)[:maxQuery])
	}
	rows, err := s.db.Query(ctx, `SELECT id, title, text, updated_at FROM notes
		WHERE user_id = $1 AND ($2 = '' OR title ILIKE '%' || $2 || '%' OR text ILIKE '%' || $2 || '%')
		ORDER BY updated_at DESC, id DESC`, userID, likeEscaper.Replace(q))
	if err != nil {
		return nil, err
	}
	out := []NoteSummary{}
	for rows.Next() {
		var n NoteSummary
		var text string
		if err := rows.Scan(&n.ID, &n.Title, &text, &n.UpdatedAt); err != nil {
			return nil, err
		}
		n.Preview = preview(text)
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *Service) get(ctx context.Context, userID, noteID id.ID) (*Note, error) {
	var n Note
	var content []byte
	err := s.db.QueryRow(ctx, `SELECT id, title, content, text, updated_at FROM notes WHERE id = $1 AND user_id = $2`, noteID, userID).
		Scan(&n.ID, &n.Title, &content, &n.Text, &n.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("note")
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(content, &n.Content); err != nil {
		return nil, err
	}
	n.CreatedAt = n.ID.Time()
	return &n, nil
}

func (s *Service) create(ctx context.Context, userID id.ID, in NoteCreate) (*Note, error) {
	f, err := validate(in.Title, in.Content, in.Text)
	if err != nil {
		return nil, err
	}
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM notes WHERE user_id = $1`, userID).Scan(&count); err != nil {
		return nil, err
	}
	if count >= maxNotes {
		return nil, httpx.BadRequest("NOTE_LIMIT", fmt.Sprintf("you have the most notes you can have (%d)", maxNotes))
	}
	title, content, text := "", emptyDoc, ""
	if f.title != nil {
		title = *f.title
	}
	if f.content != nil {
		content, text = f.content, *f.text
	}
	nid := id.New()
	if _, err := s.db.Exec(ctx, `INSERT INTO notes (id, user_id, title, content, text) VALUES ($1, $2, $3, $4, $5)`,
		nid, userID, title, content, text); err != nil {
		return nil, err
	}
	n, err := s.get(ctx, userID, nid)
	if err != nil {
		return nil, err
	}
	s.publish(userID, "NOTE_CREATE", NoteSummary{ID: n.ID, Title: n.Title, Preview: preview(n.Text), UpdatedAt: n.UpdatedAt})
	return n, nil
}

func (s *Service) update(ctx context.Context, userID, noteID id.ID, in NoteUpdate) (*Note, error) {
	f, err := validate(in.Title, in.Content, in.Text)
	if err != nil {
		return nil, err
	}
	tag, err := s.db.Exec(ctx, `UPDATE notes SET title = coalesce($3, title), content = coalesce($4, content),
		text = coalesce($5, text), updated_at = now() WHERE id = $1 AND user_id = $2`, noteID, userID, f.title, f.content, f.text)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, httpx.NotFound("note")
	}
	n, err := s.get(ctx, userID, noteID)
	if err != nil {
		return nil, err
	}
	s.publish(userID, "NOTE_UPDATE", n)
	return n, nil
}

func (s *Service) delete(ctx context.Context, userID, noteID id.ID) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM notes WHERE id = $1 AND user_id = $2`, noteID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("note")
	}
	s.publish(userID, "NOTE_DELETE", NoteDeleted{ID: noteID})
	return nil
}

// publish reaches every session of the owner, so their other devices stay current.
func (s *Service) publish(userID id.ID, typ string, data any) {
	s.bus.Publish(events.Event{Type: typ, Data: data, Scope: events.Scope{UserIDs: []id.ID{userID}}})
}
```

Note: `content` with a nil `[]byte` passed to `coalesce($4, content)` must arrive as SQL NULL. pgx encodes a nil `[]byte` as NULL; if the JSONB parameter type complains, cast with `$4::jsonb`.

- [ ] **Step 5: Implement `handlers.go`**

```go
package notes

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type notePath struct {
	NoteID string `path:"noteID"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"notes"}
	op := func(oid, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: oid, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	me := func(ctx context.Context) id.ID { return auth.Current(ctx).User.ID }

	huma.Register(api, op("list-notes", http.MethodGet, "/api/notes", 0),
		func(ctx context.Context, in *struct {
			Q string `query:"q" doc:"Only notes whose title or text contains this"`
		}) (*struct{ Body []NoteSummary }, error) {
			out, err := s.list(ctx, me(ctx), in.Q)
			return &struct{ Body []NoteSummary }{out}, err
		})

	huma.Register(api, op("create-note", http.MethodPost, "/api/notes", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body NoteCreate }) (*struct{ Body *Note }, error) {
			n, err := s.create(ctx, me(ctx), in.Body)
			return &struct{ Body *Note }{n}, err
		})

	huma.Register(api, op("get-note", http.MethodGet, "/api/notes/{noteID}", 0),
		func(ctx context.Context, in *notePath) (*struct{ Body *Note }, error) {
			nid, err := httpx.ParseID(in.NoteID, "note")
			if err != nil {
				return nil, err
			}
			n, err := s.get(ctx, me(ctx), nid)
			return &struct{ Body *Note }{n}, err
		})

	huma.Register(api, op("update-note", http.MethodPatch, "/api/notes/{noteID}", 0),
		func(ctx context.Context, in *struct {
			NoteID string `path:"noteID"`
			Body   NoteUpdate
		}) (*struct{ Body *Note }, error) {
			nid, err := httpx.ParseID(in.NoteID, "note")
			if err != nil {
				return nil, err
			}
			n, err := s.update(ctx, me(ctx), nid, in.Body)
			return &struct{ Body *Note }{n}, err
		})

	huma.Register(api, op("delete-note", http.MethodDelete, "/api/notes/{noteID}", http.StatusNoContent),
		func(ctx context.Context, in *notePath) (*struct{}, error) {
			nid, err := httpx.ParseID(in.NoteID, "note")
			if err != nil {
				return nil, err
			}
			return nil, s.delete(ctx, me(ctx), nid)
		})
}
```

If huma rejects an empty POST body `{}` for `create-note`, add `RequestBody: &huma.RequestBody{Required: false}` handling the same way as another optional-body operation in the codebase (grep `Required: false`).

- [ ] **Step 6: Wire in `app.go`** right after `albums.Register(api, albumSvc)`:

```go
	notes.Register(api, notes.NewService(pool, a.Bus))
```

and add the import `"github.com/datrope/datrope/server/internal/notes"`.

- [ ] **Step 7: Run tests**

Run: `rtk go -C server test ./internal/notes/...` → PASS. Then `rtk go -C server vet ./...` and `rtk go -C server test ./internal/app/...` → PASS.

- [ ] **Step 8: Checkpoint** (no commit): `rtk git status` shows only the five files above.

---

### Task 2: Core client and schema

**Files:**
- Modify (generated): `clients/core/openapi.json`, `clients/core/src/schema.d.ts`
- Modify: `clients/core/src/types.ts` (type exports near line 86; event map near line 128)
- Modify: `clients/core/src/client.ts` (after the playlist methods, ~line 410)

**Interfaces:**
- Consumes: Task 1 operations.
- Produces: `type NoteSummary`, `type Note`; event map entries `NOTE_CREATE: NoteSummary`, `NOTE_UPDATE: Note`, `NOTE_DELETE: Schemas["NoteDeleted"]`; client methods:
  - `listNotes(q?: string): Promise<NoteSummary[]>`
  - `createNote(body?: { title?: string; content?: Record<string, unknown>; text?: string }): Promise<Note>`
  - `getNote(noteId: string): Promise<Note>`
  - `updateNote(noteId: string, body: { title?: string; content?: Record<string, unknown>; text?: string }): Promise<Note>`
  - `deleteNote(noteId: string): Promise<void>`

- [ ] **Step 1: Regenerate**: `rtk pnpm -C clients/core gen`. Expected: `schema.d.ts` gains `NoteSummary`, `Note`, `NoteCreate`, `NoteUpdate`, `NoteDeleted` and `/api/notes` paths.

- [ ] **Step 2: Types** in `types.ts`:

```ts
export type NoteSummary = Schemas["NoteSummary"];
export type Note = Schemas["Note"];
```

and in the event map after `WATCH_UPDATE`:

```ts
  NOTE_CREATE: NoteSummary;
  NOTE_UPDATE: Note;
  NOTE_DELETE: Schemas["NoteDeleted"];
```

- [ ] **Step 3: Client methods** in `client.ts` (import `Note`, `NoteSummary` from `./types`):

```ts
  /** My notes, newest first; q filters on title and text. Events (NOTE_*) keep a loaded list current. */
  async listNotes(q?: string): Promise<NoteSummary[]> {
    return (await unwrap(this.api.GET("/api/notes", { params: { query: q ? { q } : {} } }))) ?? [];
  }

  async createNote(body: { title?: string; content?: Record<string, unknown>; text?: string } = {}): Promise<Note> {
    return unwrap(this.api.POST("/api/notes", { body }));
  }

  async getNote(noteId: string): Promise<Note> {
    return unwrap(this.api.GET("/api/notes/{noteID}", { params: { path: { noteID: noteId } } }));
  }

  async updateNote(noteId: string, body: { title?: string; content?: Record<string, unknown>; text?: string }): Promise<Note> {
    return unwrap(this.api.PATCH("/api/notes/{noteID}", { params: { path: { noteID: noteId } }, body }));
  }

  async deleteNote(noteId: string) {
    await unwrap(this.api.DELETE("/api/notes/{noteID}", { params: { path: { noteID: noteId } } }));
  }
```

- [ ] **Step 4: Verify**: `rtk pnpm -C clients/core exec tsc --noEmit` and `rtk pnpm -C clients/core test` → PASS; `rtk git diff --stat clients/core` shows the schema and the two edited files.

---

### Task 3: Notes model and store

**Files:**
- Create: `clients/web/src/app/notes/notes-model.ts`
- Create: `clients/web/src/app/notes/notes-model.test.ts`
- Create: `clients/web/src/app/notes/notes-store.ts`

**Interfaces:**
- Consumes: Task 2 types and client methods; `client`, `errorText` from `../../session`.
- Produces:
  - `type NotesState = { summaries: NoteSummary[] | null; notes: Record<string, Note>; dirty: Record<string, true>; missing: Record<string, true> }`
  - `initialNotes: NotesState`
  - `applyNoteEvent(s: NotesState, type: string, data: unknown): NotesState`
  - `putNote(s: NotesState, n: Note): NotesState` (stores the note and its summary)
  - `dropNote(s: NotesState, id: string): NotesState` (removes everywhere, marks `missing`)
  - `summaryOf(n: Note): NoteSummary`, `previewOf(text: string): string`, `displayTitle(title: string): string`
  - `useNotes` zustand store (state above) and actions `loadNotes()`, `openNote(id): Promise<void>`, `newNote(): Promise<Note>`, `saveNote(id, patch): Promise<Note>`, `deleteNote(id): Promise<void>`, `setDirty(id, dirty: boolean)`

- [ ] **Step 1: Failing tests** (`notes-model.test.ts`)

```ts
import type { Note } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { applyNoteEvent, displayTitle, initialNotes, previewOf, putNote, summaryOf } from "./notes-model";

const note = (id: string, title: string, text: string, at: string): Note => ({
  id, title, text, content: { type: "doc" }, created_at: at, updated_at: at,
});

describe("notes model", () => {
  it("previews collapse whitespace and cut at 140 characters", () => {
    expect(previewOf("a\n\n  b\tc")).toBe("a b c");
    expect(previewOf("x".repeat(200))).toHaveLength(140);
  });
  it("shows Untitled for blank titles", () => {
    expect(displayTitle("")).toBe("Untitled");
    expect(displayTitle("Raid")).toBe("Raid");
  });
  it("NOTE_CREATE adds a summary on top, once", () => {
    let s = { ...initialNotes, summaries: [summaryOf(note("1", "old", "", "2026-01-01T00:00:00Z"))] };
    const created = summaryOf(note("2", "new", "", "2026-01-02T00:00:00Z"));
    s = applyNoteEvent(s, "NOTE_CREATE", created);
    s = applyNoteEvent(s, "NOTE_CREATE", created);
    expect(s.summaries!.map((n) => n.id)).toEqual(["2", "1"]);
  });
  it("NOTE_UPDATE moves the note to the top and replaces a clean note", () => {
    let s = putNote(putNote({ ...initialNotes, summaries: [] }, note("1", "a", "", "2026-01-01T00:00:00Z")), note("2", "b", "", "2026-01-02T00:00:00Z"));
    s = applyNoteEvent(s, "NOTE_UPDATE", note("1", "a2", "t", "2026-01-03T00:00:00Z"));
    expect(s.summaries!.map((n) => n.id)).toEqual(["1", "2"]);
    expect(s.notes["1"].title).toBe("a2");
  });
  it("keeps dirty note: a remote update does not replace local edits", () => {
    let s = putNote({ ...initialNotes, summaries: [] }, note("1", "mine", "", "2026-01-01T00:00:00Z"));
    s = { ...s, dirty: { "1": true } };
    s = applyNoteEvent(s, "NOTE_UPDATE", note("1", "theirs", "", "2026-01-02T00:00:00Z"));
    expect(s.notes["1"].title).toBe("mine");
    expect(s.summaries![0].title).toBe("theirs");
  });
  it("NOTE_DELETE removes it and marks it missing", () => {
    let s = putNote({ ...initialNotes, summaries: [] }, note("1", "a", "", "2026-01-01T00:00:00Z"));
    s = applyNoteEvent(s, "NOTE_DELETE", { id: "1" });
    expect(s.summaries).toEqual([]);
    expect(s.notes["1"]).toBeUndefined();
    expect(s.missing["1"]).toBe(true);
  });
  it("ignores other events and leaves an unloaded list unloaded", () => {
    expect(applyNoteEvent(initialNotes, "MESSAGE_CREATE", {})).toBe(initialNotes);
    expect(applyNoteEvent(initialNotes, "NOTE_UPDATE", note("1", "a", "", "2026-01-01T00:00:00Z")).summaries).toBeNull();
  });
});
```

- [ ] **Step 2: Run**: `rtk vitest run src/app/notes` (from `clients/web`) → FAIL, module not found.

- [ ] **Step 3: Implement `notes-model.ts`**

```ts
import type { Note, NoteSummary } from "@datrope/core";

export type NotesState = {
  summaries: NoteSummary[] | null; // null until loaded
  notes: Record<string, Note>;
  dirty: Record<string, true>; // local edits not yet saved
  missing: Record<string, true>; // deleted, or never existed
};

export const initialNotes: NotesState = { summaries: null, notes: {}, dirty: {}, missing: {} };

export function previewOf(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ").slice(0, 140);
}

export function displayTitle(title: string): string {
  return title.trim() || "Untitled";
}

export function summaryOf(n: Note): NoteSummary {
  return { id: n.id, title: n.title, preview: previewOf(n.text), updated_at: n.updated_at };
}

/** Puts a summary on top of the list (newest first), replacing any older copy. */
function upsert(list: NoteSummary[] | null, sum: NoteSummary): NoteSummary[] | null {
  return list && [sum, ...list.filter((n) => n.id !== sum.id)];
}

export function putNote(s: NotesState, n: Note): NotesState {
  const { [n.id]: _, ...missing } = s.missing;
  return { ...s, summaries: upsert(s.summaries, summaryOf(n)), notes: { ...s.notes, [n.id]: n }, missing };
}

export function dropNote(s: NotesState, id: string): NotesState {
  const { [id]: _n, ...notes } = s.notes;
  const { [id]: _d, ...dirty } = s.dirty;
  return { ...s, summaries: s.summaries && s.summaries.filter((n) => n.id !== id), notes, dirty, missing: { ...s.missing, [id]: true } };
}

export function applyNoteEvent(s: NotesState, type: string, data: unknown): NotesState {
  switch (type) {
    case "NOTE_CREATE": {
      const sum = data as NoteSummary;
      return s.summaries?.some((n) => n.id === sum.id) ? s : { ...s, summaries: upsert(s.summaries, sum) };
    }
    case "NOTE_UPDATE": {
      const n = data as Note;
      if (s.dirty[n.id]) return { ...s, summaries: upsert(s.summaries, summaryOf(n)) };
      return { ...s, summaries: upsert(s.summaries, summaryOf(n)), notes: n.id in s.notes ? { ...s.notes, [n.id]: n } : s.notes };
    }
    case "NOTE_DELETE":
      return dropNote(s, (data as { id: string }).id);
    default:
      return s;
  }
}
```

(If `noUnusedLocals` flags the `_` destructuring, use the codebase's existing omit idiom; grep `const { [` in `clients/`.)

- [ ] **Step 4: Implement `notes-store.ts`**

```ts
import { ApiError, type Note } from "@datrope/core";
import { create } from "zustand";
import { client } from "../../session";
import { applyNoteEvent, dropNote, initialNotes, putNote, type NotesState } from "./notes-model";

export const useNotes = create<NotesState>(() => initialNotes);

let synced = false;
/** Follows NOTE_* events from the first load on; they come from this and my other devices. */
function sync() {
  if (synced) return;
  synced = true;
  client.onEvent((type, data) => useNotes.setState((s) => applyNoteEvent(s, type, data)));
}

export async function loadNotes() {
  sync();
  const list = await client.listNotes();
  useNotes.setState({ summaries: list });
}

export async function openNote(id: string) {
  sync();
  if (useNotes.getState().notes[id]) return;
  try {
    const n = await client.getNote(id);
    useNotes.setState((s) => putNote(s, n));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) useNotes.setState((s) => dropNote(s, id));
    else throw e;
  }
}

export async function newNote(): Promise<Note> {
  const n = await client.createNote();
  useNotes.setState((s) => putNote(s, n));
  return n;
}

export function setDirty(id: string, dirty: boolean) {
  useNotes.setState((s) => {
    const { [id]: _, ...rest } = s.dirty;
    return { dirty: dirty ? { ...s.dirty, [id]: true } : rest };
  });
}

/** Saves a patch; a note deleted elsewhere (404) is dropped, and the error rethrown. */
export async function saveNote(id: string, patch: { title?: string; content?: Record<string, unknown>; text?: string }) {
  try {
    const n = await client.updateNote(id, patch);
    useNotes.setState((s) => putNote(s, n));
    return n;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) useNotes.setState((s) => dropNote(s, id));
    throw e;
  }
}

export async function deleteNote(id: string) {
  await client.deleteNote(id);
  useNotes.setState((s) => dropNote(s, id));
}
```

Note: `putNote` after a save stores the server copy; the saver (Task 4) clears dirty only when no newer edits are pending, so the editor never gets reset by its own save (the editor only reloads on `updated_at` changes when not dirty and not focused, see Task 5).

- [ ] **Step 5: Run**: `rtk vitest run src/app/notes` → PASS; `rtk tsc` (in `clients/web`) → no new errors.

---

### Task 4: Autosaver

**Files:**
- Create: `clients/web/src/app/notes/autosave.ts`
- Create: `clients/web/src/app/notes/autosave.test.ts`

**Interfaces:**
- Produces:
  - `type SaveStatus = "idle" | "saving" | "saved" | "error" | "deleted"`
  - `type Patch = { title?: string; content?: Record<string, unknown>; text?: string }`
  - `createSaver(opts: { delay: number; save: (id: string, p: Patch) => Promise<unknown>; onStatus: (s: SaveStatus) => void; onDirty: (id: string, dirty: boolean) => void }): Saver`
  - `Saver = { edit(id: string, p: Patch): void; flush(): Promise<void>; retry(): Promise<void>; dispose(): Promise<void> }`
  - `useAutosave(): { status: SaveStatus; edit: Saver["edit"]; flush: Saver["flush"]; retry: Saver["retry"] }` (React hook; flushes on unmount and `beforeunload`)

- [ ] **Step 1: Failing tests**

```ts
import { ApiError } from "@datrope/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSaver, type SaveStatus } from "./autosave";

describe("createSaver", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const setup = (save = vi.fn().mockResolvedValue(undefined)) => {
    const statuses: SaveStatus[] = [];
    const dirty = vi.fn();
    const s = createSaver({ delay: 800, save, onStatus: (x) => statuses.push(x), onDirty: dirty });
    return { s, save, statuses, dirty };
  };

  it("debounces and merges edits into one save", async () => {
    const { s, save, dirty } = setup();
    s.edit("1", { title: "a" });
    s.edit("1", { content: { type: "doc" }, text: "x" });
    expect(dirty).toHaveBeenCalledWith("1", true);
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith("1", { title: "a", content: { type: "doc" }, text: "x" });
    expect(dirty).toHaveBeenLastCalledWith("1", false);
  });

  it("flush on switch: editing another note saves the first one right away to its own id", async () => {
    const { s, save } = setup();
    s.edit("1", { title: "a" });
    s.edit("2", { title: "b" });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenNthCalledWith(1, "1", { title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenNthCalledWith(2, "2", { title: "b" });
  });

  it("keeps edits made during a save dirty and saves them next", async () => {
    let finish!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { finish = r; })).mockResolvedValue(undefined);
    const { s, dirty } = setup(save);
    s.edit("1", { title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    s.edit("1", { title: "ab" });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(dirty).not.toHaveBeenLastCalledWith("1", false);
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenLastCalledWith("1", { title: "ab" });
  });

  it("reports an error and retries the same patch", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined);
    const { s, statuses } = setup(save);
    s.edit("1", { title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    expect(statuses.at(-1)).toBe("error");
    await s.retry();
    expect(save).toHaveBeenLastCalledWith("1", { title: "a" });
    expect(statuses.at(-1)).toBe("saved");
  });

  it("404 stops: a deleted note's edits are dropped, not retried", async () => {
    const save = vi.fn().mockRejectedValue(new ApiError(404, "NOT_FOUND", "note not found"));
    const { s, statuses } = setup(save);
    s.edit("1", { title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    expect(statuses.at(-1)).toBe("deleted");
    await s.retry();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module not found).

- [ ] **Step 3: Implement `autosave.ts`**

```ts
import { ApiError } from "@datrope/core";
import { useEffect, useMemo, useState } from "react";
import { saveNote, setDirty } from "./notes-store";

export type SaveStatus = "idle" | "saving" | "saved" | "error" | "deleted";
export type Patch = { title?: string; content?: Record<string, unknown>; text?: string };

type Opts = {
  delay: number;
  save: (id: string, p: Patch) => Promise<unknown>;
  onStatus: (s: SaveStatus) => void;
  onDirty: (id: string, dirty: boolean) => void;
};

/** Batches a note's edits and saves them `delay` ms after the last one; one note pending at a time. */
export function createSaver({ delay, save, onStatus, onDirty }: Opts) {
  let id: string | null = null;
  let patch: Patch = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();

  const run = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (id === null) return running;
    const target = id, sent = patch;
    id = null;
    patch = {};
    onStatus("saving");
    running = running.then(() => save(target, sent)).then(
      () => {
        if (id !== target) onDirty(target, false); // newer edits to it are still pending otherwise
        onStatus(id === null ? "saved" : "saving");
      },
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 404) {
          if (id === target) { id = null; patch = {}; }
          onDirty(target, false);
          onStatus("deleted");
          return;
        }
        if (id === target) patch = { ...sent, ...patch };
        else if (id === null) { id = target; patch = sent; }
        onStatus("error");
      },
    );
    return running;
  };

  return {
    edit(noteId: string, p: Patch) {
      if (id !== null && id !== noteId) void run();
      id = noteId;
      patch = { ...patch, ...p };
      onDirty(noteId, true);
      clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    },
    flush: run,
    retry: run,
    dispose: run,
  };
}

/** The editor's saver: 800 ms debounce, flushed on unmount and when the page is closed. */
export function useAutosave() {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const saver = useMemo(() => createSaver({ delay: 800, save: saveNote, onStatus: setStatus, onDirty: setDirty }), []);
  useEffect(() => {
    const flush = () => void saver.flush();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      void saver.dispose();
    };
  }, [saver]);
  return { status, edit: saver.edit, flush: saver.flush, retry: saver.retry };
}
```

Note: In the error case where a different note got queued meanwhile, the failed patch is lost only if `id` is another note; acceptable per spec (last write wins), and the status shows the error.

- [ ] **Step 4: Run**: `rtk vitest run src/app/notes` → PASS.

---

### Task 5: Tiptap editor and toolbar

**Files:**
- Modify: `clients/web/package.json` (dependencies)
- Create: `clients/web/src/app/notes/NoteEditor.tsx`
- Create: `clients/web/src/app/notes/NoteToolbar.tsx`
- Modify: `clients/web/src/styles.css` (append `.note-editor` block after the `.chat-md` rules)

**Interfaces:**
- Consumes: `Patch` from Task 4, `Note` type.
- Produces: `NoteEditor({ note, dirty, onEdit, onBlur }: { note: Note; dirty: boolean; onEdit: (p: Patch) => void; onBlur: () => void })`; renders toolbar + editor; editor has `aria-label="Note"` (role textbox, via `editorProps.attributes`).

- [ ] **Step 1: Dependencies** (from `clients/web`): `rtk pnpm add @tiptap/core@3.32.0 @tiptap/react@3.32.0 @tiptap/pm@3.32.0 @tiptap/starter-kit@3.32.0 @tiptap/extension-list@3.32.0 @tiptap/extensions@3.32.0`. Then make sure the versions in `package.json` are exact (no `^`). If pnpm fails on this machine, add them by hand to `package.json` and run `rtk pnpm install`.

- [ ] **Step 2: `NoteToolbar.tsx`**

```tsx
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import {
  Bold, Code, Heading1, Heading2, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Quote, SquareCode, Strikethrough,
} from "lucide-react";
import { useState, type ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Mark = { label: string; icon: ComponentType; active: (e: Editor) => boolean; run: (e: Editor) => void };

const MARKS: Mark[] = [
  { label: "Bold", icon: Bold, active: (e) => e.isActive("bold"), run: (e) => e.chain().focus().toggleBold().run() },
  { label: "Italic", icon: Italic, active: (e) => e.isActive("italic"), run: (e) => e.chain().focus().toggleItalic().run() },
  { label: "Strikethrough", icon: Strikethrough, active: (e) => e.isActive("strike"), run: (e) => e.chain().focus().toggleStrike().run() },
  { label: "Heading 1", icon: Heading1, active: (e) => e.isActive("heading", { level: 1 }), run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { label: "Heading 2", icon: Heading2, active: (e) => e.isActive("heading", { level: 2 }), run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { label: "Bulleted list", icon: List, active: (e) => e.isActive("bulletList"), run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", icon: ListOrdered, active: (e) => e.isActive("orderedList"), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: "Checklist", icon: ListChecks, active: (e) => e.isActive("taskList"), run: (e) => e.chain().focus().toggleTaskList().run() },
  { label: "Quote", icon: Quote, active: (e) => e.isActive("blockquote"), run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: "Inline code", icon: Code, active: (e) => e.isActive("code"), run: (e) => e.chain().focus().toggleCode().run() },
  { label: "Code block", icon: SquareCode, active: (e) => e.isActive("codeBlock"), run: (e) => e.chain().focus().toggleCodeBlock().run() },
];

/** Formatting buttons; scrolls sideways when narrow. */
export function NoteToolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({ editor, selector: ({ editor: e }) => MARKS.map((m) => m.active(e)).concat(e.isActive("link")) });
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-none items-center gap-0.5 overflow-x-auto border-b px-3 py-1.5">
      {MARKS.map((m, i) => (
        <Tooltip key={m.label}>
          <TooltipTrigger asChild>
            <Toggle size="sm" aria-label={m.label} pressed={active[i]} onPressedChange={() => m.run(editor)}>
              <m.icon />
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>{m.label}</TooltipContent>
        </Tooltip>
      ))}
      <LinkButton editor={editor} active={active[MARKS.length]} />
    </div>
  );
}

function LinkButton({ editor, active }: { editor: Editor; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const apply = () => {
    const href = url.trim();
    if (href) editor.chain().focus().extendMarkRange("link").setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}` }).run();
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setUrl(editor.getAttributes("link").href ?? ""); }}>
      <PopoverTrigger asChild>
        <Toggle size="sm" aria-label="Link" pressed={active}><LinkIcon /></Toggle>
      </PopoverTrigger>
      <PopoverContent className="flex w-72 gap-2">
        <Input aria-label="Link address" placeholder="https://" value={url} autoFocus
          onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }} />
        {active && (
          <Button variant="ghost" size="sm" onClick={() => { editor.chain().focus().unsetLink().run(); setOpen(false); }}>Remove</Button>
        )}
        <Button size="sm" onClick={apply}>Apply</Button>
      </PopoverContent>
    </Popover>
  );
}
```

Per AGENTS.md: `Toggle` may need `React.forwardRef` to be an `asChild` child of `TooltipTrigger`/`PopoverTrigger` (React 18). Check `src/components/ui/toggle.tsx`; if it does not forward refs, wrap it in `forwardRef` there (keep the rest of the generated file as is).

- [ ] **Step 3: `NoteEditor.tsx`**

```tsx
import type { Note } from "@datrope/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import type { Patch } from "./autosave";
import { NoteToolbar } from "./NoteToolbar";

const EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [1, 2] },
    link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder: "Write something…" }),
];

/** The note's body. A newer copy from another device replaces the text only while this editor isn't focused. */
export function NoteEditor({ note, dirty, onEdit, onBlur }: { note: Note; dirty: boolean; onEdit: (p: Patch) => void; onBlur: () => void }) {
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: note.content,
    editorProps: { attributes: { "aria-label": "Note", class: "note-editor" } },
    onUpdate: ({ editor: e }) => onEdit({ content: e.getJSON() as Record<string, unknown>, text: e.getText() }),
    onBlur,
  }, [note.id]);

  useEffect(() => {
    if (!editor || dirty || editor.isFocused) return;
    editor.commands.setContent(note.content, { emitUpdate: false });
  }, [editor, note.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps -- only a newer copy reloads

  if (!editor) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NoteToolbar editor={editor} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain" onClick={() => editor.chain().focus().run()}>
        <EditorContent editor={editor} className="mx-auto w-full max-w-[720px] px-6 py-6 md:px-10" />
      </div>
    </div>
  );
}
```

(`onEdit`/`onBlur` are read through Tiptap's latest-options handling in v3; if a stale closure shows up, keep them in refs.)

- [ ] **Step 4: Styles** in `styles.css`:

```css
/* Note editor (src/app/notes/NoteEditor.tsx). */
.note-editor { outline: none; min-height: 50vh; font-size: var(--text-body); line-height: var(--text-body--line-height); }
.note-editor > * + * { margin-top: 0.6em; }
.note-editor h1 { font-size: var(--text-heading); line-height: var(--text-heading--line-height); color: var(--foreground); }
.note-editor h2 { font-size: var(--text-title); line-height: var(--text-title--line-height); color: var(--foreground); text-transform: none; letter-spacing: normal; }
.note-editor ul { list-style: disc; padding-left: 1.4em; }
.note-editor ol { list-style: decimal; padding-left: 1.4em; }
.note-editor ul[data-type="taskList"] { list-style: none; padding-left: 0.2em; }
.note-editor ul[data-type="taskList"] li { display: flex; gap: 0.5em; align-items: flex-start; }
.note-editor ul[data-type="taskList"] li > label { margin-top: 0.2em; }
.note-editor ul[data-type="taskList"] input { accent-color: var(--primary); }
.note-editor li[data-checked="true"] > div { color: var(--muted-foreground); text-decoration: line-through; }
.note-editor blockquote { border-left: 3px solid var(--border); padding-left: 0.8em; color: var(--muted-foreground); }
.note-editor code { background: var(--muted); border-radius: calc(var(--radius) - 4px); padding: 0.1em 0.3em; font-size: 0.875em; }
.note-editor pre { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.75em 1em; overflow-x: auto; }
.note-editor pre code { background: none; padding: 0; }
.note-editor a { color: var(--primary); text-decoration: underline; }
.note-editor p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--muted-foreground); float: left; height: 0; pointer-events: none; }
```

Note: the base layer styles `h2` and `h3` (`h3` is uppercase muted); the `h2` override above resets that inside notes.

- [ ] **Step 5: Verify**: `rtk tsc` (in `clients/web`) → no errors. Visual check happens in Task 7.

---

### Task 6: Views, sidebar tab, routes, mobile

**Files:**
- Create: `clients/web/src/app/notes/NotesPane.tsx` (search + list + New note; used by the sidebar tab and the phone list screen)
- Create: `clients/web/src/app/notes/NotesView.tsx` (desktop `/notes/:noteId?` and phone screens)
- Create: `clients/web/src/app/notes/NoteMenu.tsx` (⋯ dropdown + delete AlertDialog)
- Modify: `clients/web/src/router.tsx`
- Modify: `clients/web/src/app/ServerSidebar.tsx`
- Modify: `clients/web/src/app/mobile/YouPage.tsx` (Notes row)
- Modify: `clients/web/src/app/mobile/tabs.ts` + `tabs.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5 (`useNotes`, `loadNotes`, `openNote`, `newNote`, `deleteNote`, `displayTitle`, `useAutosave`, `NoteEditor`).
- Produces: route `notes/:noteId?` → `NotesView`; sidebar tab `value="notes"` named "Notes"; list `aria-label="Notes"` of links named by note title; button "New note"; title input `aria-label="Title"`; menu button "Note options"; menu item "Delete note"; status text `Saving…` / `Saved` / `Couldn't save` + button "Retry".

- [ ] **Step 1: tabs test first** — add to `mobile/tabs.test.ts`:

```ts
  it("puts notes under the You tab", () => {
    expect(tabFor("/notes")).toBe("you");
    expect(tabFor("/notes/123")).toBe("you");
    expect(isTabRoot("/notes")).toBe(false);
  });
```

Run `rtk vitest run src/app/mobile/tabs` → FAIL. Then in `tabs.ts` change the `you` line to:

```ts
  if (pathname.startsWith("/you") || pathname.startsWith("/server-settings") || pathname.startsWith("/notes")) return "you";
```

Run again → PASS.

- [ ] **Step 2: `NotesPane.tsx`**

```tsx
import type { NoteSummary } from "@datrope/core";
import { Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLayerNavigate } from "@/hooks/use-history-layer";
import { cn } from "@/lib/utils";
import { client, errorText } from "../../session";
import { displayTitle } from "./notes-model";
import { loadNotes, newNote, useNotes } from "./notes-store";

/** Search, the list of my notes and New note: the sidebar's Notes tab, and the phone's Notes screen. */
export function NotesPane({ activeId, className }: { activeId?: string; className?: string }) {
  const nav = useLayerNavigate();
  const summaries = useNotes((s) => s.summaries);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<NoteSummary[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (!summaries) loadNotes().catch((e: unknown) => setError(errorText(e))); }, [summaries]);
  useEffect(() => {
    const query = q.trim();
    if (!query) { setFound(null); return; }
    const t = setTimeout(() => client.listNotes(query).then(setFound, (e: unknown) => setError(errorText(e))), 250);
    return () => clearTimeout(t);
  }, [q, summaries]);
  const create = () => newNote().then((n) => nav(`/notes/${n.id}`, { state: { focusTitle: true } }), (e: unknown) => setError(errorText(e)));
  const shown = found ?? summaries;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="relative px-2 pt-2">
        <Search className="pointer-events-none absolute top-1/2 left-4 mt-1 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input type="search" aria-label="Search notes" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
      </div>
      <nav aria-label="Notes" className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-2 py-2">
        {shown?.length === 0 && <p className="px-2 py-4 text-ui text-muted-foreground">{q.trim() ? "No notes match." : "No notes yet."}</p>}
        {shown?.map((n) => (
          <Link key={n.id} to={`/notes/${n.id}`} aria-current={n.id === activeId ? "page" : undefined}
            className={cn("block rounded-md px-2 py-1.5 text-foreground no-underline hover:bg-accent", n.id === activeId && "bg-accent")}>
            <span className="block truncate text-ui font-medium">{displayTitle(n.title)}</span>
            <span className="block truncate text-meta text-muted-foreground">{n.preview || "Empty note"}</span>
          </Link>
        ))}
      </nav>
      <div className="flex-none px-2 pb-2">
        {error && <p role="alert" className="pb-1 text-meta text-destructive">{error}</p>}
        <Button className="w-full" onClick={create}><Plus />New note</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `NoteMenu.tsx`**

```tsx
import { MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { errorText } from "../../session";
import { deleteNote } from "./notes-store";

/** ⋯ for the open note: Delete, after a confirm. */
export function NoteMenu({ noteId, onDeleted }: { noteId: string; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Note options" className="text-muted-foreground"><MoreHorizontal /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}><Trash2 />Delete note</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>It's removed from all your devices. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert" className="text-ui text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); deleteNote(noteId).then(onDeleted, (err: unknown) => setError(errorText(err))); }}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

(Check `DropdownMenuItem` supports `variant="destructive"` in the local file; otherwise use `className="text-destructive"`.)

- [ ] **Step 4: `NotesView.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLayerNavigate } from "@/hooks/use-history-layer";
import { useIsMobile } from "@/hooks/use-mobile";
import { EmptyView } from "../EmptyView";
import { ScreenHeader } from "../mobile/ScreenHeader";
import { TopBar } from "../TopBar";
import { errorText } from "../../session";
import { useAutosave, type SaveStatus } from "./autosave";
import { NoteEditor } from "./NoteEditor";
import { NoteMenu } from "./NoteMenu";
import { NotesPane } from "./NotesPane";
import { openNote, useNotes } from "./notes-store";

/** /notes and /notes/:noteId. Desktop: the list is in the sidebar's Notes tab. Phones: list and note are pushed screens. */
export function NotesView() {
  const { noteId } = useParams();
  const mobile = useIsMobile();
  if (!noteId) {
    return mobile ? (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="Notes">
        <ScreenHeader title="Notes" />
        <NotesPane className="pb-safe" />
      </main>
    ) : <EmptyView title="Notes">Select a note or create a new one.</EmptyView>;
  }
  return <OpenNote key={noteId} noteId={noteId} />;
}

function OpenNote({ noteId }: { noteId: string }) {
  const mobile = useIsMobile();
  const nav = useLayerNavigate();
  const focusTitle = !!(useLocation().state as { focusTitle?: boolean } | null)?.focusTitle;
  const note = useNotes((s) => s.notes[noteId]);
  const missing = useNotes((s) => !!s.missing[noteId]);
  const dirty = useNotes((s) => !!s.dirty[noteId]);
  const { status, edit, flush, retry } = useAutosave();
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const seen = useRef(false);

  useEffect(() => { openNote(noteId).catch((e: unknown) => setError(errorText(e))); }, [noteId]);
  useEffect(() => { if (note && !dirty) setTitle(note.title); }, [note?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (note) seen.current = true; }, [note]);
  // Deleted here or on another device while open: back to the list.
  useEffect(() => { if (missing && seen.current) nav("/notes", { replace: true }); }, [missing, nav]);

  if (missing && !seen.current) {
    return <EmptyView title="Notes">This note doesn't exist. <Link to="/notes">Back to notes</Link></EmptyView>;
  }
  if (error) return <EmptyView title="Notes"><span role="alert">{error}</span></EmptyView>;
  if (!note) return <main className="flex-1 bg-background" aria-busy="true" />;

  const titleInput = (
    <Input aria-label="Title" placeholder="Untitled" maxLength={100} value={title} autoFocus={focusTitle}
      onChange={(e) => { setTitle(e.target.value); edit(note.id, { title: e.target.value }); }} onBlur={() => void flush()}
      className="h-8 min-w-0 flex-1 border-none bg-transparent px-1 text-title font-semibold shadow-none focus-visible:ring-1" />
  );
  const actions = (
    <>
      <SaveState status={status} updatedAt={note.updated_at} onRetry={() => void retry()} />
      <NoteMenu noteId={note.id} onDeleted={() => nav("/notes", { replace: true })} />
    </>
  );
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="Note">
      {mobile ? <ScreenHeader title={titleInput} actions={actions} /> : <TopBar tools={false} actions={actions}>{titleInput}</TopBar>}
      <NoteEditor note={note} dirty={dirty} onEdit={(p) => edit(note.id, p)} onBlur={() => void flush()} />
    </main>
  );
}

function SaveState({ status, updatedAt, onRetry }: { status: SaveStatus; updatedAt: string; onRetry: () => void }) {
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 text-meta text-destructive" role="status">
        Couldn't save<Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button>
      </span>
    );
  }
  const text = status === "saving" ? "Saving…" : status === "saved" ? "Saved" : `Edited ${relative(updatedAt)}`;
  return <span className="whitespace-nowrap text-meta text-muted-foreground max-md:hidden" role="status">{text}</span>;
}

function relative(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
```

Before using `relative`, grep `clients/web/src` for an existing relative-time helper (e.g. `ago(`, `relativeTime`) and reuse it instead if present. If `TopBar`'s `data-titlebar-drag` header swallows clicks on the input in the desktop app, check how `desktop-chrome.ts` exempts interactive elements; inputs are normally exempt.

- [ ] **Step 5: Route** in `router.tsx` (import `NotesView` from `./app/notes/NotesView`), after the `messages` route:

```tsx
        { path: "notes/:noteId?", element: <NotesView /> },
```

- [ ] **Step 6: Sidebar tab** in `ServerSidebar.tsx`:

```tsx
  const noteId = useMatch("/notes/:noteId")?.params.noteId;
  const inNotes = !!useMatch("/notes/*");
  ...
  const tab = inMessages ? "messages" : inNotes ? "notes" : "channels";
  const switchTab = (to: string) => {
    if (to === "channels") {
      nav("/");
    } else if (to === "notes") {
      nav("/notes");
    } else { /* existing messages branch */ }
  };
```

- Sidebar `nav` label: `aria-label={tab === "messages" ? "Direct messages" : tab === "notes" ? "Notes sidebar" : "Channels"}` (the inner list is the one named "Notes").
- `TabsList` class `grid-cols-2` → `grid-cols-3`.
- Add `<TabsTrigger value="notes" disabled={gated} className={TAB}>Notes</TabsTrigger>` after Messages.
- Add `<TabsContent value="notes" className="flex min-h-0 flex-col"><NotesPane activeId={noteId} /></TabsContent>`.

Check at 240 px sidebar width that three triggers fit ("Channels", "Messages", "Notes"); if the Messages unread dot squeezes, reduce trigger padding with `px-1.5` on `TAB`.

- [ ] **Step 7: You page row** in `YouPage.tsx` before the `GROUPS.map`:

```tsx
        <div className="pt-5">
          <SettingsList label="Notes" rows={[{ id: "notes", label: "Notes", icon: NotebookPen, to: "/notes" }]} />
        </div>
```

(import `NotebookPen` from `lucide-react`). Rename that list's label to "Your notes" if the e2e or a11y check finds two navs named "Notes" on one screen.

- [ ] **Step 8: Verify**: `rtk tsc` and `rtk vitest run` (in `clients/web`) → PASS; `rtk lint` if configured → no new errors.

---

### Task 7: E2E and browser verification

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts` (new test at the end)

- [ ] **Step 1: E2E test**

```ts
test("personal notes: write a note, it survives a reload, then delete it", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");

  await alice.getByRole("tab", { name: "Notes" }).click();
  await alice.getByRole("button", { name: "New note" }).click();
  await alice.getByLabel("Title").fill("Raid roster");
  await alice.getByRole("textbox", { name: "Note" }).click();
  await alice.keyboard.type("Bring flasks");
  await expect(alice.getByRole("status")).toHaveText("Saved");

  await alice.reload();
  await expect(alice.getByLabel("Title")).toHaveValue("Raid roster");
  await expect(alice.getByRole("textbox", { name: "Note" })).toContainText("Bring flasks");
  await expect(alice.getByRole("navigation", { name: "Notes" }).getByRole("link", { name: /Raid roster/ })).toBeVisible();

  await alice.getByRole("button", { name: "Note options" }).click();
  await alice.getByRole("menuitem", { name: "Delete note" }).click();
  await alice.getByRole("button", { name: "Delete" }).click();
  await expect(alice).toHaveURL(/\/notes$/);
  await expect(alice.getByRole("navigation", { name: "Notes" }).getByRole("link", { name: /Raid roster/ })).toHaveCount(0);
});
```

- [ ] **Step 2: Run e2e if the stack is up** (`E2E_BASE_URL`, Caddy at `https://localhost`): `rtk playwright test e2e/chat.spec.ts -g "personal notes"`. If the stack is not running, say so in the report instead of claiming it passed.

- [ ] **Step 3: Browser preview**: start the dev server from `.claude/launch.json` (create an entry for `pnpm -C clients/web dev` + the Go server if missing), sign in with a test account, and check: Notes tab, create, type with formatting (bold, checklist, link), autosave status, reload persists, delete; second tab of the same user sees the note appear (event sync); phone width (375×812): You → Notes → list → note → back. Screenshot desktop and mobile.

- [ ] **Step 4: Full checks**: `rtk go -C server test ./...` (Docker needed), `rtk pnpm -C clients/core test`, `rtk vitest run` + `rtk tsc` in `clients/web`. Report results honestly, including anything skipped.

- [ ] **Step 5: Hand-over**: report the files changed, the `00043` migration-number collision risk, and leave the commit to the user.
