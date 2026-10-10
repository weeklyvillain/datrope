# Slash commands, GIFs, polls, webhook channels — design

Date: 2026-10-10. Scope: `server` and `clients/web`.

Four independent pieces, built in this order, each with its own implementation plan:

1. Slash-command framework and cheap commands (client only).
2. `/gif` via Klipy.
3. `/poll`.
4. Webhook channels with Discord-compatible webhooks.

Pieces 2 and 3 plug into the framework from piece 1. Piece 4 does not depend on the others.

## Goals

- Typing `/` at the start of a message offers built-in commands.
- Find a GIF, preview it in a modal, and post it. The posted GIF is stored on the instance.
- Create polls (single or multiple choice, open or anonymous, optional end time) with live results.
- A read-only **Webhook** channel type that external services post into using Discord's webhook format.

## 1. Slash-command framework and cheap commands

Client only. No server changes.

**Trigger.** A `/` at the very start of the composer opens the command picker. It reuses `findTrigger` / `rank` / `AutocompleteList` from `clients/web/src/chat/` with a new `"command"` trigger kind. The trigger only fires when the `/` is the first character of the text. `//text` sends a literal `/text`.

- Typing filters by command name. Each row shows `/name`, an argument hint and a one-line description.
- Tab or Enter completes the name. Esc closes the picker.
- Pressing Enter on a complete command line runs the command instead of sending the raw text.

**Registry.** `clients/web/src/chat/commands.ts` exports a list of commands:

```ts
type Command = {
  name: string;
  args?: string;          // hint, e.g. "[NdM]"
  description: string;
  available(ctx: CommandContext): boolean;
  run(args: string, ctx: CommandContext): CommandResult | Promise<CommandResult>;
};
type CommandResult =
  | { send: string }                            // post this text as a normal message
  | { open: "gif" | "poll"; query?: string }    // open a modal
  | { done: true }                              // side effect only
  | { error: string };                          // shown under the composer, nothing sent
```

`CommandContext` carries the channel (type, permissions), instance info (`gifs_enabled`) and the current user. `available` hides commands that do not apply: `/gif` without a Klipy key, `/poll` without `SendMessages` (which includes webhook channels).

**Cheap commands.**

| Command | Result |
|---|---|
| `/shrug [text]` | sends `text ¯\_(ツ)_/¯` |
| `/tableflip [text]` | sends `text (╯°□°)╯︵ ┻━┻` |
| `/unflip [text]` | sends `text ┬─┬ノ( º _ ºノ)` |
| `/me <action>` | sends `_action_` |
| `/spoiler <text>` | sends `\|\|text\|\|` (already rendered by `Markdown.tsx`) |
| `/roll [NdM]` | sends `🎲 2d6: 3 + 5 = **8**`. Default `1d20`. Limits: N 1–20, M 2–1000 |
| `/flip` | sends `🪙 Heads` or `🪙 Tails` |
| `/status [text]` | sets custom status through the existing profile PATCH; no text clears it |

`/roll` and `/flip` are computed on the client (`crypto.getRandomValues`). A user could fake a result; that is accepted for this audience.

**Errors.** Invalid arguments (`/roll 99d99999`, `/me` with no text) return `{ error }`, shown as `ErrorText` under the composer. Nothing is sent and the text stays.

**Testing.**
- Vitest: trigger detection (start of message only, `//` escape), ranking, `/roll` parser and limits, the output of every cheap command.
- Playwright: `/shrug hi` → a message `hi ¯\_(ツ)_/¯` appears.

## 2. `/gif` (Klipy)

**Config.**
- Migration: `instance_settings.klipy_api_key TEXT NULL`.
- Admin UI: new **Integrations** tab in server settings, with a masked key input, Save and Remove. The key is write-only: the API reports `klipy_configured: bool`, never the key.
- Clients get `gifs_enabled: bool` in the existing instance info. With no key, `/gif` is hidden and the GIF endpoints return 404.

**Server: new `gifs` package.**
- `GET /api/gifs/trending?pos=` and `GET /api/gifs/search?q=&pos=` proxy Klipy. They return `{ items: [{ id, title, preview_url, width, height }], next }`.
  - `preview_url` is a small WebP/MP4 on Klipy's CDN. The client loads previews from there directly.
  - Klipy's `customer_id` is an HMAC of the user ID keyed by an instance secret, so real IDs are never sent.
  - Non-GIF items (such as ad slots) are filtered out.
  - Rate limited per user with `ratelimit`.
- `POST /api/gifs/{id}/attach`:
  - The server looks the GIF up by ID with Klipy. It never fetches a URL supplied by the client.
  - It downloads the MP4 rendition (fallback WebP, then GIF), capped at 8 MB.
  - It stores it through the `files` package as an **unclaimed attachment**, exactly like `POST /api/attachments`, under the same per-user upload rate limit. It returns the attachment.
  - The attachment carries a `gif: true` flag (new `attachments.gif BOOLEAN NOT NULL DEFAULT FALSE`).
- The client then sends a normal message with `attachment_ids: [id]`. Message creation, the gallery and the player are reused.

**Rendering.** An attachment with `gif: true` plays muted, looped and autoplaying, without controls, like an image.

**Modal.** `/gif [query]` opens a shadcn `Dialog`:
- A search input prefilled with `query`, with a 300 ms debounce. Trending results show when the input is empty.
- A masonry grid with infinite scroll (`next` cursor).
- Clicking a result shows a large preview, an optional caption input, and **Send** / **Back**.
- Send: `attach`, then create the message with the caption as content.
- Footer: "Powered by KLIPY" attribution.

**Errors.**
- Klipy unreachable or erroring: "Couldn't load GIFs" with a Retry button.
- Attach fails (size, fetch, rate limit): inline error. The modal stays open.

**Testing.**
- Go, against a fake Klipy `httptest` server: response shape, ad filtering, size cap, the key never appearing in any response, `attach` producing an attachment that a message can claim, 404 without a key.
- Playwright with the GIF endpoints stubbed: `/gif cat` → pick → Send → a GIF message appears.

## 3. `/poll`

**Data.** Migration owned by the `messages` package:

```sql
CREATE TABLE polls (
    message_id BIGINT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    question   TEXT NOT NULL,
    multi      BOOLEAN NOT NULL DEFAULT FALSE,
    anonymous  BOOLEAN NOT NULL DEFAULT FALSE,
    ends_at    TIMESTAMPTZ,
    ended_at   TIMESTAMPTZ
);
CREATE TABLE poll_options (
    message_id BIGINT NOT NULL REFERENCES polls (message_id) ON DELETE CASCADE,
    position   SMALLINT NOT NULL,
    text       TEXT NOT NULL,
    emoji      TEXT,
    PRIMARY KEY (message_id, position)
);
CREATE TABLE poll_votes (
    message_id BIGINT NOT NULL,
    position   SMALLINT NOT NULL,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, position, user_id),
    FOREIGN KEY (message_id, position) REFERENCES poll_options (message_id, position) ON DELETE CASCADE
);
```

**Create.** `POST /api/channels/{id}/messages` accepts an optional `poll`:

```json
{ "question": "…", "options": [{ "text": "…", "emoji": "🍕" }], "multi": false, "anonymous": false, "duration": "24h" }
```

- Validation: question 1–300 chars; 2–10 options of 1–55 chars; `duration` one of `1h 4h 8h 24h 3d 1w` or omitted (no end). Emoji validated like reactions (`emoji_validate.go`).
- Content may be empty when a poll is present.
- Permission: the same as sending a message, so members cannot create polls in webhook channels.
- Poll messages cannot be edited (`409 POLL_NOT_EDITABLE`). They can be deleted; the poll cascades.

**Message payload.**

```json
"poll": {
  "question": "…", "multi": false, "anonymous": false,
  "ends_at": "…" | null, "ended": false,
  "options": [{ "text": "…", "emoji": "🍕", "count": 3 }],
  "total_voters": 5, "my_votes": [0]
}
```

Voter lists are never part of the message.

**Endpoints.**
- `PUT /api/channels/{c}/messages/{m}/poll/vote { positions: [] }` replaces the caller's vote. An empty list removes it. A single-choice poll takes at most one position. Needs `ViewChannel`. `409 POLL_ENDED` after the end.
- `POST /api/channels/{c}/messages/{m}/poll/end`: the author, or `ManageMessages`. Sets `ended_at`.
- `GET /api/channels/{c}/messages/{m}/poll/options/{n}/voters` lists the users who chose option `n`. Open polls only; an anonymous poll returns 404.

**Ending.** Computed lazily, with no background job: a poll has ended when `ended_at IS NOT NULL OR ends_at <= now()`. The server checks on vote and on read. The client shows a countdown and switches to the final view locally when time runs out.

**Live updates.** Gateway event `POLL_UPDATE { channel_id, message_id, options: [{ count }], total_voters, ended }`, published after every vote change and on early end. Counts only, never voter IDs. Each client learns its own `my_votes` from the PUT response.

**UI.**
- Create modal (`Dialog`, `Input`, `Checkbox`, `Select`):
  - The question.
  - Options: add, remove, reorder, per-option emoji via `EmojiPicker`.
  - **Allow multiple answers** and **Anonymous poll** checkboxes, both off by default.
  - A duration select, defaulting to 24h.
- Poll card inside the message:
  - One clickable row per option with a progress bar, percentage and checkmark for my votes.
  - Footer: "N votes · ends in 3h" or "Final results", and **End poll** for the author and moderators.
  - Once ended, the winning option(s) are highlighted.
  - Anonymous polls show an "Anonymous" badge.
  - In open polls, clicking a count opens a popover listing that option's voters.

**Testing.**
- Go integration tests on real Postgres:
  - Validation.
  - Single and multi voting, replacing and removing a vote, voting after the end.
  - End permissions.
  - Anonymous polls: the voters endpoint returns 404, and no voter IDs appear in messages or events.
  - Cascade on message delete.
  - Editing is refused.
- Vitest: percentages and winner calculation.
- Playwright: create → vote → the count updates on a second client.

## 4. Webhook channels

**Channel type.** A migration adds `'webhook'` to `channels_type_check`.
- Create Channel offers **Webhook** next to Text and Voice. The channel gets its own icon in the sidebar.
- Threads under a webhook channel are ordinary `type='thread'` channels and behave as usual.

**Permissions.**
- New flag `ManageWebhooks`. It is not in `Default`; `Admin` implies it.
- In a `webhook` channel, the channel-permission calculation clears `SendMessages` and `AttachFiles` for **everyone, admins included**. The mask does not apply to the channel's threads.
- Reactions and `CreateThreads` follow normal rules.
- With no `SendMessages`, the composer is replaced by "Only webhooks can post in this channel."

**Data.**

```sql
CREATE TABLE webhooks (
    id            BIGINT PRIMARY KEY,
    channel_id    BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    avatar_sha256 TEXT,
    token_hash    BYTEA NOT NULL,
    created_by    BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE messages
    ALTER COLUMN author_id DROP NOT NULL,
    ADD COLUMN webhook_id           BIGINT REFERENCES webhooks (id) ON DELETE SET NULL,
    ADD COLUMN author_name          TEXT NOT NULL DEFAULT '',
    ADD COLUMN author_avatar_sha256 TEXT,
    ADD COLUMN embeds               JSONB,
    ADD CONSTRAINT messages_has_author CHECK (author_id IS NOT NULL OR author_name <> '');
```

- The token is 32 random bytes. It is shown once, on create or regenerate. Only its SHA-256 is stored, like sessions.
- A webhook message stores its display name and avatar on the message, so it survives renaming or deleting the webhook.
- The 6 non-test query sites that read `author_id` (`handlers.go`, `inbox.go`, `messages.go`, `replies.go`, `search.go`, `threads.go`) switch to `LEFT JOIN users`.
- The `Message` JSON gets `webhook: { id, name, avatar_url } | null`. `author` is null for webhook messages. The `core` client types change to match.

**Management API** (needs `ManageWebhooks` on the channel):
- `GET /api/channels/{id}/webhooks`, `POST /api/channels/{id}/webhooks { name, avatar? }` (returns the URL once).
- `PATCH /api/webhooks/{id} { name?, avatar? }`, `DELETE /api/webhooks/{id}`.
- `POST /api/webhooks/{id}/token` regenerates the token and returns the new URL once.

**Management UI.** Channel settings → **Webhooks** section:
- A list of webhooks with avatar and name.
- Create (name plus optional avatar upload), rename, change avatar.
- **Copy URL** (only right after create or regenerate), **Regenerate token** (confirm dialog), delete (confirm dialog).

**Execute: `POST /api/webhooks/{id}/{token}`.** No session; the token is checked by constant-time comparison of hashes. The body is Discord-compatible:

- `content` (≤ 2000 chars), `username` (≤ 80, overrides the webhook name for this message), `avatar_url`, `embeds` (≤ 10).
- Embed fields:
  - `title` ≤ 256, `url`, `description` ≤ 4096, `color` (int).
  - `author { name ≤ 256, url, icon_url }`, `fields [{ name ≤ 256, value ≤ 1024, inline }]` ≤ 25.
  - `thumbnail.url`, `image.url`, `footer { text ≤ 2048, icon_url }`, `timestamp` (ISO 8601).
  - All embed text together ≤ 6000 chars.
- A message needs `content` or at least one embed. Unknown fields are ignored.
- Responses: `204`, or `200` with the message when `?wait=true`.
- Errors use Discord's shape `{ "code": n, "message": "…" }`: `400` invalid body, `401` bad token, `404` unknown webhook, `429` with `Retry-After`.
- Mentions: `@everyone`, `@here` and role mentions do not notify. User mentions do.
- Rate limit: 30 requests per minute per webhook.
- Webhooks post only into the channel itself (no `thread_id` in v1).

**Remote images.** `avatar_url`, `thumbnail.url`, `image.url`, `author.icon_url` and `footer.icon_url` are downloaded by the server while the message is posted:
- Through linkpreview's guarded dialer: private and loopback addresses blocked, no environment proxy.
- Images only (`image/png`, `jpeg`, `gif`, `webp`), ≤ 2 MB each, ≤ 12 per message, short timeout.
- Stored as content-addressed blobs and served from the instance. Viewers never contact third-party hosts.
- An image that fails is dropped; the message still posts. A failed `avatar_url` falls back to the webhook's avatar.
- The stored embed JSON holds instance URLs, not the original remote URLs (except `url` links, which are plain links).

**Rendering.**
- Webhook messages show the name, avatar (or a default webhook icon) and a **WEBHOOK** badge. Clicking the name opens a small popover, not a profile.
- Consecutive messages group when they have the same `webhook_id` and `author_name`.
- New `Embed` component:
  - A left border in the embed `color` (default `border-border`).
  - Author line, title (a link when `url` is set), and description rendered with `Markdown`.
  - Fields in a grid, with up to 3 inline fields per row.
  - Thumbnail on the right, full-width image, footer with icon and timestamp.
  - Colours come from tokens, except the embed's own accent colour.

**Testing.**
- Go:
  - Execute: good and bad token, Discord-shaped errors, all limits, `wait`, `@everyone` suppression, rate limit.
  - The image fetcher refuses `127.0.0.1` and private ranges, and a fake image server works.
  - The permission mask: an admin cannot post top-level, but threads work.
  - Messages survive webhook deletion; token regenerate invalidates the old URL.
- Vitest: `Embed` rendering (fields layout, missing parts).
- Playwright: create a webhook in the UI, POST to its URL from the test, see the message and embed appear.

## Out of scope

- Slack- and GitHub-native webhook formats (`/slack`, `/github`).
- Webhooks posting into threads (`thread_id`), editing or deleting webhook messages through the webhook URL.
- A general bot API, outgoing webhooks, interactive components (buttons).
- Indexing embed or poll text in search (search stays on `content`).
- `/remind`, `/event`, `/sticker`, `/youtube`.
- Server-side dice rolls.
- Other GIF providers.
