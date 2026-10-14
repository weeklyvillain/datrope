# Gallery sources and wall redesign

Date: 2026-10-14
Status: approved design, pending plan
Mockups: `docs/superpowers/mockups/GalleryRefresh.html` (concept A, Wall, chosen; B and C rejected)

## Goal

Stop forcing a global gallery onto the server. A gallery is something an admin creates, and its
settings decide which channels it shows files from. Albums become folders inside a gallery. The
gallery view is redesigned as an edge-to-edge wall.

- **Galleries are channels.** A gallery channel always shows files posted in it, plus files from
  its sources: none (standalone), every channel, or channels the admin picks.
- **No built-in global gallery.** The `/gallery` route and the sidebar link go away. An admin who
  wants a global view creates a gallery with source "Every channel".
- **Albums live in a gallery.** An album belongs to one gallery channel and is shown there as a
  deck of its top three images.
- **Playlists stay personal.** Music remains a kind filter inside each gallery; playlists are not
  tied to galleries.

Out of scope: excluding single channels from "Every channel"; nested albums; manual reordering;
choosing an album cover; moving albums between galleries; migrating existing albums.

## Current state

- `channels` has types incl. `gallery` (`00026_channel_types.sql`); no gallery-specific columns.
  Gallery posts need at least one attachment (`messages/handlers.go`, `MEDIA_ONLY`).
- `GET /api/files` (`messages/files.go`) lists sent attachments in every channel from
  `channels.Readable`, with optional `channel`, `kind`, `uploader`, `q`, `before`, `limit`.
- Albums (`00039_albums.sql`, `server/internal/albums/`): owned by a user, `private` or `server`
  visibility, collaborators, items from any readable channel, and direct uploads stored as
  attachments with `album_id` instead of `channel_id`.
- Web: `/gallery`, `/gallery/albums`, `/gallery/albums/:albumId` routes (`router.tsx`), an
  unconditional Gallery link in `ServerSidebar.tsx`, and one `GalleryView` with `global`,
  `channel` and `album` scopes (`clients/web/src/app/gallery/`).
- Create and edit: `CreateChannelDialog.tsx` and `ChannelSettingsDialog.tsx` already have a
  type-conditional block for forum tags; server validation for that lives in
  `channels/handlers.go` (`CreateChannelRequest`, `UpdateChannelRequest`).

## Data model

Two migrations: `00041_gallery_sources.sql` (sources) and `00042_gallery_albums.sql` (albums).

`00041_gallery_sources.sql`:

- `channels.gallery_sources TEXT` with values `none`, `all`, `selected`. CHECK: not NULL exactly
  when `type = 'gallery'`. Existing gallery channels get `none`.
- `gallery_source_channels (gallery_id, channel_id)`, primary key on both, both FK to
  `channels (id) ON DELETE CASCADE`. Rows exist only while the gallery's sources are `selected`;
  switching away deletes them.

`00042_gallery_albums.sql` — albums, data loss accepted:
  - delete all rows from `album_items`, `album_members`, `albums`;
  - delete attachments with `album_id IS NOT NULL`. Their blob files are reclaimed by
    `files.Sweep`, which already removes blob files nothing references once they are 24 hours old;
  - drop `attachments_home_check`, `attachments_album_idx` and `attachments.album_id`; set
    `attachments.channel_id` back to NOT NULL;
  - add `albums.gallery_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE` with an
    index;
  - change the visibility CHECK to `('private', 'gallery')`, default `gallery`.
- Down migration restores the `00039` shape (empty albums) and drops the new column and table.

## Source rules

- Eligible source channels: types `text`, `voice`, `webhook`, `announcement`, `forum`, `gallery`.
  Never DMs, `welcome`, threads (they come in through their parent) or the gallery itself.
- `all` is live: channels created later are included automatically. It includes other galleries.
- `selected` is a fixed list. A deleted channel drops out via the FK cascade.
- A gallery's scope for a viewer is
  `Readable(viewer) ∩ ({gallery} ∪ sources)`, plus threads whose parent is in that set.
  A source never grants access to a channel the viewer can't read.
- Setting sources needs ManageChannels, at create and on edit.

## API

- `CreateChannelRequest` and `UpdateChannelRequest` gain `gallery_sources` and
  `source_channel_ids`. Validation follows the forum-tags pattern: rejected for non-gallery types;
  `source_channel_ids` required (non-empty) for `selected` and rejected otherwise; every id must
  exist and be eligible. `gallery_sources` defaults to `none` on create.
- The channel payload (`Channel` struct and core types) carries `gallery_sources` and
  `source_channel_ids` for gallery channels. The existing `channel.update` event carries them.
- `GET /api/files`: new `gallery=<id>` parameter scoping to the gallery's scope above. `channel=`
  narrows inside that scope. A request with neither `gallery` nor `channel` returns 400 (the global
  scope is removed). A gallery the viewer can't see returns 404.
- Albums:
  - `GET /api/channels/{id}/albums` lists albums in a gallery the viewer can see: all `gallery`
    albums plus `private` albums the viewer owns or collaborates on. Each includes title, count,
    `gallery_id` and `deck`: the three newest image attachments in scope (replaces `cover`).
  - `GET /api/albums?contains=<attachmentID>` (contains required) lists the albums the caller can
    edit whose gallery's scope holds that file, each with `contains`. It backs "Add to album".
  - `POST /api/channels/{id}/albums` creates one; needs ViewChannel on the gallery.
  - `GET`, `PATCH`, `DELETE /api/albums/{id}` and the member endpoints stay, with permission
    checks also requiring the viewer can see the album's gallery.
  - `GET /api/albums/{id}/files` returns items whose attachment is in the gallery's *current*
    scope for the viewer. Removing a source hides those items; it doesn't delete them.
  - `PUT /api/albums/{id}/files/{attachmentID}` requires the attachment to be in the gallery's
    scope for the caller.
  - Upload into an album: the client posts a normal message in the gallery channel with the files,
    then adds them to the album. `?album_id=` on the upload handler is removed.
- Album realtime events are published to the gallery channel's viewers instead of the server.

## UI

All visual details follow concept A in the mockup and the tokens in `clients/web/src/styles.css`.

**Gallery view (wall)**

- Thin topbar: gallery name, source summary ("from all channels", "posts here + 2 channels",
  nothing for standalone), item count, Search, Upload.
- Album deck row above the wall: each album as three fanned thumbnails with title, count and a
  lock for private albums; "+ New album" at the end. Scrolls horizontally. With no albums only the
  "+ New album" slot shows.
- Justified rows: items keep their aspect ratio (from `width`/`height`), fill the row edge to edge
  with 4px gutters, grouped in date sections. Items from another channel show a `#channel` pill;
  videos the existing video badge. Audio, documents and other files use fixed-ratio tiles in the same rows
  with the existing disc/extension styling.
- Floating filter pill at the bottom: kind chips (All, Images, Video, Music, Files), Channel ▾
  (only when the gallery has sources) and Person ▾. Music still switches to `MusicView`.
- Clicking an item opens a full-screen lightbox with prev/next through the filtered list; the
  comment thread slides in from the right. This replaces the media side panel for galleries.
- Clicking a deck opens the album as the same wall with a breadcrumb (`gallery / album`); Upload
  there posts into the gallery and files into the album.
- Mobile: same wall; the filter pill opens the existing filter bottom sheet; the deck row scrolls.

**Source picker** (Create channel with type Gallery, and Channel Settings → General for galleries)

- Three radio cards under "Show files from": "Only this gallery", "Every channel" ("New channels
  join automatically"), "Channels I pick".
- "Channels I pick" expands a checklist of eligible channels grouped by category.
- Note under the cards: "People only see files from channels they can read."

**Removals and fixes**

- Remove the `/gallery*` routes, the sidebar Gallery link and the `global` scope.
- "Add to album" from chat and tiles lists albums (labelled with their gallery) whose gallery's
  scope contains the file. "New album" leaves these menus: albums are made from a gallery's deck row.
- Music → Playlists is shown in every gallery's Music view (playlists are personal; same list
  everywhere). On phones the segment switch is Files / Music.
- Fix stale copy: the create-dialog gallery hint and `channel-types.ts` description say any file,
  not only photos and videos.

## Error handling

- Invalid sources on create/update: 400 with a field error shown under the picker.
- Adding a file outside the gallery's scope to an album: 400 `NOT_IN_GALLERY`.
- Gallery deleted while open: existing channel-delete handling navigates away; its albums go with
  it via cascade.
- Source removed while viewing: the next fetch reflects it; no live re-filtering needed.

## Testing

- Server: unit/integration tests for source validation (each type, ineligible ids, self, DMs),
  scope computation (`none`, `all` incl. new channel, `selected`, unreadable source hidden,
  threads), album visibility and the `NOT_IN_GALLERY` rule, and the migration up/down.
- Web unit: justified-row layout function (row widths, last row, missing dimensions).
- E2E (`clients/web/e2e/chat.spec.ts`): replace the global-gallery test with: create a gallery
  with "Every channel", see a file from #general, a file from a private channel stays hidden for
  a user without access; switch to "Channels I pick"; create an album, add a file, see the deck;
  private album hidden from another user.
