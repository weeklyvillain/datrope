# Guest Invites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guest invite links. A visitor types a nickname, joins the server as a guest holding the Guest role, and is removed and retired automatically when their per-invite lifetime runs out.

**Architecture:** The `auth` package owns the new unauthenticated endpoint `POST /api/invites/{code}/guest`. It creates the guest user and session and calls two new `auth.Joiner` methods implemented by `communities`. Those methods check the link and add the membership plus the Guest role.

Removal has two parts:
- `communities` runs a one-minute sweep. It finds expired guests through `auth`, removes their membership, and calls `auth` to disable and sign out the account.
- Kick and ban of a guest reuse the same retire call.

The web client adds:
- a nickname form on the invite page;
- a guest switch on invite creation;
- a Guest badge, a countdown banner, and an "access ended" screen.

**Tech Stack:** Go 1.25, huma v2, pgx v5, goose migrations, Postgres (testcontainers via `pgtest`). TypeScript with openapi-fetch and zustand (`clients/core`), React 18 with shadcn/ui and Tailwind v4 (`clients/web`), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-10-guest-invites-design.md`

## Global Constraints

**Git**
- Never commit. AGENTS.md says the user makes every commit. Each task ends by **staging** its files with `git add`. Do not run `git commit`, push, amend or tag.

**Guest data**
- Guest lifetime is 3600–2592000 seconds. The UI offers 1h, 6h, 24h, 3d, 7d, 30d.
- A nick is trimmed, 1–32 characters (counted as runes), with no control characters. Duplicates are allowed.
- The guest username is `guest-` plus a random lowercase suffix, never shown in the UI.
- `users.guest_expires_at` non-NULL means the user is a guest. `invites.guest_ttl_seconds` non-NULL means the link is a guest link.

**Guest role and retirement**
- The Guest role is created on first guest join, at position 1 (just above @everyone).
  - Its default permissions are ViewChannel | ReadHistory | SendMessages | ConnectVoice | Speak.
  - It cannot be deleted.
- Retiring a guest means three things: membership deleted, `users.disabled = true`, all sessions revoked. Rows are never deleted, and messages stay.

**Web client**
- Use shadcn components and tokens only.
- Never hardcode colours. Never use `dark:` classes.
- Keep existing accessible names unchanged.

**Deliberate deviations from the spec** (found while reading the code):
1. The spec's 410 for expired or used-up links becomes the codebase's existing `404 INVITE_INVALID`.
2. The spec's 422 for a bad nick becomes `400 INVALID_NICK`, matching `VALIDATION_FAILED`-style handler checks.
3. The server has no user-facing password or email change endpoints. The guest block applies to `GET /api/sessions`, `DELETE /api/sessions/{id}` and invite creation only.
4. Retire is not a single transaction across `communities` and `auth`. It runs member delete, then disable, then revoke. Every step is idempotent, and the sweep keys on `NOT disabled`, so a crash part-way is finished on the next tick.
5. There is no dedicated migration test. `00022` is purely additive, and every `pgtest` database runs it.

## Review Focus

1. **Used-up guest link:** a second visitor gets `INVITE_INVALID` and **no orphan guest user** is left behind. Tested in Task 2.
2. **Nick edge cases:** whitespace-only and control characters are rejected; 32 emoji are accepted (runes, not bytes). Tested in Task 2.
3. **Already signed in:** opening a guest link with a session returns `409 ALREADY_SIGNED_IN`. It must not create a second account. Tested in Task 2.
4. **Live connection at expiry:** an expired guest's open websocket is closed, and other members get `MEMBER_REMOVE`. Tested in Task 4.
5. **Retired guest's messages:** they still load with `author.guest_expires_at` set, so the badge renders. Tested in Task 4.

---

## File Structure

**Server**

| File | Change |
|---|---|
| `server/internal/db/migrations/00022_guests.sql` | create: new columns and indexes |
| `server/internal/auth/store.go` | `User` and `PublicUser` gain `GuestExpiresAt`; CreateUser inserts it; add `DeleteUser` |
| `server/internal/auth/guests.go` | create: guest join handler, `RetireUser`, `ExpiredGuests`, `GuestForbidden`, `IsGuest` |
| `server/internal/auth/service.go` | `Joiner` gains `GuestTTL` and `JoinGuest`; new `guestByIP` limiter |
| `server/internal/auth/handlers.go` | register the guest route; block guests from the session endpoints |
| `server/internal/communities/invites.go` | `guest_ttl_seconds` on invites; `GuestTTL`, `JoinGuest`, `ensureGuestRole` |
| `server/internal/communities/handlers.go` | create-invite accepts the TTL and blocks guests; kick retires guests |
| `server/internal/communities/communities.go` | `Role.IsGuest`; `Users` interface gains two methods; sweep lifecycle fields |
| `server/internal/communities/roles.go` | delete-role protects the Guest role; ban retires guests |
| `server/internal/communities/guests.go` | create: `SweepGuests`, `StartGuestSweep`, `Close`, `retire` |
| `server/internal/communities/guests_test.go` | create: all guest server tests |
| `server/internal/app/app.go` | expose `Communities`; start and close the sweep |
| `server/internal/apptest/apptest.go` | `GuestInvite`, `JoinAsGuest`, `GuestBody` helpers |
| `server/internal/perms/perms.go` | `GuestDefault` |

**Clients**

| File | Change |
|---|---|
| `clients/core/src/schema.d.ts` | regenerate |
| `clients/core/src/store.ts` | `publicUser` keeps `guest_expires_at` |
| `clients/core/src/client.ts` | `joinAsGuest` |
| `clients/core/src/store.test.ts` | new test |
| `clients/web/src/lib/guest.ts` | create: duration text helpers |
| `clients/web/src/lib/guest.test.ts` | create: tests for the helpers |
| `clients/web/src/components/guest-badge.tsx` | create |
| `clients/web/src/pages/Invite.tsx` | guest form |
| `clients/web/src/pages/GuestEnded.tsx` | create |
| `clients/web/src/router.tsx` | `/guest-ended` route |
| `clients/web/src/session.ts` | remember guest status for sign-out |
| `clients/web/src/app/server-settings/Invites.tsx` | guest switch and badge |
| `clients/web/src/app/server-settings/RoleEditor.tsx` | Guest role note; no delete |
| `clients/web/src/app/AppShell.tsx` | guest banner; guest-ended state |
| `clients/web/src/app/GuestBanner.tsx` | create |
| `clients/web/src/app/MessageList.tsx` | badge |
| `clients/web/src/app/MemberList.tsx` | badge |
| `clients/web/e2e/chat.spec.ts` | guest test |

**How to run tests**
- Go: from `server/`, `go test ./internal/communities/ -run Guest -v`. Needs Docker for testcontainers.
- TS: `pnpm --filter @datrope/core test`, `pnpm --filter ./clients/web test`, `pnpm --filter ./clients/web typecheck`.

---

### Task 1: Migration and guest invite creation

**Files:**
- Create: `server/internal/db/migrations/00022_guests.sql`
- Create: `server/internal/communities/guests_test.go`
- Modify: `server/internal/communities/invites.go`
- Modify: `server/internal/communities/handlers.go:23-26`, `:167-175`
- Modify: `server/internal/apptest/apptest.go` (after `Invite`)

**Interfaces:**
- Produces:
  - `communities.Invite.GuestTTLSeconds *int` (json `guest_ttl_seconds,omitempty`)
  - `communities.InvitePreview.GuestTTLSeconds *int`
  - `CreateInviteRequest.GuestTTLSeconds *int`
  - `(*Service).createInvite(ctx, serverID, creatorID id.ID, maxUses, expiresIn, guestTTL *int)`
  - `apptest.(*Client).GuestInvite(ttl int) string`

- [ ] **Step 1: Write the failing test**

`server/internal/communities/guests_test.go`:

```go
package communities_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
)

func TestGuestInviteCreation(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")

	code := alice.GuestInvite(6 * 3600)
	var list []communities.Invite
	alice.Do(http.MethodGet, "/api/server/invites", nil, http.StatusOK, &list)
	require.Len(t, list, 1)
	require.Equal(t, 6*3600, *list[0].GuestTTLSeconds)

	var p communities.InvitePreview
	env.Anon().Do(http.MethodGet, "/api/invites/"+code, nil, http.StatusOK, &p)
	require.Equal(t, 6*3600, *p.GuestTTLSeconds)

	normal := alice.Invite()
	p = communities.InvitePreview{}
	env.Anon().Do(http.MethodGet, "/api/invites/"+normal, nil, http.StatusOK, &p)
	require.Nil(t, p.GuestTTLSeconds, "normal links are not guest links")

	alice.Do(http.MethodPost, "/api/server/invites", map[string]any{"guest_ttl_seconds": 60}, http.StatusUnprocessableEntity, nil)
}
```

The last line assumes huma rejects schema violations with 422. If this codebase maps them to another status, use the status that `TestInviteLimits`-style tests see for an out-of-range `max_uses`.

Add to `apptest.go` after `Invite`:

```go
// GuestInvite creates an unlimited guest invite whose guests stay ttl seconds.
func (c *Client) GuestInvite(ttl int) string {
	c.env.T.Helper()
	var inv communities.Invite
	c.Do(http.MethodPost, "/api/server/invites", map[string]any{"guest_ttl_seconds": ttl}, http.StatusCreated, &inv)
	return inv.Code
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `go test ./internal/communities/ -run TestGuestInviteCreation -v`

Expected: FAIL to compile, because `GuestTTLSeconds` is undefined.

- [ ] **Step 3: Write the migration**

`server/internal/db/migrations/00022_guests.sql`:

```sql
-- +goose Up
ALTER TABLE invites ADD COLUMN guest_ttl_seconds INT
    CHECK (guest_ttl_seconds BETWEEN 3600 AND 2592000);
ALTER TABLE users ADD COLUMN guest_expires_at TIMESTAMPTZ;
CREATE INDEX users_guest_expiry_idx ON users (guest_expires_at)
    WHERE guest_expires_at IS NOT NULL AND NOT disabled;
ALTER TABLE roles ADD COLUMN is_guest BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX roles_one_guest ON roles (community_id) WHERE is_guest;

-- +goose Down
DROP INDEX roles_one_guest;
ALTER TABLE roles DROP COLUMN is_guest;
DROP INDEX users_guest_expiry_idx;
ALTER TABLE users DROP COLUMN guest_expires_at;
ALTER TABLE invites DROP COLUMN guest_ttl_seconds;
```

- [ ] **Step 4: Implement invite fields**

In `invites.go`:

1. Add `GuestTTLSeconds *int` with tag `json:"guest_ttl_seconds,omitempty" doc:"Set on guest links: how long each guest stays"` to both `Invite` and `InvitePreview`.
2. Add a column list and scanner:

```go
const inviteCols = `code, creator_id, max_uses, uses, expires_at, created_at, guest_ttl_seconds`

func scanInvite(row pgx.Row) (*Invite, error) {
	var i Invite
	err := row.Scan(&i.Code, &i.CreatorID, &i.MaxUses, &i.Uses, &i.ExpiresAt, &i.CreatedAt, &i.GuestTTLSeconds)
	return &i, err
}
```

   - `listInvites`: `SELECT ` + inviteCols + ` FROM invites WHERE community_id = $1 AND ` + inviteUsable + ` ORDER BY created_at`. Scan each row with `scanInvite(rows)` and append `*i`.
   - `invite`: `i, err := scanInvite(s.db.QueryRow(ctx, "SELECT "+inviteCols+" FROM invites WHERE code = $1 AND "+inviteUsable, code))`, keeping the `pgx.ErrNoRows` → `errInviteInvalid()` mapping.
3. `createInvite` gains a last parameter `guestTTL *int`. Set `GuestTTLSeconds: guestTTL` in the struct literal, and change the insert to:

```go
INSERT INTO invites (code, community_id, creator_id, max_uses, expires_at, guest_ttl_seconds) VALUES ($1, $2, $3, $4, $5, $6)
```

   with the extra argument `inv.GuestTTLSeconds`.
4. `preview`: add `i.guest_ttl_seconds` as a fourth selected column and scan it into `&p.GuestTTLSeconds`.

In `handlers.go`:

```go
type CreateInviteRequest struct {
	MaxUses          *int `json:"max_uses,omitempty" minimum:"1" maximum:"1000"`
	ExpiresInSeconds *int `json:"expires_in_seconds,omitempty" minimum:"60" maximum:"2592000"`
	GuestTTLSeconds  *int `json:"guest_ttl_seconds,omitempty" minimum:"3600" maximum:"2592000" doc:"Makes a guest link: visitors join with a nickname and are removed this many seconds after joining"`
}
```

Change the create-invite call to `s.createInvite(ctx, a.CommunityID, a.Member.UserID, in.Body.MaxUses, in.Body.ExpiresInSeconds, in.Body.GuestTTLSeconds)`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `go test ./internal/communities/ -v`

Expected: PASS. `TestInviteLimits` and every other existing test stay green.

- [ ] **Step 6: Stage**

```bash
git add server/internal/db/migrations/00022_guests.sql server/internal/communities/invites.go server/internal/communities/handlers.go server/internal/communities/guests_test.go server/internal/apptest/apptest.go
```

---
### Task 2: Joining as a guest

**Files:**
- Create: `server/internal/auth/guests.go`
- Modify: `server/internal/auth/store.go` (structs, `Public`, `userCols`, `scanUser`, `CreateUser`, `PublicUsers`, new `DeleteUser`)
- Modify: `server/internal/auth/service.go` (`Joiner`, `Service`, `NewService`)
- Modify: `server/internal/auth/handlers.go` (call `registerGuest(api, s)` at the end of `Register`)
- Modify: `server/internal/communities/invites.go`
- Modify: `server/internal/communities/communities.go` (`Role`, `roleCols`, `scanRole`)
- Modify: `server/internal/perms/perms.go`
- Modify: `server/internal/apptest/apptest.go`
- Test: `server/internal/communities/guests_test.go`

**Interfaces:**
- Consumes:
  - `invites.guest_ttl_seconds` and `roles.is_guest` columns (Task 1)
  - `GuestInvite` (Task 1)
- Produces:
  - `auth.User.GuestExpiresAt *time.Time` and `auth.PublicUser.GuestExpiresAt *time.Time` (json `guest_expires_at,omitempty`)
  - `auth.Joiner`:
    - `GuestTTL(ctx context.Context, code string) (time.Duration, error)`
    - `JoinGuest(ctx context.Context, code string, userID id.ID) error`
  - `(*auth.Store).DeleteUser(ctx, userID id.ID) error`
  - `auth.GuestJoinRequest`, `auth.GuestForbidden() *httpx.Error`, `auth.IsGuest(ctx) bool`
  - `communities.Role.IsGuest bool` (json `is_guest`)
  - `perms.GuestDefault`
  - `apptest.(*Env).JoinAsGuest(code, nick string) *Client`
  - `apptest.GuestBody(nick string) map[string]any`

- [ ] **Step 1: Write the failing tests**

Add to `apptest.go`:

```go
// GuestBody is the request body for POST /api/invites/{code}/guest.
func GuestBody(nick string) map[string]any {
	return map[string]any{"nick": nick, "device_name": "test", "client": "native"}
}

// JoinAsGuest joins with a guest invite and returns a client signed in as the guest.
func (e *Env) JoinAsGuest(code, nick string) *Client {
	e.T.Helper()
	c := e.Anon()
	var res auth.AuthResult
	c.Do(http.MethodPost, "/api/invites/"+code+"/guest", GuestBody(nick), http.StatusOK, &res)
	c.Token, c.User = res.Token, res.User
	return c
}
```

Append to `guests_test.go`, and add the imports `context`, `strings`, `time`, `.../auth`, `.../perms`.

Guest joins share a per-IP limit of 5 a minute, and every test gets a fresh env. Keep each test to 5 guest-join calls or fewer, failures included.

```go
func guestRoles(sv communities.ServerWithRoles) []communities.Role {
	out := []communities.Role{}
	for _, r := range sv.Roles {
		if r.IsGuest {
			out = append(out, r)
		}
	}
	return out
}

func TestGuestJoin(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	env.SetRegistrationMode(auth.ModeAdminOnly) // guest links work regardless
	code := alice.GuestInvite(6 * 3600)
	ws, _ := alice.Connect()

	before := time.Now()
	g := env.JoinAsGuest(code, "  Robin  ")
	require.Equal(t, "Robin", g.User.DisplayName)
	require.True(t, strings.HasPrefix(g.User.Username, "guest-"))
	require.NotNil(t, g.User.GuestExpiresAt)
	require.WithinDuration(t, before.Add(6*time.Hour), *g.User.GuestExpiresAt, time.Minute)

	var added communities.Member
	ws.ExpectDispatch("MEMBER_ADD", &added)
	require.Equal(t, g.User.ID, added.User.ID)
	require.NotNil(t, added.User.GuestExpiresAt, "members carry the guest flag")

	roles := guestRoles(g.Server())
	require.Len(t, roles, 1)
	require.Equal(t, 1, roles[0].Position, "just above @everyone")
	require.Equal(t, perms.GuestDefault, roles[0].Permissions)
	require.Contains(t, added.RoleIDs, roles[0].ID)
	g.Send(g.General(), "hello")

	env.JoinAsGuest(code, "Robin") // duplicate nicks are fine
	require.Len(t, guestRoles(alice.Server()), 1, "the second guest reuses the role")

	env.Anon().Fail(http.MethodPost, "/api/invites/"+alice.Invite()+"/guest", apptest.GuestBody("x"), http.StatusNotFound, "NOT_GUEST_INVITE")
	env.Anon().Fail(http.MethodPost, "/api/invites/nope/guest", apptest.GuestBody("x"), http.StatusNotFound, "INVITE_INVALID")
}

func TestGuestNick(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	code := alice.GuestInvite(3600)
	for _, nick := range []string{"   ", "bad\x07nick", strings.Repeat("a", 33)} {
		env.Anon().Fail(http.MethodPost, "/api/invites/"+code+"/guest", apptest.GuestBody(nick), http.StatusBadRequest, "INVALID_NICK")
	}
	g := env.JoinAsGuest(code, strings.Repeat("🙂", 32)) // 32 runes, 128 bytes
	require.Equal(t, strings.Repeat("🙂", 32), g.User.DisplayName)
}

func TestUsedUpGuestLinkLeavesNoUser(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var inv communities.Invite
	alice.Do(http.MethodPost, "/api/server/invites", map[string]any{"guest_ttl_seconds": 3600, "max_uses": 1}, http.StatusCreated, &inv)
	env.JoinAsGuest(inv.Code, "First")
	count := func() (n int) {
		require.NoError(t, env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM users`).Scan(&n))
		return n
	}
	n := count()
	env.Anon().Fail(http.MethodPost, "/api/invites/"+inv.Code+"/guest", apptest.GuestBody("Second"), http.StatusNotFound, "INVITE_INVALID")
	require.Equal(t, n, count())
}

func TestGuestJoinWhileSignedIn(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	code := alice.GuestInvite(3600)
	alice.Fail(http.MethodPost, "/api/invites/"+code+"/guest", apptest.GuestBody("Alias"), http.StatusConflict, "ALREADY_SIGNED_IN")
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `go test ./internal/communities/ -run 'TestGuest|TestUsedUp' -v`

Expected: FAIL to compile (`GuestExpiresAt`, `IsGuest`, `perms.GuestDefault` undefined).

- [ ] **Step 3: Add `perms.GuestDefault`**

In `perms.go`, after `Default`:

```go
// GuestDefault is what the Guest role gets when it is created.
const GuestDefault = ViewChannel | ReadHistory | SendMessages | ConnectVoice | Speak
```

- [ ] **Step 4: Add the guest field to auth users**

In `store.go`:

1. Add `GuestExpiresAt *time.Time` with tag `json:"guest_expires_at,omitempty" doc:"Set for guests: when their access ends"` to both `User` and `PublicUser`.
2. `Public()` copies it: add `GuestExpiresAt: u.GuestExpiresAt`.
3. Append `, u.guest_expires_at` to `userCols`, and `&u.GuestExpiresAt` as the last element of `scanUser`'s `dest`.
4. In `CreateUser`, change the insert to:

```go
		INSERT INTO users (id, username, email, display_name, password_hash, is_admin, guest_expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING created_at`,
		u.ID, u.Username, u.Email, u.DisplayName, u.PasswordHash, u.IsAdmin, u.GuestExpiresAt).Scan(&u.CreatedAt)
```

5. In `PublicUsers`, append `guest_expires_at` to the SELECT and `&p.GuestExpiresAt` to the Scan.
6. Add `DeleteUser`:

```go
// DeleteUser removes an account that has nothing attached yet (a guest
// whose join failed). Accounts with messages cannot be deleted.
func (s *Store) DeleteUser(ctx context.Context, userID id.ID) error {
	return s.execOne(ctx, `DELETE FROM users WHERE id = $1`, userID)
}
```

- [ ] **Step 5: Extend `Joiner` and the service**

In `service.go`, add to `Joiner`:

```go
	// GuestTTL returns how long a guest link's guests stay, or an
	// *httpx.Error if the code is not a usable guest link.
	GuestTTL(ctx context.Context, code string) (time.Duration, error)
	// JoinGuest makes a new guest account a member holding the Guest role.
	JoinGuest(ctx context.Context, code string, userID id.ID) error
```

Add the field `guestByIP *ratelimit.Limiter` to `Service`, and `guestByIP: ratelimit.New(5, 5),` in `NewService`. Import `time`.

- [ ] **Step 6: Write the guest handler**

`server/internal/auth/guests.go`:

```go
package auth

import (
	"context"
	"crypto/rand"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type GuestJoinRequest struct {
	Nick       string `json:"nick" maxLength:"200" doc:"Shown as the guest's name; 1-32 characters after trimming"`
	DeviceName string `json:"device_name" minLength:"1" maxLength:"64"`
	Client     string `json:"client" enum:"web,native"`
}

// GuestForbidden is returned when a guest calls something only full accounts may use.
func GuestForbidden() *httpx.Error {
	return httpx.E(http.StatusForbidden, "GUEST_FORBIDDEN", "guests cannot do this")
}

// IsGuest reports whether the signed-in user of ctx is a guest.
func IsGuest(ctx context.Context) bool {
	p := Current(ctx)
	return p != nil && p.User.GuestExpiresAt != nil
}

func registerGuest(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{OperationID: "join-as-guest", Method: http.MethodPost,
		Path: "/api/invites/{code}/guest", Tags: []string{"server"}},
		func(ctx context.Context, in *struct {
			Code          string `path:"code"`
			Authorization string `header:"Authorization"`
			Cookie        string `header:"Cookie"`
			Body          GuestJoinRequest
		}) (*authOutput, error) {
			return s.joinAsGuest(ctx, in.Code, in.Authorization, in.Cookie, in.Body)
		})
}

func validNick(raw string) (string, bool) {
	n := strings.TrimSpace(raw)
	if n == "" || utf8.RuneCountInString(n) > 32 {
		return "", false
	}
	for _, r := range n {
		if unicode.IsControl(r) {
			return "", false
		}
	}
	return n, true
}

func (s *Service) joinAsGuest(ctx context.Context, code, authorization, cookie string, b GuestJoinRequest) (*authOutput, error) {
	if !s.guestByIP.Allow(httpx.ClientIPFrom(ctx)) {
		return nil, httpx.RateLimited()
	}
	token := strings.TrimPrefix(authorization, "Bearer ")
	if authorization == "" {
		token = cookieValue(cookie)
	}
	if token != "" {
		if _, err := s.Authenticate(ctx, token); err == nil {
			return nil, httpx.E(http.StatusConflict, "ALREADY_SIGNED_IN", "you are signed in; join with your account instead")
		}
	}
	nick, ok := validNick(b.Nick)
	if !ok {
		return nil, httpx.BadRequest("INVALID_NICK", "a nickname is 1-32 characters with no control characters")
	}
	if s.joiner == nil {
		return nil, httpx.NotFound("invite")
	}
	ttl, err := s.joiner.GuestTTL(ctx, code)
	if err != nil {
		return nil, err
	}
	hash, err := HashPassword(rand.Text()) // nobody knows it: guests cannot log in with a password
	if err != nil {
		return nil, err
	}
	expires := time.Now().Add(ttl)
	u := &User{ID: id.New(), Username: "guest-" + strings.ToLower(rand.Text()[:10]), DisplayName: nick,
		PasswordHash: hash, GuestExpiresAt: &expires}
	if err := s.store.CreateUser(ctx, u); err != nil {
		return nil, err
	}
	if err := s.joiner.JoinGuest(ctx, code, u.ID); err != nil {
		// The link was used up or deleted a moment ago; drop the empty account.
		if derr := s.store.DeleteUser(ctx, u.ID); derr != nil {
			slog.ErrorContext(ctx, "deleting a guest whose join failed", "user_id", u.ID, "err", derr)
		}
		return nil, err
	}
	return s.startSession(ctx, u, b.DeviceName, b.Client)
}
```

In `handlers.go`, add `registerGuest(api, s)` next to `registerAdmin(api, s)` at the end of `Register`.

- [ ] **Step 7: Add the Guest role field to communities**

In `communities.go`:
- Add `IsGuest bool` with tag `json:"is_guest" doc:"The system role every guest holds; it cannot be deleted"` to `Role`.
- Append `, is_guest` to `roleCols`, and `&r.IsGuest` as the last Scan target in `scanRole`.

- [ ] **Step 8: Implement `GuestTTL` and `JoinGuest`**

Append to `communities/invites.go`. Add the imports `.../events` and `.../perms`.

```go
func errNotGuestInvite() *httpx.Error {
	return httpx.E(http.StatusNotFound, "NOT_GUEST_INVITE", "this invite is not a guest link")
}

// GuestTTL implements auth.Joiner.
func (s *Service) GuestTTL(ctx context.Context, code string) (time.Duration, error) {
	inv, err := s.invite(ctx, code)
	if err != nil {
		return 0, err
	}
	if inv.GuestTTLSeconds == nil {
		return 0, errNotGuestInvite()
	}
	return time.Duration(*inv.GuestTTLSeconds) * time.Second, nil
}

// JoinGuest implements auth.Joiner: the new guest becomes a member holding
// the Guest role, which is created on first use just above @everyone.
func (s *Service) JoinGuest(ctx context.Context, code string, userID id.ID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var serverID id.ID
	var ttl *int
	err = tx.QueryRow(ctx, `SELECT community_id, guest_ttl_seconds FROM invites WHERE code = $1 AND `+inviteUsable+` FOR UPDATE`, code).
		Scan(&serverID, &ttl)
	if errors.Is(err, pgx.ErrNoRows) {
		return errInviteInvalid()
	}
	if err != nil {
		return err
	}
	if ttl == nil {
		return errNotGuestInvite()
	}
	role, created, err := ensureGuestRole(ctx, tx, serverID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE invites SET uses = uses + 1 WHERE code = $1`, code); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO members (community_id, user_id, accepted_rules_at) VALUES ($1, $2, `+acceptedOnJoin+`)`, serverID, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO member_roles (community_id, user_id, role_id) VALUES ($1, $2, $3)`, serverID, userID, role.ID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if created {
		s.bus.Publish(events.Event{Type: "ROLE_CREATE", Data: role, Scope: events.Scope{CommunityID: serverID}})
		if err := s.publishMoved(ctx, serverID, 2, ownerRank, role.ID); err != nil {
			return err
		}
	}
	return s.publishMemberAdd(ctx, serverID, userID)
}

// ensureGuestRole returns the Guest role, creating it at position 1 (the
// other roles move up one) if the server has none yet.
func ensureGuestRole(ctx context.Context, tx pgx.Tx, serverID id.ID) (*Role, bool, error) {
	if err := lockRoles(ctx, tx, serverID); err != nil {
		return nil, false, err
	}
	r, err := scanRole(tx.QueryRow(ctx, `SELECT `+roleCols+` FROM roles WHERE community_id = $1 AND is_guest`, serverID))
	if err == nil {
		return r, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE roles SET position = position + 1 WHERE community_id = $1 AND position >= 1`, serverID); err != nil {
		return nil, false, err
	}
	r, err = scanRole(tx.QueryRow(ctx, `
		INSERT INTO roles (id, community_id, name, permissions, position, is_guest)
		VALUES ($1, $2, 'Guest', $3, 1, TRUE) RETURNING `+roleCols,
		id.New(), serverID, int64(perms.GuestDefault)))
	return r, true, err
}
```

Before relying on this code, check two things:
- `scanRole` (`communities.go:312`) returns `row.Scan`'s error unwrapped. If it wraps the error, adapt the `errors.Is` check.
- `lockRoles` takes `(ctx, tx, serverID)`, as used in `hierarchy.go:96`.

- [ ] **Step 9: Run the tests and confirm they pass**

Run: `go test ./internal/communities/ ./internal/auth/ -v`

Expected: PASS, including all existing tests. If any test has a fake that implements `auth.Joiner` (grep `Joiner` under `server/internal`), add `GuestTTL` and `JoinGuest` methods to it that return errors.

- [ ] **Step 10: Stage**

```bash
git add server/internal/auth server/internal/communities server/internal/perms/perms.go server/internal/apptest/apptest.go
```

---
### Task 3: Guest restrictions and Guest role protection

**Files:**
- Modify: `server/internal/auth/handlers.go` (`list-sessions`, `delete-session`)
- Modify: `server/internal/communities/handlers.go` (`create-invite`)
- Modify: `server/internal/communities/roles.go` (`delete-role`)
- Test: `server/internal/communities/guests_test.go`

**Interfaces:**
- Consumes: `auth.IsGuest`, `auth.GuestForbidden`, `Role.IsGuest` (Task 2)

- [ ] **Step 1: Write the failing test**

```go
func TestGuestRestrictions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	g := env.JoinAsGuest(alice.GuestInvite(3600), "Visitor")

	g.Fail(http.MethodPost, "/api/server/invites", map[string]any{}, http.StatusForbidden, "GUEST_FORBIDDEN")
	g.Fail(http.MethodGet, "/api/sessions", nil, http.StatusForbidden, "GUEST_FORBIDDEN")
	g.Fail(http.MethodDelete, "/api/sessions/1", nil, http.StatusForbidden, "GUEST_FORBIDDEN")
	var me auth.User
	g.Do(http.MethodPatch, "/api/users/@me", map[string]any{"display_name": "Visitor 2"}, http.StatusOK, &me)
	require.Equal(t, "Visitor 2", me.DisplayName)
	require.NotNil(t, me.GuestExpiresAt)

	role := guestRoles(alice.Server())[0]
	alice.Fail(http.MethodDelete, "/api/server/roles/"+role.ID.String(), nil, http.StatusConflict, "CANNOT_DELETE_GUEST_ROLE")
	alice.Do(http.MethodPatch, "/api/server/roles/"+role.ID.String(), map[string]any{"name": "Visitors"}, http.StatusOK, nil)
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `go test ./internal/communities/ -run TestGuestRestrictions -v`

Expected: FAIL. Invite creation returns 201, not 403.

- [ ] **Step 3: Implement**

1. In the `create-invite` handler, before `requireActor`:

```go
			if auth.IsGuest(ctx) {
				return nil, auth.GuestForbidden()
			}
```

2. In `list-sessions` and `delete-session` in `auth/handlers.go`, make this the first statement of each handler:

```go
			if IsGuest(ctx) {
				return nil, GuestForbidden()
			}
```

3. In `delete-role`, right after the `CANNOT_DELETE_EVERYONE` check:

```go
			if r.IsGuest {
				return nil, httpx.E(http.StatusConflict, "CANNOT_DELETE_GUEST_ROLE", "the Guest role cannot be deleted")
			}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `go test ./internal/communities/ ./internal/auth/ -v`

Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add server/internal/auth/handlers.go server/internal/communities/handlers.go server/internal/communities/roles.go server/internal/communities/guests_test.go
```

---

### Task 4: Retiring guests (sweep, kick, ban)

**Files:**
- Modify: `server/internal/auth/guests.go`
- Modify: `server/internal/communities/communities.go` (`Users`, `Service`, `NewService`)
- Create: `server/internal/communities/guests.go`
- Modify: `server/internal/communities/handlers.go` (`remove-member`)
- Modify: `server/internal/communities/roles.go` (`ban-member`)
- Modify: `server/internal/app/app.go`
- Test: `server/internal/communities/guests_test.go`

**Interfaces:**
- Consumes: `PublicUser.GuestExpiresAt` (Task 2)
- Produces:
  - `(*auth.Service).RetireUser(ctx, userID id.ID) error`
  - `(*auth.Service).ExpiredGuests(ctx, now time.Time, limit int) ([]id.ID, error)`
  - `(*communities.Service).SweepGuests(ctx, now time.Time) (int, error)`
  - `StartGuestSweep()` and `Close()`
  - `app.App.Communities *communities.Service`

- [ ] **Step 1: Write the failing tests**

Add the import `.../messages`.

```go
func TestGuestExpirySweep(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	code := alice.GuestInvite(3600)
	gone := env.JoinAsGuest(code, "Gone")
	stays := env.JoinAsGuest(code, "Stays")
	general := gone.General()
	gone.Send(general, "hi from a guest")
	goneWS, _ := gone.Connect()
	aliceWS, _ := alice.Connect()

	ctx := context.Background()
	_, err := env.Pool.Exec(ctx, `UPDATE users SET guest_expires_at = now() - interval '1 second' WHERE id = $1`, gone.User.ID)
	require.NoError(t, err)
	n, err := env.App.Communities.SweepGuests(ctx, time.Now())
	require.NoError(t, err)
	require.Equal(t, 1, n)

	var removed communities.MemberRemoved
	aliceWS.ExpectDispatch("MEMBER_REMOVE", &removed)
	require.Equal(t, gone.User.ID, removed.UserID)
	goneWS.ExpectClose()
	gone.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
	stays.Do(http.MethodGet, "/api/users/@me", nil, http.StatusOK, nil)
	alice.Do(http.MethodGet, "/api/users/@me", nil, http.StatusOK, nil)

	var msgs []messages.Message
	alice.Do(http.MethodGet, "/api/channels/"+general.String()+"/messages", nil, http.StatusOK, &msgs)
	var found *messages.Message
	for i := range msgs {
		if msgs[i].Content == "hi from a guest" {
			found = &msgs[i]
		}
	}
	require.NotNil(t, found, "messages stay")
	require.Equal(t, "Gone", found.Author.DisplayName)
	require.NotNil(t, found.Author.GuestExpiresAt, "and still carry the guest badge")

	n, err = env.App.Communities.SweepGuests(ctx, time.Now())
	require.NoError(t, err)
	require.Zero(t, n, "a retired guest is not swept again")
}

func TestKickOrBanRetiresGuests(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	code := alice.GuestInvite(3600)
	kicked := env.JoinAsGuest(code, "Kicked")
	banned := env.JoinAsGuest(code, "Banned")

	alice.Do(http.MethodDelete, "/api/server/members/"+kicked.User.ID.String(), nil, http.StatusNoContent, nil)
	kicked.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")

	alice.Do(http.MethodPut, "/api/server/bans/"+banned.User.ID.String(), map[string]any{}, http.StatusNoContent, nil)
	var disabled bool
	require.NoError(t, env.Pool.QueryRow(context.Background(), `SELECT disabled FROM users WHERE id = $1`, banned.User.ID).Scan(&disabled))
	require.True(t, disabled)
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `go test ./internal/communities/ -run 'TestGuestExpirySweep|TestKickOrBan' -v`

Expected: FAIL to compile (`env.App.Communities` and `SweepGuests` undefined).

- [ ] **Step 3: Add the auth side**

Append to `auth/guests.go`:

```go
// RetireUser disables an account and signs it out everywhere (a guest whose
// time is up, or who was kicked or banned).
func (s *Service) RetireUser(ctx context.Context, userID id.ID) error {
	if err := s.store.SetDisabled(ctx, userID, true); err != nil {
		return err
	}
	return s.revokeAll(ctx, userID)
}

// ExpiredGuests lists up to limit guests whose time ran out before now and
// who are not retired yet.
func (s *Service) ExpiredGuests(ctx context.Context, now time.Time, limit int) ([]id.ID, error) {
	rows, err := s.store.db.Query(ctx, `
		SELECT id FROM users WHERE guest_expires_at <= $1 AND NOT disabled
		ORDER BY guest_expires_at LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []id.ID
	for rows.Next() {
		var uid id.ID
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		out = append(out, uid)
	}
	return out, rows.Err()
}
```

- [ ] **Step 4: Add the communities side**

In `communities.go`, extend `Users`:

```go
	RetireUser(ctx context.Context, userID id.ID) error
	ExpiredGuests(ctx context.Context, now time.Time, limit int) ([]id.ID, error)
```

Add the fields `done chan struct{}` and `stop sync.Once` to `Service`, and set `done: make(chan struct{})` in `NewService`. Import `sync`.

Create `communities/guests.go`:

```go
package communities

import (
	"context"
	"log/slog"
	"time"

	"github.com/datrope/datrope/server/internal/id"
)

// guestSweepBatch caps how many guests one pass retires.
const guestSweepBatch = 100

// retire removes a guest from the server, then disables the account and
// signs it out. Each step is idempotent, so a pass that dies half-way is
// finished by the next one.
func (s *Service) retire(ctx context.Context, serverID, userID id.ID) error {
	if _, err := s.removeMember(ctx, serverID, userID); err != nil {
		return err
	}
	return s.users.RetireUser(ctx, userID)
}

// SweepGuests retires guests whose time ran out before now and reports how many.
func (s *Service) SweepGuests(ctx context.Context, now time.Time) (int, error) {
	sid, err := s.ServerID(ctx)
	if err != nil {
		return 0, err
	}
	ids, err := s.users.ExpiredGuests(ctx, now, guestSweepBatch)
	if err != nil {
		return 0, err
	}
	for i, uid := range ids {
		if err := s.retire(ctx, sid, uid); err != nil {
			return i, err
		}
	}
	return len(ids), nil
}

// StartGuestSweep retires expired guests every minute until Close.
func (s *Service) StartGuestSweep() {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		sweep := func(now time.Time) {
			if _, err := s.SweepGuests(context.Background(), now); err != nil {
				slog.Error("communities: guest sweep", "err", err)
			}
		}
		sweep(time.Now()) // catch up after downtime
		for {
			select {
			case <-s.done:
				return
			case now := <-t.C:
				sweep(now)
			}
		}
	}()
}

func (s *Service) Close() { s.stop.Do(func() { close(s.done) }) }
```

- [ ] **Step 5: Retire on kick and ban**

`remove-member` in `handlers.go`: after `canModerate` and before `removeMember`, add:

```go
			users, err := s.users.PublicUsers(ctx, []id.ID{target})
			if err != nil {
				return nil, err
			}
			if u, ok := users[target]; ok && u.GuestExpiresAt != nil {
				return nil, s.retire(ctx, a.CommunityID, target)
			}
```

The existing path for regular users stays unchanged.

`ban-member` in `roles.go`: `users[target]` is already loaded. Replace the `RevokeSessions` block with:

```go
			signOut := s.users.RevokeSessions
			if users[target].GuestExpiresAt != nil {
				signOut = s.users.RetireUser // a banned guest is retired for good
			}
			if err := signOut(ctx, target); err != nil {
				slog.ErrorContext(ctx, "signing out a banned user", "user", target, "err", err)
			}
```

- [ ] **Step 6: Wire the sweep in the app**

In `app.go`:
1. Add the field `Communities *communities.Service` to `App`.
2. Set `a.Communities = commSvc` right after `communities.Register(api, commSvc)`.
3. Inside the existing `if pool != nil` block that calls `EnsureServer`, after the `EnsureServer` check, add:

```go
		commSvc.StartGuestSweep()
		a.closers = append(a.closers, commSvc.Close)
```

- [ ] **Step 7: Run all server tests and confirm they pass**

Run: `go test ./...` (from `server/`)

Expected: PASS. If any test has a fake that implements `communities.Users`, add no-op `RetireUser` and `ExpiredGuests` methods to it.

- [ ] **Step 8: Stage**

```bash
git add server/internal
```

---
### Task 5: Core client

**Files:**
- Modify: `clients/core/src/schema.d.ts` (regenerated)
- Modify: `clients/core/src/store.ts:200-203`
- Modify: `clients/core/src/client.ts` (after `joinServer`)
- Test: `clients/core/src/store.test.ts`

**Interfaces:**
- Consumes: the server API from Tasks 1–4
- Produces:
  - `PublicUser.guest_expires_at?: string`
  - `User.guest_expires_at?: string`
  - `Role.is_guest: boolean`
  - `Invite.guest_ttl_seconds?: number`
  - `InvitePreview.guest_ttl_seconds?: number`
  - `DatropeClient.joinAsGuest(code: string, nick: string, deviceName: string): Promise<User>`

- [ ] **Step 1: Regenerate the schema**

Run: `pnpm --filter @datrope/core gen`

Expected: `schema.d.ts` gains `guest_expires_at`, `is_guest`, `guest_ttl_seconds`, `GuestJoinRequest`, and the path `/api/invites/{code}/guest`.

- [ ] **Step 2: Write the failing test**

In `store.test.ts`, add `publicUser` to the import from `./store`. Add inside `describe("store", ...)`:

```ts
  it("keeps the guest flag when a profile update comes from my own account", () => {
    const u = publicUser({ ...me, guest_expires_at: "2026-10-11T00:00:00Z" });
    expect(u.guest_expires_at).toBe("2026-10-11T00:00:00Z");
  });
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm --filter @datrope/core test`

Expected: FAIL, because `guest_expires_at` is undefined.

- [ ] **Step 4: Implement**

`store.ts`:

```ts
export function publicUser(u: User): PublicUser {
  return { id: u.id, username: u.username, display_name: u.display_name, custom_status: u.custom_status,
    pronouns: u.pronouns, about_me: u.about_me, avatar_url: u.avatar_url, links: u.links, banner_url: u.banner_url,
    guest_expires_at: u.guest_expires_at };
}
```

`client.ts`, after `joinServer`:

```ts
  /** Joins with a guest link as a new guest account (web: sets the session cookie). */
  async joinAsGuest(code: string, nick: string, deviceName: string): Promise<User> {
    const res = await unwrap(this.api.POST("/api/invites/{code}/guest", {
      params: { path: { code } },
      body: { nick, device_name: deviceName, client: this.o.token ? "native" : "web" },
    }));
    return res.user;
  }
```

If the generated schema marks the `Authorization`/`Cookie` header params as required, pass `params: { path: { code }, header: {} }` or mark them `required:"false"` in the Go input struct. The browser sends the cookie itself.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @datrope/core test && pnpm --filter ./clients/web typecheck`

Expected: PASS.

- [ ] **Step 6: Stage**

```bash
git add clients/core/src
```

---

### Task 6: Web invite flows (guest form and guest link creation)

**Files:**
- Create: `clients/web/src/lib/guest.ts`
- Create: `clients/web/src/lib/guest.test.ts`
- Modify: `clients/web/src/pages/Invite.tsx`
- Modify: `clients/web/src/app/server-settings/Invites.tsx`

**Interfaces:**
- Consumes: `client.joinAsGuest`, `InvitePreview.guest_ttl_seconds`, `Invite.guest_ttl_seconds` (Task 5)
- Produces:
  - `guestTtlText(seconds: number): string`, e.g. "24 hours", "3 days"
  - `guestTtlShort(seconds: number): string`, e.g. "24h", "3d"
  - `timeLeft(ms: number): string`, e.g. "5h 12m", "2d 3h", "12m", "less than a minute"
  - `GUEST_TTLS: { label: string; seconds: number }[]`

- [ ] **Step 1: Write the failing tests**

`clients/web/src/lib/guest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { guestTtlShort, guestTtlText, timeLeft } from "./guest";

const H = 3600;
const M = 60_000;

describe("guest durations", () => {
  it("describes a link's lifetime", () => {
    expect(guestTtlText(H)).toBe("1 hour");
    expect(guestTtlText(24 * H)).toBe("24 hours");
    expect(guestTtlText(3 * 24 * H)).toBe("3 days");
    expect(guestTtlShort(6 * H)).toBe("6h");
    expect(guestTtlShort(24 * H)).toBe("24h");
    expect(guestTtlShort(30 * 24 * H)).toBe("30d");
  });
  it("counts down what is left", () => {
    expect(timeLeft((5 * 60 + 12) * M)).toBe("5h 12m");
    expect(timeLeft(51 * 60 * M)).toBe("2d 3h");
    expect(timeLeft(12 * M)).toBe("12m");
    expect(timeLeft(30_000)).toBe("less than a minute");
    expect(timeLeft(-1)).toBe("less than a minute");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter ./clients/web test -- guest`

Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement the helpers**

`clients/web/src/lib/guest.ts`:

```ts
const HOUR = 3600;
const DAY = 24 * HOUR;

/** The guest lifetimes a guest link can have. */
export const GUEST_TTLS = [
  { label: "1 hour", seconds: HOUR },
  { label: "6 hours", seconds: 6 * HOUR },
  { label: "24 hours", seconds: DAY },
  { label: "3 days", seconds: 3 * DAY },
  { label: "7 days", seconds: 7 * DAY },
  { label: "30 days", seconds: 30 * DAY },
];

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "1 hour", "24 hours", "3 days": a guest link's lifetime. Under two days counts in hours. */
export function guestTtlText(seconds: number): string {
  return seconds < 2 * DAY ? plural(Math.round(seconds / HOUR), "hour") : plural(Math.round(seconds / DAY), "day");
}

/** "6h", "24h", "3d": the same, for a badge. */
export function guestTtlShort(seconds: number): string {
  return seconds < 2 * DAY ? `${Math.round(seconds / HOUR)}h` : `${Math.round(seconds / DAY)}d`;
}

/** "2d 3h", "5h 12m", "12m": what is left of a guest's access. */
export function timeLeft(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "less than a minute";
  const d = Math.floor(min / (24 * 60));
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter ./clients/web test -- guest`

Expected: PASS.

- [ ] **Step 5: Add the guest form to the invite page**

In `Invite.tsx`:

1. Import `FormField` from `@/components/form-field`, `deviceName` from `../session`, and `guestTtlText` from `@/lib/guest`.
2. Add `const [nick, setNick] = useState("");`.
3. Before the final signed-out branch (`) : (` with "Create account / Sign in"), insert a guest branch:

```tsx
      ) : preview.guest_ttl_seconds ? (
        <form className="grid gap-3" aria-label="Join as guest" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await client.joinAsGuest(code, nick, deviceName());
            nav("/");
          });
        }}>
          <p>Join as a guest. Your access lasts {guestTtlText(preview.guest_ttl_seconds)}.</p>
          <FormField label="Nickname" value={nick} maxLength={32} required autoFocus onChange={(e) => setNick(e.target.value)} />
          <ErrorText error={error} />
          <Button type="submit" className="justify-self-start" disabled={busy}>Join as guest</Button>
          <Link to={`/login?next=${encodeURIComponent(`/invite/${code}`)}`}>Have an account? Sign in</Link>
        </form>
```

The existing "Create account / Sign in" block stays as the last branch.

- [ ] **Step 6: Add the guest link switch to invite settings**

In `Invites.tsx`:

1. Import `Switch` from `@/components/ui/switch`, `Badge` from `@/components/ui/badge`, and `GUEST_TTLS`, `guestTtlShort` from `@/lib/guest`.
2. In `CreateInvite`, add `const [guest, setGuest] = useState(false);` and `const [ttl, setTtl] = useState(GUEST_TTLS[2].seconds);`.
3. The POST body becomes:

```ts
          body: {
            ...(expiry ? { expires_in_seconds: expiry } : {}),
            ...(uses ? { max_uses: uses } : {}),
            ...(guest ? { guest_ttl_seconds: ttl } : {}),
          },
```

4. Inside the `flex flex-wrap` row, before the submit button:

```tsx
        <Field orientation="horizontal" className="w-auto">
          <Switch id={`${id}-guest`} checked={guest} onCheckedChange={setGuest} />
          <FieldLabel htmlFor={`${id}-guest`}>Guest link</FieldLabel>
        </Field>
        {guest && (
          <Field className="w-40">
            <FieldLabel htmlFor={`${id}-ttl`}>Guest access lasts</FieldLabel>
            <NativeSelect id={`${id}-ttl`} value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              {GUEST_TTLS.map((x) => <NativeSelectOption key={x.seconds} value={x.seconds}>{x.label}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        )}
```

5. In `InviteRow`, the code cell becomes:

```tsx
      <TableCell>
        <code>{i.code}</code>
        {i.guest_ttl_seconds ? <Badge variant="secondary" className="ml-2">Guest · {guestTtlShort(i.guest_ttl_seconds)}</Badge> : null}
      </TableCell>
```

- [ ] **Step 7: Verify**

Run: `pnpm --filter ./clients/web typecheck && pnpm --filter ./clients/web test`

Expected: PASS.

Then run the app (the `run` skill or `.claude/launch.json`) and check in the browser preview:
- The owner creates a guest link with "24 hours", and the list shows "Guest · 24h".
- A signed-out context opening the link sees the Nickname form.
- Joining lands in the app.

Take a screenshot of each.

- [ ] **Step 8: Stage**

```bash
git add clients/web/src/lib/guest.ts clients/web/src/lib/guest.test.ts clients/web/src/pages/Invite.tsx clients/web/src/app/server-settings/Invites.tsx
```

---

### Task 7: Web guest presence (badge, banner, access ended, Guest role note)

**Files:**
- Create: `clients/web/src/components/guest-badge.tsx`
- Create: `clients/web/src/app/GuestBanner.tsx`
- Create: `clients/web/src/pages/GuestEnded.tsx`
- Modify: `clients/web/src/app/MessageList.tsx:409`, `:468`
- Modify: `clients/web/src/app/MemberList.tsx:73`
- Modify: `clients/web/src/app/AppShell.tsx`
- Modify: `clients/web/src/session.ts:9-13`
- Modify: `clients/web/src/router.tsx`
- Modify: `clients/web/src/app/server-settings/RoleEditor.tsx:113-117`

**Interfaces:**
- Consumes: `timeLeft` (Task 6); `guest_expires_at` and `is_guest` (Task 5)
- Produces: `<GuestBadge user={PublicUser} />`, the `/guest-ended` route

- [ ] **Step 1: Write the badge**

`clients/web/src/components/guest-badge.tsx`:

```tsx
import type { PublicUser } from "@datrope/core";
import { Badge } from "@/components/ui/badge";

/** "Guest" next to the name of someone who joined with a guest link. */
export function GuestBadge({ user }: { user: Pick<PublicUser, "guest_expires_at"> }) {
  if (!user.guest_expires_at) return null;
  return <Badge variant="outline" className="ml-1.5 px-1.5 py-0 align-middle text-[10px]">Guest</Badge>;
}
```

- [ ] **Step 2: Show the badge on names**

- In `MessageList.tsx`, import `GuestBadge`. Render `<GuestBadge user={author} />` right after `<NameButton …>{name}</NameButton>` (line 409) and after `<strong …>{name}</strong>` (line 468).
- In `MemberList.tsx`, import it. Change the name span on line 73 to:

```tsx
<span className="block truncate" style={{ color: colors[m.user.id] }}>{displayName(m.user)}<GuestBadge user={m.user} /></span>
```

- [ ] **Step 3: Write the banner**

`clients/web/src/app/GuestBanner.tsx`:

```tsx
import { useEffect, useState } from "react";
import { timeLeft } from "@/lib/guest";
import { useApp } from "../session";

/** For guests: how long their access lasts. Updates every minute. */
export function GuestBanner() {
  const expires = useApp((s) => s.me?.guest_expires_at);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expires) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [expires]);
  if (!expires) return null;
  return (
    <div role="status" className="border-b border-border bg-card px-4 py-1.5 text-center text-sm text-muted-foreground">
      You're a guest. Access ends in {timeLeft(new Date(expires).getTime() - now)}.
    </div>
  );
}
```

- [ ] **Step 4: Write the access-ended page**

`clients/web/src/pages/GuestEnded.tsx`:

```tsx
import { AuthLayout } from "./AuthLayout";

/** Where a guest lands when their access ends (expired, kicked or banned). */
export function GuestEnded() {
  return (
    <AuthLayout title="Your guest access has ended">
      <p className="text-muted-foreground">Thanks for visiting. Ask for a new invite if you'd like to come back.</p>
    </AuthLayout>
  );
}
```

In `router.tsx`, import it and add `{ path: "/guest-ended", element: <GuestEnded /> },` after the `/invite/:code` route.

- [ ] **Step 5: Send ended guests there**

`session.ts`: replace the `client` constant with:

```ts
// The store is reset before onSignedOut runs, so remember whether I was a guest.
let wasGuest = false;

export const client = new DatropeClient({
  baseUrl: "",
  wsUrl,
  onSignedOut: () => window.location.assign(wasGuest ? "/guest-ended" : "/login"),
});

client.store.subscribe((s) => {
  if (s.me) wasGuest = !!s.me.guest_expires_at;
});
```

`AppShell.tsx`:
1. Import `GuestBanner` and `GuestEnded` (`../pages/GuestEnded`).
2. Add `const isGuest = useApp((s) => !!s.me?.guest_expires_at);`.
3. Before `if (notMember) return <NotAMember />;`, add `if (notMember && isGuest) return <GuestEnded />;`. A removed guest cannot rejoin with an invite, so `NotAMember` would mislead.
4. Wrap the layout so the banner sits on top, keeping all existing children unchanged inside the inner div:

```tsx
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <GuestBanner />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* existing children, unchanged */}
      </div>
    </div>
  );
```

- [ ] **Step 6: Protect the Guest role in the editor**

In `RoleEditor.tsx`, replace the `{editable && (...Delete role...)}` block (lines 113–117) with:

```tsx
              {role.is_guest && (
                <p className="text-muted-foreground">
                  System role for guests — can't be deleted. Guests also have @everyone's permissions, so to keep them out of a channel, deny this role in that channel's permissions.
                </p>
              )}
              {editable && !role.is_guest && (
                <div>
                  <Button variant="destructive" size="sm" disabled={busy} onClick={() => setDeleting(true)}>Delete role</Button>
                </div>
              )}
```

- [ ] **Step 7: Verify**

Run: `pnpm --filter ./clients/web typecheck && pnpm --filter ./clients/web test`

Expected: PASS.

In the browser preview:
- A guest sees the banner ("Access ends in 23h 59m").
- The owner sees "Guest" beside the guest's messages and in the member list.
- Server settings → Roles → Guest shows the note and no Delete button.
- The owner kicks the guest, and the guest's tab lands on "Your guest access has ended".

Take screenshots.

- [ ] **Step 8: Stage**

```bash
git add clients/web/src
```

---

### Task 8: End-to-end guest flow

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts` (append a test)

**Interfaces:**
- Consumes:
  - the UI from Tasks 6–7;
  - user `alice` / `password123`, created by the first test in this file. Tests in the file run in order against one fresh instance, and the first test leaves the rules gate on.

- [ ] **Step 1: Write the test**

Append:

```ts
test("a visitor joins with a guest link and shows up as a guest", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await alice.goto("/login");
  await alice.getByLabel("Username or email").fill("alice");
  await alice.getByLabel("Password", { exact: true }).fill("password123");
  await alice.getByRole("button", { name: "Sign in" }).click();
  await expect(alice.getByRole("button", { name: "Datrope menu" })).toBeVisible();

  await openServerSettings(alice);
  await alice.getByRole("link", { name: "Invites" }).click();
  await alice.getByRole("switch", { name: "Guest link" }).click();
  await alice.getByLabel("Guest access lasts").selectOption({ label: "24 hours" });
  await alice.getByRole("button", { name: "Create invite" }).click();
  const link = await alice.getByLabel("New invite link").inputValue();

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(link);
  await guest.getByLabel("Nickname").fill("Robin");
  await guest.getByRole("button", { name: "Join as guest" }).click();
  await expect(guest.getByRole("status").filter({ hasText: "You're a guest" })).toBeVisible();
  // The first test turned the rules gate on.
  await guest.getByRole("button", { name: "I accept the rules" }).click();
  await send(guest, "hi, just visiting");

  await alice.goto("/");
  await expect(alice.getByText("hi, just visiting")).toBeVisible();
  await expect(alice.getByRole("main").getByText("Guest", { exact: true }).first()).toBeVisible();
});
```

If the first test turns the rules gate off again before it ends, drop the "I accept the rules" line. Check the end of the first test.

- [ ] **Step 2: Run the test**

Run: `pnpm e2e` (needs the e2e stack from `deploy/docker-compose.e2e.yml`)

Expected: PASS for both tests. If the stack can't run on this machine (exFAT drive, port 8080 taken), report that plainly and leave the test staged without running it.

- [ ] **Step 3: Stage**

```bash
git add clients/web/e2e/chat.spec.ts
```
