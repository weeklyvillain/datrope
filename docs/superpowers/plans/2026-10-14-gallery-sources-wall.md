# Gallery Sources and Wall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Galleries become channels with configurable sources (none / all / selected), the built-in global gallery goes away, albums become folders inside one gallery, and the gallery view becomes a justified wall with album decks, a floating filter pill and a full-screen lightbox.

**Architecture:** The server stores a gallery's sources on `channels` plus a join table, and `channels.GalleryScope` computes "channels whose files this gallery shows this viewer". `GET /api/files?gallery=` and every album query go through that scope. Albums get a `gallery_id`; album-direct uploads are removed from the files package. The web client drops the `/gallery` routes and the `global` scope, adds a source picker to the channel dialogs, and rebuilds `GalleryView` as a wall.

**Tech Stack:** Go 1.25, huma v2, pgx v5, goose SQL migrations, Postgres 17 (tests via testcontainers, needs Docker). React 18, TypeScript, Tailwind v4, shadcn/ui (Radix), vitest, Playwright. OpenAPI types generated into `clients/core/src/schema.d.ts`.

**Spec:** `docs/superpowers/specs/2026-10-14-gallery-sources-wall-design.md` (mockup: `docs/superpowers/mockups/GalleryRefresh.html`, concept A).

## Global Constraints

- Never commit. AGENTS.md: "Never commit. The user always makes commits." Each task ends with **stage** (`git add`) and a suggested message; the user commits.
- Prefix shell commands with `rtk` (user CLAUDE.md), e.g. `rtk go -C server test ./internal/channels/...`.
- Source values are exactly `none`, `all`, `selected`. Album visibility values are exactly `private`, `gallery`.
- Eligible source channel types: `text`, `voice`, `webhook`, `announcement`, `forum`, `gallery`. Never `dm`, `welcome`, `thread`, or the gallery itself.
- "A source never grants access to a channel the viewer can't read."
- Error codes: `NOT_IN_GALLERY` (400, file outside album's gallery), `SCOPE_REQUIRED` (400, `/api/files` without `gallery` or `channel`), `NOT_A_GALLERY` (400), validation errors use `VALIDATION_FAILED`.
- Web: dark-only, token colours only (`bg-card`, `text-muted-foreground`, …), no `dark:` classes, `cn()` from `@/lib/utils`, imports via `@/`. `Button` defaults to `type="button"`.
- Keep accessible names that e2e uses: "Search files", group "Show", "Upload", "Upload files", "Choose files", "Caption", "Previous item", "Next item", "Close details", region "Comments", label "Comment", "Play all", "More for <file>", "Add to album", "Album settings", "New album".
- UI copy for the source picker, verbatim: group label "Show files from"; cards "Only this gallery" / "Just what people post here.", "Every channel" / "Plus posts here. New channels join automatically.", "Channels I pick" / "Plus posts here."; note "People only see files from channels they can read."
- Checks before finishing: `rtk go -C server test ./...`, `rtk pnpm typecheck`, `rtk pnpm lint`, `rtk pnpm test`, and the web e2e suite (`rtk pnpm --filter @datrope/web e2e`, needs the e2e stack).

## Review Focus

1. **Gallery whose own channel the viewer can see but not read history in** — own posts must be hidden while sources still show (scope built from `readableServer`, not from `Access`). Test in Task 2.
2. **A selected source channel deleted** — the FK cascade empties the list; the gallery keeps `selected` with no rows and shows only its own posts, no 500. Test in Task 1.
3. **Switching `selected` → `all` → `selected` without ids** — the second switch must fail validation ("pick at least one channel"), not silently keep the stale list. Test in Task 1.
4. **Album item whose source was removed later** — hidden from album files and from the deck, `item_count` still counts it, no 500. Test in Task 3.
5. **Image without width/height in the wall** (old attachments, GIF variants) — `justify` treats it as 1:1, never divides by zero. Test in Task 7.

---

### Task 1: Gallery sources on channels (migration, model, create/update, audit)

**Files:**
- Create: `server/internal/db/migrations/00041_gallery_sources.sql`
- Create: `server/internal/channels/gallery.go`
- Create: `server/internal/channels/gallery_test.go`
- Modify: `server/internal/channels/channels.go` (Channel struct, `channelCols`, `scanChannel`, `query`, `ListDMs`)
- Modify: `server/internal/channels/handlers.go` (`CreateChannelRequest`, `UpdateChannelRequest`, create + update handlers)
- Modify: `server/internal/channels/audit.go` (`channelChanges`)
- Modify: `server/internal/apptest/apptest.go` (add `CreateGallery`)

**Interfaces:**
- Produces: `channels.SourcesNone/SourcesAll/SourcesSelected` string consts; `Channel.GallerySources string` (json `gallery_sources`), `Channel.SourceChannelIDs []id.ID` (json `source_channel_ids`); `(*apptest.Client).CreateGallery(name, sources string, sourceIDs ...id.ID) id.ID`.

- [ ] **Step 1: Write the migration**

`server/internal/db/migrations/00041_gallery_sources.sql`:

```sql
-- +goose Up
-- A gallery shows its own posts plus files from its sources: no other channel, every channel, or a
-- picked list (spec: gallery sources and wall).
ALTER TABLE channels ADD COLUMN gallery_sources TEXT CHECK (gallery_sources IN ('none', 'all', 'selected'));
UPDATE channels SET gallery_sources = 'none' WHERE type = 'gallery';
ALTER TABLE channels ADD CONSTRAINT channels_gallery_sources_set CHECK ((type = 'gallery') = (gallery_sources IS NOT NULL));

-- Rows exist only while the gallery's sources are 'selected'.
CREATE TABLE gallery_source_channels (
    gallery_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    PRIMARY KEY (gallery_id, channel_id),
    CHECK (gallery_id <> channel_id)
);
CREATE INDEX gallery_source_channels_channel_idx ON gallery_source_channels (channel_id);

-- +goose Down
DROP TABLE gallery_source_channels;
ALTER TABLE channels DROP CONSTRAINT channels_gallery_sources_set, DROP COLUMN gallery_sources;
```

- [ ] **Step 2: Add the apptest helper**

In `server/internal/apptest/apptest.go`, after `CreatePrivateChannel`:

```go
// CreateGallery creates a gallery channel with sources none, all or selected (then sourceIDs);
// "" leaves the server default.
func (c *Client) CreateGallery(name, sources string, sourceIDs ...id.ID) id.ID {
	c.env.T.Helper()
	body := map[string]any{"name": name, "type": "gallery"}
	if sources != "" {
		body["gallery_sources"] = sources
	}
	if len(sourceIDs) > 0 {
		body["source_channel_ids"] = sourceIDs
	}
	var ch channels.Channel
	c.Do(http.MethodPost, "/api/server/channels", body, http.StatusCreated, &ch)
	return ch.ID
}
```

- [ ] **Step 3: Write the failing tests**

`server/internal/channels/gallery_test.go`:

```go
package channels_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
)

func getChannel(t *testing.T, c *apptest.Client, chID id.ID) channels.Channel {
	t.Helper()
	var ch channels.Channel
	c.Do(http.MethodGet, "/api/channels/"+chID.String(), nil, http.StatusOK, &ch)
	return ch
}

func TestGallerySourcesCreate(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	memes := alice.CreateTextChannel("memes")
	base := "/api/server/channels"

	plain := getChannel(t, alice, alice.CreateGallery("photos", ""))
	require.Equal(t, channels.SourcesNone, plain.GallerySources, "galleries default to their own posts only")
	require.Empty(t, plain.SourceChannelIDs)

	all := getChannel(t, alice, alice.CreateGallery("everything", "all"))
	require.Equal(t, channels.SourcesAll, all.GallerySources)

	picked := getChannel(t, alice, alice.CreateGallery("picked", "selected", memes, general, memes))
	require.Equal(t, channels.SourcesSelected, picked.GallerySources)
	require.ElementsMatch(t, []id.ID{general, memes}, picked.SourceChannelIDs, "duplicates collapse")

	text := getChannel(t, alice, general)
	require.Empty(t, text.GallerySources, "only galleries have sources")

	welcome := alice.Channels()[0].ID
	d := alice.OpenDM(env.Register("bob").User.ID)
	for _, body := range []map[string]any{
		{"name": "x", "type": "text", "gallery_sources": "all"},                                                     // sources on text
		{"name": "x", "type": "gallery", "gallery_sources": "all", "source_channel_ids": []id.ID{general}},          // ids without selected
		{"name": "x", "type": "gallery", "gallery_sources": "selected"},                                             // selected without ids
		{"name": "x", "type": "gallery", "gallery_sources": "selected", "source_channel_ids": []id.ID{welcome}},     // welcome
		{"name": "x", "type": "gallery", "gallery_sources": "selected", "source_channel_ids": []id.ID{d}},           // a DM
		{"name": "x", "type": "gallery", "gallery_sources": "selected", "source_channel_ids": []id.ID{id.New()}},    // unknown
		{"name": "x", "type": "gallery", "gallery_sources": "some"},                                                 // bad mode
	} {
		alice.Fail(http.MethodPost, base, body, http.StatusBadRequest, "VALIDATION_FAILED")
	}
}

func TestGallerySourcesUpdate(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	memes := alice.CreateTextChannel("memes")
	g := alice.CreateGallery("photos", "")
	path := "/api/channels/" + g.String()

	var got channels.Channel
	alice.Do(http.MethodPatch, path, map[string]any{"gallery_sources": "selected", "source_channel_ids": []id.ID{memes}}, http.StatusOK, &got)
	require.Equal(t, []id.ID{memes}, got.SourceChannelIDs)

	// Changing only the ids keeps the mode.
	alice.Do(http.MethodPatch, path, map[string]any{"source_channel_ids": []id.ID{general}}, http.StatusOK, &got)
	require.Equal(t, channels.SourcesSelected, got.GallerySources)
	require.Equal(t, []id.ID{general}, got.SourceChannelIDs)

	// Switching to all drops the list; switching back needs a fresh one.
	alice.Do(http.MethodPatch, path, map[string]any{"gallery_sources": "all"}, http.StatusOK, &got)
	require.Empty(t, got.SourceChannelIDs)
	alice.Fail(http.MethodPatch, path, map[string]any{"gallery_sources": "selected"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPatch, path, map[string]any{"source_channel_ids": []id.ID{g}}, http.StatusBadRequest, "VALIDATION_FAILED")

	alice.Fail(http.MethodPatch, "/api/channels/"+general.String(), map[string]any{"gallery_sources": "all"}, http.StatusBadRequest, "VALIDATION_FAILED")
	bob.Fail(http.MethodPatch, path, map[string]any{"gallery_sources": "none"}, http.StatusForbidden, "MISSING_PERMISSION")

	// The change is in the audit log.
	var log struct {
		Entries []struct {
			Action  string `json:"action"`
			Changes []struct {
				Field string `json:"field"`
			} `json:"changes"`
		} `json:"entries"`
	}
	alice.Do(http.MethodGet, "/api/server/audit-log", nil, http.StatusOK, &log)
	require.Equal(t, "channel.update", log.Entries[0].Action)
	require.Equal(t, "gallery_sources", log.Entries[0].Changes[0].Field)
}

func TestGallerySourceDeleted(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	memes := alice.CreateTextChannel("memes")
	g := alice.CreateGallery("photos", "selected", memes)
	alice.Do(http.MethodDelete, "/api/channels/"+memes.String(), nil, http.StatusNoContent, nil)
	got := getChannel(t, alice, g)
	require.Equal(t, channels.SourcesSelected, got.GallerySources)
	require.Empty(t, got.SourceChannelIDs)
}
```

Note on `audit-log` entries: check the JSON field names in `server/internal/audit/audit.go` (`LogChange` has `Field`, `Old`, `New`); adjust the struct tags if they differ.

- [ ] **Step 4: Run tests to verify they fail**

Run: `rtk go -C server test ./internal/channels/ -run 'TestGallerySource' -v`
Expected: FAIL to compile (`channels.SourcesNone` undefined, `GallerySources` field missing).

- [ ] **Step 5: Implement `gallery.go`**

`server/internal/channels/gallery.go`:

```go
package channels

import (
	"context"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// A gallery's sources: which other channels' files it shows besides its own posts.
const (
	SourcesNone     = "none"
	SourcesAll      = "all"
	SourcesSelected = "selected"
)

const maxSources = 100

// sourceTypes are the channel types a gallery can show files from.
var sourceTypes = map[string]bool{TypeText: true, TypeVoice: true, TypeWebhook: true, TypeAnnouncement: true, TypeForum: true, TypeGallery: true}

func errOnlyGalleries() error {
	return httpx.BadRequest("VALIDATION_FAILED", "only galleries have sources")
}

// checkSources validates a gallery's sources and returns its source list, deduplicated (empty
// unless mode is selected). galleryID may not be a source of itself.
func checkSources(ctx context.Context, tx pgx.Tx, communityID, galleryID id.ID, mode string, ids []id.ID) ([]id.ID, error) {
	switch mode {
	case SourcesNone, SourcesAll:
		if len(ids) > 0 {
			return nil, httpx.BadRequest("VALIDATION_FAILED", "source_channel_ids go only with gallery_sources selected")
		}
		return []id.ID{}, nil
	case SourcesSelected:
	default:
		return nil, httpx.BadRequest("VALIDATION_FAILED", "gallery_sources must be none, all or selected")
	}
	uniq := slices.Compact(slices.Sorted(slices.Values(ids)))
	if len(uniq) == 0 {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "pick at least one channel to show files from")
	}
	if len(uniq) > maxSources {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "a gallery can show files from at most 100 channels")
	}
	rows, err := tx.Query(ctx, `SELECT id, type FROM channels WHERE community_id = $1 AND id = ANY($2)`, communityID, id.Int64s(uniq))
	if err != nil {
		return nil, err
	}
	types := map[id.ID]string{}
	for rows.Next() {
		var cid id.ID
		var t string
		if err := rows.Scan(&cid, &t); err != nil {
			rows.Close()
			return nil, err
		}
		types[cid] = t
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range uniq {
		if t, ok := types[c]; !ok || c == galleryID || !sourceTypes[t] {
			return nil, httpx.BadRequest("VALIDATION_FAILED", "a gallery can't show files from channel "+c.String())
		}
	}
	return uniq, nil
}

// setSources stores a gallery's mode and replaces its source list.
func setSources(ctx context.Context, tx pgx.Tx, galleryID id.ID, mode string, ids []id.ID) error {
	if _, err := tx.Exec(ctx, `UPDATE channels SET gallery_sources = $2 WHERE id = $1`, galleryID, mode); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM gallery_source_channels WHERE gallery_id = $1`, galleryID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO gallery_source_channels (gallery_id, channel_id) SELECT $1, unnest($2::bigint[])`,
		galleryID, id.Int64s(ids))
	return err
}

// updateSources validates and stores a gallery's new sources in one transaction.
func (s *Service) updateSources(ctx context.Context, g *Channel, mode string, ids []id.ID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	checked, err := checkSources(ctx, tx, *g.CommunityID, g.ID, mode, ids)
	if err != nil {
		return err
	}
	if err := setSources(ctx, tx, g.ID, mode, checked); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// loadSources fills SourceChannelIDs for galleries with selected sources.
func (s *Service) loadSources(ctx context.Context, chs []*Channel) error {
	byID := map[id.ID]*Channel{}
	var ids []id.ID
	for _, c := range chs {
		if c.Type == TypeGallery && c.GallerySources == SourcesSelected {
			byID[c.ID] = c
			ids = append(ids, c.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT gallery_id, channel_id FROM gallery_source_channels WHERE gallery_id = ANY($1) ORDER BY channel_id`,
		id.Int64s(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var g, c id.ID
		if err := rows.Scan(&g, &c); err != nil {
			return err
		}
		byID[g].SourceChannelIDs = append(byID[g].SourceChannelIDs, c)
	}
	return rows.Err()
}

func idList(ids []id.ID) string {
	out := make([]string, len(ids))
	for i, v := range ids {
		out[i] = v.String()
	}
	return strings.Join(out, ", ")
}
```

Add `"strings"` to the imports.

- [ ] **Step 6: Wire the model in `channels.go`**

In the `Channel` struct, after `CreatedBy`:

```go
	GallerySources   string  `json:"gallery_sources,omitempty" enum:"none,all,selected" doc:"Galleries only: which other channels' files it shows besides its own posts"`
	SourceChannelIDs []id.ID `json:"source_channel_ids,omitempty" doc:"Galleries with gallery_sources selected: those channels"`
```

Replace `channelCols` and `scanChannel`:

```go
const channelCols = `id, community_id, type, name, position, category_id, topic, parent_channel_id, parent_message_id, tags, require_tag, created_by, dm_group, gallery_sources`

func scanChannel(row pgx.Row) (*Channel, error) {
	var c Channel
	var cid, catID, parentCh, parentMsg, createdBy *int64
	var sources *string
	if err := row.Scan(&c.ID, &cid, &c.Type, &c.Name, &c.Position, &catID, &c.Topic, &parentCh, &parentMsg, &c.Tags, &c.RequireTag, &createdBy, &c.Group, &sources); err != nil {
		return nil, err
	}
	c.CommunityID = id.FromNullable(cid)
	c.CategoryID = id.FromNullable(catID)
	c.ParentChannelID = id.FromNullable(parentCh)
	c.ParentMessageID = id.FromNullable(parentMsg)
	c.CreatedBy = id.FromNullable(createdBy)
	if sources != nil {
		c.GallerySources = *sources
	}
	if c.Tags == nil {
		c.Tags = []string{}
	}
	c.Overrides = []Override{}
	return &c, nil
}
```

In `query`, before `return out, s.loadParticipants(ctx, out)`:

```go
	if err := s.loadSources(ctx, out); err != nil {
		return nil, err
	}
```

In `ListDMs`, append `, c.gallery_sources` to the explicit column list (after `c.dm_group`).

- [ ] **Step 7: Create and update handlers**

In `handlers.go`, add to `CreateChannelRequest`:

```go
	GallerySources   string  `json:"gallery_sources,omitempty" enum:"none,all,selected" doc:"Galleries only; default none"`
	SourceChannelIDs []id.ID `json:"source_channel_ids,omitempty" maxItems:"100" doc:"Galleries with gallery_sources selected"`
```

and to `UpdateChannelRequest`:

```go
	GallerySources   *string  `json:"gallery_sources,omitempty" enum:"none,all,selected" doc:"Galleries only"`
	SourceChannelIDs *[]id.ID `json:"source_channel_ids,omitempty" maxItems:"100" doc:"Galleries only; replaces the source list"`
```

In `create-channel`, after the `RequireTag` check:

```go
			var sources *string
			if in.Body.Type == TypeGallery {
				mode := in.Body.GallerySources
				if mode == "" {
					mode = SourcesNone
				}
				sources = &mode
			} else if in.Body.GallerySources != "" || len(in.Body.SourceChannelIDs) > 0 {
				return nil, errOnlyGalleries()
			}
```

Change the INSERT to include `gallery_sources`:

```go
			if _, err := tx.Exec(ctx, `
				INSERT INTO channels (id, community_id, type, name, position, category_id, tags, require_tag, gallery_sources)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				newID, cid, in.Body.Type, strings.TrimSpace(in.Body.Name), len(group), in.Body.CategoryID, tags, in.Body.RequireTag, sources); err != nil {
				return nil, err
			}
			if sources != nil {
				srcIDs, err := checkSources(ctx, tx, cid, newID, *sources, in.Body.SourceChannelIDs)
				if err != nil {
					return nil, err
				}
				if err := setSources(ctx, tx, newID, *sources, srcIDs); err != nil {
					return nil, err
				}
			}
```

In `update-channel`, after the forum `requireTag` block and before the `moveChannel` call:

```go
			if in.Body.GallerySources != nil || in.Body.SourceChannelIDs != nil {
				if c.Type != TypeGallery {
					return nil, errOnlyGalleries()
				}
				mode := c.GallerySources
				if in.Body.GallerySources != nil {
					mode = *in.Body.GallerySources
				}
				var ids []id.ID
				switch {
				case in.Body.SourceChannelIDs != nil:
					ids = *in.Body.SourceChannelIDs
				case mode == SourcesSelected && c.GallerySources == SourcesSelected:
					ids = c.SourceChannelIDs // keep the list when only re-sending the mode
				}
				if err := s.updateSources(ctx, c, mode, ids); err != nil {
					return nil, err
				}
			}
```

(Switching `all` → `selected` without ids leaves `ids` nil, so `checkSources` rejects it: Review Focus 3.)

- [ ] **Step 8: Audit**

In `audit.go` `channelChanges`, insert these two lines just before the final `return audit.Diff(cs, "require_tag", …), nil` (which stays last and unchanged):

```go
	cs = audit.Diff(cs, "gallery_sources", old.GallerySources, new.GallerySources)
	cs = audit.Diff(cs, "source_channels", idList(old.SourceChannelIDs), idList(new.SourceChannelIDs))
```

The update test checks that the newest entry's first change is `gallery_sources`: its last successful PATCH (`selected` → `all`) changes only the sources, and `gallery_sources` is appended before `source_channels`.

- [ ] **Step 9: Run tests**

Run: `rtk go -C server test ./internal/channels/ ./internal/db/ -v -run 'TestGallerySource|TestDefaultChannel|Migrat'`
Expected: PASS.

- [ ] **Step 10: Stage**

```bash
rtk git add server/internal/db/migrations/00041_gallery_sources.sql server/internal/channels server/internal/apptest/apptest.go
```
Suggested message: `feat(server): gallery channels get sources (none, all, selected)`

---

### Task 2: Gallery scope and `/api/files?gallery=`; global scope removed

**Files:**
- Modify: `server/internal/channels/readable.go` (split out `readableServer`, add `GalleryScope`)
- Modify: `server/internal/messages/messages.go:25-29` (`Channels` interface)
- Modify: `server/internal/messages/files.go` (`FilesQuery.Gallery`, `Files`, handler)
- Modify: `server/internal/messages/files_test.go`
- Test: `server/internal/channels/gallery_test.go` (scope test)

**Interfaces:**
- Consumes: Task 1's `Channel.GallerySources`, `SourceChannelIDs`, `CreateGallery`.
- Produces: `func (s *channels.Service) GalleryScope(ctx context.Context, userID, galleryID id.ID) ([]id.ID, error)` — 404 `channel` if the viewer can't see the gallery, 400 `NOT_A_GALLERY` for other types; returns server channel IDs only (no threads, no DMs). `messages.FilesQuery.Gallery *id.ID`.

- [ ] **Step 1: Write the failing scope test**

Append to `server/internal/channels/gallery_test.go`:

```go
func TestGalleryScope(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	srv := alice.Server()
	general := alice.General()
	secret := alice.CreatePrivateChannel("secret")
	ctx := context.Background()
	scope := func(c *apptest.Client, g id.ID) []id.ID {
		t.Helper()
		got, err := env.App.Channels.GalleryScope(ctx, c.User.ID, g)
		require.NoError(t, err)
		return got
	}

	none := alice.CreateGallery("photos", "")
	require.Equal(t, []id.ID{none}, scope(bob, none))

	all := alice.CreateGallery("everything", "all")
	require.ElementsMatch(t, []id.ID{general, none, all}, scope(bob, all), "bob can't read #secret")
	later := alice.CreateTextChannel("later")
	require.Contains(t, scope(bob, all), later, "all includes channels made later")
	require.Contains(t, scope(alice, all), secret)

	picked := alice.CreateGallery("picked", "selected", secret, general)
	require.ElementsMatch(t, []id.ID{picked, general}, scope(bob, picked))

	// Without READ_HISTORY in the gallery itself, its own posts drop out but sources stay.
	alice.Do(http.MethodPut, "/api/channels/"+picked.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ReadHistory)}, http.StatusOK, nil)
	require.Equal(t, []id.ID{general}, scope(bob, picked))

	// A gallery bob can't see is a 404; a text channel is not a gallery.
	hidden := alice.CreateGallery("hidden", "all")
	alice.Do(http.MethodPut, "/api/channels/"+hidden.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	_, err := env.App.Channels.GalleryScope(ctx, bob.User.ID, hidden)
	requireHTTP(t, err, http.StatusNotFound)
	_, err = env.App.Channels.GalleryScope(ctx, bob.User.ID, general)
	requireHTTP(t, err, http.StatusBadRequest)
}

func requireHTTP(t *testing.T, err error, status int) {
	t.Helper()
	var he *httpx.Error
	require.ErrorAs(t, err, &he)
	require.Equal(t, status, he.Status)
}
```

Add imports `context`, `perms`, `httpx`. Check how `apptest.Env` exposes services (`env.App.Files` is used in `albums/items_test.go`); use `env.App.Channels` if that field exists, otherwise add `Channels *channels.Service` to the `app.App` struct where `Files` is declared and set it where `chanSvc` is created (`server/internal/app/app.go`). Check `httpx.Error`'s status field name (`Status` or `StatusCode`) in `server/internal/httpx` and adjust.

- [ ] **Step 2: Run to verify it fails**

Run: `rtk go -C server test ./internal/channels/ -run TestGalleryScope -v`
Expected: FAIL to compile (`GalleryScope` undefined).

- [ ] **Step 3: Implement**

Replace `server/internal/channels/readable.go` with:

```go
package channels

import (
	"context"
	"errors"

	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Readable returns the channels whose messages userID may read: server text,
// voice, webhook, announcement, forum and gallery channels where they have
// VIEW_CHANNEL and READ_HISTORY, and their DMs. Threads (and forum posts) are
// not listed: a thread is readable when its parent is.
func (s *Service) Readable(ctx context.Context, userID id.ID) ([]id.ID, error) {
	out, err := s.readableServer(ctx, userID)
	if err != nil {
		return nil, err
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

// readableServer is Readable without DMs.
func (s *Service) readableServer(ctx context.Context, userID id.ID) ([]id.ID, error) {
	out := []id.ID{}
	sid, err := s.communities.ServerID(ctx)
	if errors.Is(err, communities.ErrNotFound) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	m, err := s.communities.PermMember(ctx, sid, userID)
	if errors.Is(err, communities.ErrNotMember) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	chs, err := s.query(ctx, `SELECT `+channelCols+` FROM channels WHERE community_id = $1 AND type IN ('text', 'voice', 'webhook', 'announcement', 'forum', 'gallery')`, sid)
	if err != nil {
		return nil, err
	}
	for _, c := range chs {
		if effective(m, c).Has(perms.ViewChannel | perms.ReadHistory) {
			out = append(out, c.ID)
		}
	}
	return out, nil
}

// GalleryScope returns the channels whose files a gallery shows userID: the gallery itself and its
// sources, each only if userID can read it. Threads are not listed; a thread comes with its parent.
// A gallery the user can't see is a 404; another type of channel is a 400.
func (s *Service) GalleryScope(ctx context.Context, userID, galleryID id.ID) ([]id.ID, error) {
	g, _, err := s.Access(ctx, userID, galleryID, perms.ViewChannel)
	if err != nil {
		return nil, err
	}
	if g.Type != TypeGallery {
		return nil, httpx.BadRequest("NOT_A_GALLERY", "that channel is not a gallery")
	}
	readable, err := s.readableServer(ctx, userID)
	if err != nil {
		return nil, err
	}
	want := map[id.ID]bool{g.ID: true}
	for _, c := range g.SourceChannelIDs {
		want[c] = true
	}
	out := []id.ID{}
	for _, c := range readable {
		if g.GallerySources == SourcesAll || want[c] {
			out = append(out, c)
		}
	}
	return out, nil
}
```

In `server/internal/messages/messages.go`, add to `Channels`:

```go
	GalleryScope(ctx context.Context, userID, galleryID id.ID) ([]id.ID, error)
```

In `server/internal/messages/files.go`:
- `FilesQuery`: add `Gallery *id.ID // the gallery's scope; else Channels (required then)` and change the `Channels` comment to `// narrows the scope; with no Gallery, the scope is these readable channels`.
- `Files` doc: `// Files lists the files userID can read outside DMs in a gallery's scope or in the given channels, newest first.`
- Replace the scope computation at the top of `Files`:

```go
	var scope []id.ID
	var err error
	if fq.Gallery != nil {
		scope, err = s.channels.GalleryScope(ctx, userID, *fq.Gallery)
	} else {
		scope, err = s.channels.Readable(ctx, userID)
	}
	if err != nil {
		return nil, err
	}
	if fq.Channels != nil {
		in := map[id.ID]bool{}
		for _, c := range scope {
			in[c] = true
		}
		var narrowed []id.ID
		for _, c := range fq.Channels {
			if in[c] {
				narrowed = append(narrowed, c)
			}
		}
		scope = narrowed
	}
```

- Handler: add `Gallery string \`query:"gallery" doc:"A gallery channel ID: its own posts and its sources' files"\`` before `Kind`, change the `Channel` doc to `"Comma-separated channel IDs; narrows a gallery, or is the scope without one. A channel includes its threads"`, and after the rate-limit check:

```go
			if in.Gallery == "" && in.Channel == "" {
				return nil, httpx.BadRequest("SCOPE_REQUIRED", "pass gallery or channel")
			}
```

and after parsing `Channel`:

```go
			if in.Gallery != "" {
				g, err := httpx.ParseID(in.Gallery, "channel")
				if err != nil {
					return nil, err
				}
				fq.Gallery = &g
			}
```

- [ ] **Step 4: Update `messages/files_test.go`**

`TestFilesScope`: replace the unscoped listings with a gallery. After the DM setup add `all := alice.CreateGallery("everything", "all")` and `inAll := url.Values{"gallery": {all.String()}}`; then use `listFiles(t, bob, inAll)` where it used `url.Values{}` (both the bob and alice listings). Keep the `channel=` assertions. Add at the end:

```go
	// No scope at all is refused; a channel filter narrows a gallery.
	bob.Fail(http.MethodGet, "/api/files", nil, http.StatusBadRequest, "SCOPE_REQUIRED")
	require.Empty(t, listFiles(t, bob, url.Values{"gallery": {all.String()}, "channel": {secret.String()}}).Items)
	picked := alice.CreateGallery("picked", "selected", secret)
	require.Empty(t, listFiles(t, bob, url.Values{"gallery": {picked.String()}}).Items, "a source never grants access")
	require.Equal(t, []string{"hidden.wav"}, fileNames(listFiles(t, alice, url.Values{"gallery": {picked.String()}})))
```

`TestFilesFilters`: define `in := func(v url.Values) url.Values { v.Set("channel", general.String()); return v }` after `general` and wrap every `url.Values{…}` passed to `listFiles` in `in(…)`. Keep the `kind=music` failure as `"/api/files?channel="+general.String()+"&kind=music"`.

`TestFilesPagination`: same `in(…)` wrapper on all three `listFiles` calls.

`TestDeletedMessageLeavesAlbums`: move it out of this file — Task 3 rewrites it in `albums/items_test.go`. Delete it here.

- [ ] **Step 5: Run tests**

Run: `rtk go -C server test ./internal/channels/ ./internal/messages/ -v -run 'TestGalleryScope|TestFiles'`
Expected: PASS.

- [ ] **Step 6: Stage**

```bash
rtk git add server/internal/channels server/internal/messages server/internal/app
```
Suggested message: `feat(server): list files by gallery scope; drop the global scope`

---

### Task 3: Albums live in a gallery; album uploads removed

**Files:**
- Create: `server/internal/db/migrations/00042_gallery_albums.sql`
- Rewrite: `server/internal/albums/albums.go`, `server/internal/albums/items.go`, `server/internal/albums/handlers.go`
- Rewrite: `server/internal/albums/albums_test.go`, `server/internal/albums/items_test.go`
- Modify: `server/internal/files/files.go` (remove `Albums`, `SetAlbums`, `AlbumID`, album branches; `Sweep`)
- Modify: `server/internal/files/handlers.go` (upload: channel only)
- Modify: `server/internal/app/app.go:223-226`
- Modify: `server/internal/messages/files.go` (`FileItem`/`FileItems` comments only)

**Interfaces:**
- Consumes: `channels.Service.GalleryScope`, `Readable` (Task 2); `CreateGallery` (Task 1).
- Produces (HTTP): `GET /api/channels/{id}/albums` (op `list-gallery-albums`), `POST /api/channels/{id}/albums` (op `create-album`, body `{title, visibility: "private"|"gallery"}`), `GET /api/albums?contains=<attachmentID>` (op `list-albums-for-file`, contains required), existing `GET/PATCH/DELETE /api/albums/{albumID}`, members, `GET/PUT/DELETE /api/albums/{albumID}/files…`. `Album` JSON gains `gallery_id`, `deck` (array of attachments); loses `cover`. `files.Attachment` loses `album_id`.

- [ ] **Step 1: Migration**

`server/internal/db/migrations/00042_gallery_albums.sql`:

```sql
-- +goose Up
-- Albums are folders inside a gallery channel and hold only files posted in channels; the old
-- personal albums and their direct uploads go (spec: gallery sources and wall). Blob files of the
-- deleted uploads are reclaimed by files.Sweep once nothing references them.
DELETE FROM album_items;
DELETE FROM album_members;
DELETE FROM albums;
DELETE FROM attachments WHERE album_id IS NOT NULL;
DROP INDEX attachments_album_idx;
ALTER TABLE attachments DROP CONSTRAINT attachments_home_check, DROP COLUMN album_id;
ALTER TABLE attachments ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE albums
    ADD COLUMN gallery_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    DROP CONSTRAINT albums_visibility_check,
    ADD CONSTRAINT albums_visibility_check CHECK (visibility IN ('private', 'gallery')),
    ALTER COLUMN visibility SET DEFAULT 'gallery';
CREATE INDEX albums_gallery_idx ON albums (gallery_id);

-- +goose Down
DELETE FROM album_items;
DELETE FROM album_members;
DELETE FROM albums;
DROP INDEX albums_gallery_idx;
ALTER TABLE albums
    DROP COLUMN gallery_id,
    DROP CONSTRAINT albums_visibility_check,
    ADD CONSTRAINT albums_visibility_check CHECK (visibility IN ('private', 'server')),
    ALTER COLUMN visibility SET DEFAULT 'private';
ALTER TABLE attachments
    ALTER COLUMN channel_id DROP NOT NULL,
    ADD COLUMN album_id BIGINT REFERENCES albums (id) ON DELETE CASCADE,
    ADD CONSTRAINT attachments_home_check CHECK ((channel_id IS NULL) <> (album_id IS NULL));
CREATE INDEX attachments_album_idx ON attachments (album_id) WHERE album_id IS NOT NULL;
```

If `DROP CONSTRAINT albums_visibility_check` fails (constraint named differently), find the name with `SELECT conname FROM pg_constraint WHERE conrelid = 'albums'::regclass` in a test DB and use it.

- [ ] **Step 2: Remove album uploads from `files`**

In `server/internal/files/files.go`:
- Delete the `Albums` interface (lines 32-37), the `albums` field and the `SetAlbums` method.
- `Attachment`: delete the `AlbumID` field; `ChannelID` doc becomes `"Where it was posted"`.
- `attachmentCols`: remove `album_id`; in the scan function remove the `album` variable and its scan target, and `a.AlbumID` from the assignment.
- `authorized`: delete the `if a.AlbumID != nil { … }` block; doc comment unchanged.
- `home` struct: delete `albumID` and update its comment to `// home is where an upload goes: a channel, where it is sent later with a message.`
- `save`: drop `AlbumID: h.albumID`; the INSERT loses `album_id` and its placeholder (renumber the `$n`s); delete the `if a.AlbumID != nil { INSERT INTO album_items … }` block.
- `Sweep`: `DELETE FROM attachments WHERE message_id IS NULL AND created_at < $1`.
- `MessageID` doc: `// MessageID is the message the file was sent with; nil while unsent.`

In `server/internal/files/handlers.go` `upload`: delete the `album_id` branch so only the channel branch remains (un-nested), delete the `if err == nil && h.albumID != nil { … }` call, and change the `UploadHandler` comment to `POST /api/attachments?channel_id=<id>`.

In `server/internal/app/app.go`: delete the `filesSvc.SetAlbums(albumSvc)` line (and the `if` around it if it only guards that).

In `server/internal/messages/files.go`: `FileItem` comment → `// FileItem is one file in a gallery or album: the attachment, its message and where it was posted (a thread's file carries the thread; clients tag it with parent_name).`; `FileItems` comment → `// FileItems hydrates listed files, in order, each with its message and channel. Files deleted since they were listed are left out.` Keep `Message`/`Channel` as pointers (no client churn).

Run: `rtk go -C server build ./...` — expected: errors only inside `internal/albums` (fixed next).

- [ ] **Step 3: Write the failing album tests**

Replace `server/internal/albums/albums_test.go`:

```go
package albums_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/albums"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

func create(t *testing.T, c *apptest.Client, gallery id.ID, title, visibility string) albums.Album {
	t.Helper()
	var a albums.Album
	c.Do(http.MethodPost, "/api/channels/"+gallery.String()+"/albums", map[string]any{"title": title, "visibility": visibility}, http.StatusCreated, &a)
	return a
}

func list(t *testing.T, c *apptest.Client, gallery id.ID) []albums.Album {
	t.Helper()
	var out []albums.Album
	c.Do(http.MethodGet, "/api/channels/"+gallery.String()+"/albums", nil, http.StatusOK, &out)
	return out
}

func titles(as []albums.Album) []string {
	out := []string{}
	for _, a := range as {
		out = append(out, a.Title)
	}
	return out
}

func TestAlbumVisibility(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	g := alice.CreateGallery("photos", "")
	other := alice.CreateGallery("other", "")
	trip := create(t, alice, g, "Trip", "private")
	memes := create(t, alice, g, "Memes", "gallery")
	path := "/api/albums/" + trip.ID.String()

	require.Equal(t, "owner", trip.Role)
	require.Equal(t, g, trip.GalleryID)
	require.Equal(t, []string{"Memes", "Trip"}, titles(list(t, alice, g)), "most recently changed first")
	require.Empty(t, list(t, alice, other), "albums belong to one gallery")
	require.Equal(t, []string{"Memes"}, titles(list(t, bob, g)))
	bob.Fail(http.MethodGet, path, nil, http.StatusNotFound, "NOT_FOUND")

	alice.Do(http.MethodPut, path+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	var got albums.Album
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &got)
	require.Equal(t, "collaborator", got.Role)
	carol.Do(http.MethodGet, "/api/albums/"+memes.ID.String(), nil, http.StatusOK, &got)
	require.Equal(t, "viewer", got.Role)

	bob.Fail(http.MethodPatch, path, map[string]any{"title": "Mine"}, http.StatusForbidden, "MISSING_PERMISSION")
	carol.Fail(http.MethodPatch, path, map[string]any{"title": "Mine"}, http.StatusNotFound, "NOT_FOUND")
	alice.Do(http.MethodPatch, path, map[string]any{"title": "Lofoten", "visibility": "gallery"}, http.StatusOK, &got)
	require.Equal(t, "Lofoten", got.Title)
	carol.Do(http.MethodGet, path, nil, http.StatusOK, &got)
}

func TestAlbumFollowsGalleryAccess(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	srv := alice.Server()
	g := alice.CreateGallery("photos", "")
	shared := create(t, alice, g, "Shared", "gallery")

	// Hiding the gallery from @everyone hides its albums from bob, also as a collaborator.
	alice.Do(http.MethodPut, "/api/albums/"+shared.ID.String()+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, "/api/channels/"+g.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	bob.Fail(http.MethodGet, "/api/albums/"+shared.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodGet, "/api/channels/"+g.String()+"/albums", nil, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodPost, "/api/channels/"+g.String()+"/albums", map[string]any{"title": "x", "visibility": "private"}, http.StatusNotFound, "NOT_FOUND")

	// Not a gallery.
	alice.Fail(http.MethodPost, "/api/channels/"+alice.General().String()+"/albums", map[string]any{"title": "x", "visibility": "private"}, http.StatusBadRequest, "NOT_A_GALLERY")

	// Deleting the gallery deletes its albums.
	alice.Do(http.MethodDelete, "/api/channels/"+g.String(), nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodGet, "/api/albums/"+shared.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
}

func TestAlbumModerationDelete(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice") // server owner: has ManageMessages
	bob := env.Register("bob")
	g := alice.CreateGallery("photos", "")
	shared := create(t, bob, g, "Shared", "gallery")
	private := create(t, bob, g, "Private", "private")

	alice.Fail(http.MethodDelete, "/api/albums/"+private.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
	alice.Do(http.MethodDelete, "/api/albums/"+shared.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"Private"}, titles(list(t, bob, g)))
}

func TestAlbumLimitsAndValidation(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	g := alice.CreateGallery("photos", "")
	base := "/api/channels/" + g.String() + "/albums"
	alice.Fail(http.MethodPost, base, map[string]any{"title": "", "visibility": "private"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPost, base, map[string]any{"title": "x", "visibility": "server"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPost, base, map[string]any{"title": "   ", "visibility": "private"}, http.StatusBadRequest, "VALIDATION_FAILED")
	a := create(t, alice, g, "  Trip  ", "private")
	require.Equal(t, "Trip", a.Title)
	for i := 0; i < 99; i++ {
		create(t, alice, g, "a", "private")
	}
	alice.Fail(http.MethodPost, base, map[string]any{"title": "one more", "visibility": "private"}, http.StatusBadRequest, "ALBUMS_FULL")
}

func TestAlbumEventAudiences(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	bws, _ := bob.Connect()
	cws, _ := carol.Connect()
	g := alice.CreateGallery("photos", "")
	trip := create(t, alice, g, "Trip", "private")
	path := "/api/albums/" + trip.ID.String()
	alice.Do(http.MethodPut, path+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)

	var ev map[string]any
	bws.ExpectDispatch("ALBUM_UPDATE", &ev)
	cws.ExpectNoDispatch("ALBUM_UPDATE", 300*time.Millisecond)

	alice.Do(http.MethodPatch, path, map[string]any{"visibility": "gallery"}, http.StatusOK, nil)
	var got albums.Album
	cws.ExpectDispatch("ALBUM_UPDATE", &got)
	require.Empty(t, got.Deck)
	alice.Do(http.MethodPatch, path, map[string]any{"visibility": "private"}, http.StatusOK, nil)
	cws.ExpectDispatch("ALBUM_DELETE", &ev)
}
```

Replace `server/internal/albums/items_test.go`:

```go
package albums_test

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/albums"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/messages"
)

func albumFiles(t *testing.T, c *apptest.Client, albumID string, q url.Values) messages.FilesPage {
	t.Helper()
	var p messages.FilesPage
	c.Do(http.MethodGet, "/api/albums/"+albumID+"/files?"+q.Encode(), nil, http.StatusOK, &p)
	return p
}

func names(p messages.FilesPage) []string {
	out := []string{}
	for _, it := range p.Items {
		out = append(out, it.Attachment.Filename)
	}
	return out
}

func TestAlbumFilesInGalleryScope(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	memes := alice.CreateTextChannel("memes")
	secret := alice.CreatePrivateChannel("secret")
	g := alice.CreateGallery("photos", "selected", general, secret)

	pub := alice.Upload(general, "public.txt", []byte("hi"), http.StatusCreated)
	alice.SendWith(general, "caption words", pub.ID)
	hid := alice.Upload(secret, "hidden.txt", []byte("psst"), http.StatusCreated)
	alice.SendWith(secret, "", hid.ID)
	out := alice.Upload(memes, "outside.txt", []byte("x"), http.StatusCreated)
	alice.SendWith(memes, "", out.ID)
	own := alice.Upload(g, "own.png", tinyPNG(t), http.StatusCreated)
	alice.SendWith(g, "", own.ID)

	trip := create(t, alice, g, "Trip", "gallery")
	path := "/api/albums/" + trip.ID.String() + "/files/"
	alice.Do(http.MethodPut, path+pub.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, path+hid.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, path+own.ID.String(), nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodPut, path+out.ID.String(), nil, http.StatusBadRequest, "NOT_IN_GALLERY")
	bob.Fail(http.MethodPut, path+pub.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")

	require.Equal(t, []string{"own.png", "hidden.txt", "public.txt"}, names(albumFiles(t, alice, trip.ID.String(), nil)))
	got := albumFiles(t, bob, trip.ID.String(), nil)
	require.Equal(t, []string{"own.png", "public.txt"}, names(got), "bob can't read #secret")
	require.Equal(t, "caption words", got.Items[1].Message.Content)

	var listed []albums.Album
	alice.Do(http.MethodGet, "/api/channels/"+g.String()+"/albums", nil, http.StatusOK, &listed)
	require.Len(t, listed[0].Deck, 1, "only images make the deck")
	require.Equal(t, own.ID, listed[0].Deck[0].ID)

	// Removing #general as a source hides its file from the album but keeps it counted.
	alice.Do(http.MethodPatch, "/api/channels/"+g.String(), map[string]any{"source_channel_ids": []string{secret.String()}}, http.StatusOK, nil)
	require.Equal(t, []string{"own.png", "hidden.txt"}, names(albumFiles(t, alice, trip.ID.String(), nil)))
	var a albums.Album
	alice.Do(http.MethodGet, "/api/albums/"+trip.ID.String(), nil, http.StatusOK, &a)
	require.Equal(t, 3, a.ItemCount)

	// Removing an item keeps the file.
	alice.Do(http.MethodDelete, path+hid.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"own.png"}, names(albumFiles(t, alice, trip.ID.String(), nil)))
	alice.Do(http.MethodGet, hid.URL, nil, http.StatusOK, nil)
}

func TestAlbumsForFile(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	memes := alice.CreateTextChannel("memes")
	withGeneral := alice.CreateGallery("all", "all")
	onlyMemes := alice.CreateGallery("memes-only", "selected", memes)
	a := create(t, alice, withGeneral, "A", "private")
	create(t, alice, onlyMemes, "B", "private")
	f := alice.Upload(general, "f.txt", []byte("x"), http.StatusCreated)
	alice.SendWith(general, "", f.ID)
	alice.Do(http.MethodPut, "/api/albums/"+a.ID.String()+"/files/"+f.ID.String(), nil, http.StatusNoContent, nil)

	var got []albums.Album
	alice.Do(http.MethodGet, "/api/albums?contains="+f.ID.String(), nil, http.StatusOK, &got)
	require.Equal(t, []string{"A"}, titles(got), "only albums whose gallery shows the file")
	require.True(t, *got[0].Contains)
	alice.Fail(http.MethodGet, "/api/albums", nil, http.StatusBadRequest, "VALIDATION_FAILED")
}

// Deleting a message deletes its files, which takes them out of any album.
func TestDeletedMessageLeavesAlbums(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	g := alice.CreateGallery("all", "all")
	f := alice.Upload(general, "pic.txt", []byte("x"), http.StatusCreated)
	m := alice.SendWith(general, "", f.ID)
	album := create(t, alice, g, "T", "private")
	alice.Do(http.MethodPut, "/api/albums/"+album.ID.String()+"/files/"+f.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+m.ID.String(), nil, http.StatusNoContent, nil)
	require.Empty(t, albumFiles(t, alice, album.ID.String(), nil).Items)
}
```

`tinyPNG(t)` lives in `messages` tests; if it isn't reachable from `albums_test`, copy it into a new `server/internal/albums/fixtures_test.go` (same body as the `messages` one — find it with `rtk grep "func tinyPNG" server`).

- [ ] **Step 4: Run to verify failure**

Run: `rtk go -C server test ./internal/albums/ -v`
Expected: FAIL to compile.

- [ ] **Step 5: Rewrite `albums.go`**

Replace `server/internal/albums/albums.go` with:

```go
// Package albums is folders of files inside a gallery channel: files its gallery shows, picked into
// an album (spec: gallery sources and wall).
package albums

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

const (
	maxAlbums        = 100
	maxItems         = 5000
	maxCollaborators = 25
	deckSize         = 3
)

const (
	RoleOwner        = "owner"
	RoleCollaborator = "collaborator"
	RoleViewer       = "viewer"
)

// Album is an album as a caller sees it.
type Album struct {
	ID         id.ID              `json:"id"`
	GalleryID  id.ID              `json:"gallery_id"`
	Title      string             `json:"title"`
	Visibility string             `json:"visibility" enum:"private,gallery"`
	OwnerID    id.ID              `json:"owner_id"`
	MemberIDs  []id.ID            `json:"member_ids" doc:"Collaborators"`
	ItemCount  int                `json:"item_count" doc:"Every item, including files you cannot see"`
	Deck       []files.Attachment `json:"deck" doc:"Up to three of the newest images you can see, newest first; empty in events and in contains= listings"`
	CreatedAt  time.Time          `json:"created_at"`
	UpdatedAt  time.Time          `json:"updated_at"`
	Role       string             `json:"role,omitempty" enum:"owner,collaborator,viewer" doc:"Yours"`
	Contains   *bool              `json:"contains,omitempty" doc:"With contains=: whether the file is in it"`
}

// AlbumDeleted is the ALBUM_DELETE event.
type AlbumDeleted struct {
	ID id.ID `json:"id"`
}

// ItemsChanged is the ALBUM_ITEMS_UPDATE event: refetch the album's files.
type ItemsChanged struct {
	AlbumID id.ID `json:"album_id"`
}

type AlbumCreate struct {
	Title      string `json:"title" minLength:"1" maxLength:"100"`
	Visibility string `json:"visibility" enum:"private,gallery"`
}

type AlbumUpdate struct {
	Title      *string `json:"title,omitempty" minLength:"1" maxLength:"100"`
	Visibility *string `json:"visibility,omitempty" enum:"private,gallery"`
}

type Channels interface {
	GalleryScope(ctx context.Context, userID, galleryID id.ID) ([]id.ID, error)
	Readable(ctx context.Context, userID id.ID) ([]id.ID, error)
}

type Members interface {
	BasePerms(ctx context.Context, userID id.ID) (perms.Perms, error)
}

type Files interface {
	ForIDs(ctx context.Context, ids []id.ID) (map[id.ID]files.Attachment, error)
}

type Messages interface {
	FileItems(ctx context.Context, hits []messages.FileHit) ([]messages.FileItem, error)
}

type Service struct {
	db       *pgxpool.Pool
	bus      *events.Bus
	channels Channels
	members  Members
	files    Files
	messages Messages
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, ch Channels, m Members, fs Files, msgs Messages) *Service {
	return &Service{db: pool, bus: bus, channels: ch, members: m, files: fs, messages: msgs}
}

// row is an album's stored fields.
type row struct {
	id         id.ID
	galleryID  id.ID
	ownerID    id.ID
	title      string
	visibility string
	updatedAt  time.Time
	memberIDs  []id.ID
}

func (r *row) has(userID id.ID) bool {
	for _, m := range r.memberIDs {
		if m == userID {
			return true
		}
	}
	return false
}

const rowCols = `a.id, a.gallery_id, a.owner_id, a.title, a.visibility, a.updated_at,
	ARRAY(SELECT m.user_id FROM album_members m WHERE m.album_id = a.id ORDER BY m.user_id)`

func scanRow(r pgx.Row, extra ...any) (*row, error) {
	var a row
	var members []int64
	dest := append([]any{&a.id, &a.galleryID, &a.ownerID, &a.title, &a.visibility, &a.updatedAt, &members}, extra...)
	if err := r.Scan(dest...); err != nil {
		return nil, err
	}
	for _, m := range members {
		a.memberIDs = append(a.memberIDs, id.ID(m))
	}
	return &a, nil
}

// inScopeSQL is "attachment %[1]s was posted in a channel of scope %[2]s, or a thread of one", with
// c joined as its channel.
const inScopeSQL = `(%[1]s.channel_id = ANY(%[2]s) OR (c.type = 'thread' AND c.parent_channel_id = ANY(%[2]s)))`

// galleryScope is the channels a gallery shows userID. Not being a member (or being gated) is a
// missing channel, like a gallery you can't see.
func (s *Service) galleryScope(ctx context.Context, userID, galleryID id.ID) ([]id.ID, error) {
	p, err := s.members.BasePerms(ctx, userID)
	if err != nil {
		return nil, err
	}
	if p == 0 {
		return nil, httpx.NotFound("channel")
	}
	return s.channels.GalleryScope(ctx, userID, galleryID)
}

// access loads an album the caller can see, how (owner, collaborator or viewer) and its gallery's
// scope for them. Anything else is 404, so private albums don't reveal that they exist.
func (s *Service) access(ctx context.Context, userID, albumID id.ID) (*row, string, []id.ID, error) {
	a, err := scanRow(s.db.QueryRow(ctx, `SELECT `+rowCols+` FROM albums a WHERE a.id = $1`, albumID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", nil, httpx.NotFound("album")
	}
	if err != nil {
		return nil, "", nil, err
	}
	sc, err := s.galleryScope(ctx, userID, a.galleryID)
	var he *httpx.Error
	if errors.As(err, &he) {
		return nil, "", nil, httpx.NotFound("album")
	}
	if err != nil {
		return nil, "", nil, err
	}
	switch {
	case a.ownerID == userID:
		return a, RoleOwner, sc, nil
	case a.has(userID):
		return a, RoleCollaborator, sc, nil
	case a.visibility == "gallery":
		return a, RoleViewer, sc, nil
	}
	return nil, "", nil, httpx.NotFound("album")
}

// editable is access for adding and removing files: the owner or a collaborator.
func (s *Service) editable(ctx context.Context, userID, albumID id.ID) (*row, []id.ID, error) {
	a, role, sc, err := s.access(ctx, userID, albumID)
	if err != nil {
		return nil, nil, err
	}
	if role == RoleViewer {
		return nil, nil, httpx.MissingPermission()
	}
	return a, sc, nil
}

// owned is access for settings: only the owner.
func (s *Service) owned(ctx context.Context, userID, albumID id.ID) (*row, error) {
	a, role, _, err := s.access(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	if role != RoleOwner {
		return nil, httpx.MissingPermission()
	}
	return a, nil
}

func (s *Service) checkRoom(ctx context.Context, albumID id.ID) error {
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM album_items WHERE album_id = $1`, albumID).Scan(&n); err != nil {
		return err
	}
	if n >= maxItems {
		return httpx.BadRequest("ALBUM_FULL", fmt.Sprintf("the album has the most files it can hold (%d)", maxItems))
	}
	return nil
}

// list returns a gallery's albums userID can see, most recently changed first, each with its deck.
func (s *Service) list(ctx context.Context, userID, galleryID id.ID) ([]Album, error) {
	sc, err := s.galleryScope(ctx, userID, galleryID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+rowCols+`,
		(SELECT count(*) FROM album_items i WHERE i.album_id = a.id),
		ARRAY(SELECT t.id FROM album_items i JOIN attachments t ON t.id = i.attachment_id
			JOIN messages m ON m.id = t.message_id JOIN channels c ON c.id = t.channel_id
			WHERE i.album_id = a.id AND t.inline AND NOT m.deleted AND `+fmt.Sprintf(inScopeSQL, "t", "$3")+`
			ORDER BY t.id DESC LIMIT `+fmt.Sprint(deckSize)+`)
		FROM albums a
		WHERE a.gallery_id = $2 AND (a.visibility = 'gallery' OR a.owner_id = $1
			OR EXISTS (SELECT 1 FROM album_members m WHERE m.album_id = a.id AND m.user_id = $1))
		ORDER BY a.updated_at DESC, a.id DESC`, userID, galleryID, id.Int64s(sc))
	if err != nil {
		return nil, err
	}
	type listed struct {
		*row
		count int
		deck  []int64
	}
	var got []listed
	for rows.Next() {
		var l listed
		if l.row, err = scanRow(rows, &l.count, &l.deck); err != nil {
			rows.Close()
			return nil, err
		}
		got = append(got, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var deckIDs []id.ID
	for _, l := range got {
		for _, d := range l.deck {
			deckIDs = append(deckIDs, id.ID(d))
		}
	}
	atts, err := s.files.ForIDs(ctx, deckIDs)
	if err != nil {
		return nil, err
	}
	out := []Album{}
	for _, l := range got {
		a := toAlbum(l.row, l.count, roleOf(l.row, userID))
		for _, d := range l.deck {
			if att, ok := atts[id.ID(d)]; ok {
				a.Deck = append(a.Deck, att)
			}
		}
		out = append(out, a)
	}
	return out, nil
}

// listForFile returns the albums userID can edit whose gallery shows the attachment, each saying
// whether it holds it (no decks).
func (s *Service) listForFile(ctx context.Context, userID, attachmentID id.ID) ([]Album, error) {
	out := []Album{}
	p, err := s.members.BasePerms(ctx, userID)
	if err != nil || p == 0 {
		return out, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+rowCols+`,
		(SELECT count(*) FROM album_items i WHERE i.album_id = a.id),
		EXISTS (SELECT 1 FROM album_items i WHERE i.album_id = a.id AND i.attachment_id = $2)
		FROM albums a
		WHERE a.owner_id = $1 OR EXISTS (SELECT 1 FROM album_members m WHERE m.album_id = a.id AND m.user_id = $1)
		ORDER BY a.updated_at DESC, a.id DESC`, userID, attachmentID)
	if err != nil {
		return nil, err
	}
	type listed struct {
		*row
		count int
		has   bool
	}
	var got []listed
	for rows.Next() {
		var l listed
		if l.row, err = scanRow(rows, &l.count, &l.has); err != nil {
			rows.Close()
			return nil, err
		}
		got = append(got, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	shows := map[id.ID]bool{} // per gallery: does it show the file to userID?
	for _, l := range got {
		ok, seen := shows[l.galleryID]
		if !seen {
			sc, err := s.galleryScope(ctx, userID, l.galleryID)
			var he *httpx.Error
			switch {
			case errors.As(err, &he):
				ok = false
			case err != nil:
				return nil, err
			default:
				if ok, err = s.inScope(ctx, attachmentID, sc); err != nil {
					return nil, err
				}
			}
			shows[l.galleryID] = ok
		}
		if ok {
			a := toAlbum(l.row, l.count, roleOf(l.row, userID))
			has := l.has
			a.Contains = &has
			out = append(out, a)
		}
	}
	return out, nil
}

// inScope says whether a sent, undeleted attachment was posted in scope (or a thread of it).
func (s *Service) inScope(ctx context.Context, attachmentID id.ID, scope []id.ID) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM attachments t JOIN channels c ON c.id = t.channel_id
		JOIN messages m ON m.id = t.message_id
		WHERE t.id = $1 AND NOT m.deleted AND `+fmt.Sprintf(inScopeSQL, "t", "$2")+`)`,
		attachmentID, id.Int64s(scope)).Scan(&ok)
	return ok, err
}

func roleOf(r *row, userID id.ID) string {
	switch {
	case r.ownerID == userID:
		return RoleOwner
	case r.has(userID):
		return RoleCollaborator
	}
	return RoleViewer
}

func toAlbum(r *row, count int, role string) Album {
	members := r.memberIDs
	if members == nil {
		members = []id.ID{}
	}
	return Album{ID: r.id, GalleryID: r.galleryID, Title: r.title, Visibility: r.visibility, OwnerID: r.ownerID, MemberIDs: members,
		ItemCount: count, Deck: []files.Attachment{}, CreatedAt: r.id.Time(), UpdatedAt: r.updatedAt, Role: role}
}

// get is one album as the caller sees it.
func (s *Service) get(ctx context.Context, userID, albumID id.ID) (*Album, error) {
	a, _, _, err := s.access(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	all, err := s.list(ctx, userID, a.galleryID)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == albumID {
			return &all[i], nil
		}
	}
	return nil, httpx.NotFound("album")
}

func blankTitle() error { return httpx.BadRequest("VALIDATION_FAILED", "title must not be blank") }

func (s *Service) create(ctx context.Context, userID, galleryID id.ID, in AlbumCreate) (*Album, error) {
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		return nil, blankTitle()
	}
	if _, err := s.galleryScope(ctx, userID, galleryID); err != nil {
		return nil, err
	}
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM albums WHERE owner_id = $1`, userID).Scan(&n); err != nil {
		return nil, err
	}
	if n >= maxAlbums {
		return nil, httpx.BadRequest("ALBUMS_FULL", fmt.Sprintf("you have the most albums you can have (%d)", maxAlbums))
	}
	aid := id.New()
	if _, err := s.db.Exec(ctx, `INSERT INTO albums (id, gallery_id, owner_id, title, visibility) VALUES ($1, $2, $3, $4, $5)`,
		aid, galleryID, userID, in.Title, in.Visibility); err != nil {
		return nil, err
	}
	a, err := s.get(ctx, userID, aid)
	if err != nil {
		return nil, err
	}
	s.publishUpdate(ctx, a, nil)
	return a, nil
}

func (s *Service) update(ctx context.Context, userID, albumID id.ID, in AlbumUpdate) (*Album, error) {
	if in.Title != nil {
		t := strings.TrimSpace(*in.Title)
		if t == "" {
			return nil, blankTitle()
		}
		in.Title = &t
	}
	before, err := s.owned(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(ctx, `UPDATE albums SET title = coalesce($2, title), visibility = coalesce($3, visibility), updated_at = now()
		WHERE id = $1`, albumID, in.Title, in.Visibility); err != nil {
		return nil, err
	}
	a, err := s.get(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	s.publishUpdate(ctx, a, before)
	return a, nil
}

// remove deletes an album: by its owner, or a gallery-visible one by a moderator. Its files stay.
func (s *Service) remove(ctx context.Context, userID, albumID id.ID) error {
	a, role, _, err := s.access(ctx, userID, albumID)
	if err != nil {
		return err
	}
	moderating := false
	if role != RoleOwner {
		p, err := s.members.BasePerms(ctx, userID)
		if err != nil {
			return err
		}
		if a.visibility != "gallery" || !p.Has(perms.ManageMessages) {
			return httpx.MissingPermission()
		}
		moderating = true
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM albums WHERE id = $1`, albumID); err != nil { // cascades to members and items
		return err
	}
	if moderating {
		if err := audit.Record(ctx, tx, audit.AlbumDelete, albumID, audit.LogDetails{Name: a.title}); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.publishDelete(ctx, a)
	return nil
}

// addMember makes someone who can see the gallery a collaborator (owner only).
func (s *Service) addMember(ctx context.Context, userID, albumID, memberID id.ID) error {
	a, err := s.owned(ctx, userID, albumID)
	if err != nil {
		return err
	}
	if memberID == a.ownerID || a.has(memberID) {
		return nil
	}
	if _, err := s.galleryScope(ctx, memberID, a.galleryID); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return httpx.NotFound("member")
		}
		return err
	}
	if len(a.memberIDs) >= maxCollaborators {
		return httpx.BadRequest("COLLABORATORS_FULL", fmt.Sprintf("an album has at most %d collaborators", maxCollaborators))
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO album_members (album_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, albumID, memberID); err != nil {
		return err
	}
	return s.touchAndPublish(ctx, albumID, a)
}

// removeMember: the owner removes a collaborator, or a collaborator leaves.
func (s *Service) removeMember(ctx context.Context, userID, albumID, memberID id.ID) error {
	a, role, _, err := s.access(ctx, userID, albumID)
	if err != nil {
		return err
	}
	if role != RoleOwner && userID != memberID {
		return httpx.MissingPermission()
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM album_members WHERE album_id = $1 AND user_id = $2`, albumID, memberID)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	return s.touchAndPublish(ctx, albumID, a)
}

// touchAndPublish bumps the album and announces it from its stored row, so it doesn't depend on
// any viewer's access (the caller may just have left a private album).
func (s *Service) touchAndPublish(ctx context.Context, albumID id.ID, before *row) error {
	if _, err := s.db.Exec(ctx, `UPDATE albums SET updated_at = now() WHERE id = $1`, albumID); err != nil {
		return err
	}
	var count int
	r, err := scanRow(s.db.QueryRow(ctx, `SELECT `+rowCols+`, (SELECT count(*) FROM album_items i WHERE i.album_id = a.id)
		FROM albums a WHERE a.id = $1`, albumID), &count)
	if err != nil {
		return err
	}
	a := toAlbum(r, count, "")
	s.publishUpdate(ctx, &a, before)
	return nil
}

// audience is who hears about an album: everyone who can see its gallery, or its owner and
// collaborators who still can.
func (s *Service) audience(ctx context.Context, visibility string, galleryID, ownerID id.ID, memberIDs []id.ID) events.Scope {
	if visibility == "gallery" {
		return events.Scope{ChannelID: galleryID}
	}
	users := []id.ID{}
	for _, u := range append([]id.ID{ownerID}, memberIDs...) {
		if _, err := s.galleryScope(ctx, u, galleryID); err == nil {
			users = append(users, u)
		}
	}
	return events.Scope{UserIDs: users}
}

// publishUpdate sends ALBUM_UPDATE to its audience, and ALBUM_DELETE to anyone who could see it
// before (before may be nil) and no longer can.
func (s *Service) publishUpdate(ctx context.Context, a *Album, before *row) {
	if before != nil {
		lost := []id.ID{}
		for _, m := range before.memberIDs {
			if !contains(a.MemberIDs, m) {
				lost = append(lost, m)
			}
		}
		switch {
		case before.visibility == "gallery" && a.Visibility == "private":
			s.bus.Publish(events.Event{Type: "ALBUM_DELETE", Data: AlbumDeleted{ID: a.ID}, Scope: s.audience(ctx, "gallery", a.GalleryID, a.OwnerID, nil)})
		case a.Visibility == "private" && len(lost) > 0:
			s.bus.Publish(events.Event{Type: "ALBUM_DELETE", Data: AlbumDeleted{ID: a.ID}, Scope: events.Scope{UserIDs: lost}})
		}
	}
	shown := *a
	shown.Role, shown.Contains, shown.Deck = "", nil, []files.Attachment{}
	s.bus.Publish(events.Event{Type: "ALBUM_UPDATE", Data: shown, Scope: s.audience(ctx, a.Visibility, a.GalleryID, a.OwnerID, a.MemberIDs)})
}

func (s *Service) publishDelete(ctx context.Context, r *row) {
	s.bus.Publish(events.Event{Type: "ALBUM_DELETE", Data: AlbumDeleted{ID: r.id}, Scope: s.audience(ctx, r.visibility, r.galleryID, r.ownerID, r.memberIDs)})
}

func (s *Service) publishItems(ctx context.Context, albumID id.ID) {
	r, err := scanRow(s.db.QueryRow(ctx, `SELECT `+rowCols+` FROM albums a WHERE a.id = $1`, albumID))
	if err != nil {
		return
	}
	s.bus.Publish(events.Event{Type: "ALBUM_ITEMS_UPDATE", Data: ItemsChanged{AlbumID: albumID}, Scope: s.audience(ctx, r.visibility, r.galleryID, r.ownerID, r.memberIDs)})
}

func contains(ids []id.ID, x id.ID) bool {
	for _, v := range ids {
		if v == x {
			return true
		}
	}
	return false
}
```

If `audit.AlbumDelete`'s audit-log test (`TestAlbumModerationDelete` used to check it) matters to you, keep checking it: the old assertion on `"album.delete"` can be re-added unchanged.

- [ ] **Step 6: Rewrite `items.go`**

Keep `likeEscaper`, `fileKinds`, `filesQuery` and the `registerItems` huma handlers exactly as they are. Replace `listFiles`, `add`, `take`, delete `Uploaded`, keep `itemsChanged`:

```go
// listFiles lists an album's files its gallery shows the caller, newest upload first.
func (s *Service) listFiles(ctx context.Context, userID, albumID id.ID, fq filesQuery) (*messages.FilesPage, error) {
	_, _, sc, err := s.access(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	var args []any
	add := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	// Attachments are aliased a, as messages.KindSQL expects.
	conds := []string{"i.album_id = " + add(albumID), "NOT m.deleted", fmt.Sprintf(inScopeSQL, "a", add(id.Int64s(sc)))}
	if len(fq.kinds) > 0 {
		conds = append(conds, messages.KindSQL+" = ANY("+add(fq.kinds)+")")
	}
	if fq.uploader != nil {
		conds = append(conds, "a.uploader_id = "+add(*fq.uploader))
	}
	if fq.text != "" {
		p := add(fq.text)
		conds = append(conds, "(a.filename ILIKE '%' || "+add(likeEscaper.Replace(fq.text))+" || '%'"+
			" OR to_tsvector('simple', m.content) @@ plainto_tsquery('simple', "+p+"))")
	}
	if fq.before != nil {
		conds = append(conds, "a.id < "+add(*fq.before))
	}
	rows, err := s.db.Query(ctx, `SELECT a.id, `+messages.KindSQL+`
		FROM album_items i JOIN attachments a ON a.id = i.attachment_id
		JOIN messages m ON m.id = a.message_id JOIN channels c ON c.id = a.channel_id
		WHERE `+strings.Join(conds, " AND ")+` ORDER BY a.id DESC LIMIT `+add(fq.limit+1), args...)
	if err != nil {
		return nil, err
	}
	var hits []messages.FileHit
	for rows.Next() {
		var h messages.FileHit
		if err := rows.Scan(&h.AttachmentID, &h.Kind); err != nil {
			rows.Close()
			return nil, err
		}
		hits = append(hits, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	page := &messages.FilesPage{Items: []messages.FileItem{}}
	if len(hits) > fq.limit {
		hits = hits[:fq.limit]
		next := hits[len(hits)-1].AttachmentID
		page.NextCursor = &next
	}
	if page.Items, err = s.messages.FileItems(ctx, hits); err != nil {
		return nil, err
	}
	return page, nil
}

// add puts a file the album's gallery shows the caller into the album. A file the caller can read
// elsewhere is NOT_IN_GALLERY; one they can't read (or unsent) is a missing attachment.
func (s *Service) add(ctx context.Context, userID, albumID, attachmentID id.ID) error {
	_, sc, err := s.editable(ctx, userID, albumID)
	if err != nil {
		return err
	}
	ok, err := s.inScope(ctx, attachmentID, sc)
	if err != nil {
		return err
	}
	if !ok {
		readable, err := s.channels.Readable(ctx, userID)
		if err != nil {
			return err
		}
		if elsewhere, err := s.inScope(ctx, attachmentID, readable); err != nil {
			return err
		} else if elsewhere {
			return httpx.BadRequest("NOT_IN_GALLERY", "that file isn't in this album's gallery")
		}
		return httpx.NotFound("attachment")
	}
	if err := s.checkRoom(ctx, albumID); err != nil {
		return err
	}
	tag, err := s.db.Exec(ctx, `INSERT INTO album_items (album_id, attachment_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		albumID, attachmentID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		s.itemsChanged(ctx, albumID)
	}
	return nil
}

// take removes an item from the album; the file stays where it was posted.
func (s *Service) take(ctx context.Context, userID, albumID, attachmentID id.ID) error {
	if _, _, err := s.editable(ctx, userID, albumID); err != nil {
		return err
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM album_items WHERE album_id = $1 AND attachment_id = $2`, albumID, attachmentID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("attachment")
	}
	s.itemsChanged(ctx, albumID)
	return nil
}
```

Imports: add `"fmt"`, drop `"errors"` and `pgx` if unused.

(Readable includes DMs; `inScope` joins `messages`/`channels`, and a DM file in a gallery album is impossible because galleries never source DMs — so a DM file reports NOT_IN_GALLERY only to its participants. Acceptable.)

- [ ] **Step 7: Rewrite the handler list in `handlers.go`**

Replace the `list-albums` and `create-album` registrations with:

```go
	type galleryPath struct {
		ID string `path:"id"`
	}
	huma.Register(api, op("list-gallery-albums", http.MethodGet, "/api/channels/{id}/albums", 0),
		func(ctx context.Context, in *galleryPath) (*struct{ Body []Album }, error) {
			gid, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			out, err := s.list(ctx, me(ctx), gid)
			return &struct{ Body []Album }{out}, err
		})

	huma.Register(api, op("create-album", http.MethodPost, "/api/channels/{id}/albums", http.StatusCreated),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body AlbumCreate
		}) (*struct{ Body *Album }, error) {
			gid, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			a, err := s.create(ctx, me(ctx), gid, in.Body)
			return &struct{ Body *Album }{a}, err
		})

	huma.Register(api, op("list-albums-for-file", http.MethodGet, "/api/albums", 0),
		func(ctx context.Context, in *struct {
			Contains string `query:"contains" required:"true" doc:"An attachment ID: the albums you can add it to, and whether each holds it"`
		}) (*struct{ Body []Album }, error) {
			att, err := httpx.ParseID(in.Contains, "attachment")
			if err != nil {
				return nil, err
			}
			out, err := s.listForFile(ctx, me(ctx), att)
			return &struct{ Body []Album }{out}, err
		})
```

If huma's missing-required-query error isn't mapped to `VALIDATION_FAILED` 400, keep `required:"true"` and adjust the test's expected code to what `httpx` maps validation errors to (the old tests expect huma failures as `VALIDATION_FAILED`).

- [ ] **Step 8: Run tests**

Run: `rtk go -C server test ./... `
Expected: PASS (including `files` tests — fix any `files` test that used `album_id`/`UploadTo(…album_id…)`; delete those cases).

- [ ] **Step 9: Stage**

```bash
rtk git add server
```
Suggested message: `feat(server): albums live in a gallery; drop album uploads`

---

### Task 4: Core client and generated types

**Files:**
- Modify: `clients/core/openapi.json`, `clients/core/src/schema.d.ts` (generated)
- Modify: `clients/core/src/client.ts` (`FilesParams`, `files`, album methods)
- Modify: `clients/core/src/client.test.ts` (album tests)

**Interfaces:**
- Consumes: Task 1-3 HTTP API.
- Produces: `FilesParams.gallery?: string`; `client.galleryAlbums(galleryId: string): Promise<Album[]>`; `client.albumsForFile(attachmentId: string): Promise<Album[]>`; `client.createAlbum(galleryId: string, body: { title: string; visibility: AlbumVisibility }): Promise<Album>`. Removed: `client.albums()`, `client.uploadToAlbum()`. `Channel.gallery_sources?: "none"|"all"|"selected"`, `Channel.source_channel_ids?: string[]`, `Album.gallery_id`, `Album.deck`.

- [ ] **Step 1: Regenerate types**

Run: `rtk pnpm --filter @datrope/core gen`
Expected: `openapi.json` and `schema.d.ts` change (new `gallery_sources`, `deck`, `/api/channels/{id}/albums`).

- [ ] **Step 2: Update the client tests (failing)**

In `clients/core/src/client.test.ts` replace the "lists albums…" and "adds a file to an album and uploads into one" tests with:

```ts
it("lists a gallery's albums and the albums a file can join", async () => {
  let url: URL | undefined;
  server.use(
    http.get(`${BASE}/api/channels/300/albums`, ({ request }) => { url = new URL(request.url); return HttpResponse.json([]); }),
    http.get(`${BASE}/api/albums`, ({ request }) => { url = new URL(request.url); return HttpResponse.json([]); }),
  );
  await readyClient().galleryAlbums("300");
  expect(url?.pathname).toBe("/api/channels/300/albums");
  await readyClient().albumsForFile("900");
  expect(url?.searchParams.get("contains")).toBe("900");
});

it("creates an album in a gallery and adds a file to it", async () => {
  let created: unknown;
  let put = "";
  server.use(
    http.post(`${BASE}/api/channels/300/albums`, async ({ request }) => { created = await request.json(); return HttpResponse.json({ id: "7" }, { status: 201 }); }),
    http.put(`${BASE}/api/albums/7/files/900`, ({ request }) => { put = request.url; return new HttpResponse(null, { status: 204 }); }),
  );
  expect((await readyClient().createAlbum("300", { title: "Trip", visibility: "gallery" })).id).toBe("7");
  expect(created).toEqual({ title: "Trip", visibility: "gallery" });
  await readyClient().addToAlbum("7", "900");
  expect(put).toContain("/api/albums/7/files/900");
});
```

and in the existing `files(...)` test (around line 498) pass `gallery: "299"` and add `expect(url?.searchParams.get("gallery")).toBe("299");` (match the variable name that test uses for the captured URL).

Run: `rtk vitest run --root clients/core` — Expected: FAIL (`galleryAlbums` not a function).

- [ ] **Step 3: Implement**

In `client.ts`:

```ts
export type FilesParams = { gallery?: string; kinds?: FileKind[]; channels?: string[]; uploader?: string; q?: string; before?: string; limit?: number };
```

In `files()`, first line after `const query`: `if (p.gallery) query.gallery = p.gallery;`

Replace `albums()`, `createAlbum()` and delete `uploadToAlbum()`:

```ts
  /** A gallery's albums the caller can see, most recently changed first, each with its deck. */
  async galleryAlbums(galleryId: string): Promise<Album[]> {
    return unwrap(this.api.GET("/api/channels/{id}/albums", { params: { path: { id: galleryId } } })) as Promise<Album[]>;
  }

  /** The albums the caller can add this file to (their gallery shows it); each says whether it holds it. */
  async albumsForFile(attachmentId: string): Promise<Album[]> {
    return unwrap(this.api.GET("/api/albums", { params: { query: { contains: attachmentId } } })) as Promise<Album[]>;
  }

  async createAlbum(galleryId: string, body: { title: string; visibility: AlbumVisibility }): Promise<Album> {
    return unwrap(this.api.POST("/api/channels/{id}/albums", { params: { path: { id: galleryId } }, body }));
  }
```

`albumFiles` keeps `Omit<FilesParams, "channels">`; change to `Omit<FilesParams, "channels" | "gallery">`.

- [ ] **Step 4: Run**

Run: `rtk vitest run --root clients/core` then `rtk tsc -p clients/core/tsconfig.json`
Expected: PASS. (`clients/web` will not typecheck yet; that's Tasks 5-10.)

- [ ] **Step 5: Stage**

```bash
rtk git add clients/core
```
Suggested message: `feat(core): gallery-scoped files and albums`

---

### Task 5: Web — drop the global gallery; gallery and album scopes

**Files:**
- Create: `clients/web/src/app/gallery/sources.ts`, `clients/web/src/app/gallery/sources.test.ts`
- Modify: `clients/web/src/router.tsx`, `clients/web/src/app/Home.tsx`, `clients/web/src/app/ServerSidebar.tsx:91-108`
- Modify: `clients/web/src/app/gallery/use-files.ts`, `use-files.test.ts`, `items.ts`
- Modify: `clients/web/src/app/gallery/GalleryView.tsx` (scope plumbing only; layout in Tasks 7-10)
- Modify: `clients/web/src/app/gallery/MusicView.tsx`, `GalleryFilterSheet.tsx`
- Modify: `clients/web/src/app/gallery/albums.ts`, `albums.test.ts`, `AddToAlbum.tsx`, `FileMenu.tsx`, `TileSheet.tsx`, `UploadDialog.tsx`, `AlbumView.tsx`, `AlbumDialog.tsx`
- Modify: `clients/web/src/app/MessageList.tsx`, `clients/web/src/app/MessageSheet.tsx`
- Delete: `clients/web/src/app/gallery/AlbumsView.tsx`

**Interfaces:**
- Consumes: Task 4 client.
- Produces: `GalleryScope = { kind: "gallery"; channelId: string } | { kind: "album"; albumId: string; galleryId: string }`; `inGallery(gallery: Channel, homeId: string): boolean`; `sourceSummary(ch: Channel, channels: Record<string, Channel | undefined>): string`; `itemHome(it: GalleryItem): string | undefined`; `useGalleryAlbums(galleryId: string)`; `useAlbumsForFile(attachmentId: string)`; route `/channels/:channelId/albums/:albumId`; `AlbumDialog` prop `galleryId?: string`; `UploadDialog` prop `target: { channelId: string; albumId?: string }`.

- [ ] **Step 1: Write the failing pure tests**

`clients/web/src/app/gallery/sources.test.ts`:

```ts
import type { Channel } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { inGallery, sourceSummary } from "./sources";

const ch = (id: string, extra: Partial<Channel> = {}) => ({ id, name: id, type: "gallery", ...extra }) as Channel;

describe("inGallery", () => {
  it("always holds the gallery's own posts", () => {
    expect(inGallery(ch("g", { gallery_sources: "none" }), "g")).toBe(true);
    expect(inGallery(ch("g", { gallery_sources: "none" }), "x")).toBe(false);
  });
  it("holds every channel with all, and the picked ones with selected", () => {
    expect(inGallery(ch("g", { gallery_sources: "all" }), "x")).toBe(true);
    expect(inGallery(ch("g", { gallery_sources: "selected", source_channel_ids: ["a"] }), "a")).toBe(true);
    expect(inGallery(ch("g", { gallery_sources: "selected", source_channel_ids: ["a"] }), "b")).toBe(false);
  });
});

describe("sourceSummary", () => {
  const channels = { a: ch("a", { name: "memes", type: "text" }), b: ch("b", { name: "builds", type: "text" }) };
  it("says where files come from", () => {
    expect(sourceSummary(ch("g", { gallery_sources: "none" }), channels)).toBe("");
    expect(sourceSummary(ch("g", { gallery_sources: "all" }), channels)).toBe("from all channels");
    expect(sourceSummary(ch("g", { gallery_sources: "selected", source_channel_ids: ["a"] }), channels)).toBe("posts here + #memes");
    expect(sourceSummary(ch("g", { gallery_sources: "selected", source_channel_ids: ["a", "b", "gone"] }), channels)).toBe("posts here + 2 channels");
  });
});
```

In `use-files.test.ts` replace the `paramsFor` describe with:

```ts
describe("paramsFor", () => {
  it("scopes to the gallery and lets the channel filter narrow it", () => {
    expect(paramsFor({ kind: "gallery", channelId: "g" }, { ...DEFAULT_FILTER, kind: "audio", channels: ["x"], q: " riff " }))
      .toEqual({ gallery: "g", kinds: ["audio"], channels: ["x"], q: "riff", uploader: undefined });
    expect(paramsFor({ kind: "gallery", channelId: "g" }, DEFAULT_FILTER))
      .toEqual({ gallery: "g", kinds: undefined, channels: undefined, q: undefined, uploader: undefined });
  });

  it("does not filter an album by channel", () => {
    const p = paramsFor({ kind: "album", albumId: "7", galleryId: "g" }, { ...DEFAULT_FILTER, channels: ["1"] });
    expect(p.channels).toBeUndefined();
    expect(p.gallery).toBeUndefined();
  });
});
```

Delete the two "album uploads" cases in `dropMessage`/`patchThread` describes (album uploads no longer exist). In `albums.test.ts` delete the `groupAlbums` describe and its import, and change the `album()` helper's `visibility` to `"gallery"`.

Run: `rtk vitest run --root clients/web src/app/gallery` — Expected: FAIL.

- [ ] **Step 2: `sources.ts` and `items.ts`**

`clients/web/src/app/gallery/sources.ts`:

```ts
import type { Channel } from "@datrope/core";

/** Does a gallery show files posted in this channel (a thread counts as its parent)? */
export function inGallery(gallery: Channel, homeId: string): boolean {
  if (homeId === gallery.id) return true;
  if (gallery.gallery_sources === "all") return true;
  return gallery.gallery_sources === "selected" && (gallery.source_channel_ids ?? []).includes(homeId);
}

/** The top bar's note on where a gallery's files come from; "" for a gallery of its own posts. */
export function sourceSummary(ch: Channel, channels: Record<string, Channel | undefined>): string {
  if (ch.gallery_sources === "all") return "from all channels";
  if (ch.gallery_sources !== "selected") return "";
  const known = (ch.source_channel_ids ?? []).map((id) => channels[id]).filter((c): c is Channel => !!c);
  return known.length === 1 ? `posts here + #${known[0].name}` : `posts here + ${known.length} channels`;
}
```

In `items.ts`, update the `GalleryItem` comment to `/** A gallery tile: a file from /api/files or an album. */`, update `itemAuthor`'s comment to `/** Who shared a file: the message's shown author, or the member who uploaded it. */`, and add:

```ts
/** The channel a file was posted in, a thread's file counting as its parent's. */
export function itemHome(it: GalleryItem): string | undefined {
  return it.channel ? it.channel.parent_id || it.channel.id : undefined;
}
```

- [ ] **Step 3: `use-files.ts`**

```ts
export type GalleryScope = { kind: "gallery"; channelId: string } | { kind: "album"; albumId: string; galleryId: string };

export function paramsFor(scope: GalleryScope, f: GalleryFilter): FilesParams {
  const q = f.q.trim();
  return {
    ...(scope.kind === "gallery" && { gallery: scope.channelId }),
    kinds: f.kind === "all" ? undefined : [f.kind],
    channels: scope.kind === "gallery" && f.channels.length ? f.channels : undefined,
    q: q || undefined,
    uploader: f.uploader ?? undefined,
  };
}
```

(The test's first `toEqual` lists `gallery` first; object key order doesn't matter for `toEqual`.)

In the `onEvent` handler, replace the block after `if (type !== "MESSAGE_CREATE" …) return;` through the `if (ch?.type === "dm") return;` line with:

```ts
    const m = data as Message;
    if (!m.attachments?.length) return;
    const ch = channels[m.channel_id];
    if (ch?.type === "dm") return;
    const home = ch?.type === "thread" ? ch.parent_channel_id ?? m.channel_id : m.channel_id;
    const gallery = channels[scope.channelId];
    if (!gallery || !inGallery(gallery, home)) return;
```

(`scope` is narrowed to `gallery` there because the album branch returned.) Import `inGallery` from `./sources`. Update the hook doc: `in a channel this gallery shows`.

- [ ] **Step 4: Routes, Home, sidebar**

`router.tsx`: replace the three `gallery*` routes with

```tsx
        { path: "channels/:channelId/albums/:albumId", element: <GalleryAlbumRoute /> },
        { path: "gallery/*", element: <Navigate to="/" replace /> },
```

and import `GalleryAlbumRoute` instead of `AlbumRoute, AlbumsRoute, GlobalGalleryRoute`.

`Home.tsx`: delete `GlobalGalleryRoute`, `AlbumsRoute`, `AlbumRoute` and the `AlbumsView` import; add

```tsx
/** /channels/:channelId/albums/:albumId — an album inside a gallery. */
export function GalleryAlbumRoute() {
  const { channelId = "", albumId = "" } = useParams();
  return <AlbumView key={albumId} galleryId={channelId} albumId={albumId} />;
}
```

and in `ChannelRoute` the gallery case becomes `<GalleryView key={channelId} scope={{ kind: "gallery", channelId }} />`.

`ServerSidebar.tsx` `ChannelsPane`: remove `onGallery` and the `<Link to="/gallery">…</Link>`; doc becomes `/** The Channels tab body: the channel tree. */`. Remove now-unused imports (`Images`, maybe `Link`/`useMatch` — keep whatever else uses them).

- [ ] **Step 5: GalleryView scope plumbing (no layout change yet)**

In `GalleryView.tsx`:
- `const channelId = given.kind === "gallery" ? given.channelId : given.galleryId;` and `const albumId = given.kind === "album" ? given.albumId : undefined;`
- `const scope = useMemo<GalleryScope>(() => (albumId ? { kind: "album", albumId, galleryId: channelId } : { kind: "gallery", channelId }), [channelId, albumId]);`
- Delete `const global = …`; add `const hasSources = !!ch && ch.gallery_sources !== "none";` and `const showTag = (it: GalleryItem) => itemHome(it) !== channelId;`
- `tags` uses → per tile `global={showTag(it)}`.
- Topbar: delete the whole `global ? (…) : (…)` branch, keep the channel branch (name + topic). Add after the name: `{summary && <span className="truncate text-sm text-muted-foreground">{summary}</span>}` with `const summary = ch && !header ? sourceSummary(ch, channels) : "";` and `const channels = useApp((s) => s.channels);`.
- `main` aria-label: `scope.kind === "album" ? "Album" : ch?.name ?? ""`. If `!ch` (gallery not loaded/visible) → keep the existing `EmptyView` early return, now for both scopes: `if (!ch) return <EmptyView>This channel is not available.</EmptyView>;`
- `ScreenHeader title={<EmojiText text={ch.name} />}`.
- `GallerySegments` shows when `mobile && !header` (all galleries).
- `ChannelFilter` shows when `hasSources` (was `global`); `GalleryFilterSheet global={hasSources}`; `MusicView global={hasSources}`.
- The read-marking `useEffect` and `channelId` usages stay (gallery id).
- `UploadDialog target={{ channelId }}`.

- [ ] **Step 6: MusicView and segments**

`MusicView.tsx`: `const view = filter.view;` (delete the `global ?` and its comment); render the `Tabs` unconditionally (drop `global &&`). Update the component doc: `/** Music: the tracks as tiles or a list, with Play all and Shuffle, and the (personal) playlists. */`. `global` keeps only controlling the channel tag / Channel column.

`GalleryFilterSheet.tsx` `GallerySegments`: values `"files" | "music"` only, `onFiles`/`onMusic` required, no navigation:

```tsx
export type GallerySegment = "files" | "music";

/** Phones' full-width view switch: All files and Music (the audio kind). */
export function GallerySegments({ value, onFiles, onMusic }: { value: GallerySegment; onFiles: () => void; onMusic: () => void }) {
  const go = (v: string) => {
    if (!v || v === value) return; // a click on the selected segment reports ""
    if (v === "music") onMusic();
    else onFiles();
  };
  return (
    <ToggleGroup type="single" variant="outline" aria-label="Gallery view" value={value} onValueChange={go}
      className="mx-4 mt-3 mb-1 w-[calc(100%-2rem)] flex-none">
      {([["files", "All files"], ["music", "Music"]] as const).map(([v, label]) => (
        <ToggleGroupItem key={v} value={v} aria-label={label} className="h-9 flex-1 text-[13px] font-normal text-muted-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground">{label}</ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
```

Remove the `useNavigate` import if unused.

- [ ] **Step 7: Albums hooks and menus**

`albums.ts`: delete `groupAlbums`; replace `useAlbums` with:

```ts
/** Keeps a list of albums fresh: refetched on any album event. */
function useAlbumList(load: () => Promise<Album[]>) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    setError(undefined);
    load().then(setAlbums, (e) => setError(errorText(e))).finally(() => setLoading(false));
  }, [load]);
  useEffect(reload, [reload]);
  useEffect(() => client.onEvent((type) => {
    if (type === "ALBUM_UPDATE" || type === "ALBUM_DELETE" || type === "ALBUM_ITEMS_UPDATE") reload();
  }), [reload]);
  return { albums, loading, error, reload };
}

/** A gallery's albums I can see, each with its deck. */
export function useGalleryAlbums(galleryId: string) {
  return useAlbumList(useCallback(() => client.galleryAlbums(galleryId), [galleryId]));
}

/** The albums I can add this file to, each saying whether it holds it. */
export function useAlbumsForFile(attachmentId: string) {
  return useAlbumList(useCallback(() => client.albumsForFile(attachmentId), [attachmentId]));
}
```

`AddToAlbum.tsx`:

```tsx
import { DropdownMenuCheckboxItem, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { client, errorText, useApp } from "../../session";
import { addAll, useAlbumsForFile } from "./albums";

/** "Lofoten · #photos": albums are named with their gallery, since a file can be in several galleries. */
export function useAlbumLabel() {
  const channels = useApp((s) => s.channels);
  return (a: { title: string; gallery_id: string }) => `${a.title} · #${channels[a.gallery_id]?.name ?? "gallery"}`;
}

/** Albums I can add one file to, as checkboxes: ticking adds it, unticking takes it out. */
export function AddToAlbumItems({ attachmentId, onError }: { attachmentId: string; onError: (message: string) => void }) {
  const { albums, loading, reload } = useAlbumsForFile(attachmentId);
  const label = useAlbumLabel();
  return (
    <>
      {loading && albums.length === 0 && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
      {!loading && albums.length === 0 && <DropdownMenuItem disabled>No albums here yet</DropdownMenuItem>}
      {albums.map((a) => (
        <DropdownMenuCheckboxItem key={a.id} checked={!!a.contains} onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => void (on ? client.addToAlbum(a.id, attachmentId) : client.removeFromAlbum(a.id, attachmentId)).then(reload, (e) => { onError(errorText(e)); reload(); })}>
          {label(a)}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

/** A message's files into one of my albums, from its right-click menu. Its files share a channel, so the first one decides. */
export function AddToAlbumContextItems({ attachmentIds, onError }: { attachmentIds: string[]; onError: (message: string) => void }) {
  const { albums, loading } = useAlbumsForFile(attachmentIds[0]);
  const label = useAlbumLabel();
  return (
    <>
      {!loading && albums.length === 0 && <ContextMenuItem disabled>No albums here yet</ContextMenuItem>}
      {albums.map((a) => (
        <ContextMenuItem key={a.id} onSelect={() => void addAll(a.id, attachmentIds).then((m) => m && onError(m))}>{label(a)}</ContextMenuItem>
      ))}
    </>
  );
}
```

`FileMenu.tsx`: delete the `newAlbum` state, the `AlbumDialog` import and render, the `addAll` import if unused, the `library` variable (always true now — inline its uses), and pass only `attachmentId`/`onError` to `AddToAlbumItems`. Line ~145 `{!item.attachment.album_id && (…)}` → render its children unconditionally.

`TileSheet.tsx`: `AlbumRows` uses `useAlbumsForFile(item.attachment.id)`, lists every returned album (no `mine` filter; they're all editable) labelled with `useAlbumLabel()`, and drops the "New album" row and `onNew`; delete `dialog === "album"` branch and the `AlbumDialog` import; `library` → always true (inline). Keep `dialog === "playlist"`.

`MessageSheet.tsx` `AlbumSheet`: `const { albums } = useAlbumsForFile(attachmentIds[0]);`, list all, label with `useAlbumLabel()`, drop the "New album" row and `onNew`; remove `onNewAlbum` from `MessageSheet` props.

`MessageList.tsx`: delete `newAlbum` state, the `AlbumDialog` import and its render block, the `addAll` import if unused; `AddToAlbumContextItems` loses `onNew`; `MessageSheet` loses `onNewAlbum`.

- [ ] **Step 8: UploadDialog into an album**

`UploadDialog.tsx`: delete `AlbumUpload` and `AlbumFile`; the exported component becomes:

```tsx
/** Uploads files to a gallery as one message, with an optional caption; with albumId, also files them into that album. */
export function UploadDialog({ target, onClose }: { target: { channelId: string; albumId?: string }; onClose: () => void }) {
  return <ChannelUpload channelId={target.channelId} albumId={target.albumId} onClose={onClose} />;
}
```

`ChannelUpload` takes `albumId?: string` and its submit becomes:

```tsx
          void run(async () => {
            await client.send(channelId, caption.trim(), ready);
            if (albumId) {
              const failed = await addAll(albumId, ready.map((a) => a.id));
              if (failed) throw new Error(failed);
            }
            onClose();
          });
```

Import `addAll` from `./albums`. Remove now-unused imports (`errorText`, `formatBytes` only if unused by `FileRow` — `FileRow` uses `formatBytes`, keep it).

- [ ] **Step 9: AlbumDialog and AlbumView**

`AlbumDialog.tsx`: add prop `galleryId?: string` (required when creating); `useState<AlbumVisibility>(album?.visibility ?? "gallery")`; create call `client.createAlbum(galleryId!, { title: t, visibility })`; radio labels: `private` → "Only collaborators", `gallery` → "Everyone in this gallery". The collaborator picker stays.

`AlbumView.tsx`:
- Props `{ galleryId, albumId }: { galleryId: string; albumId: string }`.
- Every `nav("/gallery/albums")` → `nav(\`/channels/${galleryId}\`)`.
- Header: replace the back button and title with a breadcrumb:

```tsx
      {!mobile && <Button variant="ghost" size="icon-sm" asChild aria-label="Back to gallery"><Link to={`/channels/${galleryId}`}><ArrowLeft /></Link></Button>}
      <Link to={`/channels/${galleryId}`} className="flex-none text-muted-foreground hover:text-foreground">#{gallery?.name ?? "gallery"}</Link>
      <span className="text-muted-foreground" aria-hidden>/</span>
      <h2 className="flex-none">{album.title}</h2>
```

  with `const gallery = useApp((s) => s.channels[galleryId]);`.
- Visibility icon: `album.visibility === "gallery" ? Globe : Lock`, labels "Everyone in this gallery" / "Only collaborators"; moderator delete shows for `album.visibility === "gallery"`.
- Upload rights: `const galleryPerms = usePerms(galleryId); const canUpload = canEdit && !!gallery && canPost(gallery, galleryPerms) && hasPerm(galleryPerms, Perm.AttachFiles);` → `canUploadHere={canUpload}`. Import `canPost`.
- `GalleryView scope={{ kind: "album", albumId, galleryId }}`.
- `menuExtra`: only the "Remove from album" item (delete the `album_id` branch, the `removing` state and its `Confirm`).
- Delete-album confirm body: "This deletes the album for everyone. Its files stay where they were posted."
- `UploadDialog target={{ channelId: galleryId, albumId }}`.

Delete `AlbumsView.tsx` and remove `viewChip`/`viewChipActive` exports from `GalleryView.tsx` if nothing else imports them (`rtk grep viewChip clients/web/src`).

- [ ] **Step 10: Run**

Run: `rtk pnpm typecheck && rtk pnpm lint && rtk vitest run --root clients/web`
Expected: PASS.

- [ ] **Step 11: Stage**

```bash
rtk git add clients/web
```
Suggested message: `feat(web): galleries scope their own files; albums live in a gallery`

---

### Task 6: Web — source picker in Create channel and Channel settings

**Files:**
- Create: `clients/web/src/app/gallery/GallerySourcesField.tsx`
- Create: `clients/web/src/app/gallery/GallerySourcesField.test.ts` (pure helper)
- Modify: `clients/web/src/app/dialogs/CreateChannelDialog.tsx`, `clients/web/src/app/dialogs/ChannelSettingsDialog.tsx`, `clients/web/src/app/channel-types.ts`

**Interfaces:**
- Produces: `type SourcesValue = { mode: "none" | "all" | "selected"; ids: string[] }`; `sourcesBody(v: SourcesValue): { gallery_sources: SourcesValue["mode"]; source_channel_ids?: string[] }`; `<GallerySourcesField value onChange selfId? />`.

- [ ] **Step 1: Failing test for the body helper**

`GallerySourcesField.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("../../session", () => ({ useApp: () => undefined }));
import { sourcesBody } from "./GallerySourcesField";

describe("sourcesBody", () => {
  it("sends ids only for picked channels", () => {
    expect(sourcesBody({ mode: "all", ids: ["a"] })).toEqual({ gallery_sources: "all" });
    expect(sourcesBody({ mode: "selected", ids: ["a", "b"] })).toEqual({ gallery_sources: "selected", source_channel_ids: ["a", "b"] });
  });
});
```

Run: `rtk vitest run --root clients/web src/app/gallery/GallerySourcesField` — FAIL.

- [ ] **Step 2: Implement the field**

`clients/web/src/app/gallery/GallerySourcesField.tsx`:

```tsx
import { useId, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { useApp } from "../../session";
import { channelIcon } from "../channel-types";

export type SourcesValue = { mode: "none" | "all" | "selected"; ids: string[] };

const SOURCE_TYPES = new Set(["text", "voice", "webhook", "announcement", "forum", "gallery"]);

const MODES: { value: SourcesValue["mode"]; label: string; description: string }[] = [
  { value: "none", label: "Only this gallery", description: "Just what people post here." },
  { value: "all", label: "Every channel", description: "Plus posts here. New channels join automatically." },
  { value: "selected", label: "Channels I pick", description: "Plus posts here." },
];

/** The create and update request fields for a gallery's sources. */
export function sourcesBody(v: SourcesValue): { gallery_sources: SourcesValue["mode"]; source_channel_ids?: string[] } {
  return v.mode === "selected" ? { gallery_sources: "selected", source_channel_ids: v.ids } : { gallery_sources: v.mode };
}

/** "Show files from": a gallery's sources as three radio cards; "Channels I pick" opens a checklist by category. */
export function GallerySourcesField({ value, onChange, selfId }: { value: SourcesValue; onChange: (v: SourcesValue) => void; selfId?: string }) {
  const id = useId();
  const channels = useApp((s) => s.channels);
  const order = useApp((s) => s.server?.channelIds);
  const categories = useApp((s) => s.server?.categories);
  const groups = useMemo(() => {
    const eligible = (order ?? []).map((cid) => channels[cid]).filter((c) => c && c.id !== selfId && SOURCE_TYPES.has(c.type));
    const cats = Object.values(categories ?? {}).sort((a, b) => a.position - b.position);
    return [
      { id: "", name: "", items: eligible.filter((c) => !c.category_id) },
      ...cats.map((cat) => ({ id: cat.id, name: cat.name, items: eligible.filter((c) => c.category_id === cat.id) })),
    ].filter((g) => g.items.length > 0);
  }, [order, channels, categories, selfId]);
  const toggle = (cid: string, on: boolean) =>
    onChange({ mode: "selected", ids: on ? [...value.ids, cid] : value.ids.filter((x) => x !== cid) });

  return (
    <div className="grid gap-2">
      <span id={`${id}-label`} className="text-sm font-medium">Show files from</span>
      <RadioGroup aria-labelledby={`${id}-label`} value={value.mode} onValueChange={(v) => onChange({ ...value, mode: v as SourcesValue["mode"] })} className="gap-2">
        {MODES.map((m) => (
          <Label key={m.value} htmlFor={`${id}-${m.value}`}
            className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal", value.mode === m.value ? "border-primary bg-accent" : "hover:bg-accent/50")}>
            <RadioGroupItem value={m.value} id={`${id}-${m.value}`} className="mt-0.5" />
            <span className="grid gap-0.5">
              <span className="font-medium">{m.label}</span>
              <span className="text-xs text-muted-foreground">{m.description}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      {value.mode === "selected" && (
        <div role="group" aria-label="Channels" className="grid max-h-56 gap-3 overflow-y-auto rounded-lg border p-3">
          {groups.map((g) => (
            <div key={g.id} className="grid gap-1.5">
              {g.name && <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.name}</span>}
              {g.items.map((c) => {
                const Icon = channelIcon(c.type);
                return (
                  <div key={c.id} className="flex items-center gap-2">
                    <Checkbox id={`${id}-c-${c.id}`} checked={value.ids.includes(c.id)} onCheckedChange={(on) => toggle(c.id, on === true)} />
                    <Label htmlFor={`${id}-c-${c.id}`} className="flex items-center gap-1.5 font-normal">
                      <Icon className="size-4 text-muted-foreground" aria-hidden />{c.name}
                    </Label>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <p className="m-0 text-xs text-muted-foreground">People only see files from channels they can read.</p>
    </div>
  );
}
```

- [ ] **Step 3: Wire the dialogs and copy**

`CreateChannelDialog.tsx`:
- State: `const [sources, setSources] = useState<SourcesValue>({ mode: "none", ids: [] });`
- POST body: add `...(type === "gallery" && sourcesBody(sources))`.
- Replace the gallery hint line with `{type === "gallery" && <GallerySourcesField value={sources} onChange={setSources} />}`.
- Submit disabled also when `type === "gallery" && sources.mode === "selected" && sources.ids.length === 0`.

`ChannelSettingsDialog.tsx` `General`:
- `const [sources, setSources] = useState<SourcesValue>({ mode: ch.gallery_sources ?? "none", ids: ch.source_channel_ids ?? [] });`
- PATCH body: `...(ch.type === "gallery" && sourcesBody(sources))`.
- After the category field: `{ch.type === "gallery" && <GallerySourcesField value={sources} onChange={setSources} selfId={ch.id} />}`.
- Save disabled likewise for an empty pick.

`channel-types.ts` gallery description: `"A wall of photos, videos and files, from here or other channels."`

- [ ] **Step 4: Run**

Run: `rtk pnpm typecheck && rtk pnpm lint && rtk vitest run --root clients/web`
Expected: PASS.

- [ ] **Step 5: Verify in the browser**

Start the dev stack (README "Local development": Postgres, server with `DATROPE_DEV_SERVER`, `pnpm --filter @datrope/web dev`) via `preview_start` (create `.claude/launch.json` if needed). Create a gallery with "Channels I pick", tick #general, save; reopen Channel settings and confirm the selection persisted. Screenshot the dialog.

- [ ] **Step 6: Stage**

```bash
rtk git add clients/web
```
Suggested message: `feat(web): pick a gallery's sources when creating or editing it`

---

### Task 7: Web — justified wall layout

**Files:**
- Create: `clients/web/src/app/gallery/justify.ts`, `clients/web/src/app/gallery/justify.test.ts`
- Create: `clients/web/src/hooks/use-element-width.ts`
- Create: `clients/web/src/app/gallery/Wall.tsx`
- Modify: `clients/web/src/app/gallery/FileTile.tsx` (optional `size`)
- Modify: `clients/web/src/app/gallery/GalleryView.tsx` (grid → wall)

**Interfaces:**
- Produces: `justify(boxes: Box[], width: number, target?: number, gap?: number): Row[]` with `Box = { width?: number | null; height?: number | null }`, `Row = { start: number; end: number; height: number }`; `ratio(b: Box): number`; `useElementWidth<T extends HTMLElement>(): [RefCallback<T>, number]`; `<Wall items width render />`; `FileTile` prop `size?: { width: number; height: number }`.

- [ ] **Step 1: Failing tests**

`justify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { justify, ratio } from "./justify";

const sq = { width: 100, height: 100 };

describe("ratio", () => {
  it("is 1:1 without dimensions and clamped to 0.5–3", () => {
    expect(ratio({})).toBe(1);
    expect(ratio({ width: 0, height: 0 })).toBe(1);
    expect(ratio({ width: 1000, height: 10 })).toBe(3);
    expect(ratio({ width: 10, height: 1000 })).toBe(0.5);
  });
});

describe("justify", () => {
  it("is empty for no boxes or no width", () => {
    expect(justify([], 400)).toEqual([]);
    expect(justify([sq], 0)).toEqual([]);
  });

  it("closes a row once it would be no taller than the target, filling the width exactly", () => {
    const rows = justify([sq, sq, sq, sq], 400, 180, 4);
    expect(rows[0].start).toBe(0);
    expect(rows[0].end).toBe(3);
    expect(rows[0].height).toBeCloseTo((400 - 8) / 3);
    const widths = [0, 1, 2].map(() => rows[0].height * 1);
    expect(widths.reduce((a, b) => a + b, 0) + 8).toBeCloseTo(400);
  });

  it("leaves the last row at the target height", () => {
    const rows = justify([sq, sq, sq, sq], 400, 180, 4);
    expect(rows[1]).toEqual({ start: 3, end: 4, height: 180 });
  });

  it("treats a file without dimensions as square", () => {
    expect(justify([{}, {}, {}], 400, 180, 4)[0].end).toBe(3);
  });
});
```

Run: `rtk vitest run --root clients/web src/app/gallery/justify` — FAIL.

- [ ] **Step 2: Implement `justify.ts`**

```ts
export type Box = { width?: number | null; height?: number | null };
export type Row = { start: number; end: number; height: number };

/** Width over height, 1 when unknown, kept between 0.5 and 3 so one panorama can't flatten a row. */
export function ratio(b: Box): number {
  if (!b.width || !b.height || b.width <= 0 || b.height <= 0) return 1;
  return Math.min(3, Math.max(0.5, b.width / b.height));
}

/** Packs boxes into rows `width` wide, about `target` px tall, each box keeping its aspect ratio.
 *  A row closes as soon as filling the width would make it no taller than target; full rows fill the
 *  width exactly; the last, unfinished row stays at target height. */
export function justify(boxes: Box[], width: number, target = 180, gap = 4): Row[] {
  const rows: Row[] = [];
  if (width <= 0) return rows;
  let start = 0;
  let sum = 0;
  for (let i = 0; i < boxes.length; i++) {
    sum += ratio(boxes[i]);
    const height = (width - (i - start) * gap) / sum;
    if (height <= target) {
      rows.push({ start, end: i + 1, height });
      start = i + 1;
      sum = 0;
    }
  }
  if (start < boxes.length) rows.push({ start, end: boxes.length, height: target });
  return rows;
}
```

- [ ] **Step 3: Width hook, Wall, FileTile size**

`clients/web/src/hooks/use-element-width.ts`:

```ts
import { useCallback, useState, type RefCallback } from "react";

/** The content width of an element, kept current with a ResizeObserver; 0 until it is attached. */
export function useElementWidth<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [width, setWidth] = useState(0);
  const [observer] = useState(() => (typeof ResizeObserver === "undefined" ? undefined
    : new ResizeObserver((es) => setWidth(Math.floor(es[0]?.contentRect.width ?? 0)))));
  const ref = useCallback((el: T | null) => {
    observer?.disconnect();
    if (el) {
      setWidth(Math.floor(el.clientWidth));
      observer?.observe(el);
    }
  }, [observer]);
  return [ref, width];
}
```

`clients/web/src/app/gallery/Wall.tsx`:

```tsx
import type { ReactNode } from "react";
import type { GalleryItem } from "./items";
import { justify, ratio } from "./justify";

const GAP = 4; // px, set inline: Tailwind's gap-1 is 0.25rem = 3.75px with the app's 15px root, which would break the row math
const TARGET = 180;

/** Files in justified rows: each keeps its aspect ratio (files without one are square). */
export function Wall({ items, width, render }: {
  items: GalleryItem[]; width: number; render: (item: GalleryItem, size: { width: number; height: number }) => ReactNode;
}) {
  const rows = justify(items.map((it) => it.attachment), width, TARGET, GAP);
  return (
    <div className="grid" style={{ gap: GAP }}>
      {rows.map((r) => (
        <div key={items[r.start].attachment.id} className="flex" style={{ height: r.height, gap: GAP }}>
          {items.slice(r.start, r.end).map((it) => render(it, { width: ratio(it.attachment) * r.height, height: r.height }))}
        </div>
      ))}
    </div>
  );
}
```

`FileTile.tsx`: add prop `size?: { width: number; height: number }`; outer div:

```tsx
    <div {...press} style={size} className={cn("group relative overflow-hidden", size ? "flex-none rounded-sm" : "aspect-square rounded-md",
      media ? "bg-muted" : "border bg-card", (selected || playing) && "ring-2 ring-primary")}>
```

and the image `attachmentImage(a, size ? Math.ceil(Math.max(size.width, size.height)) : 240, { cover: true })`.

- [ ] **Step 4: Use it in GalleryView**

In `GalleryView.tsx` add `const [wallRef, wallWidth] = useElementWidth<HTMLDivElement>();`. Replace the files grid block:

```tsx
              <div className="grid content-start gap-6 px-2 pt-2 pb-24">
                <div ref={wallRef} aria-hidden className="h-0" />
                {groups.map((g) => (
                  <section key={g.label} aria-label={g.label}>
                    <h3 className="mx-2 mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.label}</h3>
                    <Wall items={g.items} width={wallWidth} render={(it, size) => (
                      <FileTile key={it.attachment.id} item={it} size={size} global={showTag(it)} playing={false}
                        selected={selected?.attachmentId === it.attachment.id} onOpen={() => openItem(it)}
                        onPlay={it.kind === "audio" ? () => playFrom(it) : undefined} onLongPress={mobile ? () => setSheetItem(it) : undefined}
                        menu={<FileMenu item={it} items={files.items} extra={menuExtra?.(it)} />} />
                    )} />
                  </section>
                ))}
                {files.hasMore && ( /* unchanged sentinel + Load more */ )}
              </div>
```

(`pb-24` leaves room for the floating filter pill from Task 9. The zero-height measuring div sits in the same padded column as the sections, so its width is the wall width.)

- [ ] **Step 5: Run and look**

Run: `rtk vitest run --root clients/web && rtk pnpm typecheck`
Expected: PASS. In the preview, open a gallery with mixed portrait/landscape images: rows fill edge to edge, last row not stretched, resizing the window reflows. Screenshot.

- [ ] **Step 6: Stage**

```bash
rtk git add clients/web
```
Suggested message: `feat(web): gallery files as a justified wall`

---

### Task 8: Web — album deck row

**Files:**
- Create: `clients/web/src/app/gallery/AlbumDecks.tsx`
- Modify: `clients/web/src/app/gallery/GalleryView.tsx`

**Interfaces:**
- Consumes: `useGalleryAlbums` (Task 5), `AlbumDialog` with `galleryId` (Task 5), `Album.deck` (Task 4).
- Produces: `<AlbumDecks galleryId />` — a `section` labelled "Albums" with one link per album (name "<title>, <n> items[, private]") and a "New album" button.

- [ ] **Step 1: Implement**

`clients/web/src/app/gallery/AlbumDecks.tsx`:

```tsx
import type { Album } from "@datrope/core";
import { Lock, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ErrorText } from "@/components/error-text";
import { attachmentImage } from "@/lib/sized-image";
import { cn } from "@/lib/utils";
import { AlbumDialog } from "./AlbumDialog";
import { useGalleryAlbums } from "./albums";

/** Back to front: the third-newest image at the back, tilted left; the newest on top. */
const TILT = ["-rotate-8 -translate-x-2.5 group-hover:-rotate-12 group-hover:-translate-x-4", "rotate-6 translate-x-2.5 group-hover:rotate-10 group-hover:translate-x-4", ""];

const count = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/** A gallery's albums as fanned decks of their newest images, then a New album slot. */
export function AlbumDecks({ galleryId }: { galleryId: string }) {
  const { albums, error } = useGalleryAlbums(galleryId);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  return (
    <section aria-label="Albums" className="flex-none">
      <ul className="m-0 flex list-none gap-2 overflow-x-auto overscroll-x-contain px-3 pt-3 pb-1">
        {albums.map((a) => <li key={a.id} className="flex-none"><Deck album={a} galleryId={galleryId} /></li>)}
        <li className="flex-none">
          <button type="button" onClick={() => setCreating(true)}
            className="grid h-[132px] w-28 place-items-center rounded-md border border-dashed text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <span className="grid justify-items-center gap-1"><Plus className="size-5" aria-hidden />New album</span>
          </button>
        </li>
      </ul>
      <ErrorText error={error} />
      {creating && <AlbumDialog galleryId={galleryId} onClose={() => setCreating(false)}
        onSaved={(a) => nav(`/channels/${galleryId}/albums/${a.id}`)} />}
    </section>
  );
}

function Deck({ album: a, galleryId }: { album: Album; galleryId: string }) {
  const cards = a.deck ?? [];
  const label = `${a.title}, ${count(a.item_count)}${a.visibility === "private" ? ", private" : ""}`;
  return (
    <Link to={`/channels/${galleryId}/albums/${a.id}`} aria-label={label}
      className="group grid w-36 justify-items-center gap-1 rounded-md p-1 no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="relative h-24 w-full" aria-hidden>
        {[2, 1, 0].map((i, layer) => (
          <span key={i} className={cn("absolute inset-x-5 inset-y-1 overflow-hidden rounded-md border-2 border-card bg-muted shadow-md transition-transform duration-200", TILT[layer])}>
            {cards[i] && <img {...attachmentImage(cards[i], 160, { cover: true })} alt="" loading="lazy" className="size-full object-cover" />}
          </span>
        ))}
      </span>
      <span className="max-w-full truncate text-[13px] font-semibold text-foreground">{a.title}</span>
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {a.visibility === "private" && <Lock className="size-3" aria-hidden />}{count(a.item_count)}
      </span>
    </Link>
  );
}
```

Check that `rotate-8`, `rotate-10`, `-rotate-12` compile in Tailwind v4 (numeric rotate values are allowed in v4); if the build drops them, use arbitrary values `rotate-[8deg]`. Add `motion-reduce:transition-none` to the card class.

- [ ] **Step 2: Mount it**

In `GalleryView.tsx`, just inside the scroll container before the files block: `{scope.kind === "gallery" && !music && <AlbumDecks galleryId={channelId} />}`. Remove the "No files yet." early-return wrapping so decks show even when the gallery is empty (move the empty/loading messages below the decks).

- [ ] **Step 3: Run and look**

Run: `rtk pnpm typecheck && rtk pnpm lint`
Expected: PASS. In the preview: create an album from "New album", add two images to it, return to the gallery — the deck shows the newest on top, fans on hover; a private album shows the lock. Screenshot.

- [ ] **Step 4: Stage**

```bash
rtk git add clients/web
```
Suggested message: `feat(web): albums as decks above the gallery wall`

---

### Task 9: Web — thin top bar and floating filter pill

**Files:**
- Modify: `clients/web/src/app/gallery/GalleryView.tsx`
- Modify: `clients/web/src/app/gallery/ChannelFilter.tsx` (compact trigger class only)

**Interfaces:**
- Produces: desktop filters in a `role="toolbar"` labelled "Filters", fixed to the bottom centre of the gallery; search moves into the top bar actions. Accessible names unchanged.

- [ ] **Step 1: Restructure the desktop chrome**

In `GalleryView.tsx`:
- `main` gets `relative`.
- Desktop `TopBar` actions (non-`header` case): 

```tsx
<>
  <div className="relative w-56">{/* the existing Search files input + Clear search button, unchanged */}</div>
  {canUpload && <Button size="sm" onClick={() => setUploading(true)}><Upload /> Upload</Button>}
</>
```

  For the album `header` case, put the same search box before `canUploadHere && …Upload`.
- Desktop: delete the `border-b` filter bar. Render instead, after the scroll container and only when `!mobile`:

```tsx
        <div role="toolbar" aria-label="Filters"
          className="absolute bottom-4 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-full border bg-popover/95 p-1.5 shadow-lg backdrop-blur">
          <div role="group" aria-label="Show" className="flex flex-none gap-1">{/* the existing All + KIND_ORDER toggles, unchanged */}</div>
          {hasSources && <ChannelFilter value={filter.channels} onChange={(channels) => setFilter({ channels })} />}
          <NativeSelect id={uploaderId} size="sm" aria-label="Uploaded by" value={filter.uploader ?? ""} onChange={(e) => setFilter({ uploader: e.target.value || null })}
            className="h-7 rounded-full">
            <NativeSelectOption value="">Anyone</NativeSelectOption>
            {uploaders.map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
          </NativeSelect>
          <span className="flex-none px-2 text-[13px] text-muted-foreground">{count}</span>
        </div>
```

  (The visible "Uploaded by" `<label>` becomes `aria-label`; keep `id={uploaderId}` for stability.)
- Mobile keeps its current filter row (search toggle, kind chips, filter sheet) unchanged.

`ChannelFilter.tsx` trigger: add `rounded-full` to its class list so it matches the pill.

- [ ] **Step 2: Run and look**

Run: `rtk pnpm typecheck && rtk pnpm lint`
Expected: PASS. In the preview: pill floats over the wall bottom-centre, the last row isn't hidden behind it (pb-24), kind chips/channel/person filters still work, search in the top bar filters. Check at 768px width that the pill scrolls horizontally instead of overflowing. Screenshot.

- [ ] **Step 3: Stage**

```bash
rtk git add clients/web
```
Suggested message: `feat(web): floating filter pill and thin gallery top bar`

---

### Task 10: Web — full-screen lightbox

**Files:**
- Modify: `clients/web/src/app/gallery/GalleryItemPanel.tsx` (container and preview only; `Comments`, `CommentList`, `FirstComment` unchanged)
- Modify: `clients/web/src/app/gallery/GalleryView.tsx` (nothing beyond what renders it, if the props stay the same)

**Interfaces:**
- Produces: `GalleryItemPanel` (same props) renders a `role="dialog"` `aria-modal` overlay labelled `"<Kind> details"` (e.g. "Photo details"): media left with Previous/Next, details + comments column on the right (below on phones). Escape closes; ←/→ step when focus isn't in a text field.

- [ ] **Step 1: Replace the container**

In `GalleryItemPanel.tsx`:
- Remove the `SidePanel` import.
- Add a frame component:

```tsx
/** The full-screen frame: the media fills the left, the details and comments slide in on the right (below on phones). */
function Lightbox({ label, onClose, media, children }: { label: string; onClose: () => void; media: ReactNode; children: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  return (
    <div role="dialog" aria-modal="true" aria-label={label}
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm md:flex-row"
      onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } }}>
      <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center p-4 md:p-10">{media}</div>
      <aside className="flex max-h-[55%] min-h-0 flex-none flex-col border-t bg-card animate-in slide-in-from-bottom md:max-h-none md:w-[380px] md:border-t-0 md:border-l md:slide-in-from-right motion-reduce:animate-none">
        <div className="flex flex-none items-center justify-end gap-1 px-2 pt-2">
          <Button ref={close} variant="ghost" size="icon-sm" aria-label="Close details" onClick={onClose}><X /></Button>
        </div>
        {children}
      </aside>
    </div>
  );
}
```

  `Button` must forward refs for `ref={close}`; if it doesn't (React 18, generated component), use a plain `<button type="button" ref={close} …>` styled with `buttonVariants({ variant: "ghost", size: "icon-sm" })`. Import `useRef`, `X`.

- In the main component, the arrow keys:

```tsx
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable=true]")) return;
      if (e.key === "ArrowLeft") go(i - 1);
      if (e.key === "ArrowRight") go(i + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
```

  (placed after `go`/`i` are defined; `go` already ignores out-of-range indexes because `items[to]` is undefined.) Because hooks can't follow the early `return` for the loading state, move this effect above that `return` and compute `i`/`go` before it (they only need `items` and `attachmentId`).

- Loading state: `return <Lightbox label="Item" onClose={onClose} media={<p className="text-sm text-muted-foreground">Loading…</p>}><span /></Lightbox>;`
- The `media` node: the preview at full size with the prev/next and actions overlaid:

```tsx
  const media = (
    <>
      {kind === "video" ? <div className="w-full max-w-5xl"><VideoPlayer key={attachment.id} attachment={attachment} /></div>
        : kind === "image" ? <img {...attachmentImage(attachment, 1600)} alt={attachment.filename} className="max-h-full max-w-full rounded-sm object-contain" />
        : kind === "audio" ? <div className="w-full max-w-md"><AudioPlayer key={attachment.id} attachment={attachment} /></div>
        : (
          <div className="grid justify-items-center gap-2 rounded-lg bg-card p-8">
            <span className="grid h-16 w-13 place-items-end justify-center rounded-md bg-secondary pb-2 text-[11px] font-bold text-foreground" aria-hidden>{extension(attachment.filename)}</span>
            <span className="text-center text-sm font-semibold wrap-anywhere">{attachment.filename}</span>
          </div>
        )}
      {kind === "image" && <ImageViewer images={[attachment]} index={viewing} onIndexChange={setViewing} />}
      <div className="absolute top-3 right-3 flex gap-1">{actions}</div>
      {i >= 0 && (
        <>
          <Button variant="secondary" size="icon" className="absolute top-1/2 left-3 -translate-y-1/2 rounded-full" aria-label="Previous item" disabled={i === 0}
            onClick={() => go(i - 1)}><ChevronLeft /></Button>
          <Button variant="secondary" size="icon" className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full" aria-label="Next item" disabled={i === items.length - 1}
            onClick={() => go(i + 1)}><ChevronRight /></Button>
          <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-2.5 py-0.5 text-xs text-muted-foreground tabular-nums">{i + 1} of {items.length}</span>
        </>
      )}
    </>
  );
```

- The returned tree: `<Lightbox label={\`${KIND_SINGULAR[kind]} details\`} onClose={onClose} media={media}>` containing, in a scrollable column: the title (`<h2 className="m-0 px-4 text-sm font-semibold">{itemTitle({ message, attachment })}</h2>`), `extraActions`, the author block, the `dl`, then the existing comments section (thread link or `<Comments …/>`). Wrap the non-comment parts in `<div className="flex-none overflow-y-auto border-b">` as before so comments keep the flex-1 area. Delete the old 512px preview and the old prev/next row.

- [ ] **Step 2: Update e2e selectors in the first gallery test**

In `clients/web/e2e/chat.spec.ts` (gallery part of "announcement, forum and gallery channels"): `bob.getByRole("complementary", { name: "Photo details" })` → `bob.getByRole("dialog", { name: "Photo details" })`.

- [ ] **Step 3: Run and look**

Run: `rtk pnpm typecheck && rtk pnpm lint && rtk vitest run --root clients/web`
Expected: PASS. In the preview: click a tile → full-screen; ←/→ steps; typing a comment doesn't step; Escape closes (and Escape inside an open emoji picker closes only the picker); on a 375px viewport the comments sit below the media. Screenshots desktop + mobile.

- [ ] **Step 4: Stage**

```bash
rtk git add clients/web
```
Suggested message: `feat(web): full-screen lightbox for gallery items`

---

### Task 11: E2E — galleries with sources and albums in a gallery

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts` (replace the "global gallery…" and "albums…" tests)

- [ ] **Step 1: Replace "global gallery: files from readable channels, music player and playlists"**

```ts
// Runs after the first tests: alice and bob exist; #general is shared.
test("gallery sources: files from other channels, music player and playlists", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");

  const CSRF = { "X-Datrope-CSRF": "1" };
  const put = (path: string, data: object) => alice.request.put(path, { headers: CSRF, data });

  // alice shares a song in #general and a picture in a channel only she can see.
  await alice.getByRole("link", { name: "general" }).click();
  await alice.locator('input[type="file"]').setInputFiles({ name: "riff-idea.wav", mimeType: "audio/wav", buffer: silentWav() });
  await expect(alice.getByRole("list", { name: "Attachments" })).not.toContainText("Uploading");
  await alice.getByRole("button", { name: "Send" }).click();
  const server = await (await alice.request.get("/api/server")).json() as { id: string };
  const priv = await (await alice.request.post("/api/server/channels", { headers: CSRF, data: { name: "alice-only", type: "text" } })).json() as { id: string };
  expect((await put(`/api/channels/${priv.id}/overrides/role/${server.id}`, { allow: 0, deny: 1 })).ok()).toBe(true);
  await alice.getByRole("link", { name: "alice-only" }).click();
  await alice.locator('input[type="file"]').setInputFiles({ name: "secret.png", mimeType: "image/png", buffer: solidPng(8, 8) });
  await expect(alice.getByRole("list", { name: "Attachments" })).not.toContainText("Uploading");
  await alice.getByRole("button", { name: "Send" }).click();
  await expect(alice.getByRole("main").getByRole("img", { name: "secret.png" })).toBeVisible();

  // There is no built-in gallery; alice makes one that shows every channel.
  await expect(bob.getByRole("link", { name: "Gallery", exact: true })).toHaveCount(0);
  await createChannel(alice, "Gallery", "everything");
  await alice.getByRole("dialog", { name: "Create a channel" }).getByRole("radio", { name: /Every channel/ }).click();
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  const galleryId = new URL(alice.url()).pathname.split("/").pop()!;

  // bob sees the song, tagged #general; the private picture is not there.
  await bob.getByRole("link", { name: "everything" }).click();
  const gallery = bob.getByRole("main", { name: "everything" });
  await expect(gallery.getByText("from all channels")).toBeVisible();
  await expect(gallery.getByRole("button", { name: "Track: riff-idea.wav, by alice, in #general" })).toBeVisible();
  await expect(gallery.getByRole("button", { name: /secret\.png/ })).toHaveCount(0);

  // Search and the Music filter, the player and a playlist.
  await bob.getByLabel("Search files").fill("riff");
  await expect(gallery.getByRole("button", { name: /riff-idea\.wav/ }).first()).toBeVisible();
  await bob.getByRole("toolbar", { name: "Filters" }).getByRole("group", { name: "Show" }).getByRole("button", { name: "Music" }).click();
  await gallery.getByRole("button", { name: "Play all" }).click();
  await expect(bob.getByRole("region", { name: "Music player" })).toContainText("riff-idea.wav");
  await gallery.getByRole("button", { name: "More for riff-idea.wav" }).click();
  await bob.getByRole("menuitem", { name: "Add to playlist" }).click();
  await bob.getByRole("menuitem", { name: "New playlist…" }).click();
  await bob.getByLabel("Name", { exact: true }).fill("Bob's riffs");
  await bob.getByRole("button", { name: "Create" }).click();
  await gallery.getByRole("tab", { name: "Playlists" }).click();
  await gallery.getByRole("button", { name: "Open Bob's riffs" }).click();
  await expect(gallery.getByRole("table", { name: "Tracks" })).toContainText("riff-idea");

  // Narrowed to alice-only, the gallery shows bob nothing: a source never grants access.
  const patched = await alice.request.patch(`/api/channels/${galleryId}`, { headers: CSRF, data: { gallery_sources: "selected", source_channel_ids: [priv.id] } });
  expect(patched.ok()).toBe(true);
  await bob.goto(`/channels/${galleryId}`);
  await expect(bob.getByRole("main", { name: "everything" }).getByText("No files yet.")).toBeVisible();
});
```

(If the Playwright `getByLabel("Search files")` matches both the top-bar input and nothing else, keep it unscoped; it's outside `main`'s scroll area but inside `main`, so `gallery.getByLabel` also works.)

- [ ] **Step 2: Replace "albums: collect a channel file, upload into the album, share it with the server"**

```ts
// Runs after the first tests: alice and bob exist; #general is shared.
test("albums live in a gallery: collect a file, upload into the album, share it with the gallery", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");

  await alice.getByRole("link", { name: "general" }).click();
  await alice.locator('input[type="file"]').setInputFiles({ name: "harbour.png", mimeType: "image/png", buffer: solidPng(8, 8) });
  await expect(alice.getByRole("list", { name: "Attachments" })).not.toContainText("Uploading");
  await alice.getByRole("button", { name: "Send" }).click();

  // A gallery fed by #general, picked in the dialog.
  await createChannel(alice, "Gallery", "trips");
  const dialog = alice.getByRole("dialog", { name: "Create a channel" });
  await dialog.getByRole("radio", { name: /Channels I pick/ }).click();
  await dialog.getByRole("group", { name: "Channels" }).getByRole("checkbox", { name: "general" }).click();
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  const trips = alice.getByRole("main", { name: "trips" });
  await expect(trips.getByRole("button", { name: /^Photo: harbour.png/ })).toBeVisible();

  // A private album from the deck row, then the #general picture into it.
  await trips.getByRole("region", { name: "Albums" }).getByRole("button", { name: "New album" }).click();
  await alice.getByLabel("Name").fill("Lofoten");
  await alice.getByRole("radio", { name: "Only collaborators" }).click();
  await alice.getByRole("button", { name: "Create" }).click();
  await expect(alice.getByRole("heading", { name: "Lofoten" })).toBeVisible();
  await alice.getByRole("link", { name: "trips" }).first().click();
  await trips.getByRole("button", { name: /harbour\.png/ }).first().hover();
  await trips.getByRole("button", { name: "More for harbour.png" }).click();
  await alice.getByRole("menuitem", { name: "Add to album" }).click();
  await alice.getByRole("menuitemcheckbox", { name: /Lofoten/ }).click();
  await alice.keyboard.press("Escape");

  // Upload into the album: it is posted in the gallery and filed into the album.
  await trips.getByRole("link", { name: /^Lofoten, / }).click();
  const album = alice.getByRole("main", { name: "Album" });
  await expect(album.getByRole("button", { name: /^Photo: harbour.png/ })).toBeVisible();
  await album.getByRole("button", { name: "Upload" }).click();
  const upload = alice.getByRole("dialog", { name: "Upload files" });
  const chooser = alice.waitForEvent("filechooser");
  await upload.getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles({ name: "fjord.png", mimeType: "image/png", buffer: solidPng(8, 8) });
  await expect(upload.getByRole("list", { name: "Files" })).not.toContainText("Uploading");
  await upload.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(album.getByRole("button", { name: /^Photo: fjord.png/ })).toBeVisible();

  // bob doesn't see the private album; shared with the gallery, he sees both files.
  await bob.getByRole("link", { name: "trips" }).click();
  const bobTrips = bob.getByRole("main", { name: "trips" });
  await expect(bobTrips.getByRole("region", { name: "Albums" }).getByRole("button", { name: "New album" })).toBeVisible();
  await expect(bobTrips.getByRole("link", { name: /^Lofoten, / })).toHaveCount(0);
  await alice.getByRole("button", { name: "Album settings" }).click();
  await alice.getByRole("radio", { name: "Everyone in this gallery" }).click();
  await alice.getByRole("button", { name: "Save" }).click();
  await bobTrips.getByRole("link", { name: /^Lofoten, / }).click();
  const bobAlbum = bob.getByRole("main", { name: "Album" });
  await expect(bobAlbum.getByRole("button", { name: /^Photo: harbour.png/ })).toBeVisible();
  await expect(bobAlbum.getByRole("button", { name: /^Photo: fjord.png/ })).toBeVisible();
  await expect(bobAlbum.getByRole("button", { name: "Upload" })).toHaveCount(0);
});
```

Note: the `section aria-label="Albums"` has role `region` only when labelled — it is, so `getByRole("region", { name: "Albums" })` works. If the album's breadcrumb link also matches `getByRole("link", { name: "trips" })`, the `.first()` picks the sidebar one (it renders earlier); if not, scope to `alice.getByRole("navigation")` or whatever the sidebar landmark is.

- [ ] **Step 3: Run the e2e suite**

Run: `rtk pnpm --filter @datrope/web e2e` (with the e2e stack up as in `clients/web/playwright.config.ts` / `deploy/docker-compose.e2e.yml`).
Expected: PASS. If a selector fails, fix the selector or the accessible name in the component — keep names stable per Global Constraints.

- [ ] **Step 4: Full checks**

Run: `rtk go -C server test ./... && rtk pnpm typecheck && rtk pnpm lint && rtk pnpm test`
Expected: all PASS.

- [ ] **Step 5: Stage**

```bash
rtk git add clients/web/e2e
```
Suggested message: `test(e2e): gallery sources and albums in a gallery`

---

## Self-review notes (done while writing)

- Spec coverage: data model → Tasks 1, 3; source rules → 1, 2; API → 1-4; UI wall → 7; decks → 8; pill/topbar → 9; lightbox → 10; picker → 6; removals/fixes (routes, sidebar, add-to-album, copy, playlists) → 5, 6; error handling (`NOT_IN_GALLERY`, invalid sources, gallery deleted cascade, source removed) → 1-3; testing → every task + 11.
- Spec deviations recorded in the spec itself: `GET /api/albums?contains=` kept for "Add to album"; `cover` → `deck`; "New album" only from the deck row; playlists in every gallery's Music view; two migrations.
- Names used across tasks: `GalleryScope` (Go + TS type, different packages), `inGallery`, `sourceSummary`, `itemHome`, `useGalleryAlbums`, `useAlbumsForFile`, `useAlbumLabel`, `SourcesValue`, `sourcesBody`, `justify`, `ratio`, `useElementWidth`, `Wall`, `AlbumDecks`.
