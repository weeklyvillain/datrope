# Personal notes

## Goal

A private notepad inside Datrope: each user keeps a list of rich-text notes that only they can see,
stored on the server and the same on web, desktop and mobile.

Decisions from brainstorming:

- Personal notepad (not notes about other users, not saved messages).
- Many titled notes per user.
- Stored server-side, synced across the user's devices.
- Rich-text editing (Tiptap), stored as ProseMirror JSON.
- Full-page view at `/notes` (mockup B), reached from a third sidebar tab; on phones from a row in
  the You page.
- Autosave, last write wins across devices; no conflict dialog.

Out of scope: sharing notes, folders/tags, pinning, attachments/images in notes, version history,
saving chat messages into notes, offline editing.

## Data

Migration `server/internal/db/migrations/00046_notes.sql` (the number may collide with other branches
adding migrations; renumber at merge):

```sql
-- +goose Up
-- Personal notes: private rich-text notes, visible only to their owner.
CREATE TABLE notes (
    id         BIGINT PRIMARY KEY,               -- snowflake; created_at is its time
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    content    JSONB NOT NULL,                    -- Tiptap/ProseMirror doc
    text       TEXT NOT NULL DEFAULT '',          -- plain text of content, for previews and search
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notes_user_idx ON notes (user_id, updated_at DESC);

-- +goose Down
DROP TABLE notes;
```

`text` is produced by the client (Tiptap `getText()`); the server stores it as given. It is the
owner's own data, so trusting it only affects their own previews and search.

## Server: `server/internal/notes`

Follows the albums domain: `notes.go` (Service, queries in raw pgx), `handlers.go` (`Register(api,
s)`), black-box tests in `notes_test.go` with `apptest`. Wired in `internal/app/app.go` next to
albums.

All operations are `httpx.Authed` and scoped to `auth.Current(ctx).User.ID`. A note owned by another
user is indistinguishable from a missing one: `404 NOT_FOUND` (`httpx.NotFound("note")`).

Types:

- `NoteSummary { id, title, preview, updated_at }` (JSON is snake_case like the rest of the API): `preview` is the first 140 runes of `text`,
  whitespace collapsed.
- `Note { id, title, content, text, created_at, updated_at }`: `content` is a free-form JSON object.

Endpoints:

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/notes?q=` | | `200 NoteSummary[]`, newest `updated_at` first. `q` (optional, trimmed, ≤100 runes) filters title or text with case-insensitive `ILIKE` (`%`, `_`, `\` escaped). |
| POST | `/api/notes` | `{ title?, content?, text? }` | `201 Note`. Missing content becomes an empty doc `{"type":"doc","content":[{"type":"paragraph"}]}`. |
| GET | `/api/notes/{noteID}` | | `200 Note` |
| PATCH | `/api/notes/{noteID}` | `{ title?, content?, text? }` | `200 Note`; bumps `updated_at`. `content` and `text` must be sent together. |
| DELETE | `/api/notes/{noteID}` | | `204` |

Validation (`400`):

- `NOTE_TITLE_TOO_LONG`: title over 100 runes (title is trimmed first).
- `NOTE_INVALID_CONTENT`: content not a JSON object with `"type": "doc"`, or `content`/`text` sent
  without the other.
- `NOTE_TOO_LARGE`: content JSON over 200 KB, or text over 200 KB.
- `NOTE_LIMIT`: creating a note when the user already has 500.

Events, published with `Scope{UserIDs: []id.ID{me}}` so every session of the owner gets them:

- `NOTE_CREATE`: `NoteSummary`
- `NOTE_UPDATE`: `Note`
- `NOTE_DELETE`: `{ id }`

## Client core

- `pnpm -C clients/core gen` regenerates `openapi.json` and `schema.d.ts`.
- `client.ts` gets `listNotes(q?)`, `createNote(body)`, `getNote(id)`, `updateNote(id, body)`,
  `deleteNote(id)`; types exported from `types.ts`.
- Notes are not part of the READY payload or the core store; the web feature loads them on demand.

## Web client

### State: `clients/web/src/app/notes/notes-store.ts`

Zustand store, feature-local (like gallery albums):

- `summaries: NoteSummary[] | null`, `notes: Record<id, Note>`, `dirty: Set<id>` (local edits not yet
  saved).
- `load()`, `open(id)`, `create()`, `save(id, patch)`, `remove(id)`.
- Subscribes to `client.onEvent`: `NOTE_CREATE` adds the summary; `NOTE_UPDATE` updates the summary
  and replaces the loaded note unless it is dirty (so the editor's in-progress text is not clobbered;
  the local save then wins); `NOTE_DELETE` removes it and, if it is open, navigates to `/notes`.
- Pure reducers are split out so they can be unit tested without React.

### Autosave

`useAutosave` hook: edits mark the note dirty and schedule a save 800 ms after the last change;
blur, route change and unmount flush immediately. Status shown in the top bar: `Saving…`, `Saved`,
or `Couldn't save` with a Retry button. A failed save keeps the note dirty.

### Sidebar

`ServerSidebar` tabs become **Channels | Messages | Notes** (`grid-cols-3`). The Notes tab is active on
`/notes/*` and selecting it navigates to `/notes`. Its pane (`NotesPane`) shows:

- a search input (debounced, calls `listNotes(q)`; clearing returns to the full list),
- the list of notes (title, or "Untitled", plus preview), the open note highlighted,
- a "New note" button: creates a note and navigates to it with the title field focused.

Narrow desktop uses the same sidebar inside the channels sheet, so it gets the tab for free.

### Route `notes/:noteId?` → `NotesView`

- No `noteId`: empty state ("Select a note or create a new one", with a New note button).
- Unknown/deleted id: "This note doesn't exist" with a link back to `/notes`.
- Note open:
  - Top bar: inline title input (placeholder "Untitled", max 100), "edited 2m ago" / save status,
    and a ⋯ dropdown with **Delete note** (AlertDialog confirm).
  - Toolbar: bold, italic, strike, heading 1, heading 2, bullet list, ordered list, task list, quote,
    inline code, code block, link. Built from shadcn `Toggle` + `Tooltip`; each button has an
    `aria-label` and pressed state.
  - Editor: Tiptap `EditorContent` with StarterKit, TaskList/TaskItem, Link (autolink, opens in new
    tab, `rel="noopener noreferrer"`), Placeholder ("Write something…"). Styles in `styles.css`
    under `.note-editor`, using tokens only. Max content width ~720px.

Shortcuts are Tiptap's defaults (Ctrl/Cmd+B, I, etc.).

### Mobile

`YouPage` gets a "Notes" row (`/notes`). `/notes` renders a pushed screen with `ScreenHeader`
("Notes", back) and the same search + list + New note; `/notes/:id` is a pushed screen with the title,
⋯ menu and editor. The toolbar scrolls horizontally on narrow widths.

### Dependencies

Tiptap v3 (`3.32.0`, exact pins in `clients/web/package.json`): `@tiptap/core`, `@tiptap/react`,
`@tiptap/pm`, `@tiptap/starter-kit` (includes Link), `@tiptap/extension-list` (TaskList/TaskItem),
`@tiptap/extensions` (Placeholder). shadcn `toggle`, `alert-dialog`, `dropdown-menu`, `input`,
`tooltip` are already in `src/components/ui/`.

## Errors and edge cases

- Note deleted on another device while open: `NOTE_DELETE` navigates away with a toast-free return to
  `/notes`.
- Save after the note was deleted elsewhere: `404` → show "This note was deleted" and drop local
  edits.
- `NOTE_TOO_LARGE`/`NOTE_LIMIT`: shown inline via the save status or the New note button's error.
- Account deletion removes notes via `ON DELETE CASCADE`.

## Testing

Go (`notes_test.go`, `apptest`):

- create/list/get/update/delete round trip; list ordered by `updated_at`.
- another user gets `404` on get/patch/delete and never sees the note in list.
- validation: long title, non-doc content, content without text, oversize content, 501st note.
- `q` search on title and text, including `%`/`_` literal.
- events: owner's socket gets `NOTE_CREATE/UPDATE/DELETE`; another user's socket gets none.

Vitest (`clients/web`):

- store reducers: create/update/delete events, dirty note not replaced by remote update.
- autosave debounce and flush (fake timers).
- preview/summary helpers.

Playwright (`clients/web/e2e/chat.spec.ts` or a new `notes.spec.ts`): open Notes tab, create a note,
type a title and text, reload, note and text persist; delete it.

Manual: verify in the browser preview (desktop and mobile widths).
