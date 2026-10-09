# Milestone 5: Messaging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chat feel complete:
- safe Markdown in messages;
- replies with a quote line and jump-to-original;
- edit and delete from a hover menu;
- `@` mentions with autocomplete and highlighting;
- reactions with Unicode and custom emoji, through one shared emoji picker;
- bulk-uploaded custom emoji;
- text-only link previews.

**Architecture:**
- The `messages` package gains replies, mentions and reactions: new columns and a `message_reactions` table.
- A new `expressions` package owns custom emoji metadata and routes. Their image bytes go through the `files` blob store; files gains a small "store an image blob / register tables that reference blobs" API so its garbage collector stays correct.
- A new `linkpreview` package fetches the first link of a message with an SSRF-safe HTTP client and caches the results. `messages` attaches the preview asynchronously and publishes `MESSAGE_UPDATE`.
- Markdown is rendered only in the client: `react-markdown` + `remark-gfm` + one small remark plugin for spoilers, `:emoji:` and mentions. No raw HTML.

**Tech Stack:** Go (Huma, pgx, goose, `golang.org/x/net/html` for preview parsing) · `@datrope/core` · React 18 + shadcn/ui · `react-markdown` 9.0.1 + `remark-gfm` 4.0.0 (installed in M4) · `emojibase-data` 16.0.3 (Unicode emoji list and shortcodes, lazy-loaded) · Vitest · Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-one-server-design.md`:
- §2: custom emoji.
- §3: Message `reply_to_id` and `mentions`; Reaction; Emoji in `expressions`.
- §4: `ADD_REACTIONS`, `MANAGE_EXPRESSIONS`.
- §5: events `MESSAGE_REACTION_ADD/REMOVE` and `EMOJI_UPDATE`; link-preview rules.
- §6: M5.
- §7: deleted emoji; rate limits.
- §8: table tests for Markdown and preview address checks; the M5 e2e (reply, react with a custom emoji).

**Mockups:** the HTML is static; read it for structure and copy, then build with shadcn components and tokens.
- `docs/superpowers/mockups/Main.dc.html`, message rows:
  - reactions row with a "mine" state;
  - reply quote line above a message;
  - highlighted mention pill and mention-highlighted message;
  - `(edited)`, a code block, an inline custom emoji;
  - link preview card with site, title and description.
- `Main.dc.html`, composer: "Replying to …" bar with cancel, and an emoji button.
- `docs/superpowers/mockups/SettingsEmoji.dc.html`: bulk upload tiles with `:name:` inputs; server emoji table with search and delete.

## Global Constraints

- **Never commit.** (AGENTS.md §5.) Each task ends with a *Checkpoint*: the controller reviews and stages; nobody commits.
- **Markdown** (spec §6 M5): bold, italic, strikethrough, inline code, code blocks, quotes, lists, links (and bare URLs), spoilers `||…||`, `:emoji:`. **No raw HTML.** Anything else (headings, images, tables, horizontal rules) renders as its plain text content.
- **Replies:** `reply_to_id` must be a live message in the same channel. The reply shows a quote line: author plus the first line of the original, or "Original message deleted".
- **Mentions:** the server parses `@username` into `mentions`:
  - usernames match `^[A-Za-z0-9_.-]{2,32}$`, case-insensitive;
  - user IDs of existing accounts only, at most 20, in order of first appearance, no duplicates;
  - edits re-parse.
- **Reactions:**
  - The emoji is a Unicode emoji or `custom:<emoji id>`.
  - Adding a reaction nobody has used on that message yet needs `ADD_REACTIONS`; adding to an existing one needs only `READ_HISTORY`.
  - Rate limit: **10 reactions per 10 s per user**.
  - DM participants hold `ADD_REACTIONS`: it is added to the fixed DM permission set on the server and the client.
- **Custom emoji:**
  - PNG, GIF or WebP, **≤ 256 KB** each, **≤ 200 per server**.
  - Names match `^[A-Za-z0-9_]{2,32}$`, unique case-insensitively.
  - Upload, rename and delete need `MANAGE_EXPRESSIONS`.
  - When an emoji is deleted, its reactions disappear and messages show its `:name:` as text.
- **Link previews** (spec §5):
  - Use the first link of a message outside code and spoilers; http/https only.
  - Public addresses only: no loopback, private, link-local, CGNAT, multicast, unspecified or metadata ranges. Check on every connection after DNS resolution, including redirects (at most 3).
  - Read at most 1 MB within 5 s total; `text/html` only.
  - Use OpenGraph `og:site_name`/`og:title`/`og:description`, else `<title>`/`meta name=description`.
  - Cache for 24 h, failures included. At most **30 fetches per minute per server**. No images.
- **Event payloads:**
  - `MESSAGE_REACTION_ADD` and `MESSAGE_REACTION_REMOVE`: `{channel_id, message_id, emoji, user_id}`.
  - `EMOJI_UPDATE`: `{emoji: Emoji[]}`, the full list.
- **Web UI:** shadcn/ui components first (AGENTS.md §6; hand-write registry components with the documented fallback if the CLI cannot run); tokens only; dark only; keep accessible names stable (the e2e selects by role and label).
- **Dev environment:**
  - The user's dev servers run on :8081 and :5173.
  - Implementers never start or stop them.
  - Implementers never run `pnpm install`/`add` while Vite runs, because Vite locks native binaries. The controller installs new npm packages before dispatching a task that needs them.
  - Go tests run from PowerShell with `$env:GOTOOLCHAIN='local'`.
- **Out of scope** (later milestones):
  - M6: threads, categories, pins, the unread "New messages" line.
  - M7: soundboard.
  - M8: mention count badges and inbox, search, notifications.
  - Not scheduled: link-preview images.

## Decisions this plan makes

1. `Message` gains four fields, all filled by every route that returns messages:
   - `reply_to`: `{id, author, content, deleted}`, with `content` cut to 200 characters;
   - `mentions`;
   - `reactions`: `[{emoji, count, user_ids}]`, sorted by first use;
   - `embed`: `{url, site, title, description}`.
2. Reactions on a deleted message are removed with it. The client URL-path-escapes the emoji in the reactions path.
3. Unicode emoji validation on the server is structural:
   - 1–10 code points, ≤ 32 bytes;
   - every code point is one of: an emoji pictograph, a regional indicator, a keycap base (`0-9#*` followed by U+FE0F U+20E3), U+200D (ZWJ), U+FE0F, or a skin-tone modifier;
   - at least one code point is a pictograph, regional indicator or keycap.
4. Custom emoji images are public at `/api/emoji/{id}`, like the server icon, so `<img>` works everywhere. The list is in READY (`emoji`) for members, gated members included.
5. Bulk upload: after the user edits names, the client sends one `POST /api/server/emoji` per tile. Failures are shown per tile.
6. Jumping to a replied-to message scrolls to it if it is loaded. Otherwise the client loads older pages (at most 5) until it appears; if it never does, a short message says it is too far back.
7. Unicode `:shortcode:` text in messages renders as the emoji when the shortcode exists in emojibase's GitHub shortcode set. Custom emoji names take precedence.
8. Link previews are fetched asynchronously. The message is sent immediately and the preview arrives as a `MESSAGE_UPDATE`. Editing a message re-evaluates its first link.

## File Structure

```
server/internal/db/migrations/00011_replies_mentions.sql  reply_to_id, mentions
server/internal/db/migrations/00012_reactions.sql         message_reactions
server/internal/db/migrations/00013_emoji.sql             emoji
server/internal/db/migrations/00014_link_previews.sql     link_previews cache, messages.embed
server/internal/messages/    replies.go, mentions.go, reactions.go, emoji_validate.go, previews.go (+ tests)
server/internal/expressions/ expressions.go, handlers.go, expressions_test.go (custom emoji)
server/internal/linkpreview/ fetch.go (SSRF-safe client), parse.go, linkpreview.go (cache + rate limit), tests
server/internal/files/       blobs.go (StoreImageBlob, blob-referencing tables, ServeBlob)
server/internal/auth/        UserIDsByUsername
server/internal/perms/       DM gains ADD_REACTIONS
server/internal/app/         wiring, READY emoji, event schemas
clients/core/src/            types, store (reactions, emoji, embeds), client (reply, react, emoji), perms DM
clients/web/src/chat/        Markdown.tsx, remarkChat.ts (+ tests), emoji-data.ts, EmojiPicker.tsx, Reactions.tsx, Autocomplete.tsx
clients/web/src/app/         MessageList.tsx (row redesign), MessageToolbar.tsx, ReplyQuote.tsx, LinkPreview.tsx, Composer.tsx
clients/web/src/app/server-settings/Emoji.tsx
clients/web/e2e/chat.spec.ts
```

---

### Task 1: Replies and mentions (server)

**Files:**
- Create: `server/internal/db/migrations/00011_replies_mentions.sql`, `server/internal/messages/replies.go`, `server/internal/messages/mentions.go`, `server/internal/messages/mentions_test.go` (pure unit test), `server/internal/messages/replies_test.go`
- Modify: `server/internal/messages/messages.go` (`Message`, scan/list/get, `hydrate`), `handlers.go` (send, edit), `server/internal/auth/store.go` + `service.go` (`UserIDsByUsername`), `server/internal/apptest/apptest.go` (`CreateTextChannel` if missing)

**Interfaces:**
- **Message fields:**
  - `Message.ReplyTo *ReplyRef` (JSON `reply_to,omitempty`).
  - `type ReplyRef struct{ ID id.ID; Author auth.PublicUser; Content string; Deleted bool }` (JSON `id`, `author`, `content`, `deleted`).
  - `Message.Mentions []id.ID` (JSON `mentions`, never null).
- **Request and errors:** `SendRequest.ReplyToID *id.ID` (JSON `reply_to_id,omitempty`); error `400 REPLY_NOT_FOUND` ("you can only reply to a message in this channel").
- **Username lookup:** `messages.Users` gains `UserIDsByUsername(ctx, names []string) (map[string]id.ID, error)` (keys lower-cased), implemented by `auth.(*Service).UserIDsByUsername`.
- **Helpers:**
  - `(*Service).hydrate(ctx, []Message) error` fills authors, attachments and reply references. Later tasks add reactions and embeds to it.
  - `parseMentions(content string) []string`: lower-cased usernames, in order, unique, at most 20. It ignores text inside inline code and code blocks. A mention is `@` preceded by the start of the text or a character that is not a letter, digit, `_`, `.`, `-` or `@`. A trailing `.` or `-` is not part of the name.

- [ ] **Step 1: Write the failing tests** — `server/internal/messages/mentions_test.go` (package `messages`, no database):

```go
package messages

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseMentions(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"hi @Alice and @bob", []string{"alice", "bob"}},
		{"@alice @ALICE @alice", []string{"alice"}},
		{"mail me at bob@example.com", nil},
		{"`@alice` in code", nil},
		{"```\n@alice\n```\n@bob", []string{"bob"}},
		{"(@carol.x) @d", []string{"carol.x"}}, // @d is too short
		{"thanks @bob.", []string{"bob"}},
		{"@a_b-c.d!", []string{"a_b-c.d"}},
	}
	for _, c := range cases {
		require.Equal(t, c.want, parseMentions(c.in), c.in)
	}
	var many strings.Builder
	for i := 0; i < 30; i++ {
		fmt.Fprintf(&many, "@user%02d ", i)
	}
	require.Len(t, parseMentions(many.String()), 20)
}
```

`server/internal/messages/replies_test.go` (package `messages_test`):

```go
package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/messages"
)

func TestReplies(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	orig := alice.Send(general, "first line\nsecond line")

	var reply messages.Message
	bob.Do(http.MethodPost, "/api/channels/"+general.String()+"/messages",
		map[string]any{"content": "agreed", "reply_to_id": orig.ID.String()}, http.StatusCreated, &reply)
	require.NotNil(t, reply.ReplyTo)
	require.Equal(t, orig.ID, reply.ReplyTo.ID)
	require.Equal(t, "alice", reply.ReplyTo.Author.Username)
	require.Equal(t, "first line\nsecond line", reply.ReplyTo.Content)

	// The reference survives in history and shows deletion.
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+orig.ID.String(), nil, http.StatusNoContent, nil)
	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &page)
	require.True(t, page[0].ReplyTo.Deleted)
	require.Empty(t, page[0].ReplyTo.Content)

	// Only live messages in the same channel.
	other := alice.CreateTextChannel("other")
	elsewhere := alice.Send(other, "x")
	bob.Fail(http.MethodPost, "/api/channels/"+general.String()+"/messages",
		map[string]any{"content": "nope", "reply_to_id": elsewhere.ID.String()}, http.StatusBadRequest, "REPLY_NOT_FOUND")
	bob.Fail(http.MethodPost, "/api/channels/"+general.String()+"/messages",
		map[string]any{"content": "nope", "reply_to_id": orig.ID.String()}, http.StatusBadRequest, "REPLY_NOT_FOUND")
}

func TestMentions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	m := alice.Send(general, "hey @BOB and @nobody, also @alice")
	require.Equal(t, []any{bob.User.ID, alice.User.ID}, toAny(m.Mentions))

	var edited messages.Message
	alice.Do(http.MethodPatch, "/api/channels/"+general.String()+"/messages/"+m.ID.String(),
		map[string]any{"content": "never mind"}, http.StatusOK, &edited)
	require.NotNil(t, edited.Mentions, "mentions is [] not null")
	require.Empty(t, edited.Mentions)
}
```

(`toAny` is a two-line helper in the test file converting `[]id.ID` to `[]any`; or compare `[]id.ID{bob.User.ID, alice.User.ID}` directly if the types line up.) If `apptest` has no `CreateTextChannel(name string) id.ID`, add it: POST `/api/server/channels` with `{"name": name, "type": "text"}`, expect 201, and return the ID.

- [ ] **Step 2: Run to verify they fail** — PowerShell: `$env:GOTOOLCHAIN='local'; go -C server test ./internal/messages/ -run 'TestParseMentions|TestReplies|TestMentions'`. Expected: compile errors (`parseMentions`, `ReplyTo` undefined).

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00011_replies_mentions.sql`:

```sql
-- +goose Up
ALTER TABLE messages
    ADD COLUMN reply_to_id BIGINT REFERENCES messages (id) ON DELETE SET NULL,
    ADD COLUMN mentions BIGINT[] NOT NULL DEFAULT '{}';
CREATE INDEX messages_mentions_idx ON messages USING gin (mentions);

-- +goose Down
DROP INDEX messages_mentions_idx;
ALTER TABLE messages DROP COLUMN mentions, DROP COLUMN reply_to_id;
```

- [ ] **Step 4: Mentions** — `server/internal/messages/mentions.go`:

```go
package messages

import (
	"context"
	"regexp"
	"strings"

	"github.com/datrope/datrope/server/internal/id"
)

const maxMentions = 20

var (
	codeBlock  = regexp.MustCompile("(?s)```.*?(```|$)")
	inlineCode = regexp.MustCompile("`[^`\n]*`")
	mentionRe  = regexp.MustCompile(`(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9_.-]{2,32})`)
)

// parseMentions returns the lower-cased usernames mentioned in content, in
// order of first appearance, without duplicates, ignoring code.
func parseMentions(content string) []string {
	text := inlineCode.ReplaceAllString(codeBlock.ReplaceAllString(content, " "), " ")
	var out []string
	seen := map[string]bool{}
	for _, m := range mentionRe.FindAllStringSubmatch(text, -1) {
		name := strings.ToLower(strings.TrimRight(m[2], ".-")) // "@bob." ends a sentence
		if len(name) < 2 || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
		if len(out) == maxMentions {
			break
		}
	}
	return out
}

// mentionIDs resolves the users mentioned in content; unknown names are ignored.
func (s *Service) mentionIDs(ctx context.Context, content string) ([]id.ID, error) {
	out := []id.ID{}
	names := parseMentions(content)
	if len(names) == 0 {
		return out, nil
	}
	byName, err := s.users.UserIDsByUsername(ctx, names)
	if err != nil {
		return nil, err
	}
	for _, n := range names {
		if uid, ok := byName[n]; ok {
			out = append(out, uid)
		}
	}
	return out, nil
}
```

(Go's RE2 has no lookbehind, so the preceding character is captured in group 1. Two adjacent mentions separated by one space both match, because the space before the second `@` is not consumed by the first match's group 2.)

In `server/internal/auth/store.go`:

```go
// UserIDsByUsername maps lower-cased usernames to user IDs; unknown names are absent.
func (s *Store) UserIDsByUsername(ctx context.Context, names []string) (map[string]id.ID, error) {
	rows, err := s.db.Query(ctx, `SELECT lower(username), id FROM users WHERE lower(username) = ANY($1)`, names)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]id.ID{}
	for rows.Next() {
		var n string
		var uid id.ID
		if err := rows.Scan(&n, &uid); err != nil {
			return nil, err
		}
		out[n] = uid
	}
	return out, rows.Err()
}
```

and in `service.go`: `func (s *Service) UserIDsByUsername(ctx context.Context, names []string) (map[string]id.ID, error) { return s.store.UserIDsByUsername(ctx, names) }`. Add the method to the `messages.Users` interface.

- [ ] **Step 5: Replies** — `server/internal/messages/replies.go`:

```go
package messages

import (
	"context"
	"net/http"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

const replyPreviewLen = 200

// ReplyRef is the message a reply points at, as the reply shows it.
type ReplyRef struct {
	ID      id.ID           `json:"id"`
	Author  auth.PublicUser `json:"author"`
	Content string          `json:"content" doc:"Up to 200 characters; empty when deleted"`
	Deleted bool            `json:"deleted"`
}

func errReplyNotFound() *httpx.Error {
	return httpx.E(http.StatusBadRequest, "REPLY_NOT_FOUND", "you can only reply to a message in this channel")
}

// checkReply verifies that replyTo is a live message in channelID.
func (s *Service) checkReply(ctx context.Context, channelID, replyTo id.ID) error {
	var ok bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2 AND NOT deleted)`,
		replyTo, channelID).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return errReplyNotFound()
	}
	return nil
}

// withReplies fills ReplyTo for messages that reply to another.
func (s *Service) withReplies(ctx context.Context, ms []Message) error {
	var ids []id.ID
	for _, m := range ms {
		if m.replyToID != nil {
			ids = append(ids, *m.replyToID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT id, author_id, left(content, $2), deleted FROM messages WHERE id = ANY($1)`,
		id.Int64s(ids), replyPreviewLen)
	if err != nil {
		return err
	}
	defer rows.Close()
	refs := map[id.ID]*ReplyRef{}
	var authors []id.ID
	for rows.Next() {
		r := &ReplyRef{}
		if err := rows.Scan(&r.ID, &r.Author.ID, &r.Content, &r.Deleted); err != nil {
			return err
		}
		if r.Deleted {
			r.Content = ""
		}
		refs[r.ID] = r
		authors = append(authors, r.Author.ID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	users, err := s.users.PublicUsers(ctx, authors)
	if err != nil {
		return err
	}
	for i := range ms {
		if ms[i].replyToID == nil {
			continue
		}
		if r := refs[*ms[i].replyToID]; r != nil {
			r.Author = users[r.Author.ID]
			ms[i].ReplyTo = r
		}
	}
	return nil
}
```

In `messages.go`:
- `Message` gains `ReplyTo *ReplyRef \`json:"reply_to,omitempty"\``, `Mentions []id.ID \`json:"mentions"\`` and an unexported `replyToID *id.ID`.
- `messageCols` becomes `id, channel_id, author_id, content, edited_at, deleted, reply_to_id, mentions`.
- `scanMessage` scans `reply_to_id` (nullable int64, then `id.FromNullable`) and `mentions` (`[]int64` converted to `[]id.ID`, never nil).
- Add one helper used by every path that returns messages:

```go
// hydrate fills what the messages table does not hold: authors, attachments
// and reply references.
func (s *Service) hydrate(ctx context.Context, ms []Message) error {
	if err := s.withAuthors(ctx, ms); err != nil {
		return err
	}
	if err := s.withAttachments(ctx, ms); err != nil {
		return err
	}
	return s.withReplies(ctx, ms)
}
```

`list` calls `hydrate` instead of its two calls. Send and edit call `hydrate` on a one-element slice before publishing. Edit currently sets the author and attachments by hand; replace that with `hydrate`.

- [ ] **Step 6: Handlers** — `SendRequest` gains `ReplyToID *id.ID \`json:"reply_to_id,omitempty" doc:"Reply to this message (same channel)"\``.
  - **Send:** if `ReplyToID` is set, call `s.checkReply(ctx, ch.ID, *in.Body.ReplyToID)`. Compute `mentions, err := s.mentionIDs(ctx, content)`, then insert `reply_to_id` and `mentions` (`id.Int64s(mentions)`) with the message.
  - **Edit:** recompute mentions and run `UPDATE messages SET content = $2, mentions = $3, edited_at = now() WHERE … RETURNING `+messageCols`.

- [ ] **Step 7: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...` (PowerShell). Expected: PASS. `gofmt -l server` empty.

- [ ] **Step 8: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(messages): replies and mentions`

---

### Task 2: Reactions (server)

**Files:**
- Create: `server/internal/db/migrations/00012_reactions.sql`, `server/internal/messages/reactions.go`, `server/internal/messages/emoji_validate.go`, `server/internal/messages/emoji_validate_test.go`, `server/internal/messages/reactions_test.go`
- Modify: `server/internal/messages/messages.go` (`Message.Reactions`, `hydrate`, fields), `handlers.go` (register routes; delete removes reactions), `server/internal/perms/perms.go` (`DM` gains `AddReactions`), `server/internal/app/realtime.go` (event schema)

**Interfaces:**
- **Consumes (Task 1):** `hydrate`, `Message`.
- **Types:**
  - `type Reaction struct{ Emoji string; Count int; UserIDs []id.ID }` (JSON `emoji`, `count`, `user_ids`).
  - `Message.Reactions []Reaction` (JSON `reactions`, never null; ordered by each emoji's first use).
  - `type ReactionEvent struct{ ChannelID, MessageID id.ID; Emoji string; UserID id.ID }` (JSON `channel_id`, `message_id`, `emoji`, `user_id`).
- **Routes:**
  - `add-reaction` `PUT /api/channels/{id}/messages/{messageID}/reactions/{emoji}` → 204.
  - `remove-reaction` `DELETE …/reactions/{emoji}` → 204. It removes your own reaction and answers 204 even when there was none.
- **Events:** `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`.
- **Errors:** `400 INVALID_EMOJI`, `429 RATE_LIMITED` (whatever code `httpx.RateLimited()` uses), `403 MISSING_PERMISSION`.
- **Custom emoji hook:** `validUnicodeEmoji(s string) bool`; `type CustomEmoji interface{ EmojiExists(ctx, emojiID id.ID) (bool, error) }` with `(*Service).SetCustomEmoji(CustomEmoji)`. Until Task 3 wires it up, `custom:<id>` is refused with `INVALID_EMOJI`.
- **Cleanup:** `(*Service).RemoveReactions(ctx, emoji string) error`, used by Task 3 when an emoji is deleted.

- [ ] **Step 1: Write the failing tests** — `server/internal/messages/emoji_validate_test.go`:

```go
package messages

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidUnicodeEmoji(t *testing.T) {
	for _, ok := range []string{"👍", "👍🏽", "❤️", "🇸🇪", "1️⃣", "#️⃣", "👩‍👩‍👧", "🏳️‍🌈", "😀", "✅", "☕"} {
		require.True(t, validUnicodeEmoji(ok), ok)
	}
	for _, bad := range []string{"", "a", "ab", "👍 ", " 👍", "1", "👍a", "<script>", "‍", "️",
		"😀😀😀😀😀😀😀😀😀😀😀", "custom:1"} {
		require.False(t, validUnicodeEmoji(bad), bad)
	}
}
```

`server/internal/messages/reactions_test.go`:

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

func reactPath(chID, msgID id.ID, emoji string) string {
	return "/api/channels/" + chID.String() + "/messages/" + msgID.String() + "/reactions/" + url.PathEscape(emoji)
}

func TestReactions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	m := alice.Send(general, "react to me")
	ws, _ := alice.Connect()

	bob.Do(http.MethodPut, reactPath(general, m.ID, "👍"), nil, http.StatusNoContent, nil)
	var ev messages.ReactionEvent
	ws.ExpectDispatch("MESSAGE_REACTION_ADD", &ev)
	require.Equal(t, "👍", ev.Emoji)
	require.Equal(t, bob.User.ID, ev.UserID)

	alice.Do(http.MethodPut, reactPath(general, m.ID, "👍"), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, reactPath(general, m.ID, "👍"), nil, http.StatusNoContent, nil) // idempotent
	ws.ExpectDispatch("MESSAGE_REACTION_ADD", nil)
	ws.ExpectNoDispatch("MESSAGE_REACTION_ADD", 200*time.Millisecond) // the repeat changed nothing

	var page []messages.Message
	alice.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &page)
	require.Len(t, page[0].Reactions, 1)
	require.Equal(t, "👍", page[0].Reactions[0].Emoji)
	require.Equal(t, 2, page[0].Reactions[0].Count)
	require.Equal(t, []id.ID{bob.User.ID, alice.User.ID}, page[0].Reactions[0].UserIDs)

	bob.Do(http.MethodDelete, reactPath(general, m.ID, "👍"), nil, http.StatusNoContent, nil)
	ws.ExpectDispatch("MESSAGE_REACTION_REMOVE", &ev)
	require.Equal(t, bob.User.ID, ev.UserID)
	bob.Do(http.MethodDelete, reactPath(general, m.ID, "👍"), nil, http.StatusNoContent, nil) // already gone

	bob.Fail(http.MethodPut, reactPath(general, m.ID, "lol"), nil, http.StatusBadRequest, "INVALID_EMOJI")
	bob.Fail(http.MethodPut, reactPath(general, m.ID, "custom:123"), nil, http.StatusBadRequest, "INVALID_EMOJI")

	// Deleting the message drops its reactions.
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+m.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &page)
	require.Empty(t, page[0].Reactions)
}

func TestReactionPermissionsAndLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	m := alice.Send(general, "x")
	alice.Do(http.MethodPut, reactPath(general, m.ID, "🎉"), nil, http.StatusNoContent, nil)

	// Without ADD_REACTIONS you can join an existing reaction but not start one.
	srv := alice.Server()
	alice.Do(http.MethodPatch, "/api/server/roles/"+srv.ID.String(),
		map[string]any{"permissions": perms.Default &^ perms.AddReactions}, http.StatusOK, nil)
	bob.Do(http.MethodPut, reactPath(general, m.ID, "🎉"), nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodPut, reactPath(general, m.ID, "🥳"), nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestReactionRateLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	m := alice.Send(general, "x")
	emoji := []string{"😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊"}
	for _, e := range emoji {
		alice.Do(http.MethodPut, reactPath(general, m.ID, e), nil, http.StatusNoContent, nil)
	}
	alice.Fail(http.MethodPut, reactPath(general, m.ID, "😋"), nil, http.StatusTooManyRequests, rateLimitedCode)
}
```

Add `"time"` to the imports. `rateLimitedCode` stands for the literal code `httpx.RateLimited()` returns: read `server/internal/httpx/errors.go` and write it in.

- [ ] **Step 2: Run to verify they fail** — `go -C server test ./internal/messages/ -run 'TestValidUnicodeEmoji|TestReaction'`. Expected: compile errors.

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00012_reactions.sql`:

```sql
-- +goose Up
-- emoji is a Unicode emoji or "custom:<emoji id>".
CREATE TABLE message_reactions (
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (message_id, emoji, user_id)
);
CREATE INDEX message_reactions_custom_idx ON message_reactions (emoji) WHERE emoji LIKE 'custom:%';

-- +goose Down
DROP TABLE message_reactions;
```

- [ ] **Step 4: Validation** — `server/internal/messages/emoji_validate.go`:

```go
package messages

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

const keycapBases = "0123456789#*"

// validUnicodeEmoji is a structural check (M5 plan decision 3): short, made
// only of emoji code points and their joiners and modifiers, with at least
// one pictograph, flag letter or keycap.
func validUnicodeEmoji(s string) bool {
	if s == "" || len(s) > 32 || !utf8.ValidString(s) {
		return false
	}
	runes := []rune(s)
	if len(runes) > 10 {
		return false
	}
	base := false
	for i, r := range runes {
		switch {
		case isPictograph(r), isRegionalIndicator(r):
			base = true
		case r == 0x200D, r == 0xFE0F, r >= 0x1F3FB && r <= 0x1F3FF, r >= 0xE0020 && r <= 0xE007F:
			// ZWJ, VS16, skin tones, tag sequences (subdivision flags)
		case r == 0x20E3: // combining keycap: must follow [0-9#*] FE0F
			if i < 2 || runes[i-1] != 0xFE0F || !strings.ContainsRune(keycapBases, runes[i-2]) {
				return false
			}
			base = true
		case strings.ContainsRune(keycapBases, r):
			if i+2 >= len(runes) || runes[i+1] != 0xFE0F || runes[i+2] != 0x20E3 {
				return false
			}
		default:
			return false
		}
	}
	return base
}

func isRegionalIndicator(r rune) bool { return r >= 0x1F1E6 && r <= 0x1F1FF }

// isPictograph covers the emoji blocks; precise enough for validating reactions.
func isPictograph(r rune) bool {
	switch {
	case r >= 0x1F000 && r <= 0x1FAFF:
		return !isRegionalIndicator(r) && !(r >= 0x1F3FB && r <= 0x1F3FF)
	case r >= 0x2600 && r <= 0x27BF, r >= 0x2190 && r <= 0x21FF, r >= 0x2300 && r <= 0x23FF, r >= 0x2B00 && r <= 0x2BFF:
		return true
	case r == 0x00A9, r == 0x00AE, r == 0x203C, r == 0x2049, r == 0x2122, r == 0x2139, r == 0x24C2,
		r == 0x3030, r == 0x303D, r == 0x3297, r == 0x3299:
		return true
	}
	return false
}

// customEmojiID parses "custom:<id>".
func customEmojiID(s string) (int64, bool) {
	rest, ok := strings.CutPrefix(s, "custom:")
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(rest, 10, 64)
	return n, err == nil && n > 0
}
```

- [ ] **Step 5: Reactions** — `server/internal/messages/reactions.go`:

```go
package messages

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type Reaction struct {
	Emoji   string  `json:"emoji" doc:"A Unicode emoji or custom:<emoji id>"`
	Count   int     `json:"count"`
	UserIDs []id.ID `json:"user_ids"`
}

type ReactionEvent struct {
	ChannelID id.ID  `json:"channel_id"`
	MessageID id.ID  `json:"message_id"`
	Emoji     string `json:"emoji"`
	UserID    id.ID  `json:"user_id"`
}

// CustomEmoji is what this package needs from expressions.
type CustomEmoji interface {
	EmojiExists(ctx context.Context, emojiID id.ID) (bool, error)
}

func (s *Service) SetCustomEmoji(c CustomEmoji) { s.custom = c }

type reactionPath struct {
	ID        string `path:"id"`
	MessageID string `path:"messageID"`
	Emoji     string `path:"emoji" maxLength:"64"`
}

func errInvalidEmoji() *httpx.Error {
	return httpx.BadRequest("INVALID_EMOJI", "that is not an emoji this server knows")
}

func (s *Service) checkEmoji(ctx context.Context, emoji string) error {
	if n, ok := customEmojiID(emoji); ok {
		if s.custom == nil {
			return errInvalidEmoji()
		}
		exists, err := s.custom.EmojiExists(ctx, id.ID(n))
		if err != nil {
			return err
		}
		if !exists {
			return errInvalidEmoji()
		}
		return nil
	}
	if !validUnicodeEmoji(emoji) {
		return errInvalidEmoji()
	}
	return nil
}

// withReactions fills Reactions, ordered by each emoji's first use.
func (s *Service) withReactions(ctx context.Context, ms []Message) error {
	ids := make([]id.ID, 0, len(ms))
	for i := range ms {
		ms[i].Reactions = []Reaction{}
		ids = append(ids, ms[i].ID)
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT message_id, emoji, array_agg(user_id ORDER BY created_at)
		FROM message_reactions WHERE message_id = ANY($1)
		GROUP BY message_id, emoji ORDER BY min(created_at)`, id.Int64s(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	byMsg := map[id.ID][]Reaction{}
	for rows.Next() {
		var mid id.ID
		var r Reaction
		var users []int64
		if err := rows.Scan(&mid, &r.Emoji, &users); err != nil {
			return err
		}
		for _, u := range users {
			r.UserIDs = append(r.UserIDs, id.ID(u))
		}
		r.Count = len(r.UserIDs)
		byMsg[mid] = append(byMsg[mid], r)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range ms {
		if rs := byMsg[ms[i].ID]; rs != nil {
			ms[i].Reactions = rs
		}
	}
	return nil
}

// RemoveReactions deletes every reaction with this emoji (a deleted custom emoji).
func (s *Service) RemoveReactions(ctx context.Context, emoji string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM message_reactions WHERE emoji = $1`, emoji)
	return err
}

type accessFunc func(ctx context.Context, raw string, need perms.Perms) (*channels.Channel, perms.Perms, error)

func registerReactions(api huma.API, s *Service, op func(string, string, string, int) huma.Operation, access accessFunc) {
	huma.Register(api, op("add-reaction", http.MethodPut, "/api/channels/{id}/messages/{messageID}/reactions/{emoji}", http.StatusNoContent),
		func(ctx context.Context, in *reactionPath) (*struct{}, error) {
			ch, have, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			if err := s.checkEmoji(ctx, in.Emoji); err != nil {
				return nil, err
			}
			me := auth.Current(ctx).User.ID
			if !s.reactLimit.Allow(me.String()) {
				return nil, httpx.RateLimited()
			}
			var exists bool
			if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM message_reactions WHERE message_id = $1 AND emoji = $2)`,
				m.ID, in.Emoji).Scan(&exists); err != nil {
				return nil, err
			}
			if !exists && !have.Has(perms.AddReactions) {
				return nil, httpx.MissingPermission()
			}
			tag, err := s.db.Exec(ctx, `INSERT INTO message_reactions (message_id, emoji, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
				m.ID, in.Emoji, me)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() > 0 {
				s.publish("MESSAGE_REACTION_ADD", ch.ID, ReactionEvent{ChannelID: ch.ID, MessageID: m.ID, Emoji: in.Emoji, UserID: me})
			}
			return nil, nil
		})

	huma.Register(api, op("remove-reaction", http.MethodDelete, "/api/channels/{id}/messages/{messageID}/reactions/{emoji}", http.StatusNoContent),
		func(ctx context.Context, in *reactionPath) (*struct{}, error) {
			ch, _, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			mid, err := httpx.ParseID(in.MessageID, "message")
			if err != nil {
				return nil, err
			}
			me := auth.Current(ctx).User.ID
			tag, err := s.db.Exec(ctx, `
				DELETE FROM message_reactions r USING messages m
				WHERE r.message_id = m.id AND m.channel_id = $1 AND r.message_id = $2 AND r.emoji = $3 AND r.user_id = $4`,
				ch.ID, mid, in.Emoji, me)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() > 0 {
				s.publish("MESSAGE_REACTION_REMOVE", ch.ID, ReactionEvent{ChannelID: ch.ID, MessageID: mid, Emoji: in.Emoji, UserID: me})
			}
			return nil, nil
		})
}
```

In `messages.go`:
- Add the fields `custom CustomEmoji` and `reactLimit *ratelimit.Limiter`. Initialise `reactLimit` in `NewService` with `ratelimit.New(60, 10)`, which allows 10 per 10 s with a burst of 10.
- `hydrate` also calls `withReactions`. Deleted messages get `[]`.

In `handlers.go`:
- Call `registerReactions(api, s, op, access)` from `Register`; the existing `access` closure matches `accessFunc`.
- In `delete-message`, inside the transaction, run `DELETE FROM message_reactions WHERE message_id = $1`.

The reactions route must reject the welcome channel like every other message route; it does, because it uses the same `access` helper.

Huma path parameters come from `http.ServeMux` (`r.PathValue`), already unescaped. The `👍` test confirms it; the client escapes with `encodeURIComponent`.

- [ ] **Step 6: DM permissions and schemas** — `perms.DM` gains `| AddReactions`; update its doc comment and `perms_test.go` if it asserts the DM set. In `app/realtime.go` `registerEventSchemas`, add `messages.ReactionEvent{}`.

- [ ] **Step 7: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...`. Expected: PASS. `gofmt -l server` empty.

- [ ] **Step 8: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(messages): reactions`

---
### Task 3: Custom emoji (server)

**Files:**
- Create: `server/internal/db/migrations/00013_emoji.sql`, `server/internal/files/blobs.go`, `server/internal/expressions/expressions.go`, `server/internal/expressions/handlers.go`, `server/internal/expressions/expressions_test.go`
- Modify: `server/internal/files/files.go` (`removeIfUnused` uses the registered blob tables), `server/internal/files/server_images.go` (reuse `ServeBlob` in its download handler), `server/internal/app/app.go` (wiring, routes), `server/internal/app/realtime.go` (READY `emoji`, schemas)

**Interfaces:**
- **Consumes:** Task 2's `messages.CustomEmoji` / `SetCustomEmoji` / `RemoveReactions`; M4's `communities.(*Service).BasePerms`, `ServerID`; `perms.ManageExpressions`.
- **Produces (package `files`):**
  - `(*Service).AddBlobTable(table, column string)`: rows of that table keep blobs alive. Call it at startup; the arguments are code constants.
  - `(*Service).StoreImageBlob(ctx, tx pgx.Tx, data []byte) (sum, contentType string, err error)`: sniff (PNG, JPEG, WebP or GIF), clean metadata, check it decodes, stage and commit the blob while holding the blob lock in `tx`. Error `400 NOT_AN_IMAGE`.
  - `(*Service).ServeBlob(w, r, sum, contentType string, immutable bool)`: the response headers the server-image download already uses.
- **Produces (package `expressions`):**
  - `type Emoji struct{ ID id.ID; Name string; URL string; CreatorID *id.ID }` (JSON `id`, `name`, `url`, `creator_id,omitempty`); `URL` = `/api/emoji/<id>`.
  - `(*Service).List(ctx) ([]Emoji, error)`, `(*Service).EmojiExists(ctx, id) (bool, error)`.
  - Routes:
    - `list-emoji` `GET /api/server/emoji` (any member, gated included);
    - raw `POST /api/server/emoji` (multipart fields `name` and `file`) → 201 `Emoji`;
    - `rename-emoji` `PATCH /api/server/emoji/{emojiID}` `{name}` → `Emoji`;
    - `delete-emoji` `DELETE /api/server/emoji/{emojiID}` → 204;
    - public raw `GET /api/emoji/{id}`.
  - Event `EMOJI_UPDATE` `{emoji: Emoji[]}` (type `EmojiUpdate`), published after every change.
  - Errors: `400 INVALID_NAME`, `409 NAME_TAKEN`, `400 EMOJI_LIMIT` ("this server already has 200 emoji"), `413 TOO_LARGE`, `400 NOT_AN_IMAGE`, `403 MISSING_PERMISSION`.
- **Produces (package `app`):** `Ready.Emoji []expressions.Emoji` (JSON `emoji`, `[]` for non-members).
- **Allowed types:** PNG, GIF, WebP only. JPEG is refused for emoji with `NOT_AN_IMAGE` and the message "emoji must be PNG, GIF or WebP".

- [ ] **Step 1: Write the failing tests** — `server/internal/expressions/expressions_test.go`:

```go
package expressions_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/expressions"
)

func pngBytes(t *testing.T, size int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func upload(t *testing.T, c *apptest.Client, name string, data []byte, want int) []byte {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	require.NoError(t, mw.WriteField("name", name))
	fw, err := mw.CreateFormFile("file", name+".png")
	require.NoError(t, err)
	_, _ = fw.Write(data)
	require.NoError(t, mw.Close())
	_, raw := c.Raw(http.MethodPost, "/api/server/emoji", &body, mw.FormDataContentType(), want)
	return raw
}

func TestEmojiLifecycle(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var e expressions.Emoji
	require.NoError(t, json.Unmarshal(upload(t, alice, "party_parrot", pngBytes(t, 32), http.StatusCreated), &e))
	require.Equal(t, "party_parrot", e.Name)
	require.Equal(t, "/api/emoji/"+e.ID.String(), e.URL)
	var ev expressions.EmojiUpdate
	ws.ExpectDispatch("EMOJI_UPDATE", &ev)
	require.Len(t, ev.Emoji, 1)

	res, _ := env.Anon().Raw(http.MethodGet, e.URL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", res.Header.Get("Content-Type"))

	var list []expressions.Emoji
	bob.Do(http.MethodGet, "/api/server/emoji", nil, http.StatusOK, &list)
	require.Len(t, list, 1)
	_, ready := bob.Connect()
	require.Len(t, ready.Emoji, 1)

	// Names: valid, unique case-insensitively.
	upload(t, alice, "bad name", pngBytes(t, 8), http.StatusBadRequest)
	upload(t, alice, "PARTY_parrot", pngBytes(t, 8), http.StatusConflict)
	upload(t, bob, "mine", pngBytes(t, 8), http.StatusForbidden)
	upload(t, alice, "big", bytes.Repeat([]byte{0}, 300<<10), http.StatusRequestEntityTooLarge)
	upload(t, alice, "text", []byte("hello"), http.StatusBadRequest)

	alice.Do(http.MethodPatch, "/api/server/emoji/"+e.ID.String(), map[string]any{"name": "parrot"}, http.StatusOK, &e)
	require.Equal(t, "parrot", e.Name)

	// Reactions with the custom emoji, and their removal with it.
	general := alice.General()
	m := alice.Send(general, "nice")
	path := "/api/channels/" + general.String() + "/messages/" + m.ID.String() + "/reactions/" + url.PathEscape("custom:"+e.ID.String())
	bob.Do(http.MethodPut, path, nil, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, "/api/server/emoji/"+e.ID.String(), nil, http.StatusNoContent, nil)
	var page []struct {
		Reactions []any `json:"reactions"`
	}
	bob.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &page)
	require.Empty(t, page[0].Reactions)
	bob.Fail(http.MethodPut, path, nil, http.StatusBadRequest, "INVALID_EMOJI")
	env.Anon().Raw(http.MethodGet, e.URL, nil, "", http.StatusNotFound)
}

func TestEmojiLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	_, err := env.Pool.Exec(t.Context(), `
		INSERT INTO emoji (id, name, sha256, content_type, creator_id)
		SELECT g, 'e' || g, repeat('a', 64), 'image/png', $1 FROM generate_series(1, 200) g`, alice.User.ID)
	require.NoError(t, err)
	upload(t, alice, "one_more", pngBytes(t, 8), http.StatusBadRequest)
}
```

Use `context.Background()` instead of `t.Context()` if the Go version in `go.mod` lacks it (it was added in Go 1.24; the project uses 1.25). Also add a case to the files GC test: an emoji blob survives `Sweep` 48 h later.

- [ ] **Step 2: Run to verify they fail** — `go -C server test ./internal/expressions/`. Expected: build failure (the package does not exist).

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00013_emoji.sql`:

```sql
-- +goose Up
CREATE TABLE emoji (
    id           BIGINT PRIMARY KEY,
    name         TEXT NOT NULL CHECK (name ~ '^[A-Za-z0-9_]{2,32}$'),
    sha256       TEXT NOT NULL,
    content_type TEXT NOT NULL,
    creator_id   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX emoji_name_idx ON emoji (lower(name));
CREATE INDEX emoji_sha_idx ON emoji (sha256);

-- +goose Down
DROP TABLE emoji;
```

- [ ] **Step 4: Files blob API** — `server/internal/files/blobs.go`:

```go
package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
)

type blobTable struct{ table, column string }

// AddBlobTable registers a table whose column holds blob sums that must not
// be collected. table and column are code constants, never user input.
func (s *Service) AddBlobTable(table, column string) {
	s.blobTables = append(s.blobTables, blobTable{table, column})
}

// StoreImageBlob cleans an image and stores it, holding the blob lock in tx
// so the collector cannot remove it before tx commits.
func (s *Service) StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error) {
	ct, kind := Sniff(data[:min(len(data), 512)])
	if kind == "" {
		return "", "", httpx.BadRequest("NOT_AN_IMAGE", "upload a PNG, JPEG, WebP or GIF image")
	}
	clean, err := Clean(kind, data)
	if err != nil {
		return "", "", httpx.BadRequest("NOT_AN_IMAGE", "the image could not be read")
	}
	if _, _, err := Info(clean); err != nil {
		return "", "", httpx.BadRequest("NOT_AN_IMAGE", "the image could not be read")
	}
	staged, err := s.store.Stage(bytes.NewReader(clean), int64(len(clean)))
	if err != nil {
		return "", "", err
	}
	defer s.store.Discard(staged)
	if err := lockBlobs(ctx, tx, staged.Sum); err != nil {
		return "", "", err
	}
	if err := s.store.Commit(staged); err != nil {
		return "", "", err
	}
	return staged.Sum, ct, nil
}

// ServeBlob writes a stored image with the headers every public image uses.
func (s *Service) ServeBlob(w http.ResponseWriter, r *http.Request, sum, contentType string, immutable bool) {
	f, err := s.store.Open(sum)
	if errors.Is(err, os.ErrNotExist) {
		httpx.WriteHTTPError(w, r, httpx.NotFound("image"))
		return
	}
	if err != nil {
		httpx.WriteHTTPError(w, r, err)
		return
	}
	defer f.Close()
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if immutable {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "public, max-age=60")
	}
	h.Set("ETag", `"`+sum+`"`)
	http.ServeContent(w, r, "", time.Time{}, f.(io.ReadSeeker))
}
```

Then:
- Add the `blobTables []blobTable` field to `Service`.
- In `NewService`, register the built-in references: `s.AddBlobTable("server_images", "sha256")`. Attachments stay as they are because they also have `thumb_sha256`.
- `removeIfUnused` builds its query: `SELECT EXISTS (SELECT 1 FROM attachments WHERE sha256 = $1 OR thumb_sha256 = $1)` followed by ` OR EXISTS (SELECT 1 FROM <table> WHERE <column> = $1)` for each registered table.
- `ServerImageDownload` keeps its lookup and calls `s.ServeBlob(w, r, sum, ct, versioned)`, where `versioned` is the condition it uses today for `immutable`.

`store.Open` already returns an `io.ReadSeekCloser`, so drop the type assertion if it does not compile.

- [ ] **Step 5: Expressions** — `server/internal/expressions/expressions.go`:

```go
// Package expressions owns custom emoji (and, in M7, soundboard sounds).
package expressions

import (
	"context"
	"errors"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

const (
	MaxEmoji      = 200
	MaxEmojiBytes = 256 << 10
)

var nameRe = regexp.MustCompile(`^[A-Za-z0-9_]{2,32}$`)

type Emoji struct {
	ID        id.ID  `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url" doc:"Public image URL"`
	CreatorID *id.ID `json:"creator_id,omitempty"`
}

type EmojiUpdate struct {
	Emoji []Emoji `json:"emoji" doc:"Every custom emoji on the server"`
}

// Server is what this package needs from communities.
type Server interface {
	ServerID(ctx context.Context) (id.ID, error)
	BasePerms(ctx context.Context, userID id.ID) (perms.Perms, error)
}

// Blobs is what this package needs from files.
type Blobs interface {
	StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error)
	RemoveBlobs(ctx context.Context, sums []string) error
	ServeBlob(w http.ResponseWriter, r *http.Request, sum, contentType string, immutable bool)
}

// Reactions is what this package needs from messages.
type Reactions interface {
	RemoveReactions(ctx context.Context, emoji string) error
}

type Service struct {
	db        *pgxpool.Pool
	bus       *events.Bus
	server    Server
	blobs     Blobs
	reactions Reactions
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, server Server, blobs Blobs, reactions Reactions) *Service {
	return &Service{db: pool, bus: bus, server: server, blobs: blobs, reactions: reactions}
}

func (s *Service) List(ctx context.Context) ([]Emoji, error) {
	rows, err := s.db.Query(ctx, `SELECT id, name, creator_id FROM emoji ORDER BY lower(name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Emoji{}
	for rows.Next() {
		var e Emoji
		var creator *int64
		if err := rows.Scan(&e.ID, &e.Name, &creator); err != nil {
			return nil, err
		}
		e.CreatorID = id.FromNullable(creator)
		e.URL = "/api/emoji/" + e.ID.String()
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Service) EmojiExists(ctx context.Context, emojiID id.ID) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM emoji WHERE id = $1)`, emojiID).Scan(&ok)
	return ok, err
}

func (s *Service) get(ctx context.Context, emojiID id.ID) (*Emoji, string, string, error) {
	var e Emoji
	var sum, ct string
	var creator *int64
	err := s.db.QueryRow(ctx, `SELECT id, name, creator_id, sha256, content_type FROM emoji WHERE id = $1`, emojiID).
		Scan(&e.ID, &e.Name, &creator, &sum, &ct)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", "", errNotFound
	}
	e.CreatorID = id.FromNullable(creator)
	e.URL = "/api/emoji/" + e.ID.String()
	return &e, sum, ct, err
}

func (s *Service) publish(ctx context.Context) error {
	list, err := s.List(ctx)
	if err != nil {
		return err
	}
	sid, err := s.server.ServerID(ctx)
	if err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "EMOJI_UPDATE", Data: EmojiUpdate{Emoji: list}, Scope: events.Scope{CommunityID: sid}})
	return nil
}
```

(Add `net/http` to the imports and `var errNotFound = errors.New("emoji not found")`.)

`server/internal/expressions/handlers.go`:

```go
package expressions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type RenameRequest struct {
	Name string `json:"name" pattern:"^[A-Za-z0-9_]{2,32}$"`
}

type emojiPath struct {
	EmojiID string `path:"emojiID"`
}

func errInvalidName() *httpx.Error {
	return httpx.BadRequest("INVALID_NAME", "names use letters, digits and _ (2 to 32 characters)")
}

func errNameTaken() *httpx.Error {
	return httpx.E(http.StatusConflict, "NAME_TAKEN", "another emoji already has that name")
}

func isUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

func (s *Service) require(ctx context.Context, need perms.Perms) error {
	p, err := s.server.BasePerms(ctx, auth.Current(ctx).User.ID)
	if err != nil {
		return err
	}
	if p == 0 {
		return httpx.E(http.StatusForbidden, "NOT_A_MEMBER", "you are not a member of this server; ask for an invite")
	}
	if !p.Has(need) {
		return httpx.MissingPermission()
	}
	return nil
}

func Register(api huma.API, s *Service) {
	tags := []string{"expressions"}
	op := func(oid, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: oid, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}

	huma.Register(api, op("list-emoji", http.MethodGet, "/api/server/emoji", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Emoji }, error) {
			if err := s.require(ctx, 0); err != nil {
				return nil, err
			}
			list, err := s.List(ctx)
			return &struct{ Body []Emoji }{list}, err
		})

	huma.Register(api, op("rename-emoji", http.MethodPatch, "/api/server/emoji/{emojiID}", 0),
		func(ctx context.Context, in *struct {
			EmojiID string `path:"emojiID"`
			Body    RenameRequest
		}) (*struct{ Body *Emoji }, error) {
			if err := s.require(ctx, perms.ManageExpressions); err != nil {
				return nil, err
			}
			eid, err := httpx.ParseID(in.EmojiID, "emoji")
			if err != nil {
				return nil, err
			}
			tag, err := s.db.Exec(ctx, `UPDATE emoji SET name = $2 WHERE id = $1`, eid, in.Body.Name)
			if isUniqueViolation(err) {
				return nil, errNameTaken()
			}
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, httpx.NotFound("emoji")
			}
			e, _, _, err := s.get(ctx, eid)
			if err != nil {
				return nil, err
			}
			return &struct{ Body *Emoji }{e}, s.publish(ctx)
		})

	huma.Register(api, op("delete-emoji", http.MethodDelete, "/api/server/emoji/{emojiID}", http.StatusNoContent),
		func(ctx context.Context, in *emojiPath) (*struct{}, error) {
			if err := s.require(ctx, perms.ManageExpressions); err != nil {
				return nil, err
			}
			eid, err := httpx.ParseID(in.EmojiID, "emoji")
			if err != nil {
				return nil, err
			}
			var sum string
			if err := s.db.QueryRow(ctx, `DELETE FROM emoji WHERE id = $1 RETURNING sha256`, eid).Scan(&sum); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, httpx.NotFound("emoji")
				}
				return nil, err
			}
			if err := s.reactions.RemoveReactions(ctx, "custom:"+eid.String()); err != nil {
				return nil, err
			}
			if err := s.blobs.RemoveBlobs(ctx, []string{sum}); err != nil {
				slog.WarnContext(ctx, "expressions: removing an emoji blob; the sweep will retry", "err", err)
			}
			return nil, s.publish(ctx)
		})
}

// UploadHandler serves POST /api/server/emoji (multipart: name, file). It
// must run behind auth.RequireHTTP.
func (s *Service) UploadHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e, err := s.upload(w, r)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, e)
	})
}

func (s *Service) upload(w http.ResponseWriter, r *http.Request) (*Emoji, error) {
	ctx := r.Context()
	if err := s.require(ctx, perms.ManageExpressions); err != nil {
		return nil, err
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxEmojiBytes+64<<10)
	if err := r.ParseMultipartForm(MaxEmojiBytes + 64<<10); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "emoji can be at most 256 KB")
		}
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if !nameRe.MatchString(name) {
		return nil, errInvalidName()
	}
	f, hdr, err := r.FormFile("file")
	if err != nil {
		return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
	}
	defer f.Close()
	if hdr.Size > MaxEmojiBytes {
		return nil, httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "emoji can be at most 256 KB")
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxEmojiBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxEmojiBytes {
		return nil, httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "emoji can be at most 256 KB")
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('emoji', 0))`); err != nil { // one upload at a time: the count check
		return nil, err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM emoji`).Scan(&count); err != nil {
		return nil, err
	}
	if count >= MaxEmoji {
		return nil, httpx.BadRequest("EMOJI_LIMIT", fmt.Sprintf("this server already has %d emoji", MaxEmoji))
	}
	sum, ct, err := s.blobs.StoreImageBlob(ctx, tx, data)
	if err != nil {
		return nil, err
	}
	if ct == "image/jpeg" {
		return nil, httpx.BadRequest("NOT_AN_IMAGE", "emoji must be PNG, GIF or WebP")
	}
	eid := id.New()
	me := auth.Current(ctx).User.ID
	if _, err := tx.Exec(ctx, `INSERT INTO emoji (id, name, sha256, content_type, creator_id) VALUES ($1, $2, $3, $4, $5)`,
		eid, name, sum, ct, me); err != nil {
		if isUniqueViolation(err) {
			return nil, errNameTaken()
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if err := s.publish(ctx); err != nil {
		slog.WarnContext(ctx, "expressions: publishing EMOJI_UPDATE", "err", err)
	}
	e, _, _, err := s.get(ctx, eid)
	return e, err
}

// ImageHandler serves GET /api/emoji/{id} without a session.
func (s *Service) ImageHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		eid, err := httpx.ParseID(r.PathValue("id"), "emoji")
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		_, sum, ct, err := s.get(r.Context(), eid)
		if errors.Is(err, errNotFound) {
			httpx.WriteHTTPError(w, r, httpx.NotFound("emoji"))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		s.blobs.ServeBlob(w, r, sum, ct, true) // an ID's image never changes
	})
}
```

(`pgx` is needed in `handlers.go` for `pgx.ErrNoRows`. Fix imports as the compiler asks. When the JPEG check rejects an upload, the blob it just committed has no row; the hourly sweep collects it.)

- [ ] **Step 6: Wiring** — in `app.go`, inside the `pool != nil` files block (after `msgSvc` exists, so move the block if needed):

```go
		filesSvc.AddBlobTable("emoji", "sha256")
		exprSvc := expressions.NewService(pool, a.Bus, commSvc, filesSvc, msgSvc)
		msgSvc.SetCustomEmoji(exprSvc)
		expressions.Register(api, exprSvc)
		mux.Handle("POST /api/server/emoji", authSvc.RequireHTTP(exprSvc.UploadHandler()))
		mux.Handle("GET /api/emoji/{id}", exprSvc.ImageHandler())
```

If `datrope openapi` runs with `pool == nil`, `expressions.Register` must still run so the OpenAPI document includes the emoji routes. Construct `exprSvc` outside the `pool != nil` check, as the other services are, and wire only the raw handlers inside it.

READY:
- `Ready.Emoji []expressions.Emoji \`json:"emoji"\``. Fill it for members (gated too) via `exprSvc.List`; use `[]` otherwise.
- Give `readyBuilder` an `expressions *expressions.Service` field.
- `registerEventSchemas` adds `expressions.EmojiUpdate{}`.

- [ ] **Step 7: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...`. Expected: PASS. `gofmt -l server` empty.

- [ ] **Step 8: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(expressions): custom emoji`

---

### Task 4: Link previews (server)

**Files:**
- Create: `server/internal/db/migrations/00014_link_previews.sql`, `server/internal/linkpreview/fetch.go`, `server/internal/linkpreview/parse.go`, `server/internal/linkpreview/linkpreview.go`, `server/internal/linkpreview/fetch_test.go`, `server/internal/linkpreview/parse_test.go`, `server/internal/messages/previews.go`, `server/internal/messages/previews_test.go`
- Modify: `server/go.mod` (promote `golang.org/x/net` to a direct dependency), `server/internal/messages/messages.go` (`Message.Embed`, scan, `hydrate`, a WaitGroup), `handlers.go` (attach after send and edit), `server/internal/app/app.go` (wiring, `App.Messages`, closer)

**Interfaces:**
- **Produces (package `linkpreview`):**
  - `type Preview struct{ URL, Site, Title, Description string }` (JSON `url`, `site`, `title`, `description`; `site` is `og:site_name` or else the host).
  - `func Blocked(ip net.IP) bool`.
  - `func Parse(r io.Reader, pageURL *url.URL) (*Preview, bool)` returns false when the page has no title.
  - `type Service struct`; `New(pool *pgxpool.Pool) *Service`; `(*Service).Get(ctx, rawURL string) (*Preview, error)`. It returns `nil, nil` when there is no preview: a failed fetch, no title, or rate limited.
- **Produces (package `messages`):**
  - `Message.Embed *linkpreview.Preview` (JSON `embed,omitempty`).
  - `type Previews interface{ Get(ctx, rawURL string) (*linkpreview.Preview, error) }` with `(*Service).SetPreviews(Previews)` and `(*Service).Wait()`; `Wait` blocks until background preview work has finished, and runs on shutdown and in tests.
  - `firstLink(content string) string`.
- **Produces (package `app`):** `App.Messages *messages.Service`, so tests can inject a fake `Previews`.

- [ ] **Step 1: Write the failing tests** — `server/internal/linkpreview/fetch_test.go`:

```go
package linkpreview

import (
	"net"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBlocked(t *testing.T) {
	blocked := []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
		"0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "fe80::1", "fc00::1", "fd12::1", "::", "ff02::1",
		"::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "198.18.0.1", "192.0.0.1"}
	for _, s := range blocked {
		require.True(t, Blocked(net.ParseIP(s)), s)
	}
	for _, s := range []string{"1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"} {
		require.False(t, Blocked(net.ParseIP(s)), s)
	}
}
```

`server/internal/linkpreview/parse_test.go`:

```go
package linkpreview

import (
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParse(t *testing.T) {
	u, _ := url.Parse("https://docs.example.com/ports")
	cases := []struct {
		name, html string
		want       *Preview
	}{
		{"opengraph", `<html><head><meta property="og:site_name" content="Example Docs"><meta property="og:title" content="Ports &amp; firewall">
			<meta property="og:description" content="Which ports to open."><title>ignored</title></head><body>x</body></html>`,
			&Preview{URL: u.String(), Site: "Example Docs", Title: "Ports & firewall", Description: "Which ports to open."}},
		{"title fallback", `<head><title> Plain  title </title><meta name="description" content="Desc"></head>`,
			&Preview{URL: u.String(), Site: "docs.example.com", Title: "Plain title", Description: "Desc"}},
		{"no title", `<html><body><p>nothing</p></body></html>`, nil},
		{"long title cut", `<title>` + strings.Repeat("a", 500) + `</title>`,
			&Preview{URL: u.String(), Site: "docs.example.com", Title: strings.Repeat("a", 200)}},
	}
	for _, c := range cases {
		got, ok := Parse(strings.NewReader(c.html), u)
		if c.want == nil {
			require.False(t, ok, c.name)
			continue
		}
		require.True(t, ok, c.name)
		require.Equal(t, c.want, got, c.name)
	}
}

func TestFetchRefusesPrivateAddresses(t *testing.T) {
	_, err := fetch(t.Context(), "http://127.0.0.1:1/")
	require.ErrorIs(t, err, errBlockedAddress)
	_, err = fetch(t.Context(), "ftp://example.com/")
	require.Error(t, err)
}
```

(`fetch` is the package-internal fetcher; the test proves the dial check runs. Fetching from a local `httptest` server needs the check disabled: give `fetch` an unexported variant `fetchWith(ctx, url, allow func(net.IP) bool)` and test redirects, size limits and content-type with `allow` returning true.) Add `TestFetchLimits` using `httptest.NewServer` and `fetchWith(…, func(net.IP) bool { return true })`:
- a non-HTML response returns an error;
- a 2 MB HTML body parses only the first 1 MB, which is enough for a `<title>` near the top;
- a chain of 4 redirects fails;
- a handler that sleeps 6 s times out.

`server/internal/messages/previews_test.go`:

```go
package messages

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFirstLink(t *testing.T) {
	cases := map[string]string{
		"see https://example.com/a?b=1.":                 "https://example.com/a?b=1",
		"[docs](https://example.com/x) and http://b.com": "https://example.com/x",
		"`https://code.com` then https://real.com":       "https://real.com",
		"||https://spoiler.com|| https://shown.com":      "https://shown.com",
		"```\nhttps://block.com\n```":                    "",
		"no links here":                                  "",
		"(https://example.com/wiki/Foo_(bar))":            "https://example.com/wiki/Foo_(bar)",
		"javascript:alert(1) ftp://x.com":                "",
	}
	for in, want := range cases {
		require.Equal(t, want, firstLink(in), in)
	}
}
```

Add an integration test, `TestLinkPreviewAttached`, to `messages/reactions_test.go` or a new `messages/embed_test.go`:
- Inject a fake via `env.App.Messages.SetPreviews(fakePreviews{…})`; the fake returns a fixed `Preview` for `https://example.com`.
- Send `"look https://example.com"` and expect `MESSAGE_UPDATE` on the socket with `embed.title` set.
- Edit to `"never mind"` and expect a `MESSAGE_UPDATE` with no embed.
- Call `env.App.Messages.Wait()` before the test ends.

If `apptest.Env` has no `App` field, add one.

- [ ] **Step 2: Run to verify they fail** — `go -C server test ./internal/linkpreview/ ./internal/messages/ -run 'TestBlocked|TestParse|TestFetch|TestFirstLink|TestLinkPreview'`. Expected: build failures.

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00014_link_previews.sql`:

```sql
-- +goose Up
-- Cache of fetched link previews (failures too, with ok = false).
CREATE TABLE link_previews (
    url         TEXT PRIMARY KEY,
    ok          BOOLEAN NOT NULL,
    site        TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN embed JSONB;

-- +goose Down
ALTER TABLE messages DROP COLUMN embed;
DROP TABLE link_previews;
```

- [ ] **Step 4: Fetcher** — `server/internal/linkpreview/fetch.go`:

```go
// Package linkpreview fetches text previews of links (spec §5) without
// letting a message make the server reach private networks.
package linkpreview

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"syscall"
	"time"
)

const (
	maxBody      = 1 << 20
	fetchTimeout = 5 * time.Second
	maxRedirects = 3
)

var errBlockedAddress = errors.New("link preview: address not allowed")

var blockedNets = func() []*net.IPNet {
	var out []*net.IPNet
	for _, cidr := range []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
		"192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
		"224.0.0.0/4", "240.0.0.0/4",
		"::/128", "::1/128", "64:ff9b::/96", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8",
	} {
		_, n, err := net.ParseCIDR(cidr)
		if err != nil {
			panic(err)
		}
		out = append(out, n)
	}
	return out
}()

// Blocked reports whether ip is not a public unicast address.
func Blocked(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4 // also catches IPv4-mapped IPv6
	}
	for _, n := range blockedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func fetch(ctx context.Context, rawURL string) (*Preview, error) {
	return fetchWith(ctx, rawURL, func(ip net.IP) bool { return !Blocked(ip) })
}

// fetchWith fetches and parses a page; allow decides every address dialled
// (after DNS resolution, on every redirect).
func fetchWith(ctx context.Context, rawURL string, allow func(net.IP) bool) (*Preview, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("link preview: unsupported URL %q", rawURL)
	}
	dialer := &net.Dialer{
		Timeout: fetchTimeout,
		Control: func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if !allow(net.ParseIP(host)) {
				return errBlockedAddress
			}
			return nil
		},
	}
	client := &http.Client{
		Timeout: fetchTimeout,
		Transport: &http.Transport{
			Proxy:                 nil, // never through an environment proxy: it would dial for us
			DialContext:           dialer.DialContext,
			TLSHandshakeTimeout:   fetchTimeout,
			ResponseHeaderTimeout: fetchTimeout,
			MaxResponseHeaderBytes: 64 << 10,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return errors.New("link preview: too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errors.New("link preview: redirect to an unsupported scheme")
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Datrope link preview (+https://github.com/datrope/datrope)")
	req.Header.Set("Accept", "text/html")
	res, err := client.Do(req)
	if err != nil {
		if errors.Is(err, errBlockedAddress) {
			return nil, errBlockedAddress
		}
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("link preview: status %d", res.StatusCode)
	}
	if mt, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type")); mt != "text/html" {
		return nil, fmt.Errorf("link preview: not HTML (%s)", mt)
	}
	p, ok := Parse(io.LimitReader(res.Body, maxBody), res.Request.URL)
	if !ok {
		return nil, errors.New("link preview: no title")
	}
	p.URL = rawURL // the link as written, not where it redirected
	return p, nil
}
```

(`errors.Is` sees `errBlockedAddress` through the `*url.Error` and `*net.OpError` wrappers; if it does not, unwrap explicitly in the test, not by loosening the check.)

- [ ] **Step 5: Parser** — `server/internal/linkpreview/parse.go`:

```go
package linkpreview

import (
	"io"
	"net/url"
	"strings"

	"golang.org/x/net/html"
)

const (
	maxTitle = 200
	maxDesc  = 300
	maxSite  = 100
)

// Parse reads a page's <head> for OpenGraph tags and the title.
func Parse(r io.Reader, pageURL *url.URL) (*Preview, bool) {
	z := html.NewTokenizer(r)
	meta := map[string]string{}
	var title strings.Builder
	inTitle := false
	for {
		switch z.Next() {
		case html.ErrorToken:
			return finish(meta, title.String(), pageURL)
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			switch string(name) {
			case "title":
				inTitle = true
			case "body":
				return finish(meta, title.String(), pageURL)
			case "meta":
				var key, content string
				for hasAttr {
					var k, v []byte
					k, v, hasAttr = z.TagAttr()
					switch string(k) {
					case "property", "name":
						key = strings.ToLower(string(v))
					case "content":
						content = string(v)
					}
				}
				if key != "" && meta[key] == "" {
					meta[key] = content
				}
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			switch string(name) {
			case "title":
				inTitle = false
			case "head":
				return finish(meta, title.String(), pageURL)
			}
		case html.TextToken:
			if inTitle {
				title.Write(z.Text())
			}
		}
	}
}

func finish(meta map[string]string, title string, pageURL *url.URL) (*Preview, bool) {
	p := &Preview{URL: pageURL.String()}
	p.Title = clean(firstNonEmpty(meta["og:title"], meta["twitter:title"], title), maxTitle)
	if p.Title == "" {
		return nil, false
	}
	p.Description = clean(firstNonEmpty(meta["og:description"], meta["twitter:description"], meta["description"]), maxDesc)
	p.Site = clean(firstNonEmpty(meta["og:site_name"], pageURL.Hostname()), maxSite)
	return p, true
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// clean collapses whitespace and cuts to n runes.
func clean(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		s = string(r[:n])
	}
	return s
}
```

(The tokenizer decodes entities in attribute values and text, so `&amp;` becomes `&`.)

- [ ] **Step 6: Cache and rate limit** — `server/internal/linkpreview/linkpreview.go`:

```go
package linkpreview

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/ratelimit"
)

const cacheTTL = 24 * time.Hour

type Preview struct {
	URL         string `json:"url"`
	Site        string `json:"site"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

type Service struct {
	db    *pgxpool.Pool
	limit *ratelimit.Limiter
	fetch func(ctx context.Context, rawURL string) (*Preview, error)
}

func New(pool *pgxpool.Pool) *Service {
	return &Service{db: pool, limit: ratelimit.New(30, 30), fetch: fetch}
}

// Get returns the preview for rawURL from the cache or the web; nil when
// there is none (failed, no title, or rate limited).
func (s *Service) Get(ctx context.Context, rawURL string) (*Preview, error) {
	var p Preview
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT ok, site, title, description FROM link_previews WHERE url = $1 AND fetched_at > $2`,
		rawURL, time.Now().Add(-cacheTTL)).Scan(&ok, &p.Site, &p.Title, &p.Description)
	if err == nil {
		if !ok {
			return nil, nil
		}
		p.URL = rawURL
		return &p, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if !s.limit.Allow("server") { // 30 fetches a minute for the whole server
		return nil, nil
	}
	got, ferr := s.fetch(ctx, rawURL)
	if ferr != nil {
		slog.InfoContext(ctx, "link preview failed", "url", rawURL, "err", ferr)
		got = nil
	}
	row := Preview{}
	if got != nil {
		row = *got
	}
	if _, err := s.db.Exec(ctx, `
		INSERT INTO link_previews (url, ok, site, title, description, fetched_at) VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (url) DO UPDATE SET ok = EXCLUDED.ok, site = EXCLUDED.site, title = EXCLUDED.title,
		    description = EXCLUDED.description, fetched_at = EXCLUDED.fetched_at`,
		rawURL, got != nil, row.Site, row.Title, row.Description); err != nil {
		return nil, err
	}
	return got, nil
}
```

`Preview` is defined here; `fetch.go` and `parse.go` use it.

- [ ] **Step 7: Messages** — `server/internal/messages/previews.go`:

```go
package messages

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/linkpreview"
)

// Previews is what this package needs from linkpreview.
type Previews interface {
	Get(ctx context.Context, rawURL string) (*linkpreview.Preview, error)
}

func (s *Service) SetPreviews(p Previews) { s.previews = p }

// Wait blocks until background preview work has finished.
func (s *Service) Wait() { s.bg.Wait() }

var (
	spoilerRe = regexp.MustCompile(`(?s)\|\|.*?\|\|`)
	linkRe    = regexp.MustCompile(`https?://[^\s<>"'` + "`" + `]+`)
)

// firstLink returns the first http(s) link outside code and spoilers.
func firstLink(content string) string {
	text := spoilerRe.ReplaceAllString(inlineCode.ReplaceAllString(codeBlock.ReplaceAllString(content, " "), " "), " ")
	link := linkRe.FindString(text)
	for link != "" {
		last := link[len(link)-1]
		switch {
		case strings.ContainsRune(".,!?:;'\"", rune(last)):
			link = link[:len(link)-1]
		case last == ')' && strings.Count(link, "(") < strings.Count(link, ")"):
			link = link[:len(link)-1]
		case last == ']':
			link = link[:len(link)-1]
		default:
			return link
		}
	}
	return ""
}

// attachPreview looks up the first link of a message in the background and,
// if the message still says the same thing, stores and publishes the embed.
func (s *Service) attachPreview(m Message, hadEmbed bool) {
	if s.previews == nil {
		return
	}
	link := firstLink(m.Content)
	if link == "" && !hadEmbed {
		return
	}
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		var embed []byte
		if link != "" {
			p, err := s.previews.Get(ctx, link)
			if err != nil {
				slog.WarnContext(ctx, "link preview", "message", m.ID, "err", err)
				return
			}
			if p != nil {
				embed, _ = json.Marshal(p)
			}
		}
		if embed == nil && !hadEmbed {
			return
		}
		tag, err := s.db.Exec(ctx, `UPDATE messages SET embed = $2 WHERE id = $1 AND content = $3 AND NOT deleted`, m.ID, embed, m.Content)
		if err != nil || tag.RowsAffected() == 0 {
			return // edited or deleted meanwhile; that change attaches its own preview
		}
		s.publishUpdated(ctx, m.ChannelID, m.ID)
	}()
}

// publishUpdated re-reads a message and publishes MESSAGE_UPDATE.
func (s *Service) publishUpdated(ctx context.Context, channelID, messageID id.ID) {
	m, err := scanMessage(s.db.QueryRow(ctx, `SELECT `+messageCols+` FROM messages WHERE id = $1`, messageID))
	if err != nil {
		return
	}
	ms := []Message{*m}
	if err := s.hydrate(ctx, ms); err != nil {
		return
	}
	s.publish("MESSAGE_UPDATE", channelID, ms[0])
}
```

In `messages.go`:
- `Message` gains `Embed *linkpreview.Preview \`json:"embed,omitempty"\``.
- `messageCols` gains `embed`. `scanMessage` reads it into a `[]byte`; when the bytes are non-null, `json.Unmarshal` them into `Embed`.
- `Service` gains `previews Previews` and `bg sync.WaitGroup`.

In `handlers.go`:
- After a send commits and publishes, call `s.attachPreview(*m, false)`.
- After an edit, call `s.attachPreview(*updated, m.Embed != nil)`; the edit sets `embed = NULL` in its UPDATE when the first link changed, so stale embeds never show.
- Deleting a message sets `embed = NULL` too.

In `app.go`:
- `msgSvc.SetPreviews(linkpreview.New(pool))` when `pool != nil`.
- `a.Messages = msgSvc`.
- `a.closers = append(a.closers, msgSvc.Wait)`.
- Run `go -C server get golang.org/x/net@<the version already in go.sum>` so it is listed as a direct dependency, then `go mod tidy`. On this machine, run go commands with `$env:GOTOOLCHAIN='local'` in PowerShell.

- [ ] **Step 8: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...`. Expected: PASS. `gofmt -l server` empty.

- [ ] **Step 9: Regenerate the API client** — `pnpm -C clients/core run gen`, run from PowerShell with `$env:GOTOOLCHAIN='local'`. Only `clients/core/openapi.json` and `clients/core/src/schema.d.ts` change under `clients/`. Do not fix TypeScript errors elsewhere; Task 5 handles them.

- [ ] **Step 10: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(messages): text link previews with an SSRF-safe fetcher`

---
### Task 5: Core client — replies, reactions, emoji, embeds

**Files:**
- Modify: `clients/core/src/types.ts`, `store.ts`, `client.ts`, `perms.ts`, and their tests (`store.test.ts`, `client.test.ts`, `perms.test.ts`)

**Interfaces:**
- **Consumes:** the regenerated schema from Task 4 (`Message.reply_to`, `mentions`, `reactions`, `embed`; `Emoji`; `ReactionEvent`; `EmojiUpdate`; READY `emoji`).
- **Types:** `Emoji`, `Reaction`, `ReactionEvent`, `ReplyRef`, `Embed` (= `Schemas["Preview"]`, or whatever name the schema gives `linkpreview.Preview`); `EventMap` gains `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`, `EMOJI_UPDATE`.
- **Store:**
  - `State.emoji: Record<string, Emoji>` (by ID).
  - `applyEvent` handles `EMOJI_UPDATE` and both reaction events.
  - `addPending(s, channelId, nonce, content, attachments, replyTo?: ReplyRef)`.
  - Selectors: `emojiList(s): Emoji[]`, sorted by name. It returns a new array, so call it with `useShallow`.
  - `customEmojiId(emoji: string): string | null`, which parses `custom:<id>`.
- **Client:**
  - `send(channelId, content, attachments = [], replyTo?: ReplyRef)`; sends `reply_to_id`.
  - `react(channelId, messageId, emoji)` and `unreact(channelId, messageId, emoji)`; both `encodeURIComponent` the emoji.
  - `uploadEmoji(name, file): Promise<Emoji>`, `renameEmoji(id, name)`, `deleteEmoji(id)`.
- **Perms:** `DM_PERMS` gains `Perm.AddReactions`.

- [ ] **Step 1: Write the failing tests** — add to `clients/core/src/store.test.ts` (reuse its READY fixture; add `emoji: []` to it):

```ts
describe("reactions and emoji", () => {
  const msg = { id: "500", channel_id: "101", author: { id: "10", username: "alice", display_name: "Alice", custom_status: "" },
    content: "hi", attachments: [], created_at: "", deleted: false, mentions: [], reactions: [] };

  it("adds and removes reactions", () => {
    let s = applyReady(initialState, ready());
    s = { ...s, messages: { "101": { items: [msg as never], hasMore: false } } };
    s = applyEvent(s, "MESSAGE_REACTION_ADD", { channel_id: "101", message_id: "500", emoji: "👍", user_id: "20" });
    s = applyEvent(s, "MESSAGE_REACTION_ADD", { channel_id: "101", message_id: "500", emoji: "👍", user_id: "10" });
    s = applyEvent(s, "MESSAGE_REACTION_ADD", { channel_id: "101", message_id: "500", emoji: "👍", user_id: "10" }); // repeat
    expect(s.messages["101"].items[0].reactions).toEqual([{ emoji: "👍", count: 2, user_ids: ["20", "10"] }]);
    s = applyEvent(s, "MESSAGE_REACTION_REMOVE", { channel_id: "101", message_id: "500", emoji: "👍", user_id: "20" });
    s = applyEvent(s, "MESSAGE_REACTION_REMOVE", { channel_id: "101", message_id: "500", emoji: "👍", user_id: "10" });
    expect(s.messages["101"].items[0].reactions).toEqual([]);
  });

  it("keeps the emoji list from READY and EMOJI_UPDATE", () => {
    let s = applyReady(initialState, ready({ emoji: [{ id: "7", name: "parrot", url: "/api/emoji/7" }] }));
    expect(emojiList(s).map((e) => e.name)).toEqual(["parrot"]);
    s = applyEvent(s, "EMOJI_UPDATE", { emoji: [{ id: "8", name: "zebra", url: "/api/emoji/8" }, { id: "9", name: "apple", url: "/api/emoji/9" }] });
    expect(emojiList(s).map((e) => e.name)).toEqual(["apple", "zebra"]);
    expect(customEmojiId("custom:8")).toBe("8");
    expect(customEmojiId("👍")).toBeNull();
  });

  it("shows a pending reply with its reference", () => {
    let s = applyReady(initialState, ready());
    s = addPending(s, "101", "n1", "agreed", [], { id: "500", author: msg.author, content: "hi", deleted: false });
    expect(s.messages["101"].items[0].reply_to?.id).toBe("500");
  });
});
```

In `client.test.ts`, add two cases:
- `react("101", "500", "👍")` PUTs `/api/channels/101/messages/500/reactions/%F0%9F%91%8D`.
- `send("101", "x", [], ref)` posts `reply_to_id: "500"`.

In `perms.test.ts`, assert `hasPerm(DM_PERMS, Perm.AddReactions)`.

- [ ] **Step 2: Run to verify they fail** — `pnpm -C clients/core exec vitest run`. Expected: FAIL.

- [ ] **Step 3: Implement.**

`store.ts`:
- `State.emoji` is `{}` in `initialState`. `applyReady` sets `emoji: byKey(r.emoji ?? [], (e) => e.id)`.
- New event cases:

```ts
    case "EMOJI_UPDATE":
      return { ...s, emoji: byKey((data as { emoji: Emoji[] | null }).emoji ?? [], (e) => e.id) };
    case "MESSAGE_REACTION_ADD":
    case "MESSAGE_REACTION_REMOVE": {
      const d = data as ReactionEvent;
      const add = type === "MESSAGE_REACTION_ADD";
      return updateMessages(s, d.channel_id, (items) => items.map((m) => {
        if (m.id !== d.message_id) return m;
        const reactions = [...(m.reactions ?? [])];
        const i = reactions.findIndex((r) => r.emoji === d.emoji);
        const users = i >= 0 ? reactions[i].user_ids ?? [] : [];
        if (add === users.includes(d.user_id)) return m; // nothing changes
        const next = add ? [...users, d.user_id] : users.filter((u) => u !== d.user_id);
        if (next.length === 0) reactions.splice(i, 1);
        else if (i >= 0) reactions[i] = { emoji: d.emoji, count: next.length, user_ids: next };
        else reactions.push({ emoji: d.emoji, count: 1, user_ids: next });
        return { ...m, reactions };
      }));
    }
```

- `addPending` gains a `replyTo?: ReplyRef` parameter. It sets `reply_to: replyTo`, `mentions: []`, `reactions: []` on the pending message, and `custom_status` on its author from `s.me`.

Selectors:

```ts
/** Custom emoji by name order. Returns a new array: select it with useShallow. */
export function emojiList(s: State): Emoji[] {
  return Object.values(s.emoji).sort((a, b) => a.name.localeCompare(b.name));
}

/** The custom emoji ID in a reaction's "custom:<id>", or null for a Unicode emoji. */
export function customEmojiId(emoji: string): string | null {
  return emoji.startsWith("custom:") ? emoji.slice(7) : null;
}
```

`client.ts`:

```ts
  async send(channelId: string, content: string, attachments: Attachment[] = [], replyTo?: ReplyRef) {
    const nonce = crypto.randomUUID();
    this.set((s) => addPending(s, channelId, nonce, content, attachments, replyTo));
    try {
      const m = await unwrap(this.api.POST("/api/channels/{id}/messages", {
        params: { path: { id: channelId } },
        body: {
          content, nonce,
          ...(attachments.length > 0 ? { attachment_ids: attachments.map((a) => a.id) } : {}),
          ...(replyTo ? { reply_to_id: replyTo.id } : {}),
        },
      }));
      this.set((s) => applyEvent(s, "MESSAGE_CREATE", m));
    } catch (e) {
      this.set((s) => markFailed(s, channelId, nonce));
      throw e;
    }
  }

  async react(channelId: string, messageId: string, emoji: string) {
    await unwrap(this.api.PUT("/api/channels/{id}/messages/{messageID}/reactions/{emoji}", {
      params: { path: { id: channelId, messageID: messageId, emoji } },
    }));
  }

  async unreact(channelId: string, messageId: string, emoji: string) {
    await unwrap(this.api.DELETE("/api/channels/{id}/messages/{messageID}/reactions/{emoji}", {
      params: { path: { id: channelId, messageID: messageId, emoji } },
    }));
  }

  /** Adds a custom emoji (MANAGE_EXPRESSIONS). */
  async uploadEmoji(name: string, file: Blob): Promise<Emoji> {
    const form = new FormData();
    form.append("name", name);
    form.append("file", file, `${name}.img`);
    return this.multipartForm("POST", "/api/server/emoji", form);
  }

  async renameEmoji(id: string, name: string): Promise<Emoji> {
    return unwrap(this.api.PATCH("/api/server/emoji/{emojiID}", { params: { path: { emojiID: id } }, body: { name } }));
  }

  async deleteEmoji(id: string) {
    await unwrap(this.api.DELETE("/api/server/emoji/{emojiID}", { params: { path: { emojiID: id } } }));
  }
```

`openapi-fetch` path-serialises parameters with `encodeURIComponent`; the client test checks the URL. If the test shows a raw emoji in the URL, encode it explicitly. Refactor the existing private `multipart(method, path, file, filename)` helper into `multipartForm(method, path, form: FormData)`, keeping `multipart` as a thin wrapper so the image and attachment uploads stay unchanged.

`perms.ts`: add `| Perm.AddReactions` to `DM_PERMS`.

`types.ts`: add the types and `EventMap` entries listed above.

- [ ] **Step 4: Run** — `pnpm -C clients/core exec vitest run` and `pnpm -C clients/core exec tsc --noEmit`. Expected: PASS. Also `pnpm -C clients/web run typecheck`; fix type errors there only where the core API changed shape, such as `addPending` callers.

- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(core): replies, reactions, custom emoji and embeds`

---

### Task 6: Web — Markdown rendering for messages

**Files:**
- Create: `clients/web/src/chat/remarkChat.ts`, `clients/web/src/chat/Markdown.tsx`, `clients/web/src/chat/emoji-data.ts`, `clients/web/src/chat/Markdown.test.tsx`
- Modify: `clients/web/package.json` (`emojibase-data` `16.0.3`; the controller installs it before dispatch), `clients/web/src/app/MessageList.tsx` (render `content` through `<Markdown>`), `clients/web/src/styles.css` (the `.chat-md` rules for the elements below, using tokens)

**Interfaces:**
- **Consumes:** the core `State.emoji`, `server.members`, `me`.
- **Produces:**
  - `<Markdown text: string, mentions?: string[] />`, where `mentions` are the message's mentioned user IDs. Spoilers are revealed by click or Enter and become `aria-expanded`. Mentions render as `<span class="mention" data-me>`, where `data-me` is set when the mention is the viewer.
  - `remarkChat(options: ChatOptions)`, a unified plugin.
  - `type ChatOptions = { custom: Map<string, { id: string; url: string }>; shortcodes: Map<string, string> | null; users: Map<string, { id: string; name: string }>; meId?: string }`. Keys are lower-cased.
  - `loadEmojiData(): Promise<EmojiData>`, `useEmojiData(): EmojiData | null`.
  - `type EmojiData = { list: UnicodeEmoji[]; byShortcode: Map<string, string> }`.
  - `type UnicodeEmoji = { emoji: string; label: string; group: number; shortcodes: string[] }`.

**Rendering rules (Global Constraints):**
- Elements produced: `p` (with `white-space: pre-wrap`, so single newlines show), `br`, `strong`, `em`, `del`, `code`, `pre`, `blockquote`, `ul`, `ol`, `li`, `a`, `span` (spoiler, mention), `img` (custom emoji only).
- Every other element is unwrapped to its text (`allowedElements` + `unwrapDisallowed`). Markdown images render their alt text.
- `skipHtml`, so raw HTML disappears. `react-markdown`'s default `urlTransform` stays on, so `javascript:` links lose their `href`.
- Links: `target="_blank"` and `rel="noopener noreferrer"`.
- `remark-gfm` gives bare-URL autolinks and `~~strike~~`.
- `remarkChat` rewrites text nodes, but not inside `code`, `inlineCode` or `link`:
  - `||x||` becomes a spoiler span. Text only; formatting inside spoilers is not parsed.
  - `:name:` becomes a custom emoji `img` when `custom` has the name. Otherwise it becomes the Unicode emoji when `shortcodes` has it. Otherwise it is left as text.
  - `@name` becomes a mention span when `users` has the name, using the same boundary rule as the server: preceded by start or a character that is not a letter, digit, `_`, `.`, `-` or `@`, with trailing `.`/`-` excluded.

- [ ] **Step 1: Write the failing test** — `clients/web/src/chat/Markdown.test.tsx` (vitest, render to a static string):

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./Markdown";

const opts = {
  custom: new Map([["parrot", { id: "7", url: "/api/emoji/7" }]]),
  shortcodes: new Map([["smile", "😄"]]),
  users: new Map([["bob", { id: "20", name: "Bob" }], ["me", { id: "10", name: "Me" }]]),
  meId: "10",
};
const html = (text: string) => renderToStaticMarkup(<MarkdownView text={text} options={opts} />);

describe("message Markdown", () => {
  it.each([
    ["**bold** *it* ~~gone~~", "<strong>bold</strong>", "<em>it</em>", "<del>gone</del>"],
    ["`x<y`", "<code>x&lt;y</code>"],
    ["```\nconst a = 1;\n```", "<pre><code>const a = 1;\n</code></pre>"],
    ["> quoted", "<blockquote>"],
    ["- a\n- b", "<ul>", "<li>a</li>"],
    ["[site](https://example.com)", 'href="https://example.com"', 'target="_blank"', 'rel="noopener noreferrer"'],
    ["see https://example.com/x", 'href="https://example.com/x"'],
    ["||secret||", 'class="spoiler"', "secret"],
    ["hi :parrot:", '<img', 'src="/api/emoji/7"', 'alt=":parrot:"'],
    ["hi :smile:", "😄"],
    ["hi :nope:", ":nope:"],
    ["hey @bob and @nobody", 'class="mention"', "@bob", "@nobody"],
    ["ping @me", "data-me"],
    ["# Heading", "Heading"],
    ["line one\nline two", "line one\nline two"],
  ])("%s", (text, ...want) => {
    const out = html(text);
    for (const w of want) expect(out).toContain(w);
  });

  it.each([
    ["<b>raw</b> html", "<b>"],
    ["[x](javascript:alert(1))", "javascript:"],
    ["![alt](https://evil.example/i.png)", "<img"],
    ["# Heading", "<h1"],
    ["`@bob`", 'class="mention"'],
    ["`:parrot:`", "<img"],
  ])("%s is not rendered as markup", (text, absent) => {
    expect(html(text)).not.toContain(absent);
  });
});
```

`MarkdownView` is the pure component taking `options`. `Markdown` wraps it, building `options` from the store and `useEmojiData()`.

- [ ] **Step 2: Run to verify it fails** — `pnpm -C clients/web exec vitest run src/chat`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

`clients/web/src/chat/remarkChat.ts`: walk the mdast with a small recursive function (no new dependency; `unist-util-visit` comes transitively with react-markdown, but do not import transitive packages). Skip `code`, `inlineCode` and `link` nodes. For each `text` node, split its value with one regex:

```ts
const TOKEN = /(\|\|[\s\S]+?\|\||:[A-Za-z0-9_+-]{2,32}:|(?<![A-Za-z0-9_.@-])@[A-Za-z0-9_.-]{2,32})/g;
```

Replace the node with a list of new nodes:
- `{type: "text"}` for plain parts.
- `{type: "chatSpoiler", data: {hName: "span", hProperties: {className: ["spoiler"]}}, children: [{type: "text", value: inner}]}`.
- `{type: "chatEmoji", data: {hName: "img", hProperties: {src, alt: ":name:", className: ["emoji"], "data-emoji": "custom", draggable: false}}}`.
- A text node with the Unicode character, for a shortcode match.
- `{type: "chatMention", data: {hName: "span", hProperties: {className: ["mention"], "data-user-id": id, ...(id === meId ? {"data-me": ""} : {})}}, children: [{type: "text", value: "@" + name}]}`.

Unknown `:x:` and `@x` stay text. Strip trailing `.`/`-` from a mention and push them back as text.

`clients/web/src/chat/Markdown.tsx`:

```tsx
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo, useState } from "react";
import { client, useApp } from "@/session";
import { remarkChat, type ChatOptions } from "./remarkChat";
import { useEmojiData } from "./emoji-data";

const ALLOWED = ["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "a", "span", "img"];

function Spoiler({ children }: { children?: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="spoiler" data-shown={shown || undefined} role="button" tabIndex={0} aria-expanded={shown}
      aria-label={shown ? undefined : "Spoiler, select to show"}
      onClick={() => setShown(true)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setShown(true); }}>
      {children}
    </span>
  );
}

const components: Components = {
  a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" />,
  img: ({ node: _n, ...p }) =>
    (p as Record<string, unknown>)["data-emoji"] ? <img {...p} className="emoji" loading="lazy" /> : <>{p.alt}</>,
  span: ({ node: _n, className, children, ...p }) =>
    className === "spoiler" ? <Spoiler>{children}</Spoiler> : <span className={className} {...p}>{children}</span>,
};

export function MarkdownView({ text, options }: { text: string; options: ChatOptions }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, [remarkChat, options]]} allowedElements={ALLOWED} unwrapDisallowed skipHtml
        components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const emoji = useApp((s) => s.emoji);
  const members = useApp((s) => s.server?.members);
  const meId = useApp((s) => s.me?.id);
  const data = useEmojiData();
  const options = useMemo<ChatOptions>(() => ({
    custom: new Map(Object.values(emoji).map((e) => [e.name.toLowerCase(), { id: e.id, url: client.url(e.url) }])),
    shortcodes: data?.byShortcode ?? null,
    users: new Map(Object.values(members ?? {}).map((m) => [m.user.username.toLowerCase(), { id: m.user.id, name: m.user.display_name }])),
    meId,
  }), [emoji, members, meId, data]);
  return <MarkdownView text={text} options={options} />;
}
```

The `img` override must distinguish our emoji from Markdown images, which `allowedElements` lets through as `img`. Check how react-markdown passes `data-*` properties and adjust the prop name. The test proves that `![alt](…)` renders only its alt text.

`clients/web/src/chat/emoji-data.ts`: a module-level cache with a promise and listeners. `loadEmojiData()` dynamically imports `emojibase-data/en/compact.json` and `emojibase-data/en/shortcodes/github.json`. Vite turns these into separate lazy chunks; check with `vite build` that they are not in the main chunk. It builds `list` and `byShortcode`, where `github.json` maps hexcode to shortcode or shortcodes, joined to `compact` by `hexcode`. `useEmojiData()` uses `useSyncExternalStore` and calls `loadEmojiData()` once on first use. Skip the regional-indicator and component groups (`group === 2`, "component") in `list`.

`MessageList.tsx`: replace the `<p>{m.content}</p>` body with `<Markdown text={m.content} />`, keeping `(edited)` after it as an inline muted span inside the last paragraph's line. Render it as a sibling with `inline` styling; exact placement is a styling detail. Keep the pending opacity.

`styles.css`: add `.chat-md` rules: paragraph margins 0 and `white-space: pre-wrap`; `code` uses `bg-muted`, rounded, a monospace font and a small padding; `pre` uses `--sidebar` as its background, with a border, overflow-x auto and the mockup's padding; `blockquote` gets a left border and muted text; lists get padding. Then:
- `.spoiler` uses the `--muted` background with transparent text until `[data-shown]`; it gets a pointer cursor.
- `.mention` uses the primary colour mixed at 22%, bold. `.mention[data-me]` is the same colour mixed at 35%.
- `img.emoji` is 1.375em with `vertical-align: -0.3em`.

Use tokens through `var(--…)` and `color-mix`, as the mockup does; no new hex values.

- [ ] **Step 4: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS, and the build output lists separate chunks for the emojibase JSON.

- [ ] **Step 5: Checkpoint** — stop; the controller reviews, checks a few messages in the browser and stages. Suggested message: `feat(web): Markdown in messages with spoilers, emoji and mentions`

---

### Task 7: Web — message rows: toolbar, replies, edit/delete, link previews, mention highlight

**Files:**
- Create: `clients/web/src/app/MessageToolbar.tsx`, `clients/web/src/app/ReplyQuote.tsx`, `clients/web/src/app/LinkPreview.tsx`
- Modify: `clients/web/src/app/MessageList.tsx` (row layout), `clients/web/src/app/Composer.tsx` (reply bar), `clients/web/src/app/ChannelView.tsx` and `DMView.tsx` (shared "replying to" state between list and composer)

**Interfaces:**
- **Consumes:** Task 5 (`client.send(…, replyTo)`, `ReplyRef`, `Message.reply_to`, `embed`, `mentions`) and Task 6 (`<Markdown>`).
- **Produces:**
  - `type ReplyState = { replyTo: ReplyRef | null; setReplyTo(r: ReplyRef | null): void }`, passed from the view to `MessageList` and `Composer`.
  - `jumpTo(channelId, messageId): Promise<boolean>`, which scrolls to `#message-<id>` and flashes it. It loads older pages (at most 5) when needed and returns false if the message was not found; the caller then shows "That message is too far back."
  - `<MessageToolbar>`, `<ReplyQuote>`, `<LinkPreview>`.

Build it from the mockup's message area (`Main.dc.html`, the `role="log"` block):
- **Row:** a 40 px avatar circle with initials (`bg-muted`) on the first message of a group, aligned under it for grouped messages. The header has the display name (in the author's highest role colour, the same helper as the member list) and the time; `(edited)` is muted next to the time, as in the mockup. Then the body (`<Markdown>`), attachments, embed and reactions (the reactions row arrives in Task 8; leave a slot).
- **Day dividers:** "Today", "Yesterday", or a short date between messages from different days, as in the mockup.
- **Reply quote line:** above the header, as in the mockup. A reply icon, the original author's name (bold, foreground), then the first line of the original, one line with ellipsis, muted. "Original message deleted" when `reply_to.deleted`. Clicking it calls `jumpTo`. A reply always starts a new group, so it shows the header.
- **Mention highlight:** when `message.mentions` includes me, give the row the background `color-mix(in srgb, var(--primary) 9%, transparent)` and a 2 px left border in primary, as in the mockup.
- **Hover toolbar** (`MessageToolbar`): a small floating group of icon buttons at the top right of the row, shown on hover and focus-within, each with a tooltip:
  - "Add reaction" (opens the picker in Task 8; leave the button wired to a prop);
  - "Reply";
  - "Edit" (mine only);
  - "Delete" (as `canDelete` today).

  Buttons are shadcn `Button` `variant="ghost" size="icon-sm"` on a `bg-popover` `border` container. The accessible names are exactly "Add reaction", "Reply", "Edit message" and "Delete message".
- **Editing:** inline, as today. Enter saves, Shift+Enter makes a newline and Esc cancels, with a hint line under the textarea ("Escape to cancel · Enter to save").
- **Deleting:** a shadcn `Dialog` replaces `window.confirm`. Title "Delete message?", a preview of the message, Cancel and a destructive "Delete".
- **Reply flow:** "Reply" sets `replyTo` and focuses the composer. The composer shows the bar from the mockup above the input inside the card: a `bg-muted` strip with "Replying to **Name**" and a "Cancel reply" icon button. Esc in the composer clears it. Sending passes `replyTo` to `client.send` and clears it.
- **Link preview card** (`LinkPreview`): when `embed` is set, show the mockup's card under the body. A 4 px accent bar in `bg-muted`; the site in small muted text; the title as a link (`target="_blank" rel="noopener noreferrer"`) to `embed.url`; the description in muted text, clamped to 3 lines. No image.
- **IDs:** every row gets `id={"message-" + m.id}` for `jumpTo`. A flash is a short `bg-accent` highlight fade, done with a CSS class removed after 1.5 s.

- [ ] **Step 1: Build** the pieces above, keeping all existing behaviours: grouping, pending and failed states, attachments, load older, scroll to bottom on new messages.

- [ ] **Step 2: Type-check, test and build** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS.

- [ ] **Step 3: Checkpoint** — stop. The controller reviews and checks in the browser: reply, jump to the original, edit, delete with the dialog, a link preview arriving, a mention of the viewer. Then it stages. Suggested message: `feat(web): message toolbar, replies, link previews and mention highlight`

---

### Task 8: Web — emoji picker, reactions, autocomplete

**Files:**
- Create: `clients/web/src/components/ui/popover.tsx` (shadcn new-york-v4 popover on `radix-ui`; hand-written per the AGENTS.md §6 fallback if the CLI cannot run), `clients/web/src/chat/EmojiPicker.tsx`, `clients/web/src/chat/Reactions.tsx`, `clients/web/src/chat/Autocomplete.tsx`, `clients/web/src/chat/autocomplete.ts`, `clients/web/src/chat/autocomplete.test.ts`
- Modify: `clients/web/src/app/MessageList.tsx` (reactions row, toolbar "Add reaction"), `clients/web/src/app/Composer.tsx` (emoji button, autocomplete)

**Interfaces:**
- **Consumes:** Task 5 (`client.react`, `unreact`, `emojiList`, `customEmojiId`, `State.emoji`), Task 6 (`useEmojiData`), Task 7 (toolbar `onAddReaction` prop).
- **Produces:**
  - `<EmojiPicker onPick(value: { unicode: string } | { custom: Emoji }), trigger: ReactNode />`. `value` turns into a reaction string (`unicode` or `custom:<id>`) or composer text (`unicode` or `:name:`).
  - `<Reactions message />`.
  - `findTrigger(text: string, caret: number): { kind: "emoji" | "mention"; query: string; start: number } | null`.
  - `rank(query: string, items: { key: string }[]): items`. Prefix matches come first, then substring matches; within each group, shorter keys first; at most 8 results.

- [ ] **Step 1: Write the failing test** — `clients/web/src/chat/autocomplete.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findTrigger, rank } from "./autocomplete";

describe("composer autocomplete", () => {
  it.each([
    ["hi @bo", 6, { kind: "mention", query: "bo", start: 3 }],
    ["@a", 2, null], // one character after @ is not enough
    ["mail a@b", 8, null],
    ["nice :par", 9, { kind: "emoji", query: "par", start: 5 }],
    ["time 10:30", 10, null],
    ["done :parrot: ", 14, null],
    ["`@bob", 5, null],
  ])("%s", (text, caret, want) => {
    expect(findTrigger(text as string, caret as number)).toEqual(want);
  });

  it("ranks prefix matches first, then shorter keys", () => {
    const items = ["sparrow", "parrot", "party_parrot", "pa"].map((key) => ({ key }));
    expect(rank("par", items).map((i) => i.key)).toEqual(["parrot", "party_parrot", "sparrow"]);
  });
});
```

Rules for `findTrigger`:
- **Mention:** `@` at the start or after whitespace or `(`, followed by 2 or more of `[A-Za-z0-9_.-]` up to the caret.
- **Emoji:** `:` at the start or after whitespace, followed by 2 or more of `[A-Za-z0-9_+-]` up to the caret, with no closing `:`.
- No trigger inside an unclosed inline code span (an odd number of backticks before the caret on that line).

- [ ] **Step 2: Run to verify it fails** — `pnpm -C clients/web exec vitest run src/chat/autocomplete.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
- **`autocomplete.ts`:** the two pure functions above.
- **`EmojiPicker.tsx`:** a shadcn `Popover` with a 352 px wide panel containing:
  - a search `Input` ("Search emoji", autofocus);
  - a scroll area with sections: "Server" (custom emoji from `emojiList`, as images), then the Unicode groups from `useEmojiData()` with their names (Smileys & emotion, People & body, Animals & nature, Food & drink, Travel & places, Activities, Objects, Symbols, Flags);
  - a row of group shortcut buttons at the top.

  Search filters by label, shortcodes and custom names. Each emoji is a `button` with `aria-label` set to its label or `:name:`. Arrow keys move through the grid, Enter picks, and Esc closes. While the data is loading, show "Loading emoji…". There are no skin-tone options in M5.
- **`Reactions.tsx`:** the row under a message, from the mockup's `.react` / `.react-mine` styles.
  - One pill per reaction: the emoji (or custom `img`) and the count.
  - `aria-pressed` when I reacted. The `aria-label` reads e.g. "👍, 3 people including you" or ":parrot:, 4 people".
  - A tooltip lists up to 10 names.
  - Click toggles `client.react` / `client.unreact`.
  - The last pill is "Add a reaction" with an `EmojiPicker` trigger.
  - Reactions whose custom emoji no longer exists are hidden.
  - Pills use tokens: `border bg-card rounded-full h-[26px] px-2 text-[13px]`; "mine" uses `border-primary` and a primary 14% `color-mix` background.
- **Toolbar "Add reaction":** opens an `EmojiPicker` anchored to the toolbar and calls `client.react`.
- **Errors:** a reaction failure (rate limit, missing permission) shows briefly as an `ErrorText` under the row.
- **`Autocomplete.tsx` + `Composer.tsx`:**
  - The composer gets the emoji button from the mockup (`aria-label="Emoji"`) before Send. It opens `EmojiPicker` and inserts `unicode` or `:name:` at the caret.
  - When `findTrigger` matches, a `role="listbox"` panel opens above the composer card.
    - Mentions: members by username and display name.
    - Emoji: custom first, then Unicode shortcodes; at most 8 results.
  - Up/Down moves; Enter or Tab inserts (`@username ` or `:name: ` / the Unicode character) and closes; Esc closes.
  - While the list is open, Enter does not send.
  - Use `aria-activedescendant` on the textarea.

- [ ] **Step 4: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS.

- [ ] **Step 5: Checkpoint** — stop. The controller reviews and checks in the browser: react with a Unicode emoji and a custom emoji, toggle off, use the picker from the composer, `@` and `:` autocomplete. Then it stages. Suggested message: `feat(web): emoji picker, reactions and composer autocomplete`

---

### Task 9: Web — Emoji settings

**Files:**
- Create: `clients/web/src/app/server-settings/Emoji.tsx`, `clients/web/src/app/server-settings/emojiNames.ts`, `clients/web/src/app/server-settings/emojiNames.test.ts`
- Modify: `clients/web/src/app/server-settings/ServerSettings.tsx` (the "Emoji" nav item becomes a real section, visible with `MANAGE_EXPRESSIONS`)

**Interfaces:**
- **Consumes:** Task 5 (`client.uploadEmoji`, `renameEmoji`, `deleteEmoji`, `emojiList`).
- **Produces:**
  - `nameFromFile(filename: string): string`. It lower-cases, replaces runs of other characters with `_`, trims `_`, cuts to 32, and pads names shorter than 2 with `_`. Examples: `"Party Parrot.png"` → `"party_parrot"`, `"IMG_2041.GIF"` → `"img_2041"`, `"a.png"` → `"a_"`.
  - `validateNames(tiles: { name: string }[], existing: string[]): (string | null)[]`. It returns one error per tile or null:
    - "Use letters, digits and _ (2–32)" for a bad name;
    - "Already used" when the name clashes with an existing emoji;
    - "Duplicate name" when two tiles share a name.

    All comparisons are case-insensitive.

- [ ] **Step 1: Write the failing test** — `clients/web/src/app/server-settings/emojiNames.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nameFromFile, validateNames } from "./emojiNames";

describe("emoji names", () => {
  it.each([
    ["Party Parrot.png", "party_parrot"],
    ["IMG_2041.GIF", "img_2041"],
    ["a.png", "a_"],
    ["---.webp", "emoji"],
    ["very-long-name-that-keeps-going-forever.png", "very_long_name_that_keeps_going_"],
  ])("%s", (file, want) => expect(nameFromFile(file)).toBe(want));

  it("flags bad, taken and duplicate names", () => {
    expect(validateNames([{ name: "ok_1" }, { name: "Taken" }, { name: "dup" }, { name: "DUP" }, { name: "x y" }], ["taken"]))
      .toEqual([null, "Already used", "Duplicate name", "Duplicate name", "Use letters, digits and _ (2–32)"]);
  });
});
```

(`"---.webp"` produces an empty name, which falls back to `"emoji"`.)

- [ ] **Step 2: Run to verify it fails** — `pnpm -C clients/web exec vitest run src/app/server-settings`. Expected: FAIL.

- [ ] **Step 3: Implement** the helpers, then the page from `SettingsEmoji.dc.html`.
- **Header:** "Emoji", with the description "Custom emoji everyone on the server can use in messages and reactions."
- **Upload button:** labelled "Upload emoji", backed by a hidden `input type=file multiple accept="image/png,image/gif,image/webp"` with `aria-label="Choose emoji images"`.
- **Count line:** "N of 200 used".
- **New emoji section** (`aria-label="New emoji"`):
  - A grid of tiles. Each tile shows a preview image (from `URL.createObjectURL`, revoked on removal), a `:` `Input` `:` name field (`aria-label="Name for emoji N"`), an error line, and a "Remove <name>" icon button.
  - Files over 256 KB or of other types get a tile error straight away and are skipped on upload.
  - A header line shows the count, e.g. "5 new emoji", with the hint from the mockup.
  - Buttons: "Add all" (disabled while any tile has an error) and "Clear".
  - "Add all" uploads tiles one at a time. Successful tiles disappear. A failed tile stays with the server's message, for example "another emoji already has that name". Uploading stops if the server limit is reached.
- **Server emoji section** (`aria-label="Server emoji"`):
  - A search `Input` ("Search emoji").
  - A shadcn `Table` with columns: image, `:name:`, an inline rename `Input` saved on blur or Enter via `renameEmoji` (errors inline), added by (the creator's display name, from server members, or "Someone"), and a "Delete :name:" icon button with a confirm `Dialog`. The dialog warns: "Messages will show :name: as text and its reactions will be removed."
- **Permissions:** without `MANAGE_EXPRESSIONS` the section is hidden from the nav. The shell already redirects hidden sections.

- [ ] **Step 4: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS.

- [ ] **Step 5: Checkpoint** — stop. The controller reviews and checks in the browser: bulk-upload three images, rename one, delete one. Then it stages. Suggested message: `feat(web): custom emoji settings with bulk upload`

---

### Task 10: End-to-end test and docs

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts` (and add a small PNG fixture under `clients/web/e2e/fixtures/` if none exists), `deploy/README.md` (features; the link preview note: outbound HTTP from the server, no private addresses)

**Interfaces:**
- **Consumes:** everything above.

- [ ] **Step 1: Extend the e2e** — after the M4 flow (alice owns the server, bob joined and accepted the rules):
  1. Alice opens Server settings → Emoji, uploads `parrot.png` (the fixture), keeps the name `parrot`, and clicks "Add all". It appears in the Server emoji table.
  2. Alice sends "who wants pizza? @bob". In bob's browser, the message has the mention highlight and `@bob` renders as a mention.
  3. Bob hovers the message, clicks "Reply" ("Replying to Alice" shows), and sends "me!". Alice sees bob's message with the quote line "alice / who wants pizza?". Clicking the quote line scrolls to and highlights the original.
  4. Bob opens "Add reaction" on alice's message, searches "parrot", and picks it. Alice sees a reaction pill ":parrot:, 1 person". Alice clicks the pill, and it reads ":parrot:, 2 people including you" (`aria-pressed=true`).
  5. Alice sends `**bold** and ||spoiler||`. Bob sees `<strong>bold</strong>`, and the spoiler is hidden until clicked.

  Select by role and name, as the existing spec does. Keep the existing parts of the spec working.

- [ ] **Step 2: Run** — the `datrope-e2e` compose stack as in M4 Task 11 (`docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait`), then `pnpm --filter @datrope/web e2e`, then `… -p datrope-e2e down -v`. Never touch other containers. Never stop the user's dev servers on :8081 and :5173. Expected: PASS.

- [ ] **Step 3: Docs** — update `deploy/README.md`:
  - Features: Markdown, replies, mentions, reactions, custom emoji, link previews.
  - A note: link previews make the server fetch pages from the internet. Only public addresses are fetched, and results are cached for 24 h.

- [ ] **Step 4: Full verification** — `go -C server vet ./...`; `go -C server test -p 2 ./...`; `gofmt -l server` (empty); `pnpm -C clients/core exec vitest run`; `pnpm -C clients/web exec vitest run`; `pnpm -C clients/web run build`; the e2e. Expected: all PASS.

- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `test(e2e): replies, mentions, custom emoji reactions; docs`
