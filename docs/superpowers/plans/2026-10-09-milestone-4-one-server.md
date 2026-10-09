# Milestone 4: One Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the instance into one server: no communities in the API or UI, registration makes you a member, a new app layout from the mockups (Channels/Messages tabs, voice panel and profile strip), a server settings area (overview, look with palettes, icon and banner, sign-ups, uploads, invites, bans, members, roles with colours and hierarchy), and a welcome channel the admin writes in Markdown with an optional rules gate.

**Architecture:** The database keeps its `communities` tables; exactly one row (`is_server`) remains, created when the first user registers, and every other package keeps calling the communities service with that row's ID (`ServerID`). Routes, JSON and events lose community IDs (`/api/server/...`, `SERVER_UPDATE`). The files package stores the server icon and banner. The communities package owns the welcome page and the rules gate; the gate is applied where permissions are computed (`channels.effective`). The web client is rebuilt around a single server state.

**Tech Stack:** existing Go/Huma/pgx/goose server · `@datrope/core` (zustand, openapi-fetch, Vitest) · React 18 + Tailwind v4 + shadcn/ui · `react-markdown` 9.0.1 + `remark-gfm` 4.0.0 (welcome page) · Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-one-server-design.md` (§2 decisions, §3 domain model, §4 permissions, §5 API, §6 M4, §7 edge cases) amending `docs/superpowers/specs/2026-10-08-datrope-architecture-design.md`.

**Mockups (visual source of truth for the UI tasks):** `docs/superpowers/mockups/` — `Main.dc.html` (app layout), `DMs.dc.html` (Messages view), `Welcome.dc.html`, `WelcomeEdit.dc.html`, `SettingsLook.dc.html`, `SettingsRoles.dc.html`, and `datrope-logo.svg` (the mark, `fill="currentColor"`). They are static HTML: read them for layout, spacing, copy and states; build the real thing from the app's shadcn components and tokens (not by pasting their markup).

## Global Constraints

- **Never commit.** (CLAUDE.md §5.) Each task ends with a *Checkpoint*: the controller stages the task with `git add` after review; nobody commits.
- **One server per instance.** No rail, no "create community", no community IDs in the API or UI. Registering makes you a member.
- **Kick** removes membership (the account can come back only with a new invite); **ban** removes membership, blocks rejoining and revokes sessions.
- **Palettes:** `emerald` `#2ecc71`, `ocean` `#4aa3ff`, `violet` `#a78bfa`, `amber` `#f5a524`, `rose` `#fb7185`, `mint` `#2dd4bf`. The palette sets `--primary` and `--ring` for everyone; dark text (`#131313`) stays readable on all six. The Datrope mark is drawn in the accent when no icon is uploaded. Dark theme only.
- **Welcome page:** Markdown (images and channel cards `[[channel:<name> "<description>"]]`), banner, optional rules gate. While the gate is on and a member has not accepted, they see **only the welcome page** (their permissions are `VIEW_CHANNEL` on the welcome channel and nothing else).
- **DMs are their own view**; the sidebar switches between **Channels** and **Messages** tabs; the voice panel and profile strip stay at the bottom of both, on the `card` surface.
- **Role hierarchy:** roles are ordered (higher `position` = higher rank). You can only create, edit, delete, reorder or hand out roles below your highest role, and only moderate (kick, ban, voice-mute, move, disconnect, delete messages of) members whose highest role is below yours. The owner is above everyone; nobody moderates the owner.
- **Permissions** (bit values must match server and client): existing 0–16 unchanged, `MANAGE_COMMUNITY` (bit 15) is renamed `MANAGE_SERVER`; new `ADD_REACTIONS` = bit 17, `CREATE_THREADS` = 18, `USE_SOUNDBOARD` = 19, `MANAGE_EXPRESSIONS` = 20. `@everyone` gets `ADD_REACTIONS`, `CREATE_THREADS`, `USE_SOUNDBOARD` by default.
- Web UI: shadcn/ui components first (add missing ones with the shadcn CLI from `clients/web`; on this exFAT drive its install step may fail after writing the file — check the file exists and fix a stray `cn` import to `@/lib/utils`); style with existing tokens only (no hex colours outside `src/styles.css`, except the palette table, which lives in one module).
- Project conventions (still binding): Go `go 1.25.6`, `GOTOOLCHAIN=local`; Huma path params declared on input structs; nil slices initialised non-nil server-side, `?? []` client-side; packages talk through consumer-declared interfaces; Go DB tests via `apptest`/`pgtest` (and `lktest` only in the voice package); Go tests run from PowerShell on Windows.
- Out of scope for M4: reactions, threads, emoji, soundboard, Markdown in messages, categories (M5–M7); notifications and mutes; the desktop app.

## Decisions this plan makes (confirm with the user if any matter)

1. The server row is created by the first registration (owned by that user, named "Datrope", with `#welcome` and `#general`). A database with users but no community gets one at startup, owned by the oldest user, with every user a member.
2. Existing data: the oldest community becomes the server; other communities' channels move into it renamed `<community> · <channel>` (categories come in M6) and lose their role overrides; every non-disabled, non-banned user becomes a member; the other communities are deleted with their roles, invites and bans. The "allow community creation" setting is removed.
3. A user who is not a member (kicked) gets `READY` without `server`, and the web app shows a "You are not a member" page with an invite field (`POST /api/invites/{code}/accept` rejoins). `GET /api/server…` answers 403 `NOT_A_MEMBER` for them.
4. Leaving the server is not offered (spec: leaving = deleting your account, which is not built yet). The owner cannot be kicked or banned.
5. Server icon and banner: PNG, JPEG, WebP or GIF, at most 8 MB, EXIF stripped; served without authentication at `/api/server/icon` and `/api/server/banner` (the sign-in page may show them).
6. Gated members (rules not accepted) get a `READY` with the server, its roles and only the welcome channel — no members, presences, voice states or DMs — and cannot start DMs. Accepting publishes `MEMBER_UPDATE` and the client reconnects for a full `READY`.
7. The welcome channel cannot be deleted, renamed to another type or receive messages; its page is at most 50 000 characters; the gate cannot be on while the page is empty.
8. Custom status: up to 80 characters, part of `PublicUser` (`custom_status`), edited from the profile strip and Your settings.
9. Role colours come from a fixed set of eight (`#e74c3c`, `#f5a524`, `#2ecc71`, `#2dd4bf`, `#4aa3ff`, `#a78bfa`, `#fb7185`, `#969da2`) or none; "show separately" (`hoist`) groups members in the member list. Reordering roles in M4 uses up/down buttons (drag-and-drop comes with channel reordering in M6).

## File Structure

```
server/internal/db/migrations/00007_server.sql        one server, palette, description; drops allow_community_creation
server/internal/db/migrations/00008_server_images.sql server icon/banner (files)
server/internal/db/migrations/00009_welcome.sql       welcome channel type, welcome page, accepted_rules_at
server/internal/db/migrations/00010_roles_status.sql  role colour/hoist, new permission bits, custom status
server/internal/communities/   Server type, ServerID, EnsureServer, Join; /api/server routes; welcome page + gate; hierarchy
server/internal/auth/          Joiner hook (every registration joins), custom_status, settings without community creation
server/internal/channels/      /api/server/channels, welcome channel, gate in effective()
server/internal/files/         server_images: upload, serve, GC
server/internal/messages/      no messages in the welcome channel; hierarchy for deleting others' messages
server/internal/voice/         hierarchy for voice moderation
server/internal/perms/         renamed and new flags
server/internal/app/           READY server, wiring, startup EnsureServer, schemas
server/internal/apptest/       server helpers (Server, Invite, Outsider)
clients/core/src/              single server state, server/welcome/role/member APIs, perms flags
clients/web/src/               new layout, palette + logo, welcome page + editor, server settings, not-a-member page
clients/web/e2e/chat.spec.ts   rewritten for the one-server flow
```

---

### Task 1: The server (collapse communities)

**Files:**
- Create: `server/internal/db/migrations/00007_server.sql`
- Modify: `server/internal/communities/communities.go`, `invites.go`, `roles.go` (routes only), Replace: `handlers.go`
- Modify: `server/internal/auth/service.go`, `handlers.go`, `admin.go`, `store.go` (Joiner, settings)
- Modify: `server/internal/channels/channels.go`, `handlers.go` (routes, JSON)
- Modify: `server/internal/app/app.go`, `realtime.go`; `server/internal/voice/reconcile.go` (event list)
- Modify: `server/internal/apptest/apptest.go` (helpers)
- Modify: every Go test that used community routes or helpers: `communities/communities_test.go`, `communities/roles_test.go`, `channels/channels_test.go`, `messages/messages_test.go`, `gateway/gateway_test.go`, `files/files_test.go`, `voice/helpers_test.go`, `voice/reconcile_test.go`, `voice/voice_test.go`, `voice/state_test.go`, `app/app_test.go`, `auth/*_test.go` where they touch community creation or the community-creation setting

**Interfaces:**
- Produces (package `communities`): `Palettes []string`; `type Server struct{ID, Name, Description, Palette, OwnerID, CreatedAt}` (JSON `id`, `name`, `description`, `palette`, `owner_id`, `created_at`); `type ServerWithRoles struct{ Server; Roles []Role }`; `Role` and `Member` without community IDs in JSON; `MemberRemoved{UserID}`, `RoleDeleted{ID}`; `ErrNotFound` (no server yet); `(*Service).ServerID(ctx) (id.ID, error)`, `Server(ctx) (*Server, error)`, `EnsureServer(ctx) error`, `Join(ctx, code string, userID id.ID) error` (auth hook), `IsMember(ctx, userID id.ID) (bool, error)`; existing `PermMember`, `PermMembers`, `Members`, `Roles`, `MemberIDs`, `CoMemberIDs`, `SharesCommunity`, `HasRole` unchanged in signature (still take the community ID).
- Routes (all `Security: httpx.Authed` unless noted): `get-server` `GET /api/server` → `ServerWithRoles`; `update-server` `PATCH /api/server` (`MANAGE_SERVER`) body `{name?, description?, palette?}` → `Server`; `list-members` `GET /api/server/members`; `remove-member` `DELETE /api/server/members/{userID}` (kick, `KICK`); `create-invite` `POST /api/server/invites`; `list-invites` `GET /api/server/invites` (`MANAGE_SERVER`); `get-invite` `GET /api/invites/{code}` (public) → `{code, server_name, member_count}`; `accept-invite` `POST /api/invites/{code}/accept` → 204; `delete-invite` `DELETE /api/invites/{code}`; roles `POST /api/server/roles`, `PATCH|DELETE /api/server/roles/{roleID}`, `PUT|DELETE /api/server/members/{userID}/roles/{roleID}`; bans `GET /api/server/bans`, `PUT|DELETE /api/server/bans/{userID}`; channels `GET|POST /api/server/channels`. Non-members: 403 `NOT_A_MEMBER` on every `/api/server…` route.
- Events: `SERVER_UPDATE` (`Server`), `MEMBER_ADD`/`MEMBER_UPDATE` (`Member`), `MEMBER_REMOVE` (`{user_id}`), `ROLE_CREATE`/`ROLE_UPDATE` (`Role`), `ROLE_DELETE` (`{id}`), `CHANNEL_DELETE` (`{id}`). `COMMUNITY_*` events are gone.
- Produces (package `auth`): `type Joiner interface{ Check(ctx, code string) error; Join(ctx, code string, userID id.ID) error }`, `(*Service).SetJoiner(Joiner)`; `Settings` without `allow_community_creation`.
- Produces (package `app`): `Ready.Server *ReadyServer` (JSON `server`, omitted for non-members) with `type ReadyServer struct{ communities.Server; Roles; Members; Channels }`; `Ready.Communities` is gone.
- Produces (package `apptest`): `(*Client).Server() communities.ServerWithRoles`, `(*Client).Invite() string`, `(*Client).Join(code string)`, `(*Client).Channels() []channels.Channel`, `(*Client).General() id.ID`, `(*Env).Outsider(username string) *Client` (registers then is kicked by the owner, i.e. the env's first registered user). `CreateCommunity`, `JoinCommunity` and the community-ID parameters are removed.

This is the widest task of the milestone: compile errors will point at every call site. Change behaviour only as described; keep every other test's intent (a test that "creates a community and invites bob" becomes "alice is the owner, bob registers and is already a member").

- [ ] **Step 1: Write the failing tests** — replace `server/internal/communities/communities_test.go` with:

```go
package communities_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestFirstUserCreatesTheServer(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	s := alice.Server()
	require.Equal(t, "Datrope", s.Name)
	require.Equal(t, alice.User.ID, s.OwnerID)
	require.Equal(t, "emerald", s.Palette)
	require.Len(t, s.Roles, 1)
	require.Equal(t, s.ID, s.Roles[0].ID, "@everyone shares the server's ID")
	require.Equal(t, perms.Default, s.Roles[0].Permissions)

	names := []string{}
	for _, ch := range alice.Channels() {
		names = append(names, ch.Name)
	}
	require.Contains(t, names, "general")
}

func TestRegisteringJoinsTheServer(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob") // open registration in tests
	var members []communities.Member
	alice.Do(http.MethodGet, "/api/server/members", nil, http.StatusOK, &members)
	require.Len(t, members, 2)

	env.SetRegistrationMode(auth.ModeInviteOnly)
	code := bob.Invite()
	carol := env.RegisterWithInvite("carol", code)
	carol.Do(http.MethodGet, "/api/server/members", nil, http.StatusOK, &members)
	require.Len(t, members, 3)

	var preview struct {
		Code        string `json:"code"`
		ServerName  string `json:"server_name"`
		MemberCount int    `json:"member_count"`
	}
	env.Anon().Do(http.MethodGet, "/api/invites/"+code, nil, http.StatusOK, &preview)
	require.Equal(t, "Datrope", preview.ServerName)
	require.Equal(t, 3, preview.MemberCount)
}

func TestUpdateServer(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var s communities.Server
	alice.Do(http.MethodPatch, "/api/server", map[string]any{"name": "The Basement", "description": "Board games and links", "palette": "ocean"}, http.StatusOK, &s)
	require.Equal(t, "The Basement", s.Name)
	require.Equal(t, "ocean", s.Palette)
	var ev communities.Server
	ws.ExpectDispatch("SERVER_UPDATE", &ev)
	require.Equal(t, "Board games and links", ev.Description)

	bob.Fail(http.MethodPatch, "/api/server", map[string]any{"name": "Mine"}, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Fail(http.MethodPatch, "/api/server", map[string]any{"palette": "beige"}, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
}

func TestKickAndRejoin(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	code := alice.Invite()

	alice.Do(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodGet, "/api/server", nil, http.StatusForbidden, "NOT_A_MEMBER")
	_, ready := bob.Connect()
	require.Nil(t, ready.Server, "READY has no server for a non-member")

	bob.Join(code)
	require.Equal(t, alice.Server().ID, bob.Server().ID)

	alice.Fail(http.MethodDelete, "/api/server/members/"+alice.User.ID.String(), nil, http.StatusBadRequest, "CANNOT_KICK_SELF")
	bob.Fail(http.MethodDelete, "/api/server/members/"+alice.User.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestBanBlocksRejoining(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	code := alice.Invite()
	alice.Do(http.MethodPut, "/api/server/bans/"+bob.User.ID.String(), map[string]any{"reason": "spam"}, http.StatusNoContent, nil)
	bob.Fail(http.MethodPost, "/api/invites/"+code+"/accept", nil, http.StatusForbidden, "BANNED")
}

func TestNoCommunityRoutesRemain(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPost, "/api/communities", map[string]any{"name": "Second"}, http.StatusNotFound, nil)
}
```

Add `RegisterWithInvite` to apptest in Step 4 (it registers with `"invite_code"`). Then update the other test files listed above so they compile against the new helpers and routes (most changes are mechanical: `c := alice.CreateCommunity("Club")` → `c := alice.Server()`; `bob.JoinCommunity(alice, c.ID)` → nothing, bob is already a member; outsiders → `env.Outsider("eve")`; `/api/communities/{id}/channels` → `/api/server/channels`, `/api/communities/{id}/roles/{rid}` → `/api/server/roles/{rid}`, `/api/communities/{id}/members/{uid}` → `/api/server/members/{uid}`, `/api/communities/{id}/bans/{uid}` → `/api/server/bans/{uid}`). In `voice/helpers_test.go`, `newClub` becomes: alice registers (owner), bob registers (member), `community` = `alice.Server()`, voice channel via `POST /api/server/channels`. The `club.community` field becomes `communities.ServerWithRoles`.

- [ ] **Step 2: Run them to verify they fail**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server vet ./...`
Expected: compile errors (`alice.Server` undefined, …).

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00007_server.sql`:

```sql
-- +goose Up
-- One community per instance: the server (spec: one-server design §2, §3).
ALTER TABLE communities
    ADD COLUMN description TEXT NOT NULL DEFAULT '',
    ADD COLUMN palette TEXT NOT NULL DEFAULT 'emerald'
        CHECK (palette IN ('emerald', 'ocean', 'violet', 'amber', 'rose', 'mint')),
    ADD COLUMN is_server BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX communities_one_server ON communities (is_server) WHERE is_server;

-- The oldest community becomes the server; the others fold into it.
UPDATE communities SET is_server = true
WHERE id = (SELECT id FROM communities ORDER BY created_at, id LIMIT 1);

-- Moved channels lose overrides that name the old community's roles.
DELETE FROM channel_overrides o USING channels ch, communities c
WHERE o.channel_id = ch.id AND ch.community_id = c.id AND NOT c.is_server AND o.target_type = 'role';

UPDATE channels ch
SET community_id = s.id, name = left(c.name || ' · ' || ch.name, 100), position = ch.position + 1000
FROM communities c, communities s
WHERE ch.community_id = c.id AND NOT c.is_server AND s.is_server;

-- Every account that is not disabled or banned is a member.
INSERT INTO members (community_id, user_id)
SELECT s.id, u.id FROM users u, communities s
WHERE s.is_server AND NOT u.disabled
  AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.community_id = s.id AND b.user_id = u.id)
ON CONFLICT DO NOTHING;

DELETE FROM communities WHERE NOT is_server;

ALTER TABLE instance_settings DROP COLUMN allow_community_creation;

-- +goose Down
ALTER TABLE instance_settings ADD COLUMN allow_community_creation BOOLEAN NOT NULL DEFAULT TRUE;
DROP INDEX communities_one_server;
ALTER TABLE communities DROP COLUMN is_server, DROP COLUMN palette, DROP COLUMN description;
```

- [ ] **Step 4: The communities service** — in `server/internal/communities/communities.go`:

Replace `Community`, `CommunityWithRoles` and `CommunityDeleted` with:

```go
// Palettes a server can use; the client maps each to its accent colour.
var Palettes = []string{"emerald", "ocean", "violet", "amber", "rose", "mint"}

// Server is the instance's one community.
type Server struct {
	ID          id.ID     `json:"id" doc:"Also the ID of the @everyone role"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Palette     string    `json:"palette" enum:"emerald,ocean,violet,amber,rose,mint"`
	OwnerID     id.ID     `json:"owner_id"`
	CreatedAt   time.Time `json:"created_at"`
}

type ServerWithRoles struct {
	Server
	Roles []Role `json:"roles"`
}
```

`Role.CommunityID` keeps its Go field for internal use with tag `json:"-"`; `Member.CommunityID` and `MemberRemoved.CommunityID` and `RoleDeleted.CommunityID` are removed (scopes still use the server ID). `ErrNotFound` now means "no server yet".

Add to `Service` a cached ID — `serverID atomic.Int64` (import `sync/atomic`) — and:

```go
// ServerID returns the server's ID: ErrNotFound until someone registers.
func (s *Service) ServerID(ctx context.Context) (id.ID, error) {
	if v := s.serverID.Load(); v != 0 {
		return id.ID(v), nil
	}
	var sid id.ID
	err := s.db.QueryRow(ctx, `SELECT id FROM communities WHERE is_server`).Scan(&sid)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	s.serverID.Store(int64(sid))
	return sid, nil
}

func (s *Service) Server(ctx context.Context) (*Server, error) {
	var sv Server
	err := s.db.QueryRow(ctx, `SELECT id, name, description, palette, owner_id, created_at FROM communities WHERE is_server`).
		Scan(&sv.ID, &sv.Name, &sv.Description, &sv.Palette, &sv.OwnerID, &sv.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &sv, err
}

func (s *Service) withRoles(ctx context.Context) (*ServerWithRoles, error) {
	sv, err := s.Server(ctx)
	if err != nil {
		return nil, err
	}
	roles, err := s.Roles(ctx, sv.ID)
	if err != nil {
		return nil, err
	}
	return &ServerWithRoles{Server: *sv, Roles: roles}, nil
}

// EnsureServer creates the server when there is none but there are users:
// it belongs to the oldest account, every account that is not disabled
// joins it, and it gets its default channels. It runs at startup and when
// the first user registers.
func (s *Service) EnsureServer(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7300151)`); err != nil { // one creator at a time
		return err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM communities WHERE is_server)`).Scan(&exists); err != nil || exists {
		return err
	}
	var owner id.ID
	err = tx.QueryRow(ctx, `SELECT id FROM users WHERE NOT disabled ORDER BY created_at, id LIMIT 1`).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // nobody has registered yet
	}
	if err != nil {
		return err
	}
	sid := id.New()
	if _, err := tx.Exec(ctx, `INSERT INTO communities (id, name, owner_id, is_server) VALUES ($1, 'Datrope', $2, true)`, sid, owner); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO roles (id, community_id, name, permissions, position) VALUES ($1, $1, '@everyone', $2, 0)`,
		sid, int64(perms.Default)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO members (community_id, user_id) SELECT $1, id FROM users WHERE NOT disabled`, sid); err != nil {
		return err
	}
	if s.seeder != nil {
		if err := s.seeder.SeedCommunity(ctx, tx, sid); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Join makes a newly registered user a member (auth.Joiner). The first
// registration creates the server; a non-empty code is redeemed as an invite.
func (s *Service) Join(ctx context.Context, code string, userID id.ID) error {
	if _, err := s.ServerID(ctx); errors.Is(err, ErrNotFound) {
		return s.EnsureServer(ctx)
	} else if err != nil {
		return err
	}
	if code != "" {
		return s.join(ctx, code, userID)
	}
	return s.addMember(ctx, userID)
}

// IsMember reports whether userID belongs to the server.
func (s *Service) IsMember(ctx context.Context, userID id.ID) (bool, error) {
	sid, err := s.ServerID(ctx)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var ok bool
	err = s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM members WHERE community_id = $1 AND user_id = $2)`, sid, userID).Scan(&ok)
	return ok, err
}

// addMember joins userID without an invite (open registration).
func (s *Service) addMember(ctx context.Context, userID id.ID) error {
	sid, err := s.ServerID(ctx)
	if err != nil {
		return err
	}
	var banned bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM bans WHERE community_id = $1 AND user_id = $2)`, sid, userID).Scan(&banned); err != nil {
		return err
	}
	if banned {
		return httpx.E(http.StatusForbidden, "BANNED", "you are banned from this server")
	}
	tag, err := s.db.Exec(ctx, `INSERT INTO members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, sid, userID)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	return s.publishMemberAdd(ctx, sid, userID)
}

func (s *Service) publishMemberAdd(ctx context.Context, sid, userID id.ID) error {
	m, err := s.member(ctx, sid, userID)
	if err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "MEMBER_ADD", Data: m, Scope: events.Scope{CommunityID: sid}})
	return nil
}
```

(imports gain `net/http`, `sync/atomic`, `httpx`.) Delete `create`, `get`, `ListForUser` and the old `withRoles`. In `permMembers`, replace `s.get(ctx, communityID)` with a query of the owner (`SELECT owner_id FROM communities WHERE id = $1`, no rows ⇒ return `nil, nil`). `members` stops setting `CommunityID`. `publishMemberRemoved(communityID, userID)` publishes `MemberRemoved{UserID: userID}` with the same scope.

In `server/internal/communities/invites.go`:

```go
type Invite struct {
	Code      string     `json:"code"`
	CreatorID id.ID      `json:"creator_id"`
	MaxUses   *int       `json:"max_uses,omitempty"`
	Uses      int        `json:"uses"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

type InvitePreview struct {
	Code        string `json:"code"`
	ServerName  string `json:"server_name"`
	MemberCount int    `json:"member_count"`
}
```

`createInvite(ctx, creatorID, maxUses, expiresIn)` and `listInvites(ctx)` use the server ID internally; `invite` keeps returning the row (scan `community_id` into a local you ignore); `preview` selects `c.name`. `Check` stays; `Redeem` is removed (replaced by `Join`). `join(ctx, code, userID) error`: same transaction as today (lock invite, refuse `BANNED` with message "you are banned from this server", add the member and count the use unless already a member), then `publishMemberAdd` when it added someone; no `COMMUNITY_CREATE` event.

In `server/internal/communities/roles.go`: route paths and inputs lose `{id}` (`/api/server/roles`, `/api/server/roles/{roleID}`, `/api/server/members/{userID}/roles/{roleID}`, `/api/server/bans`, `/api/server/bans/{userID}`); every `s.requireActor(ctx, in.ID, need)` becomes `s.requireActor(ctx, need)`; `rolePath` and `memberRolePath` drop `ID`; events drop community IDs (`RoleDeleted{ID: r.ID}`); `ban`'s target-is-owner check uses `s.Server(ctx)`. The hierarchy rules come in Task 4; keep `canModerate` and `canTouch` as they are here.

- [ ] **Step 5: Replace `server/internal/communities/handlers.go`**

```go
package communities

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type UpdateServerRequest struct {
	Name        *string `json:"name,omitempty" minLength:"1" maxLength:"100"`
	Description *string `json:"description,omitempty" maxLength:"300"`
	Palette     *string `json:"palette,omitempty" enum:"emerald,ocean,violet,amber,rose,mint"`
}

type CreateInviteRequest struct {
	MaxUses          *int `json:"max_uses,omitempty" minimum:"1" maximum:"1000"`
	ExpiresInSeconds *int `json:"expires_in_seconds,omitempty" minimum:"60" maximum:"2592000"`
}

type memberPath struct {
	UserID string `path:"userID"`
}

type codePath struct {
	Code string `path:"code"`
}

// actor is the caller's standing in the server.
type actor struct {
	CommunityID id.ID // the server's ID
	Member      PermMember
	Base        perms.Perms
}

func errNotMember() *httpx.Error {
	return httpx.E(http.StatusForbidden, "NOT_A_MEMBER", "you are not a member of this server; ask for an invite")
}

// requireActor checks that the caller is a member holding need.
func (s *Service) requireActor(ctx context.Context, need perms.Perms) (actor, error) {
	sid, err := s.ServerID(ctx)
	if errors.Is(err, ErrNotFound) {
		return actor{}, errNotMember()
	}
	if err != nil {
		return actor{}, err
	}
	m, err := s.PermMember(ctx, sid, auth.Current(ctx).User.ID)
	if errors.Is(err, ErrNotMember) {
		return actor{}, errNotMember()
	}
	if err != nil {
		return actor{}, err
	}
	base := perms.Base(m.Perms)
	if !base.Has(need) {
		return actor{}, httpx.MissingPermission()
	}
	return actor{CommunityID: sid, Member: m, Base: base}, nil
}

func Register(api huma.API, s *Service) {
	tags := []string{"server"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}

	huma.Register(api, op("get-server", http.MethodGet, "/api/server", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body *ServerWithRoles }, error) {
			if _, err := s.requireActor(ctx, 0); err != nil {
				return nil, err
			}
			sv, err := s.withRoles(ctx)
			return &struct{ Body *ServerWithRoles }{sv}, err
		})

	huma.Register(api, op("update-server", http.MethodPatch, "/api/server", 0),
		func(ctx context.Context, in *struct{ Body UpdateServerRequest }) (*struct{ Body *Server }, error) {
			a, err := s.requireActor(ctx, perms.ManageServer)
			if err != nil {
				return nil, err
			}
			var name *string
			if in.Body.Name != nil {
				n := strings.TrimSpace(*in.Body.Name)
				name = &n
			}
			if _, err := s.db.Exec(ctx, `
				UPDATE communities SET name = COALESCE($2, name), description = COALESCE($3, description), palette = COALESCE($4, palette)
				WHERE id = $1`, a.CommunityID, name, in.Body.Description, in.Body.Palette); err != nil {
				return nil, err
			}
			sv, err := s.Server(ctx)
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "SERVER_UPDATE", Data: sv, Scope: events.Scope{CommunityID: sv.ID}})
			return &struct{ Body *Server }{sv}, nil
		})

	huma.Register(api, op("list-members", http.MethodGet, "/api/server/members", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Member }, error) {
			a, err := s.requireActor(ctx, 0)
			if err != nil {
				return nil, err
			}
			ms, err := s.Members(ctx, a.CommunityID)
			return &struct{ Body []Member }{ms}, err
		})

	huma.Register(api, op("remove-member", http.MethodDelete, "/api/server/members/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *memberPath) (*struct{}, error) {
			a, err := s.requireActor(ctx, perms.Kick)
			if err != nil {
				return nil, err
			}
			target, err := httpx.ParseID(in.UserID, "member")
			if err != nil {
				return nil, err
			}
			if target == a.Member.UserID {
				return nil, httpx.BadRequest("CANNOT_KICK_SELF", "you cannot kick yourself")
			}
			sv, err := s.Server(ctx)
			if err != nil {
				return nil, err
			}
			if target == sv.OwnerID {
				return nil, httpx.MissingPermission()
			}
			if err := s.canModerate(ctx, a, target); err != nil {
				return nil, err
			}
			ok, err := s.removeMember(ctx, a.CommunityID, target)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, httpx.NotFound("member")
			}
			return nil, nil
		})

	huma.Register(api, op("create-invite", http.MethodPost, "/api/server/invites", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body CreateInviteRequest }) (*struct{ Body *Invite }, error) {
			a, err := s.requireActor(ctx, perms.CreateInvite)
			if err != nil {
				return nil, err
			}
			inv, err := s.createInvite(ctx, a.CommunityID, a.Member.UserID, in.Body.MaxUses, in.Body.ExpiresInSeconds)
			return &struct{ Body *Invite }{inv}, err
		})

	huma.Register(api, op("list-invites", http.MethodGet, "/api/server/invites", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Invite }, error) {
			a, err := s.requireActor(ctx, perms.ManageServer)
			if err != nil {
				return nil, err
			}
			list, err := s.listInvites(ctx, a.CommunityID)
			return &struct{ Body []Invite }{list}, err
		})

	huma.Register(api, huma.Operation{OperationID: "get-invite", Method: http.MethodGet, Path: "/api/invites/{code}", Tags: tags},
		func(ctx context.Context, in *codePath) (*struct{ Body *InvitePreview }, error) {
			p, err := s.preview(ctx, in.Code)
			return &struct{ Body *InvitePreview }{p}, err
		})

	huma.Register(api, op("accept-invite", http.MethodPost, "/api/invites/{code}/accept", http.StatusNoContent),
		func(ctx context.Context, in *codePath) (*struct{}, error) {
			return nil, s.join(ctx, in.Code, auth.Current(ctx).User.ID)
		})

	huma.Register(api, op("delete-invite", http.MethodDelete, "/api/invites/{code}", http.StatusNoContent),
		func(ctx context.Context, in *codePath) (*struct{}, error) {
			inv, err := s.invite(ctx, in.Code)
			if err != nil {
				return nil, err
			}
			if inv.CreatorID != auth.Current(ctx).User.ID {
				if _, err := s.requireActor(ctx, perms.ManageServer); err != nil {
					return nil, err
				}
			}
			return nil, s.deleteInvite(ctx, in.Code)
		})

	registerRoles(api, s, op)
}
```

(`createInvite(ctx, serverID, creatorID, maxUses, expiresIn)` and `listInvites(ctx, serverID)` keep a server-ID parameter internally.)

- [ ] **Step 6: Permissions rename** — in `server/internal/perms/perms.go`, rename `ManageCommunity` to `ManageServer` (same bit; the new flags come in Task 4) and update its uses.

- [ ] **Step 7: Registration joins** — in `server/internal/auth/service.go` replace the `Invites` interface, field and setter with:

```go
// Joiner adds people to the server. The communities package implements it.
type Joiner interface {
	// Check returns an *httpx.Error if the invite cannot be used.
	Check(ctx context.Context, code string) error
	// Join makes a new account a member; code may be empty.
	Join(ctx context.Context, code string, userID id.ID) error
}
```

`joiner Joiner` and `func (s *Service) SetJoiner(j Joiner) { s.joiner = j }`. In `register` (`handlers.go`), the invite-only check uses `s.joiner`, and after `createUser`:

```go
	if s.joiner != nil {
		// The account exists now; failing to join (e.g. the invite was used up
		// a moment ago) should not fail the sign-up: they can join later.
		if err := s.joiner.Join(ctx, b.InviteCode, u.ID); err != nil {
			slog.WarnContext(ctx, "join after registration", "user_id", u.ID, "err", err)
		}
	}
```

Remove `AllowCommunityCreation` from `Settings` (`store.go`: the SELECT and UPDATE no longer touch the dropped column) and from `UpdateSettingsRequest` in `admin.go`.

- [ ] **Step 8: Channels** — in `server/internal/channels/channels.go`: `Communities` gains `ServerID(ctx context.Context) (id.ID, error)`; `Channel.CommunityID` gets tag `json:"-"` (the Go field stays); `ChannelDeleted` becomes `{ID id.ID \`json:"id"\`}`. In `handlers.go`: `list-channels` → `GET /api/server/channels` (input `*struct{}`, server ID from `s.communities.ServerID`, non-member → 403 `NOT_A_MEMBER` with the same message as communities), `create-channel` → `POST /api/server/channels` (body only). `CHANNEL_DELETE` publishes `ChannelDeleted{ID: c.ID}`.

- [ ] **Step 9: READY and wiring** — in `server/internal/app/realtime.go`:

```go
// Ready is the READY payload (architecture spec §5.2; one-server design §5).
type Ready struct {
	SessionID   string                   `json:"session_id"`
	User        *auth.User               `json:"user"`
	Server      *ReadyServer             `json:"server,omitempty" doc:"Absent when the user is not a member"`
	DMs         []channels.Channel       `json:"dms"`
	Presences   []gateway.PresenceUpdate `json:"presences" doc:"People who share the server and are not offline"`
	ReadStates  []messages.ReadState     `json:"read_states" doc:"One per visible channel and DM"`
	VoiceStates []voice.VoiceState       `json:"voice_states" doc:"Who is in voice, in channels and DMs the user can see"`
}

type ReadyServer struct {
	communities.Server
	Roles    []communities.Role   `json:"roles"`
	Members  []communities.Member `json:"members"`
	Channels []channels.Channel   `json:"channels" doc:"Only channels the user can see"`
}
```

`Build`: look up the server (`communities.Server`; `ErrNotFound` ⇒ no server), check membership with `communities.IsMember`; for a member fill `ReadyServer` (roles, members, `channels.ListVisible(u.ID, sv.ID)`) and the presences of its members; DMs, read states and voice states as before. `registerEventSchemas`: drop `communities.CommunityDeleted`, add `communities.Server{}`. In `app.go`: `authSvc.SetJoiner(commSvc)`; after `commSvc.SetChannelSeeder(chanSvc)`, when `pool != nil`: `if err := commSvc.EnsureServer(context.Background()); err != nil { panic(fmt.Errorf("server: %w", err)) }`. In `server/internal/voice/reconcile.go`, drop `"COMMUNITY_DELETE"` from `permissionEvents`.

- [ ] **Step 10: Test helpers** — in `server/internal/apptest/apptest.go` replace the community helpers with:

```go
// Register signs up a user (see RegisterWithInvite). The first user of an
// Env becomes the server's owner.
func (e *Env) Register(username string) *Client { return e.RegisterWithInvite(username, "") }

// RegisterWithInvite signs up with an invite code ("" for none), password "password123".
func (e *Env) RegisterWithInvite(username, code string) *Client {
	e.T.Helper()
	c := e.Anon()
	var res auth.AuthResult
	body := map[string]any{"username": username, "password": "password123", "device_name": "test", "client": "native"}
	if code != "" {
		body["invite_code"] = code
	}
	c.Do(http.MethodPost, "/api/auth/register", body, http.StatusOK, &res)
	c.Token, c.User = res.Token, res.User
	if e.owner == nil {
		e.owner = c
	}
	return c
}

// Outsider is a registered user who is not a member: the owner kicked them.
func (e *Env) Outsider(username string) *Client {
	e.T.Helper()
	c := e.Register(username)
	e.owner.Do(http.MethodDelete, "/api/server/members/"+c.User.ID.String(), nil, http.StatusNoContent, nil)
	return c
}

func (c *Client) Server() communities.ServerWithRoles {
	c.env.T.Helper()
	var out communities.ServerWithRoles
	c.Do(http.MethodGet, "/api/server", nil, http.StatusOK, &out)
	return out
}

// Invite creates an unlimited invite and returns its code.
func (c *Client) Invite() string {
	c.env.T.Helper()
	var inv communities.Invite
	c.Do(http.MethodPost, "/api/server/invites", map[string]any{}, http.StatusCreated, &inv)
	return inv.Code
}

func (c *Client) Join(code string) {
	c.env.T.Helper()
	c.Do(http.MethodPost, "/api/invites/"+code+"/accept", nil, http.StatusNoContent, nil)
}

// Channels lists the channels c can see.
func (c *Client) Channels() []channels.Channel {
	c.env.T.Helper()
	var out []channels.Channel
	c.Do(http.MethodGet, "/api/server/channels", nil, http.StatusOK, &out)
	return out
}

// General returns the ID of the default #general channel.
func (c *Client) General() id.ID {
	c.env.T.Helper()
	for _, ch := range c.Channels() {
		if ch.Name == "general" {
			return ch.ID
		}
	}
	c.env.T.Fatal("no #general channel")
	return 0
}
```

with an `owner *Client` field on `Env`. Delete `CreateCommunity`, `JoinCommunity` and the old signatures.

- [ ] **Step 11: Run everything** — `go -C server vet ./...`, then `go -C server test -p 2 ./...` (PowerShell). Expected: PASS. `gofmt -l server` empty. (A migration test on an empty database runs implicitly in every package; also run Step 12.)

- [ ] **Step 12: Migration with existing data** — add `server/internal/db/migrate_test.go` (package `db_test`) that migrates a fresh database to version 6 with goose, inserts two users, two communities (each with an @everyone role, a member, a channel, a role override), runs the remaining migrations, and asserts: one community remains (the older), marked `is_server`; both channels belong to it, the moved one named `<other> · <channel>` with no role overrides; both users are members. Use `pgtest` for the database and `goose.UpTo`/`goose.Up` with the embedded migrations (see `server/internal/db/db.go` for how they are embedded).

- [ ] **Step 13: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(server): one server per instance; community routes become /api/server`

---
### Task 2: Server icon, banner and page images

**Files:**
- Create: `server/internal/db/migrations/00008_server_images.sql`, `server/internal/files/server_images.go`, `server/internal/files/server_images_test.go`
- Modify: `server/internal/files/files.go` (`removeIfUnused`), `server/internal/communities/communities.go` (`Server` URLs, `BasePerms`, `PublishServerUpdate`), `server/internal/app/app.go` (routes, wiring)

**Interfaces:**
- Consumes (Task 1): `communities.Server`, `(*communities.Service).Server`, `ServerID`.
- Produces (package `communities`): `Server.IconURL *string` (JSON `icon_url,omitempty`), `Server.BannerURL *string` (`banner_url,omitempty`); `type Images interface{ ServerImageURLs(ctx) (icon, banner string, err error) }` and `(*Service).SetImages(Images)` — `Server(ctx)` fills the URLs from it ("" ⇒ nil); `(*Service).BasePerms(ctx, userID) (perms.Perms, error)` (0 for non-members); `(*Service).PublishServerUpdate(ctx) error` (publishes `SERVER_UPDATE` with the current `Server`).
- Produces (package `files`): `type Server interface{ BasePerms(ctx, userID id.ID) (perms.Perms, error); PublishServerUpdate(ctx) error }`, `(*Service).SetServer(Server)`, `(*Service).ServerImageURLs(ctx) (icon, banner string, err error)`, handlers `ServerImageUpload(kind string) http.Handler` (kind `icon`, `banner` or `page`), `ServerImageDelete(kind string) http.Handler`, `ServerImageDownload() http.Handler`.
- Routes (raw mux, multipart field `file`): `PUT /api/server/icon`, `PUT /api/server/banner` → 200 `{"url": "..."}`; `DELETE /api/server/icon`, `DELETE /api/server/banner` → 204; `POST /api/server/images` (images for the welcome page) → 201 `{"id": "...", "url": "/api/server/images/<id>"}`. All need a session and `MANAGE_SERVER`. Public (no session): `GET /api/server/icon`, `GET /api/server/banner` (404 when unset), `GET /api/server/images/{id}`.
- URLs carry a version so caches refresh: `/api/server/icon?v=<first 12 hex of sha256>`.

Page images are kept until the server is deleted (they are small and rare; tracking which ones the Markdown still references is not worth it in M4).

- [ ] **Step 1: Write the failing tests** — first add to `server/internal/apptest/apptest.go` an exported multipart helper next to `Upload`:

```go
// UploadTo sends content as the multipart "file" field to any path.
func (c *Client) UploadTo(method, path, filename string, content []byte, want int) []byte {
	c.env.T.Helper()
	body, ct := multipartFile(c.env.T, filename, content)
	_, raw := c.Raw(method, path, body, ct, want)
	return raw
}
```

Then `server/internal/files/server_images_test.go`:

```go
package files_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
)

func TestServerIcon(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	icon := pngWithText(pngImage(64, 64, false), "Comment", "secret")
	alice.UploadTo(http.MethodPut, "/api/server/icon", "icon.png", icon, http.StatusOK)
	var ev communities.Server
	ws.ExpectDispatch("SERVER_UPDATE", &ev)
	require.NotNil(t, ev.IconURL)
	require.True(t, strings.HasPrefix(*ev.IconURL, "/api/server/icon?v="))

	res, data := env.Anon().Raw(http.MethodGet, *ev.IconURL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", res.Header.Get("Content-Type"))
	require.NotContains(t, string(data), "secret", "metadata is stripped")

	bob.UploadTo(http.MethodPut, "/api/server/icon", "icon.png", pngImage(8, 8, false), http.StatusForbidden)
	alice.UploadTo(http.MethodPut, "/api/server/banner", "banner.png", []byte("not an image"), http.StatusBadRequest)

	alice.Raw(http.MethodDelete, "/api/server/icon", nil, "", http.StatusNoContent)
	require.Nil(t, alice.Server().IconURL)
	env.Anon().Raw(http.MethodGet, "/api/server/icon", nil, "", http.StatusNotFound)
}

func TestServerPageImages(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	raw := alice.UploadTo(http.MethodPost, "/api/server/images", "pic.png", pngImage(32, 32, false), http.StatusCreated)
	var out struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal(raw, &out))
	require.Equal(t, "/api/server/images/"+out.ID, out.URL)
	env.Anon().Raw(http.MethodGet, out.URL, nil, "", http.StatusOK)
}
```

(`pngImage` and `pngWithText` are the fixtures in `fixtures_test.go`; `Raw` sends the bearer token, so no CSRF header is needed.)

Also add to `files/files_test.go` a case: after uploading an icon and running `env.App.Files.Sweep(ctx, time.Now().Add(48*time.Hour))` (or however the existing sweep tests reach the service), the icon is still served — GC keeps blobs referenced by `server_images`.

- [ ] **Step 2: Run to verify they fail** — `go -C server test ./internal/files/ -run 'TestServer'` (PowerShell). Expected: 404/405 from the missing routes.

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00008_server_images.sql`:

```sql
-- +goose Up
-- The server's icon and banner (one each) and images used on the welcome page.
CREATE TABLE server_images (
    id           BIGINT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('icon', 'banner', 'page')),
    sha256       TEXT NOT NULL,
    content_type TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX server_images_one_each ON server_images (kind) WHERE kind IN ('icon', 'banner');
CREATE INDEX server_images_sha_idx ON server_images (sha256);

-- +goose Down
DROP TABLE server_images;
```

- [ ] **Step 4: Files** — `server/internal/files/server_images.go`:

```go
package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Server is what this package needs from communities.
type Server interface {
	BasePerms(ctx context.Context, userID id.ID) (perms.Perms, error)
	PublishServerUpdate(ctx context.Context) error
}

func (s *Service) SetServer(sv Server) { s.server = sv }

const maxServerImageBytes = 8 << 20

// ServerImageURLs returns the icon and banner URLs, "" when unset.
func (s *Service) ServerImageURLs(ctx context.Context) (icon, banner string, err error) {
	rows, err := s.db.Query(ctx, `SELECT kind, sha256 FROM server_images WHERE kind IN ('icon', 'banner')`)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, sum string
		if err := rows.Scan(&kind, &sum); err != nil {
			return "", "", err
		}
		u := "/api/server/" + kind + "?v=" + sum[:12]
		if kind == "icon" {
			icon = u
		} else {
			banner = u
		}
	}
	return icon, banner, rows.Err()
}

func (s *Service) requireManageServer(ctx context.Context) error {
	p, err := s.server.BasePerms(ctx, auth.Current(ctx).User.ID)
	if err != nil {
		return err
	}
	if !p.Has(perms.ManageServer) {
		return httpx.MissingPermission()
	}
	return nil
}

// ServerImageUpload serves PUT /api/server/{icon,banner} and POST
// /api/server/images (kind "page"). It must run behind auth.RequireHTTP.
func (s *Service) ServerImageUpload(kind string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if err := s.requireManageServer(ctx); err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		staged, err := s.stageForm(w, r, maxServerImageBytes)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		imgID, sum, err := s.saveServerImage(ctx, kind, staged)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		if kind == "page" {
			httpx.WriteJSON(w, http.StatusCreated, map[string]string{"id": imgID.String(), "url": "/api/server/images/" + imgID.String()})
			return
		}
		if err := s.server.PublishServerUpdate(ctx); err != nil {
			slog.WarnContext(ctx, "files: publishing server update", "err", err)
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"url": "/api/server/" + kind + "?v=" + sum[:12]})
	})
}

// stageForm reads the multipart "file" field into the store's staging area.
func (s *Service) stageForm(w http.ResponseWriter, r *http.Request, limit int64) (*Staged, error) {
	r.Body = http.MaxBytesReader(w, r.Body, limit+multipartOverhead)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
		}
		if err != nil {
			return nil, uploadError(err, limit)
		}
		if part.FormName() != "file" {
			_, _ = io.Copy(io.Discard, part)
			continue
		}
		staged, err := s.store.Stage(part, limit)
		if err != nil {
			return nil, uploadError(err, limit)
		}
		return staged, nil
	}
}

// saveServerImage cleans an image and records it, replacing the previous
// icon or banner.
func (s *Service) saveServerImage(ctx context.Context, kind string, staged *Staged) (id.ID, string, error) {
	defer s.store.Discard(staged)
	data, err := staged.Bytes()
	if err != nil {
		return 0, "", err
	}
	ct, ik := Sniff(data[:min(len(data), 512)])
	if ik == "" {
		return 0, "", httpx.BadRequest("NOT_AN_IMAGE", "upload a PNG, JPEG, WebP or GIF image")
	}
	clean, err := Clean(ik, data)
	if err != nil {
		return 0, "", httpx.BadRequest("NOT_AN_IMAGE", "the image could not be read")
	}
	cleaned, err := s.store.Stage(bytes.NewReader(clean), int64(len(clean)))
	if err != nil {
		return 0, "", err
	}
	defer s.store.Discard(cleaned)

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, "", err
	}
	defer tx.Rollback(ctx)
	if err := lockBlobs(ctx, tx, cleaned.Sum); err != nil {
		return 0, "", err
	}
	if err := s.store.Commit(cleaned); err != nil {
		return 0, "", err
	}
	var old *string
	if kind != "page" {
		err := tx.QueryRow(ctx, `DELETE FROM server_images WHERE kind = $1 RETURNING sha256`, kind).Scan(&old)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return 0, "", err
		}
	}
	imgID := id.New()
	if _, err := tx.Exec(ctx, `INSERT INTO server_images (id, kind, sha256, content_type) VALUES ($1, $2, $3, $4)`,
		imgID, kind, cleaned.Sum, ct); err != nil {
		return 0, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, "", err
	}
	if old != nil && *old != cleaned.Sum {
		if err := s.removeIfUnused(ctx, *old); err != nil {
			slog.WarnContext(ctx, "files: removing the old server image; the sweep will retry", "err", err)
		}
	}
	return imgID, cleaned.Sum, nil
}

// ServerImageDelete serves DELETE /api/server/{icon,banner}. It must run
// behind auth.RequireHTTP.
func (s *Service) ServerImageDelete(kind string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if err := s.requireManageServer(ctx); err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		var sum string
		err := s.db.QueryRow(ctx, `DELETE FROM server_images WHERE kind = $1 RETURNING sha256`, kind).Scan(&sum)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteHTTPError(w, r, httpx.NotFound(kind))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		if err := s.removeIfUnused(ctx, sum); err != nil {
			slog.WarnContext(ctx, "files: removing a server image; the sweep will retry", "err", err)
		}
		if err := s.server.PublishServerUpdate(ctx); err != nil {
			slog.WarnContext(ctx, "files: publishing server update", "err", err)
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// ServerImageDownload serves GET /api/server/icon, /api/server/banner and
// /api/server/images/{id} without a session: the sign-in page shows them.
func (s *Service) ServerImageDownload() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var sum, ct string
		var err error
		if raw := r.PathValue("id"); raw != "" {
			imgID, perr := httpx.ParseID(raw, "image")
			if perr != nil {
				httpx.WriteHTTPError(w, r, perr)
				return
			}
			err = s.db.QueryRow(ctx, `SELECT sha256, content_type FROM server_images WHERE id = $1 AND kind = 'page'`, imgID).Scan(&sum, &ct)
		} else {
			kind := "icon"
			if r.URL.Path == "/api/server/banner" {
				kind = "banner"
			}
			err = s.db.QueryRow(ctx, `SELECT sha256, content_type FROM server_images WHERE kind = $1`, kind).Scan(&sum, &ct)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteHTTPError(w, r, httpx.NotFound("image"))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
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
		h.Set("Content-Type", ct)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
		h.Set("Cache-Control", "public, max-age=86400")
		h.Set("ETag", `"`+sum+`"`)
		http.ServeContent(w, r, "", time.Time{}, f)
	})
}
```

Add the `server Server` field to `Service`. In `files.go` `removeIfUnused`, the "in use" query becomes:

```go
		`SELECT EXISTS (SELECT 1 FROM attachments WHERE sha256 = $1 OR thumb_sha256 = $1)
		     OR EXISTS (SELECT 1 FROM server_images WHERE sha256 = $1)`
```

(and its doc comment on `removeUnreferenced`: "no attachment or server image points at").

- [ ] **Step 5: Communities** — in `communities.go`: add `IconURL *string \`json:"icon_url,omitempty"\`` and `BannerURL *string \`json:"banner_url,omitempty"\`` to `Server`; an `images Images` field with `SetImages`; at the end of `Server(ctx)`, when `s.images != nil`, fill them (`""` stays nil). Add:

```go
// Images reports the server's icon and banner URLs. The files package implements it.
type Images interface {
	ServerImageURLs(ctx context.Context) (icon, banner string, err error)
}

// BasePerms is userID's server-wide permission set: 0 for non-members.
func (s *Service) BasePerms(ctx context.Context, userID id.ID) (perms.Perms, error) {
	sid, err := s.ServerID(ctx)
	if errors.Is(err, ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	m, err := s.PermMember(ctx, sid, userID)
	if errors.Is(err, ErrNotMember) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return perms.Base(m.Perms), nil
}

// PublishServerUpdate tells every member about the server's current settings.
func (s *Service) PublishServerUpdate(ctx context.Context) error {
	sv, err := s.Server(ctx)
	if err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "SERVER_UPDATE", Data: sv, Scope: events.Scope{CommunityID: sv.ID}})
	return nil
}
```

and make `update-server` (Task 1) call `PublishServerUpdate` instead of publishing itself.

- [ ] **Step 6: Wiring** — in `app.go`, inside the `pool != nil` files block:

```go
		filesSvc.SetServer(commSvc)
		commSvc.SetImages(filesSvc)
		for _, kind := range []string{"icon", "banner"} {
			mux.Handle("PUT /api/server/"+kind, authSvc.RequireHTTP(filesSvc.ServerImageUpload(kind)))
			mux.Handle("DELETE /api/server/"+kind, authSvc.RequireHTTP(filesSvc.ServerImageDelete(kind)))
			mux.Handle("GET /api/server/"+kind, filesSvc.ServerImageDownload())
		}
		mux.Handle("POST /api/server/images", authSvc.RequireHTTP(filesSvc.ServerImageUpload("page")))
		mux.Handle("GET /api/server/images/{id}", filesSvc.ServerImageDownload())
```

These raw routes are not in the OpenAPI document (like attachments); add their paths to the comment that lists raw routes in `app.go` if there is one.

- [ ] **Step 7: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./internal/files/ ./internal/communities/ ./internal/app/` (PowerShell). Expected: PASS. `gofmt -l server` empty.

- [ ] **Step 8: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(files): server icon, banner and welcome-page images`

---

### Task 3: Welcome channel, page and rules gate

**Files:**
- Create: `server/internal/db/migrations/00009_welcome.sql`, `server/internal/communities/welcome.go`, `server/internal/communities/welcome_test.go`
- Modify: `server/internal/communities/communities.go` (`Server.RulesGate`, `PermMember.Gated`, `Member.AcceptedRulesAt`, joins set `accepted_rules_at`, `SharesCommunity`), `handlers.go` (`requireActor` and `list-members` for gated members)
- Modify: `server/internal/channels/channels.go` (`TypeWelcome`, seed, gate in `effective`), `handlers.go` (cannot delete the welcome channel)
- Modify: `server/internal/messages/handlers.go` (no messages in the welcome channel)
- Modify: `server/internal/app/realtime.go` (READY for gated members)

**Interfaces:**
- Consumes (Tasks 1–2): `Server`, `ServerID`, `requireActor`, `PublishServerUpdate`, `publishMemberUpdate`.
- Produces: channel type `welcome` (`channels.TypeWelcome`; enum `text,voice,welcome,dm` in `Channel.Type`; creating one through the API stays impossible); `Server.RulesGate bool` (JSON `rules_gate`); `Member.AcceptedRulesAt *time.Time` (JSON `accepted_rules_at,omitempty`); `PermMember.Gated bool`.
- Routes: `get-welcome` `GET /api/server/welcome` → `Welcome{channel_id, markdown, rules_gate}` (any member, gated included); `update-welcome` `PUT /api/server/welcome` (`MANAGE_SERVER`) body `{markdown, rules_gate}` → `Welcome`, publishes `WELCOME_UPDATE` (`Welcome`) and, when the gate changed, `SERVER_UPDATE`; `accept-rules` `POST /api/server/welcome/accept` → 204, publishes `MEMBER_UPDATE`.
- Errors: `PUT` with `rules_gate: true` and blank markdown → 400 `WELCOME_EMPTY`; markdown over 50 000 characters → 422; deleting the welcome channel → 400 `CANNOT_DELETE_WELCOME`; any message route on it → 400 `NO_MESSAGES_HERE`.
- Gate rule: `Gated` = gate on ∧ `accepted_rules_at` is null ∧ not the owner. A gated member's permissions are `VIEW_CHANNEL` in the welcome channel and nothing anywhere else (base perms 0); they cannot list members or start DMs (`SharesCommunity` is false for them), and their READY holds the server, its roles, the welcome channel only, no members, presences, voice states or DMs. Joining while the gate is off sets `accepted_rules_at` to now, so turning the gate on later does not lock out existing members.

- [ ] **Step 1: Write the failing tests** — `server/internal/communities/welcome_test.go`:

```go
package communities_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
)

func TestWelcomePage(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var w communities.Welcome
	bob.Do(http.MethodGet, "/api/server/welcome", nil, http.StatusOK, &w)
	require.Equal(t, "", w.Markdown)
	require.False(t, w.RulesGate)

	alice.Fail(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "  ", "rules_gate": true}, http.StatusBadRequest, "WELCOME_EMPTY")
	alice.Do(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "# Hi\nBe nice.", "rules_gate": false}, http.StatusOK, &w)
	var ev communities.Welcome
	ws.ExpectDispatch("WELCOME_UPDATE", &ev)
	require.Equal(t, "# Hi\nBe nice.", ev.Markdown)
	bob.Fail(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "mine"}, http.StatusForbidden, "MISSING_PERMISSION")

	// The welcome channel is listed, has no messages and cannot be deleted.
	var welcomeID string
	for _, ch := range bob.Channels() {
		if ch.Type == "welcome" {
			welcomeID = ch.ID.String()
		}
	}
	require.Equal(t, w.ChannelID.String(), welcomeID)
	bob.Fail(http.MethodPost, "/api/channels/"+welcomeID+"/messages", map[string]any{"content": "hi"}, http.StatusBadRequest, "NO_MESSAGES_HERE")
	alice.Fail(http.MethodDelete, "/api/channels/"+welcomeID, nil, http.StatusBadRequest, "CANNOT_DELETE_WELCOME")
}

func TestRulesGate(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob") // joined before the gate: not gated
	alice.Do(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "Rules: be nice.", "rules_gate": true}, http.StatusOK, nil)
	require.True(t, alice.Server().RulesGate)

	carol := env.Register("carol")
	chans := carol.Channels()
	require.Len(t, chans, 1, "a gated member sees only the welcome channel")
	require.Equal(t, "welcome", chans[0].Type)
	carol.Fail(http.MethodGet, "/api/server/members", nil, http.StatusForbidden, "RULES_NOT_ACCEPTED")
	carol.Fail(http.MethodGet, "/api/channels/"+bob.General().String()+"/messages", nil, http.StatusNotFound, "NOT_FOUND")
	carol.Fail(http.MethodPost, dmPath, dmBody(bob), dmRefusedStatus, dmRefusedCode)
	_, ready := carol.Connect()
	require.NotNil(t, ready.Server)
	require.Len(t, ready.Server.Channels, 1)
	require.Empty(t, ready.Server.Members)

	require.Len(t, bob.Channels(), 2, "bob accepted implicitly by joining before the gate")

	ws, _ := alice.Connect()
	carol.Do(http.MethodPost, "/api/server/welcome/accept", nil, http.StatusNoContent, nil)
	var m communities.Member
	ws.ExpectDispatch("MEMBER_UPDATE", &m)
	require.Equal(t, carol.User.ID, m.User.ID)
	require.NotNil(t, m.AcceptedRulesAt)
	require.Len(t, carol.Channels(), 2)
}
```

`dmPath`, `dmBody`, `dmRefusedStatus` and `dmRefusedCode` stand for the DM-creation route, its body, and the status and code `channels/handlers.go` returns today for "you share no community with them" — read the handler and the existing DM test in `channels/channels_test.go` and write the literal values in (`Fail` compares the code exactly).

- [ ] **Step 2: Run to verify they fail** — `go -C server test ./internal/communities/ -run 'TestWelcome|TestRulesGate'`. Expected: compile failure (`communities.Welcome` undefined).

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00009_welcome.sql`:

```sql
-- +goose Up
-- The welcome channel and page, and the rules gate (one-server design §3, §4).
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'welcome', 'dm'));
CREATE UNIQUE INDEX channels_one_welcome ON channels (community_id) WHERE type = 'welcome';

ALTER TABLE communities
    ADD COLUMN welcome_markdown TEXT NOT NULL DEFAULT '',
    ADD COLUMN rules_gate BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE members ADD COLUMN accepted_rules_at TIMESTAMPTZ;
UPDATE members SET accepted_rules_at = joined_at;

INSERT INTO channels (id, community_id, type, name, position)
SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint << 22, id, 'welcome', 'welcome', -1
FROM communities WHERE is_server;

-- +goose Down
DELETE FROM channels WHERE type = 'welcome';
ALTER TABLE members DROP COLUMN accepted_rules_at;
ALTER TABLE communities DROP COLUMN rules_gate, DROP COLUMN welcome_markdown;
DROP INDEX channels_one_welcome;
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'dm'));
```

Check two things before using this verbatim: the constraint name Postgres generated for the inline `CHECK` in `00003_channels.sql` (normally `channels_type_check`; confirm with `\d channels` or `pg_constraint` in a pgtest database), and how `id.New()` builds IDs in `server/internal/id` — the migration's ID expression must produce a value in the same scheme (timestamp in the high bits, relative to the same epoch). If the scheme uses a custom epoch or worker bits, mirror it; the ID only needs to be unique and of the same shape.

- [ ] **Step 4: Communities** — `server/internal/communities/welcome.go`:

```go
package communities

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Welcome is the welcome channel's page.
type Welcome struct {
	ChannelID id.ID  `json:"channel_id"`
	Markdown  string `json:"markdown"`
	RulesGate bool   `json:"rules_gate" doc:"New members see only this page until they accept the rules"`
}

type UpdateWelcomeRequest struct {
	Markdown  string `json:"markdown" maxLength:"50000"`
	RulesGate bool   `json:"rules_gate"`
}

func (s *Service) welcome(ctx context.Context, serverID id.ID) (*Welcome, error) {
	var w Welcome
	err := s.db.QueryRow(ctx, `
		SELECT ch.id, c.welcome_markdown, c.rules_gate
		FROM communities c JOIN channels ch ON ch.community_id = c.id AND ch.type = 'welcome'
		WHERE c.id = $1`, serverID).Scan(&w.ChannelID, &w.Markdown, &w.RulesGate)
	return &w, err
}

func registerWelcome(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("get-welcome", http.MethodGet, "/api/server/welcome", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body *Welcome }, error) {
			a, err := s.requireActor(ctx, 0)
			if err != nil {
				return nil, err
			}
			w, err := s.welcome(ctx, a.CommunityID)
			return &struct{ Body *Welcome }{w}, err
		})

	huma.Register(api, op("update-welcome", http.MethodPut, "/api/server/welcome", 0),
		func(ctx context.Context, in *struct{ Body UpdateWelcomeRequest }) (*struct{ Body *Welcome }, error) {
			a, err := s.requireActor(ctx, perms.ManageServer)
			if err != nil {
				return nil, err
			}
			if in.Body.RulesGate && strings.TrimSpace(in.Body.Markdown) == "" {
				return nil, httpx.BadRequest("WELCOME_EMPTY", "write the welcome page before turning on the rules gate")
			}
			var wasGated bool
			if err := s.db.QueryRow(ctx, `
				UPDATE communities c SET welcome_markdown = $2, rules_gate = $3
				FROM communities old WHERE c.id = $1 AND old.id = c.id
				RETURNING old.rules_gate`, a.CommunityID, in.Body.Markdown, in.Body.RulesGate).Scan(&wasGated); err != nil {
				return nil, err
			}
			w, err := s.welcome(ctx, a.CommunityID)
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "WELCOME_UPDATE", Data: w, Scope: events.Scope{CommunityID: a.CommunityID}})
			if wasGated != w.RulesGate {
				if err := s.PublishServerUpdate(ctx); err != nil {
					return nil, err
				}
			}
			return &struct{ Body *Welcome }{w}, nil
		})

	huma.Register(api, op("accept-rules", http.MethodPost, "/api/server/welcome/accept", http.StatusNoContent),
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			a, err := s.requireActor(ctx, 0)
			if err != nil {
				return nil, err
			}
			tag, err := s.db.Exec(ctx, `
				UPDATE members SET accepted_rules_at = now()
				WHERE community_id = $1 AND user_id = $2 AND accepted_rules_at IS NULL`, a.CommunityID, auth.Current(ctx).User.ID)
			if err != nil || tag.RowsAffected() == 0 {
				return nil, err
			}
			return nil, s.publishMemberUpdate(ctx, a.CommunityID, auth.Current(ctx).User.ID)
		})
}
```

(`UPDATE … FROM communities old` reads the pre-update row because the `FROM` table sees the snapshot from before the statement.) Call `registerWelcome(api, s, op)` from `Register`.

In `communities.go`:
- `Server` gains `RulesGate bool \`json:"rules_gate"\``; `Server(ctx)` selects `rules_gate`.
- `Member` gains `AcceptedRulesAt *time.Time \`json:"accepted_rules_at,omitempty"\``; `members` selects `m.accepted_rules_at` (add it to `GROUP BY`).
- `PermMember` gains `Gated bool // the rules gate hides everything but the welcome page`; `permMembers` reads the server's `owner_id, rules_gate` in the query that replaced `s.get` and selects `m.accepted_rules_at IS NULL` per member; `Gated = rulesGate && notAccepted && uid != ownerID`.
- Every place that inserts into `members` (`EnsureServer`, `addMember`, `join`) sets `accepted_rules_at` to `CASE WHEN (SELECT rules_gate FROM communities WHERE id = $1) THEN NULL ELSE now() END` — for `EnsureServer` simply `now()` (a new server has no gate).
- `SharesCommunity` excludes gated members:

```go
func (s *Service) SharesCommunity(ctx context.Context, a, b id.ID) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM members x JOIN members y ON x.community_id = y.community_id
		               JOIN communities c ON c.id = x.community_id
		               WHERE x.user_id = $1 AND y.user_id = $2
		                 AND (NOT c.rules_gate OR ((x.accepted_rules_at IS NOT NULL OR x.user_id = c.owner_id)
		                                       AND (y.accepted_rules_at IS NOT NULL OR y.user_id = c.owner_id))))`, a, b).Scan(&ok)
	return ok, err
}
```

In `handlers.go`, `requireActor`: after loading `m`, `if m.Gated { if need != 0 { return actor{}, errGated() }; return actor{CommunityID: sid, Member: m}, nil }` with

```go
func errGated() *httpx.Error {
	return httpx.E(http.StatusForbidden, "RULES_NOT_ACCEPTED", "accept the server's rules on the welcome page first")
}
```

and `list-members` refuses gated callers (`if a.Member.Gated { return nil, errGated() }`). Same in `create-invite` (it needs `CREATE_INVITE`, so it is already refused).

- [ ] **Step 5: Channels** — in `channels.go`: `TypeWelcome = "welcome"`; `Channel.Type` enum `text,voice,welcome,dm`; `SeedCommunity` inserts the welcome channel (`'welcome', 'welcome', position -1`) and then `general` (position 0); `effective` starts with:

```go
	if m.Gated {
		if c.Type == TypeWelcome {
			return perms.ViewChannel
		}
		return 0
	}
```

In `handlers.go` `delete-channel`: after loading the channel, `if c.Type == TypeWelcome { return nil, httpx.BadRequest("CANNOT_DELETE_WELCOME", "the welcome channel cannot be deleted") }`.

- [ ] **Step 6: Messages** — in `messages/handlers.go`, the `access` helper refuses the welcome channel for every message route:

```go
	access := func(ctx context.Context, raw string, need perms.Perms) (*channels.Channel, perms.Perms, error) {
		chID, err := httpx.ParseID(raw, "channel")
		if err != nil {
			return nil, 0, err
		}
		ch, p, err := s.channels.Access(ctx, auth.Current(ctx).User.ID, chID, need)
		if err == nil && ch.Type == channels.TypeWelcome {
			return nil, 0, httpx.BadRequest("NO_MESSAGES_HERE", "the welcome channel has no messages")
		}
		return ch, p, err
	}
```

Uploads (`files.upload`) need `ATTACH_FILES`, which a gated member lacks and the welcome channel never grants usefully; leave them.

- [ ] **Step 7: READY** — in `realtime.go` `Build`, after the membership check, load the member's `PermMember`; when `Gated`: fill `ReadyServer` with the server, roles, `Members: []` and the visible channels (only the welcome channel, via `ListVisible`), and leave presences, DMs, voice states and read states empty. Otherwise build as in Task 1.

- [ ] **Step 8: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...` (PowerShell). Expected: PASS (channel-count assertions in older tests may need +1 for `#welcome`; fix those tests, not the behaviour). `gofmt -l server` empty.

- [ ] **Step 9: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(server): welcome channel and page with an optional rules gate`

---

### Task 4: Roles — colour, hoist, hierarchy, new permissions

**Files:**
- Create: `server/internal/db/migrations/00010_roles_status.sql` (also holds Task 5's column), `server/internal/communities/hierarchy.go`, `server/internal/communities/hierarchy_test.go`
- Modify: `server/internal/perms/perms.go`, `perms_test.go`
- Modify: `server/internal/communities/communities.go` (`Role` fields, `scanRole`, `Roles`), `roles.go` (requests, hierarchy checks, ban revokes sessions)
- Modify: `server/internal/auth/service.go` (exported `RevokeSessions`)
- Modify: `server/internal/messages/messages.go`, `handlers.go` (hierarchy for deleting others' messages); `server/internal/voice/voice.go`, `reconcile.go` (hierarchy for mute, move, disconnect)
- Modify: `server/internal/app/app.go` (wiring)

**Interfaces:**
- Produces (package `perms`): `AddReactions` (bit 17), `CreateThreads` (18), `UseSoundboard` (19), `ManageExpressions` (20); `All` = `(1<<21)-1`; `Default` adds `AddReactions | CreateThreads | UseSoundboard`.
- Produces (package `communities`): `Role.Color *string` (JSON `color,omitempty`, one of `RoleColors`), `Role.Hoist bool` (JSON `hoist`); `RoleColors = []string{"#e74c3c", "#f5a524", "#2ecc71", "#2dd4bf", "#4aa3ff", "#a78bfa", "#fb7185", "#969da2"}`; `(*Service).Outranks(ctx, actorID, targetID id.ID) (bool, error)`; `Users` interface gains `RevokeSessions(ctx, userID id.ID) error`.
- Requests: `CreateRoleRequest{name, permissions, color?, hoist?}`; `UpdateRoleRequest{name?, permissions?, position?, color?, hoist?, clear_color?}` (`clear_color: true` removes the colour).
- Produces (package `auth`): `(*Service).RevokeSessions(ctx, userID) error` (wraps `revokeAll`).
- Consumed by `messages` and `voice`: `type Ranks interface{ Outranks(ctx context.Context, actorID, targetID id.ID) (bool, error) }`; `messages.NewService(pool, bus, ch, users, attachments, ranks)`; `voice.NewService(cfg, bus, ch, ranks)` (a nil `ranks` means "no hierarchy", used by the voice restart test).

Hierarchy (spec §2, §4): a member's rank is the highest `position` among their roles (`@everyone` is 0); the owner outranks everyone. `Outranks(a, t)` is true when `a` is the owner and `t` is not, or `a`'s rank > `t`'s rank, or `t` is not a member (and `a` is). Role rules: creating a role puts it directly below the actor's highest role (owner: on top); editing, deleting or assigning a role needs `role.position < actor rank` (owner: any role but `@everyone`'s position stays 0); a new `position` must be ≥ 1 and < actor rank (owner: any ≥ 1), and moving a role shifts the others so positions stay unique. Moderation (kick, ban, voice mute/move/disconnect of others, deleting others' messages in server channels) needs the permission and `Outranks`. The old subset rule (`canModerate`) is replaced; `canTouch` ("you cannot grant what you do not have") stays.

- [ ] **Step 1: Write the failing tests** — add to `server/internal/perms/perms_test.go`:

```go
func TestNewFlags(t *testing.T) {
	require.Equal(t, perms.Perms(1<<15), perms.ManageServer)
	require.Equal(t, perms.Perms(1<<17), perms.AddReactions)
	require.Equal(t, perms.Perms(1<<18), perms.CreateThreads)
	require.Equal(t, perms.Perms(1<<19), perms.UseSoundboard)
	require.Equal(t, perms.Perms(1<<20), perms.ManageExpressions)
	require.Equal(t, perms.Perms(1<<21-1), perms.All)
	require.True(t, perms.Default.Has(perms.AddReactions|perms.CreateThreads|perms.UseSoundboard))
	require.False(t, perms.Default.Has(perms.ManageExpressions))
}
```

`server/internal/communities/hierarchy_test.go`:

```go
package communities_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/perms"
)

// staff sets up: alice (owner), bob (Moderator: kick, ban, manage roles),
// carol (Helper: kick), dave (no roles). Moderator ranks above Helper.
func staff(t *testing.T) (env *apptest.Env, alice, bob, carol, dave *apptest.Client, mod, helper communities.Role) {
	env = apptest.New(t)
	alice, bob, carol, dave = env.Register("alice"), env.Register("bob"), env.Register("carol"), env.Register("dave")
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Helper", "permissions": perms.Kick}, http.StatusCreated, &helper)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Moderator", "permissions": perms.Kick | perms.Ban | perms.ManageRoles,
		"color": "#4aa3ff", "hoist": true}, http.StatusCreated, &mod)
	alice.Do(http.MethodPatch, "/api/server/roles/"+mod.ID.String(), map[string]any{"position": 2}, http.StatusOK, &mod)
	alice.Do(http.MethodPatch, "/api/server/roles/"+helper.ID.String(), map[string]any{"position": 1}, http.StatusOK, &helper)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, "/api/server/members/"+carol.User.ID.String()+"/roles/"+helper.ID.String(), nil, http.StatusNoContent, nil)
	return
}

func TestRoleColourAndHoist(t *testing.T) {
	_, alice, _, _, _, mod, _ := staff(t)
	require.Equal(t, "#4aa3ff", *mod.Color)
	require.True(t, mod.Hoist)
	alice.Fail(http.MethodPatch, "/api/server/roles/"+mod.ID.String(), map[string]any{"color": "#123456"}, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
	var r communities.Role
	alice.Do(http.MethodPatch, "/api/server/roles/"+mod.ID.String(), map[string]any{"clear_color": true}, http.StatusOK, &r)
	require.Nil(t, r.Color)
}

func TestModerationFollowsHierarchy(t *testing.T) {
	_, _, bob, carol, dave, _, _ := staff(t)
	carol.Fail(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION") // helper < moderator
	bob.Do(http.MethodDelete, "/api/server/members/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)                   // moderator > helper
	bob.Do(http.MethodDelete, "/api/server/members/"+dave.User.ID.String(), nil, http.StatusNoContent, nil)
}

func TestRoleEditingFollowsHierarchy(t *testing.T) {
	_, alice, bob, _, _, mod, helper := staff(t)
	bob.Fail(http.MethodPatch, "/api/server/roles/"+mod.ID.String(), map[string]any{"name": "Boss"}, http.StatusForbidden, "MISSING_PERMISSION")      // own top role
	bob.Do(http.MethodPatch, "/api/server/roles/"+helper.ID.String(), map[string]any{"name": "Trial helper"}, http.StatusOK, nil)                     // below
	bob.Fail(http.MethodPatch, "/api/server/roles/"+helper.ID.String(), map[string]any{"position": 2}, http.StatusForbidden, "MISSING_PERMISSION")    // not up to his own rank
	var created communities.Role
	bob.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Regular"}, http.StatusCreated, &created)
	require.Less(t, created.Position, 3, "a new role goes below the creator's highest role")
	bob.Fail(http.MethodPut, "/api/server/members/"+alice.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")

	roles := alice.Server().Roles
	seen := map[int]bool{}
	for _, r := range roles {
		require.False(t, seen[r.Position], "positions stay unique")
		seen[r.Position] = true
	}
}

func TestBanRevokesSessions(t *testing.T) {
	env, alice, _, _, dave, _, _ := staff(t)
	_ = env
	alice.Do(http.MethodPut, "/api/server/bans/"+dave.User.ID.String(), map[string]any{}, http.StatusNoContent, nil)
	dave.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, unauthCode)
}
```

Add to `messages/messages_test.go`: a helper (rank 1, `MANAGE_MESSAGES` on a role) cannot delete a message by a moderator (rank 2) → 403, but can delete @everyone-only members' messages → 204. Add to `voice/voice_test.go` (or `state_test.go`, wherever moderation tests live): a lower-ranked member with `MUTE_MEMBERS` cannot server-mute a higher-ranked one → 403. `unauthCode` stands for the code `auth` returns for a revoked or unknown token — find it in `auth/service.go` (`authenticateRequest`) and write the literal in (`Fail` compares the code exactly).

- [ ] **Step 2: Run to verify they fail** — `go -C server test ./internal/perms/ ./internal/communities/`. Expected: compile errors (`perms.AddReactions`, `Role.Color` undefined).

- [ ] **Step 3: Permissions** — in `perms.go`, after `Admin` in the `iota` block add `AddReactions`, `CreateThreads`, `UseSoundboard`, `ManageExpressions` (bits 17–20, in that order); `All` becomes `ManageExpressions<<1 - 1`; `Default` gains `| AddReactions | CreateThreads | UseSoundboard`. Update the doc comment of `Default` ("what @everyone gets on a new server").

- [ ] **Step 4: Migration** — `server/internal/db/migrations/00010_roles_status.sql`:

```sql
-- +goose Up
ALTER TABLE roles
    ADD COLUMN color TEXT CHECK (color IN ('#e74c3c', '#f5a524', '#2ecc71', '#2dd4bf', '#4aa3ff', '#a78bfa', '#fb7185', '#969da2')),
    ADD COLUMN hoist BOOLEAN NOT NULL DEFAULT false;

-- New flags for @everyone: ADD_REACTIONS (1<<17), CREATE_THREADS (1<<18), USE_SOUNDBOARD (1<<19).
UPDATE roles SET permissions = permissions | (1 << 17) | (1 << 18) | (1 << 19) WHERE id = community_id;

-- Make role positions unique and dense (@everyone stays 0).
UPDATE roles r SET position = o.n
FROM (SELECT id, row_number() OVER (PARTITION BY community_id ORDER BY position, id) AS n
      FROM roles WHERE id <> community_id) o
WHERE r.id = o.id;

ALTER TABLE users ADD COLUMN custom_status TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE users DROP COLUMN custom_status;
UPDATE roles SET permissions = permissions & ~((1 << 17) | (1 << 18) | (1 << 19)) WHERE id = community_id;
ALTER TABLE roles DROP COLUMN hoist, DROP COLUMN color;
```

- [ ] **Step 5: Hierarchy** — `server/internal/communities/hierarchy.go`:

```go
package communities

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// RoleColors are the colours a role may have.
var RoleColors = []string{"#e74c3c", "#f5a524", "#2ecc71", "#2dd4bf", "#4aa3ff", "#a78bfa", "#fb7185", "#969da2"}

// ownerRank is above any role position.
const ownerRank = 1 << 30

// rank is userID's highest role position (ownerRank for the owner, -1 for
// non-members).
func (s *Service) rank(ctx context.Context, tx pgx.Tx, serverID, userID id.ID) (int, error) {
	var r int
	q := `
		SELECT CASE WHEN c.owner_id = $2 THEN $3
		            ELSE COALESCE((SELECT max(ro.position) FROM member_roles mr JOIN roles ro ON ro.id = mr.role_id
		                           WHERE mr.community_id = $1 AND mr.user_id = $2), 0) END
		FROM communities c JOIN members m ON m.community_id = c.id AND m.user_id = $2
		WHERE c.id = $1`
	var row pgx.Row
	if tx != nil {
		row = tx.QueryRow(ctx, q, serverID, userID, ownerRank)
	} else {
		row = s.db.QueryRow(ctx, q, serverID, userID, ownerRank)
	}
	err := row.Scan(&r)
	if errors.Is(err, pgx.ErrNoRows) {
		return -1, nil
	}
	return r, err
}

// Outranks reports whether actorID may moderate targetID (spec §2: role hierarchy).
func (s *Service) Outranks(ctx context.Context, actorID, targetID id.ID) (bool, error) {
	sid, err := s.ServerID(ctx)
	if err != nil {
		return false, err
	}
	a, err := s.rank(ctx, nil, sid, actorID)
	if err != nil {
		return false, err
	}
	t, err := s.rank(ctx, nil, sid, targetID)
	if err != nil {
		return false, err
	}
	return a >= 0 && a > t, nil
}

// canModerate refuses unless the actor outranks the target.
func (s *Service) canModerate(ctx context.Context, a actor, target id.ID) error {
	ok, err := s.Outranks(ctx, a.Member.UserID, target)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.MissingPermission()
	}
	return nil
}

// canEditRole refuses unless the role is below the actor's highest role.
func (s *Service) canEditRole(ctx context.Context, a actor, r *Role) error {
	rank, err := s.rank(ctx, nil, a.CommunityID, a.Member.UserID)
	if err != nil {
		return err
	}
	if r.Position >= rank {
		return httpx.MissingPermission()
	}
	return nil
}

// moveRole puts role r at position pos (≥ 1), shifting the roles in between
// so positions stay unique.
func moveRole(ctx context.Context, tx pgx.Tx, serverID id.ID, r *Role, pos int) error {
	var top int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(position), 0) FROM roles WHERE community_id = $1`, serverID).Scan(&top); err != nil {
		return err
	}
	pos = min(pos, top)
	if pos == r.Position {
		return nil
	}
	if pos > r.Position {
		_, err := tx.Exec(ctx, `UPDATE roles SET position = position - 1 WHERE community_id = $1 AND position > $2 AND position <= $3`,
			serverID, r.Position, pos)
		if err != nil {
			return err
		}
	} else {
		_, err := tx.Exec(ctx, `UPDATE roles SET position = position + 1 WHERE community_id = $1 AND position >= $2 AND position < $3`,
			serverID, pos, r.Position)
		if err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `UPDATE roles SET position = $2 WHERE id = $1`, r.ID, pos)
	return err
}
```

Remove the old `canModerate` from `roles.go`.

- [ ] **Step 6: Roles** — in `communities.go`: `Role` gains `Color *string \`json:"color,omitempty"\`` and `Hoist bool \`json:"hoist"\``; every role `SELECT`/`RETURNING` lists `id, community_id, name, permissions, position, color, hoist` (one `roleCols` constant), and `scanRole` scans them; `Roles` orders by `position DESC, id` (highest first, as the settings list shows them).

In `roles.go`:

```go
type CreateRoleRequest struct {
	Name        string      `json:"name" minLength:"1" maxLength:"32"`
	Permissions perms.Perms `json:"permissions"`
	Color       *string     `json:"color,omitempty" enum:"#e74c3c,#f5a524,#2ecc71,#2dd4bf,#4aa3ff,#a78bfa,#fb7185,#969da2"`
	Hoist       bool        `json:"hoist,omitempty" doc:"Show members with this role separately in the member list"`
}

type UpdateRoleRequest struct {
	Name        *string      `json:"name,omitempty" minLength:"1" maxLength:"32"`
	Permissions *perms.Perms `json:"permissions,omitempty"`
	Position    *int         `json:"position,omitempty" minimum:"1" doc:"Higher is more senior; @everyone is always 0"`
	Color       *string      `json:"color,omitempty" enum:"#e74c3c,#f5a524,#2ecc71,#2dd4bf,#4aa3ff,#a78bfa,#fb7185,#969da2"`
	ClearColor  bool         `json:"clear_color,omitempty"`
	Hoist       *bool        `json:"hoist,omitempty"`
}
```

- `create-role`: in a transaction, compute the actor's rank; the new position is `rank` for non-owners (shift every role with `position >= rank` up by one first, so it lands directly below the actor's highest role) and `max+1` for the owner; insert with colour and hoist.
- `update-role`: `canTouch` as today; unless the role is `@everyone`, `canEditRole`; for `@everyone` only `permissions` may change (name and position refused as today; colour/hoist → 400 `CANNOT_STYLE_EVERYONE`); a `position` must be `< rank` for non-owners (else `MissingPermission`) and is applied with `moveRole` inside the transaction before the other fields; colour is set, cleared (`clear_color`), or kept.
- `delete-role`: `canEditRole` added; after deleting, close the gap (`UPDATE roles SET position = position - 1 WHERE community_id = $1 AND position > $2`) in the same transaction.
- `assign` (add/remove member role): `canEditRole` for the role, and `canModerate` for the target unless the target is the actor (you may drop your own lower roles but not take your top role, which `canEditRole` already prevents).
- `ROLE_UPDATE` for every role whose position changed: after a move, publish `ROLE_UPDATE` for each affected role (re-read them in one query).
- `ban`: after the transaction, `s.users.RevokeSessions(ctx, userID)` (log and continue on error); `Users` gains `RevokeSessions`.

In `auth/service.go` add `func (s *Service) RevokeSessions(ctx context.Context, userID id.ID) error { return s.revokeAll(ctx, userID) }`.

- [ ] **Step 7: Messages and voice** — in `messages/messages.go` add `Ranks` (interface above) and the `ranks Ranks` field/param; in `delete-message`, after the `ManageMessages` check, for a server channel and someone else's message:

```go
			if me := auth.Current(ctx).User.ID; m.Author.ID != me && ch.Type != channels.TypeDM {
				ok, err := s.ranks.Outranks(ctx, me, m.Author.ID)
				if err != nil {
					return nil, err
				}
				if !ok {
					return nil, httpx.MissingPermission()
				}
			}
```

In `voice/voice.go` add `Ranks` and a `ranks` field (`NewService(cfg, bus, ch, ranks)`); in `reconcile.go` `inVoice`, after `Access`, when `callerID != userID && s.ranks != nil`, require `Outranks` (else `httpx.MissingPermission()`). Update `app.go`: `messages.NewService(pool, a.Bus, chanSvc, authSvc, filesSvc, commSvc)`, `voice.NewService(cfg.LiveKit, a.Bus, chanSvc, commSvc)`; the voice test that builds a bare service passes `nil`.

- [ ] **Step 8: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...` (PowerShell). Expected: PASS. Older tests that relied on the subset rule (e.g. "a member with the same permissions cannot be kicked") change to the hierarchy rule; keep their intent. `gofmt -l server` empty.

- [ ] **Step 9: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(server): role colours, separate display, hierarchy and new permission flags`

---

### Task 5: Custom status

**Files:**
- Modify: `server/internal/auth/store.go` (`custom_status` in `User`, `PublicUser`, queries; `UpdateProfile`), `handlers.go` (`update-me`), `handlers_test.go`

**Interfaces:**
- Produces: `User.CustomStatus string` and `PublicUser.CustomStatus string` (JSON `custom_status`); `UpdateMeRequest{display_name?, custom_status?}` (both optional now; `custom_status` max 80 characters, trimmed; `""` clears it); `USER_UPDATE` carries the new `PublicUser`.
- The column was added in Task 4's migration (`00010_roles_status.sql`).

- [ ] **Step 1: Write the failing test** — add to `server/internal/auth/handlers_test.go`:

```go
func TestCustomStatus(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var me auth.User
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"custom_status": "  Playing Factorio  "}, http.StatusOK, &me)
	require.Equal(t, "Playing Factorio", me.CustomStatus)
	require.Equal(t, "alice", me.DisplayName, "display name unchanged when omitted")
	var ev auth.PublicUser
	ws.ExpectDispatch("USER_UPDATE", &ev)
	require.Equal(t, "Playing Factorio", ev.CustomStatus)

	long := strings.Repeat("x", 81)
	alice.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"custom_status": long}, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"custom_status": ""}, http.StatusOK, &me)
	require.Equal(t, "", me.CustomStatus)
}
```

(Use the package's existing test package name and imports; if `auth` tests cannot import `apptest` because of an import cycle, put this test in `server/internal/app/app_test.go` instead.)

- [ ] **Step 2: Run to verify it fails** — `go -C server test ./internal/auth/ -run TestCustomStatus`. Expected: compile error (`CustomStatus` undefined).

- [ ] **Step 3: Implement** — in `store.go`: `CustomStatus string \`json:"custom_status"\`` on `User` and `PublicUser`; `userCols` and `scanUser` include `u.custom_status`; `Public()` copies it; `PublicUsers` selects it. Replace `UpdateDisplayName` with:

```go
// UpdateProfile changes the fields that are not nil.
func (s *Store) UpdateProfile(ctx context.Context, userID id.ID, displayName, customStatus *string) (*User, error) {
	return scanUser(s.db.QueryRow(ctx, `
		UPDATE users u SET display_name = COALESCE($2, display_name), custom_status = COALESCE($3, custom_status)
		WHERE u.id = $1 RETURNING `+userCols, userID, displayName, customStatus))
}
```

In `handlers.go`:

```go
type UpdateMeRequest struct {
	DisplayName  *string `json:"display_name,omitempty" minLength:"1" maxLength:"32"`
	CustomStatus *string `json:"custom_status,omitempty" maxLength:"80" doc:"Shown under your name; empty clears it"`
}
```

and `update-me` trims both (a display name that is empty after trimming → 422 `VALIDATION_FAILED` with "display name cannot be blank") before calling `UpdateProfile`. Update any other caller of `UpdateDisplayName` (grep).

- [ ] **Step 4: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...`. Expected: PASS. Then regenerate the OpenAPI document and the client schema, since Tasks 1–5 changed the API: `go -C server run ./cmd/datrope openapi > clients/core/openapi.json` and `pnpm -C clients/core run gen` (check `clients/core/package.json` for the script name and the exact openapi command the repo uses; the M2/M3 plans did the same step). Commit nothing; the client compile errors this causes are fixed in Task 6.

- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(auth): custom status`

---
### Task 6: Core client — one server

**Files:**
- Modify: `clients/core/src/types.ts`, `store.ts`, `client.ts`, `perms.ts` (and their tests `store.test.ts`, `client.test.ts`, `perms.test.ts`)
- `clients/core/openapi.json` and `src/schema.d.ts` were regenerated in Task 5; regenerate again if they are stale (`pnpm -C clients/core run gen`, or the script the package defines).

**Interfaces:**
- Consumes: the API from Tasks 1–5 (`GET /api/server`, `/api/server/channels`, `/api/server/members`, `/api/server/welcome`, `POST /api/server/welcome/accept`, `POST /api/invites/{code}/accept`; READY `server`; events `SERVER_UPDATE`, `WELCOME_UPDATE`, `MEMBER_*`, `ROLE_*`, `CHANNEL_*`, `USER_UPDATE`).
- Produces (types): `Server = Schemas["Server"]`, `ServerWithRoles = Schemas["ServerWithRoles"]`, `Welcome = Schemas["Welcome"]`; `Community`, `CommunityWithRoles` removed; `EventMap` gains `SERVER_UPDATE: Server`, `WELCOME_UPDATE: Welcome`, loses `COMMUNITY_*`.
- Produces (store): `interface ServerState { server: Server; roles: Record<string, Role>; members: Record<string, Member>; channelIds: string[] }`; `State.server: ServerState | null` and `State.welcome: Welcome | null` replace `communities`/`communityOrder`; `setChannels(s, chs)`, `setMembers(s, members)` (no community ID); selectors `myRoleIds(s): string[]`, `myBasePerms(s): number`, `myChannelPerms(s, channelId): number`, `isGated(s): boolean`, `rolesByRank(s): Role[]` (highest first, `@everyone` last).
- Produces (perms): `Perm.ManageServer` (replaces `ManageCommunity`, same bit), `Perm.AddReactions` (1<<17), `CreateThreads` (1<<18), `UseSoundboard` (1<<19), `ManageExpressions` (1<<20); `ALL_PERMS = (1 << 21) - 1`; `basePerms(server, roles, userId, roleIds)` and `channelPerms(server, roles, userId, roleIds, ch, gated = false)` (a gated member gets `ViewChannel` in the welcome channel and 0 elsewhere — mirrors Task 3).
- Produces (client): `loadChannels()`, `loadMembers()`, `loadWelcome()`, `acceptRules()` (POST, then reconnects the gateway for a full READY), `joinServer(code)` (accept the invite, then reconnect), `uploadServerImage(kind: "icon" | "banner" | "page", file)` → `{ url, id? }`, `deleteServerImage(kind)`.

- [ ] **Step 1: Write the failing tests** — replace the community cases in `clients/core/src/store.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { applyEvent, applyReady, initialState, isGated, myChannelPerms, rolesByRank } from "./store";
import { Perm } from "./perms";
import type { Ready } from "./types";

const server = { id: "1", name: "Datrope", description: "", palette: "emerald", owner_id: "10", created_at: "", rules_gate: false };
const everyone = { id: "1", name: "@everyone", permissions: Perm.ViewChannel | Perm.SendMessages, position: 0, hoist: false };
const mod = { id: "2", name: "Mod", permissions: Perm.Kick, position: 1, hoist: true, color: "#4aa3ff" };
const me = { id: "20", username: "bob", display_name: "Bob", custom_status: "", is_admin: false, disabled: false, created_at: "" };
const ready = (over: Partial<Ready> = {}): Ready => ({
  session_id: "s", user: me, dms: [], presences: [], read_states: [], voice_states: [],
  server: {
    ...server, roles: [everyone, mod],
    members: [{ user: { id: "20", username: "bob", display_name: "Bob", custom_status: "" }, role_ids: [], joined_at: "", accepted_rules_at: "x" }],
    channels: [
      { id: "100", type: "welcome", name: "welcome", position: -1, overrides: [] },
      { id: "101", type: "text", name: "general", position: 0, overrides: [] },
    ],
  },
  ...over,
} as Ready);

describe("one server", () => {
  it("applies READY", () => {
    const s = applyReady(initialState, ready());
    expect(s.server?.server.name).toBe("Datrope");
    expect(s.server?.channelIds).toEqual(["100", "101"]);
    expect(rolesByRank(s).map((r) => r.name)).toEqual(["Mod", "@everyone"]);
  });

  it("has no server for a non-member", () => {
    const s = applyReady(initialState, ready({ server: undefined }));
    expect(s.server).toBeNull();
  });

  it("updates the server and drops it when I am removed", () => {
    let s = applyReady(initialState, ready());
    s = applyEvent(s, "SERVER_UPDATE", { ...server, name: "Basement", palette: "ocean" });
    expect(s.server?.server.palette).toBe("ocean");
    s = applyEvent(s, "MEMBER_REMOVE", { user_id: "20" });
    expect(s.server).toBeNull();
    expect(s.channels["101"]).toBeUndefined();
  });

  it("adds channels without a community ID", () => {
    let s = applyReady(initialState, ready());
    s = applyEvent(s, "CHANNEL_CREATE", { id: "102", type: "voice", name: "Lounge", position: 1, overrides: [] });
    expect(s.server?.channelIds).toEqual(["100", "101", "102"]);
    expect(s.dmIds).toEqual([]);
  });

  it("gates a member who has not accepted the rules", () => {
    const gated = ready();
    gated.server!.rules_gate = true;
    gated.server!.members![0].accepted_rules_at = undefined;
    const s = applyReady(initialState, gated);
    expect(isGated(s)).toBe(true);
    expect(myChannelPerms(s, "100")).toBe(Perm.ViewChannel);
    expect(myChannelPerms(s, "101")).toBe(0);
  });

  it("stores the welcome page and my custom status", () => {
    let s = applyReady(initialState, ready());
    s = applyEvent(s, "WELCOME_UPDATE", { channel_id: "100", markdown: "# Hi", rules_gate: false });
    expect(s.welcome?.markdown).toBe("# Hi");
    s = applyEvent(s, "USER_UPDATE", { id: "20", username: "bob", display_name: "Bob", custom_status: "away" });
    expect(s.me?.custom_status).toBe("away");
    expect(s.server?.members["20"].user.custom_status).toBe("away");
  });
});
```

Keep the existing message, typing, read-state, DM and voice cases (adjust their READY fixtures to the new shape). In `perms.test.ts`, update `CommunityRef` uses to the server object and add a case for the new bits (`ALL_PERMS === (1 << 21) - 1`) and for `channelPerms(..., gated = true)`. In `client.test.ts`, replace community calls with `loadChannels()` hitting `/api/server/channels`, and add: `acceptRules()` POSTs `/api/server/welcome/accept` and then opens a new WebSocket (the test's fake WebSocket factory sees a second connection).

- [ ] **Step 2: Run to verify they fail** — `pnpm -C clients/core exec vitest run`. Expected: FAIL (type errors / missing exports).

- [ ] **Step 3: Implement** — `perms.ts`:

```ts
import type { Channel, Role } from "./types";

/** Mirrors server/internal/perms. Bit values must stay identical. */
export const Perm = {
  ViewChannel: 1 << 0,
  SendMessages: 1 << 1,
  AttachFiles: 1 << 2,
  ReadHistory: 1 << 3,
  ConnectVoice: 1 << 4,
  Speak: 1 << 5,
  Stream: 1 << 6,
  ManageMessages: 1 << 7,
  MuteMembers: 1 << 8,
  MoveMembers: 1 << 9,
  Kick: 1 << 10,
  Ban: 1 << 11,
  CreateInvite: 1 << 12,
  ManageRoles: 1 << 13,
  ManageChannels: 1 << 14,
  ManageServer: 1 << 15,
  Admin: 1 << 16,
  AddReactions: 1 << 17,
  CreateThreads: 1 << 18,
  UseSoundboard: 1 << 19,
  ManageExpressions: 1 << 20,
} as const;

// JavaScript bitwise operators work on 32 bits; revisit if flags pass bit 30.
export const ALL_PERMS = (1 << 21) - 1;
```

`DM_PERMS`, `OVERRIDABLE` and `hasPerm` unchanged; `CommunityRef` renamed `ServerRef` (same fields); `channelPerms` gains a last parameter `gated = false` and starts with `if (gated) return ch.type === "welcome" ? Perm.ViewChannel : 0;` (after the DM case).

`store.ts` — replace `CommunityState`, `communities`, `communityOrder`, `updateCommunity`, `removeCommunity`, and the `COMMUNITY_*` cases:

```ts
export interface ServerState {
  server: Server;
  roles: Record<string, Role>;
  members: Record<string, Member>; // by user ID
  channelIds: string[]; // visible channels, by position
}
```

`State` gets `server: ServerState | null` and `welcome: Welcome | null` (both `null` in `initialState`). `applyReady`:

```ts
export function applyReady(s: State, r: Ready): State {
  const channels: Record<string, Channel> = {};
  let server: ServerState | null = null;
  // Go serializes nil slices as null, so generated array types are nullable.
  if (r.server) {
    const { roles, members, channels: chs, ...sv } = r.server;
    server = {
      server: sv,
      roles: byKey(roles ?? [], (x) => x.id),
      members: byKey(members ?? [], (m) => m.user.id),
      channelIds: (chs ?? []).map((c) => c.id),
    };
    for (const c of chs ?? []) channels[c.id] = c;
  }
  const dms = r.dms ?? [];
  for (const dm of dms) channels[dm.id] = dm;
  return {
    ...s,
    me: r.user,
    server,
    welcome: null,
    channels,
    dmIds: dms.map((d) => d.id),
    messages: {},
    typing: {},
    voice: byKey(r.voice_states ?? [], (v) => v.user_id),
    presences: Object.fromEntries((r.presences ?? []).map((p) => [p.user_id, p.status])),
    readStates: Object.fromEntries(
      (r.read_states ?? []).map((x) => [x.channel_id, { lastReadId: x.last_read_id, lastMessageId: x.last_message_id }]),
    ),
  };
}

function updateServer(s: State, fn: (c: ServerState) => ServerState): State {
  return s.server ? { ...s, server: fn(s.server) } : s;
}

function leaveServer(s: State): State {
  if (!s.server) return s;
  let next = s;
  for (const ch of s.server.channelIds) next = removeChannel(next, ch);
  return { ...next, server: null, welcome: null };
}
```

`upsertChannel` branches on `c.type !== "dm"` (server channel) instead of `c.community_id`; `removeChannel` removes the ID from `server.channelIds` when present. `renameUser` updates `server.members[u.id].user`, DM participants, and `me` (`display_name` and `custom_status`). Event cases:

```ts
    case "SERVER_UPDATE":
      return updateServer(s, (cs) => ({ ...cs, server: data as Server }));
    case "WELCOME_UPDATE":
      return { ...s, welcome: data as Welcome };
    case "MEMBER_ADD":
    case "MEMBER_UPDATE": {
      const m = data as Member;
      return updateServer(s, (cs) => ({ ...cs, members: { ...cs.members, [m.user.id]: m } }));
    }
    case "MEMBER_REMOVE": {
      const d = data as { user_id: string };
      if (d.user_id === s.me?.id) return leaveServer(s);
      return updateServer(s, (cs) => {
        const members = { ...cs.members };
        delete members[d.user_id];
        return { ...cs, members };
      });
    }
    case "ROLE_CREATE":
    case "ROLE_UPDATE": {
      const r = data as Role;
      return updateServer(s, (cs) => ({ ...cs, roles: { ...cs.roles, [r.id]: r } }));
    }
    case "ROLE_DELETE": {
      const d = data as { id: string };
      return updateServer(s, (cs) => {
        const roles = { ...cs.roles };
        delete roles[d.id];
        const members = Object.fromEntries(Object.entries(cs.members).map(([k, m]) =>
          [k, { ...m, role_ids: (m.role_ids ?? []).filter((r) => r !== d.id) }]));
        return { ...cs, roles, members };
      });
    }
```

`setChannels(s, chs)` and `setMembers(s, members)` drop the community parameter. Selectors (append to `store.ts`; import `basePerms`, `channelPerms` from `./perms`):

```ts
export function myRoleIds(s: State): string[] {
  return (s.me && s.server?.members[s.me.id]?.role_ids) ?? [];
}

/** True while the rules gate hides everything but the welcome page from me. */
export function isGated(s: State): boolean {
  const sv = s.server;
  if (!sv || !s.me || !sv.server.rules_gate || sv.server.owner_id === s.me.id) return false;
  return !sv.members[s.me.id]?.accepted_rules_at;
}

export function myBasePerms(s: State): number {
  if (!s.server || !s.me || isGated(s)) return 0;
  return basePerms(s.server.server, Object.values(s.server.roles), s.me.id, myRoleIds(s));
}

export function myChannelPerms(s: State, channelId: string): number {
  const ch = s.channels[channelId];
  if (!ch || !s.me) return 0;
  if (ch.type === "dm") return channelPerms({ id: "", owner_id: "" }, [], s.me.id, [], ch);
  if (!s.server) return 0;
  return channelPerms(s.server.server, Object.values(s.server.roles), s.me.id, myRoleIds(s), ch, isGated(s));
}

/** Roles from highest to lowest; @everyone last. Returns a new array: select it with useShallow. */
export function rolesByRank(s: State): Role[] {
  return Object.values(s.server?.roles ?? {}).sort((a, b) => b.position - a.position);
}
```

(If the gated member's own `Member` is absent from READY — Task 3 sends `members: []` to gated members — `isGated` must still be true: treat a missing own member record as "not accepted" only when `rules_gate` is on, which the code above already does.)

`client.ts`:

```ts
  /** Some events only say "something changed"; fetch what they imply. */
  private async follow(type: string, data: unknown) {
    try {
      if (type === "MEMBER_UPDATE" && (data as Member).user.id === this.store.getState().me?.id) {
        await this.loadChannels(); // my roles changed what I can see
      } else if (type === "ROLE_UPDATE" || type === "ROLE_DELETE") {
        await this.loadChannels();
      }
    } catch (e) {
      console.warn(`datrope: refreshing after ${type} failed`, e);
    }
  }

  async loadChannels() {
    if (!this.store.getState().server) return;
    const chs = await unwrap(this.api.GET("/api/server/channels"));
    this.set((s) => setChannels(s, chs ?? []));
  }

  async loadMembers() {
    const ms = await unwrap(this.api.GET("/api/server/members"));
    this.set((s) => setMembers(s, ms ?? []));
  }

  async loadWelcome() {
    const w = await unwrap(this.api.GET("/api/server/welcome"));
    this.set((s) => ({ ...s, welcome: w }));
  }

  /** Accepts the rules, then reconnects so READY includes everything the gate hid. */
  async acceptRules() {
    await unwrap(this.api.POST("/api/server/welcome/accept"));
    this.connect(this.store.getState().presence);
  }

  /** Rejoins the server with an invite (after a kick), then reconnects. */
  async joinServer(code: string) {
    await unwrap(this.api.POST("/api/invites/{code}/accept", { params: { path: { code } } }));
    this.connect(this.store.getState().presence);
  }

  /** Uploads the server icon or banner (PUT) or a welcome-page image (POST). */
  async uploadServerImage(kind: "icon" | "banner" | "page", file: Blob): Promise<{ url: string; id?: string }> {
    const path = kind === "page" ? "/api/server/images" : `/api/server/${kind}`;
    return this.multipart(kind === "page" ? "POST" : "PUT", path, file, "image");
  }

  async deleteServerImage(kind: "icon" | "banner") {
    const res = await fetch(this.url(`/api/server/${kind}`), { method: "DELETE", headers: this.authHeaders(), credentials: "include" });
    if (!res.ok) await this.throwApiError(res);
  }
```

Factor the body of `upload` into private helpers `authHeaders()`, `multipart(method, path, file, filename)` and `throwApiError(res)` and make `upload` use them (same behaviour as today). Remove `CommunityWithRoles` imports and the "COMMUNITY_CREATE after creating a community" example in the `apply` doc comment (use "MESSAGE_CREATE after sending").

`types.ts`: replace `Community`/`CommunityWithRoles` with `Server`, `ServerWithRoles`, add `Welcome`; `EventMap`: remove the three `COMMUNITY_*` entries, add `SERVER_UPDATE: Server;` and `WELCOME_UPDATE: Welcome;`.

- [ ] **Step 4: Run** — `pnpm -C clients/core exec vitest run` and `pnpm -C clients/core exec tsc --noEmit`. Expected: PASS, no type errors. (The web app does not compile until Task 7; that is expected.)

- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(core): single server state, welcome page and rules gate`

---

### Task 7: Web — app layout, palette and logo

**Files:**
- Create: `clients/web/src/app/ServerSidebar.tsx` (replaces `ChannelSidebar.tsx`), `clients/web/src/app/SidebarFooter.tsx` (voice panel + profile strip), `clients/web/src/app/ProfileStrip.tsx`, `clients/web/src/app/DMList.tsx`, `clients/web/src/app/NotAMember.tsx`, `clients/web/src/components/logo.tsx`, `clients/web/src/lib/palettes.ts`, `clients/web/src/hooks/use-palette.ts`, `clients/web/src/assets/datrope-logo.svg` (copy of `docs/superpowers/mockups/datrope-logo.svg`)
- Modify: `clients/web/src/router.tsx`, `src/app/AppShell.tsx`, `src/app/ChannelView.tsx`, `src/app/DMView.tsx`, `src/app/Home.tsx`, `src/app/MemberList.tsx`, `src/app/voice/VoicePanel.tsx`, `src/app/dialogs/*` (drop community IDs), `src/pages/Invite.tsx`, `src/pages/AuthLayout.tsx` (server icon or mark), `src/permLabels.ts`
- Delete: `src/app/CommunityRail.tsx`, `src/app/CommunityView.tsx`, `src/app/ChannelSidebar.tsx`, `src/app/dialogs/CreateCommunityDialog.tsx`

**Interfaces:**
- Consumes (Task 6): `useApp((s) => s.server)`, `isGated`, `myBasePerms`, `myChannelPerms`, `rolesByRank`, `client.joinServer`, `client.loadMembers`.
- Produces: routes `/` (redirects to the welcome channel when gated, else the last visited or first text channel), `/channels/:channelId` (text, voice or welcome channel), `/messages/:channelId?` (DMs), `/settings` (your settings), `/server-settings/:section?` (Task 9/10), `/invite/:code`; `PALETTES: Record<Palette, { label: string; accent: string }>` and `usePalette()` (sets `--primary` and `--ring` on `document.documentElement` from `server.palette`); `<Logo className />` (the mark in `currentColor`) and `<ServerIcon size />` (uploaded icon, else the mark in the accent).

The visual source is `docs/superpowers/mockups/Main.dc.html` (channels tab) and `DMs.dc.html` (messages tab). Open both and match their structure, spacing and copy using the existing shadcn components and tokens:

- **No rail.** The left column is one sidebar (`bg-sidebar`, 240 px): header with the server icon (32 px, rounded), name and "N members" (members count from the store), a chevron opening a `DropdownMenu` with "Invite people" (needs `CREATE_INVITE`; opens `InviteDialog`), "Server settings" (needs any of `MANAGE_SERVER`, `MANAGE_ROLES`, `KICK`, `BAN`, `MANAGE_CHANNELS`) and "Create channel" (`MANAGE_CHANNELS`).
- Under the header, shadcn `Tabs` with **Channels** and **Messages** (the Messages tab shows an unread dot when any DM has unread messages). The tab follows the route (`/channels/...` ↔ Channels, `/messages/...` ↔ Messages); switching tabs navigates to the last channel or DM visited in that tab (remember both in `sessionStorage`, wrapped in try/catch).
- **Channels tab:** the welcome channel first (a `BookOpen`-style lucide icon, label = channel name), then text and voice channels by position, as today's `ChannelSidebar` renders them (unread state, voice members under voice channels). Channels the user cannot see are already absent.
- **Messages tab:** "New message" button (opens `NewDMDialog`) and the DM list (avatar initials, names, unread dot), as in `DMs.dc.html`.
- **Footer** (both tabs), on the `card` surface with a top border — not the near-black sidebar: the voice panel (today's `VoicePanel`, restyled so its background is `bg-card`, per the user's feedback on the mockup) and the **profile strip**: avatar initials with presence dot, display name, custom status (muted text, truncated; "Set a status" placeholder on hover), and buttons for mute, deafen and settings. Clicking the name area opens a `DropdownMenu` with presence choices (online, idle, invisible), "Edit status…" (a small `Dialog` with an `Input`, max 80 chars, Clear and Save → `PATCH /api/users/@me {custom_status}`) and "Sign out".
- **Main area:** `ChannelView` for text channels (header with `#name`; member list on the right as today, now grouped: members whose highest hoisted role exists are grouped under that role's name, in role order, then "Online" / "Offline" for the rest; names coloured with their highest coloured role), `VoiceChannelView` for voice, `WelcomeView` (Task 8 — until then render a placeholder `<div>` with the channel name) for the welcome channel, `DMView` for DMs.
- **Gate:** while `isGated(state)`, every route except the welcome channel redirects to it, the Messages tab is disabled, and the footer shows only the profile strip.
- **Not a member:** when `state.server === null` after READY (connection `ready`), render `NotAMember` instead of the layout: a centred `Card` with the mark, "You're not a member of this server", an input for an invite code or link (accept either `CODE` or `.../invite/CODE`), and "Join" → `client.joinServer(code)`; also a "Sign out" link.
- **Palette:** `lib/palettes.ts`:

```ts
/** Server palettes (spec: one-server design §2). The accent must keep #131313 text readable. */
export const PALETTES = {
  emerald: { label: "Emerald", accent: "#2ecc71" },
  ocean: { label: "Ocean", accent: "#4aa3ff" },
  violet: { label: "Violet", accent: "#a78bfa" },
  amber: { label: "Amber", accent: "#f5a524" },
  rose: { label: "Rose", accent: "#fb7185" },
  mint: { label: "Mint", accent: "#2dd4bf" },
} as const;

export type Palette = keyof typeof PALETTES;

/** Role colours a role may have (server/internal/communities RoleColors). */
export const ROLE_COLORS = ["#e74c3c", "#f5a524", "#2ecc71", "#2dd4bf", "#4aa3ff", "#a78bfa", "#fb7185", "#969da2"] as const;
```

`usePalette()` (called once in `AppShell`) sets `document.documentElement.style.setProperty("--primary", accent)` and `--ring`, and `--online` stays green (presence is not the brand colour). This module is the only place outside `styles.css` allowed to hold hex colours.
- **Logo:** `components/logo.tsx` imports the SVG with Vite's `?react`-free approach: inline the mark's `<path>` data in a small React component (`viewBox` from the SVG file, `fill="currentColor"`), so it recolours with `text-primary`. `ServerIcon` renders `<img src={client.url(server.icon_url)}>` when set, else `<Logo className="text-primary" />` on a `bg-muted` rounded square. Use `ServerIcon` in the sidebar header, `NotAMember`, `Home` and the auth pages (`AuthLayout` shows the instance's icon via `GET /api/server/icon`, falling back to the mark on error).
- `permLabels.ts`: rename the `ManageCommunity` entry to `{ flag: Perm.ManageServer, label: "Manage server", channel: false }`; add `AddReactions` ("Add reactions", channel), `CreateThreads` ("Create threads", channel), `UseSoundboard` ("Use soundboard", channel), `ManageExpressions` ("Manage emoji and sounds", server).
- `Home.tsx` becomes the `/` redirect logic (no invite box: invites live in `NotAMember` and `/invite/:code`). `pages/Invite.tsx` shows the server name from the preview (`server_name`, `member_count`); for a signed-in non-member, "Join" calls `client.joinServer(code)` and navigates to `/`; for a signed-in member it says "You're already a member" with a link home; signed out → register with the code as today.

- [ ] **Step 1: Build the layout** as described, deleting the community components. Keep every behaviour the old sidebar and views had (unread markers, typing, voice members, creating channels, channel settings dialog, DMs) — this task moves them, it does not drop them.

- [ ] **Step 2: Type-check and build** — `pnpm -C clients/web run typecheck` and `pnpm -C clients/web run build`. Expected: no errors.

- [ ] **Step 3: Look at it** — start the dev stack (`.claude/launch.json` has the configurations used before; the server and Vite dev server must both run) and check in the browser pane, at 1280×800: channels tab, messages tab, the voice panel on the card surface, the profile strip with a custom status, switching the palette via `PATCH /api/server` (from the console with `fetch`) recolours buttons and the mark, a kicked user sees the not-a-member page and can rejoin with an invite. Compare against `Main.dc.html` and `DMs.dc.html` and fix visible differences in structure (not pixel-perfect). Report what you checked.

- [ ] **Step 4: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(web): one-server layout with channels and messages tabs, palettes and logo`

---

### Task 8: Web — welcome page and editor

**Files:**
- Create: `clients/web/src/app/welcome/WelcomeView.tsx`, `WelcomeMarkdown.tsx`, `WelcomeEditor.tsx`, `channelCards.ts`, `channelCards.test.ts`
- Modify: `clients/web/package.json` (`react-markdown` `9.0.1`, `remark-gfm` `4.0.0`; add `vitest` as a dev dependency if the web package has no unit tests yet, with a `test` script `vitest run`), the route rendering for welcome channels (Task 7's placeholder)

**Interfaces:**
- Consumes: `client.loadWelcome()`, `state.welcome`, `client.acceptRules()`, `client.uploadServerImage("page", file)`, `isGated`, `myBasePerms` (`MANAGE_SERVER` shows "Edit page"), `PUT /api/server/welcome`.
- Produces: `parseChannelCards(markdown): Array<{ kind: "markdown"; text: string } | { kind: "card"; name: string; description: string }>` — splits the page into Markdown blocks and channel cards. A card is a line that is exactly `[[channel:<name> "<description>"]]` (name: the channel's name as shown, may contain spaces and `·`; description: any text without `"`); consecutive cards form one grid.

Visual source: `docs/superpowers/mockups/Welcome.dc.html` (reading) and `WelcomeEdit.dc.html` (editing). Match their structure:

- **Reading view:** the server banner (`server.banner_url`) across the top (a muted gradient block when unset), the server icon overlapping its bottom edge, server name and description, then the page. Markdown is rendered with `react-markdown` + `remark-gfm`, **no raw HTML** (do not add `rehype-raw`), links open in a new tab with `rel="noreferrer"`, images only from the same origin (`/api/server/images/...`) — drop others with a `components.img` override that renders nothing for absolute URLs on another host. Style the Markdown with token classes (headings, lists, quotes, tables, code) in `WelcomeMarkdown.tsx`; no typography plugin.
- **Channel cards:** a responsive grid of cards (shadcn `Card`): channel icon, `#name`, description; clicking navigates to the channel when it exists and the user can see it; unknown names render as a dimmed card "Channel not found".
- **Rules gate:** when `isGated`, a sticky bottom bar on the card surface: "Read the page above, then accept the rules to see the rest of the server." with a primary "I accept the rules" button → `client.acceptRules()`; after the reconnect the user lands on `/` (which now goes to `#general`).
- **Edit (MANAGE_SERVER):** an "Edit page" button in the header opens `WelcomeEditor` in place: a two-pane layout (`Textarea` with the Markdown on the left, live preview using the same `WelcomeMarkdown` on the right; stacked on narrow screens), a toolbar with "Insert image" (file picker → `uploadServerImage("page")` → inserts `![](url)` at the cursor), "Insert channel card" (a `DropdownMenu` of channels → inserts `[[channel:<name> "Describe this channel"]]` on its own line), a `Checkbox`/switch "Require new members to accept the rules" (disabled with a hint while the page is blank), character count against 50 000, and Cancel / Save (`PUT /api/server/welcome`; errors shown with `ErrorText`). Banner and icon are edited in Server settings → Look (Task 9); the editor links there.
- Empty page for non-editors: "Nothing here yet."; for editors: an empty state with "Write the welcome page".

- [ ] **Step 1: Write the failing test** — `channelCards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseChannelCards } from "./channelCards";

describe("parseChannelCards", () => {
  it("splits markdown and cards", () => {
    const md = '# Hi\nWelcome!\n\n[[channel:general "Chat about anything"]]\n[[channel:Club · lounge "Old club lounge"]]\n\nBye';
    expect(parseChannelCards(md)).toEqual([
      { kind: "markdown", text: "# Hi\nWelcome!\n" },
      { kind: "card", name: "general", description: "Chat about anything" },
      { kind: "card", name: "Club · lounge", description: "Old club lounge" },
      { kind: "markdown", text: "\nBye" },
    ]);
  });

  it("leaves inline or malformed cards as markdown", () => {
    const md = 'See [[channel:general "x"]] here\n[[channel:general]]';
    expect(parseChannelCards(md)).toEqual([{ kind: "markdown", text: md }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm -C clients/web exec vitest run src/app/welcome`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `channelCards.ts`:

```ts
export type WelcomeBlock = { kind: "markdown"; text: string } | { kind: "card"; name: string; description: string };

const CARD = /^\[\[channel:([^"\]]+?) "([^"]*)"\]\]$/;

/** Splits a welcome page into Markdown blocks and channel cards (one card per line). */
export function parseChannelCards(markdown: string): WelcomeBlock[] {
  const out: WelcomeBlock[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length > 0) out.push({ kind: "markdown", text: text.join("\n") });
    text = [];
  };
  for (const line of markdown.split("\n")) {
    const m = CARD.exec(line.trim());
    if (m) {
      flush();
      out.push({ kind: "card", name: m[1].trim(), description: m[2] });
    } else {
      text.push(line);
    }
  }
  flush();
  return out;
}
```

Then build `WelcomeMarkdown`, `WelcomeView` and `WelcomeEditor` as described, and render `WelcomeView` for welcome channels. Load the page with `client.loadWelcome()` on mount (the store keeps it current through `WELCOME_UPDATE`).

- [ ] **Step 4: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS. Note: the first test expects the Markdown text before the cards to end with `"\n"` (the blank line) and the text after to start with `"\n"`; if your split differs only in that whitespace, fix the test's expectation rather than adding trimming logic — both render identically.

- [ ] **Step 5: Look at it** — in the browser pane: write a page with a heading, a list, an uploaded image and two channel cards; save; check the reading view; turn the gate on, register a new user in a private window (or a second browser tab via the pane) and confirm they see only the welcome page, accept, and reach `#general`. Compare with `Welcome.dc.html` and `WelcomeEdit.dc.html`. Report what you checked.

- [ ] **Step 6: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(web): welcome page with Markdown editor, channel cards and rules gate`

---

### Task 9: Web — server settings shell, Overview, Look, Invites, Bans, Sign-ups, Uploads and voice

**Files:**
- Create: `clients/web/src/app/server-settings/ServerSettings.tsx` (shell + routing), `Overview.tsx`, `Look.tsx`, `Invites.tsx`, `Bans.tsx`, `SignUps.tsx`, `Uploads.tsx`
- Modify: `clients/web/src/router.tsx` (`/server-settings/:section?`), `src/app/settings/UserSettings.tsx` (custom status field; link to server settings for admins)
- Delete: `src/app/settings/CommunitySettings.tsx`, `src/app/settings/AdminSettings.tsx` (their content moves here)

**Interfaces:**
- Consumes: `PATCH /api/server`, `client.uploadServerImage("icon" | "banner")`, `client.deleteServerImage`, `GET/POST /api/server/invites`, `DELETE /api/invites/{code}`, `GET /api/server/bans`, `DELETE /api/server/bans/{userID}`, the admin settings API (`GET/PATCH /api/admin/settings` or whatever `AdminSettings.tsx` calls today) and the admin users list it shows; `PALETTES`, `ServerIcon`, `myBasePerms`.
- Produces: the settings shell used by Task 10 (`sections` table with `{ id, label, group, visible(perms, me) , element }`).

Visual source: `docs/superpowers/mockups/SettingsLook.dc.html` (the shell and the Look page) — the other pages follow the same shell. Build:

- **Shell:** full-height page replacing the main layout (no sidebar), left nav on `bg-sidebar` grouped as in the mockup: *Server* — Overview, Look, Welcome page (link to the welcome channel's editor), Channels (disabled "coming soon" style item: M6), Members, Roles (Task 10); *Expressions* — Emoji, Soundboard (disabled, M5/M7); *Moderation* — Invites, Bans; *Instance* (only for `me.is_admin`) — Sign-ups, Uploads and voice. A close button (and Esc) returns to the last channel. Sections the user lacks permission for are hidden; the default section is the first visible one.
- **Overview** (`MANAGE_SERVER`): name (max 100), description (`Textarea`, max 300), Save → `PATCH /api/server`.
- **Look** (`MANAGE_SERVER`): palette picker — six swatches (`RadioGroup` styled as swatches with the label under each; selected = ring) saving immediately (`PATCH /api/server {palette}`); a preview card showing the mark, a primary button and a link in the chosen accent; icon uploader (square preview 96 px, "Upload" / "Remove", PNG/JPEG/WebP/GIF ≤ 8 MB, client-side check before upload) and banner uploader (wide preview, same controls). Errors via `ErrorText`.
- **Invites** (`MANAGE_SERVER` to list; `CREATE_INVITE` to create): table of invites (code, creator, uses / max, expires) with copy-link and delete; "Create invite" with max uses and expiry (`NativeSelect` presets: never, 1 hour, 1 day, 7 days; uses: unlimited, 1, 5, 10, 25) — reuse what `CommunitySettings.tsx` had.
- **Bans** (`BAN`): table with user, reason, date, "Unban".
- **Sign-ups** (instance admin): registration mode (`RadioGroup`: open, invite only, admin only) — moved from `AdminSettings`, minus "allow community creation"; plus the users table (disable/enable, as `AdminSettings` has today).
- **Uploads and voice** (instance admin): max upload size, and the voice status shown today (LiveKit configured or not) — moved from `AdminSettings`.
- `UserSettings.tsx`: add the custom status field next to the display name (both saved with one `PATCH /api/users/@me`).

- [ ] **Step 1: Build** the shell and pages, moving logic from `CommunitySettings.tsx` and `AdminSettings.tsx` (delete them; nothing else may import them).

- [ ] **Step 2: Type-check and build** — `pnpm -C clients/web run typecheck && pnpm -C clients/web run build`. Expected: no errors.

- [ ] **Step 3: Look at it** — in the browser pane: change name and description, switch palettes (watch the sidebar and buttons recolour live, also in a second signed-in tab via `SERVER_UPDATE`), upload and remove an icon and a banner, create and delete an invite, ban and unban a user, change the registration mode. Compare the shell and Look page with `SettingsLook.dc.html`. Report what you checked.

- [ ] **Step 4: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(web): server settings — overview, look, invites, bans, sign-ups, uploads`

---

### Task 10: Web — Members and Roles settings

**Files:**
- Create: `clients/web/src/app/server-settings/Members.tsx`, `Roles.tsx`, `RoleEditor.tsx`, `clients/web/src/lib/hierarchy.ts`, `hierarchy.test.ts`
- Modify: `clients/web/src/app/server-settings/ServerSettings.tsx` (register the two sections), `src/permLabels.ts` (groups and plain-word descriptions)

**Interfaces:**
- Consumes: `rolesByRank`, `myBasePerms`, server members from the store (`client.loadMembers()` on mount), `POST/PATCH/DELETE /api/server/roles…`, `PUT/DELETE /api/server/members/{userID}/roles/{roleID}`, `DELETE /api/server/members/{userID}` (kick), `PUT /api/server/bans/{userID}`, `ROLE_COLORS`.
- Produces: `myRank(server, roles, me, roleIds): number` (owner → `Infinity`; else highest position among held roles, 0 for none), `canEditRole(rank, role)` (`role.position < rank` and not `@everyone`, except that `@everyone`'s permissions are editable by anyone with `MANAGE_ROLES`), `outranks(myRank, theirRank)` — mirror of Task 4's server rules so the UI hides what the server would refuse.
- `PERM_GROUPS`: `[{ title: "General", flags: [...] }, { title: "Text", … }, { title: "Voice", … }, { title: "Moderation", … }, { title: "Server", … }]` with a one-line plain-words description per flag (e.g. Kick: "Remove people from the server. They can come back with a new invite.").

Visual source: `docs/superpowers/mockups/SettingsRoles.dc.html`. Build:

- **Roles:** left list of roles highest first (colour dot, name, member count), `@everyone` last and pinned; "Create role" (`MANAGE_ROLES`) creates "New role" and selects it; up/down buttons reorder a role within the range you may edit (`PATCH position`); roles you cannot edit are shown with a lock and read-only. Right pane `RoleEditor` with tabs **Display** (name, colour swatches from `ROLE_COLORS` plus "None", "Show members separately" switch) and **Permissions** (grouped toggles with descriptions; a toggle for a permission you do not hold is disabled with the tooltip "You can only grant permissions you have"; `Administrator` shows a warning line) and **Members** (members holding the role, "Add members" picker, remove). Save bar appears when the role has unsaved changes (Reset / Save), like the mockup. Delete role (confirm `Dialog`).
- **Members:** searchable table (avatar initials, display name + username, roles as coloured `Badge`s, joined date); per row a `DropdownMenu`: "Manage roles" (checkbox list of roles you can assign), "Kick" (`KICK` + outranks; confirm dialog), "Ban" (`BAN` + outranks; dialog with reason). The owner row shows a crown and no actions.

- [ ] **Step 1: Write the failing test** — `hierarchy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canEditRole, myRank, outranks } from "./hierarchy";

const server = { id: "1", owner_id: "10" };
const roles = [
  { id: "1", name: "@everyone", position: 0, permissions: 0, hoist: false },
  { id: "2", name: "Helper", position: 1, permissions: 0, hoist: false },
  { id: "3", name: "Mod", position: 2, permissions: 0, hoist: false },
];

describe("hierarchy", () => {
  it("ranks by highest role, owner on top", () => {
    expect(myRank(server, roles, "10", [])).toBe(Infinity);
    expect(myRank(server, roles, "20", ["2", "3"])).toBe(2);
    expect(myRank(server, roles, "30", [])).toBe(0);
  });

  it("edits only roles below", () => {
    expect(canEditRole(2, roles[1])).toBe(true);
    expect(canEditRole(2, roles[2])).toBe(false);
    expect(canEditRole(Infinity, roles[2])).toBe(true);
  });

  it("moderates only lower ranks", () => {
    expect(outranks(2, 1)).toBe(true);
    expect(outranks(1, 1)).toBe(false);
    expect(outranks(Infinity, 5)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm -C clients/web exec vitest run src/lib`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `hierarchy.ts`:

```ts
import type { Role } from "@datrope/core";

/** Mirrors the server's role hierarchy (server/internal/communities/hierarchy.go). */
export function myRank(server: { owner_id: string }, roles: Role[], userId: string, roleIds: string[]): number {
  if (userId === server.owner_id) return Infinity;
  return roles.filter((r) => roleIds.includes(r.id)).reduce((max, r) => Math.max(max, r.position), 0);
}

/** Whether a member of this rank may edit the role (@everyone's permissions are handled by the caller). */
export function canEditRole(rank: number, role: Role): boolean {
  return role.position > 0 && role.position < rank;
}

export function outranks(mine: number, theirs: number): boolean {
  return mine > theirs;
}
```

Then build `Roles.tsx`, `RoleEditor.tsx` and `Members.tsx` as described and register them in the shell.

- [ ] **Step 4: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS.

- [ ] **Step 5: Look at it** — in the browser pane, as the owner: create two roles, colour one, make it show separately (check the member list groups it), reorder, grant permissions, assign to a member; sign in as that member (second tab) and confirm they cannot edit roles at or above their own and cannot kick the owner. Compare with `SettingsRoles.dc.html`. Report what you checked.

- [ ] **Step 6: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(web): members and roles settings with colours and hierarchy`

---

### Task 11: End-to-end test and docs

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts`, `README.md` (or wherever the project describes communities and setup), `AGENTS.md` if it mentions communities, `docs/superpowers/specs/2026-10-09-one-server-design.md` (§6 M4 migration line: moved channels are renamed `<community> · <channel>`, since categories arrive in M6)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Rewrite the e2e flow** — `chat.spec.ts` follows the one-server flow (keep its helpers for registering and signing in in separate browser contexts):
  1. alice registers first (owner) and lands in `#general` (via `/`), sees the server name "Datrope" in the sidebar header and the Channels / Messages tabs.
  2. alice opens Server settings → Look, picks Ocean; the "Create invite" button (or any primary button) has the Ocean accent (`getComputedStyle(...).backgroundColor === "rgb(74, 163, 255)"`).
  3. alice opens the welcome channel, edits the page (`# Rules` + `Be nice.`), turns on the rules gate, saves.
  4. alice creates an invite (Server settings → Invites, or the header menu) and reads its link.
  5. bob registers with the invite link, sees only the welcome page with "I accept the rules", clicks it, and lands in `#general`.
  6. bob sends "hello alice"; alice sees it.
  7. bob opens the Messages tab, starts a DM with alice, sends "psst"; alice sees an unread dot on her Messages tab and the message in the DM.
  Keep the existing voice e2e (if any) working; update its navigation to the new routes.

- [ ] **Step 2: Run** — the compose stack as the M3 plan's e2e step did (see `clients/web/playwright.config.ts` for how it starts the server; never touch other projects' containers, never kill processes by port), then `pnpm -C clients/web run e2e`. Expected: PASS.

- [ ] **Step 3: Docs** — update the README's feature list and setup notes: one server per instance; the first account owns it; registration joins it; communities are gone; existing instances migrate automatically (oldest community kept, other communities' channels renamed `<community> · <channel>`). Fix the spec's M4 migration line as listed above.

- [ ] **Step 4: Full verification** — `go -C server vet ./...`, `go -C server test -p 2 ./...`, `gofmt -l server` (empty), `pnpm -C clients/core exec vitest run`, `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run build`, e2e. Expected: all PASS.

- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `test(e2e): one-server flow with rules gate; docs`
