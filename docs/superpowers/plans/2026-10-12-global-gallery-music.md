# Global Gallery, Music Player and Playlists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a permission-scoped global gallery of every file you can read, with kind filters and search, a persistent personal music player, and gallery audio in the existing music-bot playlists. You can play those playlists yourself or have the bot play them in a voice call.

**Architecture:**
- A new `GET /api/files` endpoint (Go, `messages` package) feeds one shared `GalleryView` in two scopes, global (`/gallery`) and per gallery channel.
- Playlist items gain a fourth source, `attachment_id`. Reads are filtered per caller. When the bot is asked to play a playlist, it plays only the files the person queueing can read.
- The personal player is a module-level zustand store plus one `<audio>` element and a bottom `PlayerBar` in `AppShell`.

**Tech Stack:**
- Server: Go 1.25, huma v2, pgx v5, goose migrations, testify + apptest (real Postgres 17 via testcontainers).
- Clients: React 18, react-router 6, zustand, shadcn/ui (Radix) + Tailwind v4, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-global-gallery-music-design.md`
**Mockups:** `docs/superpowers/mockups/GlobalGallery.html`, frames 1–10. The bottom-bar player (frame 5) is the chosen placement. Shuffle and repeat stay. The Music view gets both Grid and List, with Grid as the default.

## Global Constraints

- **Never commit.** `AGENTS.md` §5: no `git commit`, `push`, `amend`, `rebase` or tags. Each task ends with a *checkpoint* (tests green, `git status` reviewed) instead of a commit.
- **UI rules (AGENTS.md §6):**
  - Use shadcn/ui components only.
  - Never hardcode colours; use token utilities only (`bg-card`, `text-muted-foreground`, `bg-primary`, …). The one exception is the deterministic disc gradients, which come from `--avatar-1…8` tokens.
  - Dark only: no `dark:` classes.
  - Merge class names with `cn()`, and import with `@/…`.
  - `Button` defaults to `type="button"`.
- **React 18:** wrap a component in `React.forwardRef`, or use `RefButton` from `@/components/ref-button`, before it becomes an `asChild` trigger child.
- **Keep the existing accessible names**, except these deliberate changes, which the e2e test is updated for:
  - the upload dialog title becomes `"Upload files"`;
  - the empty text becomes `"No files yet."`;
  - the details panel labels are `"Photo details" | "Video details" | "Track details" | "File details"`.
- **Kinds:** exactly `image | video | audio | document | archive | other`. UI labels: Photos, Videos, Music, Documents, Archives, Other.
- **`GET /api/files` multi-value params are comma-separated strings** (`kind=audio,image`, `channel=1,2`). This avoids huma and openapi-fetch disagreeing about array encoding.
- **The global gallery excludes DMs.** Playlists reject files from DMs.
- **Run server tests** from `server/`: `go test ./internal/<pkg>/ -run <Name> -count=1`. They need Docker running (testcontainers). The music tests skip without `ffmpeg`, and the bot tests need LiveKit (`lktest`).
- **Run web tests** from `clients/web`: `pnpm vitest run <path>`. Typecheck with `pnpm -r typecheck` from the repo root.
- **There is no toast library in the app.** The spec's "toasts" are inline status notices (`role="status"`), the same way `PlaylistsTab` shows `notice` today.

## Review Focus

1. **A file in a channel the viewer lost access to after it was loaded.**
   - Expected: the next page or refetch no longer lists it.
   - The player skips it with a notice instead of stalling.
   - Owning task: Task 12, which tests the `onError → skip` path.
2. **A playlist that contains only files the caller can't read.**
   - Expected: queueing it on the bot returns a clear `PLAYLIST_EMPTY`-style error rather than queueing nothing silently.
   - Its detail shows "N tracks hidden" with an empty list.
   - Owning task: Task 3 (server test) and Task 14.
3. **Search text with `%`, `_` or `\` in it** (`50%_off.mp3`).
   - Expected: treated as literal characters, not wildcards.
   - Owning task: Task 1 test `q` escaping.
4. **The `channel=` filter given a thread id, a DM id or a hidden channel's id.**
   - Expected: no error and no leak; the result is empty or ignores that id.
   - Owning task: Task 1 test.
5. **Deleting a message whose audio is queued in the personal player or saved in a playlist.**
   - Expected: the playlist item disappears (cascade).
   - The personal player skips it when it comes up (404).
   - Owning tasks: Task 3 (cascade test) and Task 12 (skip on error).

---

## Phase A: Server

### Task 1: Migration and `GET /api/files`

**Files:**
- Create: `server/internal/db/migrations/00037_files_gallery.sql`
- Create: `server/internal/messages/files.go`
- Create: `server/internal/messages/files_test.go`
- Modify: `server/internal/files/claim.go` (add `ForIDs`)
- Modify: `server/internal/messages/messages.go:42-47` (add `ForIDs` to the `Attachments` interface)
- Modify: `server/internal/messages/handlers.go:71` (register the route)

**Interfaces:**
- Produces:
  - `messages.FileItem{Attachment files.Attachment; Message Message; Channel ChannelRef; Kind string}`
  - `messages.FilesPage{Items []FileItem; NextCursor *id.ID}`
  - Route `GET /api/files?kind=&channel=&uploader=&q=&before=&limit=`, operation id `list-files`.
  - `files.(*Service).ForIDs(ctx, []id.ID) (map[id.ID]files.Attachment, error)`
  - The SQL const `messages.kindSQL`, which Task 6 mirrors in TS.

- [ ] **Step 1: Write the migration.**

```sql
-- +goose Up
-- The global gallery: list a channel's files newest first, search file names.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX attachments_channel_idx ON attachments (channel_id, id DESC) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_filename_trgm_idx ON attachments USING gin (filename gin_trgm_ops);

-- Playlists can hold a channel's audio file, played from the attachment's blob.
ALTER TABLE music_playlist_items
    ADD COLUMN attachment_id BIGINT REFERENCES attachments (id) ON DELETE CASCADE,
    DROP CONSTRAINT music_playlist_items_check,
    ADD CONSTRAINT music_playlist_items_source_check CHECK (num_nonnulls(track_id, url, search, attachment_id) = 1);

-- +goose Down
DELETE FROM music_playlist_items WHERE attachment_id IS NOT NULL;
ALTER TABLE music_playlist_items
    DROP CONSTRAINT music_playlist_items_source_check,
    DROP COLUMN attachment_id,
    ADD CONSTRAINT music_playlist_items_check CHECK (num_nonnulls(track_id, url, search) = 1);
DROP INDEX attachments_filename_trgm_idx;
DROP INDEX attachments_channel_idx;
```

- [ ] **Step 2: Add `ForIDs` to `server/internal/files/claim.go`, below `ForMessages`.**

```go
// ForIDs loads attachments by ID (for the gallery, which lists files, not messages).
func (s *Service) ForIDs(ctx context.Context, ids []id.ID) (map[id.ID]Attachment, error) {
	out := map[id.ID]Attachment{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `SELECT `+attachmentCols+` FROM attachments WHERE id = ANY($1)`, id.Int64s(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanAttachment(rows, s.variantsOn())
		if err != nil {
			return nil, err
		}
		out[a.ID] = *a
	}
	return out, rows.Err()
}
```

Then add `ForIDs(ctx context.Context, ids []id.ID) (map[id.ID]files.Attachment, error)` to the `Attachments` interface in `messages/messages.go`.

- [ ] **Step 3: Write the failing tests in `server/internal/messages/files_test.go`.**

```go
package messages_test

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func listFiles(t *testing.T, c *apptest.Client, q url.Values) messages.FilesPage {
	t.Helper()
	var p messages.FilesPage
	c.Do(http.MethodGet, "/api/files?"+q.Encode(), nil, http.StatusOK, &p)
	return p
}

func fileNames(p messages.FilesPage) []string {
	out := []string{}
	for _, it := range p.Items {
		out = append(out, it.Attachment.Filename)
	}
	return out
}

// minimal WAV header + silence: sniffed as audio/wave.
func wav() []byte {
	b := make([]byte, 44+800)
	copy(b, "RIFF")
	b[4] = byte(36 + 800)
	copy(b[8:], "WAVEfmt ")
	b[16], b[20], b[22], b[24], b[25], b[32], b[34] = 16, 1, 1, 0x40, 0x1f, 2, 16
	copy(b[36:], "data")
	b[40], b[41] = 0x20, 0x03
	return b
}

func TestFilesScope(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	srv := alice.Server()
	secret := alice.CreateTextChannel("secret")
	alice.Do(http.MethodPut, "/api/channels/"+secret.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)

	alice.SendWith(general, "a song", alice.Upload(general, "song.wav", wav(), http.StatusCreated).ID)
	alice.SendWith(secret, "", alice.Upload(secret, "hidden.wav", wav(), http.StatusCreated).ID)
	parent := alice.Send(general, "thread here")
	th := startThread(t, alice, general, parent)
	alice.SendWith(th.ID, "", alice.Upload(th.ID, "in-thread.txt", []byte("hello"), http.StatusCreated).ID)
	d := dm(t, alice, bob)
	alice.SendWith(d.ID, "", alice.Upload(d.ID, "dm.txt", []byte("psst"), http.StatusCreated).ID)

	got := listFiles(t, bob, url.Values{})
	require.Equal(t, []string{"in-thread.txt", "song.wav"}, fileNames(got))
	require.Equal(t, "thread", got.Items[0].Channel.Type)
	require.Equal(t, general, *got.Items[0].Channel.ParentID, "a thread's file is tagged with its parent")
	require.Equal(t, "audio", got.Items[1].Kind)
	require.Equal(t, "a song", got.Items[1].Message.Content)

	// alice sees her secret channel too, but never DMs.
	require.Equal(t, []string{"in-thread.txt", "hidden.wav", "song.wav"}, fileNames(listFiles(t, alice, url.Values{})))

	// A channel filter naming a hidden channel, a DM or a thread yields nothing and no error.
	require.Empty(t, listFiles(t, bob, url.Values{"channel": {secret.String()}}).Items)
	require.Empty(t, listFiles(t, bob, url.Values{"channel": {d.ID.String()}}).Items)
	require.Equal(t, []string{"in-thread.txt", "song.wav"}, fileNames(listFiles(t, bob, url.Values{"channel": {general.String()}})))
}

func TestFilesFilters(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	png := alice.Upload(general, "pic.png", tinyPNG(t), http.StatusCreated)
	pdf := alice.Upload(general, "50%_off notes.pdf", []byte("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"), http.StatusCreated)
	zip := bob.Upload(general, "pack.zip", []byte("PK\x03\x04rest-of-zip"), http.StatusCreated)
	bin := bob.Upload(general, "blob.bin", []byte{0, 1, 2, 3, 0xff}, http.StatusCreated)
	alice.SendWith(general, "", png.ID, pdf.ID)
	bob.SendWith(general, "the wingspan rules", zip.ID, bin.ID)

	kinds := func(k string) []string { return fileNames(listFiles(t, bob, url.Values{"kind": {k}})) }
	require.Equal(t, []string{"pic.png"}, kinds("image"))
	require.Equal(t, []string{"50%_off notes.pdf"}, kinds("document"))
	require.Equal(t, []string{"pack.zip"}, kinds("archive"))
	require.Equal(t, []string{"blob.bin"}, kinds("other"))
	require.Equal(t, []string{"pack.zip", "50%_off notes.pdf"}, kinds("archive,document"))

	require.Equal(t, []string{"blob.bin", "pack.zip"}, fileNames(listFiles(t, alice, url.Values{"uploader": {bob.User.ID.String()}})))

	q := func(s string) []string { return fileNames(listFiles(t, bob, url.Values{"q": {s}})) }
	require.Equal(t, []string{"50%_off notes.pdf"}, q("NOTES"), "file names match case-insensitively")
	require.Equal(t, []string{"50%_off notes.pdf"}, q("50%_"), "% and _ are literal")
	require.Empty(t, q("5_%"))
	require.Equal(t, []string{"blob.bin", "pack.zip"}, q("wingspan"), "captions match")

	bob.Fail(http.MethodGet, "/api/files?kind=music", nil, http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestFilesPagination(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	var ids []id.ID
	for i := 0; i < 5; i++ {
		a := alice.Upload(general, "f.txt", []byte("x"), http.StatusCreated)
		alice.SendWith(general, "", a.ID)
		ids = append(ids, a.ID)
	}
	first := listFiles(t, alice, url.Values{"limit": {"3"}})
	require.Len(t, first.Items, 3)
	require.Equal(t, ids[4], first.Items[0].Attachment.ID)
	require.NotNil(t, first.NextCursor)
	second := listFiles(t, alice, url.Values{"limit": {"3"}, "before": {first.NextCursor.String()}})
	require.Len(t, second.Items, 2)
	require.Equal(t, ids[1], second.Items[0].Attachment.ID)
	require.Nil(t, second.NextCursor)

	// Deleting the message removes its files from the gallery.
	m := alice.SendWith(general, "", alice.Upload(general, "gone.txt", []byte("x"), http.StatusCreated).ID)
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+m.ID.String(), nil, http.StatusNoContent, nil)
	require.NotContains(t, fileNames(listFiles(t, alice, url.Values{})), "gone.txt")
}
```

The `wav()` header layout matches `silentWav()` in the e2e spec. If `http.DetectContentType` doesn't classify it as `audio/wave`, copy the exact bytes from `clients/web/e2e/chat.spec.ts:43-60`.

- [ ] **Step 4: Run the tests and confirm they fail.**

Run: `cd server && go test ./internal/messages/ -run 'TestFiles' -count=1`
Expected: a compile error, `undefined: messages.FilesPage`.

- [ ] **Step 5: Implement `server/internal/messages/files.go`.**

```go
package messages

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// FileItem is one file in the gallery: the attachment, its message, and where it was posted
// (a thread's file carries the thread; clients tag it with parent_name).
type FileItem struct {
	Attachment files.Attachment `json:"attachment"`
	Message    Message          `json:"message"`
	Channel    ChannelRef       `json:"channel"`
	Kind       string           `json:"kind" enum:"image,video,audio,document,archive,other"`
}

type FilesPage struct {
	Items      []FileItem `json:"items"`
	NextCursor *id.ID     `json:"next_cursor,omitempty" doc:"Pass as before= for the next page"`
}

// kindSQL classifies attachment a by its sniffed type (without parameters). Mirrored in
// clients/web/src/app/gallery/kinds.ts: change both together.
const kindSQL = `(CASE
	WHEN a.gif OR split_part(a.content_type, ';', 1) LIKE 'image/%' THEN 'image'
	WHEN split_part(a.content_type, ';', 1) LIKE 'video/%' THEN 'video'
	WHEN split_part(a.content_type, ';', 1) LIKE 'audio/%' THEN 'audio'
	WHEN split_part(a.content_type, ';', 1) LIKE 'text/%'
		OR split_part(a.content_type, ';', 1) IN ('application/pdf', 'application/json', 'application/rtf', 'application/msword',
			'application/vnd.ms-excel', 'application/vnd.ms-powerpoint')
		OR split_part(a.content_type, ';', 1) LIKE 'application/vnd.openxmlformats-officedocument.%'
		OR split_part(a.content_type, ';', 1) LIKE 'application/vnd.oasis.opendocument.%' THEN 'document'
	WHEN split_part(a.content_type, ';', 1) IN ('application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed',
		'application/vnd.rar', 'application/x-tar', 'application/gzip', 'application/x-gzip', 'application/x-bzip2', 'application/x-xz') THEN 'archive'
	ELSE 'other' END)`

var fileKinds = map[string]bool{"image": true, "video": true, "audio": true, "document": true, "archive": true, "other": true}

const filesPageMax = 100

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

type FilesQuery struct {
	Kinds    []string
	Channels []id.ID // nil: every readable channel
	Uploader *id.ID
	Text     string
	Before   *id.ID
	Limit    int
}

// Files lists the files userID can read outside DMs, newest first (spec: global gallery).
func (s *Service) Files(ctx context.Context, userID id.ID, fq FilesQuery) (*FilesPage, error) {
	scope, err := s.channels.Readable(ctx, userID)
	if err != nil {
		return nil, err
	}
	if fq.Channels != nil {
		readable := map[id.ID]bool{}
		for _, c := range scope {
			readable[c] = true
		}
		var narrowed []id.ID
		for _, c := range fq.Channels {
			if readable[c] {
				narrowed = append(narrowed, c)
			}
		}
		scope = narrowed
	}
	page := &FilesPage{Items: []FileItem{}}
	if len(scope) == 0 {
		return page, nil
	}
	var args []any
	add := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	sc := add(id.Int64s(scope))
	conds := []string{
		"a.message_id IS NOT NULL", "NOT m.deleted", "c.type <> 'dm'",
		"(a.channel_id = ANY(" + sc + ") OR (c.type = 'thread' AND c.parent_channel_id = ANY(" + sc + ")))",
	}
	if len(fq.Kinds) > 0 {
		conds = append(conds, kindSQL+" = ANY("+add(fq.Kinds)+")")
	}
	if fq.Uploader != nil {
		conds = append(conds, "a.uploader_id = "+add(*fq.Uploader))
	}
	if fq.Text != "" {
		p := add(fq.Text)
		conds = append(conds, "(a.filename ILIKE '%' || "+add(likeEscaper.Replace(fq.Text))+" || '%'"+
			" OR to_tsvector('simple', m.content) @@ plainto_tsquery('simple', "+p+"))")
	}
	if fq.Before != nil {
		conds = append(conds, "a.id < "+add(*fq.Before))
	}
	rows, err := s.db.Query(ctx, `SELECT a.id, a.message_id, `+kindSQL+`
		FROM attachments a JOIN messages m ON m.id = a.message_id JOIN channels c ON c.id = a.channel_id
		WHERE `+strings.Join(conds, " AND ")+` ORDER BY a.id DESC LIMIT `+add(fq.Limit+1), args...)
	if err != nil {
		return nil, err
	}
	type hit struct {
		att, msg id.ID
		kind     string
	}
	var hits []hit
	for rows.Next() {
		var h hit
		if err := rows.Scan(&h.att, &h.msg, &h.kind); err != nil {
			rows.Close()
			return nil, err
		}
		hits = append(hits, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(hits) > fq.Limit {
		hits = hits[:fq.Limit]
		next := hits[len(hits)-1].att
		page.NextCursor = &next
	}
	if len(hits) == 0 {
		return page, nil
	}
	attIDs := make([]id.ID, len(hits))
	msgIDs := make([]id.ID, 0, len(hits))
	seen := map[id.ID]bool{}
	for i, h := range hits {
		attIDs[i] = h.att
		if !seen[h.msg] {
			seen[h.msg] = true
			msgIDs = append(msgIDs, h.msg)
		}
	}
	atts, err := s.attachments.ForIDs(ctx, attIDs)
	if err != nil {
		return nil, err
	}
	mrows, err := s.db.Query(ctx, `SELECT `+messageCols+` FROM messages WHERE id = ANY($1)`, id.Int64s(msgIDs))
	if err != nil {
		return nil, err
	}
	ms, err := collectMessages(mrows)
	if err != nil {
		return nil, err
	}
	if err := s.hydrate(ctx, ms); err != nil {
		return nil, err
	}
	byID := make(map[id.ID]Message, len(ms))
	for _, m := range ms {
		byID[m.ID] = m
	}
	refs, err := s.channelRefs(ctx, channelIDsOf(ms))
	if err != nil {
		return nil, err
	}
	for _, h := range hits {
		m, ok := byID[h.msg]
		a, aok := atts[h.att]
		if !ok || !aok {
			continue // deleted between the two queries
		}
		page.Items = append(page.Items, FileItem{Attachment: a, Message: m, Channel: refs[m.ChannelID], Kind: h.kind})
	}
	return page, nil
}

func parseIDList(raw, what string) ([]id.ID, error) {
	if raw == "" {
		return nil, nil
	}
	out := []id.ID{}
	for _, p := range strings.Split(raw, ",") {
		v, err := id.Parse(strings.TrimSpace(p))
		if err != nil {
			return nil, httpx.BadRequest("VALIDATION_FAILED", what+" must be IDs separated by commas")
		}
		out = append(out, v)
	}
	return out, nil
}

func registerFiles(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("list-files", http.MethodGet, "/api/files", 0),
		func(ctx context.Context, in *struct {
			Kind     string `query:"kind" doc:"Comma-separated: image, video, audio, document, archive, other"`
			Channel  string `query:"channel" doc:"Comma-separated channel IDs; a channel includes its threads"`
			Uploader string `query:"uploader"`
			Q        string `query:"q" maxLength:"100" doc:"Matches file names and captions"`
			Before   string `query:"before" doc:"next_cursor from the previous page"`
			Limit    int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
		}) (*struct{ Body *FilesPage }, error) {
			me := auth.Current(ctx).User.ID
			if !s.searchLimit.Allow(me.String()) {
				return nil, httpx.RateLimited()
			}
			fq := FilesQuery{Text: strings.TrimSpace(in.Q), Limit: min(max(in.Limit, 1), filesPageMax)}
			if in.Kind != "" {
				for _, k := range strings.Split(in.Kind, ",") {
					k = strings.TrimSpace(k)
					if !fileKinds[k] {
						return nil, httpx.BadRequest("VALIDATION_FAILED", "kind must be image, video, audio, document, archive or other")
					}
					fq.Kinds = append(fq.Kinds, k)
				}
			}
			var err error
			if fq.Channels, err = parseIDList(in.Channel, "channel"); err != nil {
				return nil, err
			}
			if in.Uploader != "" {
				u, err := id.Parse(in.Uploader)
				if err != nil {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "uploader must be a user ID")
				}
				fq.Uploader = &u
			}
			if in.Before != "" {
				b, err := id.Parse(in.Before)
				if err != nil {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "before must be an attachment ID")
				}
				fq.Before = &b
			}
			page, err := s.Files(ctx, me, fq)
			return &struct{ Body *FilesPage }{page}, err
		})
}
```

In `handlers.go`, add `registerFiles(api, s, op)` right after `registerSearch(api, s, op)`.

**Check before running the tests:**
- Confirm that `httpx.BadRequest("VALIDATION_FAILED", …)` is the code tests expect for bad input. `search.go` uses it.
- Confirm that the search rate limiter allows the test bursts. If `TestFilesFilters` hits `RATE_LIMITED`, give files its own `ratelimit` limiter. Copy how `searchLimit` is built in `messages.go` and double the burst.

- [ ] **Step 6: Run the tests and confirm they pass.**

Run: `cd server && go test ./internal/messages/ -run 'TestFiles' -count=1`
Expected: PASS.

Then run the whole package to catch interface fallout: `go test ./internal/messages/ ./internal/files/ -count=1`.

- [ ] **Step 7: Sanity-check the query plan.** In a test, or with `psql` against a dev database, run `EXPLAIN` on the generated SQL with a `q`. Confirm it uses `attachments_channel_idx` or the trigram index and doesn't seq-scan `messages`. If it does, wrap the `OR` as `a.id IN (SELECT … UNION SELECT …)`. This step is a note for the reviewer; no code change is expected.

- [ ] **Step 8: Checkpoint.** Run `cd server && go vet ./... && go test ./internal/messages/ ./internal/files/ -count=1`. Expect everything green. Do not commit.

---

### Task 2: Gallery channels accept any file

**Files:**
- Modify: `server/internal/messages/handlers.go:195-201` (remove the type loop), `:382-384` (message text)
- Modify: `server/internal/messages/messages_test.go:315-345` (`TestGalleryChannel`)

**Interfaces:**
- Produces: a gallery post requires ≥1 attachment of any type. The error code stays `MEDIA_ONLY`.

- [ ] **Step 1: Update the test first.** In `TestGalleryChannel`, replace the `txt` block (from `txt := bob.Upload(...)` through `require.Equal(t, 1, count, ...)`) with:

```go
	txt := bob.Upload(art.ID, "notes.txt", []byte("any file is fine"), http.StatusCreated)
	bob.Do(http.MethodPost, path, map[string]any{"content": "", "attachment_ids": []string{txt.ID.String()}}, http.StatusCreated, nil)
	song := bob.Upload(art.ID, "song.wav", wav(), http.StatusCreated)
	bob.Do(http.MethodPost, path, map[string]any{"content": "", "attachment_ids": []string{song.ID.String()}}, http.StatusCreated, nil)
```

Keep the first `bob.Fail(... "just words" ... "MEDIA_ONLY")`. Remove the now-unused `env`, `count` and `context` usage only if the compiler says they're unused. Change `env, alice, bob, _, general := setup(t)` to `_, alice, bob, _, general := setup(t)` if needed.

- [ ] **Step 2: Run the test and confirm it fails.** Run `go test ./internal/messages/ -run TestGalleryChannel -count=1`. Expected: FAIL, 400 `MEDIA_ONLY` on notes.txt.

- [ ] **Step 3: Implement the change.**
  - In `handlers.go`, delete the block `if ch.Type == channels.TypeGallery { for _, a := range m.Attachments { ... } }` inside the send transaction.
  - Change `errMediaOnly`:

```go
func errMediaOnly() error {
	return httpx.BadRequest("MEDIA_ONLY", "gallery posts need a file")
}
```

  - If `strings` becomes unused in `handlers.go`, the compiler will say so; remove the import only in that case.

- [ ] **Step 4: Run the test and confirm it passes.** Run `go test ./internal/messages/ -count=1`. Expected: PASS.

- [ ] **Step 5: Checkpoint.** Do not commit.

---

### Task 3: Playlists accept channel files, filtered per caller

**Files:**
- Modify: `server/internal/music/music.go:62-66` (`Channels` interface), `:98-118` (`MusicTrack`)
- Modify: `server/internal/music/playlists.go` (types, `itemCols`, `playlistItems`, `track()`, `insertItems`, the add handler, the get handler, the create handler)
- Modify: `server/internal/music/handlers.go:28-32,125-139` (`QueueResult`, playlist queueing)
- Create: `server/internal/music/files.go` (`attachmentTrack`)
- Test: `server/internal/music/playlists_test.go` (new `TestPlaylistFiles`), `server/internal/music/music_test.go` (one assertion inside `TestMusicBot`)

**Interfaces:**
- Consumes: migration `attachment_id` (Task 1); `channels.Service.Readable` and `Access`.
- Produces:
  - `PlaylistAdd.AttachmentID *id.ID` (json `attachment_id`).
  - `PlaylistItem.Source` ∈ `link|upload|file`.
  - `PlaylistItem.AttachmentID *id.ID` (json `attachment_id`) and `PlaylistItem.ChannelID *id.ID` (json `channel_id`, the parent channel for a thread).
  - `PlaylistDetail.Hidden int` (json `hidden`).
  - `QueueResult.SkippedUnreadable int` (json `skipped_unreadable`).
  - `MusicTrack.Source` ∈ `link|upload|file`.
  - `(s *Service) playlistItems(ctx, pid) (items []PlaylistItem, hidden int, err error)`.

- [ ] **Step 1: Write the failing test.** Append to `server/internal/music/playlists_test.go`. It needs ffmpeg for the duration probe, so it skips when ffmpeg is missing, like its neighbours. Add `wav()` as a helper in the test file; it is the same bytes as in Task 1.

```go
func TestPlaylistFiles(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	srv := alice.Server()
	secret := alice.CreateTextChannel("secret")
	alice.Do(http.MethodPut, "/api/channels/"+secret.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)

	open := alice.Upload(general, "open-song.mp3", tone(t, "2", "mp3"), http.StatusCreated)
	alice.SendWith(general, "", open.ID)
	hidden := alice.Upload(secret, "secret-song.mp3", tone(t, "2", "mp3"), http.StatusCreated)
	hm := alice.SendWith(secret, "", hidden.ID)
	notes := alice.Upload(general, "notes.txt", []byte("words"), http.StatusCreated)
	alice.SendWith(general, "", notes.ID)

	var created struct{ music.PlaylistDetail }
	alice.Do(http.MethodPost, "/api/server/music/playlists", map[string]any{"title": "Mix"}, http.StatusCreated, &created)
	pl := "/api/server/music/playlists/" + created.ID.String()
	alice.Do(http.MethodPost, pl+"/items", map[string]any{"attachment_id": open.ID}, http.StatusCreated, nil)
	alice.Do(http.MethodPost, pl+"/items", map[string]any{"attachment_id": hidden.ID}, http.StatusCreated, nil)
	alice.Fail(http.MethodPost, pl+"/items", map[string]any{"attachment_id": notes.ID}, http.StatusBadRequest, "NOT_AUDIO")
	// bob may not add a file he cannot read, even to his own playlist.
	var bobs struct{ music.PlaylistDetail }
	bob.Do(http.MethodPost, "/api/server/music/playlists", map[string]any{"title": "Bob's"}, http.StatusCreated, &bobs)
	bob.Fail(http.MethodPost, "/api/server/music/playlists/"+bobs.ID.String()+"/items",
		map[string]any{"attachment_id": hidden.ID}, http.StatusNotFound, "NOT_FOUND")

	var mine, his music.PlaylistDetail
	alice.Do(http.MethodGet, pl, nil, http.StatusOK, &mine)
	require.Equal(t, []string{"open-song", "secret-song"}, itemTitles(mine.Items))
	require.Equal(t, "file", mine.Items[0].Source)
	require.Equal(t, general, *mine.Items[0].ChannelID)
	require.Equal(t, open.ID, *mine.Items[0].AttachmentID)
	require.Greater(t, mine.Items[0].Duration, 0)
	require.Zero(t, mine.Hidden)

	bob.Do(http.MethodGet, pl, nil, http.StatusOK, &his)
	require.Equal(t, []string{"open-song"}, itemTitles(his.Items))
	require.Equal(t, 1, his.Hidden)

	// Deleting the message deletes its attachment, which removes the item.
	alice.Do(http.MethodDelete, "/api/channels/"+secret.String()+"/messages/"+hm.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodGet, pl, nil, http.StatusOK, &mine)
	require.Equal(t, []string{"open-song"}, itemTitles(mine.Items))
}
```

Imports to add: `"github.com/datrope/datrope/server/internal/perms"`.

**If `alice.Server()` or `CreateTextChannel` don't exist** on the apptest Client: they do (`apptest.go:156,471`).

**If `tone(t, "2", "mp3")` is in `music_test.go` (same package `music_test`):** reuse it as is.

- [ ] **Step 2: Run the test and confirm it fails.** Run `cd server && go test ./internal/music/ -run TestPlaylistFiles -count=1`. Expected: FAIL. Either the item is not added (`VALIDATION_FAILED`, "give a query…") or a compile error on `Hidden` / `ChannelID`.

- [ ] **Step 3: Extend the interfaces and types.**

In `music.go`:

```go
// Channels is what this package needs from channels.
type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
	Readable(ctx context.Context, userID id.ID) ([]id.ID, error)
}
```

In `MusicTrack`, change the `Source` tag to `enum:"link,upload,file"` and add a private field `attachmentID id.ID // channel files: the attachment` next to `libraryID`.

In `playlists.go`:

```go
type PlaylistItem struct {
	ID           id.ID  `json:"id"`
	Title        string `json:"title"`
	Artist       string `json:"artist,omitempty"`
	Duration     int    `json:"duration" doc:"Seconds; 0 when unknown"`
	Source       string `json:"source" enum:"link,upload,file"`
	Site         string `json:"site,omitempty"`
	URL          string `json:"url,omitempty"`
	Cover        string `json:"cover,omitempty"`
	TrackID      *id.ID `json:"track_id,omitempty" doc:"The library track, for uploads"`
	AttachmentID *id.ID `json:"attachment_id,omitempty" doc:"The channel file, for files"`
	ChannelID    *id.ID `json:"channel_id,omitempty" doc:"Where the file was posted (a thread's parent)"`
	AddedBy      *id.ID `json:"added_by,omitempty"`

	search   string
	blob     string
	opus     bool
	coverSum string
}

type PlaylistDetail struct {
	MusicPlaylist
	Items  []PlaylistItem `json:"items"`
	Hidden int            `json:"hidden" doc:"Files left out because you cannot read their channel"`
}

type PlaylistAdd struct {
	Query        string `json:"query,omitempty" maxLength:"500" doc:"A link or YouTube search words"`
	Playlist     bool   `json:"playlist,omitempty" doc:"With a link: add every track of the playlist it is in"`
	TrackID      *id.ID `json:"track_id,omitempty" doc:"A library track"`
	AttachmentID *id.ID `json:"attachment_id,omitempty" doc:"An audio file posted in a channel you can read"`
	FromChannel  *id.ID `json:"from_channel,omitempty" doc:"A voice channel: add what plays there and its queue"`
}
```

In `handlers.go`'s `QueueResult`, add:

```go
	SkippedUnreadable int `json:"skipped_unreadable" doc:"Playlist files left out because you cannot read their channel"`
```

- [ ] **Step 4: Filter the items per caller.** Replace `itemCols` and `playlistItems` in `playlists.go`:

```go
const itemCols = `i.id, i.title, coalesce(nullif(i.artist, ''), t.artist, ''), i.duration, i.site, coalesce(i.url, ''),
	coalesce(i.search, ''), i.track_id, i.attachment_id, i.added_by, coalesce(t.sha256, a.sha256, ''), coalesce(t.format, ''),
	coalesce(i.cover, t.cover, ''), CASE WHEN ac.type = 'thread' THEN ac.parent_channel_id ELSE a.channel_id END`

const itemJoins = ` FROM music_playlist_items i LEFT JOIN music_tracks t ON t.id = i.track_id
	LEFT JOIN attachments a ON a.id = i.attachment_id LEFT JOIN channels ac ON ac.id = a.channel_id`

// playlistItems lists a playlist's tracks in order, leaving out the channel files the
// signed-in user cannot read (hidden counts them).
func (s *Service) playlistItems(ctx context.Context, pid id.ID) ([]PlaylistItem, int, error) {
	if _, err := s.playlist(ctx, pid); err != nil {
		return nil, 0, err
	}
	readable, err := s.channels.Readable(ctx, auth.Current(ctx).User.ID)
	if err != nil {
		return nil, 0, err
	}
	canRead := make(map[id.ID]bool, len(readable))
	for _, c := range readable {
		canRead[c] = true
	}
	rows, err := s.db.Query(ctx, `SELECT `+itemCols+itemJoins+` WHERE i.playlist_id = $1 ORDER BY i.position`, pid)
	if err != nil {
		return nil, 0, err
	}
	all, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (PlaylistItem, error) {
		var it PlaylistItem
		var track, att, by, ch *int64
		var format string
		err := r.Scan(&it.ID, &it.Title, &it.Artist, &it.Duration, &it.Site, &it.URL, &it.search, &track, &att, &by,
			&it.blob, &format, &it.coverSum, &ch)
		it.TrackID, it.AttachmentID, it.AddedBy, it.ChannelID = id.FromNullable(track), id.FromNullable(att), id.FromNullable(by), id.FromNullable(ch)
		it.opus = format == "opus"
		switch {
		case it.AttachmentID != nil:
			it.Source = "file"
		case it.TrackID != nil:
			it.Source = "upload"
		default:
			it.Source = "link"
		}
		it.Cover = coverPath(it.coverSum)
		return it, err
	})
	if err != nil {
		return nil, 0, err
	}
	items := []PlaylistItem{}
	hidden := 0
	for _, it := range all {
		if it.AttachmentID != nil && (it.ChannelID == nil || !canRead[*it.ChannelID]) {
			hidden++
			continue
		}
		items = append(items, it)
	}
	return items, hidden, nil
}
```

`canRead[*it.ChannelID]` checks the thread's parent. `Readable` lists parents, never threads, which matches the rule that a thread follows its parent.

Update `track()`:

```go
func (it PlaylistItem) track() MusicTrack {
	t := MusicTrack{Title: it.Title, Artist: it.Artist, Duration: it.Duration, Source: it.Source, Site: it.Site, URL: it.URL,
		Cover: it.Cover, blob: it.blob, opus: it.opus, search: it.search, coverSum: it.coverSum}
	if it.TrackID != nil {
		t.libraryID = *it.TrackID
	}
	if it.AttachmentID != nil {
		t.attachmentID = *it.AttachmentID
	}
	return t
}
```

Update the 3 callers:
- `get-music-playlist`:

```go
			items, hidden, err := s.playlistItems(ctx, pid)
			return &struct{ Body PlaylistDetail }{PlaylistDetail{MusicPlaylist: pl, Items: items, Hidden: hidden}}, err
```

- `create-music-playlist`: `items, _, err := s.playlistItems(ctx, pid)`, and build `PlaylistDetail{MusicPlaylist: pl, Items: items}`.
- The queue handler in `handlers.go`:

```go
			case in.Body.PlaylistID != nil:
				if _, err := s.member(ctx); err != nil {
					return nil, err
				}
				items, hidden, err := s.playlistItems(ctx, *in.Body.PlaylistID)
				if err != nil {
					return nil, err
				}
				res.SkippedUnreadable = hidden
				for _, it := range items {
					tracks = append(tracks, it.track())
				}
				if len(tracks) == 0 {
					return nil, httpx.BadRequest("PLAYLIST_EMPTY", "the playlist has no tracks you can play")
				}
```

- [ ] **Step 5: Insert the file items.** In `insertItems`, extend the switch and the INSERT:

```go
		var link, search *string
		var trackID, attID *id.ID
		switch {
		case t.attachmentID != 0:
			attID = &t.attachmentID
		case t.blob != "":
			trackID = &t.libraryID
		case t.URL != "":
			link = &t.URL
		default:
			search = &t.search
		}
```

The INSERT column list gains `attachment_id` after `track_id`. It is placeholder `$5`, and every later placeholder shifts by one: url `$6`, search `$7`, title `$8`, artist `$9`, duration `$10`, site `$11`, cover `$12::text` (used twice), added_by `$13`. Args: `iid, pid, next, trackID, attID, link, search, t.Title, t.Artist, t.Duration, t.Site, cover, me`.

The existing `if t.coverSum != "" && t.blob == ""` guard already skips covers for files. Leave it as it is.

- [ ] **Step 6: Add `attachmentTrack` in a new file, `server/internal/music/files.go`.**

```go
package music

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// attachmentTrack makes a channel's audio file a track, for a playlist: the caller must be
// able to read it (404 otherwise, like downloading it), and it must be audio outside a DM.
func (s *Service) attachmentTrack(ctx context.Context, aid id.ID) (MusicTrack, error) {
	var filename, contentType, sum, chType string
	var channelID id.ID
	err := s.db.QueryRow(ctx, `SELECT a.filename, a.content_type, a.sha256, a.channel_id, c.type
		FROM attachments a JOIN channels c ON c.id = a.channel_id WHERE a.id = $1 AND a.message_id IS NOT NULL`, aid).
		Scan(&filename, &contentType, &sum, &channelID, &chType)
	if errors.Is(err, pgx.ErrNoRows) {
		return MusicTrack{}, httpx.NotFound("attachment")
	}
	if err != nil {
		return MusicTrack{}, err
	}
	if _, _, err := s.channels.Access(ctx, auth.Current(ctx).User.ID, channelID, perms.ReadHistory); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return MusicTrack{}, httpx.NotFound("attachment")
		}
		return MusicTrack{}, err
	}
	if chType == "dm" {
		return MusicTrack{}, httpx.BadRequest("NOT_ALLOWED_HERE", "files from direct messages can't go in playlists")
	}
	if !strings.HasPrefix(contentType, "audio/") {
		return MusicTrack{}, httpx.BadRequest("NOT_AUDIO", "only audio files can go in playlists")
	}
	title := strings.TrimSuffix(filename, filepath.Ext(filename))
	if title == "" {
		title = filename
	}
	return MusicTrack{Title: clip(title, 200), Source: "file", Duration: s.blobDuration(ctx, sum), blob: sum, attachmentID: aid}, nil
}

// blobDuration measures a stored file's length; 0 when it cannot.
func (s *Service) blobDuration(ctx context.Context, sum string) int {
	if s.blobs == nil {
		return 0
	}
	f, err := s.blobs.OpenBlob(sum)
	if err != nil {
		return 0
	}
	defer f.Close()
	tmp, err := os.CreateTemp("", "datrope-probe-*")
	if err != nil {
		return 0
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if _, err := io.Copy(tmp, f); err != nil {
		return 0
	}
	d, err := s.probe(ctx, tmp.Name())
	if err != nil {
		return 0
	}
	return d
}
```

Check before using these helpers:
- `clip(s, n)` exists in the package; `playlists.go` uses `clip(in.Body.Title, 100)`.
- `httpx.Error` is the exported error type; `files.go:159` uses `var he *httpx.Error`.

In the add handler's switch, before `case in.Body.FromChannel != nil:`, add:

```go
			case in.Body.AttachmentID != nil:
				t, err := s.attachmentTrack(ctx, *in.Body.AttachmentID)
				if err != nil {
					return nil, err
				}
				tracks = []MusicTrack{t}
```

Also change the default error text to `"give a query, a track_id, an attachment_id or from_channel"`.

- [ ] **Step 7: Run the test and confirm it passes.** Run `cd server && go test ./internal/music/ -run 'TestPlaylist' -count=1`. Expected: PASS, or SKIP without ffmpeg. If ffmpeg is missing locally, say so in the checkpoint; CI has it.

- [ ] **Step 8: Assert that the bot queue skips unreadable files.** In `TestMusicBot` (`music_test.go`), after the saved-playlist block (~line 209), add:

```go
	// A playlist file the queuer cannot read is left out and counted.
	srv := alice.Server()
	locked := alice.CreateTextChannel("locked")
	song := alice.Upload(locked, "locked.mp3", tone(t, "2", "mp3"), http.StatusCreated)
	alice.SendWith(locked, "", song.ID)
	var mix struct{ music.PlaylistDetail }
	alice.Do(http.MethodPost, "/api/server/music/playlists", map[string]any{"title": "Locked mix"}, http.StatusCreated, &mix)
	alice.Do(http.MethodPost, "/api/server/music/playlists/"+mix.ID.String()+"/items", map[string]any{"attachment_id": song.ID}, http.StatusCreated, nil)
	alice.Do(http.MethodPost, "/api/server/music/playlists/"+mix.ID.String()+"/items", map[string]any{"track_id": lt.ID}, http.StatusCreated, nil)
	alice.Do(http.MethodPut, "/api/channels/"+locked.String()+"/overrides/member/"+alice.User.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)
	var q music.QueueResult
	alice.Do(http.MethodPost, base, map[string]any{"playlist_id": mix.ID}, http.StatusCreated, &q)
	require.Equal(t, 1, q.SkippedUnreadable)
	require.Len(t, q.Tracks, 1)
```

Notes on this step:
- `lt` is the library track variable already in that test. If it's named differently there, use that name.
- The owner may bypass overrides. Check `channels.effective`. If owners can't be denied, upload in a channel denied to **@everyone** and have **carol** (a non-owner who joined the call in that test, or add her) do the queueing instead. Adapt the test to whichever actor can be denied; the assertion stays the same.

Run: `go test ./internal/music/ -run TestMusicBot -count=1`. Expected: PASS, or SKIP without ffmpeg/LiveKit.

- [ ] **Step 9: Checkpoint.** Run `cd server && go vet ./... && go test ./internal/music/ ./internal/messages/ -count=1`. Do not commit.

---

### Task 4: Stream library tracks to browsers

The personal player plays playlist "upload" items, and there is no route for that today.

**Files:**
- Modify: `server/internal/music/tracks.go` (add `AudioHandler`)
- Modify: `server/internal/app/app.go:201-202` (mount it)
- Test: `server/internal/music/music_test.go` (a small new test)

**Interfaces:**
- Produces: `GET /api/music/tracks/{trackID}/audio`. Server members only. Serves the stored blob with `audio/ogg` for Opus, otherwise the sniffed type. Supports Range requests through `ServeBlob`.

- [ ] **Step 1: Write the failing test.**

```go
func TestLibraryAudio(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	env := apptest.New(t)
	alice := env.Register("alice")
	outsider := env.Outsider("eve")
	raw := alice.UploadForm(http.MethodPost, "/api/server/music", "tone.mp3", tone(t, "2", "mp3"), map[string]string{"title": "Beep"}, http.StatusCreated)
	var lt music.LibraryTrack
	require.NoError(t, json.Unmarshal(raw, &lt))
	res, body := alice.Raw(http.MethodGet, "/api/music/tracks/"+lt.ID.String()+"/audio", nil, "", http.StatusOK)
	require.Equal(t, "audio/ogg", res.Header.Get("Content-Type"))
	require.NotEmpty(t, body)
	outsider.Raw(http.MethodGet, "/api/music/tracks/"+lt.ID.String()+"/audio", nil, "", http.StatusForbidden)
	alice.Raw(http.MethodGet, "/api/music/tracks/1/audio", nil, "", http.StatusNotFound)
}
```

(`env.Outsider` is at `apptest.go:149`. Check that `Raw`'s signature matches `apptest.go:372`.)

- [ ] **Step 2: Run the test and confirm it fails.** Run `go test ./internal/music/ -run TestLibraryAudio -count=1`. Expected: FAIL, a 404 from the mux.

- [ ] **Step 3: Implement the handler.** In `tracks.go`:

```go
// AudioHandler serves a library track's file to members, for the gallery's player.
// It must run behind RequireHTTP.
func (s *Service) AudioHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := s.member(r.Context()); err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		tid, err := httpx.ParseID(r.PathValue("trackID"), "track")
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		lt, err := s.libraryTrack(r.Context(), tid)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		ct := "audio/ogg"
		if lt.format != "opus" {
			ct = "application/octet-stream"
			if f, err := s.blobs.OpenBlob(lt.sum); err == nil {
				head := make([]byte, 512)
				n, _ := io.ReadFull(f, head)
				f.Close()
				ct = http.DetectContentType(head[:n])
			}
		}
		s.blobs.ServeBlob(w, r, lt.sum, ct, true)
	})
}
```

Check before wiring it up:
- `httpx.WriteHTTPError` accepts any error. `CoverHandler` passes an `httpx.NotFound`; if the function only accepts `*httpx.Error`, unwrap first.
- The `io` import exists in `tracks.go`.

In `app.go`, next to the cover route, add:

```go
		mux.Handle("GET /api/music/tracks/{trackID}/audio", authSvc.RequireHTTP(musicSvc.AudioHandler()))
```

- [ ] **Step 4: Run the test and confirm it passes.** Run `go test ./internal/music/ -run TestLibraryAudio -count=1`. Expected: PASS or SKIP.

- [ ] **Step 5: Checkpoint.** Run `cd server && go test ./... -count=1` (the full server suite). Do not commit.

---

## Phase B: Core client

### Task 5: Regenerate the API types and add client methods

**Files:**
- Modify: `clients/core/openapi.json`, `clients/core/src/schema.d.ts` (generated)
- Modify: `clients/core/src/client.ts` (after `search()` at ~line 503; the import list at line 8)
- Modify: `clients/core/src/index.ts` or wherever schema types are re-exported. Find `export type SearchResponse` and follow its pattern.
- Test: `clients/core/src/client.test.ts`, if it exists with fetch mocks; otherwise rely on the typecheck.

**Interfaces:**
- Produces:
  - Types `FileItem`, `FilesPage`, `FileKind = FileItem["kind"]` exported from `@datrope/core`.
  - `client.files(p: FilesParams): Promise<FilesPage>`, where `type FilesParams = { kinds?: FileKind[]; channels?: string[]; uploader?: string; q?: string; before?: string; limit?: number }`.
  - `client.libraryAudioUrl(trackId: string): string`.

- [ ] **Step 1: Regenerate.** From `clients/core`, run `pnpm gen`. Expected: `schema.d.ts` gains `FileItem`, `FilesPage`, `/api/files`, `attachment_id` on `PlaylistAdd`/`PlaylistItem`, `hidden` on `PlaylistDetail`, and `skipped_unreadable` on `QueueResult`.

- [ ] **Step 2: Export the types.** Find how `SearchResponse` is exported (`grep -n "SearchResponse" clients/core/src/*.ts`) and add `FileItem` and `FilesPage` the same way. Add `export type FileKind = FileItem["kind"];` next to them.

- [ ] **Step 3: Add the client methods** below `search()`:

```ts
  /** Files in channels the caller can read (not DMs), newest first. */
  async files(p: FilesParams = {}): Promise<FilesPage> {
    const query: Record<string, string | number> = {};
    if (p.kinds?.length) query.kind = p.kinds.join(",");
    if (p.channels?.length) query.channel = p.channels.join(",");
    if (p.uploader) query.uploader = p.uploader;
    if (p.q) query.q = p.q;
    if (p.before) query.before = p.before;
    if (p.limit) query.limit = p.limit;
    return unwrap(this.api.GET("/api/files", { params: { query } }));
  }

  /** Where a library track's audio is served, for the browser's own player. */
  libraryAudioUrl(trackId: string): string {
    return this.url(`/api/music/tracks/${trackId}/audio`);
  }
```

Also export `export type FilesParams = { kinds?: FileKind[]; channels?: string[]; uploader?: string; q?: string; before?: string; limit?: number };` from the same module.

- [ ] **Step 4: Typecheck.** From the repo root, run `pnpm -r typecheck`. Expected: PASS. Fix any web compile errors caused by `PlaylistDetail` gaining `hidden`; it's additive, so there should be none.

- [ ] **Step 5: Checkpoint.** Do not commit.

---

## Phase C: Gallery UI

### Task 6: File kinds in TS (mirrors `kindSQL`)

**Files:**
- Create: `clients/web/src/app/gallery/kinds.ts`
- Create: `clients/web/src/app/gallery/kinds.test.ts`
- Modify: `clients/web/src/app/gallery/items.ts` (drop `isMedia`, `isMediaFile` and `galleryItems`; keep `sections` and `itemTitle`; retype `GalleryItem`)
- Modify: `clients/web/src/app/gallery/items.test.ts` (delete the `isMedia`, `isMediaFile` and `galleryItems` describes; keep the `sections` tests and retarget their item factory)

**Interfaces:**
- Produces:
  - `fileKind(contentType: string, gif?: boolean): FileKind`
  - `KIND_LABELS: Record<FileKind, string>`; the tile prefix uses the singular from `KIND_SINGULAR`.
  - `KIND_ORDER: FileKind[]`
  - `extension(filename): string`
  - The new `GalleryItem` type.

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from "vitest";
import { extension, fileKind } from "./kinds";

describe("fileKind", () => {
  it.each([
    ["image/png", false, "image"], ["application/octet-stream", true, "image"], ["video/webm", false, "video"],
    ["audio/mpeg", false, "audio"], ["audio/wave", false, "audio"],
    ["text/plain; charset=utf-8", false, "document"], ["application/pdf", false, "document"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", false, "document"],
    ["application/vnd.oasis.opendocument.text", false, "document"], ["application/json", false, "document"],
    ["application/zip", false, "archive"], ["application/x-7z-compressed", false, "archive"], ["application/gzip", false, "archive"],
    ["application/octet-stream", false, "other"], ["", false, "other"],
  ] as const)("%s (gif %s) is %s", (ct, gif, kind) => {
    expect(fileKind(ct, gif)).toBe(kind);
  });
});

describe("extension", () => {
  it("is the upper-cased suffix, or FILE", () => {
    expect(extension("notes.v2.PDF")).toBe("PDF");
    expect(extension("Makefile")).toBe("FILE");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails.** Run `cd clients/web && pnpm vitest run src/app/gallery/kinds.test.ts`. Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement `kinds.ts`.**

```ts
import type { FileKind } from "@datrope/core";

export const KIND_ORDER: FileKind[] = ["image", "video", "audio", "document", "archive", "other"];
export const KIND_LABELS: Record<FileKind, string> = {
  image: "Photos", video: "Videos", audio: "Music", document: "Documents", archive: "Archives", other: "Other",
};
export const KIND_SINGULAR: Record<FileKind, string> = {
  image: "Photo", video: "Video", audio: "Track", document: "File", archive: "File", other: "File",
};

const DOCUMENTS = new Set(["application/pdf", "application/json", "application/rtf", "application/msword",
  "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]);
const ARCHIVES = new Set(["application/zip", "application/x-7z-compressed", "application/x-rar-compressed", "application/vnd.rar",
  "application/x-tar", "application/gzip", "application/x-gzip", "application/x-bzip2", "application/x-xz"]);

/** A file's kind from its sniffed type. Mirrors kindSQL in server/internal/messages/files.go: change both together. */
export function fileKind(contentType: string, gif = false): FileKind {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (gif || ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("text/") || DOCUMENTS.has(ct) || ct.startsWith("application/vnd.openxmlformats-officedocument.")
    || ct.startsWith("application/vnd.oasis.opendocument.")) return "document";
  if (ARCHIVES.has(ct)) return "archive";
  return "other";
}

/** "notes.pdf" → "PDF"; no extension → "FILE". */
export function extension(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 && i < filename.length - 1 ? filename.slice(i + 1).toUpperCase() : "FILE";
}
```

- [ ] **Step 4: Retype `items.ts`.** Replace everything above `sections` with:

```ts
import type { FileItem } from "@datrope/core";

/** A gallery tile: a file from /api/files. */
export type GalleryItem = FileItem;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const month = new Intl.DateTimeFormat("en", { month: "long" });
```

Keep `sections` unchanged; it reads `item.message.created_at`. Keep `itemTitle(it)` as is; `it.message.content` and `it.attachment.filename` still exist.

In `items.test.ts`:
- delete the `isMedia`, `isMediaFile` and `galleryItems` describes and their imports;
- for the `sections` tests, build items as `({ attachment: file(...), message: msg(...), channel: { id: "c", type: "text", name: "general" }, kind: "image" }) as GalleryItem`.

- [ ] **Step 5: Run the tests and typecheck.** Run `pnpm vitest run src/app/gallery/` and then `pnpm -r typecheck` (repo root). Expected: the tests pass. The typecheck fails in `GalleryView.tsx`, `GalleryItemPanel.tsx` and `UploadDialog.tsx` because they import removed names. That is expected; Tasks 9 and 10 fix those files. To keep the tree compiling between tasks, an implementer may leave temporary `isMedia`/`isMediaFile`/`galleryItems` re-exports in `items.ts` until Task 9 deletes them.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 7: Gallery filter ↔ URL params

**Files:**
- Create: `clients/web/src/app/gallery/filter.ts`
- Create: `clients/web/src/app/gallery/filter.test.ts`

**Interfaces:**
- Produces:
  - `type GalleryFilter = { kind: FileKind | "all"; channels: string[]; uploader: string | null; q: string; view: "tracks" | "playlists"; playlist: string | null; layout: "grid" | "list" }`
  - `parseFilter(params: URLSearchParams): GalleryFilter`
  - `filterParams(f: GalleryFilter): URLSearchParams`. It omits defaults, so a clean URL is `/gallery`.
  - `DEFAULT_FILTER`.
  - `layout` is not put in the URL; it's stored in localStorage by the view.

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER, filterParams, parseFilter } from "./filter";

describe("gallery filter params", () => {
  it("round-trips every field except layout", () => {
    const f = { ...DEFAULT_FILTER, kind: "audio" as const, channels: ["1", "2"], uploader: "9", q: "riff", view: "playlists" as const, playlist: "7" };
    expect(parseFilter(filterParams(f))).toEqual(f);
  });
  it("omits defaults", () => {
    expect(filterParams(DEFAULT_FILTER).toString()).toBe("");
  });
  it("ignores unknown kinds and views", () => {
    expect(parseFilter(new URLSearchParams("kind=music&view=x"))).toEqual(DEFAULT_FILTER);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails.** Run `pnpm vitest run src/app/gallery/filter.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement it.**

```ts
import type { FileKind } from "@datrope/core";
import { KIND_ORDER } from "./kinds";

export type GalleryFilter = {
  kind: FileKind | "all";
  channels: string[];
  uploader: string | null;
  q: string;
  view: "tracks" | "playlists"; // only under Music
  playlist: string | null; // an open playlist, under Music → Playlists
  layout: "grid" | "list";
};

export const DEFAULT_FILTER: GalleryFilter = { kind: "all", channels: [], uploader: null, q: "", view: "tracks", playlist: null, layout: "grid" };

export function parseFilter(p: URLSearchParams): GalleryFilter {
  const kind = p.get("kind");
  const view = p.get("view");
  return {
    ...DEFAULT_FILTER,
    kind: KIND_ORDER.includes(kind as FileKind) ? (kind as FileKind) : "all",
    channels: p.getAll("channel"),
    uploader: p.get("uploader"),
    q: p.get("q") ?? "",
    view: view === "playlists" ? "playlists" : "tracks",
    playlist: p.get("playlist"),
  };
}

export function filterParams(f: GalleryFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.kind !== "all") p.set("kind", f.kind);
  for (const c of f.channels) p.append("channel", c);
  if (f.uploader) p.set("uploader", f.uploader);
  if (f.q) p.set("q", f.q);
  if (f.view !== "tracks") p.set("view", f.view);
  if (f.playlist) p.set("playlist", f.playlist);
  return p;
}
```

- [ ] **Step 4: Run the test and confirm it passes.**
- [ ] **Step 5: Checkpoint.** Do not commit.

---

### Task 8: `useFiles`, paging and live updates

**Files:**
- Create: `clients/web/src/app/gallery/use-files.ts`
- Create: `clients/web/src/app/gallery/use-files.test.ts`

**Interfaces:**
- Consumes: `client.files`, `client.onEvent`, `GalleryFilter`, `FilesParams`.
- Produces:
  - `useFiles(scope: GalleryScope, f: GalleryFilter): { items: GalleryItem[]; hasMore: boolean; loading: boolean; error?: string; loadMore(): void }`
  - `type GalleryScope = { kind: "global" } | { kind: "channel"; channelId: string }`
  - Pure helpers: `mergeHead(current, head): GalleryItem[]`, `dropMessage(current, messageId): GalleryItem[]`, `paramsFor(scope, f): FilesParams`.

- [ ] **Step 1: Write the failing tests** for the pure helpers.

```ts
import type { FileItem } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER } from "./filter";
import { dropMessage, mergeHead, paramsFor } from "./use-files";

const it_ = (att: string, msg = `m${att}`) => ({ attachment: { id: att }, message: { id: msg } }) as unknown as FileItem;
const ids = (xs: FileItem[]) => xs.map((x) => x.attachment.id);

describe("mergeHead", () => {
  it("puts new files first and keeps one copy of each", () => {
    expect(ids(mergeHead([it_("5"), it_("4"), it_("3")], [it_("7"), it_("6"), it_("5"), it_("4")]))).toEqual(["7", "6", "5", "4", "3"]);
  });
  it("takes the fresh copy of a file already shown", () => {
    const fresh = { ...it_("5"), kind: "audio" } as FileItem;
    expect(mergeHead([it_("5")], [fresh])[0]).toBe(fresh);
  });
});

describe("dropMessage", () => {
  it("removes every file of a deleted message", () => {
    expect(ids(dropMessage([it_("1", "m"), it_("2", "m"), it_("3")], "m"))).toEqual(["3"]);
  });
});

describe("paramsFor", () => {
  it("pins the channel in channel scope and maps the filter", () => {
    expect(paramsFor({ kind: "channel", channelId: "c1" }, { ...DEFAULT_FILTER, kind: "audio", channels: ["x"], q: " riff " }))
      .toEqual({ kinds: ["audio"], channels: ["c1"], q: "riff", uploader: undefined });
    expect(paramsFor({ kind: "global" }, DEFAULT_FILTER)).toEqual({ kinds: undefined, channels: undefined, q: undefined, uploader: undefined });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement it.**

```ts
import type { FilesParams, Message, MessageDeleted } from "@datrope/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { client, errorText, useApp } from "../../session";
import type { GalleryFilter } from "./filter";
import type { GalleryItem } from "./items";

export type GalleryScope = { kind: "global" } | { kind: "channel"; channelId: string };

const PAGE = 50;

export function paramsFor(scope: GalleryScope, f: GalleryFilter): FilesParams {
  const q = f.q.trim();
  return {
    kinds: f.kind === "all" ? undefined : [f.kind],
    channels: scope.kind === "channel" ? [scope.channelId] : f.channels.length ? f.channels : undefined,
    q: q || undefined,
    uploader: f.uploader ?? undefined,
  };
}

/** The first page fetched again, merged over what is shown: new files first, one copy each. */
export function mergeHead(current: GalleryItem[], head: GalleryItem[]): GalleryItem[] {
  const fresh = new Map(head.map((h) => [h.attachment.id, h]));
  return [...head, ...current.filter((c) => !fresh.has(c.attachment.id))];
}

export function dropMessage(current: GalleryItem[], messageId: string): GalleryItem[] {
  return current.filter((c) => c.message.id !== messageId);
}

/** Pages through /api/files for a scope and filter; a message with files sent, edited or deleted
 *  in a channel this scope covers refetches the first page. */
export function useFiles(scope: GalleryScope, f: GalleryFilter) {
  const params = paramsFor(scope, f);
  const key = JSON.stringify(params);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const gen = useRef(0);
  const channels = useApp((s) => s.channels);

  // The search box waits 250 ms after typing; other filters apply at once.
  const [debouncedKey, setDebouncedKey] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(key), 250);
    return () => clearTimeout(t);
  }, [key]);

  useEffect(() => {
    const g = ++gen.current;
    setLoading(true);
    setError(undefined);
    client.files({ ...JSON.parse(debouncedKey), limit: PAGE })
      .then((p) => { if (g === gen.current) { setItems(p.items); setCursor(p.next_cursor ?? undefined); } })
      .catch((e) => { if (g === gen.current) setError(errorText(e)); })
      .finally(() => { if (g === gen.current) setLoading(false); });
  }, [debouncedKey]);

  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    const g = gen.current;
    setLoading(true);
    client.files({ ...JSON.parse(debouncedKey), before: cursor, limit: PAGE })
      .then((p) => { if (g === gen.current) { setItems((cur) => [...cur, ...p.items]); setCursor(p.next_cursor ?? undefined); } })
      .catch((e) => { if (g === gen.current) setError(errorText(e)); })
      .finally(() => { if (g === gen.current) setLoading(false); });
  }, [cursor, loading, debouncedKey]);

  useEffect(() => client.onEvent((type, data) => {
    if (type === "MESSAGE_DELETE") {
      setItems((cur) => dropMessage(cur, (data as MessageDeleted).id));
      return;
    }
    if (type !== "MESSAGE_CREATE" && type !== "MESSAGE_UPDATE") return;
    const m = data as Message;
    if (!m.attachments?.length) return;
    const ch = channels[m.channel_id];
    const home = ch?.type === "thread" ? ch.parent_id : m.channel_id;
    if (scope.kind === "channel" && home !== scope.channelId && m.channel_id !== scope.channelId) return;
    if (ch?.type === "dm") return;
    const g = gen.current;
    client.files({ ...JSON.parse(debouncedKey), limit: PAGE })
      .then((p) => { if (g === gen.current) setItems((cur) => mergeHead(cur, p.items)); })
      .catch(() => undefined);
  }), [channels, scope, debouncedKey]);

  return { items, hasMore: !!cursor, loading, error, loadMore };
}
```

Check before running:
- The `MessageDeleted` field name: `grep -n "MessageDeleted" -A5 clients/core/src/schema.d.ts`. It may be `{ id, channel_id }` or `{ message_id }`; use the real field.
- Thread channels' parent field: `grep -n "parent" clients/core/src/schema.d.ts | grep -i channel`. Use the real name (`parent_id` or `parent_channel_id`).
- `MessageDeleted`, `Message` and `FilesParams` are exported from `@datrope/core`. If `MessageDeleted` isn't exported, import `Schemas` and use `Schemas["MessageDeleted"]` as `types.ts` does.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm vitest run src/app/gallery/use-files.test.ts`.
- [ ] **Step 5: Checkpoint.** Do not commit.

---

### Task 9: The shared `GalleryView`: filter bar, tiles, upload of any file

**Files:**
- Rewrite: `clients/web/src/app/gallery/GalleryView.tsx`
- Create: `clients/web/src/app/gallery/FileTile.tsx` (tile per kind, channel tag, "…" menu slot)
- Create: `clients/web/src/app/gallery/ChannelFilter.tsx` (Popover + Command multi-select)
- Modify: `clients/web/src/app/gallery/UploadDialog.tsx` (any file)
- Modify: `clients/web/src/app/Home.tsx:43-52` (pass `scope`)

**Interfaces:**
- Consumes: `useFiles`, `GalleryFilter`, `parseFilter`/`filterParams`, `KIND_*`, `fileKind`, `extension`.
- Produces:
  - `GalleryView({ scope }: { scope: GalleryScope })`
  - `FileTile({ item, global, selected, playing, onOpen, menu }: { item: GalleryItem; global: boolean; selected: boolean; playing: boolean; onOpen(): void; menu?: ReactNode })`
  - `channelTag(item): string`, which returns the channel name (the parent's for a thread), exported from `FileTile.tsx`.
  - `discToken(sum: string): string`, a CSS var from `--avatar-1…8` chosen by the attachment id. There is no hash on the client, so the id is used.

- [ ] **Step 1: Write `ChannelFilter.tsx`.**

```tsx
import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RefButton } from "@/components/ref-button";
import { cn } from "@/lib/utils";
import { useApp } from "../../session";

const LISTED = new Set(["text", "announcement", "forum", "gallery", "voice", "webhook"]);

/** "In channel": pick any number of channels; none picked means every channel. */
export function ChannelFilter({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const channels = useApp((s) => s.channels);
  const order = useApp((s) => s.server?.channelIds ?? []);
  const options = useMemo(() => order.map((id) => channels[id]).filter((c) => c && LISTED.has(c.type)), [order, channels]);
  const label = value.length === 0 ? "All" : value.length === 1 ? `#${channels[value[0]]?.name ?? "1 channel"}` : `${value.length} channels`;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <RefButton variant="outline" size="sm" aria-label={`In channel: ${label}`}
          className={cn("h-7 gap-1.5 text-[13px] font-normal", value.length > 0 && "border-primary bg-primary/10 text-primary")}>
          In channel: {label}<ChevronDown className="size-3.5" />
        </RefButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-0">
        <Command>
          <CommandInput placeholder="Find a channel" aria-label="Find a channel" />
          <CommandList>
            <CommandEmpty>No channel.</CommandEmpty>
            <CommandGroup>
              {options.map((c) => (
                <CommandItem key={c.id} value={c.name} onSelect={() => toggle(c.id)} aria-selected={value.includes(c.id)}>
                  <Check className={cn("size-4", !value.includes(c.id) && "invisible")} />#{c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {value.length > 0 && (
            <button type="button" className="w-full border-t px-3 py-2 text-left text-sm text-muted-foreground hover:text-foreground"
              onClick={() => onChange([])}>Clear selection</button>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

Confirm `RefButton`'s props (`grep -n "export" clients/web/src/components/ref-button.tsx`). If it doesn't accept `variant`/`size`, use `React.forwardRef` around `Button`, as `InboxButton` does.

- [ ] **Step 2: Write `FileTile.tsx`.**

```tsx
import { FileArchive, FileText, File as FileIcon, Hash, Music, Play } from "lucide-react";
import type { ReactNode } from "react";
import { UserAvatar } from "@/components/user-avatar";
import { attachmentImage } from "@/lib/sized-image";
import { cn } from "@/lib/utils";
import { client, displayName, formatBytes } from "../../session";
import { shownAuthor } from "../message-author";
import { extension, KIND_SINGULAR } from "./kinds";
import { itemTitle, type GalleryItem } from "./items";

/** Where a file was posted, as tagged: a thread's file shows its parent channel. */
export function channelTag(item: GalleryItem): string {
  return item.channel.parent_name || item.channel.name;
}

/** A stable colour per file from the avatar palette tokens. */
export function discToken(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `var(--avatar-${(Math.abs(h) % 8) + 1})`;
}

export function tileLabel(item: GalleryItem, global: boolean): string {
  const base = `${KIND_SINGULAR[item.kind]}: ${itemTitle(item)}, by ${displayName(shownAuthor(item.message))}`;
  return global ? `${base}, in #${channelTag(item)}` : base;
}

export function FileTile({ item, global, selected, playing, onOpen, onPlay, menu }: {
  item: GalleryItem; global: boolean; selected: boolean; playing: boolean;
  onOpen: () => void; onPlay?: () => void; menu?: ReactNode;
}) {
  const { attachment: a, message: m, kind } = item;
  const media = kind === "image" || kind === "video";
  return (
    <div className={cn("group relative aspect-square overflow-hidden rounded-md", media ? "bg-muted" : "border bg-card",
      selected && "ring-2 ring-primary", playing && "ring-2 ring-primary")}>
      <button type="button" onClick={onOpen} aria-label={tileLabel(item, global)}
        className="absolute inset-0 grid outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring">
        {media ? (
          kind === "video" && !a.thumbnail_url
            ? <video src={client.url(a.url)} preload="metadata" muted playsInline className="pointer-events-none size-full object-cover" />
            : <img {...attachmentImage(a, 240, { cover: true })} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <span className={cn("flex min-h-0 flex-col p-2.5 text-left", global ? "pt-9" : "pt-3")}>
            <span className="grid flex-1 place-items-center" aria-hidden>
              {kind === "audio" ? (
                <span className="grid size-16 place-items-center rounded-full text-foreground" style={{ background: discToken(a.id) }}>
                  <Music className="size-7" />
                </span>
              ) : (
                <span className="relative grid h-16 w-13 place-items-end justify-center rounded-md bg-secondary pb-2 text-[11px] font-bold text-foreground">
                  {kind === "archive" ? <FileArchive className="absolute top-2 size-5" /> : kind === "document" ? <FileText className="absolute top-2 size-5" /> : <FileIcon className="absolute top-2 size-5" />}
                  {extension(a.filename)}
                </span>
              )}
            </span>
            <span className="line-clamp-2 text-[13px] leading-tight font-semibold wrap-anywhere text-foreground">{a.filename}</span>
            <span className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {playing ? "Playing · " : ""}{formatBytes(a.size)} · {displayName(shownAuthor(m))}
            </span>
          </span>
        )}
      </button>
      {global && (
        <span className={cn("pointer-events-none absolute top-1.5 left-1.5 inline-flex h-5 max-w-[calc(100%-2.5rem)] items-center gap-0.5 rounded-full pr-2 pl-1 text-[11px] font-semibold text-foreground",
          media ? "bg-background/85" : "bg-muted")} aria-hidden>
          <Hash className="size-3 flex-none" /><span className="truncate">{channelTag(item)}</span>
        </span>
      )}
      {media && <UserAvatar user={shownAuthor(m)} size="xs" className="pointer-events-none absolute bottom-1.5 left-1.5" />}
      {kind === "video" && (
        <span className="pointer-events-none absolute right-1.5 bottom-1.5 inline-flex h-5 items-center rounded bg-background/85 px-1.5 text-foreground" aria-hidden>
          <Play className="size-2.5 fill-current" />
        </span>
      )}
      {kind === "audio" && onPlay && (
        <button type="button" onClick={onPlay} aria-label={`Play ${a.filename}`}
          className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-md group-hover:opacity-100 focus-visible:opacity-100">
          <Play className="size-4 fill-current" />
        </button>
      )}
      {menu && <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">{menu}</div>}
    </div>
  );
}
```

Tile durations: the spec's lazy `<audio preload="metadata">` duration is **deferred**. The tile shows size, the player shows duration, and the track list (Task 13) reads durations. Noted as a scope trim; YAGNI for v1.

- [ ] **Step 3: Rewrite `GalleryView.tsx`.** It keeps the TopBar, read ack, panel switching and upload button for channel scope.

```tsx
import { Perm, canPost, hasPerm } from "@datrope/core";
import { Images, Search, Upload, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { client, displayName, useApp, usePerms } from "../../session";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Toggle } from "@/components/ui/toggle";
import { useWindowFocus } from "@/hooks/use-window-focus";
import { EmojiText } from "@/chat/EmojiText";
import { Topic } from "../ChannelView";
import { EmptyView } from "../EmptyView";
import { SearchPanel } from "../search/SearchPanel";
import { TopBar } from "../TopBar";
import { closePanel, openPanel, panelStore, usePanel } from "../side-panel/panel";
import { ThreadPanel } from "../side-panel/ThreadPanel";
import { ChannelFilter } from "./ChannelFilter";
import { FileTile } from "./FileTile";
import { DEFAULT_FILTER, filterParams, parseFilter, type GalleryFilter } from "./filter";
import { GalleryItemPanel } from "./GalleryItemPanel";
import { sections } from "./items";
import { KIND_LABELS, KIND_ORDER } from "./kinds";
import { MusicView } from "./MusicView";
import { UploadDialog } from "./UploadDialog";
import { useFiles, type GalleryScope } from "./use-files";

const chip = "h-7 rounded-full px-3 text-[13px] font-normal text-muted-foreground data-[state=on]:border-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground";
const note = "m-0 p-8 text-center text-sm text-muted-foreground";

/** A gallery of files, newest first: one channel's, or (global) every channel the viewer can read. */
export function GalleryView({ scope }: { scope: GalleryScope }) {
  const channelId = scope.kind === "channel" ? scope.channelId : undefined;
  const ch = useApp((s) => (channelId ? s.channels[channelId] : undefined));
  const perms = usePerms(channelId);
  const panel = usePanel((s) => s.panel);
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => parseFilter(params), [params]);
  const setFilter = (patch: Partial<GalleryFilter>) => setParams(filterParams({ ...filter, ...patch }), { replace: true });
  const files = useFiles(scope, filter);
  const groups = useMemo(() => sections(files.items, new Date()), [files.items]);
  const members = useApp((s) => s.server?.members);
  const uploaders = useMemo(() => Object.values(members ?? {}).map((m) => [m.user.id, displayName(m.user)] as const)
    .sort((a, b) => a[1].localeCompare(b[1])), [members]);
  const uploaderId = useId();
  const [uploading, setUploading] = useState(false);
  const global = scope.kind === "global";

  useEffect(() => {
    const p = panelStore.getState().panel;
    if (p?.kind === "threads" || p?.kind === "post" || p?.kind === "media" || (p?.kind === "thread" && p.parentId !== channelId)) closePanel();
  }, [channelId]);

  // Seeing a gallery channel marks it read.
  const newest = useApp((s) => (channelId ? s.channels[channelId]?.last_message_id : undefined));
  const focused = useWindowFocus();
  useEffect(() => {
    if (channelId && newest && focused) client.ack(channelId, newest).catch(() => undefined);
  }, [channelId, newest, focused]);

  // Infinite scroll: load the next page when the sentinel shows.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !files.hasMore) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) files.loadMore(); });
    io.observe(el);
    return () => io.disconnect();
  }, [files.hasMore, files.loadMore]);

  if (scope.kind === "channel" && !ch) return <EmptyView>This channel is not available.</EmptyView>;
  const canUpload = !!ch && canPost(ch, perms) && hasPerm(perms, Perm.AttachFiles);
  const selected = panel?.kind === "media" ? panel : undefined;
  const filtered = filter.kind !== "all" || filter.q.trim() !== "" || filter.uploader !== null || filter.channels.length > 0;
  const count = `${files.items.length}${files.hasMore ? "+" : ""} ${files.items.length === 1 && !files.hasMore ? "item" : "items"}`;
  const music = filter.kind === "audio";

  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-background" aria-label={global ? "Gallery" : ch!.name}>
        <TopBar actions={canUpload && <Button size="sm" onClick={() => setUploading(true)}><Upload /> Upload</Button>}>
          <Images className="size-4 flex-none text-muted-foreground" aria-hidden />
          {global ? (
            <>
              <h2 className="flex-none">Gallery</h2>
              <span className="truncate text-sm text-muted-foreground">Files from every channel</span>
            </>
          ) : (
            <>
              <h2 className="flex-none"><EmojiText text={ch!.name} /></h2>
              {ch!.topic && <Topic channelId={ch!.id} name={ch!.name} topic={ch!.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
            </>
          )}
        </TopBar>

        <div className="flex flex-none flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="relative w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={filter.q} onChange={(e) => setFilter({ q: e.target.value })} placeholder="Search files" aria-label="Search files"
              className="h-8 pr-8 pl-8" />
            {filter.q && (
              <button type="button" aria-label="Clear search" onClick={() => setFilter({ q: "" })}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
            )}
          </div>
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            <Toggle variant="outline" size="sm" className={chip} pressed={filter.kind === "all"} onPressedChange={() => setFilter({ kind: "all", view: "tracks", playlist: null })}>All</Toggle>
            {KIND_ORDER.map((k) => (
              <Toggle key={k} variant="outline" size="sm" className={chip} pressed={filter.kind === k}
                onPressedChange={() => setFilter({ kind: k, view: "tracks", playlist: null })}>{KIND_LABELS[k]}</Toggle>
            ))}
          </div>
          <span className="flex-1" />
          {global && <ChannelFilter value={filter.channels} onChange={(channels) => setFilter({ channels })} />}
          <label htmlFor={uploaderId} className="text-[13px] text-muted-foreground">Uploaded by</label>
          <NativeSelect id={uploaderId} size="sm" value={filter.uploader ?? ""} onChange={(e) => setFilter({ uploader: e.target.value || null })}>
            <NativeSelectOption value="">Anyone</NativeSelectOption>
            {uploaders.map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
          </NativeSelect>
          <span className="text-[13px] text-muted-foreground">{count}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {music ? (
            <MusicView scope={scope} filter={filter} setFilter={setFilter} files={files} global={global} />
          ) : files.error && files.items.length === 0 ? <div className="p-4"><ErrorText error={files.error} /></div>
            : files.loading && files.items.length === 0 ? <p className={note}>Loading…</p>
            : files.items.length === 0 ? (
              filtered ? (
                <div className="grid justify-items-center gap-3 p-8">
                  <p className="m-0 text-sm text-muted-foreground">No files match.</p>
                  <Button variant="outline" size="sm" onClick={() => setParams(filterParams(DEFAULT_FILTER), { replace: true })}>Clear filters</Button>
                </div>
              ) : <p className={note}>No files yet.</p>
            ) : (
              <div className="grid content-start gap-6 p-4">
                {groups.map((g) => (
                  <section key={g.label} aria-label={g.label}>
                    <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.label}</h3>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
                      {g.items.map((it) => (
                        <FileTile key={it.attachment.id} item={it} global={global} playing={false}
                          selected={selected?.attachmentId === it.attachment.id}
                          onOpen={() => openPanel({ kind: "media", channelId: it.message.channel_id, messageId: it.message.id, attachmentId: it.attachment.id })} />
                      ))}
                    </div>
                  </section>
                ))}
                {files.hasMore && (
                  <div ref={sentinel} className="grid justify-items-center gap-2">
                    <Button variant="outline" size="sm" disabled={files.loading} onClick={files.loadMore}>Load more</Button>
                    <ErrorText error={files.error} />
                  </div>
                )}
              </div>
            )}
        </div>
      </main>
      {selected ? (
        <GalleryItemPanel key={selected.attachmentId} attachmentId={selected.attachmentId} items={files.items} onClose={closePanel} />
      ) : panel?.kind === "thread" ? (
        <ThreadPanel key={panel.threadId} threadId={panel.threadId} parentChannelId={panel.parentId ?? channelId ?? ""} onClose={closePanel} />
      ) : panel?.kind === "search" ? (
        <SearchPanel />
      ) : null}
      {uploading && channelId && <UploadDialog channelId={channelId} onClose={() => setUploading(false)} />}
    </>
  );
}
```

Notes on the code above:
- `MusicView` doesn't exist until Task 13. For this task, create a stub `MusicView.tsx` that renders the same grid of `FileTile`s. Simplest: export a component that receives `files` and renders `groups` like above. Task 13 replaces it. Keep the stub under 30 lines.
- Check that `last_message_id` exists on `Channel` (`grep -n "last_message_id" clients/core/src/schema.d.ts`). If not, keep the old ack approach with the newest item's message id: `files.items[0]?.message.id`.
- `usePerms(undefined)` must return server-level perms. Check the `usePerms` signature in `session.ts`.

- [ ] **Step 4: `UploadDialog` takes any file.**
  - Remove `isMediaFile`, `MEDIA_ONLY` and the `accept: MEDIA_ONLY` option. Call `useUploads(channelId, { onError: setInvalid })`; check that `accept` is optional in `use-uploads`.
  - Change the title to `Upload files` and remove `accept="image/*,video/*,.mkv,.webm"` from the input.
  - The `FieldDescription` becomes `Up to {MAX_FILES} files.`
  - Update the doc comment to `/** Uploads files to a gallery as one message, with an optional caption. */`.
  - If `FileRow` shows a `Film`/`ImagePlus` icon by type, give non-media files a `File` icon.

- [ ] **Step 5: Update `Home.tsx`.** Change `<GalleryView channelId={…} />` to `<GalleryView scope={{ kind: "channel", channelId: … }} />`.

- [ ] **Step 6: Typecheck and run the tests.** Run `pnpm -r typecheck` and `cd clients/web && pnpm vitest run`. Expect failures only in `GalleryItemPanel` (Task 10) and `panel.ts` (`channelId` on `media`). Do Task 10 before checking in a browser.

- [ ] **Step 7: Checkpoint.** Do not commit.

---

### Task 10: The `/gallery` route, the sidebar link and a scope-free details panel

**Files:**
- Modify: `clients/web/src/router.tsx:25` (route)
- Modify: `clients/web/src/app/Home.tsx` (export `GlobalGalleryRoute`)
- Modify: `clients/web/src/app/ServerSidebar.tsx:84-87` (a link above `ChannelTree`)
- Modify: `clients/web/src/app/side-panel/panel.ts:10` (`media` gains `channelId`)
- Modify: `clients/web/src/app/gallery/GalleryItemPanel.tsx` (read from `items`; kind-aware)
- Modify: any other `openPanel({ kind: "media" …` callers. Find them with `grep -rn 'kind: "media"' clients/web/src`.

**Interfaces:**
- Consumes: `GalleryItem` (Task 6), `FileTile`'s `channelTag`.
- Produces: `GalleryItemPanel({ attachmentId, items, onClose, actions? })`. Task 13 injects `actions` for audio (Play, Add to queue, Add to playlist).

- [ ] **Step 1: Update the panel type.**

```ts
  | { kind: "media"; channelId: string; messageId: string; attachmentId: string }
```

- [ ] **Step 2: Add the route.** In `router.tsx`, add `{ path: "gallery", element: <GlobalGalleryRoute /> }` after the channels route. In `Home.tsx`:

```tsx
export function GlobalGalleryRoute() {
  return <GalleryView scope={{ kind: "global" }} />;
}
```

- [ ] **Step 3: Add the sidebar link.** In `ServerSidebar`, inside `<TabsContent value="channels">` and before `<CreateMenu>`:

```tsx
          <Link to="/gallery" aria-current={onGallery ? "page" : undefined}
            className={cn("mx-2 mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground",
              onGallery && "bg-accent text-foreground")}>
            <Images className="size-4" aria-hidden />Gallery
          </Link>
```

Add `const onGallery = !!useMatch("/gallery");` at the top. Import `Link` from react-router-dom and `Images` from lucide-react. Match the row padding and font size of the channel rows in `ChannelTree.tsx:360`.

- [ ] **Step 4: Make `GalleryItemPanel` read its item from `items`.**
  - Change the signature to `({ attachmentId, items, onClose, actions }: { attachmentId: string; items: GalleryItem[]; onClose: () => void; actions?: (item: GalleryItem) => ReactNode })`.
  - Replace the store lookups with:

```tsx
  const item = items.find((it) => it.attachment.id === attachmentId);
  const channelId = item?.message.channel_id ?? "";
  // The store's copy is fresher (thread counts, edits) when the channel is loaded.
  const stored = useApp((s) => s.messages[channelId]?.items.find((m) => m.id === item?.message.id));
  const message = stored ?? item?.message;
  const attachment = item?.attachment;
```

  - Gone: `const gone = !item;`, and call `onClose()` in the effect when gone.
  - Kind: `const kind = item.kind;`. The label is `` `${KIND_SINGULAR[kind] === "File" ? "File" : KIND_SINGULAR[kind]} details` `` → "Photo details" / "Video details" / "Track details" / "File details".
  - Preview by kind:
    - video → `VideoPlayer`;
    - image → `<img>` and `ImageViewer`;
    - audio → `<AudioPlayer attachment={attachment} />` (`../attachments/AudioPlayer`; check its props);
    - otherwise → a card with the extension badge and file name.
  - "Open full size": photo → the viewer; video and PDF → a new-tab link; hide it for other kinds.
  - Under the author line, add a link `in #{channelTag(item)}` to `/channels/${item.message.channel_id}`. Use `Link` with the `?message=` param pattern if `jump.ts` has one (`grep -n "export function" clients/web/src/app/jump.ts`); otherwise link to the channel.
  - Render `{actions?.(item)}` as a button row under the preview.
  - Prev/next: `openPanel({ kind: "media", channelId: it.message.channel_id, messageId: it.message.id, attachmentId: it.attachment.id })`.
  - `Comments` gets `channelId={item.message.channel_id}` and perms from `usePerms(item.message.channel_id)`.

- [ ] **Step 5: Typecheck and run the tests.** Run `pnpm -r typecheck` and `cd clients/web && pnpm vitest run`. Expected: green.

- [ ] **Step 6: Verify in the browser** (the preview tools from the system prompt):
  1. Start the dev stack per `.claude/launch.json`. If it doesn't exist, ask the user how they run the web client locally.
  2. Sign in and click **Gallery** in the sidebar.
  3. Confirm the tiles show channel tags, the kind chips filter, and search narrows after typing.
  4. Open a file's details, then step with prev/next.
  5. Open a gallery channel: no tags, the Upload button is there, and the "Upload files" dialog accepts a `.zip`.
  6. Take a screenshot as proof.

- [ ] **Step 7: Checkpoint.** Do not commit.

---

## Phase D: Player and playlists

### Task 11: Player queue logic (pure) and store

**Files:**
- Create: `clients/web/src/app/player/queue.ts`
- Create: `clients/web/src/app/player/queue.test.ts`
- Create: `clients/web/src/app/player/player-store.ts`

**Interfaces:**
- Produces:
  - `type Track = { key: string; title: string; subtitle: string; src: string; channelId?: string; attachmentId?: string; cover?: string }`
  - `type Repeat = "off" | "all" | "one"`
  - `type Queue = { tracks: Track[]; index: number }`. `index` is −1 when empty.
  - Pure functions:
    - `start(tracks, at): Queue`
    - `enqueue(q, tracks): Queue`
    - `advance(q, repeat): Queue | null`. `null` means stop at the end.
    - `back(q): Queue`
    - `removeAt(q, i): Queue`
    - `moveTo(q, from, to): Queue`
    - `shuffleUpcoming(q, rand = Math.random): Queue`
  - Store `playerStore` (zustand vanilla) and `usePlayer(selector)`. The state is `{ queue, playing, repeat, shuffle, volume, notice? }` and the actions are `play(tracks, at?, shuffle?)`, `add(tracks)`, `toggle()`, `next()`, `prev()`, `ended()`, `failed()`, `remove(i)`, `move(from,to)`, `setRepeat(r)`, `toggleShuffle()`, `setVolume(v)`, `clear()`.
  - Helpers: `trackFromItem(item: GalleryItem): Track` and `trackFromPlaylistItem(it: PlaylistItem, channelName?: string): Track | null`. The latter returns `null` for link/search items.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from "vitest";
import { advance, back, enqueue, moveTo, removeAt, shuffleUpcoming, start, type Track } from "./queue";

const t = (k: string): Track => ({ key: k, title: k, subtitle: "", src: `/${k}` });
const keys = (q: { tracks: Track[] }) => q.tracks.map((x) => x.key);

describe("player queue", () => {
  it("starts at the picked track", () => {
    expect(start([t("a"), t("b")], 1)).toEqual({ tracks: [t("a"), t("b")], index: 1 });
  });
  it("advances, wraps with repeat all, stops at the end otherwise", () => {
    const q = start([t("a"), t("b")], 1);
    expect(advance(q, "off")).toBeNull();
    expect(advance(q, "all")?.index).toBe(0);
    expect(advance(start([t("a"), t("b")], 0), "off")?.index).toBe(1);
  });
  it("repeat one replays the same track on a natural end", () => {
    expect(advance(start([t("a"), t("b")], 0), "one")?.index).toBe(0);
  });
  it("back goes to the previous track, not before the first", () => {
    expect(back(start([t("a"), t("b")], 1)).index).toBe(0);
    expect(back(start([t("a")], 0)).index).toBe(0);
  });
  it("enqueue appends; on an empty queue it starts", () => {
    expect(enqueue({ tracks: [], index: -1 }, [t("a")])).toEqual({ tracks: [t("a")], index: 0 });
    expect(keys(enqueue(start([t("a")], 0), [t("b")]))).toEqual(["a", "b"]);
  });
  it("removing keeps the current track playing", () => {
    expect(removeAt(start([t("a"), t("b"), t("c")], 2), 0)).toEqual({ tracks: [t("b"), t("c")], index: 1 });
    expect(removeAt(start([t("a"), t("b")], 1), 1)).toEqual({ tracks: [t("a")], index: 0 });
    expect(removeAt(start([t("a")], 0), 0)).toEqual({ tracks: [], index: -1 });
  });
  it("moving follows the current track", () => {
    expect(moveTo(start([t("a"), t("b"), t("c")], 0), 0, 2)).toEqual({ tracks: [t("b"), t("c"), t("a")], index: 2 });
    expect(moveTo(start([t("a"), t("b"), t("c")], 1), 2, 0)).toEqual({ tracks: [t("c"), t("a"), t("b")], index: 2 });
  });
  it("shuffle keeps played tracks and the current one in place", () => {
    const q = shuffleUpcoming(start([t("a"), t("b"), t("c"), t("d")], 1), () => 0);
    expect(keys(q).slice(0, 2)).toEqual(["a", "b"]);
    expect(new Set(keys(q))).toEqual(new Set(["a", "b", "c", "d"]));
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm vitest run src/app/player/queue.test.ts`.

- [ ] **Step 3: Implement `queue.ts`.**

```ts
export type Track = { key: string; title: string; subtitle: string; src: string; channelId?: string; attachmentId?: string; cover?: string };
export type Repeat = "off" | "all" | "one";
export type Queue = { tracks: Track[]; index: number };

export const EMPTY: Queue = { tracks: [], index: -1 };

export function start(tracks: Track[], at = 0): Queue {
  return tracks.length ? { tracks, index: Math.min(Math.max(at, 0), tracks.length - 1) } : EMPTY;
}

export function enqueue(q: Queue, tracks: Track[]): Queue {
  return q.index < 0 ? start(tracks) : { ...q, tracks: [...q.tracks, ...tracks] };
}

/** The next track after the current one ends (or Next is pressed with repeat off/all). */
export function advance(q: Queue, repeat: Repeat): Queue | null {
  if (q.index < 0) return null;
  if (repeat === "one") return q;
  if (q.index + 1 < q.tracks.length) return { ...q, index: q.index + 1 };
  return repeat === "all" ? { ...q, index: 0 } : null;
}

export function back(q: Queue): Queue {
  return q.index > 0 ? { ...q, index: q.index - 1 } : q;
}

export function removeAt(q: Queue, i: number): Queue {
  const tracks = q.tracks.filter((_, j) => j !== i);
  if (!tracks.length) return EMPTY;
  const index = i < q.index ? q.index - 1 : Math.min(q.index, tracks.length - 1);
  return { tracks, index };
}

export function moveTo(q: Queue, from: number, to: number): Queue {
  const tracks = [...q.tracks];
  const [moved] = tracks.splice(from, 1);
  tracks.splice(to, 0, moved);
  return { tracks, index: tracks.indexOf(q.tracks[q.index]) };
}

/** Shuffles the tracks after the current one (Fisher–Yates). */
export function shuffleUpcoming(q: Queue, rand: () => number = Math.random): Queue {
  const head = q.tracks.slice(0, q.index + 1);
  const rest = q.tracks.slice(q.index + 1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return { tracks: [...head, ...rest], index: q.index };
}
```

- [ ] **Step 4: Implement `player-store.ts`.**

```ts
import type { PlaylistItem } from "@datrope/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { client, displayName } from "../../session";
import type { GalleryItem } from "../gallery/items";
import { channelTag } from "../gallery/FileTile";
import { shownAuthor } from "../message-author";
import { advance, back, EMPTY, enqueue, moveTo, removeAt, shuffleUpcoming, start, type Queue, type Repeat, type Track } from "./queue";

type PlayerState = { queue: Queue; playing: boolean; repeat: Repeat; shuffle: boolean; volume: number; notice?: string };

export const playerStore = createStore<PlayerState>(() => ({ queue: EMPTY, playing: false, repeat: "off", shuffle: false, volume: 1 }));
export const usePlayer = <T,>(select: (s: PlayerState) => T): T => useStore(playerStore, select);

const set = (patch: Partial<PlayerState>) => playerStore.setState(patch);
const get = () => playerStore.getState();

export const player = {
  play(tracks: Track[], at = 0, shuffle = false) {
    let q = start(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : at);
    if (shuffle) q = shuffleUpcoming(q);
    set({ queue: q, playing: q.index >= 0, shuffle, notice: undefined });
  },
  add(tracks: Track[]) {
    const wasEmpty = get().queue.index < 0;
    set({ queue: enqueue(get().queue, tracks), ...(wasEmpty ? { playing: true } : {}) });
  },
  toggle() { if (get().queue.index >= 0) set({ playing: !get().playing }); },
  next() {
    const r = get().repeat === "one" ? "off" : get().repeat; // Next always moves on
    const q = advance(get().queue, r);
    set(q ? { queue: q, playing: true } : { playing: false });
  },
  prev() { set({ queue: back(get().queue), playing: true }); },
  ended() {
    const q = advance(get().queue, get().repeat);
    set(q ? { queue: q, playing: true } : { playing: false });
  },
  /** The current track could not load (gone, or no longer readable): note it and move on. */
  failed() {
    const cur = get().queue.tracks[get().queue.index];
    const q = advance(get().queue, get().repeat === "one" ? "off" : get().repeat);
    set({ notice: cur ? `Couldn't play ${cur.title}. Skipped.` : undefined, ...(q && q.index !== get().queue.index ? { queue: q } : { playing: false }) });
  },
  remove(i: number) { const q = removeAt(get().queue, i); set({ queue: q, playing: q.index >= 0 && get().playing }); },
  move(from: number, to: number) { set({ queue: moveTo(get().queue, from, to) }); },
  setRepeat(repeat: Repeat) { set({ repeat }); },
  toggleShuffle() {
    const on = !get().shuffle;
    set({ shuffle: on, ...(on ? { queue: shuffleUpcoming(get().queue) } : {}) });
  },
  setVolume(volume: number) { set({ volume }); },
  clear() { set({ queue: EMPTY, playing: false, notice: undefined }); },
};

export function trackFromItem(it: GalleryItem): Track {
  return {
    key: `file:${it.attachment.id}`, title: it.attachment.filename,
    subtitle: `#${channelTag(it)} · ${displayName(shownAuthor(it.message))}`,
    src: client.url(it.attachment.url), channelId: it.message.channel_id, attachmentId: it.attachment.id,
  };
}

/** A playlist item the browser can play (files and library uploads); links play only in voice. */
export function trackFromPlaylistItem(it: PlaylistItem, channelName?: string): Track | null {
  if (it.source === "file" && it.attachment_id) {
    return { key: `file:${it.attachment_id}`, title: it.title, subtitle: channelName ? `#${channelName}` : "",
      src: client.url(`/api/attachments/${it.attachment_id}`), attachmentId: it.attachment_id, channelId: it.channel_id ?? undefined };
  }
  if (it.source === "upload" && it.track_id) {
    return { key: `upload:${it.track_id}`, title: it.title, subtitle: it.artist ?? "", src: client.libraryAudioUrl(it.track_id), cover: it.cover ? client.url(it.cover) : undefined };
  }
  return null;
}
```

- [ ] **Step 5: Run the tests.** Run `pnpm vitest run src/app/player/` and `pnpm -r typecheck`. Expected: green.
- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 12: `PlayerBar` with audio, the queue popover and media keys

**Files:**
- Create: `clients/web/src/app/player/PlayerBar.tsx`
- Create: `clients/web/src/app/player/QueuePopover.tsx`
- Create: `clients/web/src/app/player/PlayerBar.test.tsx`
- Modify: `clients/web/src/app/AppShell.tsx:64-82` (render `<PlayerBar />` after the row div, inside the column)

**Interfaces:**
- Consumes: `playerStore`, `player`, `usePlayer`, `formatDuration` from `../attachments/media`, `Slider`.
- Produces: `<PlayerBar />`, a `section` with `aria-label="Music player"`. Controls by label:
  - `Play` / `Pause`, `Previous track`, `Next track`;
  - `Shuffle` (pressed state), `Repeat: off|all|one`;
  - a `Seek` slider, a `Volume` slider;
  - `Queue` (popover), `Close player`;
  - a `role="status"` notice.

- [ ] **Step 1: Write the failing component test** (vitest + Testing Library; follow the setup in `GifMedia.test.tsx`).

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { player, playerStore } from "./player-store";
import { PlayerBar } from "./PlayerBar";

const track = (k: string) => ({ key: k, title: `${k}.mp3`, subtitle: "#music · alice", src: `/a/${k}` });

describe("PlayerBar", () => {
  afterEach(() => player.clear());

  it("is hidden with an empty queue and shows the current track", () => {
    const { container } = render(<PlayerBar />);
    expect(container).toBeEmptyDOMElement();
    act(() => player.play([track("a"), track("b")]));
    expect(screen.getByRole("region", { name: "Music player" })).toHaveTextContent("a.mp3");
  });

  it("skips a track that fails to load and says so", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    render(<PlayerBar />);
    act(() => player.play([track("a"), track("b")]));
    fireEvent.error(document.querySelector("audio")!);
    expect(playerStore.getState().queue.index).toBe(1);
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't play a.mp3. Skipped.");
  });
});
```

If `@testing-library/react` isn't a dev dependency (check `clients/web/package.json`), test `player.failed()` in `queue.test.ts`-style unit tests instead, and drop this file. Don't add dependencies.

- [ ] **Step 2: Run the test and confirm it fails.**

- [ ] **Step 3: Implement `PlayerBar.tsx`.**

```tsx
import { ListMusic, Music, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Toggle } from "@/components/ui/toggle";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { formatDuration } from "../attachments/media";
import { player, usePlayer } from "./player-store";
import { QueuePopover } from "./QueuePopover";

const NEXT_REPEAT = { off: "all", all: "one", one: "off" } as const;

/** The gallery's own music player: one audio element for the whole app, a bar at the bottom while something is queued. */
export function PlayerBar() {
  const queue = usePlayer((s) => s.queue);
  const playing = usePlayer((s) => s.playing);
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);
  const volume = usePlayer((s) => s.volume);
  const notice = usePlayer((s) => s.notice);
  const audio = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const mobile = useIsMobile();
  const current = queue.tracks[queue.index];

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    if (playing) el.play().catch(() => undefined);
    else el.pause();
  }, [playing, current?.key]);
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume]);
  // A replayed track (repeat one) starts from the top.
  useEffect(() => { if (audio.current) audio.current.currentTime = 0; }, [queue]);

  // OS media keys and the now-playing card.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !current) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: current.subtitle });
    navigator.mediaSession.setActionHandler("play", () => player.toggle());
    navigator.mediaSession.setActionHandler("pause", () => player.toggle());
    navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
    navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
  }, [current]);

  if (!current) return null;
  const prev = () => (audio.current && audio.current.currentTime > 3 ? (audio.current.currentTime = 0) : player.prev());
  return (
    <section aria-label="Music player" className="flex h-16 flex-none items-center gap-4 border-t bg-card px-4">
      <audio ref={audio} src={current.src} preload="auto"
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onDurationChange={(e) => setLength(e.currentTarget.duration)}
        onEnded={() => player.ended()} onError={() => player.failed()} />
      <div className={cn("flex min-w-0 items-center gap-2.5", mobile ? "flex-1" : "w-64")}>
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary text-foreground" aria-hidden><Music className="size-5" /></span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{current.title}</div>
          <div className="truncate text-xs text-muted-foreground">{notice ? <span role="status">{notice}</span> : current.subtitle}</div>
        </div>
      </div>
      <div className={cn("grid flex-1 justify-items-center gap-1", mobile && "flex-none")}>
        <div className="flex items-center gap-1">
          {!mobile && <Toggle size="sm" aria-label="Shuffle" pressed={shuffle} onPressedChange={() => player.toggleShuffle()} className="data-[state=on]:text-primary"><Shuffle /></Toggle>}
          {!mobile && <Button variant="ghost" size="icon-sm" aria-label="Previous track" onClick={prev}><SkipBack className="fill-current" /></Button>}
          <Button size="icon-sm" className="rounded-full" aria-label={playing ? "Pause" : "Play"} onClick={() => player.toggle()}>
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next track" onClick={() => player.next()}><SkipForward className="fill-current" /></Button>
          {!mobile && (
            <Button variant="ghost" size="icon-sm" aria-label={`Repeat: ${repeat}`} className={cn(repeat !== "off" && "text-primary")}
              onClick={() => player.setRepeat(NEXT_REPEAT[repeat])}>{repeat === "one" ? <Repeat1 /> : <Repeat />}</Button>
          )}
        </div>
        {!mobile && (
          <div className="flex w-full max-w-xl items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <span>{formatDuration(time)}</span>
            <Slider className="flex-1" min={0} max={Math.max(length, 1)} step={1} value={[time]} aria-label="Seek"
              onValueChange={([v]) => { if (audio.current) audio.current.currentTime = v; }} />
            <span>{formatDuration(length)}</span>
          </div>
        )}
      </div>
      {!mobile && (
        <div className="flex w-64 items-center justify-end gap-2">
          <QueuePopover />
          <Volume2 className="size-4 text-muted-foreground" aria-hidden />
          <Slider className="w-24" min={0} max={1} step={0.05} value={[volume]} aria-label="Volume" onValueChange={([v]) => player.setVolume(v)} />
          <Button variant="ghost" size="icon-sm" aria-label="Close player" onClick={() => player.clear()}><X /></Button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Implement `QueuePopover.tsx`.** It's a Popover with a trigger labelled `Queue` (a `ListMusic` icon via `RefButton`) and content labelled `Queue`. It contains:
  - a "Now playing" row;
  - "Up next · N" as a sortable list. Reuse the `@dnd-kit` pattern from `PlaylistsTab.tsx`: `DndContext` + `SortableContext` + `useSortable`, calling `player.move(from, to)` in `onDragEnd` with the absolute indexes.
  - a remove button per row, labelled `Remove {title}`;
  - a `Clear queue` button.

```tsx
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, ListMusic, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RefButton } from "@/components/ref-button";
import { player, usePlayer } from "./player-store";
import type { Track } from "./queue";

export function QueuePopover() {
  const queue = usePlayer((s) => s.queue);
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const current = queue.tracks[queue.index];
  const upNext = queue.tracks.slice(queue.index + 1);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const keys = queue.tracks.map((t) => t.key);
    player.move(keys.indexOf(String(e.active.id)), keys.indexOf(String(e.over.id)));
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <RefButton variant="ghost" size="icon-sm" aria-label="Queue"><ListMusic /></RefButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 p-0" aria-label="Queue">
        <div className="flex items-center px-3 pt-2.5 pb-1">
          <span className="flex-1 text-sm font-semibold">Queue</span>
          <Button variant="ghost" size="sm" onClick={() => player.clear()}>Clear queue</Button>
        </div>
        <p className="m-0 px-3 pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Now playing</p>
        {current && <div className="mx-1 truncate rounded-md bg-accent px-2 py-1.5 text-sm font-semibold text-primary">{current.title}</div>}
        <p className="m-0 px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Up next · {upNext.length}</p>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={upNext.map((t) => t.key)} strategy={verticalListSortingStrategy}>
            <ol className="m-0 grid max-h-72 list-none gap-0.5 overflow-y-auto p-1">
              {upNext.map((t, i) => <Row key={t.key} track={t} index={queue.index + 1 + i} />)}
            </ol>
          </SortableContext>
        </DndContext>
      </PopoverContent>
    </Popover>
  );
}

function Row({ track, index }: { track: Track; index: number }) {
  const s = useSortable({ id: track.key });
  return (
    <li ref={s.setNodeRef} style={{ transform: CSS.Transform.toString(s.transform), transition: s.transition }}
      className="group flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-accent">
      <button type="button" aria-label={`Move ${track.title}`} className="cursor-grab text-muted-foreground" {...s.attributes} {...s.listeners}><GripVertical className="size-4" /></button>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm">{track.title}</span><span className="block truncate text-xs text-muted-foreground">{track.subtitle}</span></span>
      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${track.title}`} onClick={() => player.remove(index)}><X /></Button>
    </li>
  );
}
```

Because track keys are `file:<id>`, the same file queued twice would give duplicate sortable ids. In `player.add`, skip tracks whose key is already in the queue, and add a unit test to `queue.test.ts`: `enqueue skips keys already queued`. Implement it in `enqueue` as `tracks.filter((t) => !q.tracks.some((x) => x.key === t.key))`.

- [ ] **Step 5: Mount the bar in `AppShell`.** After the `<div className="flex min-h-0 flex-1 overflow-hidden">…</div>` closes, inside the outer column, add `{!gated && <PlayerBar />}`.

- [ ] **Step 6: Run the tests and typecheck.** Expected: green.
- [ ] **Step 7: Checkpoint.** Do not commit.

---

### Task 13: The Music view (tracks grid/list) and file actions (play, queue, add to playlist)

**Files:**
- Replace the stub: `clients/web/src/app/gallery/MusicView.tsx`
- Create: `clients/web/src/app/gallery/FileMenu.tsx` (the "…" dropdown per tile/row; the Add to playlist submenu)
- Create: `clients/web/src/app/gallery/AddToPlaylist.tsx` (submenu content: search, checkmarks, New playlist…)
- Modify: `clients/web/src/app/gallery/GalleryView.tsx` (pass `menu` and `onPlay` to tiles; pass `actions` to `GalleryItemPanel`)
- Modify: `clients/web/src/app/voice/PlaylistsTab.tsx` (export `NewPlaylistDialog` and `useCanEdit`)

**Interfaces:**
- Consumes: `player`, `trackFromItem`, `client.addToPlaylist(id, { attachment_id })`, `client.playlist(id)`, `client.removeFromPlaylist`. Check the method name with `grep -n "Playlist" clients/core/src/client.ts`.
- Produces:
  - `MusicView({ scope, filter, setFilter, files, global })`
  - `FileMenu({ item, items })`, a dropdown labelled `More for {filename}`.
  - `AddToPlaylistItems({ attachmentId })`.

- [ ] **Step 1: Export from `PlaylistsTab.tsx`.** Add `export` to `function useCanEdit` and `function NewPlaylistDialog`. Nothing else changes.

- [ ] **Step 2: Implement `AddToPlaylist.tsx`.**

```tsx
import { Check, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Perm, hasPerm } from "@datrope/core";
import { client, useApp, usePerms } from "../../session";
import { NewPlaylistDialog } from "../voice/PlaylistsTab";

/** The playlists I can change, with a check on those that already hold this file. */
export function AddToPlaylistItems({ attachmentId, onNew }: { attachmentId: string; onNew: () => void }) {
  const playlists = useApp((s) => s.playlists);
  const meId = useApp((s) => s.me?.id);
  const canManage = hasPerm(usePerms(), Perm.ManageExpressions);
  const [holding, setHolding] = useState<Record<string, string>>({}); // playlist id → item id holding this file
  const editable = Object.values(playlists ?? {}).filter((p) => canManage || p.created_by === meId).sort((a, b) => a.title.localeCompare(b.title));

  useEffect(() => {
    if (!playlists) void client.loadPlaylists().catch(() => undefined);
  }, [playlists]);
  useEffect(() => {
    let live = true;
    void Promise.all(editable.map(async (p) => {
      const d = await client.playlist(p.id);
      const it = d.items?.find((i) => i.attachment_id === attachmentId);
      return [p.id, it?.id] as const;
    })).then((pairs) => { if (live) setHolding(Object.fromEntries(pairs.filter(([, i]) => i)) as Record<string, string>); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId, editable.length]);

  const toggle = async (pid: string) => {
    if (holding[pid]) {
      await client.removeFromPlaylist(pid, holding[pid]);
      setHolding(({ [pid]: _, ...rest }) => rest);
    } else {
      await client.addToPlaylist(pid, { attachment_id: attachmentId });
      const d = await client.playlist(pid);
      const it = d.items?.find((i) => i.attachment_id === attachmentId);
      if (it) setHolding((h) => ({ ...h, [pid]: it.id }));
    }
  };

  return (
    <>
      {editable.length === 0 && <DropdownMenuItem disabled>No playlists you can change</DropdownMenuItem>}
      {editable.map((p) => (
        <DropdownMenuItem key={p.id} onSelect={(e) => { e.preventDefault(); void toggle(p.id); }}
          aria-checked={!!holding[p.id]} role="menuitemcheckbox">
          <Check className={holding[p.id] ? "" : "invisible"} />{p.title}
          <span className="ml-auto text-xs text-muted-foreground">{p.count}</span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onNew}><Plus />New playlist…</DropdownMenuItem>
    </>
  );
}

export { NewPlaylistDialog };
```

Loading every editable playlist's detail to find the checkmarks is N requests. That's fine at ≤100 playlists and only while the submenu is open. Note it for the reviewer.

`client.removeFromPlaylist`: if it has a different name, use the existing method behind `DELETE /api/server/music/playlists/{playlistID}/items/{itemID}`.

- [ ] **Step 3: Implement `FileMenu.tsx`.**

```tsx
import { Download, ExternalLink, ListPlus, MoreHorizontal, Play, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RefButton } from "@/components/ref-button";
import { client } from "../../session";
import { player, trackFromItem } from "../player/player-store";
import { AddToPlaylistItems, NewPlaylistDialog } from "./AddToPlaylist";
import type { GalleryItem } from "./items";

export function FileMenu({ item, items }: { item: GalleryItem; items: GalleryItem[] }) {
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const audio = item.kind === "audio";
  const audioItems = items.filter((i) => i.kind === "audio");
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <RefButton variant="secondary" size="icon-sm" aria-label={`More for ${item.attachment.filename}`}><MoreHorizontal /></RefButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {audio && <DropdownMenuItem onSelect={() => player.play(audioItems.map(trackFromItem), audioItems.indexOf(item))}><Play />Play</DropdownMenuItem>}
          {audio && <DropdownMenuItem onSelect={() => player.add([trackFromItem(item)])}><ListPlus />Add to queue</DropdownMenuItem>}
          {audio && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Plus />Add to playlist</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                <AddToPlaylistItems attachmentId={item.attachment.id} onNew={() => setCreating(true)} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem onSelect={() => nav(`/channels/${item.message.channel_id}`)}><ExternalLink />Go to message</DropdownMenuItem>
          <DropdownMenuItem asChild><a href={client.url(item.attachment.url)} download={item.attachment.filename}><Download />Download</a></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {creating && <NewPlaylistDialog onClose={() => setCreating(false)} onCreated={async (id) => {
        setCreating(false);
        await client.addToPlaylist(id, { attachment_id: item.attachment.id });
      }} />}
    </>
  );
}
```

Two things to check:
- The `DropdownMenuSub*` exports in `dropdown-menu.tsx`. If they're missing, re-fetch `dropdown-menu` with the shadcn CLI per AGENTS.md and keep the local changes.
- `NewPlaylistDialog`'s `onCreated` signature in `PlaylistsTab.tsx`. Match it.

"Go to message" should jump to the message itself. Use `jump.ts`'s helper if one exists (`openMessage`), otherwise navigate to the channel.

- [ ] **Step 4: Implement `MusicView.tsx`** (frames 2a, 2b and 7, plus the Task 14 detail).

```tsx
import { LayoutGrid, List, Play, Shuffle } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { displayName } from "../../session";
import { shownAuthor } from "../message-author";
import { openPanel } from "../side-panel/panel";
import { player, trackFromItem, usePlayer } from "../player/player-store";
import { channelTag, FileTile } from "./FileTile";
import { FileMenu } from "./FileMenu";
import type { GalleryFilter } from "./filter";
import { PlaylistsGrid } from "./PlaylistsGrid";
import type { useFiles, GalleryScope } from "./use-files";

const LAYOUT_KEY = "gallery.music.layout";
const readLayout = (): "grid" | "list" => { try { return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; } };
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

export function MusicView({ scope, filter, setFilter, files, global }: {
  scope: GalleryScope; filter: GalleryFilter; setFilter: (p: Partial<GalleryFilter>) => void;
  files: ReturnType<typeof useFiles>; global: boolean;
}) {
  const [layout, setLayout] = useState(readLayout);
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* private mode */ } }, [layout]);
  const playingKey = usePlayer((s) => s.queue.tracks[s.queue.index]?.key);
  const tracks = files.items.map(trackFromItem);
  const open = (i: number) => {
    const it = files.items[i];
    openPanel({ kind: "media", channelId: it.message.channel_id, messageId: it.message.id, attachmentId: it.attachment.id });
  };

  return (
    <div className="grid content-start gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {global && (
          <Tabs value={filter.view} onValueChange={(v) => setFilter({ view: v as GalleryFilter["view"], playlist: null })}>
            <TabsList><TabsTrigger value="tracks">Tracks</TabsTrigger><TabsTrigger value="playlists">Playlists</TabsTrigger></TabsList>
          </Tabs>
        )}
        {filter.view === "tracks" && (
          <>
            <Button size="sm" disabled={!tracks.length} onClick={() => player.play(tracks)}><Play className="fill-current" />Play all</Button>
            <Button size="sm" variant="outline" disabled={!tracks.length} onClick={() => player.play(tracks, 0, true)}><Shuffle />Shuffle</Button>
            <span className="flex-1" />
            <ToggleGroup type="single" variant="outline" size="sm" value={layout} onValueChange={(v) => v && setLayout(v as "grid" | "list")} aria-label="Layout">
              <ToggleGroupItem value="grid" aria-label="Grid"><LayoutGrid /></ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List"><List /></ToggleGroupItem>
            </ToggleGroup>
          </>
        )}
      </div>

      {filter.view === "playlists" && global ? (
        <PlaylistsGrid filter={filter} setFilter={setFilter} />
      ) : files.error && !files.items.length ? <ErrorText error={files.error} />
        : !files.items.length ? <p className="m-0 p-8 text-center text-sm text-muted-foreground">{files.loading ? "Loading…" : "No music yet."}</p>
        : layout === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
            {files.items.map((it, i) => (
              <FileTile key={it.attachment.id} item={it} global={global} selected={false} playing={playingKey === `file:${it.attachment.id}`}
                onOpen={() => open(i)} onPlay={() => player.play(tracks, i)} menu={<FileMenu item={it} items={files.items} />} />
            ))}
          </div>
        ) : (
          <Table aria-label="Tracks">
            <TableHeader><TableRow>
              <TableHead className="w-10">#</TableHead><TableHead>Title</TableHead>{global && <TableHead>Channel</TableHead>}
              <TableHead>Uploaded by</TableHead><TableHead>Added</TableHead><TableHead className="w-10" />
            </TableRow></TableHeader>
            <TableBody>
              {files.items.map((it, i) => {
                const cur = playingKey === `file:${it.attachment.id}`;
                return (
                  <TableRow key={it.attachment.id} className={cn(cur && "bg-primary/10")} onDoubleClick={() => player.play(tracks, i)}>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" aria-label={`Play ${it.attachment.filename}`} onClick={() => player.play(tracks, i)}>
                        {cur ? <span className="text-primary">♪</span> : <span className="text-muted-foreground tabular-nums">{i + 1}</span>}
                      </Button>
                    </TableCell>
                    <TableCell><button type="button" className={cn("text-left", cur && "font-semibold text-primary")} onClick={() => open(i)}>{it.attachment.filename}</button></TableCell>
                    {global && <TableCell><span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">#{channelTag(it)}</span></TableCell>}
                    <TableCell>{displayName(shownAuthor(it.message))}</TableCell>
                    <TableCell className="text-muted-foreground">{dateFmt.format(new Date(it.message.created_at))}</TableCell>
                    <TableCell><FileMenu item={it} items={files.items} /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      {filter.view === "tracks" && files.hasMore && (
        <div className="grid justify-items-center"><Button variant="outline" size="sm" disabled={files.loading} onClick={files.loadMore}>Load more</Button></div>
      )}
    </div>
  );
}
```

On scope:
- The per-channel gallery hides the Tracks/Playlists tabs (`global &&`). Playlists live in the global gallery only, as in mockup frame 5.
- `scope` is unused here beyond typing. Remove the prop if lint complains. YAGNI.

For this task, create `PlaylistsGrid.tsx` as a stub that returns `null`. Task 14 fills it.

- [ ] **Step 5: Wire the actions in `GalleryView`.**
  - Pass `onPlay` and `menu` to the main grid tiles:
    - `onPlay={it.kind === "audio" ? () => { const a = files.items.filter((x) => x.kind === "audio"); player.play(a.map(trackFromItem), a.indexOf(it)); } : undefined}`
    - `menu={<FileMenu item={it} items={files.items} />}`
  - Pass `actions` to `GalleryItemPanel` for audio: Play, Add to queue and a DropdownMenu "Add to playlist" holding `AddToPlaylistItems`.

- [ ] **Step 6: Typecheck, run the tests and check in the browser.** In the browser:
  - Music → Play all starts the bar.
  - Next/Prev work, and Repeat cycles.
  - The List toggle persists across a reload.
  - Add to playlist puts a checkmark on the playlist.

  Take a screenshot.

- [ ] **Step 7: Checkpoint.** Do not commit.

---

### Task 14: Playlists in the gallery: grid, detail, play yourself or in voice

**Files:**
- Replace the stub: `clients/web/src/app/gallery/PlaylistsGrid.tsx`
- Create: `clients/web/src/app/gallery/PlaylistDetailView.tsx`
- Create: `clients/web/src/app/gallery/playlist-tracks.ts` and `playlist-tracks.test.ts`
- Modify: `clients/web/src/lib/music.ts:51-57` (`addedSummary` gains `unreadable`)

**Interfaces:**
- Consumes: `client.playlist(id)` → `PlaylistDetail` (with `hidden`); `client.queueMusic(voiceChannelId, { playlist_id, shuffle })` → `QueueResult` (with `skipped_unreadable`); `useVoice`; `trackFromPlaylistItem`; `NewPlaylistDialog`; `Cover` and `clock` from voice.
- Produces:
  - `playableTracks(items: PlaylistItem[], channelName: (id?: string) => string | undefined): Track[]`, which drops link and search items.
  - `addedSummary(verb, { count, skipped, dropped, unreadable? })`.

- [ ] **Step 1: Write the failing tests.**

`playlist-tracks.test.ts`:

```ts
import type { PlaylistItem } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { playableTracks } from "./playlist-tracks";

const item = (o: Partial<PlaylistItem>): PlaylistItem => ({ id: "i", title: "t", duration: 0, source: "link", ...o }) as PlaylistItem;

describe("playableTracks", () => {
  it("keeps files and uploads, in order, and leaves out links", () => {
    const got = playableTracks([
      item({ id: "1", title: "file", source: "file", attachment_id: "a1", channel_id: "c1" }),
      item({ id: "2", title: "yt", source: "link", url: "https://youtube.com/x" }),
      item({ id: "3", title: "up", source: "upload", track_id: "t1" }),
    ], (id) => (id === "c1" ? "music" : undefined));
    expect(got.map((t) => [t.title, t.subtitle])).toEqual([["file", "#music"], ["up", ""]]);
  });
});
```

Add to `clients/web/src/lib/music.test.ts` (create it if it's missing, next to the existing tests):

```ts
it("mentions files left out for permissions", () => {
  expect(addedSummary("Queued", { count: 4, skipped: 0, dropped: 0, unreadable: 1 }))
    .toBe("Queued 4 tracks, 1 skipped (from a channel you can't read).");
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement the helpers.**

`playlist-tracks.ts`:

```ts
import type { PlaylistItem } from "@datrope/core";
import { trackFromPlaylistItem } from "../player/player-store";
import type { Track } from "../player/queue";

/** The tracks your own player can play: channel files and library uploads (links play only in voice). */
export function playableTracks(items: PlaylistItem[], channelName: (id?: string) => string | undefined): Track[] {
  return items.map((it) => trackFromPlaylistItem(it, channelName(it.channel_id ?? undefined))).filter((t): t is Track => t !== null);
}
```

In `lib/music.ts`:

```ts
export function addedSummary(verb: "Queued" | "Added", r: { count: number; skipped: number; dropped: number; unreadable?: number }): string | undefined {
  if (r.count <= 1 && !r.skipped && !r.dropped && !r.unreadable) return undefined;
  const parts = [`${verb} ${r.count} ${r.count === 1 ? "track" : "tracks"}`];
  if (r.skipped) parts.push(`${r.skipped} didn't fit`);
  if (r.dropped) parts.push(`${r.dropped} unavailable ${r.dropped === 1 ? "track was" : "tracks were"} left out`);
  if (r.unreadable) parts.push(`${r.unreadable} skipped (from a channel you can't read)`);
  return `${parts.join(", ")}.`;
}
```

- [ ] **Step 4: Implement `PlaylistsGrid.tsx`.** It contains:
  - the All/Mine chips (`Toggle`, `role="group" aria-label="Playlists shown"`);
  - a `New playlist` button, shown only with `Perm.AttachFiles`, that opens `NewPlaylistDialog` and, once created, `setFilter({ playlist: id })`;
  - cards as buttons labelled `Open {title}`, with a cover via `Cover`, the title and `{n} tracks · {totalLength} · {creator}`.
  - When `filter.playlist` is set, it renders `<PlaylistDetailView id={filter.playlist} onBack={() => setFilter({ playlist: null })} />` instead.
  - It calls `client.loadPlaylists()` on mount if `playlists` is null.

```tsx
import { Perm, hasPerm } from "@datrope/core";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { totalLength } from "@/lib/music";
import { client, displayName, useApp, usePerms } from "../../session";
import { Cover } from "../voice/MusicBits";
import { NewPlaylistDialog } from "../voice/PlaylistsTab";
import type { GalleryFilter } from "./filter";
import { PlaylistDetailView } from "./PlaylistDetailView";

const chip = "h-7 rounded-full px-3 text-[13px] font-normal text-muted-foreground data-[state=on]:border-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground";

export function PlaylistsGrid({ filter, setFilter }: { filter: GalleryFilter; setFilter: (p: Partial<GalleryFilter>) => void }) {
  const playlists = useApp((s) => s.playlists);
  const members = useApp((s) => s.server?.members);
  const meId = useApp((s) => s.me?.id);
  const canCreate = hasPerm(usePerms(), Perm.AttachFiles);
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (!playlists) void client.loadPlaylists().catch(() => undefined); }, [playlists]);

  if (filter.playlist) return <PlaylistDetailView id={filter.playlist} onBack={() => setFilter({ playlist: null })} />;
  const list = Object.values(playlists ?? {}).filter((p) => !mine || p.created_by === meId).sort((a, b) => a.title.localeCompare(b.title));
  const by = (id?: string | null) => (id === meId ? "you" : id && members?.[id] ? displayName(members[id].user) : "someone");
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-1.5" role="group" aria-label="Playlists shown">
        <Toggle variant="outline" size="sm" className={chip} pressed={!mine} onPressedChange={() => setMine(false)}>All</Toggle>
        <Toggle variant="outline" size="sm" className={chip} pressed={mine} onPressedChange={() => setMine(true)}>Mine</Toggle>
        <span className="flex-1" />
        {canCreate && <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus />New playlist</Button>}
      </div>
      {list.length === 0 ? <p className="m-0 p-8 text-center text-sm text-muted-foreground">{playlists ? "No playlists yet." : "Loading…"}</p> : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 p-0">
          {list.map((p) => (
            <li key={p.id}>
              <button type="button" aria-label={`Open ${p.title}`} onClick={() => setFilter({ playlist: p.id })}
                className="grid w-full gap-2 rounded-md border bg-card p-2.5 text-left hover:bg-accent">
                <Cover src={p.cover} className="aspect-square size-auto w-full" />
                <span className="truncate text-sm font-semibold">{p.title}</span>
                <span className="truncate text-xs text-muted-foreground">{p.count} tracks{p.duration ? ` · ${totalLength(p.duration)}` : ""} · {by(p.created_by)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {creating && <NewPlaylistDialog onClose={() => setCreating(false)} onCreated={(id: string) => { setCreating(false); setFilter({ playlist: id }); }} />}
    </div>
  );
}
```

Check that `Cover` accepts `className` for sizing (`MusicBits.tsx:13`). It does: `{ src, className }`.

- [ ] **Step 5: Implement `PlaylistDetailView.tsx`.**

```tsx
import type { PlaylistDetail } from "@datrope/core";
import { ArrowLeft, Play, Shuffle, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSubmit } from "@/hooks/use-submit";
import { addedSummary, totalLength } from "@/lib/music";
import { cn } from "@/lib/utils";
import { useVoice } from "../../voice/voice";
import { client, errorText, useApp } from "../../session";
import { player } from "../player/player-store";
import { Cover } from "../voice/MusicBits";
import { clock } from "../voice/MusicPanel";
import { playableTracks } from "./playlist-tracks";

export function PlaylistDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const summary = useApp((s) => s.playlists?.[id]);
  const channels = useApp((s) => s.channels);
  const voiceId = useVoice((v) => (v.status === "connected" ? v.channelId : undefined));
  const voiceName = useApp((s) => (voiceId ? s.channels[voiceId]?.name : undefined));
  const [detail, setDetail] = useState<PlaylistDetail>();
  const [error, setError] = useState<string>();
  const send = useSubmit();
  const [notice, setNotice] = useState<string>();

  // Reload when the playlist changes (MUSIC_PLAYLIST_UPDATE keeps the summary current).
  useEffect(() => {
    client.playlist(id).then(setDetail).catch((e) => setError(errorText(e)));
  }, [id, summary?.count]);

  if (error) return <ErrorText error={error} />;
  if (!detail) return <p className="m-0 p-8 text-center text-sm text-muted-foreground">Loading…</p>;
  const name = (cid?: string) => (cid ? channels[cid]?.name : undefined);
  const tracks = playableTracks(detail.items ?? [], name);
  const inVoice = () => void send.run(async () => {
    const r = await client.queueMusic(voiceId!, { playlist_id: id });
    setNotice(addedSummary("Queued", { count: r.tracks?.length ?? 0, skipped: r.skipped, dropped: r.dropped, unreadable: r.skipped_unreadable }));
  });
  const voiceButton = (
    <Button size="sm" variant="outline" disabled={!voiceId || send.busy} onClick={inVoice}>
      <Volume2 />{voiceId ? `Play in voice · ${voiceName ?? "voice"}` : "Play in voice"}
    </Button>
  );

  return (
    <section aria-label={detail.title} className="grid gap-4">
      <div className="flex items-end gap-4">
        <Cover src={detail.cover} className="size-28 flex-none" />
        <div className="grid min-w-0 gap-1">
          <Button variant="ghost" size="sm" className="w-fit px-1 text-muted-foreground" onClick={onBack}><ArrowLeft />Playlists</Button>
          <h3 className="m-0 truncate text-2xl font-bold text-foreground">{detail.title}</h3>
          <p className="m-0 text-sm text-muted-foreground">
            {detail.count} tracks{detail.duration ? ` · ${totalLength(detail.duration)}` : ""}
            {detail.hidden > 0 && ` · ${detail.hidden} ${detail.hidden === 1 ? "track" : "tracks"} hidden`}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" disabled={!tracks.length} onClick={() => player.play(tracks)}><Play className="fill-current" />Play</Button>
            <Button size="sm" variant="outline" disabled={!tracks.length} onClick={() => player.play(tracks, 0, true)}><Shuffle />Shuffle</Button>
            {voiceId ? voiceButton : (
              <Tooltip><TooltipTrigger asChild><span tabIndex={0}>{voiceButton}</span></TooltipTrigger><TooltipContent>Join a voice channel first</TooltipContent></Tooltip>
            )}
          </div>
          {notice && <p role="status" className="m-0 text-sm text-muted-foreground">{notice}</p>}
          <ErrorText error={send.error} />
        </div>
      </div>
      <Table aria-label="Tracks">
        <TableHeader><TableRow><TableHead className="w-10">#</TableHead><TableHead>Title</TableHead><TableHead>From</TableHead><TableHead className="text-right">Length</TableHead></TableRow></TableHeader>
        <TableBody>
          {(detail.items ?? []).map((it, i) => {
            const voiceOnly = it.source === "link";
            return (
              <TableRow key={it.id} className={cn(voiceOnly && "opacity-50")}>
                <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                <TableCell>{it.title}{it.artist && <span className="text-xs text-muted-foreground"> · {it.artist}</span>}</TableCell>
                <TableCell><span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {voiceOnly ? "Voice only" : it.source === "upload" ? "Library" : `#${name(it.channel_id ?? undefined) ?? "channel"}`}
                </span></TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{it.duration ? clock(it.duration) : ""}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
```

Review Focus 2: a playlist with only unreadable files shows an empty table, "N tracks hidden", and disabled Play/Shuffle. "Play in voice" returns `PLAYLIST_EMPTY`, which `send.error` shows.

- [ ] **Step 6: Run the tests, typecheck and check in the browser.**
  - Open Music → Playlists and open a playlist.
  - Link rows are greyed out with "Voice only".
  - Play queues only files and uploads in the bottom bar.
  - "Play in voice" is disabled with a tooltip outside a call. Join a voice channel and it queues on the bot, with the notice text shown.

- [ ] **Step 7: Checkpoint.** Do not commit.

---

### Task 15: The voice panel shows file items and the unreadable count

**Files:**
- Modify: `clients/web/src/app/voice/PlaylistsTab.tsx` (`usePlay`, ~line 74; item row rendering, ~line 213+)

**Interfaces:**
- Consumes: `QueueResult.skipped_unreadable`, `PlaylistItem.source === "file"` and `channel_id`.

- [ ] **Step 1: Pass the count into the notice.** In `usePlay`:

```ts
    setNotice(addedSummary("Queued", { count: r.tracks?.length ?? 0, skipped: r.skipped, dropped: r.dropped, unreadable: r.skipped_unreadable }));
```

- [ ] **Step 2: Show the channel on file items.** In the playlist item row (where `SiteIcon` / `linkKind` render the subtitle for links), add a branch: `it.source === "file"` → subtitle `#{channels[it.channel_id]?.name ?? "channel"}`, with a `Music` icon in place of the site icon. Read channels with `useApp((s) => s.channels)` in the row's parent and pass the name down.

- [ ] **Step 3: Show hidden items.** Where `PlaylistView` loads the detail (`client.playlist`), show `"{hidden} hidden (from channels you can't read)"` under the header when `detail.hidden > 0`.

- [ ] **Step 4: Typecheck, run the tests and check in the browser.** In the voice panel, Playlists: a file item shows `#general`, and queueing shows the unreadable count when applicable.

- [ ] **Step 5: Checkpoint.** Do not commit.

---

### Task 16: End-to-end coverage

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts`. Update the gallery block (lines ~782-816) and add a new test after "announcement, forum and gallery channels".

**Interfaces:**
- Consumes: every accessible name defined above.

- [ ] **Step 1: Update the existing gallery block for the new names.**
  - `"No photos or videos yet."` becomes `"No files yet."`
  - the dialog `"Upload photos and videos"` becomes `"Upload files"`
  - the tile name `"Photo: Board night, by alice"` is unchanged in channel scope
  - `"Photo details"` is unchanged

- [ ] **Step 2: Add the new test.**

```ts
// Runs after the first tests: alice and bob exist; #general is shared.
test("global gallery: files from readable channels, music player and playlists", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");

  // alice shares a song in #general and a picture in a channel only she can see.
  await alice.getByRole("link", { name: "general" }).click();
  await alice.locator('input[type="file"]').setInputFiles({ name: "riff-idea.wav", mimeType: "audio/wav", buffer: silentWav() });
  await expect(alice.getByRole("list", { name: "Attachments" })).not.toContainText("Uploading");
  await alice.getByRole("button", { name: "Send" }).click();
  await createChannel(alice, "Text", "alice-only");
  // Make it private: follow the existing private-channel steps in this file (search for "overrides" or "Private channel"),
  // or deny @everyone View Channel through channel settings the way the roles test does.
  await alice.locator('input[type="file"]').setInputFiles({ name: "secret.png", mimeType: "image/png", buffer: solidPng(8, 8) });
  await expect(alice.getByRole("list", { name: "Attachments" })).not.toContainText("Uploading");
  await alice.getByRole("button", { name: "Send" }).click();

  // bob opens Gallery: the song is there, tagged #general; the private picture is not.
  await bob.getByRole("link", { name: "Gallery" }).click();
  const gallery = bob.getByRole("main", { name: "Gallery" });
  await expect(gallery.getByRole("button", { name: "Track: riff-idea.wav, by alice, in #general" })).toBeVisible();
  await expect(gallery.getByRole("button", { name: /secret\.png/ })).toHaveCount(0);

  // Search and the Music filter.
  await gallery.getByLabel("Search files").fill("riff");
  await expect(gallery.getByRole("button", { name: /riff-idea\.wav/ }).first()).toBeVisible();
  await gallery.getByRole("group", { name: "Show" }).getByRole("button", { name: "Music" }).click();

  // Play it: the player bar shows the track.
  await gallery.getByRole("button", { name: "Play all" }).click();
  await expect(bob.getByRole("region", { name: "Music player" })).toContainText("riff-idea.wav");

  // Add it to a new playlist; the playlist lists it.
  await gallery.getByRole("button", { name: "More for riff-idea.wav" }).click();
  await bob.getByRole("menuitem", { name: "Add to playlist" }).click();
  await bob.getByRole("menuitem", { name: "New playlist…" }).click();
  await bob.getByLabel("Playlist name").fill("Bob's riffs");
  await bob.getByRole("button", { name: "Create" }).click();
  await gallery.getByRole("tab", { name: "Playlists" }).click();
  await gallery.getByRole("button", { name: "Open Bob's riffs" }).click();
  await expect(gallery.getByRole("table", { name: "Tracks" })).toContainText("riff-idea");
  await expect(gallery.getByRole("table", { name: "Tracks" })).toContainText("#general");
});
```

The private-channel step must follow an existing pattern in `chat.spec.ts`. Search for one (`grep -n "View Channel\|overrides\|private" clients/web/e2e/chat.spec.ts`) and reuse it. If none exists, deny @everyone View Channel through the channel settings permissions UI, using that UI's labels.

- [ ] **Step 3: Run the e2e tests.** Follow the repo's e2e workflow (docker-compose.e2e plus Caddy; see `clients/web/playwright.config.ts` and any `e2e` script in `package.json`).

Run: `cd clients/web && pnpm playwright test e2e/chat.spec.ts`
Expected: all pass. If the e2e stack can't run locally, report that plainly at the checkpoint and don't claim it passed.

- [ ] **Step 4: Final checkpoint.** From the repo root:
  - `pnpm -r typecheck`, `pnpm lint` and `pnpm -r test`;
  - `cd server && go vet ./... && go test ./... -count=1`.

  Everything should be green. Summarize `git status` for the user. Do not commit; the user commits.

---

## Deviations from the spec (decided while planning)

- **Comma-separated params.** `kind` and `channel` are comma-separated strings, not repeated params, to avoid an array-encoding mismatch between huma and openapi-fetch. Behaviour is the same.
- **No soft-delete handling needed.** Deleting a message hard-deletes its attachments (`files.DeleteForMessage`), so playlist items disappear through `ON DELETE CASCADE`.
- **New route `GET /api/music/tracks/{id}/audio` (Task 4).** The spec assumed library uploads were already playable in the browser; they weren't.
- **No duration on tiles.** Tiles show size instead of duration for v1. The player shows the duration, and playlists show the stored duration.
- **Notices, not toasts.** "Toasts" are inline `role="status"` notices, because the app has no toast component.
- **No playlists in channel galleries.** The Tracks/Playlists switch appears only in the global gallery.
