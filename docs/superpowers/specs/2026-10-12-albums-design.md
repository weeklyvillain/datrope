# Albums

Date: 2026-10-12
Status: approved design, pending plan
Mockups: shown in chat on 2026-10-12 (four frames: Albums view, open album, Add to album, album settings)

## Goal

Personal photo albums inside the gallery, such as "Lofoten trip 2026" next to the overall gallery.

- **Curated.** An album picks files from any channel you can read. The same file can be in several
  albums, and it stays in its channel.
- **Direct uploads.** You can also upload straight into an album (dump 200 trip photos) without
  posting them in a channel.
- **Personal and shareable.** An album belongs to the person who made it. It is private (owner and
  collaborators) or visible to everyone on the server. The owner picks collaborators, who can add
  and remove files.

Out of scope: reordering items by hand; choosing a cover (the cover is the newest image); captions
or comments on album uploads; DM files in albums; moving an album upload to another album or
channel; sharing outside the server; nested albums.

## Current state

- `attachments` (`00006_files.sql`): every row has a `channel_id` (NOT NULL). `message_id` is NULL
  until the file is sent; `files.Sweep` deletes rows still unsent after 24 hours.
- Upload: `POST /api/attachments?channel_id=<id>` (`files/handlers.go`), limit from
  `files.UploadLimit(ctx, user, channel)`.
- Download auth: `files.authorized`. Your own unsent upload, or ReadHistory on the attachment's
  channel; otherwise 404.
- Global gallery: `GET /api/files` (`messages/files.go`) lists sent attachments in channels from
  `channels.Readable`, joined to `messages` and `channels`. The web `GalleryView`
  (`clients/web/src/app/gallery/`) renders it with `FileTile`, `FileMenu`, the media side panel
  and date sections.
- Events go out through `events.Bus.Publish` to a community, a channel's viewers, or a list of
  users.

## Data model

Migration `00039_albums.sql` (after `00038_audit_log.sql`):

```sql
CREATE TABLE albums (
    id         BIGINT PRIMARY KEY,                -- snowflake; created_at is its time
    owner_id   BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,                     -- 1-100 characters
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'server')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX albums_owner_idx ON albums (owner_id);

CREATE TABLE album_members (                      -- collaborators; the owner is not listed
    album_id BIGINT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    user_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (album_id, user_id)
);
CREATE INDEX album_members_user_idx ON album_members (user_id);

ALTER TABLE attachments
    ALTER COLUMN channel_id DROP NOT NULL,
    ADD COLUMN album_id BIGINT REFERENCES albums (id) ON DELETE CASCADE,
    ADD CONSTRAINT attachments_home_check CHECK ((channel_id IS NULL) <> (album_id IS NULL));
CREATE INDEX attachments_album_idx ON attachments (album_id) WHERE album_id IS NOT NULL;

CREATE TABLE album_items (
    album_id      BIGINT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    attachment_id BIGINT NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
    added_by      BIGINT REFERENCES users (id) ON DELETE SET NULL,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (album_id, attachment_id)
);
CREATE INDEX album_items_attachment_idx ON album_items (attachment_id);
```

- An attachment's home is a channel or an album, never both. An album upload has `album_id` set,
  `channel_id` NULL and `message_id` NULL, and also has an `album_items` row in its own album.
- Deleting a message deletes its attachments (existing cascade), which removes them from every
  album. Deleting an album deletes its uploads (cascade on `album_id`). Their blobs are removed by
  `removeIfUnused` right away, or by the sweep's unreferenced-blob pass.
- `files.Sweep` deletes unsent uploads with `message_id IS NULL AND album_id IS NULL`, so album
  uploads are never swept.
- `files.Attachment.ChannelID` becomes `*id.ID` (JSON `channel_id`, nullable) and gains `AlbumID`
  (`album_id`, nullable). Code that reads `ChannelID` (download auth, variants, `UploadLimit`
  callers) is checked. Queries that inner-join `channels` on `a.channel_id` (gallery, search)
  already leave album uploads out.

Limits: 100 albums per owner, 5,000 items per album, 25 collaborators per album.

## Access rules

All checks require server membership (as `channels.Readable` does). A person removed from the
server loses access even if they are still listed as a collaborator.

| Action | Who |
|---|---|
| See an album, list its items | Owner, collaborators, and everyone on the server when `visibility = 'server'` |
| Add a channel file, upload, remove an item | Owner and collaborators |
| Rename, change visibility, add or remove collaborators, delete | Owner |
| Delete a server-visible album | Also anyone with ManageMessages (moderation; written to the audit log) |
| Leave an album | A collaborator removes themselves |

- **Channel files in an album** are shown to a viewer only if the viewer can read that channel
  (ViewChannel and ReadHistory, as `/api/files`). The album still counts them; the viewer just
  doesn't get them.
- **Adding a channel file** requires that the adder can read it, that it is sent (`message_id` set)
  and that its channel is not a DM. Otherwise `404 attachment`.
- **Album uploads** need AttachFiles at the server level (the @everyone and role permissions,
  without channel overrides). The size limit is the server's default upload limit.
- **Download** (`files.authorized`): an attachment with `album_id` is served to anyone who can see
  that album; otherwise the existing rules apply. Failures stay 404.
- **Removing an album upload** from its album deletes the attachment, since that album is its only
  home. Removing a channel file only deletes the `album_items` row.

## API

All under `/api`, registered with huma like `messages/files.go`.

| Method and path | Body / query | Returns |
|---|---|---|
| `GET /albums` | `contains=<attachmentID>` (optional) | Albums I can see: `id, title, visibility, owner, members, item_count, cover (attachment or null), role ("owner" / "collaborator" / "viewer"), contains (when asked)` |
| `POST /albums` | `{title, visibility}` | The album |
| `GET /albums/{albumID}` | | The album |
| `PATCH /albums/{albumID}` | `{title?, visibility?}` | The album |
| `DELETE /albums/{albumID}` | | 204 |
| `PUT /albums/{albumID}/members/{userID}` | | 204 (the user must be a server member) |
| `DELETE /albums/{albumID}/members/{userID}` | | 204 (owner, or the user themselves) |
| `GET /albums/{albumID}/files` | `kind, q, uploader, before, limit` (as `/api/files`) | `FilesPage`. For album uploads, `message` and `channel` are null |
| `PUT /albums/{albumID}/files/{attachmentID}` | | 204 (idempotent) |
| `DELETE /albums/{albumID}/files/{attachmentID}` | | 204 |
| `POST /attachments?album_id=<id>` | multipart `file` | The attachment, already in the album |

- `item_count` counts every item; `cover` is the newest image item the caller can see.
- Album files are ordered by attachment ID, newest first (upload time), so the gallery's date
  sections still work. `FileItem.message` and `FileItem.channel` become optional in the OpenAPI
  schema; `/api/files` still always fills them. `FileItem` gains `uploader_id` and `created_at`
  (the upload time), which clients use for authors and date sections instead of the message.
- `q` matches file names, and captions for channel files.
- Rate limits: album files use the `searchLimit` bucket like `/api/files`; uploads use the
  existing upload limits.
- The `@datrope/core` client gains `albums()`, `album()`, `createAlbum()`, `updateAlbum()`,
  `deleteAlbum()`, `addAlbumMember()`, `removeAlbumMember()`, `albumFiles()`, `addToAlbum()`,
  `removeFromAlbum()`, and `uploadToAlbum()`. Types come from the regenerated `openapi.json`.

## Events

| Event | Payload | Sent to |
|---|---|---|
| `ALBUM_UPDATE` | the album (without `role`/`contains`) | Its audience |
| `ALBUM_DELETE` | `{id}` | Its audience |
| `ALBUM_ITEMS_UPDATE` | `{album_id}` | Its audience; clients refetch the first page, like the gallery does today |

The audience is the community when `visibility = 'server'`; otherwise the owner and collaborators.
When an album turns private, `ALBUM_DELETE` goes to the community first and `ALBUM_UPDATE` to the
new audience. A removed collaborator gets `ALBUM_DELETE` unless the album is server-visible.

## Web client

- **Gallery switch.** The global gallery's top bar gets **All files | Albums** (Toggle chips like
  the kind filter). Routes: `/gallery` (unchanged), `/gallery/albums`,
  `/gallery/albums/:albumId`.
- **Albums view** (`gallery/AlbumsView.tsx`). A grid of album cards (cover, title, visibility
  icon, owner and collaborator count, item count) in two sections: "Yours" (owner or
  collaborator) and "On the server". A **New album** button opens `AlbumDialog`.
- **Album view** (`gallery/AlbumView.tsx`). Reuses `GalleryView`'s grid, kind chips, search,
  uploader filter, infinite scroll and media side panel through a new scope
  `{ kind: "album"; albumId }` in `use-files.ts`, fetched from `albumFiles`. The top bar shows a
  back arrow, title, visibility, collaborator avatars, **Upload** (owner and collaborators) and
  **Settings** (owner) or **Leave** (collaborator). For a viewer the album is read-only.
- **Tile menu** (`FileMenu`). **Add to album** opens a checklist of albums I own or collaborate
  on (`GET /albums?contains=`), with **New album** at the bottom. In an album the menu adds
  **Remove from album** (owner and collaborators) and keeps **Jump to message** for channel
  files only. Album uploads have no message, so the side panel shows file, uploader and date
  without thread or reply actions.
- **Messages.** Chat has no per-attachment menu, so a message with files gets **Add to album** in
  its right-click menu: a submenu of my albums, adding all of the message's files to the one picked.
- **AlbumDialog** (create and settings). Name; **Who can see it**: "Only collaborators" or
  "Everyone on the server" (shadcn RadioGroup); collaborators, picked from server members; and,
  in settings, **Delete album** with a confirmation that says the album's direct uploads are
  deleted too.
- **Upload.** `UploadDialog` takes an album target and calls `uploadToAlbum` per file, several
  at a time with progress, as it does for channels.
- Built from shadcn primitives already in `src/components/ui/`; new ones (radio-group, command
  for the member picker if missing) are fetched with the shadcn CLI. Accessible names: "Albums",
  "New album", "Add to album", "Remove from album", "Album settings", "Who can see it".

## Errors

- Unknown album, or one you can't see: `404 album`. Editing without rights: `403 MISSING_PERMISSION`
  (the codebase's existing code).
- Over a limit, following `PLAYLISTS_FULL`: `400 ALBUMS_FULL` ("you have the most albums you can
  have (100)"), `400 ALBUM_FULL` (5,000 items) or `400 COLLABORATORS_FULL` (25).
- Adding a file you can't read, an unsent file or a DM file: `404 attachment`.
- Adding a file already in the album: 204 (no change, no event).
- The web client shows these with `ErrorText`; a failed upload in a batch is listed and the rest
  continue.

## Testing

- **Server** (`apptest`, real Postgres):
  - Access rules from the table: owner, collaborator, viewer of a server album, non-member of a
    private album (404), a collaborator removed from the server.
  - Channel files filtered per viewer by channel access (private channel file hidden from bob,
    shown to alice).
  - Album upload: download allowed for album viewers, 404 otherwise; never in `/api/files` or
    search; not swept after 24 hours; deleted when removed from its album and when the album is
    deleted.
  - Message delete removes the file from albums; DM and unsent files can't be added.
  - Limits, events with their audiences, the visibility switch, the ManageMessages delete and its
    audit entry.
- **Web** (vitest): `use-files` album scope params; album card grouping into Yours / On the
  server; FileMenu items per role.
- **E2E** (Playwright): create an album, add a #general file from the gallery, upload a file into
  the album, and check a second user sees it after the album is made server-visible.
