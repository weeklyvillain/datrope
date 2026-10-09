# Milestone 8: People and catching up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make people visible and help everyone catch up:
- **Avatars** everywhere, with initials on a colour from the user ID when there is no image.
- **Profiles:** pronouns and "About me", a profile popover from any name or avatar, and a full profile in the side panel (with quick role changes for people who can manage roles).
- **Member list** with avatars, presence dots and custom status.
- **Message search** in the side panel, with typed operators and filter chips, and a jump to any message, however old.
- **Mentions inbox** behind an @ button in channel and DM headers.
- **Browser notifications**, set per device.

**Architecture:**
- **Server, profiles:** `users` gains `pronouns`, `about_me` and an avatar (a blob in the `files` store, like the server icon). The `auth` package owns the avatar routes through a small `Blobs` interface that `files` implements. Every profile change publishes `USER_UPDATE`.
- **Server, search:** Postgres full text search (`to_tsvector('simple', content)` with a GIN index). The operator parser runs on the server. Permission filtering is one SQL clause built from `channels.Readable` (server channels with `VIEW_CHANNEL` + `READ_HISTORY`, plus my DMs; threads follow their parent).
- **Server, inbox:** the existing `messages.mentions BIGINT[]` GIN index, the same permission clause, and `read_states` for "unread".
- **Server, history:** `list-messages` gains `around` and `after`, so a client can open a channel at any message.
- **Clients:** `@datrope/core` gets the profile, search, inbox and message-window API and state. The web app adds the avatar component, the popover and profile panel, the search box and panel, the inbox popover, and a notification listener. Notification settings live in `localStorage` (like `voice/prefs.ts`).

**Tech Stack:** Go (Huma, pgx, goose) · Postgres full text search · `@datrope/core` · React 18 + shadcn/ui (Radix) · Tailwind v4 · Web Notifications API · Canvas · Vitest · Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-one-server-design.md`:
- §5: `USER_UPDATE`; READY members carry the public user;
- §6: M8 ("Avatars, profile panel and popover, member list grouped by roles shown separately, message search, mentions inbox, browser notifications");
- §7: threads follow their parent's visibility; deleted messages stay hidden;
- §8: Go tests against real Postgres, Vitest, Playwright.

**Mockups (binding; read the notes in each):**
- `docs/superpowers/mockups/People.html`:
  - 1: avatars in messages and the member list; the popover (`role="dialog"`, named after the person): banner, avatar with status dot, name, "username · pronouns", custom status, "About me", "Roles", "Member since", "Message" and "View full profile";
  - the member list (`aria-label="Members"`): "Admins — 1" (roles shown separately), "Online — 3", "Offline — 1"; status lines such as "In voice: Lounge"; offline rows dimmed;
  - 2: the full profile in the side panel (`aria-label="Profile"`, heading "Profile"): "Message", "In voice: Lounge", "About me", "Roles" with "+ Add role" (`aria-label="Add role"`), "Member since".
- `docs/superpowers/mockups/Search.html`:
  - 3: the header search box ("Clear search"); results in the side panel (`aria-label="Search results"`, heading "3 results", "Close search"); chips "From: Alice ✕", "In: any channel ▾", "Has ▾", "Date ▾"; results grouped under "#general"/"#games" with `<mark>` highlights; "No more results";
  - 3b: the empty-box hints (`role="listbox"`, `aria-label="Search options"`, title "Search options", rows "from: a person", "in: a channel or DM", "has: link or file", "before: / after: a date, like 2026-05-01"); the no-results state ("No results", "Nothing matches "wingspam" from Alice.", "Clear filters").
- `docs/superpowers/mockups/Inbox.html`:
  - 4: the @ "Inbox" button with a count badge; the inbox popover (`role="dialog"`, `aria-label="Inbox"`, title "Mentions", "Mark all read"); rows with an unread dot (`aria-label="Unread"`), the place ("# games", "# games · thread "Saturday plan"", a DM name), "Jump", and "Load older";
  - 5: the system notification: title "Dan in #games" / "Bob (direct message)", plain-text body, the sender's avatar as the icon.
- `docs/superpowers/mockups/SettingsProfile.html`:
  - 6: Your settings → Profile card (`aria-label="Profile"`): avatar with "Change avatar" and "Remove", hint "PNG, JPEG, WebP or GIF, up to 2 MB."; "Display name", "Pronouns", "Custom status", "About me" with "63 / 190", "Status", "Save"; a "Preview" of the popover on the right with the note "The banner takes your highest role colour, or your initials colour if you have no coloured role.";
  - 6b: the crop dialog ("Crop your avatar", a "Zoom" range, "Cancel", "Apply");
  - 7: the Notifications card (`aria-label="Notifications"`): the "Desktop notifications" switch with its description, "Notify me about" radio group ("All messages" / "Every message in channels you can read, plus DMs."; "Mentions and direct messages" / "Recommended."; "Nothing"), and the blocked warning "Your browser is blocking notifications for this site. Allow them in the address bar site settings, then turn this on again."

## Global Constraints

- **Never commit.** (AGENTS.md §5.) Each task ends with a *Checkpoint*; the controller reviews and stages; nobody commits, amends, tags or pushes.
- **The user's unrelated work in progress is in the working tree. Never modify, stage, delete or "fix" these:**
  - `clients/web/src/sounds.ts`;
  - `clients/web/src/assets/sounds/*.mp3`;
  - the unstaged edits in `clients/web/src/main.tsx` and `clients/web/src/voice/voice.ts` (built-in join and leave sounds).
  - No task in this plan needs `voice/voice.ts` or `main.tsx`. If one turns out to, keep the changes few and on their own lines, never edit the user's `play("join")` / `play("leave")` / `import { play }` lines, and paste every hunk you added into the report so the controller stages only yours.
- **No sounds.** Notifications never play audio; built-in sounds are the user's separate work (`clients/web/src/sounds.ts`).
- **Avatars:**
  - chosen in the browser: PNG, JPEG, WebP or GIF, at most **2 MB**; cropped square in a dialog; the browser uploads a **256 × 256** image (a GIF becomes a still);
  - the server accepts PNG, JPEG, WebP or GIF up to **512 KB** and at most **1024 × 1024** pixels, sniffs the type from the bytes, strips metadata (`files.StoreImageBlob`), and serves it publicly at `/api/avatars/{userID}?v=<first 12 hex of sha256>`;
  - "Remove" goes back to initials; the fallback is initials on a colour derived from the user ID.
- **Profile fields:** pronouns ≤ **40** characters, about me ≤ **190** characters (Unicode code points, both ends), display name and custom status as before (32 / 80). Values are trimmed; empty clears.
- **Search:**
  - channels the user can read (`VIEW_CHANNEL` and `READ_HISTORY`) plus their DMs; threads follow their parent channel; never the welcome channel; never deleted messages;
  - whole words in any order (`plainto_tsquery('simple', …)`), newest first, **25** per page, cursor = the last result's ID;
  - operators `from:<username>`, `in:#<channel>` or `in:@<username>` (DMs with that person), `has:link` / `has:file`, `before:YYYY-MM-DD` / `after:YYYY-MM-DD` (both exclusive, in the caller's time zone);
  - **permission filtering happens on the server and is tested.**
- **Mentions inbox:** user mentions of me (`messages.mentions`), not my own messages, newest first, in channels, threads and DMs I can still read; unread = newer than my read state for that channel; "Mark all read" moves each channel's read state up to its newest mention; 25 per page.
- **Browser notifications:** per device (`localStorage`); off until turned on; levels "All messages" / "Mentions and direct messages" (default) / "Nothing"; DMs count as mentions; fire only when the tab is hidden or a different conversation is open; title "<Name> in #channel" or "<Name> (direct message)"; body plain text ≤ **120** characters; icon = sender avatar, else the server icon; click focuses the tab and opens the message.
- **Web UI:** shadcn/ui first (AGENTS.md §6); tokens only (new colours are added to `clients/web/src/styles.css` first); dark only (no `dark:` classes); React 18 — use `RefButton` (`@/components/ref-button`) or `React.forwardRef` for `asChild` triggers; accessible names exactly as in the mockups and this plan, because the e2e selects by role and name.
- **shadcn components:** everything this milestone needs is already in `clients/web/src/components/ui/` (`avatar`, `popover`, `dialog`, `dropdown-menu`, `switch`, `radio-group`, `textarea`, `badge`, `tooltip`, `separator`, `input`, `button`). Ranges stay native `<input type="range">` styled like `app/voice/PersonMenu.tsx` (the M7 convention). If a task needs anything else, add it with `pnpm dlx shadcn@latest add <name>` from `clients/web`, or with the JSON fallback in AGENTS.md if the CLI fails.
- **Dev environment:**
  - the user's dev servers run on :8081/:5173; implementers never start or stop them;
  - no `pnpm install`/`pnpm add`;
  - Go tests run from PowerShell with `$env:GOTOOLCHAIN='local'` (Docker must be running for `pgtest`);
  - the OpenAPI client is regenerated with `pnpm -C clients/core run gen` (PowerShell, `$env:GOTOOLCHAIN='local'`); only `clients/core/openapi.json` and `clients/core/src/schema.d.ts` change from it;
  - e2e runs use project `datrope-e2e` with the LiveKit port override `C:\Users\Filip\AppData\Local\Temp\claude\D--code-datrope\8feba40d-8a5f-4bb0-bc7f-d9dc4ef118e5\scratchpad\compose.local-ports.yml`, always end with `down -v`, and never touch other containers.

## Decisions this plan makes

1. **Avatar storage:** columns on `users` (`avatar_sha256`, `avatar_content_type`), registered with `filesSvc.AddBlobTable("users", "avatar_sha256")`. Upload is `PUT /api/users/@me/avatar` (multipart `file`) and returns the full `User`; `DELETE /api/users/@me/avatar` returns the `User` too (200, idempotent). The avatar is applied on "Apply" in the crop dialog and removed on "Remove", without waiting for "Save".
2. **New user fields are `omitempty`** (`pronouns`, `about_me`, `avatar_url`), so existing TypeScript fixtures keep compiling. Clients must clear them explicitly when a `USER_UPDATE` omits them.
3. **Live profile data:** the web app reads a person's profile from the store (`findUser`: member, DM participant or me) and falls back to the message's `author` snapshot. Old messages show a new avatar at once.
4. **Avatar colour:** FNV-1a hash of the user ID string, mod 8, mapped to eight new tokens `--avatar-1` … `--avatar-8`. Snowflake low bits are mostly zero, so `id % 8` would cluster.
5. **Popover triggers:** names are `<button>`s whose accessible name is the display name. Avatars next to a name are mouse-only duplicates (`tabIndex={-1}`, `aria-hidden`). In voice rows and tiles the avatar is its own trigger with `aria-label="Profile of <Name>"`, because the rest of the row is already a moderation menu or a person menu. Member list rows are buttons with `aria-label="<Name>"`.
6. **Member list status line:** the custom status. When there is none and the person is in voice, it shows "In voice: <channel>", as in the mockup.
7. **Side panel state** moves to a small global store (`app/side-panel/panel.ts`), so a popover anywhere can open the full profile, and search survives switching channels:
   - opening a different channel closes a thread or the threads list, but keeps search and profile open;
   - the voice channel view shows the profile panel in place of its chat.
   - The profile panel's close button is "Close profile" (from `SidePanel`'s `Close <title>` rule), not the mockup's bare "Close", so it stays unique next to other panels.
8. **Search API shape:** `GET /api/search?q=…&cursor=…&utc_offset=…`. The server parses the operators and echoes the resolved filters (`from`, `in_channel`, `in_dm_with`, `has`, `before`, `after`, `terms`) so the chips can show names. Chips edit the query text with the pure `setOperator` function in core.
   - An unknown `from:` user or `in:` channel is `400 UNKNOWN_FILTER`, shown in the panel. Naming a channel you cannot read gives the same error, so it reveals nothing.
   - `total` is sent on the first page only, capped at 1001 ("1000+ results").
9. **Search box placement:** the search box is in text channel and DM headers (`ChannelView`), not in the voice channel view.
10. **Result rows:**
    - Results render with `Markdown inline`, with highlights; inline rendering has no links, so each row can be one `<button>`.
    - Clicking a channel or DM result navigates there and jumps to the message. The search panel stays open.
    - Clicking a thread result opens the thread in the side panel, replacing search, and jumps inside it. Inbox "Jump" and notification clicks do the same.
11. **Jumping to old messages:** `jumpTo` first looks in the loaded messages, then loads up to 2 older pages, then loads a window *around* the message (`around=<id>`).
    - **A detached window:** the store's `ChannelMessages` gains `hasNewer`. While it is true, new messages are not inserted, nothing is acked, the list shows "Load newer messages" and a "Jump to present" bar, and sending first reloads the latest page.
12. **Inbox count:**
    - The first page of `GET /api/users/@me/mentions` carries `unread_count` (capped at 100; the badge shows "99+" above 99).
    - The core store keeps it live: a new mention adds one; an ack flips loaded items and subtracts them; deleting an unread mention subtracts one.
    - The web app reloads the first page after each READY and whenever the inbox opens, which corrects drift.
13. **Dates in search** use the caller's UTC offset (`utc_offset`, minutes east of UTC, sent by the client from `Date.getTimezoneOffset()`). `before:D` means before D's midnight; `after:D` means from the midnight after D.
14. **Notifications:** "All messages" includes threads and voice channel side chats. A thread message's title names the parent channel ("<Name> in #general"). Spoilers become "(spoiler)" in the body; a message with only attachments says "Sent a file" / "Sent N files".
15. **No new shadcn components;** the crop "Zoom" and similar ranges stay native inputs (M7 convention).

## File Structure

```
server/internal/db/migrations/00019_profiles.sql     users: pronouns, about_me, avatar columns
server/internal/db/migrations/00020_search.sql       GIN index on to_tsvector('simple', content)
server/internal/auth/      store.go (fields, ProfilePatch), handlers.go (PATCH @me), avatar.go (upload/remove/serve), profile_test.go
server/internal/files/     blobs.go (ImageSize)
server/internal/id/        id.go (FirstAt) + id_test.go
server/internal/channels/  readable.go (Readable)
server/internal/messages/  search_query.go (+_test), search.go (+search_test.go), inbox.go (+inbox_test.go),
                           messages.go (list around/after, scanMessage extras), handlers.go (routes), history_test.go
server/internal/app/       app.go (wiring)
clients/core/src/          types.ts, store.ts (findUser, findDM, channelRef, windows, mentions), search.ts (+test), client.ts, index.ts
clients/web/src/styles.css                 --avatar-1..8 tokens, mark style
clients/web/src/lib/avatar-color.ts        (+test)
clients/web/src/components/user-avatar.tsx, role-badge.tsx
clients/web/src/hooks/use-user.ts
clients/web/src/app/side-panel/panel.ts    panel store; SidePanel.tsx gains label/closeLabel/icon
clients/web/src/app/people/                ProfileCard.tsx, ProfilePopover.tsx, ProfilePanel.tsx, use-assignable-roles.ts
clients/web/src/app/settings/              ProfileSettings.tsx, AvatarCropDialog.tsx, avatar.ts (+test), NotificationSettings.tsx
clients/web/src/app/jump.ts                pending jumps, openMessage
clients/web/src/app/search/                SearchBox.tsx, SearchPanel.tsx, SearchChips.tsx
clients/web/src/chat/highlight.ts          (+test); remarkChat.ts / Markdown.tsx gain `highlight`
clients/web/src/app/InboxButton.tsx
clients/web/src/notify/                    prefs.ts (+test), notify.ts (+test)
clients/web/src/app/NotificationListener.tsx
clients/web/e2e/chat.spec.ts, deploy/README.md
```

---

### Task 1: Profiles and avatars (server)

**Files:**
- Create: `server/internal/db/migrations/00019_profiles.sql`, `server/internal/auth/avatar.go`, `server/internal/auth/profile_test.go`
- Modify: `server/internal/auth/store.go` (fields, `userCols`, `scanUser`, `PublicUsers`, `UpdateProfile`), `server/internal/auth/handlers.go` (`UpdateMeRequest`, `update-me`, `publishUser`), `server/internal/auth/service.go` (`blobs` field), `server/internal/files/blobs.go` (`ImageSize`), `server/internal/app/app.go` (wiring), then regenerate `clients/core/openapi.json` and `clients/core/src/schema.d.ts`

**Interfaces:**
- **Produces:**
  - `auth.User` and `auth.PublicUser` gain `Pronouns string` (`json:"pronouns,omitempty"`), `AboutMe string` (`json:"about_me,omitempty"`), `AvatarURL string` (`json:"avatar_url,omitempty"`). `AvatarURL` = `/api/avatars/<userID>?v=<sha256[:12]>` or empty.
  - `auth.ProfilePatch{DisplayName, CustomStatus, Pronouns, AboutMe *string}`; `(*Store).UpdateProfile(ctx, userID, ProfilePatch) (*User, error)`.
  - `UpdateMeRequest` gains `pronouns` (`maxLength:"40"`) and `about_me` (`maxLength:"190"`).
  - `auth.Blobs` interface; `(*auth.Service).SetBlobs(Blobs)`; raw handlers `AvatarUploadHandler()` (`PUT /api/users/@me/avatar`, behind `RequireHTTP`), `AvatarDeleteHandler()` (`DELETE /api/users/@me/avatar`, behind `RequireHTTP`), `AvatarHandler()` (`GET /api/avatars/{userID}`, public).
  - `(*files.Service).ImageSize(data []byte) (width, height int, err error)`.
  - **Errors:** `413 TOO_LARGE` ("avatars can be at most 512 KB"), `400 NOT_AN_IMAGE` ("upload a PNG, JPEG, WebP or GIF image"), `400 IMAGE_TOO_BIG` ("avatars can be at most 1024 × 1024 pixels"), `400 MISSING_FILE`, `404` for a user without an avatar.
  - **Event:** `USER_UPDATE` (the `PublicUser`) after every profile or avatar change, to co-members and the user.

- [ ] **Step 1: Write the failing tests** — `server/internal/auth/profile_test.go`:

```go
package auth_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

func pngOf(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 99, 255})
		}
	}
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, img))
	return b.Bytes()
}

func TestProfileFields(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var me auth.User
	alice.Do(http.MethodPatch, "/api/users/@me",
		map[string]any{"pronouns": " she/her ", "about_me": "Board games, synths and too many houseplants."}, http.StatusOK, &me)
	require.Equal(t, "she/her", me.Pronouns)
	require.Equal(t, "Board games, synths and too many houseplants.", me.AboutMe)
	var ev auth.PublicUser
	ws.ExpectDispatch("USER_UPDATE", &ev)
	require.Equal(t, "she/her", ev.Pronouns)
	require.Equal(t, me.AboutMe, ev.AboutMe)

	// Limits count characters, not bytes.
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"about_me": strings.Repeat("é", 190)}, http.StatusOK, &me)
	alice.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"about_me": strings.Repeat("a", 191)}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"pronouns": strings.Repeat("a", 41)}, http.StatusBadRequest, "VALIDATION_FAILED")

	// Changing one field keeps the others; empty clears.
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"pronouns": ""}, http.StatusOK, &me)
	require.Empty(t, me.Pronouns)
	require.Equal(t, strings.Repeat("é", 190), me.AboutMe)

	// READY members carry the profile.
	_, ready := bob.Connect()
	found := false
	for _, m := range ready.Server.Members {
		if m.User.ID == alice.User.ID {
			found = true
			require.Equal(t, me.AboutMe, m.User.AboutMe)
		}
	}
	require.True(t, found)
}

func TestAvatar(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()
	put := func(name string, data []byte, status int) []byte {
		return alice.UploadTo(http.MethodPut, "/api/users/@me/avatar", name, data, status)
	}
	fail := func(name string, data []byte, status int, code string) {
		t.Helper()
		var e httpx.Error
		require.NoError(t, json.Unmarshal(put(name, data, status), &e))
		require.Equal(t, code, e.Code)
	}

	var me auth.User
	require.NoError(t, json.Unmarshal(put("me.png", pngOf(t, 256, 256), http.StatusOK), &me))
	require.True(t, strings.HasPrefix(me.AvatarURL, "/api/avatars/"+alice.User.ID.String()+"?v="), me.AvatarURL)
	var ev auth.PublicUser
	ws.ExpectDispatch("USER_UPDATE", &ev)
	require.Equal(t, me.AvatarURL, ev.AvatarURL)

	// Anyone can fetch it without a session; the versioned URL is immutable.
	resp, body := env.Anon().Raw(http.MethodGet, me.AvatarURL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Contains(t, resp.Header.Get("Cache-Control"), "immutable")
	require.NotEmpty(t, body)

	// A new image gets a new URL.
	old := me.AvatarURL
	require.NoError(t, json.Unmarshal(put("me2.png", pngOf(t, 128, 128), http.StatusOK), &me))
	require.NotEqual(t, old, me.AvatarURL)

	fail("wide.png", pngOf(t, 1025, 4), http.StatusBadRequest, "IMAGE_TOO_BIG")
	fail("a.txt", []byte("not an image"), http.StatusBadRequest, "NOT_AN_IMAGE")
	fail("huge.png", bytes.Repeat([]byte{0}, 600<<10), http.StatusRequestEntityTooLarge, "TOO_LARGE")

	// Remove goes back to initials.
	alice.Do(http.MethodDelete, "/api/users/@me/avatar", nil, http.StatusOK, &me)
	require.Empty(t, me.AvatarURL)
	env.Anon().Raw(http.MethodGet, "/api/avatars/"+alice.User.ID.String(), nil, "", http.StatusNotFound)
	alice.Do(http.MethodDelete, "/api/users/@me/avatar", nil, http.StatusOK, &me) // already gone: still 200
}
```

Huma checks `maxLength` in code points (`utf8.RuneCountInString`). If the "é" × 190 case fails, check the Huma version's validator, and report it before changing the test.

- [ ] **Step 2: Run to verify they fail** — PowerShell: `$env:GOTOOLCHAIN='local'; go -C server test ./internal/auth/ -run 'TestProfileFields|TestAvatar'`. Expected: compile errors (`Pronouns`, `AboutMe`, `AvatarURL` undefined).

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00019_profiles.sql`:

```sql
-- +goose Up
ALTER TABLE users
    ADD COLUMN pronouns            TEXT NOT NULL DEFAULT '',
    ADD COLUMN about_me            TEXT NOT NULL DEFAULT '',
    ADD COLUMN avatar_sha256       TEXT,
    ADD COLUMN avatar_content_type TEXT;
CREATE INDEX users_avatar_sha_idx ON users (avatar_sha256) WHERE avatar_sha256 IS NOT NULL;

-- +goose Down
DROP INDEX users_avatar_sha_idx;
ALTER TABLE users DROP COLUMN avatar_content_type, DROP COLUMN avatar_sha256, DROP COLUMN about_me, DROP COLUMN pronouns;
```

- [ ] **Step 4: Store** — in `server/internal/auth/store.go`:
  - Add the three fields to `User` and `PublicUser` (tags as in Interfaces; `doc` strings "Up to 40 characters", "Up to 190 characters", "A 256 × 256 image; absent when the user has none, and clients draw initials"). `Public()` copies them.
  - Append the new columns at the **end** of `userCols` (callers pass `extra` destinations first): `… u.password_hash, u.pronouns, u.about_me, u.avatar_sha256`.
  - In `scanUser`: scan into `&u.Pronouns, &u.AboutMe, &avatar` (`var avatar *string`), then `u.AvatarURL = avatarURL(u.ID, avatar)`.
  - Add the helper:

```go
// avatarURL is the public, versioned URL of a user's avatar, or "" when they have none.
func avatarURL(userID id.ID, sum *string) string {
	if sum == nil || len(*sum) < 12 {
		return ""
	}
	return "/api/avatars/" + userID.String() + "?v=" + (*sum)[:12]
}
```

  - `PublicUsers` selects `id, username, display_name, custom_status, pronouns, about_me, avatar_sha256` and fills the same fields.
  - Replace `UpdateProfile` (its only caller is `update-me`):

```go
// ProfilePatch holds the profile fields to change; nil leaves a field as it is.
type ProfilePatch struct {
	DisplayName, CustomStatus, Pronouns, AboutMe *string
}

// UpdateProfile changes the fields that are not nil.
func (s *Store) UpdateProfile(ctx context.Context, userID id.ID, p ProfilePatch) (*User, error) {
	return scanUser(s.db.QueryRow(ctx, `
		UPDATE users u SET display_name = COALESCE($2, display_name), custom_status = COALESCE($3, custom_status),
		                   pronouns = COALESCE($4, pronouns), about_me = COALESCE($5, about_me)
		WHERE u.id = $1 RETURNING `+userCols, userID, p.DisplayName, p.CustomStatus, p.Pronouns, p.AboutMe))
}
```

- [ ] **Step 5: `update-me`** — in `server/internal/auth/handlers.go`:
  - `UpdateMeRequest` gains:

```go
	Pronouns *string `json:"pronouns,omitempty" maxLength:"40" doc:"Empty clears them"`
	AboutMe  *string `json:"about_me,omitempty" maxLength:"190" doc:"Empty clears it"`
```

  - The handler trims every non-nil field: a `trim := func(p *string) *string { if p == nil { return nil }; t := strings.TrimSpace(*p); return &t }`. The display name keeps its "cannot be blank" check. Then call `s.store.UpdateProfile(ctx, me, ProfilePatch{...})`.
  - Move the publish into a helper used here and by the avatar handlers:

```go
// publishUser tells co-members (and the user's other sessions) about a profile change.
func (s *Service) publishUser(u *User) {
	s.bus.Publish(events.Event{Type: "USER_UPDATE", Data: u.Public(),
		Scope: events.Scope{CoMembersOf: u.ID, UserIDs: []id.ID{u.ID}}})
}
```

- [ ] **Step 6: `files.ImageSize`** — append to `server/internal/files/blobs.go`:

```go
// ImageSize reads an image's dimensions without decoding its pixels.
func (s *Service) ImageSize(data []byte) (width, height int, err error) { return Info(data) }
```

- [ ] **Step 7: Avatar routes** — `server/internal/auth/avatar.go`. Add the field `blobs Blobs` to `Service` in `service.go`.

```go
package auth

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
)

// Blobs is what this package needs from files: cleaned, stored images.
type Blobs interface {
	StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error)
	ImageSize(data []byte) (width, height int, err error)
	RemoveBlobs(ctx context.Context, sums []string) error
	ServeBlob(w http.ResponseWriter, r *http.Request, sum, contentType string, immutable bool)
}

func (s *Service) SetBlobs(b Blobs) { s.blobs = b }

const (
	// MaxAvatarBytes caps the upload; the web app sends a 256 × 256 crop well below it.
	MaxAvatarBytes = 512 << 10
	maxAvatarSide  = 1024
)

func errAvatarTooLarge() *httpx.Error {
	return httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "avatars can be at most 512 KB")
}

func writeUser(w http.ResponseWriter, r *http.Request, u *User, err error) {
	if err != nil {
		httpx.WriteHTTPError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, u)
}

// AvatarUploadHandler serves PUT /api/users/@me/avatar (multipart "file").
// It must run behind RequireHTTP.
func (s *Service) AvatarUploadHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, err := s.uploadAvatar(w, r)
		writeUser(w, r, u, err)
	})
}

func (s *Service) uploadAvatar(w http.ResponseWriter, r *http.Request) (*User, error) {
	ctx := r.Context()
	me := Current(ctx).User.ID
	r.Body = http.MaxBytesReader(w, r.Body, MaxAvatarBytes+64<<10)
	if err := r.ParseMultipartForm(MaxAvatarBytes + 64<<10); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, errAvatarTooLarge()
		}
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	f, hdr, err := r.FormFile("file")
	if err != nil {
		return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
	}
	defer f.Close()
	if hdr.Size > MaxAvatarBytes {
		return nil, errAvatarTooLarge()
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxAvatarBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxAvatarBytes {
		return nil, errAvatarTooLarge()
	}
	width, height, err := s.blobs.ImageSize(data)
	if err != nil {
		return nil, httpx.BadRequest("NOT_AN_IMAGE", "upload a PNG, JPEG, WebP or GIF image")
	}
	if width > maxAvatarSide || height > maxAvatarSide {
		return nil, httpx.BadRequest("IMAGE_TOO_BIG", "avatars can be at most 1024 × 1024 pixels")
	}

	tx, err := s.store.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var old *string
	if err := tx.QueryRow(ctx, `SELECT avatar_sha256 FROM users WHERE id = $1 FOR UPDATE`, me).Scan(&old); err != nil {
		return nil, err
	}
	sum, ct, err := s.blobs.StoreImageBlob(ctx, tx, data) // sniffs the type and strips metadata
	if err != nil {
		return nil, err
	}
	u, err := scanUser(tx.QueryRow(ctx,
		`UPDATE users u SET avatar_sha256 = $2, avatar_content_type = $3 WHERE u.id = $1 RETURNING `+userCols, me, sum, ct))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if old != nil && *old != sum {
		if err := s.blobs.RemoveBlobs(ctx, []string{*old}); err != nil {
			slog.WarnContext(ctx, "auth: removing the old avatar; the sweep will retry", "err", err)
		}
	}
	s.publishUser(u)
	return u, nil
}

// AvatarDeleteHandler serves DELETE /api/users/@me/avatar. It must run behind RequireHTTP.
func (s *Service) AvatarDeleteHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		me := Current(ctx).User.ID
		var old *string
		if err := s.store.db.QueryRow(ctx, `SELECT avatar_sha256 FROM users WHERE id = $1`, me).Scan(&old); err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		u, err := scanUser(s.store.db.QueryRow(ctx,
			`UPDATE users u SET avatar_sha256 = NULL, avatar_content_type = NULL WHERE u.id = $1 RETURNING `+userCols, me))
		if err == nil && old != nil {
			if rerr := s.blobs.RemoveBlobs(ctx, []string{*old}); rerr != nil {
				slog.WarnContext(ctx, "auth: removing an avatar; the sweep will retry", "err", rerr)
			}
			s.publishUser(u)
		}
		writeUser(w, r, u, err)
	})
}

// AvatarHandler serves GET /api/avatars/{userID} without a session.
func (s *Service) AvatarHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid, err := httpx.ParseID(r.PathValue("userID"), "user")
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		var sum, ct string
		err = s.store.db.QueryRow(r.Context(),
			`SELECT avatar_sha256, avatar_content_type FROM users WHERE id = $1 AND avatar_sha256 IS NOT NULL`, uid).Scan(&sum, &ct)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteHTTPError(w, r, httpx.NotFound("avatar"))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		// Only the URL with the current version may be cached for ever.
		s.blobs.ServeBlob(w, r, sum, ct, len(sum) >= 12 && r.URL.Query().Get("v") == sum[:12])
	})
}
```

- [ ] **Step 8: Wire it** — in `server/internal/app/app.go`, inside the `files` block (`pool != nil`), before `filesSvc.Start()`:

```go
		authSvc.SetBlobs(filesSvc)
		filesSvc.AddBlobTable("users", "avatar_sha256")
		mux.Handle("PUT /api/users/@me/avatar", authSvc.RequireHTTP(authSvc.AvatarUploadHandler()))
		mux.Handle("DELETE /api/users/@me/avatar", authSvc.RequireHTTP(authSvc.AvatarDeleteHandler()))
		mux.Handle("GET /api/avatars/{userID}", authSvc.AvatarHandler())
```

`/api/users/@me/avatar` is not a Huma route; Go's `ServeMux` picks the most specific pattern, so it does not clash with `GET/PATCH /api/users/@me`.

- [ ] **Step 9: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...` (PowerShell, `$env:GOTOOLCHAIN='local'`). Expected: PASS. `gofmt -l server` prints nothing.

- [ ] **Step 10: Regenerate the API client** — `pnpm -C clients/core run gen` (PowerShell, `$env:GOTOOLCHAIN='local'`). Then `pnpm -C clients/core exec tsc --noEmit` and `pnpm -C clients/web run typecheck`. Expected: PASS: the new fields are optional, so nothing else changes.

- [ ] **Step 11: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(auth): avatars, pronouns and about me`

---

### Task 2: Message search and loading around a message (server)

**Files:**
- Create: `server/internal/db/migrations/00020_search.sql`, `server/internal/channels/readable.go`, `server/internal/messages/search_query.go`, `server/internal/messages/search_query_test.go`, `server/internal/messages/search.go`, `server/internal/messages/search_test.go`, `server/internal/messages/history_test.go`
- Modify: `server/internal/id/id.go` (+ `id_test.go`), `server/internal/messages/messages.go` (`Channels` interface, `scanMessage` extras, `list`), `server/internal/messages/handlers.go` (`list-messages` params, `registerSearch`), then regenerate the API client

**Interfaces:**
- **Consumes:** `channels.Service` internals (`query`, `effective`, `channelCols`), `auth.PublicUser`.
- **Produces:**
  - `id.FirstAt(t time.Time) id.ID`.
  - `(*channels.Service).Readable(ctx, userID) ([]id.ID, error)`; `messages.Channels` gains `Readable(ctx context.Context, userID id.ID) ([]id.ID, error)`.
  - `messages.ParseQuery(raw string) (Query, error)`, `type Query struct{ Text string; Terms []string; From, In, Has string; Before, After time.Time }`.
  - `messages.ChannelRef{ID id.ID; Type, Name string; ParentID *id.ID; ParentName string}` (JSON `id`, `type`, `name`, `parent_id,omitempty`, `parent_name,omitempty`), shared with Task 3.
  - `messages.SearchResult{Message Message; Channel ChannelRef}`, `messages.SearchFilters{Terms []string; From *auth.PublicUser; InChannel *ChannelRef; InDMWith *auth.PublicUser; Has, Before, After string}` (JSON `terms`, `from`, `in_channel`, `in_dm_with`, `has`, `before`, `after`, all but `terms` omitempty), `messages.SearchResponse{Results []SearchResult; Filters SearchFilters; Total *int; NextCursor *id.ID}` (JSON `results`, `filters`, `total,omitempty`, `next_cursor,omitempty`).
  - Helpers used by Task 3: `readableSQL(param string) string`, `(*Service).channelRefs(ctx, ids []id.ID) (map[id.ID]ChannelRef, error)`, `collectMessages(rows pgx.Rows) ([]Message, error)`, `channelIDsOf(ms []Message) []id.ID`, `scanMessage(row pgx.Row, extra ...any)`.
  - **Routes:** `search-messages` `GET /api/search?q=&cursor=&utc_offset=`; `list-messages` gains `after` and `around` (newest first, as before; at most one of `before`/`after`/`around`).
  - **Errors:** `400 EMPTY_QUERY` ("type something to search for"), `400 INVALID_QUERY` (`has: takes "link" or "file"`, "dates look like 2026-05-01"), `400 UNKNOWN_FILTER` (`nobody is called "<name>"`, `no channel called "#<name>"`), `400 VALIDATION_FAILED` (bad cursor; several of before/after/around).

- [ ] **Step 1: Write the failing parser test** — `server/internal/messages/search_query_test.go`:

```go
package messages

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/httpx"
)

func TestParseQuery(t *testing.T) {
	day := func(s string) time.Time {
		d, err := time.Parse(time.DateOnly, s)
		require.NoError(t, err)
		return d
	}
	tests := []struct {
		in   string
		want Query
		code string
	}{
		{in: "wingspan", want: Query{Text: "wingspan", Terms: []string{"wingspan"}}},
		{in: "Wingspan  from:alice", want: Query{Text: "Wingspan", Terms: []string{"wingspan"}, From: "alice"}},
		{in: "from:@Alice board games board", want: Query{Text: "board games board", Terms: []string{"board", "games"}, From: "Alice"}},
		{in: "in:#games has:LINK", want: Query{Terms: []string{}, In: "games", Has: "link"}},
		{in: "in:@bob snacks", want: Query{Text: "snacks", Terms: []string{"snacks"}, In: "@bob"}},
		{in: "before:2026-05-01 after:2026-04-01 x", want: Query{Text: "x", Terms: []string{"x"}, Before: day("2026-05-01"), After: day("2026-04-01")}},
		{in: "from:alice from:bob hi", want: Query{Text: "hi", Terms: []string{"hi"}, From: "bob"}},
		{in: "from: pizza", want: Query{Text: "pizza", Terms: []string{"pizza"}}},
		{in: "see https://example.com now", want: Query{Text: "see https://example.com now", Terms: []string{"see", "https", "example", "com", "now"}}},
		{in: "cost:5 Café", want: Query{Text: "cost:5 Café", Terms: []string{"cost", "5", "café"}}},
		{in: "", code: "EMPTY_QUERY"},
		{in: "   from:  ", code: "EMPTY_QUERY"},
		{in: "?!", code: "EMPTY_QUERY"},
		{in: "has:image", code: "INVALID_QUERY"},
		{in: "before:May", code: "INVALID_QUERY"},
		{in: "after:2026-13-01", code: "INVALID_QUERY"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := ParseQuery(tt.in)
			if tt.code != "" {
				var he *httpx.Error
				require.ErrorAs(t, err, &he)
				require.Equal(t, tt.code, he.Code)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.want, got)
		})
	}
}
```

Add to `server/internal/id/id_test.go`:

```go
func TestFirstAt(t *testing.T) {
	at := time.UnixMilli(Epoch + 5000)
	require.Equal(t, at.UnixMilli(), FirstAt(at).Time().UnixMilli())
	require.Equal(t, ID(0), FirstAt(time.UnixMilli(Epoch-1)))
	require.Greater(t, int64(New()), int64(FirstAt(time.Now().Add(-time.Second))))
}
```

(Use the test file's existing imports; add `time` and `require` if missing.)

- [ ] **Step 2: Write the failing integration tests** — `server/internal/messages/search_test.go`:

```go
package messages_test

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func search(t *testing.T, c *apptest.Client, q string) messages.SearchResponse {
	t.Helper()
	var r messages.SearchResponse
	c.Do(http.MethodGet, "/api/search?q="+url.QueryEscape(q), nil, http.StatusOK, &r)
	return r
}

func contents(rs []messages.SearchResult) []string {
	out := []string{}
	for _, r := range rs {
		out = append(out, r.Message.Content)
	}
	return out
}

func startThread(t *testing.T, c *apptest.Client, channelID id.ID, parent messages.Message) channels.Channel {
	t.Helper()
	var th channels.Channel
	c.Do(http.MethodPost, "/api/channels/"+channelID.String()+"/messages/"+parent.ID.String()+"/thread", map[string]any{}, http.StatusCreated, &th)
	return th
}

func dm(t *testing.T, from, to *apptest.Client) channels.Channel {
	t.Helper()
	var ch channels.Channel
	from.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{to.User.ID.String()}}, http.StatusOK, &ch)
	return ch
}

func TestSearchPermissions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	general := alice.General()
	srv := alice.Server()
	deny := func(ch id.ID, p perms.Perms) {
		alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+srv.ID.String(),
			map[string]any{"allow": 0, "deny": p}, http.StatusOK, nil)
	}
	secret := alice.CreateTextChannel("secret")
	deny(secret, perms.ViewChannel)
	noHistory := alice.CreateTextChannel("no-history")
	deny(noHistory, perms.ReadHistory)

	alice.Send(general, "wingspan in general")
	alice.Send(secret, "wingspan in secret")
	alice.Send(noHistory, "wingspan without history")
	hidden := startThread(t, alice, secret, alice.Send(secret, "plans"))
	alice.Send(hidden.ID, "wingspan in a hidden thread")
	open := startThread(t, alice, general, alice.Send(general, "saturday"))
	alice.Send(open.ID, "wingspan in a visible thread")
	alice.Send(dm(t, alice, carol).ID, "wingspan between alice and carol")
	alice.Send(dm(t, alice, bob).ID, "wingspan between alice and bob")

	got := search(t, bob, "wingspan")
	require.Equal(t, []string{"wingspan between alice and bob", "wingspan in a visible thread", "wingspan in general"}, contents(got.Results))
	require.Equal(t, 3, *got.Total)
	require.Equal(t, "dm", got.Results[0].Channel.Type)
	require.Equal(t, "thread", got.Results[1].Channel.Type)
	require.Equal(t, "general", got.Results[1].Channel.ParentName)
	require.Equal(t, "general", got.Results[2].Channel.Name)

	require.Equal(t, []string{"wingspan between alice and carol", "wingspan in a visible thread", "wingspan in general"},
		contents(search(t, carol, "wingspan").Results))
	require.Len(t, search(t, alice, "wingspan").Results, 7) // the owner reads every channel, and both her DMs

	// Naming a channel bob cannot read does not reveal it.
	bob.Fail(http.MethodGet, "/api/search?q="+url.QueryEscape("in:#secret wingspan"), nil, http.StatusBadRequest, "UNKNOWN_FILTER")

	// A kicked member keeps only their DMs.
	alice.Do(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"wingspan between alice and bob"}, contents(search(t, bob, "wingspan").Results))
}

func TestSearchFilters(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	games := alice.CreateTextChannel("games")
	alice.Send(general, "board games tonight")
	bob.Send(general, "Games night? board ready")
	alice.Send(games, "board rules: https://example.com")
	a := alice.Upload(games, "board.txt", []byte("hi"), http.StatusCreated)
	alice.SendWith(games, "board photo", a.ID)
	alice.Send(dm(t, alice, bob).ID, "board in a dm")

	// Whole words in any order, newest first.
	require.Equal(t, []string{"board in a dm", "board photo", "board rules: https://example.com", "Games night? board ready", "board games tonight"},
		contents(search(t, bob, "board").Results))
	require.Equal(t, []string{"Games night? board ready", "board games tonight"}, contents(search(t, bob, "games BOARD").Results))
	require.Empty(t, search(t, bob, "boar").Results)

	r := search(t, bob, "board from:alice in:#games")
	require.Equal(t, []string{"board photo", "board rules: https://example.com"}, contents(r.Results))
	require.Equal(t, "alice", r.Filters.From.Username)
	require.Equal(t, "games", r.Filters.InChannel.Name)
	require.Equal(t, []string{"board"}, r.Filters.Terms)

	r = search(t, bob, "board in:@alice")
	require.Equal(t, []string{"board in a dm"}, contents(r.Results))
	require.Equal(t, "alice", r.Filters.InDMWith.Username)

	require.Equal(t, []string{"board rules: https://example.com"}, contents(search(t, bob, "has:link").Results))
	require.Equal(t, []string{"board photo"}, contents(search(t, bob, "has:file board").Results))

	bob.Fail(http.MethodGet, "/api/search?q=from:nobody", nil, http.StatusBadRequest, "UNKNOWN_FILTER")
	bob.Fail(http.MethodGet, "/api/search?q=has:gif", nil, http.StatusBadRequest, "INVALID_QUERY")
	bob.Fail(http.MethodGet, "/api/search?q=", nil, http.StatusBadRequest, "EMPTY_QUERY")
	bob.Fail(http.MethodGet, "/api/search?q=board&cursor=nope", nil, http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestSearchDatesAndPages(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	noon := func(s string) time.Time {
		d, err := time.Parse(time.DateOnly, s)
		require.NoError(t, err)
		return d.Add(12 * time.Hour)
	}
	// 30 messages at noon UTC on 2026-04-10 and one on 2026-05-02, with IDs from those times.
	_, err := env.Pool.Exec(t.Context(), `
		INSERT INTO messages (id, channel_id, author_id, content)
		SELECT $3::bigint + g, $1, $2, 'cascadia ' || g FROM generate_series(1, 30) g`,
		general, alice.User.ID, int64(id.FirstAt(noon("2026-04-10"))))
	require.NoError(t, err)
	_, err = env.Pool.Exec(t.Context(), `INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, 'cascadia may')`,
		id.FirstAt(noon("2026-05-02")), general, alice.User.ID)
	require.NoError(t, err)

	first := search(t, alice, "cascadia")
	require.Len(t, first.Results, 25)
	require.Equal(t, 31, *first.Total)
	require.Equal(t, "cascadia may", first.Results[0].Message.Content)
	require.NotNil(t, first.NextCursor)
	var second messages.SearchResponse
	alice.Do(http.MethodGet, "/api/search?q=cascadia&cursor="+first.NextCursor.String(), nil, http.StatusOK, &second)
	require.Len(t, second.Results, 6)
	require.Nil(t, second.NextCursor)
	require.Nil(t, second.Total)
	require.Equal(t, "cascadia 1", second.Results[5].Message.Content)

	require.Equal(t, []string{"cascadia may"}, contents(search(t, alice, "cascadia after:2026-04-10").Results))
	require.Len(t, search(t, alice, "cascadia before:2026-05-01").Results, 25)

	// Dates are the caller's days: at UTC+14, noon UTC on 2026-04-10 is already 2026-04-11.
	var r messages.SearchResponse
	q := url.QueryEscape("cascadia before:2026-04-11")
	alice.Do(http.MethodGet, "/api/search?q="+q+"&utc_offset=840", nil, http.StatusOK, &r)
	require.Empty(t, r.Results)
	alice.Do(http.MethodGet, "/api/search?q="+q, nil, http.StatusOK, &r)
	require.Len(t, r.Results, 25)
}
```

`server/internal/messages/history_test.go`:

```go
package messages_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/messages"
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
```

- [ ] **Step 3: Run to verify they fail** — `go -C server test ./internal/id/ ./internal/messages/ -run 'TestFirstAt|TestParseQuery|TestSearch|TestHistory'`. Expected: compile errors.

- [ ] **Step 4: Migration** — `server/internal/db/migrations/00020_search.sql`:

```sql
-- +goose Up
-- Message search (M8): whole words, any language, no stemming. Queries must use the same expression.
CREATE INDEX messages_search_idx ON messages USING gin (to_tsvector('simple', content));

-- +goose Down
DROP INDEX messages_search_idx;
```

- [ ] **Step 5: `id.FirstAt`** — in `server/internal/id/id.go`:

```go
// FirstAt returns the smallest ID made at or after t; 0 for times before Epoch.
func FirstAt(t time.Time) ID {
	ms := t.UnixMilli() - Epoch
	if ms < 0 {
		return 0
	}
	return ID(ms << 22)
}
```

- [ ] **Step 6: `channels.Readable`** — `server/internal/channels/readable.go`:

```go
package channels

import (
	"context"
	"errors"

	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Readable returns the channels whose messages userID may read: server text
// and voice channels where they have VIEW_CHANNEL and READ_HISTORY, and their
// DMs. Threads are not listed: a thread is readable when its parent is.
func (s *Service) Readable(ctx context.Context, userID id.ID) ([]id.ID, error) {
	out := []id.ID{}
	sid, err := s.communities.ServerID(ctx)
	if err != nil && !errors.Is(err, communities.ErrNotFound) {
		return nil, err
	}
	if err == nil {
		m, err := s.communities.PermMember(ctx, sid, userID)
		switch {
		case errors.Is(err, communities.ErrNotMember): // DMs only
		case err != nil:
			return nil, err
		default:
			chs, err := s.query(ctx, `SELECT `+channelCols+` FROM channels WHERE community_id = $1 AND type IN ('text', 'voice')`, sid)
			if err != nil {
				return nil, err
			}
			for _, c := range chs {
				if effective(m, c).Has(perms.ViewChannel | perms.ReadHistory) {
					out = append(out, c.ID)
				}
			}
		}
	}
	rows, err := s.db.Query(ctx, `SELECT channel_id FROM dm_participants WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid id.ID
		if err := rows.Scan(&cid); err != nil {
			return nil, err
		}
		out = append(out, cid)
	}
	return out, rows.Err()
}
```

(`s.query` loads overrides, which `effective` needs; confirm in `channels.go`. A member held at the rules gate gets no server channels from `effective`.) Add `Readable` to the `messages.Channels` interface.

- [ ] **Step 7: Parser** — `server/internal/messages/search_query.go`:

```go
package messages

import (
	"strings"
	"time"
	"unicode"

	"github.com/datrope/datrope/server/internal/httpx"
)

// Query is a parsed search box: words plus operators (mockup Search.html).
type Query struct {
	Text   string    // the words, operators removed, as typed
	Terms  []string  // lower-cased words of Text without duplicates: what is searched and highlighted
	From   string    // a username, without "@"
	In     string    // a channel name without "#", or "@username" for DMs with that person
	Has    string    // "link" or "file"
	Before time.Time // a date (midnight UTC); zero when unset
	After  time.Time
}

func isOperator(key string) bool {
	switch key {
	case "from", "in", "has", "before", "after":
		return true
	}
	return false
}

// ParseQuery splits raw into words and operators. A repeated operator keeps
// its last value; an operator with no value yet ("from:") is ignored.
func ParseQuery(raw string) (Query, error) {
	var q Query
	var words []string
	for _, tok := range strings.Fields(raw) {
		key, val, ok := strings.Cut(tok, ":")
		key = strings.ToLower(key)
		if !ok || !isOperator(key) {
			words = append(words, tok)
			continue
		}
		if val == "" {
			continue
		}
		switch key {
		case "from":
			q.From = strings.TrimPrefix(val, "@")
		case "in":
			q.In = strings.TrimPrefix(val, "#")
		case "has":
			v := strings.ToLower(val)
			if v != "link" && v != "file" {
				return Query{}, httpx.BadRequest("INVALID_QUERY", `has: takes "link" or "file"`)
			}
			q.Has = v
		case "before", "after":
			d, err := time.Parse(time.DateOnly, val)
			if err != nil {
				return Query{}, httpx.BadRequest("INVALID_QUERY", "dates look like 2026-05-01")
			}
			if key == "before" {
				q.Before = d
			} else {
				q.After = d
			}
		}
	}
	q.Text = strings.Join(words, " ")
	q.Terms = searchTerms(q.Text)
	if len(q.Terms) == 0 && q.From == "" && q.In == "" && q.Has == "" && q.Before.IsZero() && q.After.IsZero() {
		return Query{}, httpx.BadRequest("EMPTY_QUERY", "type something to search for")
	}
	return q, nil
}

// searchTerms splits text into lower-cased runs of letters and digits, roughly
// as Postgres' parser does for the 'simple' configuration.
func searchTerms(text string) []string {
	seen := map[string]bool{}
	out := []string{}
	split := func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }
	for _, w := range strings.FieldsFunc(strings.ToLower(text), split) {
		if !seen[w] {
			seen[w] = true
			out = append(out, w)
		}
	}
	return out
}
```

- [ ] **Step 8: Search** — `server/internal/messages/search.go`. Write the types from Interfaces, then:

```go
const (
	searchPage     = 25
	searchCountCap = 1001 // "1000+ results"
)

// readableSQL limits messages m to the channels in the bigint[] parameter
// and the threads of those channels (a thread follows its parent).
func readableSQL(param string) string {
	return `(m.channel_id = ANY(` + param + `) OR m.channel_id IN (
		SELECT c.id FROM channels c WHERE c.type = 'thread' AND c.parent_channel_id = ANY(` + param + `)))`
}

const searchWhere = `NOT m.deleted AND %READABLE%
	AND ($2 = '' OR to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $2))
	AND ($3::bigint IS NULL OR m.author_id = $3)
	AND (NOT $4 OR m.content ~* 'https?://')
	AND (NOT $5 OR EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id))
	AND ($6::bigint IS NULL OR m.id < $6)
	AND ($7::bigint IS NULL OR m.id >= $7)`

// Search runs a search box query for userID (spec M8: channels they can read
// plus their DMs; threads follow their parent). utcOffset is minutes east of
// UTC; before:/after: dates are days in that offset.
func (s *Service) Search(ctx context.Context, userID id.ID, raw string, cursor *id.ID, utcOffset int) (*SearchResponse, error) {
	q, err := ParseQuery(raw)
	if err != nil {
		return nil, err
	}
	scope, err := s.channels.Readable(ctx, userID)
	if err != nil {
		return nil, err
	}
	resp := &SearchResponse{Results: []SearchResult{}, Filters: SearchFilters{Terms: q.Terms, Has: q.Has}}
	var author *id.ID
	if q.From != "" {
		uid, u, err := s.userNamed(ctx, q.From)
		if err != nil {
			return nil, err
		}
		author, resp.Filters.From = &uid, u
	}
	if q.In != "" {
		if scope, err = s.searchScope(ctx, userID, scope, q.In, &resp.Filters); err != nil {
			return nil, err
		}
	}
	loc := time.FixedZone("", utcOffset*60)
	var before, after *id.ID
	if !q.Before.IsZero() {
		b := id.FirstAt(time.Date(q.Before.Year(), q.Before.Month(), q.Before.Day(), 0, 0, 0, 0, loc))
		before, resp.Filters.Before = &b, q.Before.Format(time.DateOnly)
	}
	if !q.After.IsZero() {
		a := id.FirstAt(time.Date(q.After.Year(), q.After.Month(), q.After.Day()+1, 0, 0, 0, 0, loc))
		after, resp.Filters.After = &a, q.After.Format(time.DateOnly)
	}
	where := strings.Replace(searchWhere, "%READABLE%", readableSQL("$1"), 1)
	args := []any{id.Int64s(scope), strings.Join(q.Terms, " "), author, q.Has == "link", q.Has == "file", before, after}

	rows, err := s.db.Query(ctx, `SELECT `+messageCols+` FROM messages m WHERE `+where+`
		AND ($8::bigint IS NULL OR m.id < $8) ORDER BY m.id DESC LIMIT $9`, append(args, cursor, searchPage+1)...)
	if err != nil {
		return nil, err
	}
	ms, err := collectMessages(rows)
	if err != nil {
		return nil, err
	}
	if len(ms) > searchPage {
		ms = ms[:searchPage]
		next := ms[searchPage-1].ID
		resp.NextCursor = &next
	}
	if cursor == nil {
		var n int
		if err := s.db.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM messages m WHERE `+where+` LIMIT `+
			strconv.Itoa(searchCountCap)+`) x`, args...).Scan(&n); err != nil {
			return nil, err
		}
		resp.Total = &n
	}
	if err := s.hydrate(ctx, ms); err != nil {
		return nil, err
	}
	refs, err := s.channelRefs(ctx, channelIDsOf(ms))
	if err != nil {
		return nil, err
	}
	for _, m := range ms {
		resp.Results = append(resp.Results, SearchResult{Message: m, Channel: refs[m.ChannelID]})
	}
	return resp, nil
}
```

Also in `search.go`:
- `collectMessages(rows pgx.Rows) ([]Message, error)`: the scanning loop from `list` (closes `rows`; returns `[]Message{}` when empty). `list` uses it too (Step 9).
- `channelIDsOf(ms []Message) []id.ID`.
- `userNamed(ctx, name) (id.ID, *auth.PublicUser, error)`: `s.users.UserIDsByUsername(ctx, []string{strings.ToLower(name)})`. A missing user → `httpx.BadRequest("UNKNOWN_FILTER", fmt.Sprintf("nobody is called %q", name))`. Otherwise `s.users.PublicUsers` gives the user for the filter echo.
- `searchScope(ctx, userID, scope []id.ID, in string, f *SearchFilters) ([]id.ID, error)`:
  - `in` starting with `@` resolves the user as above. The scope becomes `SELECT c.id FROM channels c JOIN dm_participants p ON p.channel_id = c.id WHERE c.id = ANY($1) AND c.type = 'dm' AND p.user_id = $2`, which can be empty. It sets `f.InDMWith`.
  - Otherwise the scope is `SELECT id FROM channels WHERE id = ANY($1) AND type IN ('text', 'voice') AND lower(name) = lower($2) ORDER BY id LIMIT 1`. None → `httpx.BadRequest("UNKNOWN_FILTER", fmt.Sprintf("no channel called %q", "#"+in))`. The scope becomes `[]id.ID{that}` (its threads come in through `readableSQL`). It sets `f.InChannel` from `channelRefs`.
- `channelRefs`:

```go
// channelRefs describes where messages are, for search results and the inbox.
func (s *Service) channelRefs(ctx context.Context, ids []id.ID) (map[id.ID]ChannelRef, error) {
	rows, err := s.db.Query(ctx, `
		SELECT c.id, c.type, c.name, c.parent_channel_id, COALESCE(p.name, '')
		FROM channels c LEFT JOIN channels p ON p.id = c.parent_channel_id
		WHERE c.id = ANY($1)`, id.Int64s(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[id.ID]ChannelRef, len(ids))
	for rows.Next() {
		var r ChannelRef
		var parent *int64
		if err := rows.Scan(&r.ID, &r.Type, &r.Name, &parent, &r.ParentName); err != nil {
			return nil, err
		}
		r.ParentID = id.FromNullable(parent)
		if r.Type == channels.TypeDM {
			r.Name = "" // clients name DMs after the other people
		}
		out[r.ID] = r
	}
	return out, rows.Err()
}
```

- `registerSearch(api, s, op)`, called from `Register` next to `registerPins`:

```go
func registerSearch(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("search-messages", http.MethodGet, "/api/search", 0),
		func(ctx context.Context, in *struct {
			Q         string `query:"q" maxLength:"500" doc:"Words plus from:, in:, has:, before:, after:"`
			Cursor    string `query:"cursor" doc:"next_cursor from the previous page"`
			UTCOffset int    `query:"utc_offset" minimum:"-840" maximum:"840" doc:"Minutes east of UTC, for before:/after: dates"`
		}) (*struct{ Body *SearchResponse }, error) {
			var cursor *id.ID
			if in.Cursor != "" {
				c, err := id.Parse(in.Cursor)
				if err != nil {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "cursor must be a message ID")
				}
				cursor = &c
			}
			r, err := s.Search(ctx, auth.Current(ctx).User.ID, in.Q, cursor, in.UTCOffset)
			return &struct{ Body *SearchResponse }{r}, err
		})
}
```

- [ ] **Step 9: Loading around a message** — in `server/internal/messages/messages.go`:
  - `scanMessage(row pgx.Row, extra ...any)` appends `extra` after its own destinations (Task 3 needs one extra column). Existing callers are unchanged.
  - Replace `list` (its only caller is `list-messages`):

```go
// list returns up to limit messages, newest first: the latest ones, or those
// before, after or around a message ID (callers set at most one).
func (s *Service) list(ctx context.Context, channelID id.ID, before, after, around *id.ID, limit int) ([]Message, error) {
	var sql string
	args := []any{channelID}
	switch {
	case after != nil:
		sql = `SELECT * FROM (SELECT ` + messageCols + ` FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id LIMIT $3) x ORDER BY id DESC`
		args = append(args, *after, limit)
	case around != nil: // the message, older ones, then newer ones
		sql = `(SELECT ` + messageCols + ` FROM messages WHERE channel_id = $1 AND id <= $2 ORDER BY id DESC LIMIT $3)
			UNION ALL (SELECT ` + messageCols + ` FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id LIMIT $4)
			ORDER BY id DESC`
		args = append(args, *around, limit-limit/2, limit/2)
	default:
		sql = `SELECT ` + messageCols + ` FROM messages WHERE channel_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`
		args = append(args, before, limit)
	}
	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	out, err := collectMessages(rows)
	if err != nil {
		return nil, err
	}
	return out, s.hydrate(ctx, out)
}
```

  - In `handlers.go` `list-messages`: add `After string \`query:"after" doc:"Only messages newer than this ID"\`` and `Around string \`query:"around" doc:"Messages around this ID, itself included"\``. Parse each with `id.Parse` (`VALIDATION_FAILED`, "<name> must be a message ID"). More than one of before/after/around → `httpx.BadRequest("VALIDATION_FAILED", "use only one of before, after and around")`. Call `s.list(ctx, ch.ID, before, after, around, in.Limit)`.

- [ ] **Step 10: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...` (PowerShell). Expected: PASS. `gofmt -l server` empty. If `has:link` or term matching fails, run the query in `psql` against a pgtest database to check `to_tsvector('simple', …)`, and fix the test data, not the semantics.

- [ ] **Step 11: Regenerate the API client** — as in Task 1, Step 10. Expected: core and web typecheck PASS.

- [ ] **Step 12: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(messages): full-text search with server-side permission filtering; history around a message`

---

### Task 3: Mentions inbox (server)

**Files:**
- Create: `server/internal/messages/inbox.go`, `server/internal/messages/inbox_test.go`
- Modify: `server/internal/messages/handlers.go` (`registerInbox(api, s, op)` call), then regenerate the API client

**Interfaces:**
- **Consumes:** Task 2's `readableSQL`, `channelRefs`, `channelIDsOf`, `scanMessage(row, extra...)`, `channels.Readable`, `ChannelRef`.
- **Produces:**
  - `messages.MentionItem{Message Message; Channel ChannelRef; Unread bool}` (JSON `message`, `channel`, `unread`).
  - `messages.MentionsPage{Items []MentionItem; UnreadCount *int; NextCursor *id.ID}` (JSON `items`, `unread_count,omitempty`, `next_cursor,omitempty`).
  - `messages.AckMentionsResult{ReadStates []ReadState}` (JSON `read_states`; each has `channel_id` and `last_read_id`).
  - **Routes:** `list-mentions` `GET /api/users/@me/mentions?before=&limit=` (limit 1–50, default 25); `ack-mentions` `POST /api/users/@me/mentions/ack` → 200.

- [ ] **Step 1: Write the failing test** — `server/internal/messages/inbox_test.go` (reuses `startThread` and `dm` from `search_test.go`, same package):

```go
package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func itemIDs(items []messages.MentionItem) []id.ID {
	out := []id.ID{}
	for _, it := range items {
		out = append(out, it.Message.ID)
	}
	return out
}

func TestMentionsInbox(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	general := alice.General()
	srv := alice.Server()
	hide := func(ch id.ID) {
		alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+srv.ID.String(),
			map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)
	}
	secret := alice.CreateTextChannel("secret")
	hide(secret)

	inGeneral := alice.Send(general, "@bob you in?")
	alice.Send(secret, "@bob can't see this")
	thread := startThread(t, alice, general, alice.Send(general, "Saturday plan"))
	inThread := carol.Send(thread.ID, "@bob vote on the start time please")
	inDM := alice.Send(dm(t, alice, bob).ID, "are we still on for Saturday, @bob?")
	alice.Send(dm(t, alice, carol).ID, "@bob is not here")
	bob.Send(general, "talking to myself @bob")
	alice.Send(general, "no mention of anyone")

	get := func(query string) messages.MentionsPage {
		t.Helper()
		var p messages.MentionsPage
		bob.Do(http.MethodGet, "/api/users/@me/mentions"+query, nil, http.StatusOK, &p)
		return p
	}

	page := get("")
	require.Equal(t, []id.ID{inDM.ID, inThread.ID, inGeneral.ID}, itemIDs(page.Items))
	require.Equal(t, 3, *page.UnreadCount)
	require.True(t, page.Items[0].Unread)
	require.Equal(t, "dm", page.Items[0].Channel.Type)
	require.Equal(t, "thread", page.Items[1].Channel.Type)
	require.Equal(t, "general", page.Items[1].Channel.ParentName)
	require.Nil(t, page.NextCursor)

	// Reading #general up to the mention makes it read.
	bob.Do(http.MethodPost, "/api/channels/"+general.String()+"/ack", map[string]any{"message_id": inGeneral.ID.String()}, http.StatusNoContent, nil)
	page = get("")
	require.Equal(t, 2, *page.UnreadCount)
	require.False(t, page.Items[2].Unread)

	// Pages.
	page = get("?limit=2")
	require.Len(t, page.Items, 2)
	require.NotNil(t, page.NextCursor)
	older := get("?limit=2&before=" + page.NextCursor.String())
	require.Equal(t, []id.ID{inGeneral.ID}, itemIDs(older.Items))
	require.Nil(t, older.UnreadCount)

	// Mark all read: each channel up to its newest mention.
	var acked messages.AckMentionsResult
	bob.Do(http.MethodPost, "/api/users/@me/mentions/ack", nil, http.StatusOK, &acked)
	require.Len(t, acked.ReadStates, 3)
	for _, rs := range acked.ReadStates {
		require.NotNil(t, rs.LastReadID)
	}
	require.Equal(t, 0, *get("").UnreadCount)

	// Losing access to a channel hides its mentions (and its threads').
	hide(general)
	require.Equal(t, []id.ID{inDM.ID}, itemIDs(get("").Items))

	// Others never see bob's inbox.
	var carols messages.MentionsPage
	carol.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &carols)
	require.Empty(t, carols.Items)
}
```

- [ ] **Step 2: Run to verify it fails** — `go -C server test ./internal/messages/ -run TestMentionsInbox`. Expected: compile errors.

- [ ] **Step 3: Implement** — `server/internal/messages/inbox.go` (add the type definitions from Interfaces at the top):

```go
package messages

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

const mentionsUnreadCap = 100

// mentionsWhere: live messages that mention $1, by someone else, where $1 can still read them ($2).
var mentionsWhere = `m.mentions @> ARRAY[$1::bigint] AND NOT m.deleted AND m.author_id <> $1 AND ` + readableSQL("$2")

// unreadSQL: m is newer than $1's read position in its channel.
const unreadSQL = `m.id > COALESCE((SELECT rs.last_message_id FROM read_states rs WHERE rs.user_id = $1 AND rs.channel_id = m.channel_id), 0)`

// Mentions lists the messages that mention userID, newest first (spec M8).
func (s *Service) Mentions(ctx context.Context, userID id.ID, before *id.ID, limit int) (*MentionsPage, error) {
	scope, err := s.channels.Readable(ctx, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+messageCols+`, `+unreadSQL+` FROM messages m
		WHERE `+mentionsWhere+` AND ($3::bigint IS NULL OR m.id < $3) ORDER BY m.id DESC LIMIT $4`,
		userID, id.Int64s(scope), before, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ms []Message
	var unread []bool
	for rows.Next() {
		var u bool
		m, err := scanMessage(rows, &u)
		if err != nil {
			return nil, err
		}
		ms, unread = append(ms, *m), append(unread, u)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	page := &MentionsPage{Items: []MentionItem{}}
	if len(ms) > limit {
		ms, unread = ms[:limit], unread[:limit]
		next := ms[limit-1].ID
		page.NextCursor = &next
	}
	if before == nil {
		var n int
		if err := s.db.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM messages m WHERE `+mentionsWhere+` AND `+unreadSQL+
			` LIMIT `+strconv.Itoa(mentionsUnreadCap)+`) x`, userID, id.Int64s(scope)).Scan(&n); err != nil {
			return nil, err
		}
		page.UnreadCount = &n
	}
	if err := s.hydrate(ctx, ms); err != nil {
		return nil, err
	}
	refs, err := s.channelRefs(ctx, channelIDsOf(ms))
	if err != nil {
		return nil, err
	}
	for i, m := range ms {
		page.Items = append(page.Items, MentionItem{Message: m, Channel: refs[m.ChannelID], Unread: unread[i]})
	}
	return page, nil
}

// AckMentions moves the read position of every channel with a mention of
// userID up to its newest mention ("Mark all read").
func (s *Service) AckMentions(ctx context.Context, userID id.ID) (*AckMentionsResult, error) {
	scope, err := s.channels.Readable(ctx, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `
		INSERT INTO read_states (user_id, channel_id, last_message_id)
		SELECT $1, m.channel_id, max(m.id) FROM messages m WHERE `+mentionsWhere+` GROUP BY m.channel_id
		ON CONFLICT (user_id, channel_id)
		DO UPDATE SET last_message_id = GREATEST(read_states.last_message_id, EXCLUDED.last_message_id)
		RETURNING channel_id, last_message_id`, userID, id.Int64s(scope))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &AckMentionsResult{ReadStates: []ReadState{}}
	for rows.Next() {
		var r ReadState
		var last int64
		if err := rows.Scan(&r.ChannelID, &last); err != nil {
			return nil, err
		}
		l := id.ID(last)
		r.LastReadID = &l
		out.ReadStates = append(out.ReadStates, r)
	}
	return out, rows.Err()
}

func registerInbox(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("list-mentions", http.MethodGet, "/api/users/@me/mentions", 0),
		func(ctx context.Context, in *struct {
			Before string `query:"before" doc:"next_cursor from the previous page"`
			Limit  int    `query:"limit" minimum:"1" maximum:"50" default:"25"`
		}) (*struct{ Body *MentionsPage }, error) {
			var before *id.ID
			if strings.TrimSpace(in.Before) != "" {
				b, err := id.Parse(in.Before)
				if err != nil {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "before must be a message ID")
				}
				before = &b
			}
			p, err := s.Mentions(ctx, auth.Current(ctx).User.ID, before, in.Limit)
			return &struct{ Body *MentionsPage }{p}, err
		})
	huma.Register(api, op("ack-mentions", http.MethodPost, "/api/users/@me/mentions/ack", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body *AckMentionsResult }, error) {
			r, err := s.AckMentions(ctx, auth.Current(ctx).User.ID)
			return &struct{ Body *AckMentionsResult }{r}, err
		})
}
```

(`SELECT messageCols … FROM messages m`: the select list is unqualified over a single table, so it is unambiguous; the subqueries use their own aliases.)

- [ ] **Step 4: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...`. Expected: PASS. `gofmt -l server` empty.

- [ ] **Step 5: Regenerate the API client** — as in Task 1, Step 10.

- [ ] **Step 6: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(messages): mentions inbox with read state and mark all read`

---

### Task 4: Core client — profiles, avatars and DMs

**Files:**
- Modify: `clients/core/src/store.ts`, `clients/core/src/client.ts`, `clients/core/src/index.ts` (exports, if it doesn't `export *`), `clients/core/src/store.test.ts`, `clients/core/src/client.test.ts`; `clients/web/src/app/settings/UserSettings.tsx` and `clients/web/src/app/ProfileStrip.tsx` (switch to `client.updateMe`)

**Interfaces:**
- **Consumes:** the regenerated schema (Task 1: `User`/`PublicUser` with optional `pronouns`, `about_me`, `avatar_url`).
- **Produces:**
  - `publicUser(u: User): PublicUser` (store.ts).
  - `findUser(s: State, userId: string): PublicUser | undefined`: a member, else a DM participant, else me (as `publicUser(s.me)`).
  - `findDM(s: State, userId: string): string | undefined`: the ID of my 1:1 DM with that user.
  - `renameUser` (internal, on `USER_UPDATE`) copies `display_name`, `custom_status`, `pronouns`, `about_me` and `avatar_url` explicitly, so omitted fields are cleared on members, DM participants and `me`.
  - **Client:**
    - `updateMe(patch: { display_name?: string; custom_status?: string; pronouns?: string; about_me?: string }): Promise<User>`: PATCH `/api/users/@me`, then `apply("USER_UPDATE", publicUser(u))`;
    - `uploadAvatar(image: Blob): Promise<User>`: multipart PUT `/api/users/@me/avatar` (filename `avatar.png`), then apply;
    - `removeAvatar(): Promise<User>`: DELETE `/api/users/@me/avatar`, JSON response, then apply;
    - `openDM(userId: string): Promise<Channel>`: the existing 1:1 DM, or POST `/api/dms` `{recipient_ids: [userId]}`, then `apply("CHANNEL_CREATE", ch)`.

- [ ] **Step 1: Write the failing tests** — append to `clients/core/src/store.test.ts` (inside `describe("store")`; import `findUser` and `findDM` at the top):

```ts
  it("finds users anywhere and clears omitted profile fields on USER_UPDATE", () => {
    let s = loaded();
    s = applyEvent(s, "USER_UPDATE", { id: "20", username: "bob", display_name: "Bob", custom_status: "", pronouns: "he/him", avatar_url: "/api/avatars/20?v=abc" });
    expect(findUser(s, "20")).toMatchObject({ pronouns: "he/him", avatar_url: "/api/avatars/20?v=abc" });
    expect(s.me?.avatar_url).toBe("/api/avatars/20?v=abc");
    s = applyEvent(s, "USER_UPDATE", { id: "20", username: "bob", display_name: "Bob", custom_status: "" });
    expect(findUser(s, "20")?.avatar_url).toBeUndefined();
    expect(findUser(s, "20")?.pronouns).toBeUndefined();
    expect(s.me?.avatar_url).toBeUndefined();
    expect(findUser(s, "999")).toBeUndefined();
  });

  it("finds a DM participant and my 1:1 DM", () => {
    const meUser = { id: "20", username: "bob", display_name: "Bob", custom_status: "" };
    const carol = { id: "30", username: "carol", display_name: "Carol", custom_status: "" };
    const s = applyReady(initialState, ready({
      dms: [
        { id: "500", type: "dm", name: "", position: 0, topic: "", overrides: [], participants: [meUser, carol, bob] },
        { id: "501", type: "dm", name: "", position: 0, topic: "", overrides: [], participants: [meUser, carol] },
      ],
    }));
    expect(findUser(s, "30")?.display_name).toBe("Carol");
    expect(findDM(s, "30")).toBe("501");
    expect(findDM(s, "2")).toBeUndefined(); // only a group DM with bob
  });
```

Append to `clients/core/src/client.test.ts`:

```ts
it("uploads an avatar and applies the USER_UPDATE", async () => {
  let hasFile = false;
  server.use(http.put(`${BASE}/api/users/@me/avatar`, async ({ request }) => {
    hasFile = (await request.formData()).get("file") instanceof File;
    return HttpResponse.json({ ...ready.user, avatar_url: "/api/avatars/1?v=0123456789ab" });
  }));
  const client = readyClient();
  const u = await client.uploadAvatar(new Blob(["x"], { type: "image/png" }));
  expect(hasFile).toBe(true);
  expect(u.avatar_url).toBe("/api/avatars/1?v=0123456789ab");
  expect(client.store.getState().me?.avatar_url).toBe("/api/avatars/1?v=0123456789ab");
});

it("removes an avatar", async () => {
  server.use(http.delete(`${BASE}/api/users/@me/avatar`, () => HttpResponse.json({ ...ready.user })));
  const client = readyClient();
  client.apply("USER_UPDATE", { id: "1", username: "alice", display_name: "Alice", custom_status: "", avatar_url: "/a" });
  await client.removeAvatar();
  expect(client.store.getState().me?.avatar_url).toBeUndefined();
});

it("updateMe patches and applies the change", async () => {
  let sent: unknown;
  server.use(http.patch(`${BASE}/api/users/@me`, async ({ request }) => {
    sent = await request.json();
    return HttpResponse.json({ ...ready.user, pronouns: "she/her" });
  }));
  const client = readyClient();
  await client.updateMe({ pronouns: "she/her" });
  expect(sent).toEqual({ pronouns: "she/her" });
  expect(client.store.getState().me?.pronouns).toBe("she/her");
});

it("openDM reuses a 1:1 DM and creates one otherwise", async () => {
  const bob = { id: "2", username: "bob", display_name: "Bob", custom_status: "" };
  const alice = { id: "1", username: "alice", display_name: "Alice", custom_status: "" };
  const client = new DatropeClient({ baseUrl: BASE, wsUrl: "ws://unused" });
  client.store.setState(applyReady(client.store.getState(), {
    ...ready, dms: [{ id: "700", type: "dm", name: "", position: 0, topic: "", overrides: [], participants: [alice, bob] }],
  }), true);
  expect((await client.openDM("2")).id).toBe("700"); // no request: msw fails on unhandled ones

  let body: unknown;
  server.use(http.post(`${BASE}/api/dms`, async ({ request }) => {
    body = await request.json();
    return HttpResponse.json({ id: "701", type: "dm", name: "", position: 0, topic: "", overrides: [], participants: [alice, { ...bob, id: "3" }] });
  }));
  const ch = await client.openDM("3");
  expect(body).toEqual({ recipient_ids: ["3"] });
  expect(client.store.getState().dmIds).toContain(ch.id);
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm -C clients/core exec vitest run`. Expected: FAIL (missing exports and methods).

- [ ] **Step 3: Implement** — in `store.ts`:

```ts
export function publicUser(u: User): PublicUser {
  return { id: u.id, username: u.username, display_name: u.display_name, custom_status: u.custom_status,
    pronouns: u.pronouns, about_me: u.about_me, avatar_url: u.avatar_url };
}

/** A person's public profile from wherever the state has it: the server, a DM, or me. */
export function findUser(s: State, userId: string): PublicUser | undefined {
  const m = s.server?.members[userId];
  if (m) return m.user;
  for (const id of s.dmIds) {
    const p = s.channels[id]?.participants?.find((x) => x.id === userId);
    if (p) return p;
  }
  return s.me?.id === userId ? publicUser(s.me) : undefined;
}

/** My 1:1 DM with a user, if there is one. */
export function findDM(s: State, userId: string): string | undefined {
  return s.dmIds.find((id) => {
    const ps = s.channels[id]?.participants ?? [];
    return ps.length === 2 && ps.some((p) => p.id === userId) && ps.some((p) => p.id === s.me?.id);
  });
}
```

In `renameUser`, build the profile once:

```ts
  const profile = { display_name: u.display_name, custom_status: u.custom_status, pronouns: u.pronouns, about_me: u.about_me, avatar_url: u.avatar_url };
```

Members keep `{ ...m, user: u }` and participants keep `u` (as now); `me` becomes `{ ...s.me, ...profile }`. The `undefined` values in `profile` overwrite old values (the tests check this).

In `client.ts`:
- `updateMe` uses `unwrap(this.api.PATCH("/api/users/@me", { body: patch }))`.
- `uploadAvatar` uses `(await this.multipart("PUT", "/api/users/@me/avatar", image, "avatar.png")) as User`.
- `removeAvatar` uses `fetch(this.url("/api/users/@me/avatar"), { method: "DELETE", headers: this.authHeaders(), credentials: "include" })`, then `throwApiError` on failure, else `(await res.json()) as User`.
- All three end with `this.apply("USER_UPDATE", publicUser(u))` and return `u`.
- `openDM`:

```ts
  /** My 1:1 DM with a user: the existing one, or a new one. */
  async openDM(userId: string): Promise<Channel> {
    const existing = findDM(this.store.getState(), userId);
    if (existing) return this.store.getState().channels[existing]!;
    const ch = await unwrap(this.api.POST("/api/dms", { body: { recipient_ids: [userId] } }));
    this.apply("CHANNEL_CREATE", ch);
    return ch;
  }
```

In the web app, replace the two hand-built `client.apply("USER_UPDATE", {...})` calls (`UserSettings.tsx`; `ProfileStrip.tsx`'s `EditStatusDialog`) with `await client.updateMe({...})`.

- [ ] **Step 4: Run** — `pnpm -C clients/core exec vitest run`, `pnpm -C clients/core exec tsc --noEmit`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web exec vitest run`. Expected: PASS.

- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(core): profiles, avatars and opening a DM`

---

### Task 5: Core client — search, mentions inbox and message windows

**Files:**
- Create: `clients/core/src/search.ts`, `clients/core/src/search.test.ts`
- Modify: `clients/core/src/types.ts`, `clients/core/src/store.ts`, `clients/core/src/client.ts`, `clients/core/src/index.ts`, `clients/core/src/store.test.ts`, `clients/core/src/client.test.ts`

**Interfaces:**
- **Consumes:** Tasks 2–3 schema: `SearchResponse`, `SearchResult`, `SearchFilters`, `ChannelRef`, `MentionItem`, `MentionsPage`, `AckMentionsResult`, the `search-messages`, `list-mentions` and `ack-mentions` routes, and `list-messages` `after`/`around`.
- **Produces:**
  - **types.ts:** `ChannelRef`, `SearchResponse`, `SearchResult`, `SearchFilters`, `MentionItem`, `MentionsPage`.
  - **search.ts:**
    - `type SearchOperator = "from" | "in" | "has" | "before" | "after"`;
    - `setOperator(query: string, key: SearchOperator, value: string | null): string`;
    - `clearOperators(query: string): string`;
    - `operatorValue(query: string, key: SearchOperator): string | undefined`.
  - **store.ts:**
    - `ChannelMessages.hasNewer?: boolean`;
    - `State.mentions: MentionsState`, where `MentionsState = { items: MentionItem[]; unread: number; hasMore: boolean; loaded: boolean }` (initial `{ items: [], unread: 0, hasMore: false, loaded: false }`; `applyReady` resets it);
    - `replaceWindow(s, channelId, page: Message[]): State`;
    - `appendNewer(s, channelId, page: Message[]): State`;
    - `latestWindow(s, channelId, page: Message[], limit: number): State`;
    - `setMentions(s, page: MentionsPage, older: boolean): State`;
    - `markMentionsRead(s, states: ReadState[]): State`;
    - `channelRef(s, channelId): ChannelRef`.
  - **Store behaviour:**
    - `MESSAGE_CREATE` skips inserting into a list with `hasNewer`, and adds an unread inbox item when `mentions.loaded` and the message mentions me from someone else;
    - `MESSAGE_UPDATE` replaces an inbox item's message;
    - `MESSAGE_DELETE` drops an inbox item (and one unread if it was unread);
    - `ackLocal` flips that channel's inbox items up to the message and subtracts them from `unread`.
  - **client.ts:**
    - `search(q: string, cursor?: string): Promise<SearchResponse>` (sends `utc_offset = -new Date().getTimezoneOffset()`);
    - `loadAround(channelId, messageId, limit = 50)`, `loadNewer(channelId, limit = 50)`, `loadLatest(channelId, limit = 50)`;
    - `loadMentions()`, `loadOlderMentions()`, `markMentionsRead()`.

- [ ] **Step 1: Write the failing tests** — `clients/core/src/search.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clearOperators, operatorValue, setOperator } from "./search";

describe("search operators", () => {
  it("sets, replaces and removes one operator", () => {
    expect(setOperator("wingspan", "from", "bob")).toBe("wingspan from:bob");
    expect(setOperator("wingspan FROM:alice in:#games", "from", "bob")).toBe("wingspan in:#games from:bob");
    expect(setOperator("wingspan from:alice", "from", null)).toBe("wingspan");
    expect(setOperator("", "has", "link")).toBe("has:link");
    expect(setOperator("info:x  in:#a", "in", null)).toBe("info:x");
    expect(setOperator("https://x.com from:a", "from", "")).toBe("https://x.com");
  });

  it("reads and clears operators", () => {
    expect(operatorValue("x from:@Alice", "from")).toBe("@Alice");
    expect(operatorValue("x", "in")).toBeUndefined();
    expect(clearOperators("wingspam from:alice has:file  x")).toBe("wingspam x");
  });
});
```

Append to `store.test.ts` (import `replaceWindow`, `appendNewer`, `latestWindow`, `setMentions`, `markMentionsRead`, `ackLocal`; there `bob` has id "2" and `me` has id "20"):

```ts
  it("opens a window around a message and ignores new messages until it reaches the present", () => {
    let s = loaded(); // channel 101 has 10 and 20; READY says its last message is 25
    s = replaceWindow(s, "101", [msg("6"), msg("5"), msg("4")]);
    expect(s.messages["101"].items.map((m) => m.id)).toEqual(["4", "5", "6"]);
    expect(s.messages["101"].hasNewer).toBe(true);
    s = applyEvent(s, "MESSAGE_CREATE", msg("30"));
    expect(s.messages["101"].items.map((m) => m.id)).toEqual(["4", "5", "6"]);
    expect(s.readStates["101"].lastMessageId).toBe("30");
    s = appendNewer(s, "101", [msg("30"), msg("7")]);
    expect(s.messages["101"].items.map((m) => m.id)).toEqual(["4", "5", "6", "7", "30"]);
    expect(s.messages["101"].hasNewer).toBe(false);
    s = latestWindow(s, "101", [msg("30"), msg("29")], 50);
    expect(s.messages["101"]).toMatchObject({ hasMore: false, hasNewer: false });
    expect(s.messages["101"].items.map((m) => m.id)).toEqual(["29", "30"]);
  });

  it("keeps the mentions inbox and its unread count live", () => {
    const meMention = (id: string, extra: Partial<Message> = {}) => msg(id, { mentions: ["20"], ...extra });
    let s = setMentions(loaded(), { items: [], unread_count: 2 }, false);
    expect(s.mentions).toMatchObject({ loaded: true, unread: 2, hasMore: false });
    s = applyEvent(s, "MESSAGE_CREATE", meMention("40"));
    expect(s.mentions.items.map((i) => i.message.id)).toEqual(["40"]);
    expect(s.mentions.items[0]).toMatchObject({ unread: true, channel: { id: "101", type: "text", name: "general" } });
    expect(s.mentions.unread).toBe(3);
    s = applyEvent(s, "MESSAGE_CREATE", meMention("41", { author: { id: "20", username: "bob", display_name: "Bob", custom_status: "" } }));
    expect(s.mentions.items).toHaveLength(1); // my own message
    s = ackLocal(s, "101", "40");
    expect(s.mentions.items[0].unread).toBe(false);
    expect(s.mentions.unread).toBe(2);
    s = applyEvent(s, "MESSAGE_DELETE", { id: "40", channel_id: "101" });
    expect(s.mentions.items).toHaveLength(0);
    expect(s.mentions.unread).toBe(2); // it was already read
    s = markMentionsRead(s, [{ channel_id: "101", last_read_id: "45" }]);
    expect(s.mentions.unread).toBe(0);
    expect(s.readStates["101"].lastReadId).toBe("45");
  });
```

Append to `client.test.ts`:

```ts
it("searches with the local UTC offset", async () => {
  let url: URL | undefined;
  server.use(http.get(`${BASE}/api/search`, ({ request }) => {
    url = new URL(request.url);
    return HttpResponse.json({ results: [], filters: { terms: ["wingspan"] }, total: 0 });
  }));
  const r = await readyClient().search("wingspan from:alice");
  expect(url?.searchParams.get("q")).toBe("wingspan from:alice");
  expect(url?.searchParams.get("utc_offset")).toBe(String(-new Date().getTimezoneOffset()));
  expect(url?.searchParams.has("cursor")).toBe(false);
  expect(r.total).toBe(0);
});

it("loads a window around a message", async () => {
  let around: string | null = null;
  server.use(http.get(`${BASE}/api/channels/:id/messages`, ({ request }) => {
    around = new URL(request.url).searchParams.get("around");
    return HttpResponse.json([message({ content: "old", nonce: "" })]);
  }));
  const client = readyClient();
  await client.loadAround("300", "77");
  expect(around).toBe("77");
  expect(client.store.getState().messages["300"].items.map((m) => m.content)).toEqual(["old"]);
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm -C clients/core exec vitest run`. Expected: FAIL.

- [ ] **Step 3: Implement `search.ts`:**

```ts
export type SearchOperator = "from" | "in" | "has" | "before" | "after";

const token = (key: SearchOperator) => new RegExp(`(^|\\s)${key}:\\S*`, "gi");
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/** Sets an operator in a search query (null or "" removes it), keeping the words and other operators. */
export function setOperator(query: string, key: SearchOperator, value: string | null): string {
  const rest = tidy(query.replace(token(key), " "));
  return value ? tidy(`${rest} ${key}:${value}`) : rest;
}

/** The value of an operator in a query (the last one wins, as on the server). */
export function operatorValue(query: string, key: SearchOperator): string | undefined {
  const all = [...query.matchAll(new RegExp(`(?:^|\\s)${key}:(\\S+)`, "gi"))];
  return all.at(-1)?.[1];
}

/** The query without any operators: "Clear filters". */
export function clearOperators(query: string): string {
  return tidy(query.split(/\s+/).filter((w) => !/^(from|in|has|before|after):/i.test(w)).join(" "));
}
```

- [ ] **Step 4: Implement the store and client:**
  - `channelRef(s, channelId)`:
    - from `s.channels[channelId]`;
    - a thread gives `{ id, type: "thread", name, parent_id, parent_name: s.channels[parent]?.name ?? "" }`;
    - a DM gives `{ id, type: "dm", name: "" }`;
    - an unknown channel gives `{ id: channelId, type: "thread", name: "" }`. Every non-thread channel I can see is in the store; threads are fetched on demand.
  - **The window helpers:**
    - `newerExists(s, channelId, items)` is true when `s.readStates[channelId]?.lastMessageId` is newer than the newest confirmed item;
    - `replaceWindow` sets `{ items: sorted page, hasMore: true, hasNewer: newerExists(...) }`;
    - `appendNewer` inserts the page with `insertSorted` and recomputes `hasNewer`;
    - `latestWindow` sets `{ items: sorted page + the list's pending items, hasMore: page.length === limit, hasNewer: false }`.
  - **`MESSAGE_CREATE` in `applyEvent`:**
    - keep the `readStates` update;
    - when `s.messages[m.channel_id]?.hasNewer`, skip inserting into the list;
    - add the inbox item when `s.mentions.loaded && s.me && m.author.id !== s.me.id && m.mentions?.includes(s.me.id)` and no item has that ID. It is prepended as `{ message: m, channel: channelRef(s, m.channel_id), unread: true }`, and `unread + 1`.
  - **`MESSAGE_UPDATE`** replaces `item.message` when present, keeping `reactions` as for lists.
  - **`MESSAGE_DELETE`** removes the item; if it was unread, `unread = max(0, unread - 1)`.
  - **`ackLocal`:** besides `readStates`, flip items with `channel.id === channelId && unread && compareIds(message.id, messageId) <= 0`, and subtract their number from `unread` (min 0). Return `s` unchanged only when neither changed.
  - **`setMentions(s, page, older)`:**
    - `items` = (older ? existing + page items without duplicates : page items);
    - `hasMore = !!page.next_cursor`;
    - `unread = page.unread_count ?? s.mentions.unread`;
    - `loaded: true`.
  - **`markMentionsRead(s, states)`:** `ackLocal` for each state, then every item `unread: false`, and `unread: 0`.
  - **Client:**
    - `search` calls `this.api.GET("/api/search", { params: { query: { q, utc_offset, ...(cursor ? { cursor } : {}) } } })`;
    - `loadAround` GETs `around`, then `replaceWindow`;
    - `loadNewer` GETs `after` = the newest confirmed item, then `appendNewer`;
    - `loadLatest` GETs with no cursor, then `latestWindow`;
    - `loadMentions` GETs `/api/users/@me/mentions`, then `setMentions(…, false)`;
    - `loadOlderMentions` GETs with `before` = the oldest loaded item, then `setMentions(…, true)`;
    - `markMentionsRead` POSTs `/api/users/@me/mentions/ack`, then `markMentionsRead(s, r.read_states ?? [])`.
  - **`index.ts`:** export `search.ts` and the new store functions (follow the existing export style).

- [ ] **Step 5: Run** — core vitest, `pnpm -C clients/core exec tsc --noEmit`, `pnpm -C clients/web run typecheck`. Fix web type errors only where core shapes changed. Expected: PASS.

- [ ] **Step 6: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(core): search, mentions inbox and message windows`

---

### Task 6: Web — avatars everywhere and the member list

**Files:**
- Create: `clients/web/src/lib/avatar-color.ts`, `clients/web/src/lib/avatar-color.test.ts`, `clients/web/src/components/user-avatar.tsx`, `clients/web/src/hooks/use-user.ts`
- Modify: `clients/web/src/styles.css` (tokens), `clients/web/src/app/MessageList.tsx`, `clients/web/src/app/side-panel/ThreadPanel.tsx`, `clients/web/src/app/ThreadSummary.tsx`, `clients/web/src/app/DMList.tsx`, `clients/web/src/app/ProfileStrip.tsx`, `clients/web/src/app/voice/VoiceMembers.tsx`, `clients/web/src/app/voice/Tile.tsx`, `clients/web/src/app/server-settings/Members.tsx`, `clients/web/src/app/server-settings/RoleEditor.tsx`, `clients/web/src/app/MemberList.tsx`

**Interfaces:**
- **Consumes:** Task 4's `findUser`, `PublicUser.avatar_url`.
- **Produces:**
  - `avatarColorIndex(userId: string): number` (1–8); `avatarColor(userId: string): string` (`"var(--avatar-N)"`).
  - `<UserAvatar user={{ id; display_name; username; avatar_url? }} size="xs" | "sm" | "md" | "lg" | "xl" status?: string ringClassName?: string className? />`:
    - sizes 20 / 24 / 32 / 40 / 80 px;
    - `status` draws a `PresenceDot` at the bottom right with `ring-2` in `ringClassName` (default `ring-card`).
  - `useUser(userId: string, fallback?: PublicUser): PublicUser | undefined`.

- [ ] **Step 1: Write the failing test** — `clients/web/src/lib/avatar-color.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { avatarColor, avatarColorIndex } from "./avatar-color";

describe("avatar colour", () => {
  it("is stable and one of the eight tokens", () => {
    expect(avatarColor("1234567890")).toBe(avatarColor("1234567890"));
    expect(avatarColor("42")).toMatch(/^var\(--avatar-[1-8]\)$/);
  });

  it("spreads snowflake-like IDs over the palette", () => {
    // Snowflakes made in different milliseconds often end in the same bits.
    const ids = Array.from({ length: 64 }, (_, i) => String((BigInt(i + 1) << 22n) + 1767225600000n));
    expect(new Set(ids.map(avatarColorIndex)).size).toBeGreaterThanOrEqual(6);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm -C clients/web exec vitest run src/lib/avatar-color.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement:**
  - **`styles.css`** — add to `:root`:

```css
  --avatar-1: #34495e;
  --avatar-2: #5b3a6e;
  --avatar-3: #2d5a46;
  --avatar-4: #6e4b2a;
  --avatar-5: #2a4f6e;
  --avatar-6: #6e2a3f;
  --avatar-7: #4b5a2a;
  --avatar-8: #3f3f6e;
```

  and to `@theme inline`: `--color-avatar-1: var(--avatar-1);` … `--color-avatar-8: var(--avatar-8);`. These are dark enough for `text-foreground` initials.
  - **`avatar-color.ts`:**

```ts
export const AVATAR_COLORS = 8;

/** 1–8, from an FNV-1a hash of the user ID (snowflake low bits cluster, so not id % 8). */
export function avatarColorIndex(userId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % AVATAR_COLORS) + 1;
}

/** The initials background for someone without an avatar. */
export const avatarColor = (userId: string) => `var(--avatar-${avatarColorIndex(userId)})`;
```

  - **`user-avatar.tsx`:**
    - shadcn `Avatar` with `AvatarImage src={user.avatar_url} alt=""` (decorative: the name is always next to it or in the trigger's label);
    - `AvatarFallback` with `style={{ background: avatarColor(user.id) }}`, `text-foreground font-semibold`, and `initials(displayName(user))` from `@/session`;
    - size classes from a map (`xs: "size-5 text-[9px]"`, `sm: "size-6 text-[0.65rem]"`, `md: "size-8 text-xs"`, `lg: "size-10 text-sm"`, `xl: "size-20 text-[26px]"`);
    - wrap it in a `relative` span when `status` is set, for the dot (`size-3` for md/lg, `size-5` for xl, `ring-2`/`ring-4`).
  - **`use-user.ts`:** `export function useUser(userId: string, fallback?: PublicUser) { return useApp((s) => findUser(s, userId)) ?? fallback; }`.
  - **Replace each initials-only `Avatar`** (`grep -rn "initials(" clients/web/src --include=*.tsx`) with `UserAvatar`:
    - MessageList author: `lg`, `useUser(m.author.id, m.author)`;
    - ThreadPanel parent message: `lg`;
    - ThreadSummary participants: `xs`, keeping their stacking classes;
    - DMList: `lg` for 1:1 DMs (the other person), keeping initials of the joined names for groups;
    - ProfileStrip: `md` with the existing presence dot moved into `status`;
    - VoiceMembers rows: `sm`, keeping the speaking ring;
    - Tile avatar tiles: `xl`, or the tile's existing size map;
    - Members.tsx / RoleEditor.tsx rows: `md`.
  - **`MemberList.tsx`** (keep the grouping and sorting code as it is):
    - each row: `UserAvatar size="md" status={presences[id]}` + a two-line text block: the name, coloured with `roleColor`, then the status line in `text-xs text-muted-foreground truncate`;
    - the status line is `user.custom_status`, else `In voice: <channel name>` when `s.voice[id]` is in a server channel (`s.channels[voice.channel_id]?.name`; a DM call shows nothing);
    - offline rows `opacity-50`;
    - the row layout is `flex items-center gap-2.5 rounded-md px-2 py-1.5`, hover `bg-accent`;
    - the width matches the mockup: `w-[240px]`;
    - group headings stay `"<name> — <count>"`.

- [ ] **Step 4: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS.

- [ ] **Step 5: Checkpoint** — stop. The controller reviews and checks in the browser (initials colours, the member list per People.html §1; an avatar can be uploaded with `curl` against `PUT /api/users/@me/avatar` until Task 8), then stages. Suggested message: `feat(web): avatars everywhere and a richer member list`

---

### Task 7: Web — profile popover and full profile panel

**Files:**
- Create: `clients/web/src/app/side-panel/panel.ts`, `clients/web/src/app/people/ProfileCard.tsx`, `clients/web/src/app/people/ProfilePopover.tsx`, `clients/web/src/app/people/ProfilePanel.tsx`, `clients/web/src/app/people/use-assignable-roles.ts`, `clients/web/src/components/role-badge.tsx`
- Modify: `clients/web/src/app/side-panel/SidePanel.tsx` (`label`, `closeLabel`, `icon` props), `clients/web/src/app/ChannelView.tsx` (panel store), `clients/web/src/app/voice/VoiceChannelView.tsx` (profile panel), `clients/web/src/app/MessageList.tsx` (name and avatar triggers), `clients/web/src/app/MemberList.tsx` (row triggers), `clients/web/src/app/voice/VoiceMembers.tsx` and `clients/web/src/app/voice/Tile.tsx` (avatar triggers), `clients/web/src/chat/Markdown.tsx` (mention triggers), `clients/web/src/app/server-settings/Members.tsx` (use `RoleBadge` and `useAssignableRoles`)

**Interfaces:**
- **Consumes:** Task 4 (`findUser`, `client.openDM`), Task 6 (`UserAvatar`, `useUser`, `avatarColor`), `roleColor`, `canManageRole`/`myRank`/`outranks` (`@/lib/hierarchy`), `useMyRank`, `usePerms`.
- **Produces:**
  - **`panel.ts`** (zustand vanilla store + hook, like `voice/prefs.ts`):

```ts
export type Panel =
  | null
  | { kind: "threads" }
  | { kind: "thread"; threadId: string }
  | { kind: "profile"; userId: string }
  | { kind: "search" };
export const panelStore: StoreApi<{ panel: Panel; query: string }>;
export function usePanel<T>(select: (s: { panel: Panel; query: string }) => T): T;
export function openPanel(p: Panel): void;
export function closePanel(): void;
export function setSearchQuery(q: string): void; // used by Task 9
```

  - `<ProfileCard userId variant="popover" | "panel" preview?: Partial<PublicUser> onAction?: () => void />` — the content; `preview` overrides fields and hides the action buttons (for Your settings).
  - `<ProfilePopover userId fallback?: PublicUser side? children />` — `children` is a single `asChild` trigger that forwards its ref (`RefButton`, or a `forwardRef` button).
  - `<ProfilePanel userId onClose />`.
  - `useAssignableRoles(userId: string): { held: Role[]; addable: Role[]; canEdit: boolean }`.
  - `<RoleBadge role />` (moved from `Members.tsx` unchanged).
  - `SidePanel` gains `label?: string` (default `title`), `closeLabel?: string` (default `` `Close ${title.toLowerCase()}` ``), `icon?: ReactNode` (default `MessageSquare`).

**Behaviour:**
- **Panel store:**
  - `ChannelView` replaces its local `panel` state with `usePanel` (`"threads"` → `{kind: "threads"}`, `{threadId}` → `{kind: "thread", threadId}`).
  - On a channel change it calls `closePanel()` only when the panel is a thread or the threads list.
  - It renders `ProfilePanel` for `kind: "profile"`; Task 9 adds search.
  - `VoiceChannelView` renders `ProfilePanel` when `kind === "profile"` (in place of the chat panel) and ignores the other kinds.
- **ProfileCard** (People.html §1 and §2):
  - banner `h-16` (panel `h-24`) with `style={{ background: roleColor(sv, id) ?? avatarColor(id) }}`;
  - `UserAvatar size="xl" status={presence}` overlapping (`-mt-10`, `ring-4 ring-popover`);
  - the display name (18 px bold; panel 20 px) and `"<username> · <pronouns>"` (or just the username) in muted small text;
  - the custom status;
  - in the panel only: `In voice: <channel>` when `s.voice[id]?.channel_id` is a server channel, `In a call` when it is a DM;
  - a separator; "About me" section (`h3`-style `sec` label) when set; "Roles" with `RoleBadge`s (not @everyone, highest first) when any;
  - "Member since" with `new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(member.joined_at))` when they are a member;
  - **actions** (none when `preview` is set):
    - for someone else: "Message" (primary, `flex-1`), which calls `client.openDM(id)`, then `navigate("/messages/<id>")`;
    - for me: "Edit profile", which goes to `/settings`;
    - in the popover only: "View full profile" (outline), which calls `openPanel({ kind: "profile", userId })`;
    - `onAction` closes the popover after any action.
  - The panel shows "Message"/"Edit profile" beside the name, as in the mockup.
- **ProfilePopover:**
  - shadcn `Popover`; `PopoverContent side={side ?? "right"} align="start" className="w-[300px] overflow-hidden p-0" aria-label={displayName(user)}` (Radix gives it `role="dialog"`);
  - the content is `ProfileCard variant="popover"`;
  - for people not in the store (a deleted account's message), `fallback` supplies the name.
- **Triggers** (Decision 5):
  - **MessageList:** the author name becomes a forwardRef plain `<button type="button">` styled as before (`font-semibold`, role colour, `hover:underline`), whose text is the name. The avatar becomes a `tabIndex={-1} aria-hidden` button opening the same popover: one controlled `open` state, the name as the `PopoverTrigger`, and the avatar button setting `open` too. Grouped rows keep no avatar.
  - **MemberList:** each row is a full-width forwardRef button `aria-label={name}` inside `ProfilePopover side="left"`.
  - **VoiceMembers rows and voice `Tile`s:** the avatar becomes its own trigger button `aria-label={`Profile of ${name}`}`, outside the existing `DropdownMenuTrigger` / `PersonMenu` content, so buttons don't nest. In `VoiceMembers`, move the avatar out of `row` into the `li`, before the trigger. In `Tile`, only avatar tiles get it; camera tiles get it on the name label.
  - **Mentions:** in `chat/Markdown.tsx`'s `components.span`, a `className === "mention"` span with `data-user-id` renders `<MentionTrigger userId>`. This is a forwardRef `<button type="button" className="mention">@name</button>` inside `ProfilePopover`; keep the `data-me` attribute so its styling stays. `inlineComponents` keeps plain spans: no popovers in headers or search results.
- **ProfilePanel:**
  - `SidePanel title="Profile" icon={<UserRound />}`: its label is "Profile" and its close button "Close profile";
  - the body is `ProfileCard variant="panel"` plus, when `useAssignableRoles(id).canEdit`:
    - each held role that is assignable gets a small ✕ button `aria-label={`Remove role ${role.name}`}`;
    - a dashed "+ Add role" button (`aria-label="Add role"`) opens a `DropdownMenu` of `addable` roles;
  - changes call `PUT`/`DELETE /api/server/members/{userID}/roles/{roleID}` (as `Members.tsx`'s `ManageRoles` does), with errors shown under the roles with `ErrorText`.
- **`useAssignableRoles`** mirrors `Members.tsx`:
  - `assignable = hasPerm(perms, Perm.ManageRoles) ? ranked.filter((r) => canManageRole(rank, perms, r)) : []`;
  - `canEdit = !isOwner(target) && assignable.length > 0 && (self || outranks(rank, theirRank))`;
  - `held` = their roles, highest first;
  - `addable` = assignable roles they don't hold.
  - Refactor `Members.tsx` to use the hook and `RoleBadge` without changing its behaviour.

- [ ] **Step 1: Build** the store, components and triggers above.
- [ ] **Step 2: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS. Check by reading `e2e/chat.spec.ts` that every accessible name it uses still exists (articles, "Create thread", "Pinned messages", "More options for <name>", "Voice options for <name>").
- [ ] **Step 3: Checkpoint** — stop. The controller reviews and checks in the browser: the popover from a message name, an avatar, the member list, a voice row, a mention; "View full profile"; role add/remove as an admin; "Edit profile" on yourself. Then it stages. Suggested message: `feat(web): profile popover and full profile panel`

---

### Task 8: Web — Your settings: profile card and avatar crop

**Files:**
- Create: `clients/web/src/app/settings/avatar.ts`, `clients/web/src/app/settings/avatar.test.ts`, `clients/web/src/app/settings/AvatarCropDialog.tsx`, `clients/web/src/app/settings/ProfileSettings.tsx`
- Modify: `clients/web/src/app/settings/UserSettings.tsx` (replace the Profile card with `<ProfileSettings />`)

**Interfaces:**
- **Consumes:** Task 4 (`client.updateMe`, `uploadAvatar`, `removeAvatar`), Task 7 (`ProfileCard` with `preview`), Task 6 (`UserAvatar`).
- **Produces** (`avatar.ts`):
  - `MAX_AVATAR_FILE = 2 * 1024 * 1024`, `AVATAR_SIZE = 256`, `CROP_VIEW = 220`, `CROP_CIRCLE = 180`;
  - `checkAvatarFile(f: { type: string; size: number }): string | null`;
  - `type Crop = { zoom: number; x: number; y: number }` (zoom 1–3; x/y = the image centre's offset from the circle centre, in view pixels);
  - `clampCrop(w: number, h: number, c: Crop): Crop`;
  - `cropRect(w: number, h: number, c: Crop): { sx: number; sy: number; size: number }`;
  - `cropToBlob(img: HTMLImageElement, c: Crop): Promise<Blob>` (DOM; not unit-tested).

- [ ] **Step 1: Write the failing test** — `clients/web/src/app/settings/avatar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkAvatarFile, clampCrop, cropRect } from "./avatar";

describe("avatar file check", () => {
  it("accepts images up to 2 MB", () => {
    expect(checkAvatarFile({ type: "image/gif", size: 2 * 1024 * 1024 })).toBeNull();
    expect(checkAvatarFile({ type: "image/svg+xml", size: 10 })).toBe("Use a PNG, JPEG, WebP or GIF image");
    expect(checkAvatarFile({ type: "image/png", size: 2 * 1024 * 1024 + 1 })).toBe("Larger than 2 MB");
  });
});

describe("crop", () => {
  it("covers the circle with the short side at zoom 1", () => {
    expect(cropRect(400, 200, { zoom: 1, x: 0, y: 0 })).toEqual({ sx: 100, sy: 0, size: 200 });
  });

  it("moves within the image and no further", () => {
    // At zoom 1 the 400 px side is 360 view px: 90 px of play each way.
    expect(clampCrop(400, 200, { zoom: 1, x: 500, y: 40 })).toEqual({ zoom: 1, x: 90, y: 0 });
    expect(cropRect(400, 200, { zoom: 1, x: 90, y: 0 })).toEqual({ sx: 0, sy: 0, size: 200 });
  });

  it("zooms between 1 and 3", () => {
    expect(cropRect(400, 200, { zoom: 2, x: 0, y: 0 })).toEqual({ sx: 150, sy: 50, size: 100 });
    expect(clampCrop(400, 200, { zoom: 5, x: 0, y: 0 }).zoom).toBe(3);
    expect(clampCrop(400, 200, { zoom: 0.5, x: 0, y: 0 }).zoom).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm -C clients/web exec vitest run src/app/settings/avatar.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `avatar.ts`:**

```ts
export const MAX_AVATAR_FILE = 2 * 1024 * 1024;
export const AVATAR_SIZE = 256;
export const CROP_VIEW = 220; // the square crop area, in px
export const CROP_CIRCLE = 180; // the circle others see

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function checkAvatarFile(f: { type: string; size: number }): string | null {
  if (!TYPES.includes(f.type)) return "Use a PNG, JPEG, WebP or GIF image";
  if (f.size > MAX_AVATAR_FILE) return "Larger than 2 MB";
  return null;
}

export type Crop = { zoom: number; x: number; y: number };

const scaleFor = (w: number, h: number, zoom: number) => (CROP_CIRCLE / Math.min(w, h)) * zoom;

/** Keeps the zoom in 1–3 and the circle inside the image. */
export function clampCrop(w: number, h: number, c: Crop): Crop {
  const zoom = Math.min(3, Math.max(1, c.zoom));
  const s = scaleFor(w, h, zoom);
  const mx = (w * s - CROP_CIRCLE) / 2;
  const my = (h * s - CROP_CIRCLE) / 2;
  const clamp = (v: number, m: number) => Math.min(m, Math.max(-m, v)) + 0; // + 0 turns -0 into 0 for toEqual
  return { zoom, x: clamp(c.x, mx), y: clamp(c.y, my) };
}

/** The square of the source image inside the circle. */
export function cropRect(w: number, h: number, c: Crop): { sx: number; sy: number; size: number } {
  const { zoom, x, y } = clampCrop(w, h, c);
  const s = scaleFor(w, h, zoom);
  const size = CROP_CIRCLE / s;
  return { sx: w / 2 - x / s - size / 2 + 0, sy: h / 2 - y / s - size / 2 + 0, size };
}

/** Draws the crop at 256 × 256 (a GIF's first frame) as WebP, or PNG where WebP encoding is missing. */
export async function cropToBlob(img: HTMLImageElement, c: Crop): Promise<Blob> {
  const { sx, sy, size } = cropRect(img.naturalWidth, img.naturalHeight, c);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot crop images.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const webp = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.9));
  if (webp && webp.type === "image/webp") return webp;
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!png) throw new Error("This browser cannot crop images.");
  return png;
}
```

- [ ] **Step 4: Build the dialog and the card:**
  - **`AvatarCropDialog`** (`{ file: File; onClose(): void; onDone(): void }`), per SettingsProfile.html 6b:
    - shadcn `Dialog`, `DialogTitle` "Crop your avatar";
    - a `CROP_VIEW`-high area showing the image (object URL, revoked on close), positioned by the crop state, with a `CROP_CIRCLE` circle (`rounded-full ring-2 ring-foreground shadow-[0_0_0_999px_color-mix(in_srgb,var(--background)_60%,transparent)]`);
    - **moving the image:** drag with pointer events (`setPointerCapture`); arrow keys move 4 px when the area has focus (`tabIndex={0}`, `aria-label="Avatar position"`); every change goes through `clampCrop`;
    - "Zoom" row: a muted label "Zoom" and `<input type="range" min={1} max={3} step={0.01} aria-label="Zoom">`, styled like `PersonMenu`'s range;
    - footer: "Cancel" (outline) and "Apply" (primary);
    - **Apply:** `cropToBlob`, then `client.uploadAvatar`, then `onDone()`; errors show with `ErrorText` and keep the dialog open; the buttons are disabled while busy (`useSubmit`).
  - **`ProfileSettings`**, per SettingsProfile.html 6. A two-column grid on wide screens (`grid-cols-[minmax(0,1fr)_300px]`, stacked under 760 px):
    - **left:** `Card role="region" aria-label="Profile"` with `h3` "Profile":
      - `UserAvatar size="xl"`; "Change avatar" (outline sm), which clicks a hidden `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose an avatar image">`; "Remove" (ghost sm, shown only with an avatar), which calls `client.removeAvatar()`; the hint "PNG, JPEG, WebP or GIF, up to 2 MB.";
      - choosing a file runs `checkAvatarFile`, shows its message with `ErrorText` or opens the crop dialog, and resets the input value;
      - `FormField`s "Display name" (required, `maxLength={32}`) and "Pronouns" (`maxLength={40}`, placeholder "they/them") side by side; "Custom status" (`maxLength={80}`, placeholder "What are you up to?");
      - "About me": a shadcn `Textarea` with label "About me" (`Field` + `FieldLabel`) and a right-aligned counter `${Array.from(about).length} / 190`. Characters beyond 190 code points are not accepted: trim in `onChange` with `Array.from(v).slice(0, 190).join("")`;
      - the existing "Status" select (unchanged);
      - "Save" (primary, `type="submit"`), which calls `client.updateMe({ display_name, pronouns, custom_status, about_me })`.
    - **right:** `p.sec`-style "Preview", then `ProfileCard variant="popover" userId={me.id} preview={{ display_name, pronouns, custom_status, about_me }}` inside a `rounded-xl border bg-popover overflow-hidden` box, then the note "The banner takes your highest role colour, or your initials colour if you have no coloured role." (`text-xs text-muted-foreground`).
  - In `UserSettings.tsx`, the Profile card becomes `<ProfileSettings />`; the Sessions card and the admin link stay.

- [ ] **Step 5: Run** — web vitest, typecheck, build. Expected: PASS.
- [ ] **Step 6: Checkpoint** — stop. The controller reviews and checks in the browser: crop a JPEG and a GIF, Remove, the live preview, the counter, Save. Then it stages. Suggested message: `feat(web): profile settings with avatar crop and live preview`

---

### Task 9: Web — jump to any message, and the search panel

**Files:**
- Create: `clients/web/src/app/jump.ts`, `clients/web/src/chat/highlight.ts`, `clients/web/src/chat/highlight.test.ts`, `clients/web/src/app/search/SearchBox.tsx`, `clients/web/src/app/search/SearchPanel.tsx`, `clients/web/src/app/search/SearchChips.tsx`
- Modify: `clients/web/src/app/MessageList.tsx` (`jumpTo`, pending jumps, detached windows, export `stamp`), `clients/web/src/app/Composer.tsx` (reload the latest page before sending from a detached window), `clients/web/src/chat/remarkChat.ts` and `clients/web/src/chat/Markdown.tsx` (`highlight`), `clients/web/src/styles.css` (`mark` style in `.chat-md`), `clients/web/src/app/ChannelView.tsx` (search box and panel)

**Interfaces:**
- **Consumes:** Task 5 (`client.search`, `loadAround`, `loadNewer`, `loadLatest`, `setOperator`, `clearOperators`, `operatorValue`, `ChannelRef`, `SearchResponse`), Task 7 (`panelStore`, `usePanel`, `openPanel`, `closePanel`, `setSearchQuery`, `SidePanel` props), Task 6 (`UserAvatar`, `useUser`).
- **Produces:**
  - `jump.ts`:
    - `usePendingJump(channelId): string | undefined`;
    - `clearPendingJump()`;
    - `openMessage(navigate: (to: string) => void, where: ChannelRef, messageId: string)`.
  - `splitHighlights(text: string, terms: string[]): { text: string; mark: boolean }[]`.
  - `Markdown` and `MarkdownView` accept `highlight?: string[]`; `ChatOptions.highlight?: string[]`.
  - `jumpTo(channelId, messageId): Promise<boolean>` keeps its signature and now falls back to `client.loadAround`.
  - `stamp(d: Date): string` exported from `MessageList.tsx` (used by Task 10).

- [ ] **Step 1: Write the failing test** — `clients/web/src/chat/highlight.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitHighlights } from "./highlight";

describe("splitHighlights", () => {
  it("marks whole words, ignoring case", () => {
    expect(splitHighlights("I have Wingspan and wingspans", ["wingspan"])).toEqual([
      { text: "I have ", mark: false },
      { text: "Wingspan", mark: true },
      { text: " and wingspans", mark: false },
    ]);
  });

  it("marks several terms and letters beyond ASCII", () => {
    expect(splitHighlights("Café board, board-game", ["board", "café"]).filter((p) => p.mark).map((p) => p.text))
      .toEqual(["Café", "board", "board"]);
  });

  it("leaves text alone without terms", () => {
    expect(splitHighlights("hello", [])).toEqual([{ text: "hello", mark: false }]);
    expect(splitHighlights("a+b (c)", ["+", "("])).toEqual([{ text: "a+b (c)", mark: false }]);
  });
});
```

(Terms come from the server as letters and digits only; the last case checks that non-word terms are ignored and nothing is treated as a regex.)

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL.

- [ ] **Step 3: Implement `highlight.ts`:**

```ts
export type Piece = { text: string; mark: boolean };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits text into pieces, marking whole-word, case-insensitive matches of terms
 *  (as the server's 'simple' full-text search matches them). */
export function splitHighlights(text: string, terms: string[]): Piece[] {
  const words = terms.filter((t) => /[\p{L}\p{N}]/u.test(t)).sort((a, b) => b.length - a.length).map(escape);
  if (words.length === 0 || !text) return [{ text, mark: false }];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), mark: false });
    out.push({ text: m[0], mark: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false });
  return out.length > 0 ? out : [{ text, mark: false }];
}
```

- [ ] **Step 4: Highlight in Markdown:**
  - In `remarkChat.ts`, after `splitText` produces nodes (and for unchanged text nodes), split each plain `text` node outside spoilers with `splitHighlights(value, o.highlight ?? [])`. Marked pieces become `{ type: "chatMark", data: { hName: "mark" }, children: [text(piece)] }`.
  - Add `"mark"` to `ALLOWED` and `INLINE_ALLOWED` in `Markdown.tsx`; `Markdown` passes `highlight` through `options` (and into the `useMemo` key).
  - In `styles.css`, add `.chat-md mark { background: color-mix(in srgb, var(--idle) 35%, transparent); color: var(--foreground); border-radius: 3px; padding: 0 1px; }`.

- [ ] **Step 5: Jumping:**
  - **`jump.ts`:**

```ts
import type { ChannelRef } from "@datrope/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { openPanel } from "./side-panel/panel";

type Pending = { channelId: string; messageId: string } | null;
const pending = createStore<{ jump: Pending }>(() => ({ jump: null }));

export const usePendingJump = (channelId: string) =>
  useStore(pending, (s) => (s.jump?.channelId === channelId ? s.jump.messageId : undefined));
export const clearPendingJump = () => pending.setState({ jump: null });

/** Opens the conversation a message is in and asks its message list to jump there.
 *  A thread opens in the side panel of its parent channel. */
export function openMessage(navigate: (to: string) => void, where: ChannelRef, messageId: string) {
  if (where.type === "thread" && where.parent_id) {
    navigate(`/channels/${where.parent_id}`);
    openPanel({ kind: "thread", threadId: where.id });
  } else {
    navigate(where.type === "dm" ? `/messages/${where.id}` : `/channels/${where.id}`);
  }
  pending.setState({ jump: { channelId: where.id, messageId } });
}
```

  - **`MessageList.tsx`:**
    1. **`jumpTo`:** look in the DOM; else load up to **2** older pages (was 5); else `await client.loadAround(channelId, messageId)` and two `nextFrame()`s, then look again. Return `false` only if it is still missing (a deleted message).
    2. **Pending jumps:** `const pendingJump = usePendingJump(channelId)`. An effect on `[pendingJump, !!list]` runs `clearPendingJump()` and `void jumpTo(channelId, pendingJump)` once both are set; on `false` it shows `ErrorText` "That message is no longer available." under the list for 4 s.
    3. **Detached windows** (`list.hasNewer`):
       - the "opening"/"new last message" layout effect never scrolls to the bottom;
       - the ack effect and `markRead` don't run;
       - after the last message, a "Load newer messages" outline button calls `client.loadNewer(channelId)` (disabled while loading);
       - a bar under the log (styled like the "New messages" bar, `bg-secondary`) says "You're viewing older messages" with a "Jump to present" button, which calls `client.loadLatest(channelId)` and then scrolls to the bottom.
    4. Export `stamp`.
  - **`Composer.tsx`:** before `client.send`, `if (client.store.getState().messages[channelId]?.hasNewer) await client.loadLatest(channelId);`.

- [ ] **Step 6: Search box and panel:**
  - **`SearchBox`**, in `ChannelView`'s header right side, after the other buttons:
    - a `w-[260px]` (`max-[760px]:w-40`) input group: lucide `Search` icon, `Input aria-label="Search" placeholder="Search"`, and a "Clear search" ghost icon button (lucide `X`) when it has text;
    - its value is bound to `usePanel((s) => s.query)` through `setSearchQuery`;
    - **Enter:** with a non-blank value, `openPanel({ kind: "search" })` (the panel re-runs on query changes); with a blank value, nothing;
    - **Escape** blurs;
    - "Clear search" empties the query and closes the panel if it is the search panel;
    - **hints:** while the box is focused and empty, a `Popover` anchored to it (`PopoverAnchor`, `onOpenAutoFocus={(e) => e.preventDefault()}`) shows a `role="listbox"` `aria-label="Search options"` with the title "Search options" and four `role="option"` rows from Search.html 3b. Each row shows the operator in `font-mono text-primary` and its description: "from:" "a person", "in:" "a channel or DM", "has:" "link or file", "before: / after:" "a date, like 2026-05-01". Clicking a row (`onMouseDown` + `preventDefault`, to keep focus) inserts the operator (`from:`, `in:#`, `has:`, `before:`) and keeps focus.
  - **`SearchPanel`**, rendered by `ChannelView` for `kind: "search"`:
    - `SidePanel title={heading} label="Search results" closeLabel="Close search" icon={<Search />}` with `onClose={closePanel}`. `heading` is "Searching…" while the first page loads, "No results", "1 result", "<n> results", or "1000+ results" when `total > 1000`.
    - **Fetching:** when the panel opens and on each `query` change (debounced 250 ms; chips apply at once), `client.search(query)` replaces the results; "Load more" (outline, full width) appends `client.search(query, next_cursor)`. When there is no `next_cursor` and there are results, a centred muted "No more results".
    - **Chips** (`SearchChips`, a wrapping row under the header, `border-b px-4 py-2.5`), each a small rounded-full outline button:
      - **From:** when set, a primary-tinted chip with `UserAvatar size="xs"`, "From: <Name>" and an ✕ (`aria-label="Remove from filter"`), which calls `setOperator(q, "from", null)`. When unset, "From ▾" opens a `DropdownMenu` of members (by name), which calls `setOperator(q, "from", username)`.
      - **In:** "In: any channel ▾" / "In: #games ▾" / "In: DMs with Bob ▾". A `DropdownMenu` lists "Any channel", the visible text and voice channels in sidebar order (`#name` → `in:#name`), and the DM partners (`@username` → `in:@username`).
      - **Has:** "Has ▾" / "Has: link ▾" / "Has: file ▾". Items "Anything", "A link", "A file".
      - **Date:** "Date ▾" / "Before 2026-05-01 ▾" / "After … ▾". A `Popover` with two `<Input type="date">` fields labelled "Before" and "After" and a "Clear dates" ghost button.
      - Chip labels come from `response.filters`, falling back to `operatorValue(query, …)` while loading.
    - **Results:**
      - a group label (`text-xs text-muted-foreground px-4 pt-2.5`) whenever the channel differs from the previous result: `#name`, `#parent › thread name` for threads, or the DM's name (`dmName` from the store, else "Direct message");
      - each result is one `<button type="button">` (`mx-2 rounded-lg border border-transparent p-2 text-left hover:bg-background hover:border-border`; the last opened one keeps that style). Inside: `UserAvatar size="md"` (from `useUser(author.id, author)`), the name in role colour, the time (`stamp`), and `<Markdown text={content} inline highlight={filters.terms} mentions={mentions} />` in `line-clamp-3 text-sm`. Attachments-only messages show "📎 <filename>";
      - click calls `openMessage(navigate, result.channel, result.message.id)`.
    - **No-results state:** centred "No results" heading and ``Nothing matches "<terms joined>"`` + `` from <Name>`` when a from filter is set, + `.`. When the query has operators, a "Clear filters" button calls `setSearchQuery(clearOperators(query))`.
    - **Errors** (e.g. `UNKNOWN_FILTER`, `INVALID_QUERY`) show with `ErrorText` (`errorText(e)`) in place of results.
  - **`ChannelView`** renders `SearchPanel` when `panel.kind === "search"`.

- [ ] **Step 7: Run** — web vitest, typecheck, build. Expected: PASS.
- [ ] **Step 8: Checkpoint** — stop. The controller reviews and checks in the browser:
  - search with operators and chips; no-results and "Clear filters";
  - jump to a result in another channel, to a very old message (more than 150 back: "Jump to present", "Load newer messages"), and to a thread result;
  - sending from a detached window;
  - highlights.

  Then it stages. Suggested message: `feat(web): message search panel and jump to any message`

---

### Task 10: Web — mentions inbox

**Files:**
- Create: `clients/web/src/app/InboxButton.tsx`
- Modify: `clients/web/src/app/ChannelView.tsx` (header), `clients/web/src/app/AppShell.tsx` (load the inbox after each READY)

**Interfaces:**
- **Consumes:** Task 5 (`State.mentions`, `client.loadMentions`, `loadOlderMentions`, `markMentionsRead`), Task 9 (`openMessage`, `stamp`, `Markdown`), Task 6 (`UserAvatar`, `useUser`).
- **Produces:** `<InboxButton />`.

**Behaviour** (Inbox.html 4):
- **Loading:** `AppShell` runs an effect on `connection === "ready"` that calls `client.loadMentions().catch(() => undefined)`. A fresh READY resets `mentions.loaded`, so this runs after every reconnect.
- **The button:**
  - a ghost icon button with lucide `AtSign`, `aria-label="Inbox"`, `aria-expanded` while open;
  - a destructive count badge when `mentions.unread > 0` (`"99+"` above 99, `aria-hidden`; the tooltip says "Inbox, <n> unread");
  - it sits in `ChannelView`'s header, before "Threads", in both channels and DMs.
- **The popover:**
  - shadcn `Popover` with `PopoverContent align="end" className="w-[420px] p-0" aria-label="Inbox"`;
  - opening it calls `client.loadMentions()` (refresh);
  - header: title "Mentions" (15 px semibold, `text-foreground`, normal case; override the global `h3` style with classes) and a ghost sm "Mark all read" button, disabled when `unread === 0`, which calls `client.markMentionsRead()`.
- **Each item** (`border-b px-4 py-3`):
  - a top line in `text-xs text-muted-foreground`: an unread dot (`size-2 rounded-full bg-destructive`, `role="img" aria-label="Unread"`) when `item.unread`, then the place:
    - `# <name>` for channels;
    - `# <parent> · thread "<name>"` for threads (or `# <parent> · thread` when the name is unknown);
    - the DM name from the store (`dmName`) for DMs;
  - a "Jump" outline xs button at the right, which calls `openMessage(navigate, item.channel, item.message.id)` and closes the popover;
  - below: avatar (`md`), name in role colour, time (`stamp`), and `<Markdown text inline mentions>` (`line-clamp-3`).
- **Footer:** "Load older" ghost sm button when `hasMore` (calls `loadOlderMentions`); when empty, "Nobody has mentioned you yet." centred and muted. Errors show with `ErrorText`.

- [ ] **Step 1: Build** the above.
- [ ] **Step 2: Run** — web vitest, typecheck, build. Expected: PASS.
- [ ] **Step 3: Checkpoint** — stop. The controller reviews and checks in the browser with two accounts: the badge counts up; reading the channel counts it down; "Jump" works for a channel, a thread and a DM; "Mark all read"; "Load older". Then it stages. Suggested message: `feat(web): mentions inbox`

---

### Task 11: Web — browser notifications and the Notifications card

**Files:**
- Create: `clients/web/src/notify/prefs.ts`, `clients/web/src/notify/prefs.test.ts`, `clients/web/src/notify/notify.ts`, `clients/web/src/notify/notify.test.ts`, `clients/web/src/app/NotificationListener.tsx`, `clients/web/src/app/settings/NotificationSettings.tsx`
- Modify: `clients/web/src/app/AppShell.tsx` (mount the listener), `clients/web/src/app/settings/UserSettings.tsx` (the card after Profile)

**Interfaces:**
- **Consumes:** Task 5 (`channelRef`), Task 4 (`findUser`), Task 9 (`openMessage`), Task 7 (`panelStore` for an open thread), `client.onEvent`.
- **Produces:**
  - `prefs.ts`:
    - `type NotifyLevel = "all" | "mentions" | "nothing"`;
    - `type NotifyPrefs = { enabled: boolean; level: NotifyLevel }`;
    - `sanitize(raw: unknown): NotifyPrefs`;
    - `notifyPrefs` (zustand vanilla store, `localStorage` key `datrope.notifyPrefs`);
    - `useNotifyPrefs(selector)`, `setNotifyEnabled(on: boolean)`, `setNotifyLevel(level: NotifyLevel)`.
  - `notify.ts`:
    - `NotifyInput`;
    - `shouldNotify(input: NotifyInput): boolean`;
    - `notificationTitle(author: string, where: { type: string; name: string; parent_name?: string }): string`;
    - `notificationBody(content: string, attachments: number): string`.

- [ ] **Step 1: Write the failing tests** — `clients/web/src/notify/prefs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sanitize } from "./prefs";

describe("notification prefs", () => {
  it("defaults to off and mentions", () => {
    expect(sanitize(undefined)).toEqual({ enabled: false, level: "mentions" });
    expect(sanitize("nonsense")).toEqual({ enabled: false, level: "mentions" });
  });

  it("keeps valid values and drops the rest", () => {
    expect(sanitize({ enabled: true, level: "all" })).toEqual({ enabled: true, level: "all" });
    expect(sanitize({ enabled: "yes", level: "loud" })).toEqual({ enabled: false, level: "mentions" });
  });
});
```

`clients/web/src/notify/notify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { notificationBody, notificationTitle, shouldNotify, type NotifyInput } from "./notify";

const base: NotifyInput = {
  message: { author: { id: "2" }, mentions: [], channel_id: "100" },
  meId: "1",
  isDM: false,
  prefs: { enabled: true, level: "mentions" },
  permission: "granted",
  hidden: true,
  openChannelIds: ["100"],
};

describe("shouldNotify", () => {
  it("follows the level", () => {
    expect(shouldNotify(base)).toBe(false); // no mention
    expect(shouldNotify({ ...base, message: { ...base.message, mentions: ["1"] } })).toBe(true);
    expect(shouldNotify({ ...base, isDM: true })).toBe(true); // DMs count as mentions
    expect(shouldNotify({ ...base, prefs: { enabled: true, level: "all" } })).toBe(true);
    expect(shouldNotify({ ...base, isDM: true, prefs: { enabled: true, level: "nothing" } })).toBe(false);
  });

  it("needs the switch, the permission and someone else", () => {
    const dm = { ...base, isDM: true };
    expect(shouldNotify({ ...dm, prefs: { enabled: false, level: "all" } })).toBe(false);
    expect(shouldNotify({ ...dm, permission: "denied" })).toBe(false);
    expect(shouldNotify({ ...dm, permission: "unsupported" })).toBe(false);
    expect(shouldNotify({ ...dm, message: { ...dm.message, author: { id: "1" } } })).toBe(false);
    expect(shouldNotify({ ...dm, meId: undefined })).toBe(false);
  });

  it("stays quiet in the conversation you are looking at", () => {
    const dm = { ...base, isDM: true };
    expect(shouldNotify({ ...dm, hidden: false })).toBe(false);
    expect(shouldNotify({ ...dm, hidden: false, openChannelIds: ["200"] })).toBe(true);
    expect(shouldNotify({ ...dm, hidden: true, openChannelIds: ["100"] })).toBe(true);
  });
});

describe("notification text", () => {
  it("says who and where", () => {
    expect(notificationTitle("Dan", { type: "text", name: "games" })).toBe("Dan in #games");
    expect(notificationTitle("Bob", { type: "dm", name: "" })).toBe("Bob (direct message)");
    expect(notificationTitle("Carol", { type: "thread", name: "Saturday plan", parent_name: "games" })).toBe("Carol in #games");
  });

  it("is plain text up to 120 characters", () => {
    expect(notificationBody("**Saturday:** board games? ||it's a surprise||", 0)).toBe("Saturday: board games? (spoiler)");
    expect(notificationBody("see [the rules](https://x.com) and `code`", 0)).toBe("see the rules and code");
    expect(notificationBody("> quoted\nline", 0)).toBe("quoted line");
    const long = notificationBody("a".repeat(200), 0);
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(notificationBody("", 1)).toBe("Sent a file");
    expect(notificationBody("", 3)).toBe("Sent 3 files");
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm -C clients/web exec vitest run src/notify`. Expected: FAIL.

- [ ] **Step 3: Implement** — `prefs.ts`, mirroring `voice/prefs.ts`:
  - `defaults = { enabled: false, level: "mentions" }`;
  - `sanitize` checks `typeof enabled === "boolean"` and the level is one of the three, field by field;
  - `load()` reads with try/catch through `sanitize(JSON.parse(raw))`;
  - a `subscribe` writes back with try/catch.

`notify.ts`:

```ts
import type { NotifyPrefs } from "./prefs";

export interface NotifyInput {
  message: { author: { id: string }; mentions?: string[] | null; channel_id: string; deleted?: boolean };
  meId: string | undefined;
  isDM: boolean;
  prefs: NotifyPrefs;
  permission: NotificationPermission | "unsupported";
  hidden: boolean; // document.visibilityState === "hidden"
  openChannelIds: string[]; // the conversation on screen and an open thread
}

/** Whether a new message deserves a system notification (spec M8; mockup Inbox.html 5). */
export function shouldNotify(i: NotifyInput): boolean {
  if (!i.meId || i.message.author.id === i.meId || i.message.deleted) return false;
  if (!i.prefs.enabled || i.permission !== "granted" || i.prefs.level === "nothing") return false;
  if (i.prefs.level === "mentions" && !i.isDM && !(i.message.mentions ?? []).includes(i.meId)) return false;
  return i.hidden || !i.openChannelIds.includes(i.message.channel_id);
}

export function notificationTitle(author: string, where: { type: string; name: string; parent_name?: string }): string {
  if (where.type === "dm") return `${author} (direct message)`;
  return `${author} in #${where.type === "thread" ? where.parent_name || where.name : where.name}`;
}

const MAX = 120;

/** The message as plain text, cut to 120 characters. */
export function notificationBody(content: string, attachments: number): string {
  const text = content
    .replace(/\|\|[\s\S]+?\|\|/g, "(spoiler)")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return attachments === 0 ? "" : attachments === 1 ? "Sent a file" : `Sent ${attachments} files`;
  const chars = Array.from(text);
  return chars.length <= MAX ? text : chars.slice(0, MAX - 1).join("") + "…";
}
```

- [ ] **Step 4: The listener and the card:**
  - **`NotificationListener`** (mounted once in `AppShell`, renders nothing):
    - `useNavigate()` and `useLocation()`, kept in refs;
    - `client.onEvent((type, data) => …)` for `MESSAGE_CREATE`, unsubscribed on unmount.
    - **`openChannelIds`:** the route's channel (`/channels/:id` or `/messages/:id`, parsed from `location.pathname`) plus `panelStore.getState().panel` when it is `{ kind: "thread" }`.
    - **`permission`:** `"Notification" in window ? Notification.permission : "unsupported"`.
    - **`isDM`:** `s.channels[m.channel_id]?.type === "dm"`.
    - **When `shouldNotify`:**
      - `where = channelRef(s, m.channel_id)` (it carries `parent_name` for threads);
      - `name = displayName(findUser(s, m.author.id) ?? m.author)`;
      - `icon`: the author's `avatar_url` (from the store, else `m.author`), else `s.server?.server.icon_url`, made absolute with `new URL(path, location.origin).href`;
      - `const n = new Notification(notificationTitle(name, where), { body: notificationBody(m.content, m.attachments?.length ?? 0), icon, tag: m.id })`;
      - `n.onclick = () => { window.focus(); openMessage(navigate, where, m.id); n.close(); }`.
    - Wrap the constructor in try/catch: some browsers throw outside a service worker on mobile. Never play a sound.
  - **`NotificationSettings`**, per SettingsProfile.html 7: `Card role="region" aria-label="Notifications"` with `h3` "Notifications".
    - **The switch row:** "Desktop notifications" (font-medium) with the muted description "Show a system notification when Datrope is in the background or you are in another conversation.", and a shadcn `Switch aria-label="Desktop notifications"` checked when `prefs.enabled && permission === "granted"`.
    - **Turning it on:**
      - `permission === "default"` → `await Notification.requestPermission()`; enable only if it returns `"granted"`;
      - `"granted"` → enable;
      - `"denied"` → stay off.
    - **Turning it off** → `setNotifyEnabled(false)`.
    - Without `Notification` support, the switch is disabled and the text "This browser cannot show notifications." shows.
    - **Level:** `p.sec` "Notify me about", then a shadcn `RadioGroup aria-label="Notify me about"` with three bordered option rows (the selected one `border-primary bg-primary/8`):
      - "All messages" with "Every message in channels you can read, plus DMs.";
      - "Mentions and direct messages" with "Recommended.";
      - "Nothing".

      Each `RadioGroupItem` is labelled by its title (`Label htmlFor`), and the value is the `NotifyLevel`.
    - **Warning:** when `permission === "denied"`, a `role="status"` box with `border-idle text-idle` (tokens) and "Your browser is blocking notifications for this site. Allow them in the address bar site settings, then turn this on again."
    - Re-read `Notification.permission` on window focus, so the warning clears after the user allows it.
  - **`UserSettings.tsx`:** render `<NotificationSettings />` after `<ProfileSettings />`.

- [ ] **Step 5: Run** — web vitest, typecheck, build. Expected: PASS.
- [ ] **Step 6: Checkpoint** — stop. The controller reviews and checks in the browser: allow notifications on :5173; a DM and a mention from another browser while the tab is hidden; clicking opens the message; blocked permission shows the warning; "Nothing" silences. Then it stages. Suggested message: `feat(web): browser notifications with per-device settings`

---

### Task 12: End-to-end test and docs

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts`, `deploy/README.md` (features)

- [ ] **Step 1: Extend the e2e** — at the end of the existing test, after the pins part (alice and bob are both in `#general`, bob has a DM with alice, and "who wants pizza? @bob" mentions bob):
  1. **Profile:** alice opens "Your settings":
     - she fills "Pronouns" with "she/her" and "About me" with "Board games and synths", and clicks "Save";
     - she sets the file on "Choose an avatar image" to `e2e/fixtures/parrot.png` (`setInputFiles`), sees the "Crop your avatar" dialog and clicks "Apply";
     - the Profile region then shows an `img` whose `src` contains `/api/avatars/`.
     - She goes back to `#general`.
  2. **Popover:** in bob's browser, in `#general`, bob clicks the first `button` named exactly "alice" inside an `article`. The `dialog` named "alice" shows "she/her", "Board games and synths" and "Member since". He clicks "View full profile": the `complementary` named "Profile" shows "Board games and synths". He clicks "Close profile".
  3. **Search:** bob fills `getByLabel("Search", { exact: true })` with "pizza" and presses Enter. The `complementary` named "Search results" shows a button containing "who wants pizza?", which he clicks. The article containing "who wants pizza? @bob" is in the viewport (`toBeInViewport()`). He clicks "Close search".
  4. **Inbox:** bob clicks "Inbox". The `dialog` named "Inbox" shows "who wants pizza?". He clicks "Mark all read"; the dialog then shows no element named "Unread". He presses Escape.

  Don't test system notifications in Playwright; Vitest covers `shouldNotify`. Keep the earlier parts working.
- [ ] **Step 2: Run** — the `datrope-e2e` stack with the scratchpad port override (from the repo root):
  - `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml -f C:/Users/Filip/AppData/Local/Temp/claude/D--code-datrope/8feba40d-8a5f-4bb0-bc7f-d9dc4ef118e5/scratchpad/compose.local-ports.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait`;
  - then `pnpm --filter @datrope/web e2e`;
  - then the same compose command with `down -v`, whether the run passed or not.

  Never touch other containers, the user's dev servers, or the user's sound work-in-progress files. Expected: PASS.
- [ ] **Step 3: Docs** — `deploy/README.md` "Features" gains:
  - avatars (PNG, JPEG, WebP or GIF up to 2 MB, cropped to 256 × 256 in the browser), pronouns and "About me";
  - the profile popover and full profile (role changes for people with Manage roles);
  - member list with avatars, presence and status;
  - message search (operators `from:`, `in:`, `has:link`/`has:file`, `before:`/`after:`; only channels you can read and your DMs);
  - the mentions inbox;
  - browser notifications, set per device in Your settings.
- [ ] **Step 4: Full verification** — `go -C server vet ./...`; `go -C server test -p 2 ./...` (PowerShell, `$env:GOTOOLCHAIN='local'`); `gofmt -l server` (empty); `pnpm -C clients/core exec vitest run`; `pnpm -C clients/web exec vitest run`; `pnpm -C clients/web run build`; the e2e. Expected: all PASS. Also confirm (read-only `git status` / `git diff`) that `clients/web/src/sounds.ts` and `clients/web/src/assets/sounds/` are untouched and `main.tsx`/`voice/voice.ts` have no new hunks.
- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `test(e2e): profiles, search and the mentions inbox; docs`
