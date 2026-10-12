# Global gallery, music player and playlists

Date: 2026-10-12
Status: approved design, pending plan
Mockups: `docs/superpowers/mockups/GlobalGallery.html` (frames 1–10)

## Goal

- **Global gallery.** One place to browse every file shared in any channel you can read, not just
  one gallery channel. Your channel permissions decide what you see.
- **More than photos and videos.** Filter by Photos, Videos, Music, Documents, Archives and Other,
  and search file names and captions.
- **Music.** Play audio files in a personal, persistent player with a queue that keeps playing
  while you move around the app.
- **Playlists.** Put gallery audio into the server's existing music playlists. Play a playlist
  yourself in the gallery player, or send it to the music bot so a voice call hears it.

Out of scope: DMs in the gallery; audio tag (ID3) extraction for attachments; playing link or
search playlist items (YouTube, SoundCloud, Spotify) in the personal player; drag and drop onto
playlists; private playlists; persisting the personal queue across reloads; group-by-channel view.

## Current state

- A gallery is a channel type (`channels.TypeGallery`). There is no gallery endpoint. The web
  `GalleryView` (`clients/web/src/app/gallery/`) builds its grid from the channel's message store
  (`items.ts`: photo/video only, date sections) and pages with `client.loadOlder`.
- The server rejects gallery posts that have no attachments, or any non-image/video attachment
  (`MEDIA_ONLY`, `server/internal/messages/handlers.go:145,195-200`).
- `attachments` (`00006_files.sql`): `id, channel_id, uploader_id, message_id, filename,
  content_type (sniffed), size, sha256, width, height, ...`. There are no indexes on `channel_id`
  or `filename`. Download auth is `files.authorized`: ReadHistory on the attachment's channel,
  otherwise 404.
- `channels.Readable(ctx, user)` gives the non-thread channels plus DMs the user can read.
  `messages.readableSQL` expands them to their threads. Search uses both.
- Chat renders audio attachments with `attachments/AudioPlayer.tsx` (waveform).
- Music bot playlists (`00032_music_playlists.sql`, `server/internal/music/playlists.go`) are
  server-wide: any member lists them; the creator or someone with ManageExpressions edits them;
  creating needs AttachFiles. An item is exactly one of `track_id` (library upload), `url` (link)
  or `search` (resolved when it comes up). Limits: 100 playlists, 500 items each. Changes publish
  `MUSIC_PLAYLIST_UPDATE` / `MUSIC_PLAYLIST_DELETE`. The voice `MusicPanel` has a Playlists tab
  (`PlaylistsTab.tsx`) that plays a playlist on the bot.

## Decisions

### Scope and permissions

- The global gallery covers attachments on sent, non-deleted messages in every channel from
  `channels.Readable` except DMs, plus those channels' threads (forum posts and threads count). A
  thread's file is tagged with its parent channel.
- Playlist items that point at an attachment are filtered for each viewer. Listing a playlist
  returns only the attachment items whose channel the caller can read, plus `hidden: n`, the count
  left out.
- When someone plays a playlist on the bot, only the attachment items that the person queueing
  can read go into the queue. The rest are reported as `skipped_unreadable`. Everyone in the call
  hears what was queued. This is the same trust model as screen sharing: the person who plays it
  chooses to share it.
- Deleting an attachment's message (soft delete) hides the item from playlists. Deleting the
  attachment row removes the item (`ON DELETE CASCADE`).

### Kinds

One mapping from `content_type` (plus the `gif` flag), implemented once in SQL and once in TS:

| kind       | rule                                                                                 |
|------------|--------------------------------------------------------------------------------------|
| `image`    | `image/*`, or `gif = true`                                                           |
| `video`    | `video/*`                                                                            |
| `audio`    | `audio/*`                                                                            |
| `document` | `application/pdf`, `text/*`, `application/json`, `application/rtf`, `application/msword`, `application/vnd.openxmlformats-officedocument.*`, `application/vnd.oasis.opendocument.*`, `application/vnd.ms-excel`, `application/vnd.ms-powerpoint` |
| `archive`  | `application/zip`, `application/x-7z-compressed`, `application/x-rar-compressed`, `application/vnd.rar`, `application/x-tar`, `application/gzip`, `application/x-gzip`, `application/x-bzip2`, `application/x-xz` |
| `other`    | everything else                                                                      |

UI labels: Photos, Videos, Music, Documents, Archives, Other.

### Gallery channels accept any file

- Remove the image/video check. A gallery post still needs at least one attachment. That check
  keeps its error code `MEDIA_ONLY`, so clients don't break, but the message becomes "gallery
  posts need a file".
- The upload dialog becomes "Upload files" and accepts any file. This changes the accessible name
  used by the e2e test, which gets updated with it.

## Server

### `GET /api/files`

Lives in the `messages` package, which owns `readableSQL` and the message joins. Operation id
`list-files`. Rate limited like search.

Query:

- `kind` (repeatable): `image|video|audio|document|archive|other`. None means all kinds.
- `channel` (repeatable): channel ids. A channel the caller can't read contributes nothing; there
  is no error, so hidden channels aren't revealed. A thread id isn't accepted on its own; a parent
  channel includes its threads.
- `uploader`: user id.
- `q`: up to 100 characters. Matches `a.filename ILIKE '%' || q || '%'` (with `%`/`_` escaped) OR
  `to_tsvector('simple', m.content) @@ plainto_tsquery('simple', q)`.
- `before`: attachment id, for keyset pagination (`a.id < before`).
- `limit`: 1–100, default 50.

Response `FilesPage`:

```
{ items: [ { attachment: Attachment,
             message: { id, author_id, content, created_at },
             channel: ChannelRef,          // the parent channel for a thread
             kind: "image"|"video"|... } ],
  next_cursor?: string }
```

The order is `a.id DESC`. Attachment ids are snowflakes, so this is upload order, which is close
enough to message order for date sections. `ChannelRef` is the type search already uses.

### Migration `00037_files_gallery.sql`

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX attachments_channel_idx ON attachments (channel_id, id DESC) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_filename_trgm_idx ON attachments USING gin (filename gin_trgm_ops);
ALTER TABLE music_playlist_items
    ADD COLUMN attachment_id BIGINT REFERENCES attachments (id) ON DELETE CASCADE,
    DROP CONSTRAINT music_playlist_items_check,
    ADD CONSTRAINT music_playlist_items_source_check CHECK (num_nonnulls(track_id, url, search, attachment_id) = 1);
```

Postgres names the existing unnamed table CHECK `music_playlist_items_check`. The Down migration
reverses each step and deletes the attachment items first.

### Playlists accept attachments

- `PlaylistAdd` gains `attachment_id`. Adding needs ReadHistory on the attachment's channel (404
  otherwise, the same as download) and an `audio/*` content type (400 `NOT_AUDIO` otherwise). The
  item's title is the filename without its extension, and its duration comes from the music
  service's existing `probe(ctx, path)` (`music/library.go:135`), run on the attachment's blob
  written to a temp file (0 if that fails).
- `PlaylistItem.source` gains `"file"`, plus `attachment_id` and `channel_id` (the parent channel
  for a thread).
- `GET /api/server/music/playlists/{id}` filters the attachment items per caller as described
  above and adds `hidden` to `PlaylistDetail`. `MusicPlaylist.count` and `duration` stay as stored,
  so they can be slightly more than you see. That's acceptable.
- Bot playback: an attachment item becomes a track with `blob = attachments.sha256`,
  `opus = false`, so ffmpeg transcodes it like an "original" library file. When a playlist is
  queued, unreadable attachment items are dropped for the queuer, and the response gains
  `skipped_unreadable`. A message deleted after queueing still plays if it's already queued; it
  isn't re-checked mid-queue.
- Existing playlist endpoints keep their shapes. Fields are only added.

### Tests (apptest, real Postgres)

`/api/files`:
- a file in a channel bob can't see is absent;
- a thread file shows up, tagged with the parent channel;
- a DM file is absent;
- each kind filter, including GIF→image and docx→document;
- the channel filter, including a hidden channel id, which returns empty;
- the uploader filter;
- `q` on a filename substring and on a caption word;
- pagination across 2 pages;
- a deleted message's file is absent.

Gallery channels: an mp3 and a pdf are accepted, and a post without a file is still rejected.

Playlists:
- add an attachment, including the not-audio and unreadable cases;
- the item is hidden from a user without access, with `hidden = 1`;
- queueing on the bot skips unreadable items;
- deleting the attachment removes the item.

## Web

### Core client (`clients/core`)

- Run `pnpm gen` after the server changes.
- `client.files(params)` returns `FilesPage`.
- `client.addToPlaylist(id, { attachment_id })` uses the existing method with the new field.

### Routes and entry

- `/gallery` → `GlobalGalleryRoute`.
- A "Gallery" link (images icon) at the top of `ServerSidebar`'s channel tree. It is active on
  `/gallery`.
- Filter state lives in URL search params: `kind`, `channel` (repeated), `uploader`, `q`, plus
  `view=tracks|playlists` and `playlist=<id>` under Music.

### `GalleryView` (shared)

- Props: `scope: { kind: "global" } | { kind: "channel", channelId }`.
- `useFiles(scope, filter)` (new, `app/gallery/use-files.ts`):
  - pages through `client.files`, resetting when the filter changes;
  - debounces `q` by 250 ms;
  - when a message with attachments is created, edited or deleted in a channel in scope, it
    refetches the first page and merges by attachment id, and removes items whose message was
    deleted.
  - The merge and dedupe logic is a pure function so it can be tested.
- `kinds.ts` (new) holds the TS kind mapping and labels. It replaces `items.ts`'s
  `isMedia`/`kind`; the existing `sections()` and `itemTitle()` stay.
- Filter bar (frames 1, 3, 5):
  - search input "Search files";
  - kind chips in the `role="group" aria-label="Show"`;
  - "In channel" multi-select, global only, built from shadcn `popover` + `command`;
  - "Uploaded by";
  - item count ("N items", or "N+ items" while there are more pages).
- Grid: the same date sections. Pagination uses "Load more" plus an IntersectionObserver sentinel.
- Tiles:
  - Photos and videos stay as they are.
  - Audio is a card with a disc coloured from the attachment's sha256, the filename, and
    "duration · uploader". The duration comes from `<audio preload="metadata">`, read lazily when
    the tile is visible. A hover play button sits on the card, and the playing tile gets a ring and
    an equaliser.
  - Documents, archives and other files are cards with an extension badge, the filename and
    "size · uploader".
  - In the global view, a `#channel` tag sits top-left.
  - The aria-label is `"{Kind}: {title}, by {name}"`, with `", in #{channel}"` added in the global
    view.
- A tile "…" menu: Play, Add to queue, Add to playlist ›, Go to message, Download. The playback and
  playlist items are audio only.
- The channel scope keeps the Upload button (now "Upload files") and the read ack. The global scope
  has no Upload.
- Empty state and no-results state with "Clear filters" (frame 6).

### Music filter (frames 2a, 2b, 7, 9)

- Tracks / Playlists switch.
- Tracks:
  - a "Play all" / "Shuffle" toolbar;
  - a Grid / List toggle, with Grid as the default and the choice remembered in localStorage;
  - List is a table with #, Title, Channel, Uploaded by, Added and Length columns.
- Playlists:
  - a grid of server playlists (`useApp` playlists store, already kept live by events);
  - an "All / Mine" filter;
  - "New playlist" (reuses the voice panel's create dialog; needs AttachFiles).
- Playlist detail:
  - header with Play, Shuffle and "Play in voice · {channel}";
  - "Play in voice" is disabled with the tooltip "Join a voice channel first" when you aren't in
    voice, and uses the same call as `PlaylistsTab`'s play;
  - a track table where link and search items are greyed out with a "Voice only" tag;
  - "N tracks hidden" when `hidden > 0`.

### Details panel (frame 4)

- The side panel `media` kind gains `channelId`, so it works outside a channel.
- The panel title depends on kind: Photo, Video, Track or File details.
- Audio gets the waveform `AudioPlayer` and Play / Add to queue / Add to playlist.
- Documents get Download, and PDFs also get "Open" in a new tab.
- "in #channel" links to the message.
- Prev/next steps through the current filtered list.
- Comments (thread) behave as they do today.

### Add to playlist (frame 8)

A submenu listing the playlists the user can edit (created by them, or all of them with
ManageExpressions), searchable, with a checkmark when the file is already in a playlist. Clicking a
checked playlist removes the file again. "New playlist…" creates a playlist and adds the file.

### Personal player (frames 1, 4, 5)

- `app/player/` holds the store, the `<audio>` element and `PlayerBar`.
- Store (zustand, module-level so it survives route changes):
  - `queue: Track[]`, `index`, `playing`, `position`, `duration`, `volume`, `shuffle`,
    `repeat: off|all|one`;
  - actions: `play(tracks, startIndex)`, `enqueue`, `next`, `prev`, `seek`, `toggle`, `remove`,
    `move`, `clear`.
  - `Track = { key, title, subtitle, src, channelId?, cover }`.
- A single `<audio>` lives in `AppShell` and plays `/api/attachments/{id}`, or the library track URL
  for upload items.
- `PlayerBar`:
  - a full-width bar along the bottom of `AppShell`, shown while the queue isn't empty;
  - left: track and "#channel · uploader"; centre: shuffle, prev, play/pause, next, repeat and a
    seek bar; right: queue popover, volume and close;
  - the queue popover shows now playing, up next with remove and drag reorder, and "Clear queue".
- Playing a playlist yourself queues only its file and upload items.
- A track that fails to load (403/404 after losing access) is skipped with a toast.
- The Media Session API provides OS media keys and a now-playing title.
- Mobile layout: a compact bar with title, play/pause and next.

### Voice panel (frame 10)

`PlaylistsTab` renders `source: "file"` items with their `#channel`. After queueing, it shows a
toast "Queued N tracks · M skipped (from a channel you can't read)" when `skipped_unreadable > 0`.

### Components to fetch

shadcn `command`, `popover` (if missing) and `context-menu` or `dropdown-menu` (whichever exists).
`AGENTS.md` rules apply.

### Tests

- vitest:
  - `kinds.ts` mapping, matching the SQL table;
  - URL params ↔ filter round trip;
  - `useFiles` merge/dedupe;
  - player store: play, next and prev with repeat and shuffle, enqueue, remove, and skipping on
    error;
  - the playlist "Voice only" and hidden rendering.
- Playwright (in `e2e/chat.spec.ts`):
  - alice uploads `silentWav()` in #general and a PNG in a private channel;
  - bob opens Gallery from the sidebar and sees the wav tile "in #general" but not the private PNG;
  - he searches the filename, filters Music, plays the track, and the player bar shows it;
  - he adds it to a new playlist and the playlist detail lists it;
  - the existing gallery test is updated for "Upload files".

## Risks

- `pg_trgm` needs `CREATE EXTENSION`. It is a trusted extension on PG13+, so the database owner can
  create it. Deploy and pgtest both use `postgres:17-alpine`.
- The `ILIKE` + FTS `OR` could pick a bad plan. It's bounded by the readable-channel filter and the
  `LIMIT`. Check it with `EXPLAIN` on seeded data during implementation.
- When a playlist is opened, a per-item read check for attachment items is one query: join items
  to attachments and keep those whose `channel_id` (or parent) is in the caller's readable set.
