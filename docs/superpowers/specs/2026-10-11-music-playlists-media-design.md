# Music bot: playlists, shuffle/repeat and media handling — Design

**Status:** draft, for review. No code yet.
**Builds on:** the voice music bot (#16, `server/internal/music`, migration `00031_music.sql`) and the music tile in the call (branch `claude/music-bot-vc-card-bea8ab`).

## Decisions taken

| Question | Decision |
|---|---|
| Who owns a playlist? | **The server.** Playlists are shared like the music library. Anyone with Attach Files can create one; the creator and holders of Manage Expressions can edit or delete it. |
| What can a playlist hold? | **YouTube/link tracks and library uploads, mixed.** |
| YouTube playlists | A playlist link can be **queued directly** or **imported into a saved playlist**. |
| Playback modes | **Shuffle** and **repeat (off / all / one)**. |
| Media scope | **Storage and cache** (uploads, YouTube audio, metadata, quotas) and **more sources**. Synced video is out of scope for now. |
| Art for queue-only link tracks (A) | **Nice to have, not required.** No art until a track is saved; a thumbnail proxy may come later. |
| Caching long tracks (B) | **Don't cache them.** Tracks over 20 min and live streams are never cached. |
| Direct audio URLs (C) | **No.** Not planned. |
| Playing a playlist (D) | **Append** to the queue; **Replace queue** is offered as an option. A **Clear queue** button, behind an "Are you sure?" confirmation, is added too. |
| Permission for big playlists (E) | **None.** Anyone in the channel may queue a playlist, as with single tracks. |

## Today (what the plan changes)

- `MusicTrack` is a queue entry only: title, URL, duration, `source: youtube|upload`, requester. Nothing is saved except library uploads (`music_tracks`, content-addressed blobs, 30 MB each, 500 tracks).
- Every YouTube play runs `yt-dlp --get-url`, then ffmpeg pulls the stream live. That means a 2–5 s gap between tracks, a failure when the signed URL expires mid-track, and the same YouTube download for every repeat.
- Every upload play runs ffmpeg to transcode the original file (FLAC/MP3/...) to Opus again.
- `Resolve` passes `--no-playlist`, so a playlist link plays only its first video.
- Any URL goes to yt-dlp, including its **generic extractor**. A member can make the server fetch an arbitrary URL, including internal addresses (SSRF). This is fixed in phase 6, but it's a security issue today, so phase 6's allowlist ships early on its own as phase 0.
- The queue is FIFO, capped at 100, with no shuffle, repeat or reordering.

## 1. Shuffle, repeat and clear queue (phase 1)

**Server (`player.go`).**
- `player` gets `repeat string` (`off|all|one`).
- `next()`:
  - `one`: replays `current` (a fresh copy, position 0) instead of popping.
  - `all`: appends the finished track to the tail before popping.
  - A skip under `one` moves to the next track. Skip means "next", and repeat-one only applies when a track ends naturally. `play()` reports whether it was skipped.
- Shuffle is a **one-shot action**: it Fisher-Yates-shuffles the current queue. It is not a mode that has to remember an "unshuffled" order. This is simpler, and with a shared queue it's what people expect.
- **Clear queue** empties the queue but keeps the current track playing and the bot in the channel. That's the difference from today's **Stop**, which also ends the track and makes the bot leave.
- `MusicState` gets `repeat`.
- API:
  - `POST /api/channels/{id}/music/shuffle` (204).
  - `PUT /api/channels/{id}/music/repeat {mode}` (204).
  - `DELETE /api/channels/{id}/music/queue` (204): clear the queue.
  - All three require being in the channel, like the other controls.

**Web.**
- Music panel queue header: a **Clear queue** button, disabled when the queue is empty. It opens a shadcn `AlertDialog` ("Clear the queue?", "This removes all N tracks waiting to play. The current song keeps playing.") with **Cancel** / **Clear queue**.
- Also in the header: a **Shuffle** button, and a **Repeat** toggle that cycles off → all → one (`Toggle` with a `Repeat`/`Repeat1` icon, `aria-label="Repeat: all"`).
- Music tile: a small repeat indicator.

**Tests.** `music_test.go` table tests for `next()` under each mode, for skip under `one`, for a shuffle that keeps the same multiset, and for a clear that keeps `current`. Web: the clear confirmation (cancel keeps the queue, confirm calls the API).

## 2. Saved playlists (phase 2)

**Migration `00032_music_playlists.sql`.**

```sql
CREATE TABLE music_playlists (
    id         BIGINT PRIMARY KEY,           -- snowflake; created_at = id time
    title      TEXT NOT NULL,                -- 1–100 chars
    created_by BIGINT REFERENCES users (id) ON DELETE SET NULL
);
CREATE TABLE music_playlist_items (
    id          BIGINT PRIMARY KEY,
    playlist_id BIGINT NOT NULL REFERENCES music_playlists (id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    track_id    BIGINT REFERENCES music_tracks (id) ON DELETE CASCADE, -- an upload
    url         TEXT,                                                -- a link track
    title       TEXT NOT NULL,
    duration    INTEGER NOT NULL DEFAULT 0,
    added_by    BIGINT REFERENCES users (id) ON DELETE SET NULL,
    CHECK ((track_id IS NULL) <> (url IS NULL)),
    UNIQUE (playlist_id, position) DEFERRABLE INITIALLY DEFERRED
);
```

- Deleting a library upload removes it from playlists (cascade). The library's delete confirmation says so.
- Limits: 100 playlists per server and 500 items per playlist (constants, like `maxLibrarySize`).
- Reordering rewrites `position` for the affected range in one transaction. The deferred unique constraint makes that possible.

**API** (`playlists.go` in `music`; base permission checks through `s.member`, like the library):

| Method & path | Who | What |
|---|---|---|
| `GET /api/server/music/playlists` | members | List: id, title, created_by, item count, total duration |
| `POST /api/server/music/playlists {title, from_url?}` | Attach Files | Create. With `from_url`, import a YouTube playlist (phase 3) |
| `GET /api/server/music/playlists/{id}` | members | Playlist with items |
| `PATCH /api/server/music/playlists/{id} {title}` | owner / Manage Expressions | Rename |
| `DELETE /api/server/music/playlists/{id}` | owner / Manage Expressions | Delete |
| `POST /api/server/music/playlists/{id}/items {query? \| track_id? \| from_channel?}` | owner / ME | Add a link or search (resolved like the queue), a library track, or a channel's current queue ("save queue as playlist") |
| `PUT /api/server/music/playlists/{id}/items/{itemID}/position {position}` | owner / ME | Move |
| `DELETE /api/server/music/playlists/{id}/items/{itemID}` | owner / ME | Remove |
| `POST /api/channels/{id}/music {playlist_id, shuffle?, replace?}` | in the channel | Queue the whole playlist (extends today's queue body). It appends by default; `replace: true` clears the queue first (the current track keeps playing). |

- Gateway: `MUSIC_PLAYLIST_UPDATE` (summary) and `MUSIC_PLAYLIST_DELETE`, scoped to the server. Clients don't cache item lists. They refetch an open playlist on update.
- Queue cap: raise `maxQueue` from 100 to **500**, so a whole playlist fits. When a playlist would overflow the queue, queue what fits and return `{queued, skipped}`. The UI shows "Queued 412 tracks, 88 didn't fit".

**Web.**
- The music panel gets tabs (shadcn `Tabs`): **Queue** | **Playlists**.
- The Playlists tab lists the playlists. Each row has **Play** (appends), **Shuffle play** and a ⋯ menu (Replace queue, Rename, Delete). **Replace queue** asks first when the queue isn't empty (same `AlertDialog` as Clear queue).
- Clicking a playlist opens a detail view in the panel with:
  - the item list, reorderable by drag with dnd-kit (already a dependency) and "Move up/down" in each row's menu for keyboard users;
  - an add field (link, search or library);
  - **New playlist**, and **Save queue as playlist** from the Queue tab.
- Uses `use-submit`, `error-text` and shadcn `dropdown-menu`, `alert-dialog` for delete, `input` and `tabs`.

## 3. YouTube playlist import (phase 3)

- `Resolver` gets `ResolvePlaylist(ctx, url) (title string, tracks []Resolved, dropped int, err error)`.
  - It runs `yt-dlp --flat-playlist --dump-single-json --playlist-end 500 -- url`.
  - `--flat-playlist` lists the entries without visiting each video, so a 500-entry list takes seconds, not minutes.
  - Unavailable or private entries (no URL or title) are dropped and counted.
- Detection: the URL has a `list=` parameter, or yt-dlp returns `_type: playlist` for a link (not for a search). `watch?v=X&list=Y` means "this video". In that case the UI asks: **Play this song** / **Queue the whole playlist (N)** / **Save as playlist**.
- Queueing a playlist link from "Add a song" appends up to the queue cap, as in §2.
- Import into a saved playlist is `POST /playlists {title?, from_url}`. It defaults the title to the YouTube playlist's title.
- yt-dlp runs with a 45 s timeout today. Flat playlist listing fits in that.

## 4. Media: uploads, metadata and quotas (phase 4)

**Transcode once, at upload.**
- An upload is transcoded right away with the same ffmpeg arguments as playback (48 kHz stereo Opus, 128 kb/s, Ogg, 20 ms pages). Only the `.ogg` is stored; the original is dropped.
- Effects:
  - Playback of uploads **needs no ffmpeg**. `play()` reads the Ogg blob straight into `oggreader`. That saves a process and CPU per play and makes seeking possible later.
  - Storage drops sharply (a 30 MB FLAC becomes ~4 MB). The upload limit can go from 30 MB to **100 MB** (input), while only the small result is stored.
- Migration: existing `music_tracks` rows keep their originals and play through ffmpeg as today (new `format` column: `original|opus`). A one-off background job may convert them later. Not required.

**Metadata.**
- `music_tracks` and `music_playlist_items` gain `artist TEXT` and `cover TEXT` (blob sum, registered with `AddBlobTable` so the collector keeps it).
- Uploads: `ffprobe` tags (`title`, `artist`) prefill the title, and the embedded cover art (the attached picture stream) is extracted with ffmpeg. The image goes through `StoreImageBlob`, which cleans it.
- Link tracks: yt-dlp's `uploader`/`artist` and `thumbnail`. The server **downloads the thumbnail into the blob store** for saved playlist items, so clients never load `i.ytimg.com` (that would leak their IPs). Queue-only link tracks show no art (decision A). A proxied thumbnail is a possible later addition, not part of this phase.
- `MusicTrack` gets `artist?` and `cover?`. The music tile shows the cover as its background (dimmed with a token overlay such as `bg-card/80`), and the panel shows a small thumbnail per queue row.

**Quota.**
- Besides the 500-track count, a total library size cap: `DATROPE_MUSIC_LIBRARY_MB`, default 2048.
- `GET /api/server/music` reports used and limit bytes, and the library dialog shows the usage.

## 5. YouTube audio cache and prefetch (phase 5)

- **Prefetch.** While a track plays, the player resolves the **next** queued link track's stream URL (`Stream()`), timed for 30 s before the end, and keeps it in memory for up to 5 min. The yt-dlp gap between tracks disappears.
- **Disk cache.**
  - When a link track plays, ffmpeg's Ogg output is teed into `DataDir/music-cache/<sha256(url)>.ogg.part`, then renamed on a clean, complete end. Skipped or failed plays leave no file.
  - Later plays read the cached Ogg directly (no yt-dlp, no ffmpeg), so repeat-all and saved playlists stop re-downloading.
  - The cache is LRU by file mtime (touched on play) and capped by `DATROPE_MUSIC_CACHE_MB` (default 2048; `0` turns it off).
  - It's swept at startup and after each write.
  - It lives outside the blob store on purpose: it's disposable and not referenced from the DB.
- The cache key is the canonical page URL that yt-dlp returns (`webpage_url`), not the user's input, so `youtu.be/X` and `youtube.com/watch?v=X` share an entry.
- **Not cached** (decision B): tracks longer than 20 min (`maxCachedDuration`) or of unknown length, and live streams (`is_live`). They stream as today.

## 6. More sources (phase 6, with its first part pulled forward as phase 0)

- **Extractor allowlist (also the security fix).**
  - Every yt-dlp call passes `--use-extractors <list>`. The default is `youtube,youtube:tab,youtube:search,soundcloud,bandcamp,vimeo`, configurable with `DATROPE_MUSIC_SOURCES`.
  - The generic extractor is never allowed, so arbitrary URLs and internal addresses can't be fetched.
  - Search stays `ytsearch1`.
- **Source field.**
  - `MusicTrack.source` becomes `link|upload`, and a new `site` holds yt-dlp's `extractor_key` (`youtube`, `soundcloud`, ...) for the icon (`BrandIcon slug`).
  - This is an API change: the generated types change with the server, and the web client handles both values during the transition.
- **Spotify links** (optional, behind `DATROPE_SPOTIFY_CLIENT_ID/SECRET`).
  - Spotify has no playable audio for us. A track link resolves through the Spotify Web API (client-credentials) to "artist – title", which becomes a YouTube search.
  - Playlist and album links become a list of searches, resolved **lazily when each track comes up** so that importing a 300-track playlist doesn't run 300 searches up front. Items store the search text and resolve on first play; the resolved URL is then saved.
  - Without credentials, Spotify links answer "Spotify links aren't set up here".
- **Direct audio file URLs** (`https://…/song.mp3`): **not planned.** Supporting them safely needs our own fetcher with private-IP blocking, DNS-rebinding protection, size limits and content-type checks. Not worth it while uploads exist (decision C).

## Phases and order

| # | Phase | Size | Depends on | Migration |
|---|---|---|---|---|
| 0 | Extractor allowlist only (§6 first bullet), as a quick security fix | S | — | — |
| 1 | Shuffle, repeat and clear queue | S | — | — |
| 2 | Saved playlists (API + UI) | L | — | 00032 |
| 3 | YouTube playlist import | M | 2 | — |
| 4 | Upload transcode, metadata, cover art, quota | M | — (2 for item covers) | 00033 |
| 5 | Prefetch and YouTube audio cache | M | 4 (direct Ogg playback path) | — |
| 6 | `site` field, more extractors, Spotify | M | 0 | — |

Each phase is shippable on its own and gets its own implementation plan in `docs/superpowers/plans/` (TDD, task-by-task, staging only) when it's picked up.

## Testing

- **Go.** A fake `Resolver` (already used in `music_test.go`) gains `ResolvePlaylist`. Player mode tests are pure. Playlist CRUD, permissions, cascade on library delete and position moves are testcontainers integration tests. Cache eviction is unit-tested against a temp dir.
- **Web.** vitest + msw for the playlist tab, the repeat toggle cycle and the playlist-link prompt. Playwright: create a playlist, add a library track, play it, see it in the queue.
- Accessible names the e2e will rely on: tab "Playlists", buttons "New playlist", "Play {title}", "Shuffle play {title}", "Save queue as playlist", "Shuffle queue", "Clear queue", "Replace queue", toggle "Repeat: off|all|one".

## Open questions

None. A–E are answered in "Decisions taken".

## Implementation notes (2026-10-11)

All phases (0–6) are implemented. Where the code differs from the design above:

- **Spotify credentials** come from the existing instance settings for Connections (the same Spotify app, client-credentials flow), not from new `DATROPE_SPOTIFY_*` variables. `MusicState` has no `spotify` flag. Without credentials, Spotify links answer `MUSIC_UNAVAILABLE`.
- **Spotify search items** are resolved on each play (and while the track before ends, by the prefetch). The resolved link is written onto the queued track, but not back to the saved playlist.
- **Shuffle** is `POST /music/shuffle`, an action next to pause/resume/skip/stop. Repeat is `PUT /music/repeat {mode}`, and clearing is `DELETE /music/queue`.
- **Queueing** returns `QueueResult {tracks, skipped, dropped}` instead of one track. `POST /api/channels/{id}/music` also takes `playlist` (a link: every track of its playlist) and `replace`.
- **The library list** returns `{tracks, used_bytes, limit_bytes}`. Uploads up to 100 MB are converted to Ogg Opus (stored result capped at 60 MB, about an hour). Existing uploads keep `format = 'original'` and still play through ffmpeg.
- **Covers** are served from `GET /api/music/covers/{sum}`, only for sums referenced by a library track or playlist item. Thumbnails are downloaded only from YouTube, SoundCloud, Bandcamp, Vimeo and Spotify CDNs over HTTPS.
- **Configuration:** `DATROPE_MUSIC_SOURCES`, `DATROPE_MUSIC_CACHE_MB` and `DATROPE_MUSIC_LIBRARY_MB` (see `deploy/README.md`).
