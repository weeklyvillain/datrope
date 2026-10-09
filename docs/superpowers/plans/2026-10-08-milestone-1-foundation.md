# Milestone 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hostable Datrope instance: accounts and sessions, communities, roles and permissions, invites, text channels and DMs, messaging over REST + WebSocket, a React web client, and a Docker Compose deployment.

**Architecture:** One Go program (`datrope-server`) split into packages by area (`auth`, `communities`, `channels`, `messages`, `gateway`, `perms`). Packages own their tables, talk to each other through small Go interfaces, and publish events to an in-process bus; the `gateway` package delivers those events to WebSocket clients. The HTTP API is declared with Huma, which generates the OpenAPI document the TypeScript client types are generated from. The web client is React + Vite on top of a shared `@datrope/core` TypeScript package.

**Tech Stack:** Go 1.25, Huma v2 (stdlib `net/http` adapter), pgx v5, goose v3, coder/websocket, testcontainers-go, testify, Postgres 17 · TypeScript 5, React 18, Vite 5, React Router 6, Zustand 5, openapi-fetch / openapi-typescript, Vitest, MSW 2, mock-socket, Playwright · Caddy 2, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-08-datrope-architecture-design.md` — read it before starting. This plan implements §12 milestone 1.

## Global Constraints

- **Never commit.** (CLAUDE.md §5.) Every task ends with a *Checkpoint* step: stop, show the user the changes, and let the user commit. Staging and suggesting a commit message is fine.
- Go module path: `github.com/datrope/datrope/server` (rooted at `server/`). Go 1.25. Node 22 LTS or newer; pnpm 9 via `corepack enable`.
- IDs: Snowflake-style 64-bit, time-ordered; **encoded as decimal strings in JSON**. Lists page with `?before=<id>&limit=<n>`, `limit` max 100.
- Messages: text up to **4000 characters**. Edit sets `edited_at` (no history). Delete is soft: content cleared, row kept.
- Passwords hashed with **argon2id**. Session token = **32 random bytes**; the database stores only its **SHA-256** hash plus device name and last-used time.
- Web session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, name `datrope_session`. Cookie-authenticated state-changing requests require header `X-Datrope-CSRF: 1`. Native clients use `Authorization: Bearer <token>`.
- Registration modes: `invite_only` (default), `open`, `admin_only`. The first registered user is the instance admin. The admin can disable community creation for non-admins.
- REST error body: `{ "code": "...", "message": "...", "details": {...}? }`; statuses 400, 401, 403, 404, 409, 413, 429, 500. Clients branch on `code` only. 500 responses contain only a request ID.
- Gateway: client heartbeat every **30 s**; a connection without a frame for **45 s** is closed. Resume buffer ≈ **2 minutes** per session.
- WebSocket close codes: `4001` session invalid (sign in again), `4008` rate limited (back off), anything else → reconnect with exponential backoff and `RESUME`.
- No Redis, no ORM, never mock the database: Go integration tests run against real Postgres via testcontainers (Docker must be running).
- Out of scope for milestone 1: threads, reactions, pins, custom emoji, bots, webhooks, search, OAuth/2FA/email flows, files (M2), voice/LiveKit (M3), desktop (M4), mobile (M5), Prometheus metrics.

## Interpretations of the spec (confirm with the user before Task 5)

1. **"Banning a user … revokes their sessions"** (spec §6) is read as the *instance admin disabling an account*. A *community* ban removes the member and blocks re-joining; it does not sign the user out of the instance.
2. A member with `MANAGE_ROLES` can only create, edit, assign, or put into channel overrides permissions they hold themselves (prevents self-escalation to `ADMIN`). Channel overrides can never grant `ADMIN`.
3. DMs can only be opened with users you share a community with (anti-spam).
4. `COMMUNITY_CREATE` (sent when you create or join a community) carries the community and its roles; the client then fetches channels and members over REST.
5. Presence: the client sends its status (`online`, `idle`, `invisible`) in `IDENTIFY` and with `PRESENCE_SET`; the client remembers the choice locally. `invisible` shows as `offline` to others.
6. Read markers: `POST /api/channels/{id}/ack` stores the last read message; READY carries, per visible channel, `last_read_id` and `last_message_id` so clients can show unread state.

## File Structure

```
.gitignore
package.json, pnpm-workspace.yaml, tsconfig.base.json, eslint.config.js   (JS workspace root)
.github/workflows/ci.yml

server/
  go.mod, go.sum, Dockerfile
  cmd/datrope/main.go              entry point: serve | openapi <file> | healthcheck
  internal/id/                     Snowflake IDs
  internal/perms/                  permission flags + Effective() (pure)
  internal/db/                     pool, embedded goose migrations
  internal/db/migrations/          00001_auth.sql … 00005_messages.sql (one file per owning package)
  internal/pgtest/                 test helper: Postgres container + per-test database
  internal/httpx/                  error type, middleware, small helpers
  internal/ratelimit/              keyed token buckets
  internal/events/                 in-process event bus, scopes, event names
  internal/auth/                   users, sessions, instance settings, admin
  internal/communities/            communities, members, roles, bans, invites
  internal/channels/               text/voice channels, overrides, DMs, per-channel perms
  internal/messages/               messages, typing, read states
  internal/gateway/                WebSocket protocol, delivery, resume, presence
  internal/app/                    wiring, config, READY builder, event audience
  internal/apptest/                test helper: whole app on httptest + REST/WS clients

clients/
  core/                            @datrope/core: API client, gateway client, store, perms
  web/                             @datrope/web: React app (+ Playwright e2e in web/e2e)

deploy/
  docker-compose.yml, Caddyfile, caddy.Dockerfile, .env.example
```

Each server package that has HTTP endpoints follows the same shape: `<pkg>.go` (types, service, SQL) and `handlers.go` (Huma operations, `func Register(api huma.API, s *Service)`). Packages never query another package's tables; they call the other package's exported service methods through an interface declared in the *consuming* package.

---

### Task 1: Repository scaffold and Snowflake IDs

**Files:**
- Create: `.gitignore`
- Create: `server/go.mod` (via `go mod init`)
- Create: `server/internal/id/id.go`
- Test: `server/internal/id/id_test.go`

**Interfaces:**
- Produces: `type id.ID int64` (JSON = decimal string); `id.New() ID`; `id.Parse(string) (ID, error)`; `(ID).String()`; `(ID).Time() time.Time`; `id.Int64s([]ID) []int64`; `id.FromNullable(*int64) *ID`; `id.NewGenerator(node int64) *Generator` with `Next() ID`; `const id.Epoch`.

- [ ] **Step 1: Create the module and `.gitignore`**

```bash
mkdir -p server && cd server && go mod init github.com/datrope/datrope/server
```

`.gitignore` (repo root):

```gitignore
node_modules/
dist/
coverage/
playwright-report/
test-results/
*.log
.env
deploy/.env
server/datrope
server/datrope.exe
```

- [ ] **Step 2: Write the failing test** — `server/internal/id/id_test.go`

```go
package id

import (
	"encoding/json"
	"testing"
	"time"
)

func TestNextIsIncreasing(t *testing.T) {
	g := NewGenerator(1)
	prev := g.Next()
	for i := 0; i < 10000; i++ {
		n := g.Next()
		if n <= prev {
			t.Fatalf("id %d not greater than %d", n, prev)
		}
		prev = n
	}
}

func TestSequenceOverflowStaysOrdered(t *testing.T) {
	fixed := time.UnixMilli(Epoch + 1000)
	g := NewGenerator(0)
	g.now = func() time.Time { return fixed }
	prev := g.Next()
	for i := 0; i < 5000; i++ { // more than the 4096 IDs one millisecond holds
		n := g.Next()
		if n <= prev {
			t.Fatalf("not ordered at %d: %d <= %d", i, n, prev)
		}
		prev = n
	}
}

func TestTime(t *testing.T) {
	before := time.Now().Truncate(time.Millisecond)
	got := New().Time()
	if got.Before(before) || got.After(time.Now()) {
		t.Fatalf("Time() = %v, want between %v and now", got, before)
	}
}

func TestJSONIsString(t *testing.T) {
	type wrap struct {
		ID ID `json:"id"`
	}
	b, err := json.Marshal(wrap{ID: 123})
	if err != nil || string(b) != `{"id":"123"}` {
		t.Fatalf("marshal = %s, %v", b, err)
	}
	var v wrap
	if err := json.Unmarshal([]byte(`{"id":"456"}`), &v); err != nil || v.ID != 456 {
		t.Fatalf("unmarshal = %v, %v", v.ID, err)
	}
	if err := json.Unmarshal([]byte(`{"id":456}`), &v); err == nil {
		t.Fatal("a JSON number was accepted")
	}
}

func TestParseRejectsJunk(t *testing.T) {
	for _, s := range []string{"", "abc", "-1", "0", "99999999999999999999"} {
		if _, err := Parse(s); err == nil {
			t.Errorf("Parse(%q) succeeded", s)
		}
	}
	if v, err := Parse("42"); err != nil || v != 42 {
		t.Fatalf("Parse(42) = %v, %v", v, err)
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd server && go test ./internal/id/`
Expected: FAIL — build error `undefined: NewGenerator`.

- [ ] **Step 4: Implement** — `server/internal/id/id.go`

```go
// Package id generates Snowflake-style IDs: 64-bit, time-ordered.
//
// Layout: 41 bits of milliseconds since Epoch | 10 bits node | 12 bits sequence.
package id

import (
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"
)

// Epoch is 2026-01-01T00:00:00Z in Unix milliseconds.
const Epoch int64 = 1767225600000

// ID is encoded as a decimal string in JSON because JavaScript numbers
// cannot hold 64-bit integers.
type ID int64

func (i ID) String() string { return strconv.FormatInt(int64(i), 10) }

// Time returns when the ID was generated.
func (i ID) Time() time.Time { return time.UnixMilli(int64(i)>>22 + Epoch) }

func (i ID) MarshalJSON() ([]byte, error) { return json.Marshal(i.String()) }

func (i *ID) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("id must be a string: %w", err)
	}
	v, err := Parse(s)
	if err != nil {
		return err
	}
	*i = v
	return nil
}

// Parse reads a positive decimal ID.
func Parse(s string) (ID, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid id %q", s)
	}
	return ID(n), nil
}

// Int64s converts IDs for use as a Postgres bigint[] parameter.
func Int64s(ids []ID) []int64 {
	out := make([]int64, len(ids))
	for i, v := range ids {
		out[i] = int64(v)
	}
	return out
}

// FromNullable converts a scanned nullable bigint.
func FromNullable(n *int64) *ID {
	if n == nil {
		return nil
	}
	v := ID(*n)
	return &v
}

type Generator struct {
	mu   sync.Mutex
	node int64
	last int64
	seq  int64
	now  func() time.Time
}

func NewGenerator(node int64) *Generator {
	return &Generator{node: node & 0x3FF, now: time.Now}
}

func (g *Generator) Next() ID {
	g.mu.Lock()
	defer g.mu.Unlock()
	ms := g.now().UnixMilli() - Epoch
	if ms < g.last {
		ms = g.last // the clock went backwards: keep IDs ordered
	}
	if ms == g.last {
		g.seq = (g.seq + 1) & 0xFFF
		if g.seq == 0 {
			ms++ // sequence exhausted: borrow the next millisecond
		}
	} else {
		g.seq = 0
	}
	g.last = ms
	return ID(ms<<22 | g.node<<12 | g.seq)
}

var def = NewGenerator(0)

// New returns a fresh ID from the process-wide generator.
func New() ID { return def.Next() }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && go test ./internal/id/`
Expected: `ok`

- [ ] **Step 6: Checkpoint**

Stop; the user reviews and commits. Suggested message: `chore: scaffold Go module and snowflake ids`

---

### Task 2: Permission calculation (`perms`)

**Files:**
- Create: `server/internal/perms/perms.go`
- Test: `server/internal/perms/perms_test.go`

**Interfaces:**
- Produces: `type perms.Perms uint64`; flags `ViewChannel, SendMessages, AttachFiles, ReadHistory, ConnectVoice, Speak, Stream, ManageMessages, MuteMembers, MoveMembers, Kick, Ban, CreateInvite, ManageRoles, ManageChannels, ManageCommunity, Admin` (bit 0 upward, spec §4 order — the TS mirror in Task 13 must use the same bits); `All`, `Default`, `DM`; `(Perms).Has(Perms) bool`; `type Override struct{ Allow, Deny Perms }`; `type Member struct{ IsOwner bool; Roles []Perms }`; `type Channel struct{ Everyone Override; Roles []Override; Member *Override }`; `Base(Member) Perms`; `Effective(Member, Channel) Perms`.

- [ ] **Step 1: Write the failing test** — `server/internal/perms/perms_test.go`

```go
package perms

import "testing"

func TestEffective(t *testing.T) {
	member := Member{Roles: []Perms{ViewChannel | SendMessages | ReadHistory}} // @everyone only
	tests := []struct {
		name string
		m    Member
		c    Channel
		want Perms
	}{
		{"base is the OR of roles", Member{Roles: []Perms{ViewChannel, SendMessages}}, Channel{}, ViewChannel | SendMessages},
		{"owner gets everything", Member{IsOwner: true}, Channel{Everyone: Override{Deny: ViewChannel}}, All},
		{"admin role gets everything", Member{Roles: []Perms{0, Admin}}, Channel{Everyone: Override{Deny: ViewChannel}}, All},
		{"everyone deny removes", member, Channel{Everyone: Override{Deny: SendMessages}}, ViewChannel | ReadHistory},
		{"everyone allow adds", member, Channel{Everyone: Override{Allow: Stream}}, ViewChannel | SendMessages | ReadHistory | Stream},
		{"role allow beats everyone deny", member,
			Channel{Everyone: Override{Deny: SendMessages}, Roles: []Override{{Allow: SendMessages}}},
			ViewChannel | SendMessages | ReadHistory},
		{"role allow beats another role's deny", member,
			Channel{Roles: []Override{{Deny: SendMessages}, {Allow: SendMessages}}},
			ViewChannel | SendMessages | ReadHistory},
		{"member deny beats role allow", member,
			Channel{Roles: []Override{{Allow: Stream}}, Member: &Override{Deny: Stream | SendMessages}},
			ViewChannel | ReadHistory},
		{"member allow beats role deny", member,
			Channel{Roles: []Override{{Deny: SendMessages}}, Member: &Override{Allow: SendMessages}},
			ViewChannel | SendMessages | ReadHistory},
		{"no view means nothing", member, Channel{Everyone: Override{Deny: ViewChannel}}, 0},
		{"view granted by override", Member{Roles: []Perms{SendMessages}}, Channel{Roles: []Override{{Allow: ViewChannel}}}, ViewChannel | SendMessages},
		{"overrides cannot grant admin", member, Channel{Member: &Override{Allow: Admin}}, ViewChannel | SendMessages | ReadHistory},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Effective(tt.m, tt.c); got != tt.want {
				t.Fatalf("Effective = %b, want %b", got, tt.want)
			}
		})
	}
}

func TestBase(t *testing.T) {
	if got := Base(Member{Roles: []Perms{Kick, Ban}}); got != Kick|Ban {
		t.Fatalf("Base = %b", got)
	}
	if got := Base(Member{Roles: []Perms{Admin}}); got != All {
		t.Fatalf("admin Base = %b, want All", got)
	}
}

func TestHas(t *testing.T) {
	p := ViewChannel | SendMessages
	if !p.Has(ViewChannel) || !p.Has(ViewChannel|SendMessages) || p.Has(ViewChannel|Kick) {
		t.Fatal("Has is wrong")
	}
}

func TestBitValuesAreStable(t *testing.T) {
	// The web client mirrors these values (clients/core/src/perms.ts).
	if ViewChannel != 1 || Admin != 1<<16 || All != 1<<17-1 {
		t.Fatalf("flag values changed: view=%d admin=%d all=%d", ViewChannel, Admin, All)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/perms/`
Expected: FAIL — build error `undefined: Member`.

- [ ] **Step 3: Implement** — `server/internal/perms/perms.go`

```go
// Package perms calculates permissions. It is pure: no I/O.
// Spec §4 describes the algorithm; Effective is the only place it lives.
package perms

// Perms is a 64-bit permission mask. It travels as a JSON number; the
// flags stay far below 2^53, so JavaScript can hold it exactly.
type Perms uint64

const (
	ViewChannel Perms = 1 << iota
	SendMessages
	AttachFiles
	ReadHistory
	ConnectVoice
	Speak
	Stream
	ManageMessages
	MuteMembers
	MoveMembers
	Kick
	Ban
	CreateInvite
	ManageRoles
	ManageChannels
	ManageCommunity
	Admin
)

// All is every flag.
const All Perms = Admin<<1 - 1

// Default is what @everyone gets in a new community.
const Default = ViewChannel | SendMessages | AttachFiles | ReadHistory | ConnectVoice | Speak | Stream | CreateInvite

// DM is the fixed set every DM participant holds.
const DM = ViewChannel | SendMessages | AttachFiles | ReadHistory | ConnectVoice | Speak | Stream

// overridable is what a channel override may allow or deny.
const overridable = All &^ Admin

func (p Perms) Has(q Perms) bool { return p&q == q }

type Override struct{ Allow, Deny Perms }

// Member describes one member of a community.
type Member struct {
	IsOwner bool
	Roles   []Perms // masks of every role the member holds, including @everyone
}

// Channel holds the overrides that apply to one member in one channel.
type Channel struct {
	Everyone Override   // the @everyone override (zero if none)
	Roles    []Override // overrides for roles the member holds
	Member   *Override  // the member's own override, if any
}

// Base is the community-level permission set: the OR of all roles.
func Base(m Member) Perms {
	if m.IsOwner {
		return All
	}
	var p Perms
	for _, r := range m.Roles {
		p |= r
	}
	if p.Has(Admin) {
		return All
	}
	return p
}

// Effective is the member's permission set in a channel (spec §4 steps 1–6).
func Effective(m Member, c Channel) Perms {
	p := Base(m)
	if p.Has(Admin) {
		return All
	}
	p = p&^(c.Everyone.Deny&overridable) | c.Everyone.Allow&overridable
	var allow, deny Perms
	for _, o := range c.Roles {
		allow |= o.Allow
		deny |= o.Deny
	}
	p = p&^(deny&overridable) | allow&overridable
	if c.Member != nil {
		p = p&^(c.Member.Deny&overridable) | c.Member.Allow&overridable
	}
	if !p.Has(ViewChannel) {
		return 0
	}
	return p
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test ./internal/perms/`
Expected: `ok`

- [ ] **Step 5: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(server): permission calculation`

---

### Task 3: Database plumbing and account storage

Sets up Postgres access, embedded migrations, the per-test database helper, and the `auth` package's storage layer (users, sessions, instance settings), password hashing, and session tokens.

**Files:**
- Create: `server/internal/db/db.go`
- Create: `server/internal/db/migrations/00001_auth.sql`
- Create: `server/internal/pgtest/pgtest.go`
- Create: `server/internal/auth/password.go`
- Create: `server/internal/auth/token.go`
- Create: `server/internal/auth/store.go`
- Test: `server/internal/auth/password_test.go`
- Test: `server/internal/auth/store_test.go`

**Interfaces:**
- Consumes: `id.ID`, `id.New`, `id.Int64s` (Task 1).
- Produces:
  - `db.Open(ctx, url string) (*pgxpool.Pool, error)`, `db.Migrate(ctx, *pgxpool.Pool) error`, `db.IsUniqueViolation(error) bool`, `db.IsForeignKeyViolation(error) bool`. Later tasks add migration files `0000N_<pkg>.sql` to `server/internal/db/migrations/`.
  - `pgtest.New(t testing.TB) *pgxpool.Pool` — a fresh, fully migrated database per call.
  - `auth.HashPassword(string) (string, error)`, `auth.VerifyPassword(pw, encoded string) (bool, error)`, `auth.NewToken() (token string, hash []byte, err error)`, `auth.HashToken(string) []byte`.
  - Types `auth.User`, `auth.PublicUser`, `(*User).Public() PublicUser`, `auth.Session`, `auth.Settings`; constants `auth.ModeInviteOnly|ModeOpen|ModeAdminOnly`; errors `auth.ErrNotFound`, `auth.ErrTaken`.
  - `auth.NewStore(*pgxpool.Pool) *Store` with `CreateUser`, `CountUsers`, `UserByID`, `UserByLogin`, `ListUsers`, `PublicUsers`, `UpdateDisplayName`, `SetPassword`, `SetDisabled`, `CreateSession`, `SessionByTokenHash`, `TouchSession`, `ListSessions`, `DeleteSession`, `DeleteSessions`, `Settings`, `UpdateSettings` (signatures below).

- [ ] **Step 1: Add dependencies**

```bash
cd server
go get github.com/jackc/pgx/v5 github.com/pressly/goose/v3 golang.org/x/crypto github.com/stretchr/testify
go get github.com/testcontainers/testcontainers-go github.com/testcontainers/testcontainers-go/modules/postgres
```

- [ ] **Step 2: Write the migration** — `server/internal/db/migrations/00001_auth.sql`

```sql
-- +goose Up
CREATE TABLE users (
    id            BIGINT PRIMARY KEY,
    username      TEXT NOT NULL,
    email         TEXT,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    disabled      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE sessions (
    id           BIGINT PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   BYTEA NOT NULL UNIQUE,
    device_name  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- A single row of instance-wide settings.
CREATE TABLE instance_settings (
    id                       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    registration_mode        TEXT NOT NULL DEFAULT 'invite_only'
                             CHECK (registration_mode IN ('invite_only', 'open', 'admin_only')),
    allow_community_creation BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO instance_settings DEFAULT VALUES;

-- +goose Down
DROP TABLE instance_settings;
DROP TABLE sessions;
DROP TABLE users;
```

- [ ] **Step 3: Write `server/internal/db/db.go`**

```go
// Package db opens Postgres and runs the embedded migrations.
// Each package owns its tables; its migration file is named after it.
package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return pool, nil
}

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	fsys, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return err
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	p, err := goose.NewProvider(goose.DialectPostgres, sqlDB, fsys)
	if err != nil {
		return err
	}
	_, err = p.Up(ctx)
	return err
}

func IsUniqueViolation(err error) bool { return pgCode(err) == "23505" }

func IsForeignKeyViolation(err error) bool { return pgCode(err) == "23503" }

func pgCode(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code
	}
	return ""
}
```

- [ ] **Step 4: Write `server/internal/pgtest/pgtest.go`**

```go
// Package pgtest gives each test its own migrated Postgres database.
//
// One container starts per test binary. The schema is migrated once into a
// template database; every New call clones it, which takes milliseconds.
// Docker must be running.
package pgtest

import (
	"context"
	"fmt"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/datrope/datrope/server/internal/db"
)

var (
	once     sync.Once
	baseURL  *url.URL
	startErr error
	cloneMu  sync.Mutex // CREATE DATABASE … TEMPLATE fails when run concurrently
	counter  atomic.Int64
)

func New(t testing.TB) *pgxpool.Pool {
	t.Helper()
	once.Do(start)
	if startErr != nil {
		t.Fatalf("start postgres (is Docker running?): %v", startErr)
	}
	ctx := context.Background()
	name := fmt.Sprintf("test_%d", counter.Add(1))
	cloneMu.Lock()
	err := execIn(ctx, "postgres", "CREATE DATABASE "+name+" TEMPLATE datrope_template")
	cloneMu.Unlock()
	if err != nil {
		t.Fatalf("create database: %v", err)
	}
	pool, err := db.Open(ctx, urlFor(name))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func start() {
	ctx := context.Background()
	c, err := postgres.Run(ctx, "postgres:17-alpine",
		postgres.WithDatabase("postgres"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		startErr = err
		return
	}
	raw, err := c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		startErr = err
		return
	}
	if baseURL, err = url.Parse(raw); err != nil {
		startErr = err
		return
	}
	if err := execIn(ctx, "postgres", "CREATE DATABASE datrope_template"); err != nil {
		startErr = err
		return
	}
	pool, err := db.Open(ctx, urlFor("datrope_template"))
	if err != nil {
		startErr = err
		return
	}
	defer pool.Close() // the template must have no open connections when cloned
	startErr = db.Migrate(ctx, pool)
}

func urlFor(name string) string {
	u := *baseURL
	u.Path = "/" + name
	return u.String()
}

func execIn(ctx context.Context, dbName, sql string) error {
	conn, err := pgx.Connect(ctx, urlFor(dbName))
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, sql)
	return err
}
```

- [ ] **Step 5: Write the failing tests**

`server/internal/auth/password_test.go`:

```go
package auth_test

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/auth"
)

func TestPassword(t *testing.T) {
	h, err := auth.HashPassword("correct horse")
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(h, "$argon2id$v=19$m=19456,t=2,p=1$"), h)

	ok, err := auth.VerifyPassword("correct horse", h)
	require.NoError(t, err)
	require.True(t, ok)

	ok, err = auth.VerifyPassword("wrong", h)
	require.NoError(t, err)
	require.False(t, ok)

	h2, err := auth.HashPassword("correct horse")
	require.NoError(t, err)
	require.NotEqual(t, h, h2, "salt must differ")

	_, err = auth.VerifyPassword("x", "$2a$10$bcrypthash")
	require.Error(t, err)
}

func TestToken(t *testing.T) {
	tok, hash, err := auth.NewToken()
	require.NoError(t, err)
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	require.NoError(t, err)
	require.Len(t, raw, 32)
	require.Len(t, hash, 32)
	require.Equal(t, hash, auth.HashToken(tok))
}
```

`server/internal/auth/store_test.go`:

```go
package auth_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/pgtest"
)

func TestStore(t *testing.T) {
	ctx := context.Background()
	s := auth.NewStore(pgtest.New(t))

	alice := &auth.User{ID: id.New(), Username: "Alice", DisplayName: "Alice", PasswordHash: "h"}
	require.NoError(t, s.CreateUser(ctx, alice))
	require.True(t, alice.IsAdmin, "the first user is the instance admin")

	email := "Bob@Example.com"
	bob := &auth.User{ID: id.New(), Username: "bob", Email: &email, DisplayName: "Bob", PasswordHash: "h"}
	require.NoError(t, s.CreateUser(ctx, bob))
	require.False(t, bob.IsAdmin)

	dup := &auth.User{ID: id.New(), Username: "ALICE", DisplayName: "x", PasswordHash: "h"}
	require.ErrorIs(t, s.CreateUser(ctx, dup), auth.ErrTaken, "usernames are case-insensitive")

	got, err := s.UserByLogin(ctx, "bob@example.com")
	require.NoError(t, err)
	require.Equal(t, bob.ID, got.ID)
	_, err = s.UserByLogin(ctx, "nobody")
	require.ErrorIs(t, err, auth.ErrNotFound)

	pub, err := s.PublicUsers(ctx, []id.ID{alice.ID, bob.ID})
	require.NoError(t, err)
	require.Equal(t, "Bob", pub[bob.ID].DisplayName)

	n, err := s.CountUsers(ctx)
	require.NoError(t, err)
	require.Equal(t, 2, n)

	_, hash, err := auth.NewToken()
	require.NoError(t, err)
	sess := &auth.Session{ID: id.New(), UserID: bob.ID, TokenHash: hash, DeviceName: "laptop"}
	require.NoError(t, s.CreateSession(ctx, sess))

	gotSess, gotUser, err := s.SessionByTokenHash(ctx, hash)
	require.NoError(t, err)
	require.Equal(t, sess.ID, gotSess.ID)
	require.Equal(t, bob.ID, gotUser.ID)

	list, err := s.ListSessions(ctx, bob.ID)
	require.NoError(t, err)
	require.Len(t, list, 1)

	deleted, err := s.DeleteSession(ctx, alice.ID, sess.ID)
	require.NoError(t, err)
	require.False(t, deleted, "users cannot delete other users' sessions")

	ids, err := s.DeleteSessions(ctx, bob.ID)
	require.NoError(t, err)
	require.Equal(t, []id.ID{sess.ID}, ids)
	_, _, err = s.SessionByTokenHash(ctx, hash)
	require.ErrorIs(t, err, auth.ErrNotFound)

	set, err := s.Settings(ctx)
	require.NoError(t, err)
	require.Equal(t, auth.Settings{RegistrationMode: auth.ModeInviteOnly, AllowCommunityCreation: true}, set)
	set.RegistrationMode = auth.ModeOpen
	require.NoError(t, s.UpdateSettings(ctx, set))
	set2, err := s.Settings(ctx)
	require.NoError(t, err)
	require.Equal(t, auth.ModeOpen, set2.RegistrationMode)
}
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd server && go test ./internal/auth/`
Expected: FAIL — build errors (`undefined: auth.HashPassword` …).

- [ ] **Step 7: Implement `server/internal/auth/password.go`**

```go
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

// OWASP-recommended argon2id parameters: 19 MiB, 2 iterations, 1 lane.
const (
	argonMemory  = 19 * 1024
	argonTime    = 2
	argonThreads = 1
	argonKeyLen  = 32
)

var b64 = base64.RawStdEncoding

// HashPassword returns a PHC-format argon2id hash.
func HashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

func VerifyPassword(pw, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$") // "", "argon2id", "v=19", "m=…,t=…,p=…", salt, key
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("unsupported password hash")
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, fmt.Errorf("bad hash parameters: %w", err)
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is verified against when a login names no user, so that
// response time does not reveal which usernames exist.
var dummyHash = sync.OnceValue(func() string {
	h, _ := HashPassword("not a real password")
	return h
})
```

- [ ] **Step 8: Implement `server/internal/auth/token.go`**

```go
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
)

// NewToken returns a session token (32 random bytes, base64url) and the
// SHA-256 hash that is stored in its place.
func NewToken() (token string, hash []byte, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, HashToken(token), nil
}

func HashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}
```

- [ ] **Step 9: Implement `server/internal/auth/store.go`**

```go
package auth

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/db"
	"github.com/datrope/datrope/server/internal/id"
)

var (
	ErrNotFound = errors.New("not found")
	ErrTaken    = errors.New("username or email already in use")
)

const (
	ModeInviteOnly = "invite_only"
	ModeOpen       = "open"
	ModeAdminOnly  = "admin_only"
)

// User is the full account. Only its owner and admins see it.
type User struct {
	ID           id.ID     `json:"id"`
	Username     string    `json:"username"`
	Email        *string   `json:"email,omitempty"`
	DisplayName  string    `json:"display_name"`
	IsAdmin      bool      `json:"is_admin"`
	Disabled     bool      `json:"disabled"`
	CreatedAt    time.Time `json:"created_at"`
	PasswordHash string    `json:"-"`
}

// PublicUser is what other users may see.
type PublicUser struct {
	ID          id.ID  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

func (u *User) Public() PublicUser {
	return PublicUser{ID: u.ID, Username: u.Username, DisplayName: u.DisplayName}
}

type Session struct {
	ID         id.ID     `json:"id"`
	UserID     id.ID     `json:"-"`
	DeviceName string    `json:"device_name"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt time.Time `json:"last_used_at"`
	Current    bool      `json:"current"`
	TokenHash  []byte    `json:"-"`
}

type Settings struct {
	RegistrationMode       string `json:"registration_mode" enum:"invite_only,open,admin_only"`
	AllowCommunityCreation bool   `json:"allow_community_creation"`
}

type Store struct{ db *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{db: pool} }

const userCols = `u.id, u.username, u.email, u.display_name, u.is_admin, u.disabled, u.created_at, u.password_hash`

func scanUser(row pgx.Row, extra ...any) (*User, error) {
	var u User
	dest := append(extra, &u.ID, &u.Username, &u.Email, &u.DisplayName, &u.IsAdmin, &u.Disabled, &u.CreatedAt, &u.PasswordHash)
	err := row.Scan(dest...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// CreateUser inserts u. The first user ever created becomes the instance
// admin; u.IsAdmin and u.CreatedAt are filled in.
func (s *Store) CreateUser(ctx context.Context, u *User) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialise sign-ups so exactly one user can be "first".
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(1001)`); err != nil {
		return err
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	u.IsAdmin = n == 0
	err = tx.QueryRow(ctx, `
		INSERT INTO users (id, username, email, display_name, password_hash, is_admin)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at`,
		u.ID, u.Username, u.Email, u.DisplayName, u.PasswordHash, u.IsAdmin).Scan(&u.CreatedAt)
	if db.IsUniqueViolation(err) {
		return ErrTaken
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

func (s *Store) UserByID(ctx context.Context, userID id.ID) (*User, error) {
	return scanUser(s.db.QueryRow(ctx, `SELECT `+userCols+` FROM users u WHERE u.id = $1`, userID))
}

// UserByLogin finds a user by username or email, ignoring case.
func (s *Store) UserByLogin(ctx context.Context, login string) (*User, error) {
	return scanUser(s.db.QueryRow(ctx,
		`SELECT `+userCols+` FROM users u WHERE lower(u.username) = lower($1) OR lower(u.email) = lower($1)`, login))
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.Query(ctx, `SELECT `+userCols+` FROM users u ORDER BY u.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}

func (s *Store) PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]PublicUser, error) {
	rows, err := s.db.Query(ctx, `SELECT id, username, display_name FROM users WHERE id = ANY($1)`, id.Int64s(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[id.ID]PublicUser, len(ids))
	for rows.Next() {
		var p PublicUser
		if err := rows.Scan(&p.ID, &p.Username, &p.DisplayName); err != nil {
			return nil, err
		}
		out[p.ID] = p
	}
	return out, rows.Err()
}

func (s *Store) UpdateDisplayName(ctx context.Context, userID id.ID, name string) (*User, error) {
	return scanUser(s.db.QueryRow(ctx,
		`UPDATE users u SET display_name = $2 WHERE u.id = $1 RETURNING `+userCols, userID, name))
}

func (s *Store) SetPassword(ctx context.Context, userID id.ID, hash string) error {
	return s.execOne(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1`, userID, hash)
}

func (s *Store) SetDisabled(ctx context.Context, userID id.ID, disabled bool) error {
	return s.execOne(ctx, `UPDATE users SET disabled = $2 WHERE id = $1`, userID, disabled)
}

func (s *Store) execOne(ctx context.Context, sql string, args ...any) error {
	tag, err := s.db.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) CreateSession(ctx context.Context, sess *Session) error {
	return s.db.QueryRow(ctx, `
		INSERT INTO sessions (id, user_id, token_hash, device_name) VALUES ($1, $2, $3, $4)
		RETURNING created_at, last_used_at`,
		sess.ID, sess.UserID, sess.TokenHash, sess.DeviceName).Scan(&sess.CreatedAt, &sess.LastUsedAt)
}

func (s *Store) SessionByTokenHash(ctx context.Context, hash []byte) (*Session, *User, error) {
	var sess Session
	u, err := scanUser(s.db.QueryRow(ctx, `
		SELECT s.id, s.user_id, s.device_name, s.created_at, s.last_used_at, `+userCols+`
		FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`, hash),
		&sess.ID, &sess.UserID, &sess.DeviceName, &sess.CreatedAt, &sess.LastUsedAt)
	if err != nil {
		return nil, nil, err
	}
	return &sess, u, nil
}

// TouchSession records use, at most once a minute per session.
func (s *Store) TouchSession(ctx context.Context, sessionID id.ID) error {
	_, err := s.db.Exec(ctx, `
		UPDATE sessions SET last_used_at = now()
		WHERE id = $1 AND last_used_at < now() - interval '1 minute'`, sessionID)
	return err
}

func (s *Store) ListSessions(ctx context.Context, userID id.ID) ([]Session, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, user_id, device_name, created_at, last_used_at FROM sessions
		WHERE user_id = $1 ORDER BY last_used_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		var x Session
		if err := rows.Scan(&x.ID, &x.UserID, &x.DeviceName, &x.CreatedAt, &x.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// DeleteSession deletes one of userID's sessions and reports whether it existed.
func (s *Store) DeleteSession(ctx context.Context, userID, sessionID id.ID) (bool, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE id = $1 AND user_id = $2`, sessionID, userID)
	return tag.RowsAffected() > 0, err
}

// DeleteSessions deletes all of a user's sessions and returns their IDs.
func (s *Store) DeleteSessions(ctx context.Context, userID id.ID) ([]id.ID, error) {
	rows, err := s.db.Query(ctx, `DELETE FROM sessions WHERE user_id = $1 RETURNING id`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}

func (s *Store) Settings(ctx context.Context) (Settings, error) {
	var x Settings
	err := s.db.QueryRow(ctx, `SELECT registration_mode, allow_community_creation FROM instance_settings`).
		Scan(&x.RegistrationMode, &x.AllowCommunityCreation)
	return x, err
}

func (s *Store) UpdateSettings(ctx context.Context, x Settings) error {
	_, err := s.db.Exec(ctx, `UPDATE instance_settings SET registration_mode = $1, allow_community_creation = $2`,
		x.RegistrationMode, x.AllowCommunityCreation)
	return err
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `cd server && go test ./internal/auth/`
Expected: `ok` (the first run pulls the `postgres:17-alpine` image; allow a minute).

- [ ] **Step 11: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(server): database, migrations, and account storage`

---

### Task 4: HTTP foundation (Huma, errors, middleware, event bus, app shell)

**Files:**
- Modify: `server/internal/id/id.go` (add `Schema` method)
- Create: `server/internal/httpx/errors.go`
- Create: `server/internal/httpx/middleware.go`
- Create: `server/internal/events/events.go`
- Create: `server/internal/app/config.go`
- Create: `server/internal/app/app.go`
- Create: `server/internal/apptest/apptest.go`
- Create: `server/cmd/datrope/main.go`
- Test: `server/internal/httpx/httpx_test.go`
- Test: `server/internal/events/events_test.go`
- Test: `server/internal/app/app_test.go`

**Interfaces:**
- Produces:
  - `httpx.Error{Status int; Code, Message string; Details map[string]any}` implementing `huma.StatusError`; `httpx.E(status int, code, msg string) *Error`; `httpx.NotFound(what string)`, `httpx.MissingPermission()`, `httpx.Unauthorized()`, `httpx.RateLimited()`, `httpx.BadRequest(code, msg string)`; `httpx.ParseID(s, what string) (id.ID, error)`; `httpx.Authed` (Huma `Security` value for signed-in operations); `httpx.WriteError(api huma.API, ctx huma.Context, e *Error)`.
  - Middleware: `httpx.Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler` (first is outermost), `httpx.RequestID`, `httpx.ClientIP(trustProxy bool)`, `httpx.Logger`, `httpx.Recover`; `httpx.RequestIDFrom(ctx) string`; `httpx.ClientIPFrom(ctx) string`.
  - `events.Scope{CommunityID, ChannelID, CoMembersOf id.ID; UserIDs []id.ID}`, `events.Event{Type string; Data any; Scope Scope}`, `(*events.Bus).Subscribe(func(Event))`, `(*events.Bus).Publish(Event)`, `events.SessionsRevoked`, `events.SessionsRevokedData{UserID id.ID; SessionIDs []id.ID}`.
  - `app.Config{DatabaseURL, Addr, PublicURL string; TrustProxy bool}`, `app.ConfigFromEnv() (Config, error)`, `app.New(*pgxpool.Pool, Config) *App`, `App{Handler http.Handler; API huma.API; Bus *events.Bus}`, `(*App).Close()`.
  - `apptest.New(t) *Env`, `apptest.NewWithConfig(t, func(*app.Config)) *Env`, `Env{T; App; Pool; Server}`, `apptest.PublicURL`, `(*Env).Anon() *Client`, `(*Client).Do(method, path string, body any, want int, out any) *http.Response`, `(*Client).Fail(method, path string, body any, wantStatus int, wantCode string)`.
  - CLI: `datrope` (serve), `datrope openapi <file>`.

- [ ] **Step 1: Add the dependency**

```bash
cd server && go get github.com/danielgtaylor/huma/v2
```

Huma v2.27 or newer is required (`huma.NewErrorWithContext`).

- [ ] **Step 2: Write the failing tests**

`server/internal/httpx/httpx_test.go`:

```go
package httpx_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/httpx"
)

func assertError(t *testing.T, resp *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	require.Equal(t, status, resp.Code, resp.Body.String())
	var e httpx.Error
	require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &e))
	require.Equal(t, code, e.Code)
}

func TestErrorShape(t *testing.T) {
	_, api := humatest.New(t)
	type validateIn struct {
		Body struct {
			Name string `json:"name" minLength:"3"`
		}
	}
	huma.Register(api, huma.Operation{OperationID: "validate", Method: http.MethodPost, Path: "/v"},
		func(ctx context.Context, in *validateIn) (*struct{}, error) { return nil, nil })
	huma.Register(api, huma.Operation{OperationID: "typed", Method: http.MethodGet, Path: "/typed"},
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			return nil, httpx.E(http.StatusConflict, "USERNAME_TAKEN", "taken")
		})
	huma.Register(api, huma.Operation{OperationID: "boom", Method: http.MethodGet, Path: "/boom"},
		func(ctx context.Context, _ *struct{}) (*struct{}, error) { return nil, errors.New("secret db detail") })

	assertError(t, api.Post("/v", map[string]any{"name": "x"}), http.StatusBadRequest, "VALIDATION_FAILED")
	assertError(t, api.Get("/typed"), http.StatusConflict, "USERNAME_TAKEN")

	resp := api.Get("/boom")
	assertError(t, resp, http.StatusInternalServerError, "INTERNAL")
	require.NotContains(t, resp.Body.String(), "secret", "500s must not leak internals")
}

func TestRequestIDAndClientIP(t *testing.T) {
	var gotIP, gotRID string
	h := httpx.Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotIP = httpx.ClientIPFrom(r.Context())
		gotRID = httpx.RequestIDFrom(r.Context())
	}), httpx.RequestID, httpx.ClientIP(true))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.2:5555"
	req.Header.Set("X-Forwarded-For", "1.1.1.1, 203.0.113.9")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, "203.0.113.9", gotIP, "the last hop is the one our proxy added")
	require.NotEmpty(t, gotRID)
	require.Equal(t, gotRID, rec.Header().Get("X-Request-ID"))
}

func TestRecover(t *testing.T) {
	h := httpx.Chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }),
		httpx.RequestID, httpx.Recover)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	assertError(t, rec, http.StatusInternalServerError, "INTERNAL")
}
```

`server/internal/events/events_test.go`:

```go
package events_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/events"
)

func TestBusDeliversToAllSubscribersInOrder(t *testing.T) {
	var b events.Bus
	var got []string
	b.Subscribe(func(e events.Event) { got = append(got, "a:"+e.Type) })
	b.Subscribe(func(e events.Event) { got = append(got, "b:"+e.Type) })
	b.Publish(events.Event{Type: "X"})
	b.Publish(events.Event{Type: "Y"})
	require.Equal(t, []string{"a:X", "b:X", "a:Y", "b:Y"}, got)
}
```

`server/internal/app/app_test.go`:

```go
package app_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
)

func TestHealthz(t *testing.T) {
	env := apptest.New(t)
	resp, err := http.Get(env.Server.URL + "/healthz")
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.NotEmpty(t, resp.Header.Get("X-Request-ID"))
}

func TestOpenAPIIsServed(t *testing.T) {
	env := apptest.New(t)
	var doc map[string]any
	env.Anon().Do(http.MethodGet, "/api/openapi.json", nil, http.StatusOK, &doc)
	require.Equal(t, "3.1.0", doc["openapi"])
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd server && go test ./internal/httpx/ ./internal/events/ ./internal/app/`
Expected: FAIL — build errors (packages don't exist yet).

- [ ] **Step 4: Teach Huma that IDs are strings** — add to `server/internal/id/id.go`

Add the import `"github.com/danielgtaylor/huma/v2"` and:

```go
// Schema tells Huma (and so the OpenAPI document) that an ID is a string.
func (ID) Schema(huma.Registry) *huma.Schema {
	return &huma.Schema{Type: huma.TypeString, Pattern: "^[0-9]+$", Description: "Snowflake ID as a decimal string"}
}
```

- [ ] **Step 5: Implement `server/internal/httpx/errors.go`**

```go
// Package httpx holds the REST error type (spec §9), middleware, and small
// helpers shared by every package's handlers.
package httpx

import (
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/id"
)

// Error is the body of every REST error. Clients branch on Code only.
type Error struct {
	Status  int            `json:"-"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

func (e *Error) Error() string  { return e.Message }
func (e *Error) GetStatus() int { return e.Status }

func E(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

func NotFound(what string) *Error { return E(http.StatusNotFound, "NOT_FOUND", what+" not found") }
func MissingPermission() *Error {
	return E(http.StatusForbidden, "MISSING_PERMISSION", "you do not have permission to do that")
}
func Unauthorized() *Error { return E(http.StatusUnauthorized, "UNAUTHORIZED", "sign in required") }
func RateLimited() *Error  { return E(http.StatusTooManyRequests, "RATE_LIMITED", "too many requests, slow down") }
func BadRequest(code, message string) *Error {
	return E(http.StatusBadRequest, code, message)
}

// ParseID parses an ID path parameter. A malformed ID names nothing, so it is a 404.
func ParseID(s, what string) (id.ID, error) {
	v, err := id.Parse(s)
	if err != nil {
		return 0, NotFound(what)
	}
	return v, nil
}

// Authed marks an operation as requiring a signed-in user. The auth
// middleware enforces it.
var Authed = []map[string][]string{{"session": {}}}

func codeFor(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "VALIDATION_FAILED"
	case http.StatusUnauthorized:
		return "UNAUTHORIZED"
	case http.StatusForbidden:
		return "MISSING_PERMISSION"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusConflict:
		return "CONFLICT"
	case http.StatusRequestEntityTooLarge:
		return "TOO_LARGE"
	case http.StatusTooManyRequests:
		return "RATE_LIMITED"
	default:
		return "INTERNAL"
	}
}

func newError(status int, msg string, errs ...error) huma.StatusError {
	if status == http.StatusUnprocessableEntity {
		status = http.StatusBadRequest // spec §9 uses 400 for validation failures
	}
	if status >= 500 {
		return &Error{Status: status, Code: "INTERNAL", Message: "internal error"}
	}
	e := &Error{Status: status, Code: codeFor(status), Message: msg}
	if len(errs) > 0 {
		list := make([]string, 0, len(errs))
		for _, err := range errs {
			list = append(list, err.Error())
		}
		e.Details = map[string]any{"errors": list}
	}
	return e
}

func init() {
	huma.NewError = newError
	huma.NewErrorWithContext = func(ctx huma.Context, status int, msg string, errs ...error) huma.StatusError {
		if status < 500 {
			return newError(status, msg, errs...)
		}
		rid := RequestIDFrom(ctx.Context())
		slog.ErrorContext(ctx.Context(), "request failed", "request_id", rid, "status", status, "msg", msg, "errors", errs)
		return &Error{Status: status, Code: "INTERNAL", Message: "internal error", Details: map[string]any{"request_id": rid}}
	}
}

// WriteError writes e from inside a Huma middleware.
func WriteError(api huma.API, ctx huma.Context, e *Error) {
	ctx.SetHeader("Content-Type", "application/json")
	ctx.SetStatus(e.Status)
	_ = api.Marshal(ctx.BodyWriter(), "application/json", e)
}
```

- [ ] **Step 6: Implement `server/internal/httpx/middleware.go`**

```go
package httpx

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

type ctxKey int

const (
	ridKey ctxKey = iota
	ipKey
)

// Chain wraps h in middleware; the first one listed is the outermost.
func Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, 8)
		_, _ = rand.Read(b)
		rid := hex.EncodeToString(b)
		w.Header().Set("X-Request-ID", rid)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ridKey, rid)))
	})
}

func RequestIDFrom(ctx context.Context) string {
	s, _ := ctx.Value(ridKey).(string)
	return s
}

// ClientIP records the caller's IP. Behind our reverse proxy (trustProxy),
// the last X-Forwarded-For entry is the address the proxy saw.
func ClientIP(trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				ip = r.RemoteAddr
			}
			if xff := r.Header.Get("X-Forwarded-For"); trustProxy && xff != "" {
				parts := strings.Split(xff, ",")
				ip = strings.TrimSpace(parts[len(parts)-1])
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ipKey, ip)))
		})
	}
}

func ClientIPFrom(ctx context.Context) string {
	s, _ := ctx.Value(ipKey).(string)
	return s
}

func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		slog.InfoContext(r.Context(), "http", "method", r.Method, "path", r.URL.Path, "status", sw.status,
			"duration_ms", time.Since(start).Milliseconds(), "request_id", RequestIDFrom(r.Context()))
	})
}

func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			rid := RequestIDFrom(r.Context())
			slog.ErrorContext(r.Context(), "panic", "request_id", rid, "panic", v, "stack", string(debug.Stack()))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(&Error{Code: "INTERNAL", Message: "internal error",
				Details: map[string]any{"request_id": rid}})
		}()
		next.ServeHTTP(w, r)
	})
}

// statusWriter records the status code. It passes Hijack and Flush
// through so WebSocket upgrades keep working.
type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(s int) {
	if !w.wrote {
		w.status, w.wrote = s, true
	}
	w.ResponseWriter.WriteHeader(s)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	w.wrote = true
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.status = http.StatusSwitchingProtocols
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

func (w *statusWriter) Flush() { _ = http.NewResponseController(w.ResponseWriter).Flush() }
```

- [ ] **Step 7: Implement `server/internal/events/events.go`**

```go
// Package events is the in-process event bus. Packages publish; the
// gateway subscribes and delivers to WebSocket clients (spec §2.1).
package events

import (
	"sync"

	"github.com/datrope/datrope/server/internal/id"
)

// Scope says who receives an event. The gateway delivers to the union.
type Scope struct {
	CommunityID id.ID   // every member of this community
	ChannelID   id.ID   // everyone who can view this channel
	CoMembersOf id.ID   // everyone who shares a community with this user
	UserIDs     []id.ID // these users
}

type Event struct {
	Type  string // e.g. "MESSAGE_CREATE"; "internal." prefix = never sent to clients
	Data  any    // JSON-encoded as the event payload
	Scope Scope
}

// SessionsRevoked tells the gateway to close connections using these sessions.
const SessionsRevoked = "internal.SESSIONS_REVOKED"

type SessionsRevokedData struct {
	UserID     id.ID
	SessionIDs []id.ID // nil means every session of the user
}

type Bus struct {
	mu   sync.RWMutex
	subs []func(Event)
}

func (b *Bus) Subscribe(fn func(Event)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subs = append(b.subs, fn)
}

// Publish calls every subscriber synchronously, in subscription order.
func (b *Bus) Publish(e Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, fn := range b.subs {
		fn(e)
	}
}
```

- [ ] **Step 8: Implement `server/internal/app/config.go`**

```go
package app

import (
	"errors"
	"os"
	"strings"
)

type Config struct {
	DatabaseURL string
	Addr        string
	// PublicURL is the origin browsers load the web app from, e.g.
	// https://chat.example.com. Cookie-authenticated WebSockets must come from it.
	PublicURL  string
	TrustProxy bool // read the client IP from X-Forwarded-For (set behind Caddy)
}

func ConfigFromEnv() (Config, error) {
	c := Config{
		DatabaseURL: os.Getenv("DATROPE_DATABASE_URL"),
		Addr:        os.Getenv("DATROPE_ADDR"),
		PublicURL:   strings.TrimSuffix(os.Getenv("DATROPE_PUBLIC_URL"), "/"),
		TrustProxy:  os.Getenv("DATROPE_TRUST_PROXY") == "true",
	}
	if c.Addr == "" {
		c.Addr = ":8080"
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATROPE_DATABASE_URL is required")
	}
	if c.PublicURL == "" {
		return c, errors.New("DATROPE_PUBLIC_URL is required")
	}
	return c, nil
}
```

- [ ] **Step 9: Implement `server/internal/app/app.go`**

```go
// Package app wires the packages into one HTTP handler.
package app

import (
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
)

type App struct {
	Handler http.Handler
	API     huma.API
	Bus     *events.Bus
	closers []func()
}

// Close stops background work (the gateway).
func (a *App) Close() {
	for _, c := range a.closers {
		c()
	}
}

// New builds the app. pool may be nil when only the OpenAPI document is
// needed (`datrope openapi`).
func New(pool *pgxpool.Pool, cfg Config) *App {
	mux := http.NewServeMux()
	api := humago.New(mux, apiConfig())
	a := &App{API: api, Bus: &events.Bus{}}

	// Services are added here by later tasks.

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok"))
	})

	a.Handler = httpx.Chain(mux, httpx.RequestID, httpx.ClientIP(cfg.TrustProxy), httpx.Logger, httpx.Recover)
	return a
}

func apiConfig() huma.Config {
	c := huma.DefaultConfig("Datrope API", "0.1.0")
	c.OpenAPIPath = "/api/openapi" // serves /api/openapi.json and /api/openapi.yaml
	c.DocsPath = ""
	c.SchemasPath = ""
	c.CreateHooks = nil // no "$schema" links in response bodies
	c.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		"session": {
			Type: "http", Scheme: "bearer",
			Description: "Session token. Web clients send the datrope_session cookie (plus X-Datrope-CSRF: 1 on writes) instead.",
		},
	}
	return c
}
```

- [ ] **Step 10: Implement `server/internal/apptest/apptest.go`**

```go
// Package apptest runs the whole app against a fresh database for
// end-to-end HTTP and WebSocket tests.
package apptest

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/pgtest"
)

// PublicURL is the origin the tests pretend browsers use.
const PublicURL = "http://datrope.test"

type Env struct {
	T      *testing.T
	App    *app.App
	Pool   *pgxpool.Pool
	Server *httptest.Server
}

func New(t *testing.T) *Env { return NewWithConfig(t, nil) }

func NewWithConfig(t *testing.T, mutate func(*app.Config)) *Env {
	t.Helper()
	pool := pgtest.New(t)
	cfg := app.Config{PublicURL: PublicURL}
	if mutate != nil {
		mutate(&cfg)
	}
	a := app.New(pool, cfg)
	srv := httptest.NewServer(a.Handler)
	t.Cleanup(func() {
		srv.Close()
		a.Close()
	})
	return &Env{T: t, App: a, Pool: pool, Server: srv}
}

// Client sends JSON requests, optionally as a signed-in user.
type Client struct {
	env    *Env
	Token  string      // sent as a bearer token when set
	Header http.Header // extra headers for every request
}

func (e *Env) Anon() *Client { return &Client{env: e, Header: http.Header{}} }

// Do sends a request and fails the test unless the status is want. If out
// is non-nil the JSON response is decoded into it.
func (c *Client) Do(method, path string, body any, want int, out any) *http.Response {
	t := c.env.T
	t.Helper()
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		require.NoError(t, err)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.env.Server.URL+path, r)
	require.NoError(t, err)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range c.Header {
		req.Header[k] = v
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	if resp.StatusCode != want {
		t.Fatalf("%s %s: status %d, want %d: %s", method, path, resp.StatusCode, want, raw)
	}
	if out != nil {
		require.NoError(t, json.Unmarshal(raw, out), string(raw))
	}
	return resp
}

// Fail sends a request that must fail with the given status and error code.
func (c *Client) Fail(method, path string, body any, wantStatus int, wantCode string) {
	c.env.T.Helper()
	var e httpx.Error
	c.Do(method, path, body, wantStatus, &e)
	require.Equal(c.env.T, wantCode, e.Code)
}
```

- [ ] **Step 11: Implement `server/cmd/datrope/main.go`**

```go
// Command datrope runs the Datrope server.
//
//	datrope                  serve (configured by DATROPE_* environment variables)
//	datrope openapi <file>   write the OpenAPI document and exit
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/db"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "serve":
		return serve()
	case "openapi":
		if len(args) < 2 {
			return errors.New("usage: datrope openapi <output.json>")
		}
		return writeOpenAPI(args[1])
	default:
		return fmt.Errorf("unknown command %q", cmd)
	}
}

func writeOpenAPI(path string) error {
	a := app.New(nil, app.Config{})
	b, err := json.MarshalIndent(a.API.OpenAPI(), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

func serve() error {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg, err := app.ConfigFromEnv()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	a := app.New(pool, cfg)
	defer a.Close()
	srv := &http.Server{Addr: cfg.Addr, Handler: a.Handler, ReadHeaderTimeout: 10 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.Info("listening", "addr", cfg.Addr)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
```

- [ ] **Step 12: Run the tests to verify they pass**

Run: `cd server && go test ./...`
Expected: all `ok`.

Also run: `cd server && go run ./cmd/datrope openapi ../openapi-check.json` — expect a JSON file starting with `"openapi": "3.1.0"`. Delete it afterwards.

- [ ] **Step 13: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(server): http foundation, error shape, event bus, app shell`

---

### Task 5: Accounts and sessions over HTTP

Registration, login, logout, the auth middleware (bearer token or cookie + CSRF header), rate limits, `/api/users/@me`, and session management.

**Files:**
- Create: `server/internal/ratelimit/ratelimit.go`
- Create: `server/internal/auth/service.go`
- Create: `server/internal/auth/handlers.go`
- Modify: `server/internal/app/app.go` (wire auth)
- Modify: `server/internal/apptest/apptest.go` (open registration, `Register`, `SetRegistrationMode`, `Client.User`)
- Test: `server/internal/ratelimit/ratelimit_test.go`
- Test: `server/internal/auth/handlers_test.go`

**Interfaces:**
- Consumes: Task 3 `auth.Store` and types; Task 4 `httpx.*`, `events.Bus`, `events.SessionsRevoked`, `apptest.*`.
- Produces:
  - `ratelimit.New(perMinute, burst int) *Limiter`, `(*Limiter).Allow(key string) bool`.
  - `auth.NewService(*pgxpool.Pool, *events.Bus) *Service`; `(*Service).SetInvites(Invites)`; `(*Service).Authenticate(ctx, token string) (*Principal, error)` (returns `auth.ErrInvalidSession` for unknown/revoked tokens and disabled users); `(*Service).PublicUsers(ctx, []id.ID) (map[id.ID]PublicUser, error)`; `(*Service).Settings(ctx) (Settings, error)`; `(*Service).Middleware(huma.API) func(huma.Context, func(huma.Context))`.
  - `type auth.Invites interface { Check(ctx, code string) error; Redeem(ctx, code string, userID id.ID) error }` — implemented by `communities` in Task 8.
  - `type auth.Principal struct { User *User; SessionID id.ID; ViaCookie bool }`; `auth.Current(ctx) *Principal`.
  - Constants `auth.CookieName = "datrope_session"`, `auth.CSRFHeader = "X-Datrope-CSRF"`.
  - `auth.Register(huma.API, *Service)`; response type `auth.AuthResult{User *User; Token string}`; `auth.InstanceInfo`.
  - Events: `USER_UPDATE` (data `PublicUser`, to co-members and self).
  - Endpoints: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/instance`, `GET|PATCH /api/users/@me`, `GET /api/sessions`, `DELETE /api/sessions/{id}`.
  - apptest: `(*Env).Register(username string) *Client` (password `password123`), `(*Env).SetRegistrationMode(mode string)`, `Client.User *auth.User`. `apptest.New` switches the instance to `open` registration so tests can create users freely.

Error codes introduced: `USERNAME_TAKEN` 409, `INVALID_CREDENTIALS` 401, `ACCOUNT_DISABLED` 403, `REGISTRATION_CLOSED` 403, `INVITE_REQUIRED` 403, `CSRF_FAILED` 403, `RATE_LIMITED` 429.

- [ ] **Step 1: Write the failing tests**

`server/internal/ratelimit/ratelimit_test.go`:

```go
package ratelimit_test

import (
	"testing"

	"github.com/datrope/datrope/server/internal/ratelimit"
)

func TestLimiter(t *testing.T) {
	l := ratelimit.New(1, 2)
	if !l.Allow("a") || !l.Allow("a") {
		t.Fatal("burst of 2 should be allowed")
	}
	if l.Allow("a") {
		t.Fatal("third call should be limited")
	}
	if !l.Allow("b") {
		t.Fatal("keys are independent")
	}
}
```

`server/internal/auth/handlers_test.go`:

```go
package auth_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
)

func reg(username string) map[string]any {
	return map[string]any{"username": username, "password": "password123", "device_name": "test", "client": "native"}
}

func login(name, password string) map[string]any {
	return map[string]any{"login": name, "password": password, "device_name": "test", "client": "native"}
}

func TestRegisterLoginLogout(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	require.True(t, alice.User.IsAdmin)

	var me auth.User
	alice.Do(http.MethodGet, "/api/users/@me", nil, http.StatusOK, &me)
	require.Equal(t, "alice", me.Username)

	anon := env.Anon()
	anon.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
	anon.Fail(http.MethodPost, "/api/auth/register", reg("ALICE"), http.StatusConflict, "USERNAME_TAKEN")
	anon.Fail(http.MethodPost, "/api/auth/login", login("alice", "wrong"), http.StatusUnauthorized, "INVALID_CREDENTIALS")
	anon.Fail(http.MethodPost, "/api/auth/login", login("ghost", "password123"), http.StatusUnauthorized, "INVALID_CREDENTIALS")

	var res auth.AuthResult
	anon.Do(http.MethodPost, "/api/auth/login", login("alice", "password123"), http.StatusOK, &res)
	require.NotEmpty(t, res.Token)
	second := env.Anon()
	second.Token = res.Token

	var sessions []auth.Session
	second.Do(http.MethodGet, "/api/sessions", nil, http.StatusOK, &sessions)
	require.Len(t, sessions, 2)
	current := 0
	for _, s := range sessions {
		if s.Current {
			current++
		}
	}
	require.Equal(t, 1, current)

	second.Do(http.MethodPost, "/api/auth/logout", nil, http.StatusNoContent, nil)
	second.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
	alice.Do(http.MethodGet, "/api/users/@me", nil, http.StatusOK, nil) // other sessions survive
}

func TestRevokeOtherSession(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var res auth.AuthResult
	env.Anon().Do(http.MethodPost, "/api/auth/login", login("alice", "password123"), http.StatusOK, &res)

	var sessions []auth.Session
	alice.Do(http.MethodGet, "/api/sessions", nil, http.StatusOK, &sessions)
	var other string
	for _, s := range sessions {
		if !s.Current {
			other = s.ID.String()
		}
	}
	alice.Do(http.MethodDelete, "/api/sessions/"+other, nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodDelete, "/api/sessions/"+other, nil, http.StatusNotFound, "NOT_FOUND")

	revoked := env.Anon()
	revoked.Token = res.Token
	revoked.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
}

func TestValidation(t *testing.T) {
	env := apptest.New(t)
	bad := reg("alice")
	bad["password"] = "short"
	env.Anon().Fail(http.MethodPost, "/api/auth/register", bad, http.StatusBadRequest, "VALIDATION_FAILED")
	env.Anon().Fail(http.MethodPost, "/api/auth/register", reg("no spaces"), http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestUpdateMe(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var me auth.User
	alice.Do(http.MethodPatch, "/api/users/@me", map[string]any{"display_name": "Alice A."}, http.StatusOK, &me)
	require.Equal(t, "Alice A.", me.DisplayName)
}

func TestWebCookieAndCSRF(t *testing.T) {
	env := apptest.New(t)
	env.Register("alice")

	var res auth.AuthResult
	resp := env.Anon().Do(http.MethodPost, "/api/auth/login",
		map[string]any{"login": "alice", "password": "password123", "device_name": "browser", "client": "web"},
		http.StatusOK, &res)
	require.Empty(t, res.Token, "web clients get a cookie, not a token")
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == auth.CookieName {
			cookie = c
		}
	}
	require.NotNil(t, cookie)
	require.True(t, cookie.HttpOnly)
	require.True(t, cookie.Secure)
	require.Equal(t, http.SameSiteLaxMode, cookie.SameSite)

	web := env.Anon()
	web.Header.Set("Cookie", auth.CookieName+"="+cookie.Value)
	web.Do(http.MethodGet, "/api/users/@me", nil, http.StatusOK, nil)
	web.Fail(http.MethodPatch, "/api/users/@me", map[string]any{"display_name": "Al"}, http.StatusForbidden, "CSRF_FAILED")
	web.Header.Set(auth.CSRFHeader, "1")
	web.Do(http.MethodPatch, "/api/users/@me", map[string]any{"display_name": "Al"}, http.StatusOK, nil)
}

func TestRegistrationModes(t *testing.T) {
	env := apptest.New(t)
	env.SetRegistrationMode(auth.ModeAdminOnly)
	first := env.Register("admin") // the first user can always register
	require.True(t, first.User.IsAdmin)

	env.Anon().Fail(http.MethodPost, "/api/auth/register", reg("bob"), http.StatusForbidden, "REGISTRATION_CLOSED")
	env.SetRegistrationMode(auth.ModeInviteOnly)
	env.Anon().Fail(http.MethodPost, "/api/auth/register", reg("bob"), http.StatusForbidden, "INVITE_REQUIRED")
	// Registering with an invite is tested with communities (Task 8).

	var info auth.InstanceInfo
	env.Anon().Do(http.MethodGet, "/api/instance", nil, http.StatusOK, &info)
	require.Equal(t, auth.ModeInviteOnly, info.RegistrationMode)
	require.True(t, info.HasUsers)
}

func TestLoginRateLimit(t *testing.T) {
	env := apptest.New(t)
	env.Register("alice")
	for i := 0; i < 5; i++ {
		env.Anon().Fail(http.MethodPost, "/api/auth/login", login("alice", "wrong"), http.StatusUnauthorized, "INVALID_CREDENTIALS")
	}
	env.Anon().Fail(http.MethodPost, "/api/auth/login", login("alice", "password123"), http.StatusTooManyRequests, "RATE_LIMITED")
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/ratelimit/ ./internal/auth/`
Expected: FAIL — build errors (`undefined: ratelimit.New`, `env.Register` …).

- [ ] **Step 3: Implement `server/internal/ratelimit/ratelimit.go`**

```go
// Package ratelimit keeps one token bucket per key (an IP, an account…).
package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type Limiter struct {
	mu    sync.Mutex
	limit rate.Limit
	burst int
	m     map[string]*entry
}

type entry struct {
	l    *rate.Limiter
	seen time.Time
}

// New allows perMinute events per key per minute, in bursts of up to burst.
func New(perMinute, burst int) *Limiter {
	return &Limiter{limit: rate.Limit(float64(perMinute) / 60), burst: burst, m: map[string]*entry{}}
}

func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.m) > 10000 { // forget idle keys so the map cannot grow forever
		for k, e := range l.m {
			if now.Sub(e.seen) > 10*time.Minute {
				delete(l.m, k)
			}
		}
	}
	e := l.m[key]
	if e == nil {
		e = &entry{l: rate.NewLimiter(l.limit, l.burst)}
		l.m[key] = e
	}
	e.seen = now
	return e.l.Allow()
}
```

Run: `cd server && go get golang.org/x/time/rate`

- [ ] **Step 4: Implement `server/internal/auth/service.go`**

```go
package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/ratelimit"
)

const (
	CookieName = "datrope_session"
	CSRFHeader = "X-Datrope-CSRF"
)

var ErrInvalidSession = errors.New("invalid session")

// Invites lets registration use community invites. The communities
// package implements it.
type Invites interface {
	// Check returns an *httpx.Error if the invite cannot be used.
	Check(ctx context.Context, code string) error
	// Redeem joins userID to the invite's community.
	Redeem(ctx context.Context, code string, userID id.ID) error
}

// Principal is the signed-in user of a request.
type Principal struct {
	User      *User
	SessionID id.ID
	ViaCookie bool
}

type ctxKey struct{}

// Current returns the signed-in user. It is non-nil inside every operation
// registered with Security: httpx.Authed.
func Current(ctx context.Context) *Principal {
	p, _ := ctx.Value(ctxKey{}).(*Principal)
	return p
}

type Service struct {
	store        *Store
	bus          *events.Bus
	invites      Invites
	loginByIP    *ratelimit.Limiter
	loginByName  *ratelimit.Limiter
	registerByIP *ratelimit.Limiter
}

func NewService(pool *pgxpool.Pool, bus *events.Bus) *Service {
	return &Service{
		store:        NewStore(pool),
		bus:          bus,
		loginByIP:    ratelimit.New(10, 10),
		loginByName:  ratelimit.New(5, 5),
		registerByIP: ratelimit.New(5, 5),
	}
}

func (s *Service) SetInvites(i Invites) { s.invites = i }

// Authenticate resolves a session token.
func (s *Service) Authenticate(ctx context.Context, token string) (*Principal, error) {
	if token == "" {
		return nil, ErrInvalidSession
	}
	sess, u, err := s.store.SessionByTokenHash(ctx, HashToken(token))
	if errors.Is(err, ErrNotFound) {
		return nil, ErrInvalidSession
	}
	if err != nil {
		return nil, err
	}
	if u.Disabled {
		return nil, ErrInvalidSession
	}
	if err := s.store.TouchSession(ctx, sess.ID); err != nil {
		return nil, err
	}
	return &Principal{User: u, SessionID: sess.ID}, nil
}

func (s *Service) PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]PublicUser, error) {
	return s.store.PublicUsers(ctx, ids)
}

func (s *Service) Settings(ctx context.Context) (Settings, error) { return s.store.Settings(ctx) }

// Middleware authenticates operations registered with Security: httpx.Authed.
// Native clients send a bearer token. Browsers send the session cookie, and
// must add the CSRF header to anything that changes state.
func (s *Service) Middleware(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		if len(ctx.Operation().Security) == 0 {
			next(ctx)
			return
		}
		token, viaCookie := strings.TrimPrefix(ctx.Header("Authorization"), "Bearer "), false
		if ctx.Header("Authorization") == "" {
			token, viaCookie = cookieValue(ctx.Header("Cookie")), true
		}
		p, err := s.Authenticate(ctx.Context(), token)
		if errors.Is(err, ErrInvalidSession) {
			httpx.WriteError(api, ctx, httpx.Unauthorized())
			return
		}
		if err != nil {
			rid := httpx.RequestIDFrom(ctx.Context())
			slog.ErrorContext(ctx.Context(), "authenticate", "request_id", rid, "err", err)
			httpx.WriteError(api, ctx, &httpx.Error{Status: http.StatusInternalServerError, Code: "INTERNAL",
				Message: "internal error", Details: map[string]any{"request_id": rid}})
			return
		}
		if viaCookie && !safeMethod(ctx.Method()) && ctx.Header(CSRFHeader) != "1" {
			httpx.WriteError(api, ctx, httpx.E(http.StatusForbidden, "CSRF_FAILED", "missing "+CSRFHeader+" header"))
			return
		}
		p.ViaCookie = viaCookie
		next(huma.WithValue(ctx, ctxKey{}, p))
	}
}

func cookieValue(header string) string {
	cookies, err := http.ParseCookie(header)
	if err != nil {
		return ""
	}
	for _, c := range cookies {
		if c.Name == CookieName {
			return c.Value
		}
	}
	return ""
}

func safeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// revokeAll signs the user out everywhere and drops their WebSockets.
func (s *Service) revokeAll(ctx context.Context, userID id.ID) error {
	if _, err := s.store.DeleteSessions(ctx, userID); err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: events.SessionsRevoked, Data: events.SessionsRevokedData{UserID: userID}})
	return nil
}

func (s *Service) revokeOne(userID, sessionID id.ID) {
	s.bus.Publish(events.Event{Type: events.SessionsRevoked,
		Data: events.SessionsRevokedData{UserID: userID, SessionIDs: []id.ID{sessionID}}})
}
```

- [ ] **Step 5: Implement `server/internal/auth/handlers.go`**

```go
package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type RegisterRequest struct {
	Username   string  `json:"username" minLength:"2" maxLength:"32" pattern:"^[A-Za-z0-9_.-]+$"`
	Email      *string `json:"email,omitempty" format:"email" maxLength:"254"`
	Password   string  `json:"password" minLength:"8" maxLength:"256"`
	InviteCode string  `json:"invite_code,omitempty" maxLength:"64"`
	DeviceName string  `json:"device_name" minLength:"1" maxLength:"64"`
	Client     string  `json:"client" enum:"web,native"`
}

type LoginRequest struct {
	Login      string `json:"login" minLength:"1" maxLength:"254" doc:"Username or email"`
	Password   string `json:"password" minLength:"1" maxLength:"256"`
	DeviceName string `json:"device_name" minLength:"1" maxLength:"64"`
	Client     string `json:"client" enum:"web,native"`
}

type AuthResult struct {
	User  *User  `json:"user"`
	Token string `json:"token,omitempty" doc:"Session token for native clients. Web clients get a cookie instead."`
}

type authOutput struct {
	SetCookie []http.Cookie `header:"Set-Cookie"`
	Body      AuthResult
}

type InstanceInfo struct {
	RegistrationMode string `json:"registration_mode" enum:"invite_only,open,admin_only"`
	HasUsers         bool   `json:"has_users" doc:"False until the first (admin) account exists"`
}

type UpdateMeRequest struct {
	DisplayName string `json:"display_name" minLength:"1" maxLength:"32"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"auth"}
	huma.Register(api, huma.Operation{OperationID: "register", Method: http.MethodPost, Path: "/api/auth/register", Tags: tags},
		func(ctx context.Context, in *struct{ Body RegisterRequest }) (*authOutput, error) {
			return s.register(ctx, in.Body)
		})
	huma.Register(api, huma.Operation{OperationID: "login", Method: http.MethodPost, Path: "/api/auth/login", Tags: tags},
		func(ctx context.Context, in *struct{ Body LoginRequest }) (*authOutput, error) {
			return s.login(ctx, in.Body)
		})
	huma.Register(api, huma.Operation{OperationID: "logout", Method: http.MethodPost, Path: "/api/auth/logout",
		Tags: tags, Security: httpx.Authed, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, _ *struct{}) (*struct {
			SetCookie []http.Cookie `header:"Set-Cookie"`
		}, error) {
			p := Current(ctx)
			if _, err := s.store.DeleteSession(ctx, p.User.ID, p.SessionID); err != nil {
				return nil, err
			}
			s.revokeOne(p.User.ID, p.SessionID)
			out := &struct {
				SetCookie []http.Cookie `header:"Set-Cookie"`
			}{}
			if p.ViaCookie { // expire the cookie
				out.SetCookie = []http.Cookie{{Name: CookieName, Value: "", Path: "/", MaxAge: -1,
					HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode}}
			}
			return out, nil
		})
	huma.Register(api, huma.Operation{OperationID: "get-instance", Method: http.MethodGet, Path: "/api/instance", Tags: tags},
		func(ctx context.Context, _ *struct{}) (*struct{ Body InstanceInfo }, error) {
			set, err := s.store.Settings(ctx)
			if err != nil {
				return nil, err
			}
			n, err := s.store.CountUsers(ctx)
			if err != nil {
				return nil, err
			}
			return &struct{ Body InstanceInfo }{InstanceInfo{RegistrationMode: set.RegistrationMode, HasUsers: n > 0}}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "get-me", Method: http.MethodGet, Path: "/api/users/@me",
		Tags: []string{"users"}, Security: httpx.Authed},
		func(ctx context.Context, _ *struct{}) (*struct{ Body *User }, error) {
			return &struct{ Body *User }{Current(ctx).User}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "update-me", Method: http.MethodPatch, Path: "/api/users/@me",
		Tags: []string{"users"}, Security: httpx.Authed},
		func(ctx context.Context, in *struct{ Body UpdateMeRequest }) (*struct{ Body *User }, error) {
			u, err := s.store.UpdateDisplayName(ctx, Current(ctx).User.ID, strings.TrimSpace(in.Body.DisplayName))
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "USER_UPDATE", Data: u.Public(),
				Scope: events.Scope{CoMembersOf: u.ID, UserIDs: []id.ID{u.ID}}})
			return &struct{ Body *User }{u}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "list-sessions", Method: http.MethodGet, Path: "/api/sessions",
		Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Session }, error) {
			p := Current(ctx)
			list, err := s.store.ListSessions(ctx, p.User.ID)
			if err != nil {
				return nil, err
			}
			for i := range list {
				list[i].Current = list[i].ID == p.SessionID
			}
			return &struct{ Body []Session }{list}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "delete-session", Method: http.MethodDelete, Path: "/api/sessions/{id}",
		Tags: tags, Security: httpx.Authed, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			sid, err := httpx.ParseID(in.ID, "session")
			if err != nil {
				return nil, err
			}
			p := Current(ctx)
			ok, err := s.store.DeleteSession(ctx, p.User.ID, sid)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, httpx.NotFound("session")
			}
			s.revokeOne(p.User.ID, sid)
			return nil, nil
		})
	registerAdmin(api, s)
}

func (s *Service) register(ctx context.Context, b RegisterRequest) (*authOutput, error) {
	if !s.registerByIP.Allow(httpx.ClientIPFrom(ctx)) {
		return nil, httpx.RateLimited()
	}
	set, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}
	n, err := s.store.CountUsers(ctx)
	if err != nil {
		return nil, err
	}
	if n > 0 { // the first user can always register and becomes the admin
		switch set.RegistrationMode {
		case ModeAdminOnly:
			return nil, httpx.E(http.StatusForbidden, "REGISTRATION_CLOSED", "registration is closed on this instance")
		case ModeInviteOnly:
			if b.InviteCode == "" || s.invites == nil {
				return nil, httpx.E(http.StatusForbidden, "INVITE_REQUIRED", "an invite code is required to register")
			}
			if err := s.invites.Check(ctx, b.InviteCode); err != nil {
				return nil, err
			}
		}
	}
	u, err := s.createUser(ctx, b.Username, b.Email, b.Username, b.Password)
	if err != nil {
		return nil, err
	}
	if b.InviteCode != "" && s.invites != nil {
		// The account exists now; failing to join (e.g. the invite was used
		// up a moment ago) should not fail the sign-up.
		if err := s.invites.Redeem(ctx, b.InviteCode, u.ID); err != nil {
			slog.WarnContext(ctx, "redeem invite after registration", "user_id", u.ID, "err", err)
		}
	}
	return s.startSession(ctx, u, b.DeviceName, b.Client)
}

func (s *Service) createUser(ctx context.Context, username string, email *string, displayName, password string) (*User, error) {
	hash, err := HashPassword(password)
	if err != nil {
		return nil, err
	}
	if email != nil {
		e := strings.TrimSpace(*email)
		email = &e
	}
	u := &User{ID: id.New(), Username: username, Email: email, DisplayName: displayName, PasswordHash: hash}
	if err := s.store.CreateUser(ctx, u); err != nil {
		if errors.Is(err, ErrTaken) {
			return nil, httpx.E(http.StatusConflict, "USERNAME_TAKEN", "username or email is already in use")
		}
		return nil, err
	}
	return u, nil
}

func (s *Service) login(ctx context.Context, b LoginRequest) (*authOutput, error) {
	if !s.loginByIP.Allow(httpx.ClientIPFrom(ctx)) || !s.loginByName.Allow(strings.ToLower(b.Login)) {
		return nil, httpx.RateLimited()
	}
	invalid := httpx.E(http.StatusUnauthorized, "INVALID_CREDENTIALS", "wrong username or password")
	u, err := s.store.UserByLogin(ctx, b.Login)
	if errors.Is(err, ErrNotFound) {
		_, _ = VerifyPassword(b.Password, dummyHash()) // equalise timing
		return nil, invalid
	}
	if err != nil {
		return nil, err
	}
	ok, err := VerifyPassword(b.Password, u.PasswordHash)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, invalid
	}
	if u.Disabled {
		return nil, httpx.E(http.StatusForbidden, "ACCOUNT_DISABLED", "this account has been disabled")
	}
	return s.startSession(ctx, u, b.DeviceName, b.Client)
}

func (s *Service) startSession(ctx context.Context, u *User, device, client string) (*authOutput, error) {
	token, hash, err := NewToken()
	if err != nil {
		return nil, err
	}
	sess := &Session{ID: id.New(), UserID: u.ID, TokenHash: hash, DeviceName: device}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return nil, err
	}
	out := &authOutput{Body: AuthResult{User: u}}
	if client == "web" {
		out.SetCookie = []http.Cookie{sessionCookie(token, 400*24*time.Hour)}
	} else {
		out.Body.Token = token
	}
	return out, nil
}

func sessionCookie(value string, maxAge time.Duration) http.Cookie {
	return http.Cookie{
		Name: CookieName, Value: value, Path: "/", MaxAge: int(maxAge.Seconds()),
		HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	}
}
```

`registerAdmin` is created in Task 6. Until then, add a stub at the bottom of `handlers.go` so the package compiles, and remove it in Task 6:

```go
func registerAdmin(huma.API, *Service) {} // replaced in Task 6
```

- [ ] **Step 6: Wire auth into the app** — `server/internal/app/app.go`

Replace the line `// Services are added here by later tasks.` with:

```go
	authSvc := auth.NewService(pool, a.Bus)
	api.UseMiddleware(authSvc.Middleware(api)) // must come before any huma.Register
	auth.Register(api, authSvc)
```

and add the import `"github.com/datrope/datrope/server/internal/auth"`.

- [ ] **Step 7: Extend apptest** — `server/internal/apptest/apptest.go`

Add the import `"context"` and `"github.com/datrope/datrope/server/internal/auth"`. Add a `User` field to `Client`:

```go
type Client struct {
	env    *Env
	Token  string      // sent as a bearer token when set
	Header http.Header // extra headers for every request
	User   *auth.User  // set by Register
}
```

In `NewWithConfig`, after creating `srv` and before `return`, open registration:

```go
	env := &Env{T: t, App: a, Pool: pool, Server: srv}
	// Tests create users freely; tests about registration modes change this.
	env.SetRegistrationMode(auth.ModeOpen)
	return env
```

(replacing the old `return &Env{...}` line), and add:

```go
func (e *Env) SetRegistrationMode(mode string) {
	e.T.Helper()
	_, err := e.Pool.Exec(context.Background(), `UPDATE instance_settings SET registration_mode = $1`, mode)
	require.NoError(e.T, err)
}

// Register signs up a user with password "password123" and returns a
// client signed in as them.
func (e *Env) Register(username string) *Client {
	e.T.Helper()
	c := e.Anon()
	var res auth.AuthResult
	c.Do(http.MethodPost, "/api/auth/register", map[string]any{
		"username": username, "password": "password123", "device_name": "test", "client": "native",
	}, http.StatusOK, &res)
	c.Token, c.User = res.Token, res.User
	return c
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd server && go test ./...`
Expected: all `ok`.

- [ ] **Step 9: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(server): registration, login, sessions, auth middleware`

---

### Task 6: Instance administration

Admin-only endpoints: instance settings, listing and creating users, resetting passwords, and disabling accounts (which revokes all sessions — interpretation 1).

**Files:**
- Create: `server/internal/auth/admin.go`
- Modify: `server/internal/auth/handlers.go` (delete the `registerAdmin` stub)
- Test: `server/internal/auth/admin_test.go`

**Interfaces:**
- Consumes: Task 5 `Service`, `Current`, `createUser`, `revokeAll`, `store`.
- Produces endpoints (all require `is_admin`; others get 403 `MISSING_PERMISSION`):
  - `GET /api/admin/settings` → `Settings`; `PATCH /api/admin/settings` body `{registration_mode?, allow_community_creation?}` → `Settings`
  - `GET /api/admin/users` → `[]User`
  - `POST /api/admin/users` body `{username, password, email?, display_name?}` → `User` (201)
  - `PUT /api/admin/users/{id}/password` body `{password}` → 204, revokes all of that user's sessions
  - `PUT /api/admin/users/{id}/disabled` body `{disabled}` → `User`; disabling revokes all sessions; 400 `CANNOT_DISABLE_SELF`

- [ ] **Step 1: Write the failing test** — `server/internal/auth/admin_test.go`

```go
package auth_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
)

func TestAdminOnly(t *testing.T) {
	env := apptest.New(t)
	env.Register("admin")
	bob := env.Register("bob")
	bob.Fail(http.MethodGet, "/api/admin/settings", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodGet, "/api/admin/users", nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestAdminSettings(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	var set auth.Settings
	admin.Do(http.MethodPatch, "/api/admin/settings",
		map[string]any{"registration_mode": "admin_only", "allow_community_creation": false}, http.StatusOK, &set)
	require.Equal(t, auth.Settings{RegistrationMode: auth.ModeAdminOnly, AllowCommunityCreation: false}, set)

	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"allow_community_creation": true}, http.StatusOK, &set)
	require.Equal(t, auth.ModeAdminOnly, set.RegistrationMode, "omitted fields are unchanged")
	require.True(t, set.AllowCommunityCreation)
}

func TestAdminCreatesUserAndResetsPassword(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	env.SetRegistrationMode(auth.ModeAdminOnly)

	var u auth.User
	admin.Do(http.MethodPost, "/api/admin/users",
		map[string]any{"username": "carol", "password": "initial-pass"}, http.StatusCreated, &u)
	require.Equal(t, "carol", u.DisplayName)

	var res auth.AuthResult
	env.Anon().Do(http.MethodPost, "/api/auth/login", login("carol", "initial-pass"), http.StatusOK, &res)
	carol := env.Anon()
	carol.Token = res.Token

	admin.Do(http.MethodPut, "/api/admin/users/"+u.ID.String()+"/password",
		map[string]any{"password": "new-password"}, http.StatusNoContent, nil)
	carol.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
	env.Anon().Do(http.MethodPost, "/api/auth/login", login("carol", "new-password"), http.StatusOK, nil)

	var users []auth.User
	admin.Do(http.MethodGet, "/api/admin/users", nil, http.StatusOK, &users)
	require.Len(t, users, 2)
}

func TestAdminDisablesUser(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	bob := env.Register("bob")

	var u auth.User
	admin.Do(http.MethodPut, "/api/admin/users/"+bob.User.ID.String()+"/disabled",
		map[string]any{"disabled": true}, http.StatusOK, &u)
	require.True(t, u.Disabled)
	bob.Fail(http.MethodGet, "/api/users/@me", nil, http.StatusUnauthorized, "UNAUTHORIZED")
	env.Anon().Fail(http.MethodPost, "/api/auth/login", login("bob", "password123"), http.StatusForbidden, "ACCOUNT_DISABLED")

	admin.Do(http.MethodPut, "/api/admin/users/"+bob.User.ID.String()+"/disabled",
		map[string]any{"disabled": false}, http.StatusOK, &u)
	env.Anon().Do(http.MethodPost, "/api/auth/login", login("bob", "password123"), http.StatusOK, nil)

	admin.Fail(http.MethodPut, "/api/admin/users/"+admin.User.ID.String()+"/disabled",
		map[string]any{"disabled": true}, http.StatusBadRequest, "CANNOT_DISABLE_SELF")
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/auth/ -run Admin`
Expected: FAIL — 404 responses (routes don't exist).

- [ ] **Step 3: Implement `server/internal/auth/admin.go`** and delete the `registerAdmin` stub from `handlers.go`.

```go
package auth

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/httpx"
)

type UpdateSettingsRequest struct {
	RegistrationMode       *string `json:"registration_mode,omitempty" enum:"invite_only,open,admin_only"`
	AllowCommunityCreation *bool   `json:"allow_community_creation,omitempty"`
}

type CreateUserRequest struct {
	Username    string  `json:"username" minLength:"2" maxLength:"32" pattern:"^[A-Za-z0-9_.-]+$"`
	Password    string  `json:"password" minLength:"8" maxLength:"256"`
	Email       *string `json:"email,omitempty" format:"email" maxLength:"254"`
	DisplayName string  `json:"display_name,omitempty" maxLength:"32"`
}

type userPath struct {
	ID string `path:"id"`
}

func requireAdmin(ctx context.Context) (*Principal, error) {
	p := Current(ctx)
	if !p.User.IsAdmin {
		return nil, httpx.MissingPermission()
	}
	return p, nil
}

func registerAdmin(api huma.API, s *Service) {
	tags := []string{"admin"}
	huma.Register(api, huma.Operation{OperationID: "admin-get-settings", Method: http.MethodGet,
		Path: "/api/admin/settings", Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, _ *struct{}) (*struct{ Body Settings }, error) {
			if _, err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			set, err := s.store.Settings(ctx)
			return &struct{ Body Settings }{set}, err
		})
	huma.Register(api, huma.Operation{OperationID: "admin-update-settings", Method: http.MethodPatch,
		Path: "/api/admin/settings", Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, in *struct{ Body UpdateSettingsRequest }) (*struct{ Body Settings }, error) {
			if _, err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			set, err := s.store.Settings(ctx)
			if err != nil {
				return nil, err
			}
			if in.Body.RegistrationMode != nil {
				set.RegistrationMode = *in.Body.RegistrationMode
			}
			if in.Body.AllowCommunityCreation != nil {
				set.AllowCommunityCreation = *in.Body.AllowCommunityCreation
			}
			if err := s.store.UpdateSettings(ctx, set); err != nil {
				return nil, err
			}
			return &struct{ Body Settings }{set}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "admin-list-users", Method: http.MethodGet,
		Path: "/api/admin/users", Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, _ *struct{}) (*struct{ Body []User }, error) {
			if _, err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			users, err := s.store.ListUsers(ctx)
			return &struct{ Body []User }{users}, err
		})
	huma.Register(api, huma.Operation{OperationID: "admin-create-user", Method: http.MethodPost,
		Path: "/api/admin/users", Tags: tags, Security: httpx.Authed, DefaultStatus: http.StatusCreated},
		func(ctx context.Context, in *struct{ Body CreateUserRequest }) (*struct{ Body *User }, error) {
			if _, err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			b := in.Body
			display := b.DisplayName
			if display == "" {
				display = b.Username
			}
			u, err := s.createUser(ctx, b.Username, b.Email, display, b.Password)
			return &struct{ Body *User }{u}, err
		})
	huma.Register(api, huma.Operation{OperationID: "admin-reset-password", Method: http.MethodPut,
		Path: "/api/admin/users/{id}/password", Tags: tags, Security: httpx.Authed, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *struct {
			userPath
			Body struct {
				Password string `json:"password" minLength:"8" maxLength:"256"`
			}
		}) (*struct{}, error) {
			if _, err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			uid, err := httpx.ParseID(in.ID, "user")
			if err != nil {
				return nil, err
			}
			hash, err := HashPassword(in.Body.Password)
			if err != nil {
				return nil, err
			}
			if err := s.store.SetPassword(ctx, uid, hash); err != nil {
				return nil, notFoundOr(err)
			}
			return nil, s.revokeAll(ctx, uid)
		})
	huma.Register(api, huma.Operation{OperationID: "admin-set-disabled", Method: http.MethodPut,
		Path: "/api/admin/users/{id}/disabled", Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, in *struct {
			userPath
			Body struct {
				Disabled bool `json:"disabled"`
			}
		}) (*struct{ Body *User }, error) {
			p, err := requireAdmin(ctx)
			if err != nil {
				return nil, err
			}
			uid, err := httpx.ParseID(in.ID, "user")
			if err != nil {
				return nil, err
			}
			if uid == p.User.ID && in.Body.Disabled {
				return nil, httpx.BadRequest("CANNOT_DISABLE_SELF", "you cannot disable your own account")
			}
			if err := s.store.SetDisabled(ctx, uid, in.Body.Disabled); err != nil {
				return nil, notFoundOr(err)
			}
			if in.Body.Disabled {
				if err := s.revokeAll(ctx, uid); err != nil {
					return nil, err
				}
			}
			u, err := s.store.UserByID(ctx, uid)
			return &struct{ Body *User }{u}, err
		})
}

func notFoundOr(err error) error {
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound("user")
	}
	return err
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test ./internal/auth/`
Expected: `ok`

- [ ] **Step 5: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(server): instance admin endpoints`

---

### Task 7: Communities, invites, and membership

Creating, viewing, renaming, and deleting communities; invites (create, preview, accept, revoke); member list; leaving and kicking. Registration with an invite code now works (the `auth.Invites` hook).

**Files:**
- Create: `server/internal/db/migrations/00002_communities.sql`
- Create: `server/internal/communities/communities.go`
- Create: `server/internal/communities/invites.go`
- Create: `server/internal/communities/handlers.go`
- Modify: `server/internal/app/app.go` (wire communities)
- Modify: `server/internal/apptest/apptest.go` (community helpers)
- Test: `server/internal/communities/communities_test.go`

**Interfaces:**
- Consumes: `auth.Current`, `auth.User`, `auth.PublicUser`, `auth.Settings` (Tasks 3, 5); `perms.*` (Task 2); `httpx.*`, `events.*` (Task 4).
- Produces:
  - Types: `communities.Community{ID, Name, OwnerID, CreatedAt}`, `Role{ID, CommunityID, Name, Permissions perms.Perms, Position int}`, `Member{CommunityID; User auth.PublicUser; RoleIDs []id.ID (excludes @everyone); JoinedAt}`, `CommunityWithRoles{Community (embedded); Roles []Role}`, `Invite`, `InvitePreview`, `PermMember{UserID id.ID; RoleIDs []id.ID (includes @everyone); Perms perms.Member}`.
  - The `@everyone` role's ID equals the community's ID.
  - Errors: `communities.ErrNotMember`, `communities.ErrNotFound`.
  - `NewService(*pgxpool.Pool, *events.Bus, Users) *Service` where `type Users interface { PublicUsers(ctx, []id.ID) (map[id.ID]auth.PublicUser, error); Settings(ctx) (auth.Settings, error) }`.
  - `(*Service).SetChannelSeeder(ChannelSeeder)` where `type ChannelSeeder interface { SeedCommunity(ctx, pgx.Tx, communityID id.ID) error }` (implemented by channels, Task 9).
  - Read API for other packages: `ListForUser(ctx, userID) ([]Community, error)`, `Roles(ctx, communityID) ([]Role, error)`, `Members(ctx, communityID) ([]Member, error)`, `PermMember(ctx, communityID, userID) (PermMember, error)`, `PermMembers(ctx, communityID) ([]PermMember, error)`, `MemberIDs(ctx, communityID) ([]id.ID, error)`, `CoMemberIDs(ctx, userID) ([]id.ID, error)`, `SharesCommunity(ctx, a, b id.ID) (bool, error)`, `HasRole(ctx, communityID, roleID id.ID) (bool, error)`.
  - `auth.Invites` implementation: `Check(ctx, code) error`, `Redeem(ctx, code, userID) error`.
  - `communities.Register(huma.API, *Service)`.
  - Endpoints: `POST /api/communities`, `GET|PATCH|DELETE /api/communities/{id}`, `GET /api/communities/{id}/members`, `DELETE /api/communities/{id}/members/{userID}` (`@me` = leave), `POST|GET /api/communities/{id}/invites`, `GET|DELETE /api/invites/{code}`, `POST /api/invites/{code}/accept`.
  - Events: `COMMUNITY_CREATE` (`CommunityWithRoles`, to the creator/joiner), `COMMUNITY_UPDATE` (`Community`), `COMMUNITY_DELETE` (`{id}`), `MEMBER_ADD` (`Member`), `MEMBER_REMOVE` (`{community_id, user_id}`, also sent to the removed user).
  - apptest: `(*Client).CreateCommunity(name) communities.CommunityWithRoles`, `(*Client).Invite(communityID id.ID) string`, `(*Client).Join(code string)`, `(*Client).JoinCommunity(owner *Client, communityID id.ID)`.

Error codes introduced: `COMMUNITY_CREATION_DISABLED` 403, `INVITE_INVALID` 404, `BANNED` 403, `OWNER_CANNOT_LEAVE` 400.

- [ ] **Step 1: Write the migration** — `server/internal/db/migrations/00002_communities.sql`

```sql
-- +goose Up
CREATE TABLE communities (
    id         BIGINT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   BIGINT NOT NULL REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The @everyone role has the same ID as its community.
CREATE TABLE roles (
    id           BIGINT PRIMARY KEY,
    community_id BIGINT NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    permissions  BIGINT NOT NULL,
    position     INT NOT NULL DEFAULT 0
);
CREATE INDEX roles_community_idx ON roles (community_id);

CREATE TABLE members (
    community_id BIGINT NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, user_id)
);
CREATE INDEX members_user_idx ON members (user_id);

CREATE TABLE member_roles (
    community_id BIGINT NOT NULL,
    user_id      BIGINT NOT NULL,
    role_id      BIGINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    PRIMARY KEY (community_id, user_id, role_id),
    FOREIGN KEY (community_id, user_id) REFERENCES members (community_id, user_id) ON DELETE CASCADE
);

CREATE TABLE bans (
    community_id BIGINT NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    reason       TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, user_id)
);

CREATE TABLE invites (
    code         TEXT PRIMARY KEY,
    community_id BIGINT NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    creator_id   BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    max_uses     INT,          -- NULL = unlimited
    uses         INT NOT NULL DEFAULT 0,
    expires_at   TIMESTAMPTZ,  -- NULL = never
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invites_community_idx ON invites (community_id);

-- +goose Down
DROP TABLE invites;
DROP TABLE bans;
DROP TABLE member_roles;
DROP TABLE members;
DROP TABLE roles;
DROP TABLE communities;
```

- [ ] **Step 2: Add the apptest helpers** — append to `server/internal/apptest/apptest.go`

Add imports `"github.com/datrope/datrope/server/internal/communities"` and `"github.com/datrope/datrope/server/internal/id"`.

```go
// CreateCommunity creates a community owned by c.
func (c *Client) CreateCommunity(name string) communities.CommunityWithRoles {
	c.env.T.Helper()
	var out communities.CommunityWithRoles
	c.Do(http.MethodPost, "/api/communities", map[string]any{"name": name}, http.StatusCreated, &out)
	return out
}

// Invite creates an unlimited invite to a community and returns its code.
func (c *Client) Invite(communityID id.ID) string {
	c.env.T.Helper()
	var inv communities.Invite
	c.Do(http.MethodPost, "/api/communities/"+communityID.String()+"/invites", map[string]any{}, http.StatusCreated, &inv)
	return inv.Code
}

func (c *Client) Join(code string) {
	c.env.T.Helper()
	c.Do(http.MethodPost, "/api/invites/"+code+"/accept", nil, http.StatusOK, nil)
}

// JoinCommunity makes c a member using an invite created by owner.
func (c *Client) JoinCommunity(owner *Client, communityID id.ID) {
	c.env.T.Helper()
	c.Join(owner.Invite(communityID))
}
```

- [ ] **Step 3: Write the failing test** — `server/internal/communities/communities_test.go`

```go
package communities_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestCreateAndGet(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	c := alice.CreateCommunity("Friends")
	require.Equal(t, alice.User.ID, c.OwnerID)
	require.Len(t, c.Roles, 1)
	require.Equal(t, c.ID, c.Roles[0].ID, "@everyone has the community's ID")
	require.Equal(t, perms.Default, c.Roles[0].Permissions)

	var got communities.CommunityWithRoles
	alice.Do(http.MethodGet, "/api/communities/"+c.ID.String(), nil, http.StatusOK, &got)
	require.Equal(t, "Friends", got.Name)

	bob := env.Register("bob")
	bob.Fail(http.MethodGet, "/api/communities/"+c.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
}

func TestCommunityCreationCanBeDisabled(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	bob := env.Register("bob")
	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"allow_community_creation": false}, http.StatusOK, nil)
	bob.Fail(http.MethodPost, "/api/communities", map[string]any{"name": "x"}, http.StatusForbidden, "COMMUNITY_CREATION_DISABLED")
	admin.CreateCommunity("admins can still create")
}

func TestInvitesAndMembers(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	c := alice.CreateCommunity("Friends")

	var inv communities.Invite
	alice.Do(http.MethodPost, "/api/communities/"+c.ID.String()+"/invites", map[string]any{"max_uses": 1}, http.StatusCreated, &inv)

	var invites []communities.Invite
	alice.Do(http.MethodGet, "/api/communities/"+c.ID.String()+"/invites", nil, http.StatusOK, &invites)
	require.Len(t, invites, 1)
	require.Equal(t, 0, invites[0].Uses)

	var preview communities.InvitePreview
	env.Anon().Do(http.MethodGet, "/api/invites/"+inv.Code, nil, http.StatusOK, &preview)
	require.Equal(t, "Friends", preview.CommunityName)
	require.Equal(t, 1, preview.MemberCount)

	bob.Join(inv.Code)
	carol.Fail(http.MethodPost, "/api/invites/"+inv.Code+"/accept", nil, http.StatusNotFound, "INVITE_INVALID")

	var members []communities.Member
	bob.Do(http.MethodGet, "/api/communities/"+c.ID.String()+"/members", nil, http.StatusOK, &members)
	require.Len(t, members, 2)
	require.Equal(t, "bob", members[1].User.Username)
	require.Empty(t, members[1].RoleIDs)

	alice.Do(http.MethodGet, "/api/communities/"+c.ID.String()+"/invites", nil, http.StatusOK, &invites)
	require.Empty(t, invites, "used-up invites are not listed")
	bob.Fail(http.MethodGet, "/api/communities/"+c.ID.String()+"/invites", nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestInviteExpiryAndRevoke(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Friends")

	expiring := alice.Invite(c.ID)
	_, err := env.Pool.Exec(context.Background(), `UPDATE invites SET expires_at = now() - interval '1 second' WHERE code = $1`, expiring)
	require.NoError(t, err)
	bob.Fail(http.MethodPost, "/api/invites/"+expiring+"/accept", nil, http.StatusNotFound, "INVITE_INVALID")

	revoked := alice.Invite(c.ID)
	alice.Do(http.MethodDelete, "/api/invites/"+revoked, nil, http.StatusNoContent, nil)
	env.Anon().Fail(http.MethodGet, "/api/invites/"+revoked, nil, http.StatusNotFound, "INVITE_INVALID")
}

func TestRegisterWithInvite(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	c := alice.CreateCommunity("Friends")
	code := alice.Invite(c.ID)
	env.SetRegistrationMode(auth.ModeInviteOnly)

	var res auth.AuthResult
	env.Anon().Do(http.MethodPost, "/api/auth/register", map[string]any{
		"username": "dave", "password": "password123", "device_name": "test", "client": "native", "invite_code": code,
	}, http.StatusOK, &res)
	dave := env.Anon()
	dave.Token = res.Token
	dave.Do(http.MethodGet, "/api/communities/"+c.ID.String(), nil, http.StatusOK, nil)

	env.Anon().Fail(http.MethodPost, "/api/auth/register", map[string]any{
		"username": "eve", "password": "password123", "device_name": "test", "client": "native", "invite_code": "nope",
	}, http.StatusNotFound, "INVITE_INVALID")
}

func TestLeaveAndKick(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Friends")
	base := "/api/communities/" + c.ID.String()

	bob.JoinCommunity(alice, c.ID)
	bob.Do(http.MethodDelete, base+"/members/@me", nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodGet, base, nil, http.StatusNotFound, "NOT_FOUND")
	alice.Fail(http.MethodDelete, base+"/members/@me", nil, http.StatusBadRequest, "OWNER_CANNOT_LEAVE")

	bob.JoinCommunity(alice, c.ID)
	bob.Fail(http.MethodDelete, base+"/members/"+alice.User.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Do(http.MethodDelete, base+"/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodGet, base, nil, http.StatusNotFound, "NOT_FOUND")
	alice.Fail(http.MethodDelete, base+"/members/"+bob.User.ID.String(), nil, http.StatusNotFound, "NOT_FOUND")
}

func TestRenameAndDelete(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Friends")
	base := "/api/communities/" + c.ID.String()
	bob.JoinCommunity(alice, c.ID)

	bob.Fail(http.MethodPatch, base, map[string]any{"name": "Mine"}, http.StatusForbidden, "MISSING_PERMISSION")
	var got communities.Community
	alice.Do(http.MethodPatch, base, map[string]any{"name": "Best Friends"}, http.StatusOK, &got)
	require.Equal(t, "Best Friends", got.Name)

	bob.Fail(http.MethodDelete, base, nil, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Do(http.MethodDelete, base, nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodGet, base, nil, http.StatusNotFound, "NOT_FOUND")
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd server && go test ./internal/communities/`
Expected: FAIL — build errors (`communities` package doesn't exist).

- [ ] **Step 5: Implement `server/internal/communities/communities.go`**

```go
// Package communities owns communities, roles, members, bans, and invites.
package communities

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

var (
	ErrNotMember = errors.New("not a member")
	ErrNotFound  = errors.New("community not found")
)

// Users is what this package needs from auth.
type Users interface {
	PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]auth.PublicUser, error)
	Settings(ctx context.Context) (auth.Settings, error)
}

// ChannelSeeder creates a new community's default channels inside the
// community's creation transaction. The channels package implements it.
type ChannelSeeder interface {
	SeedCommunity(ctx context.Context, tx pgx.Tx, communityID id.ID) error
}

type Community struct {
	ID        id.ID     `json:"id"`
	Name      string    `json:"name"`
	OwnerID   id.ID     `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
}

type Role struct {
	ID          id.ID       `json:"id"`
	CommunityID id.ID       `json:"community_id"`
	Name        string      `json:"name"`
	Permissions perms.Perms `json:"permissions"`
	Position    int         `json:"position"`
}

type Member struct {
	CommunityID id.ID           `json:"community_id"`
	User        auth.PublicUser `json:"user"`
	RoleIDs     []id.ID         `json:"role_ids" doc:"Excludes @everyone, which every member holds"`
	JoinedAt    time.Time       `json:"joined_at"`
}

type CommunityWithRoles struct {
	Community
	Roles []Role `json:"roles"`
}

// PermMember is a member as the permission calculation sees them.
type PermMember struct {
	UserID  id.ID
	RoleIDs []id.ID // includes @everyone (== the community ID)
	Perms   perms.Member
}

type MemberRemoved struct {
	CommunityID id.ID `json:"community_id"`
	UserID      id.ID `json:"user_id"`
}

type CommunityDeleted struct {
	ID id.ID `json:"id"`
}

type Service struct {
	db     *pgxpool.Pool
	bus    *events.Bus
	users  Users
	seeder ChannelSeeder
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, users Users) *Service {
	return &Service{db: pool, bus: bus, users: users}
}

func (s *Service) SetChannelSeeder(c ChannelSeeder) { s.seeder = c }

func (s *Service) create(ctx context.Context, ownerID id.ID, name string) (*CommunityWithRoles, error) {
	c := Community{ID: id.New(), Name: name, OwnerID: ownerID}
	everyone := Role{ID: c.ID, CommunityID: c.ID, Name: "@everyone", Permissions: perms.Default}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `INSERT INTO communities (id, name, owner_id) VALUES ($1, $2, $3) RETURNING created_at`,
		c.ID, c.Name, c.OwnerID).Scan(&c.CreatedAt); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO roles (id, community_id, name, permissions, position) VALUES ($1, $1, $2, $3, 0)`,
		everyone.ID, everyone.Name, int64(everyone.Permissions)); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO members (community_id, user_id) VALUES ($1, $2)`, c.ID, ownerID); err != nil {
		return nil, err
	}
	if s.seeder != nil {
		if err := s.seeder.SeedCommunity(ctx, tx, c.ID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	out := &CommunityWithRoles{Community: c, Roles: []Role{everyone}}
	s.bus.Publish(events.Event{Type: "COMMUNITY_CREATE", Data: out, Scope: events.Scope{UserIDs: []id.ID{ownerID}}})
	return out, nil
}

func (s *Service) get(ctx context.Context, communityID id.ID) (*Community, error) {
	var c Community
	err := s.db.QueryRow(ctx, `SELECT id, name, owner_id, created_at FROM communities WHERE id = $1`, communityID).
		Scan(&c.ID, &c.Name, &c.OwnerID, &c.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &c, err
}

func (s *Service) withRoles(ctx context.Context, communityID id.ID) (*CommunityWithRoles, error) {
	c, err := s.get(ctx, communityID)
	if err != nil {
		return nil, err
	}
	roles, err := s.Roles(ctx, communityID)
	if err != nil {
		return nil, err
	}
	return &CommunityWithRoles{Community: *c, Roles: roles}, nil
}

// ListForUser returns the communities userID belongs to, in join order.
func (s *Service) ListForUser(ctx context.Context, userID id.ID) ([]Community, error) {
	rows, err := s.db.Query(ctx, `
		SELECT c.id, c.name, c.owner_id, c.created_at
		FROM communities c JOIN members m ON m.community_id = c.id
		WHERE m.user_id = $1 ORDER BY m.joined_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Community{}
	for rows.Next() {
		var c Community
		if err := rows.Scan(&c.ID, &c.Name, &c.OwnerID, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Service) Roles(ctx context.Context, communityID id.ID) ([]Role, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, community_id, name, permissions, position FROM roles
		WHERE community_id = $1 ORDER BY position, id`, communityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Role{}
	for rows.Next() {
		r, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func scanRole(row pgx.Row) (*Role, error) {
	var r Role
	var p int64
	if err := row.Scan(&r.ID, &r.CommunityID, &r.Name, &p, &r.Position); err != nil {
		return nil, err
	}
	r.Permissions = perms.Perms(p)
	return &r, nil
}

func (s *Service) Members(ctx context.Context, communityID id.ID) ([]Member, error) {
	return s.members(ctx, communityID, nil)
}

func (s *Service) member(ctx context.Context, communityID, userID id.ID) (*Member, error) {
	ms, err := s.members(ctx, communityID, &userID)
	if err != nil {
		return nil, err
	}
	if len(ms) == 0 {
		return nil, ErrNotMember
	}
	return &ms[0], nil
}

func (s *Service) members(ctx context.Context, communityID id.ID, only *id.ID) ([]Member, error) {
	rows, err := s.db.Query(ctx, `
		SELECT m.user_id, m.joined_at,
		       COALESCE(array_agg(mr.role_id ORDER BY mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}')
		FROM members m
		LEFT JOIN member_roles mr ON mr.community_id = m.community_id AND mr.user_id = m.user_id
		WHERE m.community_id = $1 AND ($2::bigint IS NULL OR m.user_id = $2)
		GROUP BY m.user_id, m.joined_at
		ORDER BY m.joined_at, m.user_id`, communityID, only)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Member{}
	var ids []id.ID
	for rows.Next() {
		m := Member{CommunityID: communityID, RoleIDs: []id.ID{}}
		var roles []int64
		if err := rows.Scan(&m.User.ID, &m.JoinedAt, &roles); err != nil {
			return nil, err
		}
		for _, r := range roles {
			m.RoleIDs = append(m.RoleIDs, id.ID(r))
		}
		ids = append(ids, m.User.ID)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	users, err := s.users.PublicUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].User = users[out[i].User.ID]
	}
	return out, nil
}

// PermMember returns ErrNotMember if userID is not in the community (or it
// does not exist).
func (s *Service) PermMember(ctx context.Context, communityID, userID id.ID) (PermMember, error) {
	ms, err := s.permMembers(ctx, communityID, &userID)
	if err != nil {
		return PermMember{}, err
	}
	if len(ms) == 0 {
		return PermMember{}, ErrNotMember
	}
	return ms[0], nil
}

func (s *Service) PermMembers(ctx context.Context, communityID id.ID) ([]PermMember, error) {
	return s.permMembers(ctx, communityID, nil)
}

func (s *Service) permMembers(ctx context.Context, communityID id.ID, only *id.ID) ([]PermMember, error) {
	c, err := s.get(ctx, communityID)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	roles, err := s.Roles(ctx, communityID)
	if err != nil {
		return nil, err
	}
	mask := make(map[id.ID]perms.Perms, len(roles))
	for _, r := range roles {
		mask[r.ID] = r.Permissions
	}
	rows, err := s.db.Query(ctx, `
		SELECT m.user_id, COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}')
		FROM members m
		LEFT JOIN member_roles mr ON mr.community_id = m.community_id AND mr.user_id = m.user_id
		WHERE m.community_id = $1 AND ($2::bigint IS NULL OR m.user_id = $2)
		GROUP BY m.user_id`, communityID, only)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PermMember{}
	for rows.Next() {
		var uid id.ID
		var roleIDs []int64
		if err := rows.Scan(&uid, &roleIDs); err != nil {
			return nil, err
		}
		pm := PermMember{
			UserID:  uid,
			RoleIDs: []id.ID{communityID},
			Perms:   perms.Member{IsOwner: uid == c.OwnerID, Roles: []perms.Perms{mask[communityID]}},
		}
		for _, r := range roleIDs {
			pm.RoleIDs = append(pm.RoleIDs, id.ID(r))
			pm.Perms.Roles = append(pm.Perms.Roles, mask[id.ID(r)])
		}
		out = append(out, pm)
	}
	return out, rows.Err()
}

func (s *Service) MemberIDs(ctx context.Context, communityID id.ID) ([]id.ID, error) {
	rows, err := s.db.Query(ctx, `SELECT user_id FROM members WHERE community_id = $1`, communityID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}

// CoMemberIDs returns everyone who shares at least one community with
// userID, including userID if they are in any community.
func (s *Service) CoMemberIDs(ctx context.Context, userID id.ID) ([]id.ID, error) {
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT b.user_id FROM members a JOIN members b ON a.community_id = b.community_id
		WHERE a.user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}

func (s *Service) SharesCommunity(ctx context.Context, a, b id.ID) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM members x JOIN members y ON x.community_id = y.community_id
		               WHERE x.user_id = $1 AND y.user_id = $2)`, a, b).Scan(&ok)
	return ok, err
}

func (s *Service) HasRole(ctx context.Context, communityID, roleID id.ID) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM roles WHERE id = $1 AND community_id = $2)`,
		roleID, communityID).Scan(&ok)
	return ok, err
}

// removeMember deletes a membership and reports whether it existed.
func (s *Service) removeMember(ctx context.Context, communityID, userID id.ID) (bool, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM members WHERE community_id = $1 AND user_id = $2`, communityID, userID)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	s.publishMemberRemoved(communityID, userID)
	return true, nil
}

func (s *Service) publishMemberRemoved(communityID, userID id.ID) {
	s.bus.Publish(events.Event{Type: "MEMBER_REMOVE", Data: MemberRemoved{CommunityID: communityID, UserID: userID},
		Scope: events.Scope{CommunityID: communityID, UserIDs: []id.ID{userID}}})
}
```

- [ ] **Step 6: Implement `server/internal/communities/invites.go`**

```go
package communities

import (
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type Invite struct {
	Code        string     `json:"code"`
	CommunityID id.ID      `json:"community_id"`
	CreatorID   id.ID      `json:"creator_id"`
	MaxUses     *int       `json:"max_uses,omitempty"`
	Uses        int        `json:"uses"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

type InvitePreview struct {
	Code          string `json:"code"`
	CommunityID   id.ID  `json:"community_id"`
	CommunityName string `json:"community_name"`
	MemberCount   int    `json:"member_count"`
}

const inviteUsable = `(max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > now())`

func errInviteInvalid() *httpx.Error {
	return httpx.E(http.StatusNotFound, "INVITE_INVALID", "this invite is invalid or has expired")
}

func (s *Service) createInvite(ctx context.Context, communityID, creatorID id.ID, maxUses, expiresIn *int) (*Invite, error) {
	inv := Invite{Code: rand.Text()[:10], CommunityID: communityID, CreatorID: creatorID, MaxUses: maxUses}
	if expiresIn != nil {
		t := time.Now().Add(time.Duration(*expiresIn) * time.Second)
		inv.ExpiresAt = &t
	}
	err := s.db.QueryRow(ctx, `
		INSERT INTO invites (code, community_id, creator_id, max_uses, expires_at) VALUES ($1, $2, $3, $4, $5)
		RETURNING created_at`, inv.Code, inv.CommunityID, inv.CreatorID, inv.MaxUses, inv.ExpiresAt).Scan(&inv.CreatedAt)
	return &inv, err
}

func (s *Service) listInvites(ctx context.Context, communityID id.ID) ([]Invite, error) {
	rows, err := s.db.Query(ctx, `
		SELECT code, community_id, creator_id, max_uses, uses, expires_at, created_at FROM invites
		WHERE community_id = $1 AND `+inviteUsable+` ORDER BY created_at`, communityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invite{}
	for rows.Next() {
		var i Invite
		if err := rows.Scan(&i.Code, &i.CommunityID, &i.CreatorID, &i.MaxUses, &i.Uses, &i.ExpiresAt, &i.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (s *Service) invite(ctx context.Context, code string) (*Invite, error) {
	var i Invite
	err := s.db.QueryRow(ctx, `
		SELECT code, community_id, creator_id, max_uses, uses, expires_at, created_at FROM invites
		WHERE code = $1 AND `+inviteUsable, code).
		Scan(&i.Code, &i.CommunityID, &i.CreatorID, &i.MaxUses, &i.Uses, &i.ExpiresAt, &i.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errInviteInvalid()
	}
	return &i, err
}

func (s *Service) preview(ctx context.Context, code string) (*InvitePreview, error) {
	var p InvitePreview
	err := s.db.QueryRow(ctx, `
		SELECT i.code, c.id, c.name, (SELECT count(*) FROM members m WHERE m.community_id = c.id)
		FROM invites i JOIN communities c ON c.id = i.community_id
		WHERE i.code = $1 AND `+inviteUsable, code).Scan(&p.Code, &p.CommunityID, &p.CommunityName, &p.MemberCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errInviteInvalid()
	}
	return &p, err
}

// Check implements auth.Invites.
func (s *Service) Check(ctx context.Context, code string) error {
	_, err := s.invite(ctx, code)
	return err
}

// Redeem implements auth.Invites.
func (s *Service) Redeem(ctx context.Context, code string, userID id.ID) error {
	_, err := s.join(ctx, code, userID)
	return err
}

// join adds userID to the invite's community. Joining a community you are
// already in succeeds without using up the invite.
func (s *Service) join(ctx context.Context, code string, userID id.ID) (*CommunityWithRoles, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var communityID id.ID
	err = tx.QueryRow(ctx, `SELECT community_id FROM invites WHERE code = $1 AND `+inviteUsable+` FOR UPDATE`, code).
		Scan(&communityID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errInviteInvalid()
	}
	if err != nil {
		return nil, err
	}
	var banned, member bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM bans WHERE community_id = $1 AND user_id = $2),
		       EXISTS (SELECT 1 FROM members WHERE community_id = $1 AND user_id = $2)`,
		communityID, userID).Scan(&banned, &member); err != nil {
		return nil, err
	}
	if banned {
		return nil, httpx.E(http.StatusForbidden, "BANNED", "you are banned from this community")
	}
	if !member {
		if _, err := tx.Exec(ctx, `UPDATE invites SET uses = uses + 1 WHERE code = $1`, code); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO members (community_id, user_id) VALUES ($1, $2)`, communityID, userID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	out, err := s.withRoles(ctx, communityID)
	if err != nil {
		return nil, err
	}
	if !member {
		m, err := s.member(ctx, communityID, userID)
		if err != nil {
			return nil, err
		}
		s.bus.Publish(events.Event{Type: "MEMBER_ADD", Data: m, Scope: events.Scope{CommunityID: communityID}})
		s.bus.Publish(events.Event{Type: "COMMUNITY_CREATE", Data: out, Scope: events.Scope{UserIDs: []id.ID{userID}}})
	}
	return out, nil
}

func (s *Service) deleteInvite(ctx context.Context, code string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM invites WHERE code = $1`, code)
	return err
}
```

- [ ] **Step 7: Implement `server/internal/communities/handlers.go`**

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

type NameRequest struct {
	Name string `json:"name" minLength:"1" maxLength:"100"`
}

type CreateInviteRequest struct {
	MaxUses          *int `json:"max_uses,omitempty" minimum:"1" maximum:"1000"`
	ExpiresInSeconds *int `json:"expires_in_seconds,omitempty" minimum:"60" maximum:"2592000"`
}

type communityPath struct {
	ID string `path:"id"`
}

type memberPath struct {
	ID     string `path:"id"`
	UserID string `path:"userID" doc:"A user ID, or @me"`
}

type codePath struct {
	Code string `path:"code"`
}

// actor is the caller's standing in a community.
type actor struct {
	CommunityID id.ID
	Member      PermMember
	Base        perms.Perms
}

// requireActor checks that the caller is a member with the needed
// community-level permissions. Non-members get 404 so that private
// communities' existence is not revealed.
func (s *Service) requireActor(ctx context.Context, rawCommunityID string, need perms.Perms) (actor, error) {
	cid, err := httpx.ParseID(rawCommunityID, "community")
	if err != nil {
		return actor{}, err
	}
	m, err := s.PermMember(ctx, cid, auth.Current(ctx).User.ID)
	if errors.Is(err, ErrNotMember) {
		return actor{}, httpx.NotFound("community")
	}
	if err != nil {
		return actor{}, err
	}
	base := perms.Base(m.Perms)
	if !base.Has(need) {
		return actor{}, httpx.MissingPermission()
	}
	return actor{CommunityID: cid, Member: m, Base: base}, nil
}

func Register(api huma.API, s *Service) {
	tags := []string{"communities"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}

	huma.Register(api, op("create-community", http.MethodPost, "/api/communities", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body NameRequest }) (*struct{ Body *CommunityWithRoles }, error) {
			u := auth.Current(ctx).User
			set, err := s.users.Settings(ctx)
			if err != nil {
				return nil, err
			}
			if !set.AllowCommunityCreation && !u.IsAdmin {
				return nil, httpx.E(http.StatusForbidden, "COMMUNITY_CREATION_DISABLED", "only admins can create communities on this instance")
			}
			c, err := s.create(ctx, u.ID, strings.TrimSpace(in.Body.Name))
			return &struct{ Body *CommunityWithRoles }{c}, err
		})

	huma.Register(api, op("get-community", http.MethodGet, "/api/communities/{id}", 0),
		func(ctx context.Context, in *communityPath) (*struct{ Body *CommunityWithRoles }, error) {
			a, err := s.requireActor(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			c, err := s.withRoles(ctx, a.CommunityID)
			return &struct{ Body *CommunityWithRoles }{c}, err
		})

	huma.Register(api, op("update-community", http.MethodPatch, "/api/communities/{id}", 0),
		func(ctx context.Context, in *struct {
			communityPath
			Body NameRequest
		}) (*struct{ Body *Community }, error) {
			a, err := s.requireActor(ctx, in.ID, perms.ManageCommunity)
			if err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(ctx, `UPDATE communities SET name = $2 WHERE id = $1`,
				a.CommunityID, strings.TrimSpace(in.Body.Name)); err != nil {
				return nil, err
			}
			c, err := s.get(ctx, a.CommunityID)
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "COMMUNITY_UPDATE", Data: c, Scope: events.Scope{CommunityID: c.ID}})
			return &struct{ Body *Community }{c}, nil
		})

	huma.Register(api, op("delete-community", http.MethodDelete, "/api/communities/{id}", http.StatusNoContent),
		func(ctx context.Context, in *communityPath) (*struct{}, error) {
			a, err := s.requireActor(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			if !a.Member.Perms.IsOwner {
				return nil, httpx.MissingPermission()
			}
			memberIDs, err := s.MemberIDs(ctx, a.CommunityID)
			if err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(ctx, `DELETE FROM communities WHERE id = $1`, a.CommunityID); err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "COMMUNITY_DELETE", Data: CommunityDeleted{ID: a.CommunityID},
				Scope: events.Scope{UserIDs: memberIDs}})
			return nil, nil
		})

	huma.Register(api, op("list-members", http.MethodGet, "/api/communities/{id}/members", 0),
		func(ctx context.Context, in *communityPath) (*struct{ Body []Member }, error) {
			a, err := s.requireActor(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			ms, err := s.Members(ctx, a.CommunityID)
			return &struct{ Body []Member }{ms}, err
		})

	huma.Register(api, op("remove-member", http.MethodDelete, "/api/communities/{id}/members/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *memberPath) (*struct{}, error) {
			me := auth.Current(ctx).User.ID
			if in.UserID == "@me" || in.UserID == me.String() {
				a, err := s.requireActor(ctx, in.ID, 0)
				if err != nil {
					return nil, err
				}
				if a.Member.Perms.IsOwner {
					return nil, httpx.BadRequest("OWNER_CANNOT_LEAVE", "the owner cannot leave; delete the community instead")
				}
				_, err = s.removeMember(ctx, a.CommunityID, me)
				return nil, err
			}
			a, err := s.requireActor(ctx, in.ID, perms.Kick)
			if err != nil {
				return nil, err
			}
			target, err := httpx.ParseID(in.UserID, "member")
			if err != nil {
				return nil, err
			}
			c, err := s.get(ctx, a.CommunityID)
			if err != nil {
				return nil, err
			}
			if target == c.OwnerID {
				return nil, httpx.MissingPermission()
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

	huma.Register(api, op("create-invite", http.MethodPost, "/api/communities/{id}/invites", http.StatusCreated),
		func(ctx context.Context, in *struct {
			communityPath
			Body CreateInviteRequest
		}) (*struct{ Body *Invite }, error) {
			a, err := s.requireActor(ctx, in.ID, perms.CreateInvite)
			if err != nil {
				return nil, err
			}
			inv, err := s.createInvite(ctx, a.CommunityID, auth.Current(ctx).User.ID, in.Body.MaxUses, in.Body.ExpiresInSeconds)
			return &struct{ Body *Invite }{inv}, err
		})

	huma.Register(api, op("list-invites", http.MethodGet, "/api/communities/{id}/invites", 0),
		func(ctx context.Context, in *communityPath) (*struct{ Body []Invite }, error) {
			a, err := s.requireActor(ctx, in.ID, perms.ManageCommunity)
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

	huma.Register(api, op("accept-invite", http.MethodPost, "/api/invites/{code}/accept", 0),
		func(ctx context.Context, in *codePath) (*struct{ Body *CommunityWithRoles }, error) {
			c, err := s.join(ctx, in.Code, auth.Current(ctx).User.ID)
			return &struct{ Body *CommunityWithRoles }{c}, err
		})

	huma.Register(api, op("delete-invite", http.MethodDelete, "/api/invites/{code}", http.StatusNoContent),
		func(ctx context.Context, in *codePath) (*struct{}, error) {
			inv, err := s.invite(ctx, in.Code)
			if err != nil {
				return nil, err
			}
			me := auth.Current(ctx).User.ID
			if inv.CreatorID != me {
				if _, err := s.requireActor(ctx, inv.CommunityID.String(), perms.ManageCommunity); err != nil {
					return nil, err
				}
			}
			return nil, s.deleteInvite(ctx, in.Code)
		})

	registerRoles(api, s, op)
}
```

`registerRoles` comes in Task 8. Add this stub at the bottom of `handlers.go` for now:

```go
func registerRoles(huma.API, *Service, func(string, string, string, int) huma.Operation) {} // replaced in Task 8
```

- [ ] **Step 8: Wire communities into the app** — `server/internal/app/app.go`

After the auth block add:

```go
	commSvc := communities.NewService(pool, a.Bus, authSvc)
	authSvc.SetInvites(commSvc)
	communities.Register(api, commSvc)
```

and the import `"github.com/datrope/datrope/server/internal/communities"`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd server && go test ./...`
Expected: all `ok`.

- [ ] **Step 10: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(server): communities, invites, membership`

---

### Task 8: Roles and bans

Role CRUD and assignment with the no-self-escalation rule (interpretation 2), and community bans.

**Files:**
- Create: `server/internal/communities/roles.go`
- Modify: `server/internal/communities/handlers.go` (delete the `registerRoles` stub)
- Test: `server/internal/communities/roles_test.go`

**Interfaces:**
- Consumes: Task 7 `Service`, `actor`, `requireActor`, `Role`, `scanRole`, `member`, `publishMemberRemoved`.
- Produces endpoints:
  - `POST /api/communities/{id}/roles` `{name, permissions}` → `Role` (201)
  - `PATCH /api/communities/{id}/roles/{roleID}` `{name?, permissions?, position?}` → `Role`
  - `DELETE /api/communities/{id}/roles/{roleID}` → 204
  - `PUT|DELETE /api/communities/{id}/members/{userID}/roles/{roleID}` → 204
  - `GET /api/communities/{id}/bans` → `[]Ban`; `PUT /api/communities/{id}/bans/{userID}` `{reason?}` → 204; `DELETE /api/communities/{id}/bans/{userID}` → 204
- Types: `communities.Ban{User auth.PublicUser; Reason string; CreatedAt time.Time}`, `communities.RoleDeleted{CommunityID, ID}`.
- Events: `ROLE_CREATE`/`ROLE_UPDATE` (`Role`), `ROLE_DELETE` (`RoleDeleted`), `MEMBER_UPDATE` (`Member`), `MEMBER_REMOVE` on ban.
- Rule: every role mutation requires `MANAGE_ROLES` **and** that the caller's base permissions include the role's current and new permission bits.

Error codes introduced: `CANNOT_RENAME_EVERYONE`, `CANNOT_DELETE_EVERYONE`, `CANNOT_ASSIGN_EVERYONE`, `CANNOT_BAN_SELF` (all 400).

- [ ] **Step 1: Write the failing test** — `server/internal/communities/roles_test.go`

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

func TestRoles(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	c := alice.CreateCommunity("Friends")
	base := "/api/communities/" + c.ID.String()
	bob.JoinCommunity(alice, c.ID)
	carol.JoinCommunity(alice, c.ID)

	bob.Fail(http.MethodPost, base+"/roles", map[string]any{"name": "x", "permissions": 0}, http.StatusForbidden, "MISSING_PERMISSION")

	var mods communities.Role
	alice.Do(http.MethodPost, base+"/roles",
		map[string]any{"name": "Mods", "permissions": uint64(perms.Kick | perms.ManageRoles)}, http.StatusCreated, &mods)
	require.Equal(t, 1, mods.Position)
	alice.Do(http.MethodPut, base+"/members/"+bob.User.ID.String()+"/roles/"+mods.ID.String(), nil, http.StatusNoContent, nil)

	var members []communities.Member
	alice.Do(http.MethodGet, base+"/members", nil, http.StatusOK, &members)
	for _, m := range members {
		if m.User.ID == bob.User.ID {
			require.Len(t, m.RoleIDs, 1)
			require.Equal(t, mods.ID, m.RoleIDs[0])
		}
	}

	// Bob can now kick, and manage roles — but only with permissions he holds.
	bob.Fail(http.MethodPost, base+"/roles", map[string]any{"name": "Banners", "permissions": uint64(perms.Ban)},
		http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodPost, base+"/roles", map[string]any{"name": "Kickers", "permissions": uint64(perms.Kick)},
		http.StatusCreated, nil)
	bob.Fail(http.MethodPatch, base+"/roles/"+c.ID.String(), map[string]any{"permissions": uint64(perms.All)},
		http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodDelete, base+"/members/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)

	alice.Fail(http.MethodPatch, base+"/roles/"+c.ID.String(), map[string]any{"name": "everyone"},
		http.StatusBadRequest, "CANNOT_RENAME_EVERYONE")
	alice.Fail(http.MethodDelete, base+"/roles/"+c.ID.String(), nil, http.StatusBadRequest, "CANNOT_DELETE_EVERYONE")
	alice.Fail(http.MethodPut, base+"/members/"+bob.User.ID.String()+"/roles/"+c.ID.String(), nil,
		http.StatusBadRequest, "CANNOT_ASSIGN_EVERYONE")

	var updated communities.Role
	alice.Do(http.MethodPatch, base+"/roles/"+mods.ID.String(), map[string]any{"name": "Moderators"}, http.StatusOK, &updated)
	require.Equal(t, "Moderators", updated.Name)
	require.Equal(t, mods.Permissions, updated.Permissions, "omitted fields are unchanged")

	alice.Do(http.MethodDelete, base+"/roles/"+mods.ID.String(), nil, http.StatusNoContent, nil)
	carol.JoinCommunity(alice, c.ID)
	bob.Fail(http.MethodDelete, base+"/members/"+carol.User.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestUnassignRole(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Friends")
	base := "/api/communities/" + c.ID.String()
	bob.JoinCommunity(alice, c.ID)

	var r communities.Role
	alice.Do(http.MethodPost, base+"/roles", map[string]any{"name": "Kick", "permissions": uint64(perms.Kick)}, http.StatusCreated, &r)
	path := base + "/members/" + bob.User.ID.String() + "/roles/" + r.ID.String()
	alice.Do(http.MethodPut, path, nil, http.StatusNoContent, nil)
	alice.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodDelete, base+"/members/"+alice.User.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestBans(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Friends")
	base := "/api/communities/" + c.ID.String()
	bob.JoinCommunity(alice, c.ID)

	bob.Fail(http.MethodPut, base+"/bans/"+alice.User.ID.String(), map[string]any{}, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Fail(http.MethodPut, base+"/bans/"+alice.User.ID.String(), map[string]any{}, http.StatusBadRequest, "CANNOT_BAN_SELF")

	alice.Do(http.MethodPut, base+"/bans/"+bob.User.ID.String(), map[string]any{"reason": "spam"}, http.StatusNoContent, nil)
	bob.Fail(http.MethodGet, base, nil, http.StatusNotFound, "NOT_FOUND")
	code := alice.Invite(c.ID)
	bob.Fail(http.MethodPost, "/api/invites/"+code+"/accept", nil, http.StatusForbidden, "BANNED")

	var bans []communities.Ban
	alice.Do(http.MethodGet, base+"/bans", nil, http.StatusOK, &bans)
	require.Len(t, bans, 1)
	require.Equal(t, "spam", bans[0].Reason)
	require.Equal(t, bob.User.ID, bans[0].User.ID)

	alice.Do(http.MethodDelete, base+"/bans/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	bob.Join(code)
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/communities/ -run 'Roles|Unassign|Bans'`
Expected: FAIL — 404/405 responses from missing routes.

- [ ] **Step 3: Implement `server/internal/communities/roles.go`** and delete the `registerRoles` stub from `handlers.go`.

```go
package communities

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type CreateRoleRequest struct {
	Name        string      `json:"name" minLength:"1" maxLength:"32"`
	Permissions perms.Perms `json:"permissions"`
}

type UpdateRoleRequest struct {
	Name        *string      `json:"name,omitempty" minLength:"1" maxLength:"32"`
	Permissions *perms.Perms `json:"permissions,omitempty"`
	Position    *int         `json:"position,omitempty" minimum:"0"`
}

type BanRequest struct {
	Reason string `json:"reason,omitempty" maxLength:"512"`
}

type Ban struct {
	User      auth.PublicUser `json:"user"`
	Reason    string          `json:"reason"`
	CreatedAt time.Time       `json:"created_at"`
}

type RoleDeleted struct {
	CommunityID id.ID `json:"community_id"`
	ID          id.ID `json:"id"`
}

type rolePath struct {
	ID     string `path:"id"`
	RoleID string `path:"roleID"`
}

type memberRolePath struct {
	ID     string `path:"id"`
	UserID string `path:"userID"`
	RoleID string `path:"roleID"`
}

func (s *Service) role(ctx context.Context, communityID id.ID, rawRoleID string) (*Role, error) {
	rid, err := httpx.ParseID(rawRoleID, "role")
	if err != nil {
		return nil, err
	}
	r, err := scanRole(s.db.QueryRow(ctx,
		`SELECT id, community_id, name, permissions, position FROM roles WHERE id = $1 AND community_id = $2`, rid, communityID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("role")
	}
	return r, err
}

// canTouch enforces "you can only hand out permissions you have".
func canTouch(a actor, ps ...perms.Perms) error {
	for _, p := range ps {
		if !a.Base.Has(p) {
			return httpx.MissingPermission()
		}
	}
	return nil
}

func (s *Service) publishMemberUpdate(ctx context.Context, communityID, userID id.ID) error {
	m, err := s.member(ctx, communityID, userID)
	if err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "MEMBER_UPDATE", Data: m, Scope: events.Scope{CommunityID: communityID}})
	return nil
}

func registerRoles(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("create-role", http.MethodPost, "/api/communities/{id}/roles", http.StatusCreated),
		func(ctx context.Context, in *struct {
			communityPath
			Body CreateRoleRequest
		}) (*struct{ Body *Role }, error) {
			a, err := s.requireActor(ctx, in.ID, perms.ManageRoles)
			if err != nil {
				return nil, err
			}
			if err := canTouch(a, in.Body.Permissions); err != nil {
				return nil, err
			}
			r, err := scanRole(s.db.QueryRow(ctx, `
				INSERT INTO roles (id, community_id, name, permissions, position)
				VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), 0) + 1 FROM roles WHERE community_id = $2))
				RETURNING id, community_id, name, permissions, position`,
				id.New(), a.CommunityID, strings.TrimSpace(in.Body.Name), int64(in.Body.Permissions)))
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "ROLE_CREATE", Data: r, Scope: events.Scope{CommunityID: a.CommunityID}})
			return &struct{ Body *Role }{r}, nil
		})

	huma.Register(api, op("update-role", http.MethodPatch, "/api/communities/{id}/roles/{roleID}", 0),
		func(ctx context.Context, in *struct {
			rolePath
			Body UpdateRoleRequest
		}) (*struct{ Body *Role }, error) {
			a, err := s.requireActor(ctx, in.ID, perms.ManageRoles)
			if err != nil {
				return nil, err
			}
			r, err := s.role(ctx, a.CommunityID, in.RoleID)
			if err != nil {
				return nil, err
			}
			if r.ID == a.CommunityID && in.Body.Name != nil {
				return nil, httpx.BadRequest("CANNOT_RENAME_EVERYONE", "the @everyone role cannot be renamed")
			}
			var newPerms *int64
			check := []perms.Perms{r.Permissions}
			if in.Body.Permissions != nil {
				p := int64(*in.Body.Permissions)
				newPerms = &p
				check = append(check, *in.Body.Permissions)
			}
			if err := canTouch(a, check...); err != nil {
				return nil, err
			}
			updated, err := scanRole(s.db.QueryRow(ctx, `
				UPDATE roles SET name = COALESCE($3, name), permissions = COALESCE($4, permissions),
				                 position = COALESCE($5, position)
				WHERE id = $1 AND community_id = $2
				RETURNING id, community_id, name, permissions, position`,
				r.ID, a.CommunityID, in.Body.Name, newPerms, in.Body.Position))
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "ROLE_UPDATE", Data: updated, Scope: events.Scope{CommunityID: a.CommunityID}})
			return &struct{ Body *Role }{updated}, nil
		})

	huma.Register(api, op("delete-role", http.MethodDelete, "/api/communities/{id}/roles/{roleID}", http.StatusNoContent),
		func(ctx context.Context, in *rolePath) (*struct{}, error) {
			a, err := s.requireActor(ctx, in.ID, perms.ManageRoles)
			if err != nil {
				return nil, err
			}
			r, err := s.role(ctx, a.CommunityID, in.RoleID)
			if err != nil {
				return nil, err
			}
			if r.ID == a.CommunityID {
				return nil, httpx.BadRequest("CANNOT_DELETE_EVERYONE", "the @everyone role cannot be deleted")
			}
			if err := canTouch(a, r.Permissions); err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(ctx, `DELETE FROM roles WHERE id = $1`, r.ID); err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "ROLE_DELETE", Data: RoleDeleted{CommunityID: a.CommunityID, ID: r.ID},
				Scope: events.Scope{CommunityID: a.CommunityID}})
			return nil, nil
		})

	assign := func(add bool) func(context.Context, *memberRolePath) (*struct{}, error) {
		return func(ctx context.Context, in *memberRolePath) (*struct{}, error) {
			a, err := s.requireActor(ctx, in.ID, perms.ManageRoles)
			if err != nil {
				return nil, err
			}
			r, err := s.role(ctx, a.CommunityID, in.RoleID)
			if err != nil {
				return nil, err
			}
			if r.ID == a.CommunityID {
				return nil, httpx.BadRequest("CANNOT_ASSIGN_EVERYONE", "every member holds @everyone")
			}
			if err := canTouch(a, r.Permissions); err != nil {
				return nil, err
			}
			target, err := httpx.ParseID(in.UserID, "member")
			if err != nil {
				return nil, err
			}
			if _, err := s.member(ctx, a.CommunityID, target); errors.Is(err, ErrNotMember) {
				return nil, httpx.NotFound("member")
			} else if err != nil {
				return nil, err
			}
			sql := `DELETE FROM member_roles WHERE community_id = $1 AND user_id = $2 AND role_id = $3`
			if add {
				sql = `INSERT INTO member_roles (community_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`
			}
			if _, err := s.db.Exec(ctx, sql, a.CommunityID, target, r.ID); err != nil {
				return nil, err
			}
			return nil, s.publishMemberUpdate(ctx, a.CommunityID, target)
		}
	}
	huma.Register(api, op("add-member-role", http.MethodPut,
		"/api/communities/{id}/members/{userID}/roles/{roleID}", http.StatusNoContent), assign(true))
	huma.Register(api, op("remove-member-role", http.MethodDelete,
		"/api/communities/{id}/members/{userID}/roles/{roleID}", http.StatusNoContent), assign(false))

	huma.Register(api, op("list-bans", http.MethodGet, "/api/communities/{id}/bans", 0),
		func(ctx context.Context, in *communityPath) (*struct{ Body []Ban }, error) {
			a, err := s.requireActor(ctx, in.ID, perms.Ban)
			if err != nil {
				return nil, err
			}
			bans, err := s.bans(ctx, a.CommunityID)
			return &struct{ Body []Ban }{bans}, err
		})

	huma.Register(api, op("ban-member", http.MethodPut, "/api/communities/{id}/bans/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			memberPath
			Body BanRequest
		}) (*struct{}, error) {
			a, err := s.requireActor(ctx, in.ID, perms.Ban)
			if err != nil {
				return nil, err
			}
			target, err := httpx.ParseID(in.UserID, "user")
			if err != nil {
				return nil, err
			}
			if target == auth.Current(ctx).User.ID {
				return nil, httpx.BadRequest("CANNOT_BAN_SELF", "you cannot ban yourself")
			}
			c, err := s.get(ctx, a.CommunityID)
			if err != nil {
				return nil, err
			}
			if target == c.OwnerID {
				return nil, httpx.MissingPermission()
			}
			users, err := s.users.PublicUsers(ctx, []id.ID{target})
			if err != nil {
				return nil, err
			}
			if _, ok := users[target]; !ok {
				return nil, httpx.NotFound("user")
			}
			return nil, s.ban(ctx, a.CommunityID, target, in.Body.Reason)
		})

	huma.Register(api, op("unban-member", http.MethodDelete, "/api/communities/{id}/bans/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *memberPath) (*struct{}, error) {
			a, err := s.requireActor(ctx, in.ID, perms.Ban)
			if err != nil {
				return nil, err
			}
			target, err := httpx.ParseID(in.UserID, "ban")
			if err != nil {
				return nil, err
			}
			tag, err := s.db.Exec(ctx, `DELETE FROM bans WHERE community_id = $1 AND user_id = $2`, a.CommunityID, target)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, httpx.NotFound("ban")
			}
			return nil, nil
		})
}

func (s *Service) ban(ctx context.Context, communityID, userID id.ID, reason string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO bans (community_id, user_id, reason) VALUES ($1, $2, $3)
		ON CONFLICT (community_id, user_id) DO UPDATE SET reason = EXCLUDED.reason`,
		communityID, userID, reason); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM members WHERE community_id = $1 AND user_id = $2`, communityID, userID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		s.publishMemberRemoved(communityID, userID)
	}
	return nil
}

func (s *Service) bans(ctx context.Context, communityID id.ID) ([]Ban, error) {
	rows, err := s.db.Query(ctx, `SELECT user_id, reason, created_at FROM bans WHERE community_id = $1 ORDER BY created_at`, communityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Ban{}
	var ids []id.ID
	for rows.Next() {
		var b Ban
		if err := rows.Scan(&b.User.ID, &b.Reason, &b.CreatedAt); err != nil {
			return nil, err
		}
		ids = append(ids, b.User.ID)
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	users, err := s.users.PublicUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].User = users[out[i].User.ID]
	}
	return out, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test ./internal/communities/`
Expected: `ok`

- [ ] **Step 5: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(server): roles with escalation guard, community bans`

---

### Task 9: Channels, permission overrides, and DMs

Text and voice channels inside communities (voice channels exist as records now; joining them is milestone 3), per-channel overrides, the effective-permission lookup every other package uses, and DMs (2–10 users, fixed permissions).

**Files:**
- Create: `server/internal/db/migrations/00003_channels.sql`
- Create: `server/internal/channels/channels.go`
- Create: `server/internal/channels/handlers.go`
- Modify: `server/internal/app/app.go` (wire channels; set the community seeder)
- Modify: `server/internal/apptest/apptest.go` (`Channels`, `General` helpers)
- Test: `server/internal/channels/channels_test.go`

**Interfaces:**
- Consumes: `communities.PermMember`, `communities.ErrNotMember`, and the `communities.Service` methods `PermMember`, `PermMembers`, `SharesCommunity`, `HasRole` (Task 7); `perms.Effective` (Task 2).
- Produces:
  - Types: `channels.Channel{ID id.ID; CommunityID *id.ID (nil for DMs); Type string ("text"|"voice"|"dm"); Name string; Position int; Overrides []Override; Participants []auth.PublicUser (DMs only)}`, `channels.Override{TargetType ("role"|"member"); TargetID id.ID; Allow, Deny perms.Perms}`, `channels.ChannelDeleted{ID; CommunityID *id.ID}`; constants `TypeText`, `TypeVoice`, `TypeDM`; `channels.ErrNotFound`.
  - `channels.NewService(*pgxpool.Pool, *events.Bus, Communities, Users) *Service`.
  - `(*Service).SeedCommunity(ctx, pgx.Tx, communityID id.ID) error` (implements `communities.ChannelSeeder`; creates `#general`).
  - `(*Service).Perms(ctx, userID, channelID id.ID) (perms.Perms, *Channel, error)` — 0 if the user cannot see it; `ErrNotFound` if it does not exist.
  - `(*Service).Access(ctx, userID, channelID id.ID, need perms.Perms) (*Channel, perms.Perms, error)` — returns `httpx` 404 if invisible/missing, 403 if `need` is missing. **Messages (Task 10) use this.**
  - `(*Service).Viewers(ctx, channelID) ([]id.ID, error)`, `ListVisible(ctx, userID, communityID) ([]Channel, error)`, `ListDMs(ctx, userID) ([]Channel, error)`.
  - Endpoints: `GET|POST /api/communities/{id}/channels`, `PATCH|DELETE /api/channels/{id}`, `PUT|DELETE /api/channels/{id}/overrides/{targetType}/{targetID}`, `GET|POST /api/dms`.
  - Events: `CHANNEL_CREATE`/`CHANNEL_UPDATE` (`Channel`), `CHANNEL_DELETE` (`ChannelDeleted`). Override changes send `CHANNEL_UPDATE` to everyone who can see the channel afterwards and `CHANNEL_DELETE` to anyone who lost sight of it.
  - apptest: `(*Client).Channels(communityID id.ID) []channels.Channel`, `(*Client).General(communityID id.ID) id.ID`.

Error codes introduced: `NO_SHARED_COMMUNITY` 403, `INVALID_RECIPIENTS` 400.

- [ ] **Step 1: Write the migration** — `server/internal/db/migrations/00003_channels.sql`

```sql
-- +goose Up
CREATE TABLE channels (
    id           BIGINT PRIMARY KEY,
    community_id BIGINT REFERENCES communities (id) ON DELETE CASCADE, -- NULL for DMs
    type         TEXT NOT NULL CHECK (type IN ('text', 'voice', 'dm')),
    name         TEXT NOT NULL DEFAULT '',
    position     INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((type = 'dm') = (community_id IS NULL))
);
CREATE INDEX channels_community_idx ON channels (community_id);

-- target_id is a role ID (the community ID for @everyone) or a user ID.
CREATE TABLE channel_overrides (
    channel_id  BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('role', 'member')),
    target_id   BIGINT NOT NULL,
    allow       BIGINT NOT NULL DEFAULT 0,
    deny        BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, target_type, target_id)
);

CREATE TABLE dm_participants (
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX dm_participants_user_idx ON dm_participants (user_id);

-- +goose Down
DROP TABLE dm_participants;
DROP TABLE channel_overrides;
DROP TABLE channels;
```

- [ ] **Step 2: Add the apptest helpers** — append to `server/internal/apptest/apptest.go` (import `".../internal/channels"`)

```go
// Channels lists the community channels c can see.
func (c *Client) Channels(communityID id.ID) []channels.Channel {
	c.env.T.Helper()
	var out []channels.Channel
	c.Do(http.MethodGet, "/api/communities/"+communityID.String()+"/channels", nil, http.StatusOK, &out)
	return out
}

// General returns the ID of the community's default #general channel.
func (c *Client) General(communityID id.ID) id.ID {
	c.env.T.Helper()
	for _, ch := range c.Channels(communityID) {
		if ch.Name == "general" {
			return ch.ID
		}
	}
	c.env.T.Fatal("no #general channel")
	return 0
}
```

- [ ] **Step 3: Write the failing test** — `server/internal/channels/channels_test.go`

```go
package channels_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

func names(chs []channels.Channel) []string {
	out := []string{}
	for _, c := range chs {
		out = append(out, c.Name)
	}
	return out
}

func TestDefaultChannelAndCRUD(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Friends")
	bob.JoinCommunity(alice, c.ID)
	base := "/api/communities/" + c.ID.String() + "/channels"

	chs := bob.Channels(c.ID)
	require.Equal(t, []string{"general"}, names(chs))
	require.Equal(t, channels.TypeText, chs[0].Type)

	bob.Fail(http.MethodPost, base, map[string]any{"name": "x", "type": "text"}, http.StatusForbidden, "MISSING_PERMISSION")

	var voice channels.Channel
	alice.Do(http.MethodPost, base, map[string]any{"name": "hangout", "type": "voice"}, http.StatusCreated, &voice)
	require.Equal(t, 1, voice.Position)

	var renamed channels.Channel
	alice.Do(http.MethodPatch, "/api/channels/"+voice.ID.String(), map[string]any{"name": "lounge"}, http.StatusOK, &renamed)
	require.Equal(t, "lounge", renamed.Name)
	bob.Fail(http.MethodPatch, "/api/channels/"+voice.ID.String(), map[string]any{"name": "x"}, http.StatusForbidden, "MISSING_PERMISSION")

	alice.Do(http.MethodDelete, "/api/channels/"+voice.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"general"}, names(bob.Channels(c.ID)))

	outsider := env.Register("outsider")
	outsider.Fail(http.MethodGet, base, nil, http.StatusNotFound, "NOT_FOUND")
}

func TestPrivateChannel(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	c := alice.CreateCommunity("Friends")
	bob.JoinCommunity(alice, c.ID)
	carol.JoinCommunity(alice, c.ID)

	var staff channels.Channel
	alice.Do(http.MethodPost, "/api/communities/"+c.ID.String()+"/channels",
		map[string]any{"name": "staff", "type": "text"}, http.StatusCreated, &staff)
	ov := "/api/channels/" + staff.ID.String() + "/overrides/"

	// Hide it from @everyone (the @everyone role ID is the community ID).
	alice.Do(http.MethodPut, ov+"role/"+c.ID.String(), map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	require.Equal(t, []string{"general"}, names(bob.Channels(c.ID)))
	bob.Fail(http.MethodPatch, "/api/channels/"+staff.ID.String(), map[string]any{"name": "x"}, http.StatusNotFound, "NOT_FOUND")

	// A role override lets Bob see it again.
	var role communities.Role
	alice.Do(http.MethodPost, "/api/communities/"+c.ID.String()+"/roles", map[string]any{"name": "Staff", "permissions": 0}, http.StatusCreated, &role)
	alice.Do(http.MethodPut, "/api/communities/"+c.ID.String()+"/members/"+bob.User.ID.String()+"/roles/"+role.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, ov+"role/"+role.ID.String(), map[string]any{"allow": uint64(perms.ViewChannel), "deny": 0}, http.StatusOK, nil)
	require.Equal(t, []string{"general", "staff"}, names(bob.Channels(c.ID)))
	require.Equal(t, []string{"general"}, names(carol.Channels(c.ID)))

	// A member override does the same for Carol, and removing it hides it again.
	alice.Do(http.MethodPut, ov+"member/"+carol.User.ID.String(), map[string]any{"allow": uint64(perms.ViewChannel), "deny": 0}, http.StatusOK, nil)
	require.Equal(t, []string{"general", "staff"}, names(carol.Channels(c.ID)))
	alice.Do(http.MethodDelete, ov+"member/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"general"}, names(carol.Channels(c.ID)))

	alice.Fail(http.MethodPut, ov+"role/"+id.New().String(), map[string]any{"allow": 0, "deny": 0}, http.StatusNotFound, "NOT_FOUND")
}

func TestOverrideEscalation(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Friends")
	bob.JoinCommunity(alice, c.ID)
	var role communities.Role
	alice.Do(http.MethodPost, "/api/communities/"+c.ID.String()+"/roles",
		map[string]any{"name": "Perms", "permissions": uint64(perms.ManageRoles)}, http.StatusCreated, &role)
	alice.Do(http.MethodPut, "/api/communities/"+c.ID.String()+"/members/"+bob.User.ID.String()+"/roles/"+role.ID.String(), nil, http.StatusNoContent, nil)

	ov := "/api/channels/" + bob.General(c.ID).String() + "/overrides/member/" + bob.User.ID.String()
	bob.Fail(http.MethodPut, ov, map[string]any{"allow": uint64(perms.Ban), "deny": 0}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodPut, ov, map[string]any{"allow": 0, "deny": uint64(perms.Stream)}, http.StatusOK, nil)
}

func TestDMs(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	c := alice.CreateCommunity("Friends")
	bob.JoinCommunity(alice, c.ID)

	var dm channels.Channel
	alice.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{bob.User.ID.String()}}, http.StatusOK, &dm)
	require.Equal(t, channels.TypeDM, dm.Type)
	require.Nil(t, dm.CommunityID)
	require.Len(t, dm.Participants, 2)

	var again channels.Channel
	bob.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{alice.User.ID.String()}}, http.StatusOK, &again)
	require.Equal(t, dm.ID, again.ID, "a 1:1 DM is reused")

	alice.Fail(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{carol.User.ID.String()}}, http.StatusForbidden, "NO_SHARED_COMMUNITY")
	alice.Fail(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{alice.User.ID.String()}}, http.StatusBadRequest, "INVALID_RECIPIENTS")

	var list []channels.Channel
	bob.Do(http.MethodGet, "/api/dms", nil, http.StatusOK, &list)
	require.Len(t, list, 1)
	carol.Do(http.MethodGet, "/api/dms", nil, http.StatusOK, &list)
	require.Empty(t, list)
	alice.Fail(http.MethodPatch, "/api/channels/"+dm.ID.String(), map[string]any{"name": "x"}, http.StatusForbidden, "MISSING_PERMISSION")
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd server && go test ./internal/channels/`
Expected: FAIL — build errors (`channels` package doesn't exist).

- [ ] **Step 5: Implement `server/internal/channels/channels.go`**

```go
// Package channels owns channels, permission overrides, and DMs, and
// answers "what may this user do in this channel?" for everyone else.
package channels

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

const (
	TypeText  = "text"
	TypeVoice = "voice"
	TypeDM    = "dm"
)

var ErrNotFound = errors.New("channel not found")

// Communities is what this package needs from communities.
type Communities interface {
	PermMember(ctx context.Context, communityID, userID id.ID) (communities.PermMember, error)
	PermMembers(ctx context.Context, communityID id.ID) ([]communities.PermMember, error)
	SharesCommunity(ctx context.Context, a, b id.ID) (bool, error)
	HasRole(ctx context.Context, communityID, roleID id.ID) (bool, error)
}

type Users interface {
	PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]auth.PublicUser, error)
}

type Override struct {
	TargetType string      `json:"target_type" enum:"role,member"`
	TargetID   id.ID       `json:"target_id"`
	Allow      perms.Perms `json:"allow"`
	Deny       perms.Perms `json:"deny"`
}

type Channel struct {
	ID           id.ID             `json:"id"`
	CommunityID  *id.ID            `json:"community_id,omitempty" doc:"Absent for DMs"`
	Type         string            `json:"type" enum:"text,voice,dm"`
	Name         string            `json:"name"`
	Position     int               `json:"position"`
	Overrides    []Override        `json:"overrides"`
	Participants []auth.PublicUser `json:"participants,omitempty" doc:"DMs only"`
}

type ChannelDeleted struct {
	ID          id.ID  `json:"id"`
	CommunityID *id.ID `json:"community_id,omitempty"`
}

type Service struct {
	db          *pgxpool.Pool
	bus         *events.Bus
	communities Communities
	users       Users
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, c Communities, u Users) *Service {
	return &Service{db: pool, bus: bus, communities: c, users: u}
}

// SeedCommunity implements communities.ChannelSeeder.
func (s *Service) SeedCommunity(ctx context.Context, tx pgx.Tx, communityID id.ID) error {
	_, err := tx.Exec(ctx, `INSERT INTO channels (id, community_id, type, name, position) VALUES ($1, $2, 'text', 'general', 0)`,
		id.New(), communityID)
	return err
}

const channelCols = `id, community_id, type, name, position`

func scanChannel(row pgx.Row) (*Channel, error) {
	var c Channel
	var cid *int64
	if err := row.Scan(&c.ID, &cid, &c.Type, &c.Name, &c.Position); err != nil {
		return nil, err
	}
	c.CommunityID = id.FromNullable(cid)
	c.Overrides = []Override{}
	return &c, nil
}

func (s *Service) query(ctx context.Context, sql string, args ...any) ([]*Channel, error) {
	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Channel
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.loadOverrides(ctx, out); err != nil {
		return nil, err
	}
	return out, s.loadParticipants(ctx, out)
}

func (s *Service) get(ctx context.Context, channelID id.ID) (*Channel, error) {
	chs, err := s.query(ctx, `SELECT `+channelCols+` FROM channels WHERE id = $1`, channelID)
	if err != nil {
		return nil, err
	}
	if len(chs) == 0 {
		return nil, ErrNotFound
	}
	return chs[0], nil
}

func (s *Service) loadOverrides(ctx context.Context, chs []*Channel) error {
	byID := map[id.ID]*Channel{}
	var ids []id.ID
	for _, c := range chs {
		if c.Type != TypeDM {
			byID[c.ID] = c
			ids = append(ids, c.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT channel_id, target_type, target_id, allow, deny FROM channel_overrides
		WHERE channel_id = ANY($1) ORDER BY target_type, target_id`, id.Int64s(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid id.ID
		var o Override
		var allow, deny int64
		if err := rows.Scan(&cid, &o.TargetType, &o.TargetID, &allow, &deny); err != nil {
			return err
		}
		o.Allow, o.Deny = perms.Perms(allow), perms.Perms(deny)
		byID[cid].Overrides = append(byID[cid].Overrides, o)
	}
	return rows.Err()
}

func (s *Service) loadParticipants(ctx context.Context, chs []*Channel) error {
	byID := map[id.ID]*Channel{}
	var ids []id.ID
	for _, c := range chs {
		if c.Type == TypeDM {
			byID[c.ID] = c
			ids = append(ids, c.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT channel_id, user_id FROM dm_participants WHERE channel_id = ANY($1) ORDER BY user_id`,
		id.Int64s(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	type pair struct{ channel, user id.ID }
	var pairs []pair
	var userIDs []id.ID
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.channel, &p.user); err != nil {
			return err
		}
		pairs = append(pairs, p)
		userIDs = append(userIDs, p.user)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	users, err := s.users.PublicUsers(ctx, userIDs)
	if err != nil {
		return err
	}
	for _, p := range pairs {
		byID[p.channel].Participants = append(byID[p.channel].Participants, users[p.user])
	}
	return nil
}

// effective applies the channel's overrides to a community member.
func effective(m communities.PermMember, c *Channel) perms.Perms {
	held := make(map[id.ID]bool, len(m.RoleIDs))
	for _, r := range m.RoleIDs {
		held[r] = true
	}
	var pc perms.Channel
	for _, o := range c.Overrides {
		ov := perms.Override{Allow: o.Allow, Deny: o.Deny}
		switch {
		case o.TargetType == "role" && o.TargetID == *c.CommunityID:
			pc.Everyone = ov
		case o.TargetType == "role" && held[o.TargetID]:
			pc.Roles = append(pc.Roles, ov)
		case o.TargetType == "member" && o.TargetID == m.UserID:
			pc.Member = &ov
		}
	}
	return perms.Effective(m.Perms, pc)
}

func (s *Service) permsIn(ctx context.Context, userID id.ID, c *Channel) (perms.Perms, error) {
	if c.Type == TypeDM {
		for _, p := range c.Participants {
			if p.ID == userID {
				return perms.DM, nil
			}
		}
		return 0, nil
	}
	m, err := s.communities.PermMember(ctx, *c.CommunityID, userID)
	if errors.Is(err, communities.ErrNotMember) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return effective(m, c), nil
}

// Perms returns userID's permissions in a channel: zero if they cannot see
// it, ErrNotFound if it does not exist.
func (s *Service) Perms(ctx context.Context, userID, channelID id.ID) (perms.Perms, *Channel, error) {
	c, err := s.get(ctx, channelID)
	if err != nil {
		return 0, nil, err
	}
	p, err := s.permsIn(ctx, userID, c)
	return p, c, err
}

// Access loads a channel for a request. Channels the user cannot see are
// reported as missing (404); a missing `need` permission is a 403.
func (s *Service) Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*Channel, perms.Perms, error) {
	p, c, err := s.Perms(ctx, userID, channelID)
	if errors.Is(err, ErrNotFound) || (err == nil && !p.Has(perms.ViewChannel)) {
		return nil, 0, httpx.NotFound("channel")
	}
	if err != nil {
		return nil, 0, err
	}
	if !p.Has(need) {
		return nil, 0, httpx.MissingPermission()
	}
	return c, p, nil
}

// Viewers returns everyone who can see a channel.
func (s *Service) Viewers(ctx context.Context, channelID id.ID) ([]id.ID, error) {
	c, err := s.get(ctx, channelID)
	if err != nil {
		return nil, err
	}
	return s.viewersOf(ctx, c)
}

func (s *Service) viewersOf(ctx context.Context, c *Channel) ([]id.ID, error) {
	out := []id.ID{}
	if c.Type == TypeDM {
		for _, p := range c.Participants {
			out = append(out, p.ID)
		}
		return out, nil
	}
	members, err := s.communities.PermMembers(ctx, *c.CommunityID)
	if err != nil {
		return nil, err
	}
	for _, m := range members {
		if effective(m, c).Has(perms.ViewChannel) {
			out = append(out, m.UserID)
		}
	}
	return out, nil
}

// ListVisible returns the channels of a community that userID can see.
func (s *Service) ListVisible(ctx context.Context, userID, communityID id.ID) ([]Channel, error) {
	m, err := s.communities.PermMember(ctx, communityID, userID)
	if errors.Is(err, communities.ErrNotMember) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	chs, err := s.query(ctx, `SELECT `+channelCols+` FROM channels WHERE community_id = $1 ORDER BY position, id`, communityID)
	if err != nil {
		return nil, err
	}
	out := []Channel{}
	for _, c := range chs {
		if effective(m, c).Has(perms.ViewChannel) {
			out = append(out, *c)
		}
	}
	return out, nil
}

func (s *Service) ListDMs(ctx context.Context, userID id.ID) ([]Channel, error) {
	chs, err := s.query(ctx, `
		SELECT c.id, c.community_id, c.type, c.name, c.position
		FROM channels c JOIN dm_participants p ON p.channel_id = c.id
		WHERE p.user_id = $1 ORDER BY c.id DESC`, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Channel, 0, len(chs))
	for _, c := range chs {
		out = append(out, *c)
	}
	return out, nil
}

// publishVisibility tells current viewers about the channel and tells
// anyone in `before` who can no longer see it that it is gone.
func (s *Service) publishVisibility(ctx context.Context, channelID id.ID, before []id.ID) error {
	c, err := s.get(ctx, channelID)
	if err != nil {
		return err
	}
	after, err := s.viewersOf(ctx, c)
	if err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "CHANNEL_UPDATE", Data: c, Scope: events.Scope{UserIDs: after}})
	still := make(map[id.ID]bool, len(after))
	for _, u := range after {
		still[u] = true
	}
	var lost []id.ID
	for _, u := range before {
		if !still[u] {
			lost = append(lost, u)
		}
	}
	if len(lost) > 0 {
		s.bus.Publish(events.Event{Type: "CHANNEL_DELETE", Data: ChannelDeleted{ID: c.ID, CommunityID: c.CommunityID},
			Scope: events.Scope{UserIDs: lost}})
	}
	return nil
}
```

- [ ] **Step 6: Implement `server/internal/channels/handlers.go`**

```go
package channels

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type CreateChannelRequest struct {
	Name string `json:"name" minLength:"1" maxLength:"100"`
	Type string `json:"type" enum:"text,voice"`
}

type UpdateChannelRequest struct {
	Name     *string `json:"name,omitempty" minLength:"1" maxLength:"100"`
	Position *int    `json:"position,omitempty" minimum:"0"`
}

type OverrideRequest struct {
	Allow perms.Perms `json:"allow"`
	Deny  perms.Perms `json:"deny"`
}

type CreateDMRequest struct {
	RecipientIDs []id.ID `json:"recipient_ids" minItems:"1" maxItems:"9"`
}

type channelPath struct {
	ID string `path:"id"`
}

type overridePath struct {
	ID         string `path:"id"`
	TargetType string `path:"targetType" enum:"role,member"`
	TargetID   string `path:"targetID"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"channels"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	me := func(ctx context.Context) id.ID { return auth.Current(ctx).User.ID }

	huma.Register(api, op("list-channels", http.MethodGet, "/api/communities/{id}/channels", 0),
		func(ctx context.Context, in *channelPath) (*struct{ Body []Channel }, error) {
			cid, err := httpx.ParseID(in.ID, "community")
			if err != nil {
				return nil, err
			}
			chs, err := s.ListVisible(ctx, me(ctx), cid)
			if errors.Is(err, ErrNotFound) {
				return nil, httpx.NotFound("community")
			}
			return &struct{ Body []Channel }{chs}, err
		})

	huma.Register(api, op("create-channel", http.MethodPost, "/api/communities/{id}/channels", http.StatusCreated),
		func(ctx context.Context, in *struct {
			channelPath
			Body CreateChannelRequest
		}) (*struct{ Body *Channel }, error) {
			cid, err := httpx.ParseID(in.ID, "community")
			if err != nil {
				return nil, err
			}
			m, err := s.communities.PermMember(ctx, cid, me(ctx))
			if errors.Is(err, communities.ErrNotMember) {
				return nil, httpx.NotFound("community")
			}
			if err != nil {
				return nil, err
			}
			if !perms.Base(m.Perms).Has(perms.ManageChannels) {
				return nil, httpx.MissingPermission()
			}
			newID := id.New()
			if _, err := s.db.Exec(ctx, `
				INSERT INTO channels (id, community_id, type, name, position)
				VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), -1) + 1 FROM channels WHERE community_id = $2))`,
				newID, cid, in.Body.Type, strings.TrimSpace(in.Body.Name)); err != nil {
				return nil, err
			}
			c, err := s.get(ctx, newID)
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "CHANNEL_CREATE", Data: c, Scope: events.Scope{ChannelID: c.ID}})
			return &struct{ Body *Channel }{c}, nil
		})

	huma.Register(api, op("update-channel", http.MethodPatch, "/api/channels/{id}", 0),
		func(ctx context.Context, in *struct {
			channelPath
			Body UpdateChannelRequest
		}) (*struct{ Body *Channel }, error) {
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			if _, _, err := s.Access(ctx, me(ctx), chID, perms.ManageChannels); err != nil {
				return nil, err
			}
			var name *string
			if in.Body.Name != nil {
				n := strings.TrimSpace(*in.Body.Name)
				name = &n
			}
			if _, err := s.db.Exec(ctx, `UPDATE channels SET name = COALESCE($2, name), position = COALESCE($3, position) WHERE id = $1`,
				chID, name, in.Body.Position); err != nil {
				return nil, err
			}
			c, err := s.get(ctx, chID)
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "CHANNEL_UPDATE", Data: c, Scope: events.Scope{ChannelID: c.ID}})
			return &struct{ Body *Channel }{c}, nil
		})

	huma.Register(api, op("delete-channel", http.MethodDelete, "/api/channels/{id}", http.StatusNoContent),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			c, _, err := s.Access(ctx, me(ctx), chID, perms.ManageChannels)
			if err != nil {
				return nil, err
			}
			viewers, err := s.viewersOf(ctx, c)
			if err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(ctx, `DELETE FROM channels WHERE id = $1`, chID); err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "CHANNEL_DELETE", Data: ChannelDeleted{ID: c.ID, CommunityID: c.CommunityID},
				Scope: events.Scope{UserIDs: viewers}})
			return nil, nil
		})

	huma.Register(api, op("put-override", http.MethodPut, "/api/channels/{id}/overrides/{targetType}/{targetID}", 0),
		func(ctx context.Context, in *struct {
			overridePath
			Body OverrideRequest
		}) (*struct{ Body *Channel }, error) {
			c, target, before, err := s.overrideTarget(ctx, in.overridePath, in.Body.Allow|in.Body.Deny)
			if err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(ctx, `
				INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (channel_id, target_type, target_id) DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
				c.ID, in.TargetType, target, int64(in.Body.Allow), int64(in.Body.Deny)); err != nil {
				return nil, err
			}
			if err := s.publishVisibility(ctx, c.ID, before); err != nil {
				return nil, err
			}
			updated, err := s.get(ctx, c.ID)
			return &struct{ Body *Channel }{updated}, err
		})

	huma.Register(api, op("delete-override", http.MethodDelete, "/api/channels/{id}/overrides/{targetType}/{targetID}", http.StatusNoContent),
		func(ctx context.Context, in *overridePath) (*struct{}, error) {
			c, target, before, err := s.overrideTarget(ctx, *in, 0)
			if err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(ctx, `DELETE FROM channel_overrides WHERE channel_id = $1 AND target_type = $2 AND target_id = $3`,
				c.ID, in.TargetType, target); err != nil {
				return nil, err
			}
			return nil, s.publishVisibility(ctx, c.ID, before)
		})

	huma.Register(api, op("list-dms", http.MethodGet, "/api/dms", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Channel }, error) {
			chs, err := s.ListDMs(ctx, me(ctx))
			return &struct{ Body []Channel }{chs}, err
		})

	huma.Register(api, op("create-dm", http.MethodPost, "/api/dms", 0),
		func(ctx context.Context, in *struct{ Body CreateDMRequest }) (*struct{ Body *Channel }, error) {
			c, err := s.createDM(ctx, me(ctx), in.Body.RecipientIDs)
			return &struct{ Body *Channel }{c}, err
		})
}

// overrideTarget checks the caller may edit overrides on this channel with
// the given bits, validates the target, and returns the current viewers.
func (s *Service) overrideTarget(ctx context.Context, in overridePath, bits perms.Perms) (*Channel, id.ID, []id.ID, error) {
	chID, err := httpx.ParseID(in.ID, "channel")
	if err != nil {
		return nil, 0, nil, err
	}
	c, have, err := s.Access(ctx, auth.Current(ctx).User.ID, chID, perms.ManageRoles)
	if err != nil {
		return nil, 0, nil, err
	}
	if !have.Has(bits) { // you can only allow or deny permissions you hold
		return nil, 0, nil, httpx.MissingPermission()
	}
	target, err := httpx.ParseID(in.TargetID, in.TargetType)
	if err != nil {
		return nil, 0, nil, err
	}
	if in.TargetType == "role" {
		ok, err := s.communities.HasRole(ctx, *c.CommunityID, target)
		if err != nil {
			return nil, 0, nil, err
		}
		if !ok {
			return nil, 0, nil, httpx.NotFound("role")
		}
	} else {
		_, err := s.communities.PermMember(ctx, *c.CommunityID, target)
		if errors.Is(err, communities.ErrNotMember) {
			return nil, 0, nil, httpx.NotFound("member")
		}
		if err != nil {
			return nil, 0, nil, err
		}
	}
	before, err := s.viewersOf(ctx, c)
	return c, target, before, err
}

func (s *Service) createDM(ctx context.Context, creator id.ID, recipients []id.ID) (*Channel, error) {
	others := []id.ID{}
	for _, r := range recipients {
		if r != creator && !slices.Contains(others, r) {
			others = append(others, r)
		}
	}
	if len(others) == 0 || len(others) != len(recipients) {
		return nil, httpx.BadRequest("INVALID_RECIPIENTS", "list 1 to 9 other users, without duplicates")
	}
	for _, r := range others {
		ok, err := s.communities.SharesCommunity(ctx, creator, r)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, httpx.E(http.StatusForbidden, "NO_SHARED_COMMUNITY", "you can only message people you share a community with")
		}
	}
	if len(others) == 1 { // reuse an existing 1:1 conversation
		var existing id.ID
		err := s.db.QueryRow(ctx, `
			SELECT c.id FROM channels c
			JOIN dm_participants a ON a.channel_id = c.id AND a.user_id = $1
			JOIN dm_participants b ON b.channel_id = c.id AND b.user_id = $2
			WHERE c.type = 'dm' AND (SELECT count(*) FROM dm_participants p WHERE p.channel_id = c.id) = 2
			LIMIT 1`, creator, others[0]).Scan(&existing)
		if err == nil {
			return s.get(ctx, existing)
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	chID := id.New()
	if _, err := tx.Exec(ctx, `INSERT INTO channels (id, type) VALUES ($1, 'dm')`, chID); err != nil {
		return nil, err
	}
	for _, u := range append(others, creator) {
		if _, err := tx.Exec(ctx, `INSERT INTO dm_participants (channel_id, user_id) VALUES ($1, $2)`, chID, u); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	c, err := s.get(ctx, chID)
	if err != nil {
		return nil, err
	}
	s.bus.Publish(events.Event{Type: "CHANNEL_CREATE", Data: c, Scope: events.Scope{ChannelID: c.ID}})
	return c, nil
}
```

The `existing` lookup treats any error (including `pgx.ErrNoRows`) as "none found" and creates a new DM; a real database error will surface again on the inserts that follow.

- [ ] **Step 7: Wire channels into the app** — `server/internal/app/app.go`

After the communities block add:

```go
	chanSvc := channels.NewService(pool, a.Bus, commSvc, authSvc)
	commSvc.SetChannelSeeder(chanSvc)
	channels.Register(api, chanSvc)
```

and the import `"github.com/datrope/datrope/server/internal/channels"`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd server && go test ./...`
Expected: all `ok`.

- [ ] **Step 9: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(server): channels, overrides, DMs`

---

### Task 10: Messages, typing, and read markers

**Files:**
- Create: `server/internal/db/migrations/00004_messages.sql`
- Create: `server/internal/messages/messages.go`
- Create: `server/internal/messages/handlers.go`
- Modify: `server/internal/app/app.go` (wire messages)
- Modify: `server/internal/apptest/apptest.go` (`Send` helper)
- Test: `server/internal/messages/messages_test.go`

**Interfaces:**
- Consumes: `(*channels.Service).Access` (Task 9); `auth.Current`, `(*auth.User).Public()`.
- Produces:
  - Types: `messages.Message{ID; ChannelID; Author auth.PublicUser; Content string; CreatedAt time.Time; EditedAt *time.Time; Deleted bool; Nonce string}`, `messages.MessageDeleted{ID, ChannelID}`, `messages.TypingStart{ChannelID, UserID id.ID; At time.Time}`, `messages.ReadState{ChannelID id.ID; LastReadID *id.ID; LastMessageID *id.ID}`.
  - `messages.NewService(*pgxpool.Pool, *events.Bus, Channels, Users) *Service` with `type Channels interface { Access(ctx, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error) }`.
  - `(*Service).ReadStates(ctx, userID id.ID, channelIDs []id.ID) ([]ReadState, error)` — used by READY (Task 11).
  - Endpoints: `GET|POST /api/channels/{id}/messages` (`?before=&limit=`), `PATCH|DELETE /api/channels/{id}/messages/{messageID}`, `POST /api/channels/{id}/typing`, `POST /api/channels/{id}/ack`.
  - Events: `MESSAGE_CREATE`/`MESSAGE_UPDATE` (`Message`), `MESSAGE_DELETE` (`MessageDeleted`), `TYPING_START` (`TypingStart`), all scoped to the channel's viewers.
  - apptest: `(*Client).Send(channelID id.ID, content string) messages.Message`.

Error codes introduced: `EMPTY_MESSAGE` 400.

- [ ] **Step 1: Write the migration** — `server/internal/db/migrations/00004_messages.sql`

```sql
-- +goose Up
-- A message's creation time is encoded in its Snowflake ID.
CREATE TABLE messages (
    id         BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    author_id  BIGINT NOT NULL REFERENCES users (id),
    content    TEXT NOT NULL,
    edited_at  TIMESTAMPTZ,
    deleted    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX messages_channel_idx ON messages (channel_id, id DESC);

CREATE TABLE read_states (
    user_id         BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id      BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    last_message_id BIGINT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);

-- +goose Down
DROP TABLE read_states;
DROP TABLE messages;
```

- [ ] **Step 2: Add the apptest helper** — append to `server/internal/apptest/apptest.go` (import `".../internal/messages"`)

```go
func (c *Client) Send(channelID id.ID, content string) messages.Message {
	c.env.T.Helper()
	var m messages.Message
	c.Do(http.MethodPost, "/api/channels/"+channelID.String()+"/messages", map[string]any{"content": content}, http.StatusCreated, &m)
	return m
}
```

- [ ] **Step 3: Write the failing test** — `server/internal/messages/messages_test.go`

```go
package messages_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func setup(t *testing.T) (*apptest.Env, *apptest.Client, *apptest.Client, id.ID, id.ID) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Friends")
	bob.JoinCommunity(alice, c.ID)
	return env, alice, bob, c.ID, alice.General(c.ID)
}

func TestSendAndList(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	path := "/api/channels/" + ch.String() + "/messages"

	var first messages.Message
	alice.Do(http.MethodPost, path, map[string]any{"content": "one", "nonce": "n-1"}, http.StatusCreated, &first)
	require.Equal(t, "n-1", first.Nonce)
	require.Equal(t, "alice", first.Author.Username)
	require.WithinDuration(t, first.ID.Time(), first.CreatedAt, 0)
	second := bob.Send(ch, "two")
	alice.Send(ch, "three")

	var page []messages.Message
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.Equal(t, []string{"three", "two", "one"}, contents(page), "newest first")

	bob.Do(http.MethodGet, path+"?limit=2", nil, http.StatusOK, &page)
	require.Len(t, page, 2)
	bob.Do(http.MethodGet, path+"?before="+second.ID.String(), nil, http.StatusOK, &page)
	require.Equal(t, []string{"one"}, contents(page))

	alice.Fail(http.MethodPost, path, map[string]any{"content": strings.Repeat("a", 4001)}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Do(http.MethodPost, path, map[string]any{"content": strings.Repeat("é", 4000)}, http.StatusCreated, nil)
	alice.Fail(http.MethodPost, path, map[string]any{"content": "   "}, http.StatusBadRequest, "EMPTY_MESSAGE")
	alice.Fail(http.MethodGet, path+"?limit=101", nil, http.StatusBadRequest, "VALIDATION_FAILED")

	env.Register("outsider").Fail(http.MethodGet, path, nil, http.StatusNotFound, "NOT_FOUND")
}

func contents(ms []messages.Message) []string {
	out := []string{}
	for _, m := range ms {
		out = append(out, m.Content)
	}
	return out
}

func TestEditAndDelete(t *testing.T) {
	_, alice, bob, _, ch := setup(t)
	m := bob.Send(ch, "typo")
	url := "/api/channels/" + ch.String() + "/messages/" + m.ID.String()

	alice.Fail(http.MethodPatch, url, map[string]any{"content": "hijack"}, http.StatusForbidden, "MISSING_PERMISSION")
	var edited messages.Message
	bob.Do(http.MethodPatch, url, map[string]any{"content": "fixed"}, http.StatusOK, &edited)
	require.Equal(t, "fixed", edited.Content)
	require.NotNil(t, edited.EditedAt)

	other := alice.Send(ch, "mine")
	bob.Fail(http.MethodDelete, "/api/channels/"+ch.String()+"/messages/"+other.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Do(http.MethodDelete, url, nil, http.StatusNoContent, nil) // the owner has MANAGE_MESSAGES

	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+ch.String()+"/messages", nil, http.StatusOK, &page)
	require.True(t, page[1].Deleted)
	require.Empty(t, page[1].Content, "deleting clears the content but keeps the row")

	bob.Fail(http.MethodPatch, url, map[string]any{"content": "again"}, http.StatusNotFound, "NOT_FOUND")
	alice.Fail(http.MethodDelete, url, nil, http.StatusNotFound, "NOT_FOUND")
}

func TestChannelPermissionsApply(t *testing.T) {
	_, alice, bob, communityID, ch := setup(t)
	ov := "/api/channels/" + ch.String() + "/overrides/role/" + communityID.String()
	path := "/api/channels/" + ch.String() + "/messages"

	alice.Do(http.MethodPut, ov, map[string]any{"allow": 0, "deny": uint64(perms.SendMessages)}, http.StatusOK, nil)
	bob.Fail(http.MethodPost, path, map[string]any{"content": "hi"}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPost, "/api/channels/"+ch.String()+"/typing", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodGet, path, nil, http.StatusOK, nil)

	alice.Do(http.MethodPut, ov, map[string]any{"allow": 0, "deny": uint64(perms.ReadHistory)}, http.StatusOK, nil)
	bob.Fail(http.MethodGet, path, nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestDMMessages(t *testing.T) {
	env, alice, bob, _, _ := setup(t)
	var dm channels.Channel
	alice.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{bob.User.ID.String()}}, http.StatusOK, &dm)
	alice.Send(dm.ID, "psst")
	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+dm.ID.String()+"/messages", nil, http.StatusOK, &page)
	require.Equal(t, []string{"psst"}, contents(page))

	carol := env.Register("carol")
	carol.Fail(http.MethodGet, "/api/channels/"+dm.ID.String()+"/messages", nil, http.StatusNotFound, "NOT_FOUND")
}

func TestTypingAndAck(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	bob.Do(http.MethodPost, "/api/channels/"+ch.String()+"/typing", nil, http.StatusNoContent, nil)

	m1 := alice.Send(ch, "1")
	m2 := alice.Send(ch, "2")
	ack := "/api/channels/" + ch.String() + "/ack"
	bob.Do(http.MethodPost, ack, map[string]any{"message_id": m2.ID.String()}, http.StatusNoContent, nil)
	bob.Do(http.MethodPost, ack, map[string]any{"message_id": m1.ID.String()}, http.StatusNoContent, nil) // never moves backwards

	var last id.ID
	require.NoError(t, env.Pool.QueryRow(context.Background(),
		`SELECT last_message_id FROM read_states WHERE user_id = $1 AND channel_id = $2`, bob.User.ID, ch).Scan(&last))
	require.Equal(t, m2.ID, last)
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd server && go test ./internal/messages/`
Expected: FAIL — build errors (`messages` package doesn't exist).

- [ ] **Step 5: Implement `server/internal/messages/messages.go`**

```go
// Package messages owns messages, typing notifications, and read markers.
package messages

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
}

type Users interface {
	PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]auth.PublicUser, error)
}

type Message struct {
	ID        id.ID           `json:"id"`
	ChannelID id.ID           `json:"channel_id"`
	Author    auth.PublicUser `json:"author"`
	Content   string          `json:"content"`
	CreatedAt time.Time       `json:"created_at"`
	EditedAt  *time.Time      `json:"edited_at,omitempty"`
	Deleted   bool            `json:"deleted"`
	Nonce     string          `json:"nonce,omitempty" doc:"Echoes the sender's nonce on create"`
}

type MessageDeleted struct {
	ID        id.ID `json:"id"`
	ChannelID id.ID `json:"channel_id"`
}

type TypingStart struct {
	ChannelID id.ID     `json:"channel_id"`
	UserID    id.ID     `json:"user_id"`
	At        time.Time `json:"at"`
}

// ReadState says how far a user has read a channel and where it ends.
type ReadState struct {
	ChannelID     id.ID  `json:"channel_id"`
	LastReadID    *id.ID `json:"last_read_id,omitempty"`
	LastMessageID *id.ID `json:"last_message_id,omitempty"`
}

type Service struct {
	db       *pgxpool.Pool
	bus      *events.Bus
	channels Channels
	users    Users
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, c Channels, u Users) *Service {
	return &Service{db: pool, bus: bus, channels: c, users: u}
}

const messageCols = `id, channel_id, author_id, content, edited_at, deleted`

func scanMessage(row pgx.Row) (*Message, error) {
	var m Message
	if err := row.Scan(&m.ID, &m.ChannelID, &m.Author.ID, &m.Content, &m.EditedAt, &m.Deleted); err != nil {
		return nil, err
	}
	m.CreatedAt = m.ID.Time()
	return &m, nil
}

func (s *Service) withAuthors(ctx context.Context, ms []Message) error {
	ids := make([]id.ID, 0, len(ms))
	for _, m := range ms {
		ids = append(ids, m.Author.ID)
	}
	users, err := s.users.PublicUsers(ctx, ids)
	if err != nil {
		return err
	}
	for i := range ms {
		ms[i].Author = users[ms[i].Author.ID]
	}
	return nil
}

func (s *Service) list(ctx context.Context, channelID id.ID, before *id.ID, limit int) ([]Message, error) {
	rows, err := s.db.Query(ctx, `
		SELECT `+messageCols+` FROM messages
		WHERE channel_id = $1 AND ($2::bigint IS NULL OR id < $2)
		ORDER BY id DESC LIMIT $3`, channelID, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, s.withAuthors(ctx, out)
}

// get returns a live (not deleted) message in a channel.
func (s *Service) get(ctx context.Context, channelID id.ID, rawMessageID string) (*Message, error) {
	mid, err := httpx.ParseID(rawMessageID, "message")
	if err != nil {
		return nil, err
	}
	m, err := scanMessage(s.db.QueryRow(ctx,
		`SELECT `+messageCols+` FROM messages WHERE id = $1 AND channel_id = $2 AND NOT deleted`, mid, channelID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("message")
	}
	return m, err
}

// ReadStates returns, for each channel, the user's read marker and the
// newest live message.
func (s *Service) ReadStates(ctx context.Context, userID id.ID, channelIDs []id.ID) ([]ReadState, error) {
	rows, err := s.db.Query(ctx, `
		SELECT c.id, rs.last_message_id, lm.max_id
		FROM unnest($2::bigint[]) AS c(id)
		LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = $1
		LEFT JOIN LATERAL (SELECT max(m.id) AS max_id FROM messages m WHERE m.channel_id = c.id AND NOT m.deleted) lm ON TRUE`,
		userID, id.Int64s(channelIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReadState{}
	for rows.Next() {
		var r ReadState
		var lastRead, lastMsg *int64
		if err := rows.Scan(&r.ChannelID, &lastRead, &lastMsg); err != nil {
			return nil, err
		}
		r.LastReadID, r.LastMessageID = id.FromNullable(lastRead), id.FromNullable(lastMsg)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Service) publish(typ string, channelID id.ID, data any) {
	s.bus.Publish(events.Event{Type: typ, Data: data, Scope: events.Scope{ChannelID: channelID}})
}
```

- [ ] **Step 6: Implement `server/internal/messages/handlers.go`**

```go
package messages

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type SendRequest struct {
	Content string `json:"content" minLength:"1" maxLength:"4000"`
	Nonce   string `json:"nonce,omitempty" maxLength:"64" doc:"Client-chosen; echoed in MESSAGE_CREATE so the sender can match its pending message"`
}

type EditRequest struct {
	Content string `json:"content" minLength:"1" maxLength:"4000"`
}

type AckRequest struct {
	MessageID id.ID `json:"message_id"`
}

type channelPath struct {
	ID string `path:"id"`
}

type messagePath struct {
	ID        string `path:"id"`
	MessageID string `path:"messageID"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"messages"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	// access resolves the channel for the signed-in user.
	access := func(ctx context.Context, raw string, need perms.Perms) (*channels.Channel, perms.Perms, error) {
		chID, err := httpx.ParseID(raw, "channel")
		if err != nil {
			return nil, 0, err
		}
		return s.channels.Access(ctx, auth.Current(ctx).User.ID, chID, need)
	}

	huma.Register(api, op("list-messages", http.MethodGet, "/api/channels/{id}/messages", 0),
		func(ctx context.Context, in *struct {
			channelPath
			Before string `query:"before" doc:"Only messages older than this ID"`
			Limit  int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
		}) (*struct{ Body []Message }, error) {
			ch, _, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			var before *id.ID
			if in.Before != "" {
				b, err := id.Parse(in.Before)
				if err != nil {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "before must be a message ID")
				}
				before = &b
			}
			ms, err := s.list(ctx, ch.ID, before, in.Limit)
			return &struct{ Body []Message }{ms}, err
		})

	huma.Register(api, op("send-message", http.MethodPost, "/api/channels/{id}/messages", http.StatusCreated),
		func(ctx context.Context, in *struct {
			channelPath
			Body SendRequest
		}) (*struct{ Body *Message }, error) {
			ch, _, err := access(ctx, in.ID, perms.SendMessages)
			if err != nil {
				return nil, err
			}
			content := strings.TrimSpace(in.Body.Content)
			if content == "" {
				return nil, httpx.BadRequest("EMPTY_MESSAGE", "a message needs some text")
			}
			u := auth.Current(ctx).User
			m := &Message{ID: id.New(), ChannelID: ch.ID, Author: u.Public(), Content: content, Nonce: in.Body.Nonce}
			m.CreatedAt = m.ID.Time()
			if _, err := s.db.Exec(ctx, `INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, $4)`,
				m.ID, m.ChannelID, u.ID, m.Content); err != nil {
				return nil, err
			}
			s.publish("MESSAGE_CREATE", ch.ID, m)
			return &struct{ Body *Message }{m}, nil
		})

	huma.Register(api, op("edit-message", http.MethodPatch, "/api/channels/{id}/messages/{messageID}", 0),
		func(ctx context.Context, in *struct {
			messagePath
			Body EditRequest
		}) (*struct{ Body *Message }, error) {
			ch, _, err := access(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			if m.Author.ID != auth.Current(ctx).User.ID {
				return nil, httpx.MissingPermission()
			}
			content := strings.TrimSpace(in.Body.Content)
			if content == "" {
				return nil, httpx.BadRequest("EMPTY_MESSAGE", "a message needs some text")
			}
			updated, err := scanMessage(s.db.QueryRow(ctx,
				`UPDATE messages SET content = $2, edited_at = now() WHERE id = $1 RETURNING `+messageCols, m.ID, content))
			if err != nil {
				return nil, err
			}
			updated.Author = auth.Current(ctx).User.Public()
			s.publish("MESSAGE_UPDATE", ch.ID, updated)
			return &struct{ Body *Message }{updated}, nil
		})

	huma.Register(api, op("delete-message", http.MethodDelete, "/api/channels/{id}/messages/{messageID}", http.StatusNoContent),
		func(ctx context.Context, in *messagePath) (*struct{}, error) {
			ch, have, err := access(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			if m.Author.ID != auth.Current(ctx).User.ID && !have.Has(perms.ManageMessages) {
				return nil, httpx.MissingPermission()
			}
			if _, err := s.db.Exec(ctx, `UPDATE messages SET content = '', deleted = TRUE WHERE id = $1`, m.ID); err != nil {
				return nil, err
			}
			s.publish("MESSAGE_DELETE", ch.ID, MessageDeleted{ID: m.ID, ChannelID: ch.ID})
			return nil, nil
		})

	huma.Register(api, op("start-typing", http.MethodPost, "/api/channels/{id}/typing", http.StatusNoContent),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			ch, _, err := access(ctx, in.ID, perms.SendMessages)
			if err != nil {
				return nil, err
			}
			s.publish("TYPING_START", ch.ID, TypingStart{ChannelID: ch.ID, UserID: auth.Current(ctx).User.ID, At: time.Now()})
			return nil, nil
		})

	huma.Register(api, op("ack-channel", http.MethodPost, "/api/channels/{id}/ack", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			channelPath
			Body AckRequest
		}) (*struct{}, error) {
			ch, _, err := access(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			_, err = s.db.Exec(ctx, `
				INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES ($1, $2, $3)
				ON CONFLICT (user_id, channel_id)
				DO UPDATE SET last_message_id = GREATEST(read_states.last_message_id, EXCLUDED.last_message_id)`,
				auth.Current(ctx).User.ID, ch.ID, in.Body.MessageID)
			return nil, err
		})
}
```

`Access` always checks `VIEW_CHANNEL`; passing `0` as `need` means "only needs to see the channel".

- [ ] **Step 7: Wire messages into the app** — `server/internal/app/app.go`

After the channels block add:

```go
	msgSvc := messages.NewService(pool, a.Bus, chanSvc, authSvc)
	messages.Register(api, msgSvc)
```

and the import `"github.com/datrope/datrope/server/internal/messages"`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd server && go test ./...`
Expected: all `ok`.

- [ ] **Step 9: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(server): messages, typing, read markers`

---

### Task 11: Realtime gateway

The WebSocket at `/ws` (spec §5.2): `HELLO` → `IDENTIFY`/`RESUME` → `READY`/`RESUMED` → `DISPATCH` events. Per-session sequence numbers, a ~2-minute replay buffer, heartbeats, presence, permission-filtered delivery, and closing connections whose sessions are revoked.

**Protocol summary (clients implement this in Task 12):**

| Direction | `op` | `d` |
|---|---|---|
| S→C | `HELLO` | `{heartbeat_interval}` (ms), sent on connect |
| C→S | `IDENTIFY` | `{token?, status?}` — token omitted by browsers (cookie used) |
| S→C | `READY` | `Ready` (session ID, user, communities with roles/members/channels, DMs, presences, read states) |
| C→S | `RESUME` | `{session_id, seq, token?}` |
| S→C | `RESUMED` | — then every missed `DISPATCH` with `s > seq` |
| S→C | `INVALID_SESSION` | — the client must `IDENTIFY` again on the same connection |
| S→C | `DISPATCH` | `t` = event type, `s` = sequence number, `d` = payload |
| C→S | `HEARTBEAT` | — every `heartbeat_interval`; server answers `HEARTBEAT_ACK` |
| C→S | `PRESENCE_SET` | `{status: "online"|"idle"|"invisible"}` |

Frames are JSON text messages: `{"op": "...", "d": ..., "s": n, "t": "..."}`. Any frame resets the 45 s read timeout. Close codes: `4001` session invalid, `4002` not identified, `4003` bad JSON, `4008` rate limited (more than ~30 frames burst / 1 per second sustained), `4010` replaced by a newer connection resuming the same session; `4000`/others → reconnect.

**Files:**
- Create: `server/internal/gateway/protocol.go`
- Create: `server/internal/gateway/gateway.go`
- Create: `server/internal/app/realtime.go` (event audience, READY builder, event schemas for OpenAPI)
- Modify: `server/internal/app/config.go` (add `Gateway gateway.Options`)
- Modify: `server/internal/app/app.go` (wire the gateway)
- Modify: `server/internal/apptest/apptest.go` (WebSocket test client)
- Test: `server/internal/gateway/gateway_test.go`

**Interfaces:**
- Consumes: `auth.ErrInvalidSession`, `auth.Principal`, `auth.CookieName`, `(*auth.Service).Authenticate` (Task 5); `events.*` (Task 4); `communities.Service.{ListForUser, Roles, Members, MemberIDs, CoMemberIDs}` (Task 7); `channels.Service.{Viewers, ListVisible, ListDMs}`, `channels.ErrNotFound` (Task 9); `messages.Service.ReadStates` (Task 10).
- Produces:
  - `gateway.Frame{Op string; D json.RawMessage; S uint64; T string}`; op constants `OpHello, OpIdentify, OpResume, OpReady, OpResumed, OpDispatch, OpHeartbeat, OpHeartbeatAck, OpInvalidSession, OpPresenceSet`; close codes `CloseUnknown (4000), CloseSessionInvalid (4001), CloseNotIdentified (4002), CloseDecodeError (4003), CloseRateLimited (4008), CloseReplaced (4010)`; statuses `StatusOnline, StatusIdle, StatusInvisible, StatusOffline`.
  - Payload types `gateway.Hello`, `gateway.Identify`, `gateway.Resume`, `gateway.PresenceSet`, `gateway.PresenceUpdate{UserID id.ID; Status string}`.
  - `gateway.New(Deps, Options) *Gateway` (`http.Handler`), `(*Gateway).StatusOf(id.ID) string`, `(*Gateway).Close()`; `gateway.Options{HeartbeatInterval, HeartbeatTimeout, ResumeWindow time.Duration; MaxBuffer int}` (zero values → 30 s, 45 s, 2 min, 1000).
  - `app.Ready`, `app.ReadyCommunity` (the READY payload); `app.Config.Gateway`.
  - Event: `PRESENCE_UPDATE` (`PresenceUpdate`, to co-members and self).
  - OpenAPI now also contains schemas for every event payload (`Ready`, `Message`, `PresenceUpdate`, `MessageDeleted`, `TypingStart`, `ChannelDeleted`, `MemberRemoved`, `RoleDeleted`, `CommunityDeleted`, `PublicUser`, `Hello`) so TypeScript gets types for them.
  - apptest: `(*Env).Dial(http.Header) *WS`, `(*Client).Connect() (*WS, app.Ready)`, `(*WS).Send(op string, d any)`, `(*WS).TrySend(op string, d any) error`, `(*WS).Expect(op string) gateway.Frame` (skips `DISPATCH` frames), `(*WS).ExpectDispatch(t string, out any)` (skips other frames), `(*WS).ExpectNoDispatch(t string, wait time.Duration)`, `(*WS).ExpectClose() websocket.StatusCode`, `(*WS).Close()`, field `WS.Seq` (last seen dispatch sequence).

- [ ] **Step 1: Add the dependency**

```bash
cd server && go get github.com/coder/websocket
```

- [ ] **Step 2: Write `server/internal/gateway/protocol.go`**

```go
// Package gateway is the realtime WebSocket (spec §5.2). It subscribes to
// the event bus and delivers each event to the users allowed to see it.
package gateway

import (
	"encoding/json"

	"github.com/coder/websocket"

	"github.com/datrope/datrope/server/internal/id"
)

const (
	OpHello          = "HELLO"
	OpIdentify       = "IDENTIFY"
	OpResume         = "RESUME"
	OpReady          = "READY"
	OpResumed        = "RESUMED"
	OpDispatch       = "DISPATCH"
	OpHeartbeat      = "HEARTBEAT"
	OpHeartbeatAck   = "HEARTBEAT_ACK"
	OpInvalidSession = "INVALID_SESSION"
	OpPresenceSet    = "PRESENCE_SET"
)

// Close codes. 4001 means "sign in again", 4008 "back off"; for anything
// else the client reconnects with backoff and tries RESUME.
const (
	CloseUnknown        websocket.StatusCode = 4000
	CloseSessionInvalid websocket.StatusCode = 4001
	CloseNotIdentified  websocket.StatusCode = 4002
	CloseDecodeError    websocket.StatusCode = 4003
	CloseRateLimited    websocket.StatusCode = 4008
	CloseReplaced       websocket.StatusCode = 4010
)

const (
	StatusOnline    = "online"
	StatusIdle      = "idle"
	StatusInvisible = "invisible" // shown to others as offline
	StatusOffline   = "offline"
)

type Frame struct {
	Op string          `json:"op"`
	D  json.RawMessage `json:"d,omitempty"`
	S  uint64          `json:"s,omitempty"`
	T  string          `json:"t,omitempty"`
}

type Hello struct {
	HeartbeatInterval int64 `json:"heartbeat_interval" doc:"Milliseconds between client HEARTBEATs"`
}

type Identify struct {
	Token  string `json:"token,omitempty"`
	Status string `json:"status,omitempty"`
}

type Resume struct {
	SessionID string `json:"session_id"`
	Seq       uint64 `json:"seq"`
	Token     string `json:"token,omitempty"`
}

type PresenceSet struct {
	Status string `json:"status"`
}

type PresenceUpdate struct {
	UserID id.ID  `json:"user_id"`
	Status string `json:"status" enum:"online,idle,offline"`
}

func normalStatus(s string) string {
	switch s {
	case StatusIdle, StatusInvisible:
		return s
	default:
		return StatusOnline
	}
}
```

- [ ] **Step 3: Write `server/internal/gateway/gateway.go`**

```go
package gateway

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
)

type Authenticator interface {
	Authenticate(ctx context.Context, token string) (*auth.Principal, error)
}

// Audience turns an event scope into user IDs.
type Audience interface {
	Resolve(ctx context.Context, s events.Scope) ([]id.ID, error)
}

// ReadyBuilder builds the READY payload. status reports other users'
// current presence.
type ReadyBuilder interface {
	Build(ctx context.Context, user *auth.User, sessionID string, status func(id.ID) string) (any, error)
}

type Deps struct {
	Auth     Authenticator
	Audience Audience
	Ready    ReadyBuilder
	Bus      *events.Bus
	// PublicOrigin is the web app's origin. The session cookie is only
	// accepted from it, which blocks cross-site WebSocket hijacking.
	PublicOrigin string
}

type Options struct {
	HeartbeatInterval time.Duration
	HeartbeatTimeout  time.Duration
	ResumeWindow      time.Duration
	MaxBuffer         int // replayable events kept per session
}

func (o *Options) defaults() {
	if o.HeartbeatInterval == 0 {
		o.HeartbeatInterval = 30 * time.Second
	}
	if o.HeartbeatTimeout == 0 {
		o.HeartbeatTimeout = 45 * time.Second
	}
	if o.ResumeWindow == 0 {
		o.ResumeWindow = 2 * time.Minute
	}
	if o.MaxBuffer == 0 {
		o.MaxBuffer = 1000
	}
}

type Gateway struct {
	d         Deps
	o         Options
	queue     chan events.Event
	done      chan struct{}
	closeOnce sync.Once

	mu       sync.Mutex
	sessions map[string]*session
	byUser   map[id.ID]map[*session]struct{}
}

// session survives disconnects for ResumeWindow so the client can resume.
type session struct {
	id     string
	userID id.ID
	authID id.ID // the auth session (for revocation)
	status string
	seq    uint64
	buf    []stamped
	conn   *conn // nil while disconnected
	goneAt time.Time
}

type stamped struct {
	f  Frame
	at time.Time
}

func (s *session) canReplayFrom(seq uint64) bool {
	if seq > s.seq {
		return false
	}
	if seq == s.seq {
		return true
	}
	return len(s.buf) > 0 && s.buf[0].f.S <= seq+1
}

type conn struct {
	ws   *websocket.Conn
	out  chan Frame
	once sync.Once
}

func (c *conn) send(f Frame) bool {
	select {
	case c.out <- f:
		return true
	default:
		return false
	}
}

// kill closes the connection. Safe to call repeatedly and while holding the
// gateway lock.
func (c *conn) kill(code websocket.StatusCode, reason string) {
	c.once.Do(func() { go c.ws.Close(code, reason) })
}

var errSessionInvalid = errors.New("session invalid")

func New(d Deps, o Options) *Gateway {
	o.defaults()
	g := &Gateway{
		d: d, o: o,
		queue:    make(chan events.Event, 4096),
		done:     make(chan struct{}),
		sessions: map[string]*session{},
		byUser:   map[id.ID]map[*session]struct{}{},
	}
	d.Bus.Subscribe(func(e events.Event) {
		select {
		case g.queue <- e:
		case <-g.done:
		}
	})
	go g.run()
	go g.janitor()
	return g
}

func (g *Gateway) Close() {
	g.closeOnce.Do(func() {
		close(g.done)
		g.mu.Lock()
		defer g.mu.Unlock()
		for _, s := range g.sessions {
			if s.conn != nil {
				s.conn.kill(websocket.StatusGoingAway, "server shutting down")
			}
		}
	})
}

// StatusOf is the presence others see for a user.
func (g *Gateway) StatusOf(userID id.ID) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.displayedLocked(userID)
}

var statusRank = map[string]int{StatusInvisible: 1, StatusIdle: 2, StatusOnline: 3}

func (g *Gateway) displayedLocked(userID id.ID) string {
	best := ""
	for s := range g.byUser[userID] {
		if s.conn != nil && statusRank[s.status] > statusRank[best] {
			best = s.status
		}
	}
	if best == "" || best == StatusInvisible {
		return StatusOffline
	}
	return best
}

// publishPresence must not be called from the run loop (it would block on
// the loop's own queue).
func (g *Gateway) publishPresence(userID id.ID, status string) {
	g.d.Bus.Publish(events.Event{Type: "PRESENCE_UPDATE", Data: PresenceUpdate{UserID: userID, Status: status},
		Scope: events.Scope{CoMembersOf: userID, UserIDs: []id.ID{userID}}})
}

// --- event delivery ---------------------------------------------------

func (g *Gateway) run() {
	ctx := context.Background()
	for {
		select {
		case <-g.done:
			return
		case e := <-g.queue:
			g.dispatch(ctx, e)
		}
	}
}

func (g *Gateway) dispatch(ctx context.Context, e events.Event) {
	if e.Type == events.SessionsRevoked {
		g.revoke(e.Data.(events.SessionsRevokedData))
		return
	}
	users, err := g.d.Audience.Resolve(ctx, e.Scope)
	if err != nil {
		slog.Error("resolve event audience", "type", e.Type, "err", err)
		return
	}
	data, err := json.Marshal(e.Data)
	if err != nil {
		slog.Error("encode event", "type", e.Type, "err", err)
		return
	}
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, u := range users {
		for s := range g.byUser[u] {
			g.pushLocked(s, e.Type, data, now)
		}
	}
}

func (g *Gateway) pushLocked(s *session, typ string, data json.RawMessage, now time.Time) {
	s.seq++
	f := Frame{Op: OpDispatch, T: typ, S: s.seq, D: data}
	s.buf = append(s.buf, stamped{f: f, at: now})
	cut := 0
	for cut < len(s.buf) && (now.Sub(s.buf[cut].at) > g.o.ResumeWindow || len(s.buf)-cut > g.o.MaxBuffer) {
		cut++
	}
	s.buf = s.buf[cut:]
	if s.conn != nil && !s.conn.send(f) {
		s.conn.kill(CloseUnknown, "client too slow") // it can resume
	}
}

func (g *Gateway) revoke(d events.SessionsRevokedData) {
	g.mu.Lock()
	before := g.displayedLocked(d.UserID)
	for s := range g.byUser[d.UserID] {
		if d.SessionIDs == nil || slices.Contains(d.SessionIDs, s.authID) {
			if s.conn != nil {
				s.conn.kill(CloseSessionInvalid, "session revoked")
			}
			g.removeLocked(s)
		}
	}
	now := g.displayedLocked(d.UserID)
	g.mu.Unlock()
	if now != before {
		go g.publishPresence(d.UserID, now)
	}
}

func (g *Gateway) removeLocked(s *session) {
	delete(g.sessions, s.id)
	if set := g.byUser[s.userID]; set != nil {
		delete(set, s)
		if len(set) == 0 {
			delete(g.byUser, s.userID)
		}
	}
}

func (g *Gateway) janitor() {
	t := time.NewTicker(g.o.ResumeWindow / 4)
	defer t.Stop()
	for {
		select {
		case <-g.done:
			return
		case now := <-t.C:
			g.mu.Lock()
			for _, s := range g.sessions {
				if s.conn == nil && !s.goneAt.IsZero() && now.Sub(s.goneAt) > g.o.ResumeWindow {
					g.removeLocked(s)
				}
			}
			g.mu.Unlock()
		}
	}
}

// --- connections --------------------------------------------------------

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Native apps connect from other origins. Cookies are only honoured
		// from our own origin (below), which is what prevents hijacking.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(64 << 10)
	cookie := ""
	if g.d.PublicOrigin != "" && r.Header.Get("Origin") == g.d.PublicOrigin {
		if ck, err := r.Cookie(auth.CookieName); err == nil {
			cookie = ck.Value
		}
	}
	c := &conn{ws: ws, out: make(chan Frame, g.o.MaxBuffer+64)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go g.write(ctx, c)
	g.serve(ctx, c, cookie)
	c.kill(websocket.StatusNormalClosure, "")
}

func (g *Gateway) write(ctx context.Context, c *conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case f := <-c.out:
			b, err := json.Marshal(f)
			if err != nil {
				continue
			}
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err = c.ws.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.kill(CloseUnknown, "write failed")
				return
			}
		}
	}
}

func (g *Gateway) read(ctx context.Context, c *conn) (Frame, error) {
	rctx, cancel := context.WithTimeout(ctx, g.o.HeartbeatTimeout)
	defer cancel()
	_, b, err := c.ws.Read(rctx) // on timeout the library closes the connection
	if err != nil {
		return Frame{}, err
	}
	var f Frame
	if err := json.Unmarshal(b, &f); err != nil {
		c.kill(CloseDecodeError, "invalid JSON")
		return Frame{}, err
	}
	return f, nil
}

func (g *Gateway) serve(ctx context.Context, c *conn, cookie string) {
	hello, _ := json.Marshal(Hello{HeartbeatInterval: g.o.HeartbeatInterval.Milliseconds()})
	c.send(Frame{Op: OpHello, D: hello})
	limiter := rate.NewLimiter(rate.Every(time.Second), 30)
	var s *session
	defer func() {
		if s != nil {
			g.detach(s, c)
		}
	}()
	for {
		f, err := g.read(ctx, c)
		if err != nil {
			return
		}
		if !limiter.Allow() {
			c.kill(CloseRateLimited, "rate limited")
			return
		}
		switch {
		case f.Op == OpHeartbeat:
			c.send(Frame{Op: OpHeartbeatAck})
		case s == nil && f.Op == OpIdentify:
			s, err = g.identify(ctx, c, f.D, cookie)
		case s == nil && f.Op == OpResume:
			s, err = g.resume(ctx, c, f.D, cookie)
		case s == nil:
			c.kill(CloseNotIdentified, "send IDENTIFY or RESUME first")
			return
		case f.Op == OpPresenceSet:
			var p PresenceSet
			_ = json.Unmarshal(f.D, &p)
			g.setStatus(s, p.Status)
		}
		if errors.Is(err, errSessionInvalid) {
			c.kill(CloseSessionInvalid, "session invalid")
			return
		}
		if err != nil {
			slog.Error("gateway", "err", err)
			c.kill(websocket.StatusInternalError, "internal error")
			return
		}
	}
}

func (g *Gateway) authenticate(ctx context.Context, token, cookie string) (*auth.Principal, error) {
	if token == "" {
		token = cookie
	}
	p, err := g.d.Auth.Authenticate(ctx, token)
	if errors.Is(err, auth.ErrInvalidSession) {
		return nil, errSessionInvalid
	}
	return p, err
}

func (g *Gateway) identify(ctx context.Context, c *conn, raw json.RawMessage, cookie string) (*session, error) {
	var d Identify
	_ = json.Unmarshal(raw, &d)
	p, err := g.authenticate(ctx, d.Token, cookie)
	if err != nil {
		return nil, err
	}
	s := &session{id: rand.Text(), userID: p.User.ID, authID: p.SessionID, status: normalStatus(d.Status)}
	// Register first (with no connection) so events that happen while READY
	// is being built are buffered, then flushed after READY.
	g.mu.Lock()
	g.sessions[s.id] = s
	if g.byUser[s.userID] == nil {
		g.byUser[s.userID] = map[*session]struct{}{}
	}
	g.byUser[s.userID][s] = struct{}{}
	g.mu.Unlock()

	ready, err := g.d.Ready.Build(ctx, p.User, s.id, g.StatusOf)
	if err == nil {
		var b []byte
		if b, err = json.Marshal(ready); err == nil {
			c.send(Frame{Op: OpReady, D: b})
		}
	}
	if err != nil {
		g.mu.Lock()
		g.removeLocked(s)
		g.mu.Unlock()
		return nil, err
	}
	g.mu.Lock()
	before := g.displayedLocked(s.userID)
	g.attachLocked(s, c, 0)
	now := g.displayedLocked(s.userID)
	g.mu.Unlock()
	if now != before {
		g.publishPresence(s.userID, now)
	}
	return s, nil
}

// resume reattaches a session. If it cannot be resumed the client gets
// INVALID_SESSION and may IDENTIFY on the same connection (nil, nil).
func (g *Gateway) resume(ctx context.Context, c *conn, raw json.RawMessage, cookie string) (*session, error) {
	var d Resume
	_ = json.Unmarshal(raw, &d)
	p, err := g.authenticate(ctx, d.Token, cookie)
	if err != nil {
		return nil, err
	}
	g.mu.Lock()
	s := g.sessions[d.SessionID]
	if s == nil || s.userID != p.User.ID || s.authID != p.SessionID || !s.canReplayFrom(d.Seq) {
		g.mu.Unlock()
		c.send(Frame{Op: OpInvalidSession})
		return nil, nil
	}
	before := g.displayedLocked(s.userID)
	c.send(Frame{Op: OpResumed})
	g.attachLocked(s, c, d.Seq)
	now := g.displayedLocked(s.userID)
	g.mu.Unlock()
	if now != before {
		g.publishPresence(s.userID, now)
	}
	return s, nil
}

// attachLocked makes c the session's connection, first replaying buffered
// events after seq `after`.
func (g *Gateway) attachLocked(s *session, c *conn, after uint64) {
	if s.conn != nil && s.conn != c {
		s.conn.kill(CloseReplaced, "session resumed elsewhere")
	}
	for _, st := range s.buf {
		if st.f.S > after {
			c.send(st.f)
		}
	}
	s.conn = c
	s.goneAt = time.Time{}
}

func (g *Gateway) detach(s *session, c *conn) {
	g.mu.Lock()
	before := g.displayedLocked(s.userID)
	if s.conn == c {
		s.conn = nil
		s.goneAt = time.Now()
	}
	now := g.displayedLocked(s.userID)
	g.mu.Unlock()
	if now != before {
		g.publishPresence(s.userID, now)
	}
}

func (g *Gateway) setStatus(s *session, status string) {
	g.mu.Lock()
	before := g.displayedLocked(s.userID)
	s.status = normalStatus(status)
	now := g.displayedLocked(s.userID)
	g.mu.Unlock()
	if now != before {
		g.publishPresence(s.userID, now)
	}
}
```

- [ ] **Step 4: Write `server/internal/app/realtime.go`**

```go
package app

import (
	"context"
	"errors"
	"reflect"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/gateway"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
)

// Ready is the READY payload (spec §5.2).
type Ready struct {
	SessionID   string                   `json:"session_id"`
	User        *auth.User               `json:"user"`
	Communities []ReadyCommunity         `json:"communities"`
	DMs         []channels.Channel       `json:"dms"`
	Presences   []gateway.PresenceUpdate `json:"presences" doc:"Co-members who are not offline"`
	ReadStates  []messages.ReadState     `json:"read_states" doc:"One per visible channel and DM"`
}

type ReadyCommunity struct {
	communities.Community
	Roles    []communities.Role   `json:"roles"`
	Members  []communities.Member `json:"members"`
	Channels []channels.Channel   `json:"channels" doc:"Only channels the user can see"`
}

type readyBuilder struct {
	communities *communities.Service
	channels    *channels.Service
	messages    *messages.Service
}

func (b readyBuilder) Build(ctx context.Context, u *auth.User, sessionID string, status func(id.ID) string) (any, error) {
	r := Ready{SessionID: sessionID, User: u, Communities: []ReadyCommunity{}, Presences: []gateway.PresenceUpdate{}}
	cs, err := b.communities.ListForUser(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	var channelIDs []id.ID
	seen := map[id.ID]bool{}
	for _, c := range cs {
		roles, err := b.communities.Roles(ctx, c.ID)
		if err != nil {
			return nil, err
		}
		members, err := b.communities.Members(ctx, c.ID)
		if err != nil {
			return nil, err
		}
		chs, err := b.channels.ListVisible(ctx, u.ID, c.ID)
		if err != nil {
			return nil, err
		}
		for _, ch := range chs {
			channelIDs = append(channelIDs, ch.ID)
		}
		for _, m := range members {
			if seen[m.User.ID] {
				continue
			}
			seen[m.User.ID] = true
			if st := status(m.User.ID); st != gateway.StatusOffline {
				r.Presences = append(r.Presences, gateway.PresenceUpdate{UserID: m.User.ID, Status: st})
			}
		}
		r.Communities = append(r.Communities, ReadyCommunity{Community: c, Roles: roles, Members: members, Channels: chs})
	}
	if r.DMs, err = b.channels.ListDMs(ctx, u.ID); err != nil {
		return nil, err
	}
	for _, dm := range r.DMs {
		channelIDs = append(channelIDs, dm.ID)
	}
	if r.ReadStates, err = b.messages.ReadStates(ctx, u.ID, channelIDs); err != nil {
		return nil, err
	}
	return r, nil
}

type audience struct {
	communities *communities.Service
	channels    *channels.Service
}

func (a audience) Resolve(ctx context.Context, s events.Scope) ([]id.ID, error) {
	seen := map[id.ID]bool{}
	var out []id.ID
	add := func(ids []id.ID) {
		for _, u := range ids {
			if !seen[u] {
				seen[u] = true
				out = append(out, u)
			}
		}
	}
	if s.ChannelID != 0 {
		v, err := a.channels.Viewers(ctx, s.ChannelID)
		if err != nil && !errors.Is(err, channels.ErrNotFound) {
			return nil, err
		}
		add(v)
	}
	if s.CommunityID != 0 {
		v, err := a.communities.MemberIDs(ctx, s.CommunityID)
		if err != nil {
			return nil, err
		}
		add(v)
	}
	if s.CoMembersOf != 0 {
		v, err := a.communities.CoMemberIDs(ctx, s.CoMembersOf)
		if err != nil {
			return nil, err
		}
		add(v)
	}
	add(s.UserIDs)
	return out, nil
}

// registerEventSchemas puts gateway payload types into the OpenAPI
// document so the generated TypeScript types include them.
func registerEventSchemas(api huma.API) {
	reg := api.OpenAPI().Components.Schemas
	for _, v := range []any{
		Ready{}, gateway.Hello{}, gateway.PresenceUpdate{}, auth.PublicUser{},
		messages.Message{}, messages.MessageDeleted{}, messages.TypingStart{},
		channels.ChannelDeleted{}, communities.MemberRemoved{}, communities.RoleDeleted{}, communities.CommunityDeleted{},
	} {
		reg.Schema(reflect.TypeOf(v), true, "")
	}
}
```

- [ ] **Step 5: Wire the gateway**

In `server/internal/app/config.go` add the field (and import `".../internal/gateway"`):

```go
	Gateway gateway.Options // zero value = production defaults
```

In `server/internal/app/app.go`, after the messages block add:

```go
	registerEventSchemas(api)
	if pool != nil { // nil only for `datrope openapi`
		gw := gateway.New(gateway.Deps{
			Auth:         authSvc,
			Audience:     audience{communities: commSvc, channels: chanSvc},
			Ready:        readyBuilder{communities: commSvc, channels: chanSvc, messages: msgSvc},
			Bus:          a.Bus,
			PublicOrigin: cfg.PublicURL,
		}, cfg.Gateway)
		mux.Handle("GET /ws", gw)
		a.closers = append(a.closers, gw.Close)
	}
```

and the import `"github.com/datrope/datrope/server/internal/gateway"`.

- [ ] **Step 6: Add the WebSocket test client** — append to `server/internal/apptest/apptest.go`

Add imports `"encoding/json"`, `"strings"`, `"time"`, `"github.com/coder/websocket"`, `".../internal/gateway"`.

```go
// WS is a gateway connection for tests. A goroutine reads frames into a
// channel so reads with timeouts never close the connection.
type WS struct {
	t      *testing.T
	conn   *websocket.Conn
	frames chan gateway.Frame
	closed chan websocket.StatusCode
	Seq    uint64 // sequence number of the last DISPATCH read
}

func (e *Env) Dial(h http.Header) *WS {
	e.T.Helper()
	url := "ws" + strings.TrimPrefix(e.Server.URL, "http") + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: h})
	require.NoError(e.T, err)
	w := &WS{t: e.T, conn: conn, frames: make(chan gateway.Frame, 256), closed: make(chan websocket.StatusCode, 1)}
	go w.pump()
	e.T.Cleanup(func() { _ = conn.CloseNow() })
	w.Expect(gateway.OpHello)
	return w
}

// Connect dials, identifies as c, and returns the READY payload.
func (c *Client) Connect() (*WS, app.Ready) {
	c.env.T.Helper()
	w := c.env.Dial(nil)
	w.Send(gateway.OpIdentify, gateway.Identify{Token: c.Token})
	var r app.Ready
	require.NoError(c.env.T, json.Unmarshal(w.Expect(gateway.OpReady).D, &r))
	return w, r
}

func (w *WS) pump() {
	for {
		_, b, err := w.conn.Read(context.Background())
		if err != nil {
			w.closed <- websocket.CloseStatus(err)
			close(w.frames)
			return
		}
		var f gateway.Frame
		if json.Unmarshal(b, &f) == nil {
			w.frames <- f
		}
	}
}

func (w *WS) Send(op string, d any) {
	w.t.Helper()
	require.NoError(w.t, w.TrySend(op, d))
}

// TrySend is Send for when the server may close the connection mid-test.
func (w *WS) TrySend(op string, d any) error {
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	b, err := json.Marshal(gateway.Frame{Op: op, D: raw})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return w.conn.Write(ctx, websocket.MessageText, b)
}

func (w *WS) next(timeout time.Duration) (gateway.Frame, bool) {
	select {
	case f, ok := <-w.frames:
		if ok && f.Op == gateway.OpDispatch {
			w.Seq = f.S
		}
		return f, ok
	case <-time.After(timeout):
		return gateway.Frame{}, false
	}
}

// Expect returns the next non-DISPATCH frame, which must have the given op.
// Dispatches arrive asynchronously (e.g. presence) and are skipped.
func (w *WS) Expect(op string) gateway.Frame {
	w.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f, ok := w.next(time.Until(deadline))
		require.True(w.t, ok, "waiting for %s: connection closed or timed out", op)
		if f.Op == gateway.OpDispatch && op != gateway.OpDispatch {
			continue
		}
		require.Equal(w.t, op, f.Op, "frame: %+v", f)
		return f
	}
}

// ExpectDispatch waits for a DISPATCH of type t, skipping everything else.
func (w *WS) ExpectDispatch(t string, out any) {
	w.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f, ok := w.next(time.Until(deadline))
		require.True(w.t, ok, "waiting for %s: connection closed or timed out", t)
		if f.Op == gateway.OpDispatch && f.T == t {
			if out != nil {
				require.NoError(w.t, json.Unmarshal(f.D, out))
			}
			return
		}
	}
}

// ExpectNoDispatch fails if a DISPATCH of type t arrives within wait.
func (w *WS) ExpectNoDispatch(t string, wait time.Duration) {
	w.t.Helper()
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		f, ok := w.next(time.Until(deadline))
		if !ok {
			return
		}
		require.False(w.t, f.Op == gateway.OpDispatch && f.T == t, "unexpected %s: %s", t, f.D)
	}
}

// ExpectClose waits for the server to close the connection.
func (w *WS) ExpectClose() websocket.StatusCode {
	w.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case code := <-w.closed:
			return code
		case <-w.frames: // drain so the reader can finish
		case <-deadline:
			w.t.Fatal("connection was not closed")
			return 0
		}
	}
}

func (w *WS) Close() { _ = w.conn.Close(websocket.StatusNormalClosure, "") }
```

- [ ] **Step 7: Write the failing tests** — `server/internal/gateway/gateway_test.go`

```go
package gateway_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/gateway"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

// pair returns alice and bob as members of one community.
func pair(t *testing.T, env *apptest.Env) (*apptest.Client, *apptest.Client, communities.CommunityWithRoles) {
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Friends")
	bob.JoinCommunity(alice, c.ID)
	return alice, bob, c
}

func TestReady(t *testing.T) {
	env := apptest.New(t)
	alice, _, c := pair(t, env)
	alice.Send(alice.General(c.ID), "hello")

	_, ready := alice.Connect()
	require.Equal(t, alice.User.ID, ready.User.ID)
	require.NotEmpty(t, ready.SessionID)
	require.Len(t, ready.Communities, 1)
	rc := ready.Communities[0]
	require.Len(t, rc.Members, 2)
	require.Len(t, rc.Channels, 1)
	require.Len(t, rc.Roles, 1)
	require.Len(t, ready.ReadStates, 1)
	require.NotNil(t, ready.ReadStates[0].LastMessageID)
	require.Nil(t, ready.ReadStates[0].LastReadID)
}

func TestMessagesReachViewersOnly(t *testing.T) {
	env := apptest.New(t)
	alice, bob, c := pair(t, env)
	carol := env.Register("carol")
	aliceWS, _ := alice.Connect()
	bobWS, _ := bob.Connect()
	carolWS, _ := carol.Connect()

	ch := alice.General(c.ID)
	alice.Do(http.MethodPost, "/api/channels/"+ch.String()+"/messages",
		map[string]any{"content": "hi", "nonce": "abc"}, http.StatusCreated, nil)

	var m messages.Message
	bobWS.ExpectDispatch("MESSAGE_CREATE", &m)
	require.Equal(t, "hi", m.Content)
	aliceWS.ExpectDispatch("MESSAGE_CREATE", &m)
	require.Equal(t, "abc", m.Nonce, "the sender matches its pending message by nonce")
	carolWS.ExpectNoDispatch("MESSAGE_CREATE", 300*time.Millisecond)

	// Hiding the channel from @everyone removes it for Bob and stops delivery.
	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+c.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	bobWS.ExpectDispatch("CHANNEL_DELETE", nil)
	alice.Send(ch, "secret")
	bobWS.ExpectNoDispatch("MESSAGE_CREATE", 300*time.Millisecond)
}

func TestTypingAndMembershipEvents(t *testing.T) {
	env := apptest.New(t)
	alice, bob, c := pair(t, env)
	aliceWS, _ := alice.Connect()
	bobWS, _ := bob.Connect()

	alice.Do(http.MethodPost, "/api/channels/"+alice.General(c.ID).String()+"/typing", nil, http.StatusNoContent, nil)
	var typing messages.TypingStart
	bobWS.ExpectDispatch("TYPING_START", &typing)
	require.Equal(t, alice.User.ID, typing.UserID)

	carol := env.Register("carol")
	carolWS, _ := carol.Connect()
	carol.JoinCommunity(alice, c.ID)
	carolWS.ExpectDispatch("COMMUNITY_CREATE", nil)
	aliceWS.ExpectDispatch("MEMBER_ADD", nil)

	alice.Do(http.MethodDelete, "/api/communities/"+c.ID.String()+"/members/"+carol.User.ID.String(), nil, http.StatusNoContent, nil)
	carolWS.ExpectDispatch("MEMBER_REMOVE", nil)
}

func TestBadTokenClosesWith4001(t *testing.T) {
	env := apptest.New(t)
	w := env.Dial(nil)
	w.Send(gateway.OpIdentify, gateway.Identify{Token: "nope"})
	require.Equal(t, gateway.CloseSessionInvalid, w.ExpectClose())
}

func TestMustIdentifyFirst(t *testing.T) {
	env := apptest.New(t)
	w := env.Dial(nil)
	w.Send(gateway.OpHeartbeat, nil)
	w.Expect(gateway.OpHeartbeatAck)
	w.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: "idle"})
	require.Equal(t, gateway.CloseNotIdentified, w.ExpectClose())
}

func TestCookieOnlyFromOwnOrigin(t *testing.T) {
	env := apptest.New(t)
	env.Register("alice")
	resp := env.Anon().Do(http.MethodPost, "/api/auth/login",
		map[string]any{"login": "alice", "password": "password123", "device_name": "browser", "client": "web"}, http.StatusOK, nil)
	var cookie string
	for _, ck := range resp.Cookies() {
		if ck.Name == auth.CookieName {
			cookie = ck.Name + "=" + ck.Value
		}
	}

	ok := env.Dial(http.Header{"Cookie": {cookie}, "Origin": {apptest.PublicURL}})
	ok.Send(gateway.OpIdentify, gateway.Identify{})
	ok.Expect(gateway.OpReady)

	evil := env.Dial(http.Header{"Cookie": {cookie}, "Origin": {"https://evil.example"}})
	evil.Send(gateway.OpIdentify, gateway.Identify{})
	require.Equal(t, gateway.CloseSessionInvalid, evil.ExpectClose())
}

func TestResume(t *testing.T) {
	env := apptest.New(t)
	alice, bob, c := pair(t, env)
	ch := alice.General(c.ID)
	w, ready := bob.Connect()
	alice.Send(ch, "one")
	w.ExpectDispatch("MESSAGE_CREATE", nil)
	seq := w.Seq
	w.Close()

	alice.Send(ch, "two") // sent while Bob is away

	w2 := env.Dial(nil)
	w2.Send(gateway.OpResume, gateway.Resume{SessionID: ready.SessionID, Seq: seq, Token: bob.Token})
	w2.Expect(gateway.OpResumed)
	var m messages.Message
	w2.ExpectDispatch("MESSAGE_CREATE", &m)
	require.Equal(t, "two", m.Content)
}

func TestResumeUnknownSessionThenIdentify(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	w := env.Dial(nil)
	w.Send(gateway.OpResume, gateway.Resume{SessionID: "nope", Seq: 3, Token: alice.Token})
	w.Expect(gateway.OpInvalidSession)
	w.Send(gateway.OpIdentify, gateway.Identify{Token: alice.Token})
	w.Expect(gateway.OpReady)
}

func TestLogoutClosesSocket(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	w, _ := alice.Connect()
	alice.Do(http.MethodPost, "/api/auth/logout", nil, http.StatusNoContent, nil)
	require.Equal(t, gateway.CloseSessionInvalid, w.ExpectClose())
}

func TestHeartbeatTimeout(t *testing.T) {
	env := apptest.NewWithConfig(t, func(c *app.Config) {
		c.Gateway = gateway.Options{HeartbeatInterval: 100 * time.Millisecond, HeartbeatTimeout: 300 * time.Millisecond}
	})
	alice := env.Register("alice")
	w, _ := alice.Connect()
	w.Send(gateway.OpHeartbeat, nil)
	w.Expect(gateway.OpHeartbeatAck)
	code := w.ExpectClose() // we stop sending; the server gives up after 300ms
	require.NotEqual(t, gateway.CloseSessionInvalid, code, "a timeout must not force a re-login")
}

func TestRateLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	w, _ := alice.Connect()
	for i := 0; i < 40; i++ {
		if w.TrySend(gateway.OpHeartbeat, nil) != nil {
			break // the server is already closing the connection
		}
	}
	require.Equal(t, gateway.CloseRateLimited, w.ExpectClose())
}

func waitPresence(w *apptest.WS, user id.ID) string {
	for {
		var p gateway.PresenceUpdate
		w.ExpectDispatch("PRESENCE_UPDATE", &p)
		if p.UserID == user {
			return p.Status
		}
	}
}

func TestPresence(t *testing.T) {
	env := apptest.New(t)
	alice, bob, _ := pair(t, env)
	aliceWS, _ := alice.Connect()

	bobWS, _ := bob.Connect()
	require.Equal(t, gateway.StatusOnline, waitPresence(aliceWS, bob.User.ID))

	_, ready := alice.Connect() // a second Alice connection sees Bob in READY
	found := false
	for _, p := range ready.Presences {
		if p.UserID == bob.User.ID {
			found = p.Status == gateway.StatusOnline
		}
	}
	require.True(t, found)

	bobWS.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: gateway.StatusIdle})
	require.Equal(t, gateway.StatusIdle, waitPresence(aliceWS, bob.User.ID))
	bobWS.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: gateway.StatusInvisible})
	require.Equal(t, gateway.StatusOffline, waitPresence(aliceWS, bob.User.ID))
	bobWS.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: gateway.StatusOnline})
	require.Equal(t, gateway.StatusOnline, waitPresence(aliceWS, bob.User.ID))
	bobWS.Close()
	require.Equal(t, gateway.StatusOffline, waitPresence(aliceWS, bob.User.ID))
}
```

- [ ] **Step 8: Run them to verify they fail, then pass**

The gateway code from Steps 2–6 is already written, so first confirm the tests are wired to it by temporarily breaking delivery: comment out the body of `pushLocked` after `s.seq++` and run:

Run: `cd server && go test ./internal/gateway/`
Expected: FAIL — `waiting for MESSAGE_CREATE: connection closed or timed out`.

Restore `pushLocked`, then:

Run: `cd server && go test -race ./...`
Expected: all `ok`, no data races.

- [ ] **Step 9: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(server): realtime gateway with resume and presence`

---

### Task 12: JS workspace and `@datrope/core`

The shared TypeScript package (spec §2.3): generated API types, a typed REST client, the gateway client (identify, heartbeat, resume, backoff), a Zustand store with pure reducers, the permission calculation mirrored from Go, and a `DatropeClient` that ties them together. The web app (Task 13) and later the mobile app use it.

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js` (repo root)
- Create: `clients/core/package.json`, `clients/core/tsconfig.json`, `clients/core/vitest.config.ts`
- Create (generated): `clients/core/openapi.json`, `clients/core/src/schema.d.ts`
- Create: `clients/core/src/api.ts`, `src/types.ts`, `src/perms.ts`, `src/gateway.ts`, `src/store.ts`, `src/client.ts`, `src/index.ts`
- Test: `clients/core/src/api.test.ts`, `src/perms.test.ts`, `src/gateway.test.ts`, `src/store.test.ts`, `src/client.test.ts`

**Interfaces:**
- Consumes: the OpenAPI document from `datrope openapi` (Tasks 4–11), the gateway protocol (Task 11).
- Produces (all exported from `@datrope/core`):
  - Types: `Schemas`, `User`, `PublicUser`, `Community`, `CommunityWithRoles`, `Role`, `Member`, `Channel`, `Override`, `Message`, `Ready`, `ReadState`, `Invite`, `InvitePreview`, `Session`, `Settings`, `InstanceInfo`, `Ban`, `EventMap`, `PresenceStatus` (`"online"|"idle"|"invisible"`).
  - `createApi({ baseUrl, token? }): Api` (openapi-fetch client; adds `Authorization: Bearer` when `token()` returns a value, otherwise `X-Datrope-CSRF: 1` on writes); `unwrap(promise)`; `class ApiError { status; code; message; details? }`.
  - `Perm` (flag values identical to Go), `ALL_PERMS`, `DM_PERMS`, `hasPerm(p, q)`, `basePerms(...)`, `channelPerms(...)`.
  - `class Gateway` with `connect()`, `close()`, `setPresence(status)`; options `{ url, token?, status?, WebSocket?, backoff?, onReady, onDispatch, onStatus?, onSessionInvalid }`; `backoff(attempt)`; `type ConnectionStatus = "connecting"|"ready"|"reconnecting"|"closed"`.
  - Store: `State`, `CommunityState`, `ChannelMessages`, `ClientMessage`, `initialState`, `createAppStore()`, `compareIds(a, b)`, reducers `applyReady`, `applyEvent`, `addPending`, `markFailed`, `prependHistory`, `setChannels`, `setMembers`, `ackLocal`, `expireTyping`.
  - `class DatropeClient` with `api`, `store`, `connect(status?)`, `disconnect()`, `setPresence(status)`, `apply(type, data)`, `loadChannels(communityId)`, `loadMembers(communityId)`, `loadOlder(channelId, limit?)`, `send(channelId, content)`, `ack(channelId, messageId)`, `typing(channelId)`.
  - Script `pnpm --filter @datrope/core gen` regenerates `openapi.json` and `schema.d.ts` from the Go server.

- [ ] **Step 1: Create the workspace root**

```bash
corepack enable
```

`package.json`:

```json
{
  "name": "datrope",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "lint": "eslint .",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test"
  },
  "devDependencies": {
    "@eslint/js": "^9.15.0",
    "eslint": "^9.15.0",
    "eslint-plugin-react-hooks": "^5.0.0",
    "typescript": "^5.6.3",
    "typescript-eslint": "^8.15.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "clients/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "resolveJsonModule": true
  }
}
```

`eslint.config.js`:

```js
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/schema.d.ts", "**/playwright-report/**", "server/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["clients/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
```

- [ ] **Step 2: Create the core package**

`clients/core/package.json`:

```json
{
  "name": "@datrope/core",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "gen": "go -C ../../server run ./cmd/datrope openapi ../clients/core/openapi.json && openapi-typescript openapi.json -o src/schema.d.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "openapi-fetch": "^0.13.4",
    "zustand": "^5.0.1"
  },
  "devDependencies": {
    "mock-socket": "^9.3.1",
    "msw": "^2.6.6",
    "openapi-typescript": "^7.4.4",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`clients/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["vitest/globals"] },
  "include": ["src"]
}
```

`clients/core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", globals: true } });
```

Then:

```bash
pnpm install
pnpm --filter @datrope/core gen
```

Expected: `clients/core/openapi.json` and `clients/core/src/schema.d.ts` exist; `schema.d.ts` contains `export interface paths` with `"/api/channels/{id}/messages"` and `components.schemas.Ready`. Both files are committed; CI fails if they drift from the server (Task 16).

- [ ] **Step 3: Write `clients/core/src/types.ts`**

```ts
import type { components } from "./schema";

export type Schemas = components["schemas"];
export type User = Schemas["User"];
export type PublicUser = Schemas["PublicUser"];
export type Community = Schemas["Community"];
export type CommunityWithRoles = Schemas["CommunityWithRoles"];
export type Role = Schemas["Role"];
export type Member = Schemas["Member"];
export type Channel = Schemas["Channel"];
export type Override = Schemas["Override"];
export type Message = Schemas["Message"];
export type Ready = Schemas["Ready"];
export type ReadState = Schemas["ReadState"];
export type Invite = Schemas["Invite"];
export type InvitePreview = Schemas["InvitePreview"];
export type Session = Schemas["Session"];
export type Settings = Schemas["Settings"];
export type InstanceInfo = Schemas["InstanceInfo"];
export type Ban = Schemas["Ban"];

export type PresenceStatus = "online" | "idle" | "invisible";

/** Gateway DISPATCH payloads by event type. */
export interface EventMap {
  MESSAGE_CREATE: Message;
  MESSAGE_UPDATE: Message;
  MESSAGE_DELETE: Schemas["MessageDeleted"];
  TYPING_START: Schemas["TypingStart"];
  CHANNEL_CREATE: Channel;
  CHANNEL_UPDATE: Channel;
  CHANNEL_DELETE: Schemas["ChannelDeleted"];
  COMMUNITY_CREATE: CommunityWithRoles;
  COMMUNITY_UPDATE: Community;
  COMMUNITY_DELETE: Schemas["CommunityDeleted"];
  MEMBER_ADD: Member;
  MEMBER_UPDATE: Member;
  MEMBER_REMOVE: Schemas["MemberRemoved"];
  ROLE_CREATE: Role;
  ROLE_UPDATE: Role;
  ROLE_DELETE: Schemas["RoleDeleted"];
  PRESENCE_UPDATE: Schemas["PresenceUpdate"];
  USER_UPDATE: PublicUser;
}
```

If `openapi-typescript` named any schema differently (check `schema.d.ts`), use the generated name here; these names come from the Go type names.

- [ ] **Step 4: Write the failing tests**

`clients/core/src/perms.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ALL_PERMS, DM_PERMS, Perm, basePerms, channelPerms, hasPerm } from "./perms";
import type { Channel, Role } from "./types";

const community = { id: "100", owner_id: "1" };
const everyone: Role = { id: "100", community_id: "100", name: "@everyone", position: 0,
  permissions: Perm.ViewChannel | Perm.SendMessages | Perm.ReadHistory };
const mods: Role = { id: "200", community_id: "100", name: "Mods", position: 1, permissions: Perm.Kick };
const roles = [everyone, mods];

function channel(overrides: Channel["overrides"]): Channel {
  return { id: "300", community_id: "100", type: "text", name: "general", position: 0, overrides };
}

describe("perms", () => {
  it("matches the Go flag values", () => {
    expect(Perm.ViewChannel).toBe(1);
    expect(Perm.Admin).toBe(1 << 16);
    expect(ALL_PERMS).toBe((1 << 17) - 1);
  });

  it("base is the OR of roles; owner and admin get everything", () => {
    expect(basePerms(community, roles, "2", ["200"])).toBe(everyone.permissions | Perm.Kick);
    expect(basePerms(community, roles, "1", [])).toBe(ALL_PERMS);
    const admin = { ...mods, permissions: Perm.Admin };
    expect(basePerms(community, [everyone, admin], "2", ["200"])).toBe(ALL_PERMS);
  });

  it("applies overrides in order: @everyone, roles, member", () => {
    const deny = channel([{ target_type: "role", target_id: "100", allow: 0, deny: Perm.SendMessages }]);
    expect(hasPerm(channelPerms(community, roles, "2", [], deny), Perm.SendMessages)).toBe(false);

    const roleAllow = channel([
      { target_type: "role", target_id: "100", allow: 0, deny: Perm.SendMessages },
      { target_type: "role", target_id: "200", allow: Perm.SendMessages, deny: 0 },
    ]);
    expect(hasPerm(channelPerms(community, roles, "2", ["200"], roleAllow), Perm.SendMessages)).toBe(true);

    const memberDeny = channel([
      { target_type: "role", target_id: "200", allow: Perm.SendMessages, deny: 0 },
      { target_type: "member", target_id: "2", allow: 0, deny: Perm.SendMessages },
    ]);
    expect(hasPerm(channelPerms(community, roles, "2", ["200"], memberDeny), Perm.SendMessages)).toBe(false);
  });

  it("no view means nothing; DMs are fixed", () => {
    const hidden = channel([{ target_type: "role", target_id: "100", allow: 0, deny: Perm.ViewChannel }]);
    expect(channelPerms(community, roles, "2", [], hidden)).toBe(0);
    expect(DM_PERMS & Perm.ManageMessages).toBe(0);
  });
});
```

`clients/core/src/api.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiError, createApi, unwrap } from "./api";

const BASE = "http://test.local";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("api", () => {
  it("sends the CSRF header on writes when using the cookie", async () => {
    let csrf: string | null = null;
    server.use(http.patch(`${BASE}/api/users/@me`, ({ request }) => {
      csrf = request.headers.get("X-Datrope-CSRF");
      return HttpResponse.json({ id: "1", username: "a", display_name: "A", is_admin: false, disabled: false, created_at: "2026-01-01T00:00:00Z" });
    }));
    const api = createApi({ baseUrl: BASE });
    await unwrap(api.PATCH("/api/users/@me", { body: { display_name: "A" } }));
    expect(csrf).toBe("1");
  });

  it("sends a bearer token when one is configured", async () => {
    let auth: string | null = null;
    server.use(http.get(`${BASE}/api/sessions`, ({ request }) => {
      auth = request.headers.get("Authorization");
      return HttpResponse.json([]);
    }));
    const api = createApi({ baseUrl: BASE, token: () => "tok" });
    await unwrap(api.GET("/api/sessions"));
    expect(auth).toBe("Bearer tok");
  });

  it("turns error bodies into ApiError with the server's code", async () => {
    server.use(http.post(`${BASE}/api/auth/login`, () =>
      HttpResponse.json({ code: "INVALID_CREDENTIALS", message: "wrong username or password" }, { status: 401 })));
    const api = createApi({ baseUrl: BASE });
    const err = await unwrap(api.POST("/api/auth/login", {
      body: { login: "a", password: "b", device_name: "t", client: "web" },
    })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("INVALID_CREDENTIALS");
    expect((err as ApiError).status).toBe(401);
  });
});
```

`clients/core/src/gateway.test.ts`:

```ts
import { Server, WebSocket as MockWebSocket } from "mock-socket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gateway, type Frame } from "./gateway";

const URL = "ws://test.local/ws";
const ready = { session_id: "s1", user: {}, communities: [], dms: [], presences: [], read_states: [] };
let server: Server | undefined;
afterEach(() => server?.stop());

/** A fake gateway server that records frames per connection. */
function fakeServer(onFrame: (f: Frame, send: (f: Frame) => void, conn: number) => void) {
  server = new Server(URL);
  const received: Frame[][] = [];
  let n = 0;
  server.on("connection", (socket) => {
    const conn = n++;
    received[conn] = [];
    const send = (f: Frame) => socket.send(JSON.stringify(f));
    socket.on("message", (data) => {
      const f = JSON.parse(String(data)) as Frame;
      received[conn].push(f);
      onFrame(f, send, conn);
    });
    send({ op: "HELLO", d: { heartbeat_interval: 60_000 } });
  });
  return { received, sockets: () => server!.clients() };
}

function gateway(overrides: Partial<ConstructorParameters<typeof Gateway>[0]> = {}) {
  return new Gateway({
    url: URL,
    WebSocket: MockWebSocket as unknown as typeof WebSocket,
    token: () => "tok",
    backoff: () => 0,
    onReady: vi.fn(),
    onDispatch: vi.fn(),
    onSessionInvalid: vi.fn(),
    ...overrides,
  });
}

describe("Gateway", () => {
  it("identifies, dispatches, and resumes after a drop", async () => {
    const fake = fakeServer((f, send) => {
      if (f.op === "IDENTIFY") {
        send({ op: "READY", d: ready });
        send({ op: "DISPATCH", t: "MESSAGE_CREATE", s: 1, d: { id: "9" } });
      }
      if (f.op === "RESUME") send({ op: "RESUMED" });
    });
    const onDispatch = vi.fn();
    const onReady = vi.fn();
    const gw = gateway({ onDispatch, onReady });
    gw.connect();

    await vi.waitFor(() => expect(onDispatch).toHaveBeenCalledWith("MESSAGE_CREATE", { id: "9" }));
    expect(onReady).toHaveBeenCalledOnce();
    expect(fake.received[0][0]).toEqual({ op: "IDENTIFY", d: { token: "tok", status: "online" } });

    fake.sockets()[0].close({ code: 4000, reason: "drop", wasClean: false });
    await vi.waitFor(() =>
      expect(fake.received[1]?.[0]).toEqual({ op: "RESUME", d: { session_id: "s1", seq: 1, token: "tok" } }));
    gw.close();
  });

  it("re-identifies after INVALID_SESSION", async () => {
    let identifies = 0;
    fakeServer((f, send) => {
      if (f.op === "IDENTIFY" && ++identifies === 1) send({ op: "INVALID_SESSION" });
      else if (f.op === "IDENTIFY") send({ op: "READY", d: ready });
    });
    const onReady = vi.fn();
    const gw = gateway({ onReady });
    gw.connect();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(identifies).toBe(2);
    gw.close();
  });

  it("stops and reports when the session is invalid (4001)", async () => {
    const fake = fakeServer(() => {});
    const onSessionInvalid = vi.fn();
    const gw = gateway({ onSessionInvalid });
    gw.connect();
    await vi.waitFor(() => expect(fake.sockets()).toHaveLength(1));
    fake.sockets()[0].close({ code: 4001, reason: "session invalid", wasClean: true });
    await vi.waitFor(() => expect(onSessionInvalid).toHaveBeenCalledOnce());
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.received).toHaveLength(1); // no reconnect
  });
});
```

`clients/core/src/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  addPending, applyEvent, applyReady, compareIds, initialState, markFailed, prependHistory, type State,
} from "./store";
import type { Message, Ready } from "./types";

const me = { id: "1", username: "alice", display_name: "Alice", is_admin: true, disabled: false, created_at: "2026-01-01T00:00:00Z" };
const bob = { id: "2", username: "bob", display_name: "Bob" };

const ready: Ready = {
  session_id: "s",
  user: me,
  communities: [{
    id: "100", name: "Friends", owner_id: "1", created_at: "2026-01-01T00:00:00Z",
    roles: [{ id: "100", community_id: "100", name: "@everyone", permissions: 1, position: 0 }],
    members: [
      { community_id: "100", user: { id: "1", username: "alice", display_name: "Alice" }, role_ids: [], joined_at: "2026-01-01T00:00:00Z" },
      { community_id: "100", user: bob, role_ids: [], joined_at: "2026-01-01T00:00:00Z" },
    ],
    channels: [{ id: "300", community_id: "100", type: "text", name: "general", position: 0, overrides: [] }],
  }],
  dms: [],
  presences: [{ user_id: "2", status: "online" }],
  read_states: [{ channel_id: "300", last_message_id: "500" }],
};

function msg(id: string, extra: Partial<Message> = {}): Message {
  return { id, channel_id: "300", author: bob, content: `m${id}`, created_at: "2026-01-01T00:00:00Z", deleted: false, ...extra };
}

function loaded(): State {
  const s = applyReady(initialState, ready);
  return prependHistory(s, "300", [msg("20"), msg("10")], 50);
}

describe("store", () => {
  it("compares snowflake strings numerically", () => {
    expect(compareIds("9", "10")).toBeLessThan(0);
    expect(compareIds("10", "10")).toBe(0);
  });

  it("applies READY", () => {
    const s = applyReady(initialState, ready);
    expect(s.me?.id).toBe("1");
    expect(s.communityOrder).toEqual(["100"]);
    expect(s.communities["100"].channelIds).toEqual(["300"]);
    expect(Object.keys(s.communities["100"].members)).toEqual(["1", "2"]);
    expect(s.presences["2"]).toBe("online");
    expect(s.readStates["300"].lastMessageId).toBe("500");
  });

  it("keeps history oldest-first and marks whether more exists", () => {
    const s = loaded();
    expect(s.messages["300"].items.map((m) => m.id)).toEqual(["10", "20"]);
    expect(s.messages["300"].hasMore).toBe(false);
  });

  it("replaces a pending message when the server echoes its nonce", () => {
    let s = addPending(loaded(), "300", "n1", "hello");
    expect(s.messages["300"].items.at(-1)).toMatchObject({ pending: true, content: "hello" });
    s = applyEvent(s, "MESSAGE_CREATE", msg("30", { author: { id: "1", username: "alice", display_name: "Alice" }, content: "hello", nonce: "n1" }));
    const items = s.messages["300"].items;
    expect(items.map((m) => m.id)).toEqual(["10", "20", "30"]);
    expect(items.some((m) => m.pending)).toBe(false);
    expect(s.readStates["300"]).toEqual({ lastMessageId: "30", lastReadId: "30" });
    // The HTTP response may arrive after the event; applying it again is harmless.
    expect(applyEvent(s, "MESSAGE_CREATE", msg("30")).messages["300"].items).toHaveLength(3);
  });

  it("marks a failed send", () => {
    const s = markFailed(addPending(loaded(), "300", "n1", "x"), "300", "n1");
    expect(s.messages["300"].items.at(-1)).toMatchObject({ pending: true, failed: true });
  });

  it("soft-deletes messages", () => {
    const s = applyEvent(loaded(), "MESSAGE_DELETE", { id: "10", channel_id: "300" });
    expect(s.messages["300"].items[0]).toMatchObject({ deleted: true, content: "" });
  });

  it("removes a community when I am removed from it", () => {
    const s = applyEvent(loaded(), "MEMBER_REMOVE", { community_id: "100", user_id: "1" });
    expect(s.communities["100"]).toBeUndefined();
    expect(s.channels["300"]).toBeUndefined();
    expect(s.communityOrder).toEqual([]);
  });

  it("removes other members", () => {
    const s = applyEvent(loaded(), "MEMBER_REMOVE", { community_id: "100", user_id: "2" });
    expect(Object.keys(s.communities["100"].members)).toEqual(["1"]);
  });

  it("adds, updates, and deletes channels", () => {
    let s = applyEvent(loaded(), "CHANNEL_CREATE", { id: "301", community_id: "100", type: "text", name: "random", position: 1, overrides: [] });
    expect(s.communities["100"].channelIds).toEqual(["300", "301"]);
    s = applyEvent(s, "CHANNEL_UPDATE", { id: "301", community_id: "100", type: "text", name: "memes", position: 1, overrides: [] });
    expect(s.channels["301"].name).toBe("memes");
    s = applyEvent(s, "CHANNEL_DELETE", { id: "301", community_id: "100" });
    expect(s.communities["100"].channelIds).toEqual(["300"]);
  });

  it("tracks typing and clears it when that user posts", () => {
    let s = applyEvent(loaded(), "TYPING_START", { channel_id: "300", user_id: "2", at: "2026-01-01T00:00:00Z" }, 1000);
    expect(s.typing["300"]["2"]).toBe(11_000);
    s = applyEvent(s, "MESSAGE_CREATE", msg("40"));
    expect(s.typing["300"]["2"]).toBeUndefined();
  });
});
```

`clients/core/src/client.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DatropeClient } from "./client";
import { applyReady, prependHistory } from "./store";
import type { Ready } from "./types";

const BASE = "http://test.local";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

it("sends optimistically and confirms with the server's message", async () => {
  server.use(http.post(`${BASE}/api/channels/:id/messages`, async ({ request }) => {
    const body = (await request.json()) as { content: string; nonce: string };
    return HttpResponse.json({
      id: "77", channel_id: "300", author: { id: "1", username: "alice", display_name: "Alice" },
      content: body.content, created_at: "2026-01-01T00:00:00Z", deleted: false, nonce: body.nonce,
    }, { status: 201 });
  }));
  const client = new DatropeClient({ baseUrl: BASE, wsUrl: "ws://unused" });
  const ready = {
    session_id: "s", communities: [], dms: [], presences: [], read_states: [],
    user: { id: "1", username: "alice", display_name: "Alice", is_admin: false, disabled: false, created_at: "2026-01-01T00:00:00Z" },
  } satisfies Ready;
  client.store.setState(prependHistory(applyReady(client.store.getState(), ready), "300", [], 50), true);

  await client.send("300", "hi");
  const items = client.store.getState().messages["300"].items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "77", content: "hi" });
  expect(items[0].pending).toBeUndefined();
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `pnpm --filter @datrope/core test`
Expected: FAIL — `Failed to resolve import "./perms"` (and the other modules).

- [ ] **Step 6: Implement `clients/core/src/api.ts`**

```ts
import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  /** "" for the same-origin web app, or e.g. "https://chat.example.com". */
  baseUrl: string;
  /** Native clients return their session token; the web app uses the cookie. */
  token?: () => string | undefined;
}

export function createApi(opts: ApiOptions) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl, credentials: "include" });
  const auth: Middleware = {
    onRequest({ request }) {
      const token = opts.token?.();
      if (token) request.headers.set("Authorization", `Bearer ${token}`);
      else if (request.method !== "GET" && request.method !== "HEAD") request.headers.set("X-Datrope-CSRF", "1");
      return request;
    },
  };
  client.use(auth);
  return client;
}

export type Api = ReturnType<typeof createApi>;

/** Resolves to the response data or throws an ApiError. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (!response.ok) {
    const e = (error ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
    throw new ApiError(response.status, e.code ?? "UNKNOWN", e.message ?? response.statusText, e.details);
  }
  return data as T;
}
```

- [ ] **Step 7: Implement `clients/core/src/perms.ts`**

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
  ManageCommunity: 1 << 15,
  Admin: 1 << 16,
} as const;

// JavaScript bitwise operators work on 32 bits; revisit if flags pass bit 30.
export const ALL_PERMS = (1 << 17) - 1;
export const DM_PERMS = Perm.ViewChannel | Perm.SendMessages | Perm.AttachFiles | Perm.ReadHistory |
  Perm.ConnectVoice | Perm.Speak | Perm.Stream;
const OVERRIDABLE = ALL_PERMS & ~Perm.Admin;

export const hasPerm = (p: number, q: number) => (p & q) === q;

interface CommunityRef {
  id: string;
  owner_id: string;
}

/** Community-level permissions. roleIds excludes @everyone. */
export function basePerms(c: CommunityRef, roles: Role[], userId: string, roleIds: string[]): number {
  if (userId === c.owner_id) return ALL_PERMS;
  let p = 0;
  for (const r of roles) if (r.id === c.id || roleIds.includes(r.id)) p |= r.permissions;
  return hasPerm(p, Perm.Admin) ? ALL_PERMS : p;
}

/** Permissions in a channel, following the server's Effective(). */
export function channelPerms(c: CommunityRef, roles: Role[], userId: string, roleIds: string[], ch: Channel): number {
  if (ch.type === "dm") return DM_PERMS;
  let p = basePerms(c, roles, userId, roleIds);
  if (hasPerm(p, Perm.Admin)) return ALL_PERMS;
  const apply = (allow: number, deny: number) => {
    p = (p & ~(deny & OVERRIDABLE)) | (allow & OVERRIDABLE);
  };
  const overrides = ch.overrides ?? [];
  const everyone = overrides.find((o) => o.target_type === "role" && o.target_id === c.id);
  if (everyone) apply(everyone.allow, everyone.deny);
  let allow = 0;
  let deny = 0;
  for (const o of overrides) {
    if (o.target_type === "role" && o.target_id !== c.id && roleIds.includes(o.target_id)) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  apply(allow, deny);
  const mine = overrides.find((o) => o.target_type === "member" && o.target_id === userId);
  if (mine) apply(mine.allow, mine.deny);
  return hasPerm(p, Perm.ViewChannel) ? p : 0;
}
```

- [ ] **Step 8: Implement `clients/core/src/gateway.ts`**

```ts
import type { PresenceStatus, Ready } from "./types";

export interface Frame {
  op: string;
  d?: unknown;
  s?: number;
  t?: string;
}

export type ConnectionStatus = "connecting" | "ready" | "reconnecting" | "closed";

const CLOSE_SESSION_INVALID = 4001;
const CLOSE_RATE_LIMITED = 4008;

export interface GatewayOptions {
  url: string;
  token?: () => string | undefined;
  status?: PresenceStatus;
  WebSocket?: typeof WebSocket;
  backoff?: (attempt: number) => number;
  onReady: (ready: Ready) => void;
  onDispatch: (type: string, data: unknown) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** The session was revoked or expired: sign in again. */
  onSessionInvalid: () => void;
}

/** Exponential backoff with jitter: ~1s, 2s, 4s … capped at 30s. */
export function backoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export class Gateway {
  private ws?: WebSocket;
  private sessionId?: string;
  private seq = 0;
  private attempts = 0;
  private stopped = true;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private status: PresenceStatus;

  constructor(private readonly o: GatewayOptions) {
    this.status = o.status ?? "online";
  }

  connect() {
    this.stopped = false;
    this.open();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.ws?.close(1000);
    this.ws = undefined;
    this.o.onStatus?.("closed");
  }

  setPresence(status: PresenceStatus) {
    this.status = status;
    this.send({ op: "PRESENCE_SET", d: { status } });
  }

  private open() {
    const WS = this.o.WebSocket ?? WebSocket;
    this.o.onStatus?.(this.attempts === 0 && !this.sessionId ? "connecting" : "reconnecting");
    const ws = new WS(this.o.url);
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onFrame(JSON.parse(String(ev.data)) as Frame);
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.onClose(ev.code);
    };
  }

  private send(f: Frame) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(f));
  }

  private onFrame(f: Frame) {
    switch (f.op) {
      case "HELLO":
        this.startHeartbeat((f.d as { heartbeat_interval: number }).heartbeat_interval);
        if (this.sessionId) this.send({ op: "RESUME", d: { session_id: this.sessionId, seq: this.seq, token: this.o.token?.() } });
        else this.identify();
        break;
      case "READY": {
        const ready = f.d as Ready;
        this.sessionId = ready.session_id;
        this.seq = 0;
        this.attempts = 0;
        this.o.onStatus?.("ready");
        this.o.onReady(ready);
        break;
      }
      case "RESUMED":
        this.attempts = 0;
        this.o.onStatus?.("ready");
        break;
      case "INVALID_SESSION":
        this.sessionId = undefined;
        this.seq = 0;
        this.identify();
        break;
      case "DISPATCH":
        if (f.s) this.seq = f.s;
        this.o.onDispatch(f.t ?? "", f.d);
        break;
    }
  }

  private identify() {
    this.send({ op: "IDENTIFY", d: { token: this.o.token?.(), status: this.status } });
  }

  private startHeartbeat(interval: number) {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.send({ op: "HEARTBEAT" }), interval);
  }

  private stopHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private onClose(code: number) {
    this.stopHeartbeat();
    this.ws = undefined;
    if (this.stopped) return;
    if (code === CLOSE_SESSION_INVALID) {
      this.stopped = true;
      this.sessionId = undefined;
      this.o.onStatus?.("closed");
      this.o.onSessionInvalid();
      return;
    }
    const delay = code === CLOSE_RATE_LIMITED ? 60_000 : (this.o.backoff ?? backoff)(this.attempts++);
    this.o.onStatus?.("reconnecting");
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
}
```

`JSON.stringify` drops `token: undefined`, so browsers (cookie auth) send `{"status":"online"}`.

- [ ] **Step 9: Implement `clients/core/src/store.ts`**

```ts
import { createStore } from "zustand/vanilla";
import type { ConnectionStatus } from "./gateway";
import type { Channel, Community, Member, Message, PresenceStatus, PublicUser, Ready, Role, User } from "./types";

export type ClientMessage = Message & { pending?: boolean; failed?: boolean };

export interface ChannelMessages {
  items: ClientMessage[]; // oldest first; pending messages last
  hasMore: boolean;
}

export interface CommunityState {
  community: Community;
  roles: Record<string, Role>;
  members: Record<string, Member>; // by user ID
  channelIds: string[]; // visible channels, by position
}

export interface State {
  me: User | null;
  connection: ConnectionStatus;
  communities: Record<string, CommunityState>;
  communityOrder: string[];
  channels: Record<string, Channel>;
  dmIds: string[];
  messages: Record<string, ChannelMessages>; // only channels whose history was loaded
  presences: Record<string, "online" | "idle" | "offline">;
  readStates: Record<string, { lastReadId?: string; lastMessageId?: string }>;
  typing: Record<string, Record<string, number>>; // channel → user → expiry (ms)
  presence: PresenceStatus; // my chosen status
}

export const initialState: State = {
  me: null,
  connection: "closed",
  communities: {},
  communityOrder: [],
  channels: {},
  dmIds: [],
  messages: {},
  presences: {},
  readStates: {},
  typing: {},
  presence: "online",
};

export const createAppStore = () => createStore<State>(() => initialState);

/** Orders Snowflake IDs (decimal strings) numerically. */
export function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

const byKey = <T>(xs: T[], key: (x: T) => string) => Object.fromEntries(xs.map((x) => [key(x), x]));

export function applyReady(s: State, r: Ready): State {
  const communities: Record<string, CommunityState> = {};
  const channels: Record<string, Channel> = {};
  for (const rc of r.communities) {
    const { roles, members, channels: chs, ...community } = rc;
    communities[rc.id] = {
      community,
      roles: byKey(roles, (x) => x.id),
      members: byKey(members, (m) => m.user.id),
      channelIds: chs.map((c) => c.id),
    };
    for (const c of chs) channels[c.id] = c;
  }
  for (const dm of r.dms) channels[dm.id] = dm;
  return {
    ...s,
    me: r.user,
    communities,
    communityOrder: r.communities.map((c) => c.id),
    channels,
    dmIds: r.dms.map((d) => d.id),
    messages: {},
    typing: {},
    presences: Object.fromEntries(r.presences.map((p) => [p.user_id, p.status])),
    readStates: Object.fromEntries(
      r.read_states.map((x) => [x.channel_id, { lastReadId: x.last_read_id, lastMessageId: x.last_message_id }]),
    ),
  };
}

function insertSorted(items: ClientMessage[], m: ClientMessage): ClientMessage[] {
  const confirmed = items.filter((x) => !x.pending);
  const pending = items.filter((x) => x.pending);
  confirmed.push(m);
  confirmed.sort((a, b) => compareIds(a.id, b.id));
  return [...confirmed, ...pending];
}

function updateMessages(s: State, channelId: string, fn: (items: ClientMessage[]) => ClientMessage[]): State {
  const list = s.messages[channelId];
  if (!list) return s;
  return { ...s, messages: { ...s.messages, [channelId]: { ...list, items: fn(list.items) } } };
}

function updateCommunity(s: State, id: string, fn: (c: CommunityState) => CommunityState): State {
  const c = s.communities[id];
  return c ? { ...s, communities: { ...s.communities, [id]: fn(c) } } : s;
}

function withoutTyping(typing: State["typing"], channelId: string, userId: string): State["typing"] {
  const t = typing[channelId];
  if (!t?.[userId]) return typing;
  const rest = { ...t };
  delete rest[userId];
  return { ...typing, [channelId]: rest };
}

function sortChannelIds(s: State, ids: string[]): string[] {
  return [...ids].sort((a, b) => (s.channels[a]?.position ?? 0) - (s.channels[b]?.position ?? 0) || compareIds(a, b));
}

function upsertChannel(s: State, c: Channel): State {
  const next = { ...s, channels: { ...s.channels, [c.id]: c } };
  if (c.community_id) {
    return updateCommunity(next, c.community_id, (cs) => ({
      ...cs,
      channelIds: sortChannelIds(next, cs.channelIds.includes(c.id) ? cs.channelIds : [...cs.channelIds, c.id]),
    }));
  }
  return next.dmIds.includes(c.id) ? next : { ...next, dmIds: [c.id, ...next.dmIds] };
}

function removeChannel(s: State, id: string): State {
  const channels = { ...s.channels };
  const communityId = channels[id]?.community_id;
  delete channels[id];
  const messages = { ...s.messages };
  delete messages[id];
  let next: State = { ...s, channels, messages, dmIds: s.dmIds.filter((x) => x !== id) };
  if (communityId) next = updateCommunity(next, communityId, (cs) => ({ ...cs, channelIds: cs.channelIds.filter((x) => x !== id) }));
  return next;
}

function removeCommunity(s: State, id: string): State {
  const cs = s.communities[id];
  if (!cs) return s;
  let next = s;
  for (const ch of cs.channelIds) next = removeChannel(next, ch);
  const communities = { ...next.communities };
  delete communities[id];
  return { ...next, communities, communityOrder: next.communityOrder.filter((x) => x !== id) };
}

function renameUser(s: State, u: PublicUser): State {
  const communities = Object.fromEntries(Object.entries(s.communities).map(([id, cs]) => {
    const m = cs.members[u.id];
    return [id, m ? { ...cs, members: { ...cs.members, [u.id]: { ...m, user: u } } } : cs];
  }));
  const channels = { ...s.channels };
  for (const id of s.dmIds) {
    const c = channels[id];
    if (c?.participants?.some((p) => p.id === u.id)) {
      channels[id] = { ...c, participants: c.participants.map((p) => (p.id === u.id ? u : p)) };
    }
  }
  const me = s.me?.id === u.id ? { ...s.me, display_name: u.display_name } : s.me;
  return { ...s, communities, channels, me };
}

/** Applies a gateway DISPATCH. Unknown types leave the state unchanged. */
export function applyEvent(s: State, type: string, data: unknown, now = Date.now()): State {
  switch (type) {
    case "MESSAGE_CREATE": {
      const m = data as Message;
      const prev = s.readStates[m.channel_id] ?? {};
      const mine = m.author.id === s.me?.id;
      const next: State = {
        ...s,
        typing: withoutTyping(s.typing, m.channel_id, m.author.id),
        readStates: {
          ...s.readStates,
          [m.channel_id]: {
            lastMessageId: prev.lastMessageId && compareIds(prev.lastMessageId, m.id) > 0 ? prev.lastMessageId : m.id,
            lastReadId: mine ? m.id : prev.lastReadId,
          },
        },
      };
      return updateMessages(next, m.channel_id, (items) =>
        insertSorted(items.filter((x) => x.id !== m.id && !(m.nonce && x.pending && x.nonce === m.nonce)), { ...m }));
    }
    case "MESSAGE_UPDATE": {
      const m = data as Message;
      return updateMessages(s, m.channel_id, (items) => items.map((x) => (x.id === m.id ? { ...m } : x)));
    }
    case "MESSAGE_DELETE": {
      const d = data as { id: string; channel_id: string };
      return updateMessages(s, d.channel_id, (items) =>
        items.map((x) => (x.id === d.id ? { ...x, deleted: true, content: "" } : x)));
    }
    case "TYPING_START": {
      const d = data as { channel_id: string; user_id: string };
      if (d.user_id === s.me?.id) return s;
      return { ...s, typing: { ...s.typing, [d.channel_id]: { ...s.typing[d.channel_id], [d.user_id]: now + 10_000 } } };
    }
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE":
      return upsertChannel(s, data as Channel);
    case "CHANNEL_DELETE":
      return removeChannel(s, (data as { id: string }).id);
    case "COMMUNITY_CREATE": {
      const { roles, ...community } = data as Community & { roles: Role[] };
      return {
        ...s,
        communities: {
          ...s.communities,
          [community.id]: s.communities[community.id] ?? { community, roles: byKey(roles, (r) => r.id), members: {}, channelIds: [] },
        },
        communityOrder: s.communityOrder.includes(community.id) ? s.communityOrder : [...s.communityOrder, community.id],
      };
    }
    case "COMMUNITY_UPDATE": {
      const c = data as Community;
      return updateCommunity(s, c.id, (cs) => ({ ...cs, community: c }));
    }
    case "COMMUNITY_DELETE":
      return removeCommunity(s, (data as { id: string }).id);
    case "MEMBER_ADD":
    case "MEMBER_UPDATE": {
      const m = data as Member;
      return updateCommunity(s, m.community_id, (cs) => ({ ...cs, members: { ...cs.members, [m.user.id]: m } }));
    }
    case "MEMBER_REMOVE": {
      const d = data as { community_id: string; user_id: string };
      if (d.user_id === s.me?.id) return removeCommunity(s, d.community_id);
      return updateCommunity(s, d.community_id, (cs) => {
        const members = { ...cs.members };
        delete members[d.user_id];
        return { ...cs, members };
      });
    }
    case "ROLE_CREATE":
    case "ROLE_UPDATE": {
      const r = data as Role;
      return updateCommunity(s, r.community_id, (cs) => ({ ...cs, roles: { ...cs.roles, [r.id]: r } }));
    }
    case "ROLE_DELETE": {
      const d = data as { community_id: string; id: string };
      return updateCommunity(s, d.community_id, (cs) => {
        const roles = { ...cs.roles };
        delete roles[d.id];
        const members = Object.fromEntries(Object.entries(cs.members).map(([k, m]) =>
          [k, { ...m, role_ids: m.role_ids.filter((r) => r !== d.id) }]));
        return { ...cs, roles, members };
      });
    }
    case "PRESENCE_UPDATE": {
      const d = data as { user_id: string; status: "online" | "idle" | "offline" };
      return { ...s, presences: { ...s.presences, [d.user_id]: d.status } };
    }
    case "USER_UPDATE":
      return renameUser(s, data as PublicUser);
    default:
      return s;
  }
}

export function addPending(s: State, channelId: string, nonce: string, content: string): State {
  if (!s.me) return s;
  const pending: ClientMessage = {
    id: `pending:${nonce}`, channel_id: channelId, nonce, content, pending: true, deleted: false,
    author: { id: s.me.id, username: s.me.username, display_name: s.me.display_name },
    created_at: new Date().toISOString(),
  };
  const list = s.messages[channelId] ?? { items: [], hasMore: true };
  return { ...s, messages: { ...s.messages, [channelId]: { ...list, items: [...list.items, pending] } } };
}

export function markFailed(s: State, channelId: string, nonce: string): State {
  return updateMessages(s, channelId, (items) => items.map((x) => (x.pending && x.nonce === nonce ? { ...x, failed: true } : x)));
}

/** Adds an older page (as the API returns it: newest first). */
export function prependHistory(s: State, channelId: string, page: Message[], limit: number): State {
  const list = s.messages[channelId] ?? { items: [], hasMore: true };
  let items = list.items;
  for (const m of page) if (!items.some((x) => x.id === m.id)) items = insertSorted(items, m);
  return { ...s, messages: { ...s.messages, [channelId]: { items, hasMore: page.length === limit } } };
}

export function setChannels(s: State, communityId: string, chs: Channel[]): State {
  let next = s;
  const cs = s.communities[communityId];
  for (const id of cs?.channelIds ?? []) if (!chs.some((c) => c.id === id)) next = removeChannel(next, id);
  for (const c of chs) next = upsertChannel(next, c);
  return next;
}

export function setMembers(s: State, communityId: string, members: Member[]): State {
  return updateCommunity(s, communityId, (cs) => ({ ...cs, members: byKey(members, (m) => m.user.id) }));
}

export function ackLocal(s: State, channelId: string, messageId: string): State {
  const prev = s.readStates[channelId] ?? {};
  if (prev.lastReadId && compareIds(prev.lastReadId, messageId) >= 0) return s;
  return { ...s, readStates: { ...s.readStates, [channelId]: { ...prev, lastReadId: messageId } } };
}

export function expireTyping(s: State, now = Date.now()): State {
  let changed = false;
  const typing: State["typing"] = {};
  for (const [ch, users] of Object.entries(s.typing)) {
    typing[ch] = Object.fromEntries(Object.entries(users).filter(([, until]) => {
      const keep = until > now;
      if (!keep) changed = true;
      return keep;
    }));
  }
  return changed ? { ...s, typing } : s;
}
```

- [ ] **Step 10: Implement `clients/core/src/client.ts` and `src/index.ts`**

`clients/core/src/client.ts`:

```ts
import { createApi, unwrap, type Api } from "./api";
import { Gateway } from "./gateway";
import {
  ackLocal, addPending, applyEvent, applyReady, createAppStore, initialState, markFailed, prependHistory,
  setChannels, setMembers, type State,
} from "./store";
import type { CommunityWithRoles, Member, PresenceStatus } from "./types";

export interface ClientOptions {
  baseUrl: string; // "" for the web app
  wsUrl: string; // e.g. "wss://chat.example.com/ws"
  token?: () => string | undefined;
  WebSocket?: typeof WebSocket;
  onSignedOut?: () => void;
}

/** API + gateway + store: everything a Datrope UI needs. */
export class DatropeClient {
  readonly api: Api;
  readonly store = createAppStore();
  private gateway?: Gateway;
  private lastTyping: Record<string, number> = {};

  constructor(private readonly o: ClientOptions) {
    this.api = createApi({ baseUrl: o.baseUrl, token: o.token });
  }

  private set(fn: (s: State) => State) {
    this.store.setState(fn(this.store.getState()), true);
  }

  connect(status: PresenceStatus = "online") {
    this.gateway?.close();
    this.set((s) => ({ ...s, presence: status }));
    this.gateway = new Gateway({
      url: this.o.wsUrl,
      token: this.o.token,
      WebSocket: this.o.WebSocket,
      status,
      onReady: (r) => this.set((s) => applyReady(s, r)),
      onDispatch: (type, data) => this.apply(type, data),
      onStatus: (connection) => this.set((s) => ({ ...s, connection })),
      onSessionInvalid: () => {
        this.store.setState(initialState, true);
        this.o.onSignedOut?.();
      },
    });
    this.gateway.connect();
  }

  disconnect() {
    this.gateway?.close();
    this.gateway = undefined;
    this.store.setState(initialState, true);
  }

  setPresence(status: PresenceStatus) {
    this.set((s) => ({ ...s, presence: status }));
    this.gateway?.setPresence(status);
  }

  /**
   * Applies an event. The gateway calls this for every DISPATCH; UIs call it
   * with a REST response (e.g. COMMUNITY_CREATE after creating a community)
   * when they need the state before the event arrives. Applying twice is safe.
   */
  apply(type: string, data: unknown) {
    this.set((s) => applyEvent(s, type, data));
    void this.follow(type, data);
  }

  /** Some events only say "something changed"; fetch what they imply. */
  private async follow(type: string, data: unknown) {
    try {
      if (type === "COMMUNITY_CREATE") {
        const id = (data as CommunityWithRoles).id;
        await Promise.all([this.loadChannels(id), this.loadMembers(id)]);
      } else if (type === "MEMBER_UPDATE" && (data as Member).user.id === this.store.getState().me?.id) {
        await this.loadChannels((data as Member).community_id); // my roles changed what I can see
      } else if (type === "ROLE_UPDATE" || type === "ROLE_DELETE") {
        await this.loadChannels((data as { community_id: string }).community_id);
      }
    } catch (e) {
      console.warn(`datrope: refreshing after ${type} failed`, e);
    }
  }

  async loadChannels(communityId: string) {
    const chs = await unwrap(this.api.GET("/api/communities/{id}/channels", { params: { path: { id: communityId } } }));
    this.set((s) => setChannels(s, communityId, chs));
  }

  async loadMembers(communityId: string) {
    const ms = await unwrap(this.api.GET("/api/communities/{id}/members", { params: { path: { id: communityId } } }));
    this.set((s) => setMembers(s, communityId, ms));
  }

  /** Loads the next page of older messages (or the first page). */
  async loadOlder(channelId: string, limit = 50) {
    const oldest = this.store.getState().messages[channelId]?.items.find((m) => !m.pending)?.id;
    const page = await unwrap(this.api.GET("/api/channels/{id}/messages", {
      params: { path: { id: channelId }, query: { limit, ...(oldest ? { before: oldest } : {}) } },
    }));
    this.set((s) => prependHistory(s, channelId, page, limit));
  }

  async send(channelId: string, content: string) {
    const nonce = crypto.randomUUID();
    this.set((s) => addPending(s, channelId, nonce, content));
    try {
      const m = await unwrap(this.api.POST("/api/channels/{id}/messages", {
        params: { path: { id: channelId } },
        body: { content, nonce },
      }));
      // The gateway usually delivers this first; applying it twice is harmless.
      this.set((s) => applyEvent(s, "MESSAGE_CREATE", m));
    } catch (e) {
      this.set((s) => markFailed(s, channelId, nonce));
      throw e;
    }
  }

  async ack(channelId: string, messageId: string) {
    const before = this.store.getState();
    this.set((s) => ackLocal(s, channelId, messageId));
    if (this.store.getState() === before) return; // already read
    await unwrap(this.api.POST("/api/channels/{id}/ack", { params: { path: { id: channelId } }, body: { message_id: messageId } }));
  }

  /** Tells others you are typing, at most every 8 seconds per channel. */
  async typing(channelId: string) {
    const now = Date.now();
    if ((this.lastTyping[channelId] ?? 0) > now - 8000) return;
    this.lastTyping[channelId] = now;
    await unwrap(this.api.POST("/api/channels/{id}/typing", { params: { path: { id: channelId } } }));
  }
}
```

`clients/core/src/index.ts`:

```ts
export * from "./api";
export * from "./client";
export * from "./gateway";
export * from "./perms";
export * from "./store";
export * from "./types";
```

- [ ] **Step 11: Run the tests, typecheck, and lint**

Run: `pnpm --filter @datrope/core test && pnpm --filter @datrope/core typecheck && pnpm lint`
Expected: all tests pass; no type or lint errors.

If `typecheck` reports a mismatch between a generated type and a test fixture (for example an optional field the Go side marks required), fix the fixture to match `schema.d.ts` — the generated types are the source of truth.

- [ ] **Step 12: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(clients): @datrope/core API client, gateway client, store`

---

### Task 13: Web app scaffold, sign-in, registration, invites

React + Vite app in `clients/web`, served same-origin with the API (Vite proxies `/api` and `/ws` in development). Sign in, register (including the first-admin case and invite codes), and the public invite page.

The web client's automated tests are the Playwright flows in Task 16 (spec §10); in Tasks 13–15 each step is verified with `typecheck`, `build`, and the manual check listed.

**Files:**
- Create: `clients/web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`
- Create: `clients/web/src/main.tsx`, `src/router.tsx`, `src/session.ts`, `src/ui.tsx`, `src/styles.css`
- Create: `clients/web/src/pages/AuthLayout.tsx`, `Login.tsx`, `Register.tsx`, `Invite.tsx`
- Create: `clients/web/src/app/RequireSession.tsx`

**Interfaces:**
- Consumes: `@datrope/core` (`DatropeClient`, `unwrap`, `ApiError`, `basePerms`, `channelPerms`, `DM_PERMS`, types) from Task 12.
- Produces (used by Tasks 14–15):
  - `session.ts`: `client` (the app's `DatropeClient`), `useApp(selector)`, `usePerms(communityId?, channelId?) => number`, `savedPresence()`, `choosePresence(status)`, `errorText(e)`, `displayName(user)`, `userName(state, userId)`, `dmName(channel, meId)`, `deviceName()`, `safeNext(path)`.
  - `ui.tsx`: `Button` (`variant: "primary"|"ghost"|"danger"`), `Field`, `ErrorText`, `Modal`, `PresenceDot`, `useSubmit()` → `{ busy, error, run(fn) }`.
  - `router.tsx`: `router` with `/login`, `/register`, `/invite/:code`, and `/` guarded by `RequireSession` (children added in Tasks 14–15).

- [ ] **Step 1: Create the package**

`clients/web/package.json`:

```json
{
  "name": "@datrope/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "typecheck": "tsc -p tsconfig.json",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@datrope/core": "workspace:*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0",
    "zustand": "^5.0.1"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^5.4.11"
  }
}
```

`clients/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "types": ["vite/client"] },
  "include": ["src", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

`clients/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the Go server runs on :8080; the browser only talks to Vite,
// so cookies and the WebSocket stay same-origin as in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
```

`clients/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Datrope</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Run: `pnpm install`

- [ ] **Step 2: Write `clients/web/src/session.ts`**

```ts
import {
  ApiError, DM_PERMS, DatropeClient, basePerms, channelPerms,
  type Channel, type PresenceStatus, type PublicUser, type State,
} from "@datrope/core";
import { useMemo } from "react";
import { useStore } from "zustand";

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export const client = new DatropeClient({
  baseUrl: "",
  wsUrl,
  onSignedOut: () => window.location.assign("/login"),
});

/** Subscribes a component to part of the app state. Select existing objects or primitives. */
export function useApp<T>(selector: (s: State) => T): T {
  return useStore(client.store, selector);
}

/** My permissions in a community, or in one of its channels / a DM. */
export function usePerms(communityId?: string, channelId?: string): number {
  const cs = useApp((s) => (communityId ? s.communities[communityId] : undefined));
  const ch = useApp((s) => (channelId ? s.channels[channelId] : undefined));
  const me = useApp((s) => s.me);
  return useMemo(() => {
    if (ch?.type === "dm") return DM_PERMS;
    if (!cs || !me) return 0;
    const roleIds = cs.members[me.id]?.role_ids ?? [];
    const roles = Object.values(cs.roles);
    return ch ? channelPerms(cs.community, roles, me.id, roleIds, ch) : basePerms(cs.community, roles, me.id, roleIds);
  }, [cs, ch, me]);
}

const PRESENCE_KEY = "datrope.presence";

export function savedPresence(): PresenceStatus {
  try {
    const v = localStorage.getItem(PRESENCE_KEY);
    return v === "idle" || v === "invisible" ? v : "online";
  } catch {
    return "online";
  }
}

export function choosePresence(p: PresenceStatus) {
  try {
    localStorage.setItem(PRESENCE_KEY, p);
  } catch {
    // Storage unavailable (private window): the choice lasts for this session only.
  }
  client.setPresence(p);
}

export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

export const displayName = (u: Pick<PublicUser, "display_name" | "username">) => u.display_name || u.username;

/** Finds a user's name anywhere in the state. */
export function userName(s: State, userId: string): string {
  for (const cs of Object.values(s.communities)) {
    const m = cs.members[userId];
    if (m) return displayName(m.user);
  }
  for (const id of s.dmIds) {
    const p = s.channels[id]?.participants?.find((x) => x.id === userId);
    if (p) return displayName(p);
  }
  return "Someone";
}

export function dmName(ch: Channel | undefined, meId: string | undefined): string {
  const others = ch?.participants?.filter((p) => p.id !== meId) ?? [];
  return others.map(displayName).join(", ") || "Just you";
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} (web)`;
}

/** Only allow same-site relative redirects after sign-in. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
```

- [ ] **Step 3: Write `clients/web/src/ui.tsx`**

```tsx
import {
  useEffect, useId, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
} from "react";
import { errorText } from "./session";

export function Button({ variant = "primary", className = "", ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  return <button type="button" {...props} className={`btn btn-${variant} ${className}`} />;
}

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...props} />
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

export function ErrorText({ error }: { error?: string }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function PresenceDot({ status = "offline" }: { status?: string }) {
  return <span className={`dot dot-${status}`} role="img" aria-label={status} />;
}

/** Runs an async action with busy and error state. */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}
```

- [ ] **Step 4: Write `clients/web/src/styles.css`**

```css
:root {
  --bg: #f5f6f8;
  --panel: #ffffff;
  --rail: #e7eaef;
  --text: #1b1f24;
  --muted: #5b6573;
  --border: #dce1e7;
  --hover: #edf0f5;
  --accent: #4b57d1;
  --accent-text: #ffffff;
  --danger: #c22f3a;
  --online: #2f9e5b;
  --idle: #d39b14;
  --offline: #8a93a0;
  --radius: 8px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 15px;
  line-height: 1.45;
  color: var(--text);
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171c;
    --panel: #1c1f26;
    --rail: #101216;
    --text: #e6e8ec;
    --muted: #9aa3af;
    --border: #2a2e37;
    --hover: #252932;
    --accent: #7e88f3;
    --accent-text: #0f1115;
  }
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); }
h1, h2, h3 { margin: 0; font-weight: 600; }
h1 { font-size: 1rem; }
h2 { font-size: 1.05rem; }
h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
a { color: var(--accent); }
.muted { color: var(--muted); }
.center { display: grid; place-items: center; text-align: center; min-height: 100%; padding: 2rem; }
.error { color: var(--danger); margin: 0.25rem 0; }

.btn { border: 1px solid transparent; border-radius: var(--radius); padding: 0.45rem 0.9rem; font: inherit; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn-primary { background: var(--accent); color: var(--accent-text); }
.btn-ghost { background: transparent; color: var(--text); border-color: var(--border); }
.btn-danger { background: var(--danger); color: #fff; }
.btn:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}

.field { display: grid; gap: 0.25rem; margin-bottom: 0.8rem; }
.field label { font-weight: 500; }
input, textarea, select {
  font: inherit; color: inherit; background: var(--panel);
  border: 1px solid var(--border); border-radius: var(--radius); padding: 0.45rem 0.6rem;
}

.auth { min-height: 100vh; display: grid; place-items: center; padding: 1rem; }
.auth-card { width: min(400px, 100%); background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; }
.auth-card h1 { font-size: 1.3rem; margin-bottom: 1rem; }
.auth-card form .btn { width: 100%; }

.shell { display: flex; height: 100vh; overflow: hidden; }
.rail { width: 68px; flex: none; background: var(--rail); display: flex; flex-direction: column; align-items: center; gap: 0.5rem; padding: 0.6rem 0; overflow-y: auto; }
.rail-item { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; background: var(--panel); color: var(--text); text-decoration: none; font-weight: 600; border: 0; cursor: pointer; }
.rail-item.active { background: var(--accent); color: var(--accent-text); }
.rail-spacer { flex: 1; }

.sidebar { width: 236px; flex: none; background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
.sidebar-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.75rem; border-bottom: 1px solid var(--border); }
.sidebar-header h1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channel-list { list-style: none; margin: 0; padding: 0.5rem; overflow-y: auto; flex: 1; }
.channel-row { display: flex; align-items: center; }
.channel { flex: 1; display: block; padding: 0.35rem 0.5rem; border-radius: 6px; color: var(--muted); text-decoration: none; }
.channel:hover { background: var(--hover); }
.channel.active { background: var(--hover); color: var(--text); }
.channel.unread { color: var(--text); font-weight: 600; }
.channel.disabled { cursor: default; opacity: 0.7; }
.icon-btn { background: none; border: 0; color: var(--muted); cursor: pointer; padding: 0.25rem; border-radius: 4px; font: inherit; }
.icon-btn:hover { color: var(--text); background: var(--hover); }

.main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg); }
.main-header { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); background: var(--panel); }
.messages { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.15rem; }
.msg { position: relative; padding: 0.15rem 0.5rem; border-radius: 6px; }
.msg:not(.grouped) { margin-top: 0.6rem; }
.msg:hover { background: var(--hover); }
.msg header time { color: var(--muted); font-size: 0.8rem; margin-left: 0.4rem; }
.msg-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.pending .msg-body { opacity: 0.6; }
.msg-actions { position: absolute; right: 0.5rem; top: 0.1rem; display: none; gap: 0.25rem; }
.msg:hover .msg-actions, .msg:focus-within .msg-actions { display: flex; }
.typing { min-height: 1.4rem; padding: 0 1rem; font-size: 0.85rem; color: var(--muted); }
.composer { display: flex; gap: 0.5rem; padding: 0 1rem 1rem; align-items: flex-end; flex-wrap: wrap; }
.composer textarea { flex: 1; resize: none; max-height: 40vh; min-height: 2.6rem; }

.members { width: 220px; flex: none; background: var(--panel); border-left: 1px solid var(--border); padding: 0.75rem; overflow-y: auto; }
.members ul { list-style: none; margin: 0.5rem 0 0; padding: 0; }
.members li { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--offline); }
.dot-online { background: var(--online); }
.dot-idle { background: var(--idle); }

.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); display: grid; place-items: center; padding: 1rem; z-index: 10; }
.modal { width: min(520px, 100%); max-height: 90vh; overflow-y: auto; background: var(--panel); border-radius: 12px; padding: 1.25rem; display: grid; gap: 0.75rem; }
.row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.banner { position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 0.4rem 0.9rem; border-radius: 999px; }

.page { flex: 1; overflow-y: auto; padding: 1.5rem; display: grid; gap: 1.5rem; align-content: start; max-width: 860px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 1rem; display: grid; gap: 0.75rem; }
.table { width: 100%; border-collapse: collapse; }
.table td, .table th { text-align: left; padding: 0.4rem; border-bottom: 1px solid var(--border); }
.perm-grid { display: grid; grid-template-columns: 1fr auto; gap: 0.35rem 1rem; align-items: center; }

@media (max-width: 760px) {
  .members { display: none; }
  .sidebar { width: 190px; }
}
```

- [ ] **Step 5: Write the auth pages**

`clients/web/src/pages/AuthLayout.tsx`:

```tsx
import type { ReactNode } from "react";

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}
```

`clients/web/src/pages/Login.tsx`:

```tsx
import { unwrap } from "@datrope/core";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { client, deviceName, safeNext } from "../session";
import { Button, ErrorText, Field, useSubmit } from "../ui";
import { AuthLayout } from "./AuthLayout";

export function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();

  return (
    <AuthLayout title="Sign in">
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await unwrap(client.api.POST("/api/auth/login", {
            body: { login, password, device_name: deviceName(), client: "web" },
          }));
          nav(safeNext(params.get("next")), { replace: true });
        });
      }}>
        <Field label="Username or email" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <ErrorText error={error} />
        <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <p className="muted">New here? <Link to={`/register${location.search}`}>Create an account</Link></p>
    </AuthLayout>
  );
}
```

`clients/web/src/pages/Register.tsx`:

```tsx
import { unwrap, type InstanceInfo } from "@datrope/core";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { client, deviceName } from "../session";
import { Button, ErrorText, Field, useSubmit } from "../ui";
import { AuthLayout } from "./AuthLayout";

export function Register() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [info, setInfo] = useState<InstanceInfo>();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState(params.get("invite") ?? "");
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    unwrap(client.api.GET("/api/instance")).then(setInfo).catch(() => undefined);
  }, []);

  const first = info && !info.has_users;
  if (info?.has_users && info.registration_mode === "admin_only") {
    return (
      <AuthLayout title="Registration is closed">
        <p>Ask the admin of this server to create an account for you.</p>
        <Link to="/login">Sign in</Link>
      </AuthLayout>
    );
  }
  const needsInvite = info?.has_users && info.registration_mode === "invite_only";

  return (
    <AuthLayout title={first ? "Create the admin account" : "Create an account"}>
      {first && <p className="muted">You are the first person here, so this account will run the server.</p>}
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await unwrap(client.api.POST("/api/auth/register", {
            body: {
              username, password, device_name: deviceName(), client: "web",
              ...(email ? { email } : {}),
              ...(invite ? { invite_code: invite.trim().replace(/^.*\/invite\//, "") } : {}),
            },
          }));
          nav("/", { replace: true });
        });
      }}>
        <Field label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)}
          required minLength={2} maxLength={32} pattern="[A-Za-z0-9_.\-]+" hint="Letters, numbers, and _ . -" autoFocus />
        <Field label="Email (optional)" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
          required minLength={8} hint="At least 8 characters" />
        {(needsInvite || invite) && (
          <Field label="Invite code or link" value={invite} onChange={(e) => setInvite(e.target.value)} required={needsInvite} />
        )}
        <ErrorText error={error} />
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
      </form>
      <p className="muted">Already have an account? <Link to="/login">Sign in</Link></p>
    </AuthLayout>
  );
}
```

`clients/web/src/pages/Invite.tsx`:

```tsx
import { unwrap, type InvitePreview } from "@datrope/core";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { client } from "../session";
import { Button, ErrorText, useSubmit } from "../ui";
import { AuthLayout } from "./AuthLayout";

export function InvitePage() {
  const { code = "" } = useParams();
  const nav = useNavigate();
  const [preview, setPreview] = useState<InvitePreview | null>();
  const [signedIn, setSignedIn] = useState(false);
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    unwrap(client.api.GET("/api/invites/{code}", { params: { path: { code } } })).then(setPreview).catch(() => setPreview(null));
    unwrap(client.api.GET("/api/users/@me")).then(() => setSignedIn(true)).catch(() => setSignedIn(false));
  }, [code]);

  if (preview === undefined) return <AuthLayout title="Invite"><p className="muted">Loading…</p></AuthLayout>;
  if (preview === null) {
    return (
      <AuthLayout title="Invite not found">
        <p>This invite is invalid or has expired.</p>
        <Link to="/">Go home</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={`Join ${preview.community_name}`}>
      <p className="muted">{preview.member_count} {preview.member_count === 1 ? "member" : "members"}</p>
      {signedIn ? (
        <>
          <ErrorText error={error} />
          <Button disabled={busy} onClick={() => void run(async () => {
            await unwrap(client.api.POST("/api/invites/{code}/accept", { params: { path: { code } } }));
            nav(`/c/${preview.community_id}`);
          })}>Join community</Button>
        </>
      ) : (
        <div className="row">
          <Link className="btn btn-primary" to={`/register?invite=${encodeURIComponent(code)}`}>Create account</Link>
          <Link className="btn btn-ghost" to={`/login?next=${encodeURIComponent(`/invite/${code}`)}`}>Sign in</Link>
        </div>
      )}
    </AuthLayout>
  );
}
```

- [ ] **Step 6: Write the session guard, router, and entry point**

`clients/web/src/app/RequireSession.tsx`:

```tsx
import { unwrap } from "@datrope/core";
import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { client, savedPresence, useApp } from "../session";

/** Checks the session, then opens the gateway for everything below it. */
export function RequireSession() {
  const nav = useNavigate();
  const loc = useLocation();
  const [checked, setChecked] = useState(false);
  const ready = useApp((s) => s.me !== null);

  useEffect(() => {
    let cancelled = false;
    unwrap(client.api.GET("/api/users/@me"))
      .then(() => {
        if (cancelled) return;
        setChecked(true);
        client.connect(savedPresence());
      })
      .catch(() => {
        if (!cancelled) nav(`/login?next=${encodeURIComponent(loc.pathname)}`, { replace: true });
      });
    return () => {
      cancelled = true;
      client.disconnect();
    };
    // Run once per mount; navigation inside the app must not reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!checked || !ready) return <div className="center muted">Connecting…</div>;
  return <Outlet />;
}
```

`clients/web/src/router.tsx`:

```tsx
import { createBrowserRouter } from "react-router-dom";
import { RequireSession } from "./app/RequireSession";
import { InvitePage } from "./pages/Invite";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";

export const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  { path: "/register", element: <Register /> },
  { path: "/invite/:code", element: <InvitePage /> },
  {
    path: "/",
    element: <RequireSession />,
    children: [{ index: true, element: <p className="center">Signed in.</p> }], // replaced in Task 14
  },
]);
```

`clients/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

- [ ] **Step 7: Typecheck, lint, and build**

Run: `pnpm --filter @datrope/web build && pnpm lint`
Expected: build succeeds; no lint errors.

- [ ] **Step 8: Manual check**

Start a throwaway database and the server, then the web dev server:

```bash
docker run -d --name datrope-dev-db -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17-alpine
```

```bash
cd server && DATROPE_DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres?sslmode=disable DATROPE_PUBLIC_URL=http://localhost:5173 go run ./cmd/datrope
```

(PowerShell: set the two variables with `$env:NAME = "…"` first.)

```bash
pnpm --filter @datrope/web dev
```

Open http://localhost:5173/register: the page says "Create the admin account"; registering lands on "Signed in."; reloading stays signed in; http://localhost:5173/login with a wrong password shows "wrong username or password".

- [ ] **Step 9: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(web): scaffold, sign-in, registration, invite page`

---

### Task 14: Web chat — communities, channels, messages, DMs

The main app: community rail, channel list with unread state, message history with "load older", sending with optimistic pending messages, edit/delete, typing indicators, member list with presence, DMs, creating a community, and inviting people.

**Files:**
- Create: `clients/web/src/app/AppShell.tsx`, `CommunityRail.tsx`, `Home.tsx`, `CommunityView.tsx`, `ChannelSidebar.tsx`, `ChannelView.tsx`, `MessageList.tsx`, `Composer.tsx`, `MemberList.tsx`, `DMView.tsx`
- Create: `clients/web/src/app/dialogs/CreateCommunityDialog.tsx`, `InviteDialog.tsx`, `NewDMDialog.tsx`
- Modify: `clients/web/src/router.tsx`

**Interfaces:**
- Consumes: Task 13 `session.ts`, `ui.tsx`; core `DatropeClient` methods (`apply`, `loadOlder`, `send`, `ack`, `typing`), reducers `expireTyping`, `compareIds`, `Perm`, `hasPerm`.
- Produces: routes `/` (Home), `/c/:communityId/:channelId?`, `/dm/:channelId?`; `isUnread(readState)` exported from `ChannelSidebar.tsx`; `ChannelSidebar` props `{ communityId, activeId? }` (replaced wholesale in Task 15).

- [ ] **Step 1: Write the shell, rail, and home**

`clients/web/src/app/AppShell.tsx`:

```tsx
import { expireTyping } from "@datrope/core";
import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { client, useApp } from "../session";
import { CommunityRail } from "./CommunityRail";

export function AppShell() {
  const connection = useApp((s) => s.connection);
  useEffect(() => {
    const t = setInterval(() => client.store.setState((s) => expireTyping(s), true), 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="shell">
      <CommunityRail />
      <Outlet />
      {connection === "reconnecting" && <div className="banner" role="status">Reconnecting…</div>}
    </div>
  );
}
```

`clients/web/src/app/CommunityRail.tsx`:

```tsx
import { useState } from "react";
import { NavLink, useMatch } from "react-router-dom";
import { useApp } from "../session";
import { CreateCommunityDialog } from "./dialogs/CreateCommunityDialog";

const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

export function CommunityRail() {
  const order = useApp((s) => s.communityOrder);
  const communities = useApp((s) => s.communities);
  const inDMs = useMatch("/dm/*");
  const current = useMatch("/c/:communityId/*")?.params.communityId;
  const [creating, setCreating] = useState(false);

  return (
    <nav className="rail" aria-label="Communities">
      <NavLink to="/dm" className={`rail-item ${inDMs ? "active" : ""}`} title="Direct messages" aria-label="Direct messages">DM</NavLink>
      {order.map((id) => {
        const name = communities[id]?.community.name ?? "";
        return (
          <NavLink key={id} to={`/c/${id}`} className={`rail-item ${current === id ? "active" : ""}`} title={name} aria-label={name}>
            {initials(name)}
          </NavLink>
        );
      })}
      <button className="rail-item" onClick={() => setCreating(true)} title="Create a community" aria-label="Create a community">+</button>
      <div className="rail-spacer" />
      {creating && <CreateCommunityDialog onClose={() => setCreating(false)} />}
    </nav>
  );
}
```

`clients/web/src/app/Home.tsx`:

```tsx
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useApp } from "../session";
import { Button, Field } from "../ui";
import { CreateCommunityDialog } from "./dialogs/CreateCommunityDialog";

export function Home() {
  const first = useApp((s) => s.communityOrder[0]);
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [invite, setInvite] = useState("");
  if (first) return <Navigate to={`/c/${first}`} replace />;
  return (
    <main className="main center">
      <div className="card" style={{ maxWidth: 420 }}>
        <h2>Welcome to Datrope</h2>
        <p className="muted">Create a community, or join one with an invite link.</p>
        <Button onClick={() => setCreating(true)}>Create a community</Button>
        <form onSubmit={(e) => { e.preventDefault(); nav(`/invite/${invite.trim().replace(/^.*\/invite\//, "")}`); }}>
          <Field label="Invite link or code" value={invite} onChange={(e) => setInvite(e.target.value)} required />
          <Button variant="ghost" type="submit">Open invite</Button>
        </form>
      </div>
      {creating && <CreateCommunityDialog onClose={() => setCreating(false)} />}
    </main>
  );
}
```

- [ ] **Step 2: Write the dialogs**

`clients/web/src/app/dialogs/CreateCommunityDialog.tsx`:

```tsx
import { unwrap } from "@datrope/core";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { client } from "../../session";
import { Button, ErrorText, Field, Modal, useSubmit } from "../../ui";

export function CreateCommunityDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const { busy, error, run } = useSubmit();
  return (
    <Modal title="Create a community" onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const c = await unwrap(client.api.POST("/api/communities", { body: { name } }));
          client.apply("COMMUNITY_CREATE", c); // don't wait for the gateway event
          onClose();
          nav(`/c/${c.id}`);
        });
      }}>
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
        <ErrorText error={error} />
        <div className="row">
          <Button type="submit" disabled={busy}>Create</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}
```

`clients/web/src/app/dialogs/InviteDialog.tsx`:

```tsx
import { unwrap } from "@datrope/core";
import { useEffect, useState } from "react";
import { client, errorText } from "../../session";
import { Button, ErrorText, Modal } from "../../ui";

const WEEK = 7 * 24 * 3600;

export function InviteDialog({ communityId, onClose }: { communityId: string; onClose: () => void }) {
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    unwrap(client.api.POST("/api/communities/{id}/invites", {
      params: { path: { id: communityId } },
      body: { expires_in_seconds: WEEK },
    }))
      .then((inv) => setLink(`${location.origin}/invite/${inv.code}`))
      .catch((e) => setError(errorText(e)));
  }, [communityId]);

  return (
    <Modal title="Invite people" onClose={onClose}>
      <p className="muted">Anyone with this link can join for the next 7 days.</p>
      {link && (
        <div className="row">
          <input readOnly value={link} aria-label="Invite link" style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
          <Button onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
      <ErrorText error={error} />
      <Button variant="ghost" onClick={onClose}>Done</Button>
    </Modal>
  );
}
```

`clients/web/src/app/dialogs/NewDMDialog.tsx`:

```tsx
import { unwrap, type PublicUser } from "@datrope/core";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { client, displayName, useApp } from "../../session";
import { Button, ErrorText, Modal, useSubmit } from "../../ui";

export function NewDMDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const communities = useApp((s) => s.communities);
  const me = useApp((s) => s.me);
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, error, run } = useSubmit();

  const people = useMemo(() => {
    const seen = new Map<string, PublicUser>();
    for (const cs of Object.values(communities)) {
      for (const m of Object.values(cs.members)) if (m.user.id !== me?.id) seen.set(m.user.id, m.user);
    }
    return [...seen.values()].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [communities, me]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 9 ? [...p, id] : p));

  return (
    <Modal title="New message" onClose={onClose}>
      {people.length === 0 && <p className="muted">Join a community to find people to message.</p>}
      <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 300, overflowY: "auto" }}>
        {people.map((u) => (
          <li key={u.id}>
            <label className="row">
              <input type="checkbox" checked={picked.includes(u.id)} onChange={() => toggle(u.id)} />
              {displayName(u)} <span className="muted">@{u.username}</span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
      <div className="row">
        <Button disabled={busy || picked.length === 0} onClick={() => void run(async () => {
          const ch = await unwrap(client.api.POST("/api/dms", { body: { recipient_ids: picked } }));
          client.apply("CHANNEL_CREATE", ch);
          onClose();
          nav(`/dm/${ch.id}`);
        })}>Start conversation</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3: Write the community and DM views**

`clients/web/src/app/ChannelSidebar.tsx`:

```tsx
import { Perm, compareIds, hasPerm } from "@datrope/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { usePerms, useApp } from "../session";
import { Button } from "../ui";
import { InviteDialog } from "./dialogs/InviteDialog";

export function isUnread(rs?: { lastReadId?: string; lastMessageId?: string }): boolean {
  return !!rs?.lastMessageId && (!rs.lastReadId || compareIds(rs.lastMessageId, rs.lastReadId) > 0);
}

export function ChannelSidebar({ communityId, activeId }: { communityId: string; activeId?: string }) {
  const cs = useApp((s) => s.communities[communityId]);
  const channels = useApp((s) => s.channels);
  const readStates = useApp((s) => s.readStates);
  const perms = usePerms(communityId);
  const [inviting, setInviting] = useState(false);
  if (!cs) return null;
  return (
    <nav className="sidebar" aria-label="Channels">
      <header className="sidebar-header">
        <h1 title={cs.community.name}>{cs.community.name}</h1>
        {hasPerm(perms, Perm.CreateInvite) && <Button variant="ghost" onClick={() => setInviting(true)}>Invite</Button>}
      </header>
      <ul className="channel-list">
        {cs.channelIds.map((id) => {
          const ch = channels[id];
          if (!ch) return null;
          return (
            <li key={id} className="channel-row">
              {ch.type === "voice" ? (
                <span className="channel disabled" title="Voice channels arrive in a later version">🔊 {ch.name}</span>
              ) : (
                <Link to={`/c/${communityId}/${id}`}
                  className={`channel ${id === activeId ? "active" : ""} ${isUnread(readStates[id]) ? "unread" : ""}`}
                  aria-current={id === activeId ? "page" : undefined}># {ch.name}</Link>
              )}
            </li>
          );
        })}
      </ul>
      {inviting && <InviteDialog communityId={communityId} onClose={() => setInviting(false)} />}
    </nav>
  );
}
```

`clients/web/src/app/CommunityView.tsx`:

```tsx
import { Navigate, useParams } from "react-router-dom";
import { useApp } from "../session";
import { ChannelSidebar } from "./ChannelSidebar";
import { ChannelView } from "./ChannelView";
import { MemberList } from "./MemberList";

export function CommunityView() {
  const { communityId = "", channelId } = useParams();
  const exists = useApp((s) => !!s.communities[communityId]);
  const firstText = useApp((s) => s.communities[communityId]?.channelIds.find((id) => s.channels[id]?.type === "text"));
  if (!exists) return <main className="main center muted">This community is not available.</main>;
  if (!channelId && firstText) return <Navigate to={`/c/${communityId}/${firstText}`} replace />;
  return (
    <>
      <ChannelSidebar communityId={communityId} activeId={channelId} />
      {channelId
        ? <ChannelView key={channelId} channelId={channelId} communityId={communityId} />
        : <main className="main center muted">No channels yet.</main>}
      <MemberList communityId={communityId} />
    </>
  );
}
```

`clients/web/src/app/DMView.tsx`:

```tsx
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { dmName, useApp } from "../session";
import { Button } from "../ui";
import { ChannelView } from "./ChannelView";
import { isUnread } from "./ChannelSidebar";
import { NewDMDialog } from "./dialogs/NewDMDialog";

export function DMView() {
  const { channelId } = useParams();
  const dmIds = useApp((s) => s.dmIds);
  const channels = useApp((s) => s.channels);
  const readStates = useApp((s) => s.readStates);
  const me = useApp((s) => s.me);
  const [picking, setPicking] = useState(false);
  return (
    <>
      <nav className="sidebar" aria-label="Direct messages">
        <header className="sidebar-header">
          <h1>Direct messages</h1>
          <Button variant="ghost" onClick={() => setPicking(true)}>New</Button>
        </header>
        <ul className="channel-list">
          {dmIds.map((id) => (
            <li key={id} className="channel-row">
              <Link to={`/dm/${id}`} className={`channel ${id === channelId ? "active" : ""} ${isUnread(readStates[id]) ? "unread" : ""}`}>
                {dmName(channels[id], me?.id)}
              </Link>
            </li>
          ))}
        </ul>
        {picking && <NewDMDialog onClose={() => setPicking(false)} />}
      </nav>
      {channelId
        ? <ChannelView key={channelId} channelId={channelId} />
        : <main className="main center muted">Pick a conversation or start a new one.</main>}
    </>
  );
}
```

- [ ] **Step 4: Write the channel view, message list, composer, and member list**

`clients/web/src/app/ChannelView.tsx`:

```tsx
import { Perm, hasPerm } from "@datrope/core";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { client, dmName, errorText, useApp, usePerms, userName } from "../session";
import { ErrorText } from "../ui";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

export function ChannelView({ channelId, communityId }: { channelId: string; communityId?: string }) {
  const ch = useApp((s) => s.channels[channelId]);
  const me = useApp((s) => s.me);
  const loaded = useApp((s) => !!s.messages[channelId]);
  const lastId = useApp((s) => s.messages[channelId]?.items.filter((m) => !m.pending).at(-1)?.id);
  const perms = usePerms(communityId, channelId);
  const [loadError, setLoadError] = useState<string>();

  // Load the first page, and again if a fresh READY (after a long disconnect) cleared it.
  useEffect(() => {
    if (!loaded) client.loadOlder(channelId).catch((e) => setLoadError(errorText(e)));
  }, [channelId, loaded]);

  // Mark as read while the tab is visible.
  useEffect(() => {
    if (!lastId) return;
    const ack = () => {
      if (document.visibilityState === "visible") client.ack(channelId, lastId).catch(() => undefined);
    };
    ack();
    document.addEventListener("visibilitychange", ack);
    return () => document.removeEventListener("visibilitychange", ack);
  }, [channelId, lastId]);

  if (!ch) return <main className="main center muted">This channel is not available.</main>;
  const title = ch.type === "dm" ? dmName(ch, me?.id) : `# ${ch.name}`;
  return (
    <main className="main" aria-label={title}>
      <header className="main-header"><h2>{title}</h2></header>
      {loadError ? <ErrorText error={loadError} /> : <MessageList channelId={channelId} canManage={hasPerm(perms, Perm.ManageMessages)} />}
      <TypingLine channelId={channelId} />
      <Composer channelId={channelId} canSend={hasPerm(perms, Perm.SendMessages)}
        placeholder={ch.type === "dm" ? `Message ${dmName(ch, me?.id)}` : `Message #${ch.name}`} />
    </main>
  );
}

function TypingLine({ channelId }: { channelId: string }) {
  const names = useApp(useShallow((s) => Object.keys(s.typing[channelId] ?? {}).map((id) => userName(s, id))));
  return (
    <div className="typing" aria-live="polite">
      {names.length > 0 ? `${names.join(", ")} ${names.length === 1 ? "is" : "are"} typing…` : " "}
    </div>
  );
}
```

`clients/web/src/app/MessageList.tsx`:

```tsx
import { unwrap, type ClientMessage } from "@datrope/core";
import { useEffect, useRef, useState } from "react";
import { client, displayName, errorText, useApp } from "../session";
import { Button, ErrorText } from "../ui";

const FIVE_MINUTES = 5 * 60 * 1000;
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

export function MessageList({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const list = useApp((s) => s.messages[channelId]);
  const meId = useApp((s) => s.me?.id);
  const bottom = useRef<HTMLDivElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lastId = list?.items.at(-1)?.id;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lastId]);

  if (!list) return <div className="messages center muted">Loading…</div>;
  return (
    <div className="messages" role="log" aria-label="Messages">
      {list.hasMore && (
        <Button variant="ghost" disabled={loadingOlder} onClick={async () => {
          setLoadingOlder(true);
          try {
            await client.loadOlder(channelId);
          } finally {
            setLoadingOlder(false);
          }
        }}>{loadingOlder ? "Loading…" : "Load older messages"}</Button>
      )}
      {list.items.length === 0 && <p className="center muted">No messages yet. Say hi!</p>}
      {list.items.map((m, i) => {
        const prev = list.items[i - 1];
        const grouped = !!prev && prev.author.id === m.author.id && !prev.deleted &&
          Date.parse(m.created_at) - Date.parse(prev.created_at) < FIVE_MINUTES;
        return <MessageRow key={m.id} m={m} grouped={grouped} mine={m.author.id === meId} canManage={canManage} />;
      })}
      <div ref={bottom} />
    </div>
  );
}

function MessageRow({ m, grouped, mine, canManage }: { m: ClientMessage; grouped: boolean; mine: boolean; canManage: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [error, setError] = useState<string>();
  const path = { params: { path: { id: m.channel_id, messageID: m.id } } };

  const save = async () => {
    try {
      await unwrap(client.api.PATCH("/api/channels/{id}/messages/{messageID}", { ...path, body: { content: draft } }));
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const remove = async () => {
    if (!window.confirm("Delete this message?")) return;
    try {
      await unwrap(client.api.DELETE("/api/channels/{id}/messages/{messageID}", path));
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <article className={`msg ${grouped ? "grouped" : ""} ${m.pending ? "pending" : ""}`}>
      {!grouped && (
        <header>
          <strong>{displayName(m.author)}</strong>
          <time dateTime={m.created_at}>{timeFormat.format(new Date(m.created_at))}</time>
        </header>
      )}
      {m.deleted ? (
        <p className="msg-body muted"><em>Message deleted</em></p>
      ) : editing ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={4000} aria-label="Edit message" style={{ flex: 1 }} />
          <button className="btn btn-primary" type="submit">Save</button>
          <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      ) : (
        <p className="msg-body">{m.content}{m.edited_at && <span className="muted"> (edited)</span>}</p>
      )}
      {m.failed && <p className="error">Not sent.</p>}
      {!m.pending && !m.deleted && !editing && (mine || canManage) && (
        <div className="msg-actions">
          {mine && <button className="icon-btn" onClick={() => { setDraft(m.content); setEditing(true); }}>Edit</button>}
          <button className="icon-btn" onClick={() => void remove()}>Delete</button>
        </div>
      )}
      <ErrorText error={error} />
    </article>
  );
}
```

`clients/web/src/app/Composer.tsx`:

```tsx
import { useState } from "react";
import { client, errorText } from "../session";
import { Button, ErrorText } from "../ui";

export function Composer({ channelId, canSend, placeholder }: { channelId: string; canSend: boolean; placeholder: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  if (!canSend) return <div className="composer muted">You can't send messages here.</div>;

  const submit = () => {
    const content = text.trim();
    if (!content) return;
    setText("");
    setError(undefined);
    client.send(channelId, content).catch((e) => setError(errorText(e)));
  };

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea value={text} placeholder={placeholder} aria-label="Message" maxLength={4000} rows={1}
        onChange={(e) => {
          setText(e.target.value);
          client.typing(channelId).catch(() => undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }} />
      <Button type="submit" disabled={!text.trim()}>Send</Button>
      <ErrorText error={error} />
    </form>
  );
}
```

`clients/web/src/app/MemberList.tsx`:

```tsx
import { useMemo } from "react";
import { displayName, useApp } from "../session";
import { PresenceDot } from "../ui";

const rank: Record<string, number> = { online: 2, idle: 1 };

export function MemberList({ communityId }: { communityId: string }) {
  const members = useApp((s) => s.communities[communityId]?.members);
  const presences = useApp((s) => s.presences);
  const sorted = useMemo(
    () => Object.values(members ?? {}).sort((a, b) =>
      (rank[presences[b.user.id] ?? ""] ?? 0) - (rank[presences[a.user.id] ?? ""] ?? 0) ||
      displayName(a.user).localeCompare(displayName(b.user))),
    [members, presences],
  );
  return (
    <aside className="members" aria-label="Members">
      <h3>Members — {sorted.length}</h3>
      <ul>
        {sorted.map((m) => (
          <li key={m.user.id}>
            <PresenceDot status={presences[m.user.id]} />
            <span>{displayName(m.user)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 5: Add the routes** — in `clients/web/src/router.tsx`

Replace the `children` of the `/` route with:

```tsx
    children: [{
      element: <AppShell />,
      children: [
        { index: true, element: <Home /> },
        { path: "dm/:channelId?", element: <DMView /> },
        { path: "c/:communityId/:channelId?", element: <CommunityView /> },
      ],
    }],
```

and add the imports for `AppShell`, `Home`, `DMView`, `CommunityView` from `./app/…`.

- [ ] **Step 6: Typecheck, lint, and build**

Run: `pnpm --filter @datrope/web build && pnpm lint`
Expected: success.

- [ ] **Step 7: Manual check** (same dev setup as Task 13 Step 8; use a second browser profile or a private window for the second user)

1. As the admin, create a community "Test" → you land in `#general`.
2. Click **Invite**, copy the link, open it in the private window, create a second account from it → it lands in "Test".
3. Send messages both ways: they appear instantly on both sides; the sender's message is briefly faded (pending) then solid.
4. Type in one window → "… is typing…" appears in the other and disappears after ~10 s.
5. Both users show a green dot in the member list; closing the private window turns that user grey.
6. Edit and delete your own message; the other window updates. Reload: history loads, deleted shows "Message deleted".
7. DM: **DM → New**, pick the other user, send a message; it appears in their DM list in bold (unread) until opened.
8. Stop the Go server for a few seconds: "Reconnecting…" shows; restart it: the banner disappears and messages work again.

- [ ] **Step 8: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(web): chat UI — communities, channels, messages, DMs`

---

### Task 15: Web management — channels, permissions, community, account, admin

Everything that changes configuration: creating and editing channels, channel permission overrides, the community settings page (overview, roles, members, invites, bans, leaving), the user's settings (display name, presence, sessions, sign out), and the instance admin page.

**Files:**
- Create: `clients/web/src/permLabels.ts`
- Create: `clients/web/src/app/dialogs/CreateChannelDialog.tsx`, `ChannelSettingsDialog.tsx`
- Create: `clients/web/src/app/settings/CommunitySettings.tsx`, `UserSettings.tsx`, `AdminSettings.tsx`
- Replace: `clients/web/src/app/ChannelSidebar.tsx`
- Modify: `clients/web/src/app/CommunityRail.tsx`, `clients/web/src/router.tsx`

**Interfaces:**
- Consumes: Tasks 13–14 (`session.ts`, `ui.tsx`, `isUnread`, `InviteDialog`), core `Perm`, `hasPerm`, `ALL_PERMS`, `basePerms`, types; server endpoints from Tasks 5–9.
- Produces: routes `/settings`, `/admin`, `/c/:communityId/settings`; `PERM_LABELS` (`{ flag, label, channel }[]`).

- [ ] **Step 1: Write `clients/web/src/permLabels.ts`**

```ts
import { Perm } from "@datrope/core";

/** Every permission, in display order. `channel` = meaningful in a channel override. */
export const PERM_LABELS: { flag: number; label: string; channel: boolean }[] = [
  { flag: Perm.ViewChannel, label: "View channels", channel: true },
  { flag: Perm.SendMessages, label: "Send messages", channel: true },
  { flag: Perm.AttachFiles, label: "Attach files", channel: true },
  { flag: Perm.ReadHistory, label: "Read message history", channel: true },
  { flag: Perm.ConnectVoice, label: "Connect to voice", channel: true },
  { flag: Perm.Speak, label: "Speak", channel: true },
  { flag: Perm.Stream, label: "Video and screen share", channel: true },
  { flag: Perm.ManageMessages, label: "Manage messages", channel: true },
  { flag: Perm.MuteMembers, label: "Mute members", channel: true },
  { flag: Perm.MoveMembers, label: "Move members", channel: true },
  { flag: Perm.Kick, label: "Kick members", channel: false },
  { flag: Perm.Ban, label: "Ban members", channel: false },
  { flag: Perm.CreateInvite, label: "Create invites", channel: false },
  { flag: Perm.ManageRoles, label: "Manage roles and permissions", channel: true },
  { flag: Perm.ManageChannels, label: "Manage channels", channel: true },
  { flag: Perm.ManageCommunity, label: "Manage community", channel: false },
  { flag: Perm.Admin, label: "Administrator (every permission)", channel: false },
];
```

- [ ] **Step 2: Write the channel dialogs**

`clients/web/src/app/dialogs/CreateChannelDialog.tsx`:

```tsx
import { unwrap } from "@datrope/core";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { client } from "../../session";
import { Button, ErrorText, Field, Modal, useSubmit } from "../../ui";

export function CreateChannelDialog({ communityId, onClose }: { communityId: string; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [type, setType] = useState<"text" | "voice">("text");
  const { busy, error, run } = useSubmit();
  return (
    <Modal title="Create a channel" onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const ch = await unwrap(client.api.POST("/api/communities/{id}/channels", {
            params: { path: { id: communityId } }, body: { name, type },
          }));
          client.apply("CHANNEL_CREATE", ch);
          onClose();
          if (type === "text") nav(`/c/${communityId}/${ch.id}`);
        });
      }}>
        <fieldset className="row" style={{ border: 0, padding: 0 }}>
          <legend className="muted">Type</legend>
          <label><input type="radio" checked={type === "text"} onChange={() => setType("text")} /> Text</label>
          <label><input type="radio" checked={type === "voice"} onChange={() => setType("voice")} /> Voice</label>
        </fieldset>
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
        <ErrorText error={error} />
        <div className="row">
          <Button type="submit" disabled={busy}>Create</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}
```

`clients/web/src/app/dialogs/ChannelSettingsDialog.tsx`:

```tsx
import { unwrap, type Channel, type Override } from "@datrope/core";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PERM_LABELS } from "../../permLabels";
import { client, displayName, useApp } from "../../session";
import { Button, ErrorText, Field, Modal, useSubmit } from "../../ui";

type Tri = "inherit" | "allow" | "deny";

export function ChannelSettingsDialog({ channelId, communityId, onClose }:
  { channelId: string; communityId: string; onClose: () => void }) {
  const ch = useApp((s) => s.channels[channelId]);
  const [tab, setTab] = useState<"general" | "permissions">("general");
  if (!ch) return null;
  return (
    <Modal title={`#${ch.name} settings`} onClose={onClose}>
      <div className="row" role="tablist">
        <Button variant={tab === "general" ? "primary" : "ghost"} role="tab" aria-selected={tab === "general"} onClick={() => setTab("general")}>General</Button>
        <Button variant={tab === "permissions" ? "primary" : "ghost"} role="tab" aria-selected={tab === "permissions"} onClick={() => setTab("permissions")}>Permissions</Button>
      </div>
      {tab === "general"
        ? <General ch={ch} communityId={communityId} onClose={onClose} />
        : <Permissions ch={ch} communityId={communityId} />}
    </Modal>
  );
}

function General({ ch, communityId, onClose }: { ch: Channel; communityId: string; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState(ch.name);
  const { busy, error, run } = useSubmit();
  const path = { params: { path: { id: ch.id } } };
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        client.apply("CHANNEL_UPDATE", await unwrap(client.api.PATCH("/api/channels/{id}", { ...path, body: { name } })));
        onClose();
      });
    }}>
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      <ErrorText error={error} />
      <div className="row">
        <Button type="submit" disabled={busy}>Save</Button>
        <Button variant="danger" disabled={busy} onClick={() => {
          if (!window.confirm(`Delete #${ch.name} and all its messages?`)) return;
          void run(async () => {
            await unwrap(client.api.DELETE("/api/channels/{id}", path));
            client.apply("CHANNEL_DELETE", { id: ch.id, community_id: communityId });
            onClose();
            nav(`/c/${communityId}`);
          });
        }}>Delete channel</Button>
      </div>
    </form>
  );
}

function Permissions({ ch, communityId }: { ch: Channel; communityId: string }) {
  const cs = useApp((s) => s.communities[communityId]);
  const [target, setTarget] = useState(`role:${communityId}`);
  const [targetType, targetId] = target.split(":") as ["role" | "member", string];
  const existing = ch.overrides.find((o) => o.target_type === targetType && o.target_id === targetId);
  const [draft, setDraft] = useState<Record<number, Tri>>(() => toTri(existing));
  const { busy, error, run } = useSubmit();

  const targets = useMemo(() => [
    ...Object.values(cs?.roles ?? {}).sort((a, b) => a.position - b.position)
      .map((r) => ({ key: `role:${r.id}`, label: r.name })),
    ...Object.values(cs?.members ?? {}).map((m) => ({ key: `member:${m.user.id}`, label: `@${displayName(m.user)}` })),
  ], [cs]);

  const pick = (key: string) => {
    const [t, i] = key.split(":");
    setTarget(key);
    setDraft(toTri(ch.overrides.find((o) => o.target_type === t && o.target_id === i)));
  };
  const path = { params: { path: { id: ch.id, targetType, targetID: targetId } } };

  return (
    <div className="card">
      <label className="field">
        <span>Role or member</span>
        <select value={target} onChange={(e) => pick(e.target.value)}>
          {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </label>
      <div className="perm-grid">
        {PERM_LABELS.filter((p) => p.channel).map((p) => (
          <label key={p.flag} style={{ display: "contents" }}>
            <span>{p.label}</span>
            <select value={draft[p.flag] ?? "inherit"} onChange={(e) => setDraft({ ...draft, [p.flag]: e.target.value as Tri })}>
              <option value="inherit">Inherit</option>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </select>
          </label>
        ))}
      </div>
      <ErrorText error={error} />
      <div className="row">
        <Button disabled={busy} onClick={() => void run(async () => {
          const allow = sum(draft, "allow");
          const deny = sum(draft, "deny");
          client.apply("CHANNEL_UPDATE", await unwrap(client.api.PUT("/api/channels/{id}/overrides/{targetType}/{targetID}", { ...path, body: { allow, deny } })));
        })}>Save permissions</Button>
        {existing && (
          <Button variant="ghost" disabled={busy} onClick={() => void run(async () => {
            await unwrap(client.api.DELETE("/api/channels/{id}/overrides/{targetType}/{targetID}", path));
            client.apply("CHANNEL_UPDATE", { ...ch, overrides: ch.overrides.filter((o) => o !== existing) });
            setDraft({});
          })}>Reset to inherit</Button>
        )}
      </div>
    </div>
  );
}

function toTri(o?: Override): Record<number, Tri> {
  const out: Record<number, Tri> = {};
  for (const p of PERM_LABELS) {
    if (o && o.allow & p.flag) out[p.flag] = "allow";
    else if (o && o.deny & p.flag) out[p.flag] = "deny";
  }
  return out;
}

function sum(draft: Record<number, Tri>, want: Tri): number {
  return Object.entries(draft).reduce((acc, [flag, v]) => (v === want ? acc | Number(flag) : acc), 0);
}
```

- [ ] **Step 3: Replace `clients/web/src/app/ChannelSidebar.tsx`**

```tsx
import { Perm, channelPerms, compareIds, hasPerm } from "@datrope/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp, usePerms } from "../session";
import { Button } from "../ui";
import { ChannelSettingsDialog } from "./dialogs/ChannelSettingsDialog";
import { CreateChannelDialog } from "./dialogs/CreateChannelDialog";
import { InviteDialog } from "./dialogs/InviteDialog";

export function isUnread(rs?: { lastReadId?: string; lastMessageId?: string }): boolean {
  return !!rs?.lastMessageId && (!rs.lastReadId || compareIds(rs.lastMessageId, rs.lastReadId) > 0);
}

export function ChannelSidebar({ communityId, activeId }: { communityId: string; activeId?: string }) {
  const cs = useApp((s) => s.communities[communityId]);
  const channels = useApp((s) => s.channels);
  const readStates = useApp((s) => s.readStates);
  const me = useApp((s) => s.me);
  const perms = usePerms(communityId);
  const [dialog, setDialog] = useState<{ kind: "invite" } | { kind: "create" } | { kind: "settings"; channelId: string }>();
  if (!cs || !me) return null;
  const roles = Object.values(cs.roles);
  const roleIds = cs.members[me.id]?.role_ids ?? [];
  const close = () => setDialog(undefined);

  return (
    <nav className="sidebar" aria-label="Channels">
      <header className="sidebar-header">
        <h1 title={cs.community.name}>{cs.community.name}</h1>
        <div className="row">
          {hasPerm(perms, Perm.CreateInvite) && <Button variant="ghost" onClick={() => setDialog({ kind: "invite" })}>Invite</Button>}
          {/* Every member can open settings: it always offers "Leave community". */}
          <Link className="icon-btn" to={`/c/${communityId}/settings`} aria-label="Community settings" title="Community settings">⚙</Link>
        </div>
      </header>
      <ul className="channel-list">
        {cs.channelIds.map((id) => {
          const ch = channels[id];
          if (!ch) return null;
          const canManage = hasPerm(channelPerms(cs.community, roles, me.id, roleIds, ch), Perm.ManageChannels);
          return (
            <li key={id} className="channel-row">
              {ch.type === "voice" ? (
                <span className="channel disabled" title="Voice channels arrive in a later version">🔊 {ch.name}</span>
              ) : (
                <Link to={`/c/${communityId}/${id}`}
                  className={`channel ${id === activeId ? "active" : ""} ${isUnread(readStates[id]) ? "unread" : ""}`}
                  aria-current={id === activeId ? "page" : undefined}># {ch.name}</Link>
              )}
              {canManage && (
                <button className="icon-btn" aria-label={`Settings for ${ch.name}`} title="Channel settings"
                  onClick={() => setDialog({ kind: "settings", channelId: id })}>⚙</button>
              )}
            </li>
          );
        })}
      </ul>
      {hasPerm(perms, Perm.ManageChannels) && (
        <div style={{ padding: "0.5rem" }}>
          <Button variant="ghost" onClick={() => setDialog({ kind: "create" })}>+ Add channel</Button>
        </div>
      )}
      {dialog?.kind === "invite" && <InviteDialog communityId={communityId} onClose={close} />}
      {dialog?.kind === "create" && <CreateChannelDialog communityId={communityId} onClose={close} />}
      {dialog?.kind === "settings" && <ChannelSettingsDialog channelId={dialog.channelId} communityId={communityId} onClose={close} />}
    </nav>
  );
}
```

- [ ] **Step 4: Write `clients/web/src/app/settings/CommunitySettings.tsx`**

```tsx
import { ALL_PERMS, Perm, hasPerm, unwrap, type Ban, type Invite, type Role } from "@datrope/core";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PERM_LABELS } from "../../permLabels";
import { client, displayName, errorText, useApp, usePerms } from "../../session";
import { Button, ErrorText, Field, useSubmit } from "../../ui";

export function CommunitySettings() {
  const { communityId = "" } = useParams();
  const cs = useApp((s) => s.communities[communityId]);
  const me = useApp((s) => s.me);
  const perms = usePerms(communityId);
  if (!cs || !me) return <main className="main center muted">This community is not available.</main>;
  const isOwner = cs.community.owner_id === me.id;
  return (
    <main className="main">
      <header className="main-header row">
        <Link to={`/c/${communityId}`}>← Back</Link>
        <h2>{cs.community.name} settings</h2>
      </header>
      <div className="page">
        {hasPerm(perms, Perm.ManageCommunity) && <Overview communityId={communityId} isOwner={isOwner} />}
        {hasPerm(perms, Perm.ManageRoles) && <Roles communityId={communityId} perms={perms} />}
        {(hasPerm(perms, Perm.Kick) || hasPerm(perms, Perm.Ban) || hasPerm(perms, Perm.ManageRoles)) &&
          <Members communityId={communityId} perms={perms} />}
        {hasPerm(perms, Perm.ManageCommunity) && <Invites communityId={communityId} />}
        {hasPerm(perms, Perm.Ban) && <Bans communityId={communityId} />}
        {!isOwner && <Leave communityId={communityId} />}
      </div>
    </main>
  );
}

function Overview({ communityId, isOwner }: { communityId: string; isOwner: boolean }) {
  const nav = useNavigate();
  const current = useApp((s) => s.communities[communityId]?.community.name ?? "");
  const [name, setName] = useState(current);
  const { busy, error, run } = useSubmit();
  const path = { params: { path: { id: communityId } } };
  return (
    <section className="card" aria-label="Overview">
      <h3>Overview</h3>
      <form className="row" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          client.apply("COMMUNITY_UPDATE", await unwrap(client.api.PATCH("/api/communities/{id}", { ...path, body: { name } })));
        });
      }}>
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        <Button type="submit" disabled={busy}>Save</Button>
      </form>
      {isOwner && (
        <Button variant="danger" disabled={busy} onClick={() => {
          if (!window.confirm(`Delete ${current} for everyone? This cannot be undone.`)) return;
          void run(async () => {
            await unwrap(client.api.DELETE("/api/communities/{id}", path));
            client.apply("COMMUNITY_DELETE", { id: communityId });
            nav("/");
          });
        }}>Delete community</Button>
      )}
      <ErrorText error={error} />
    </section>
  );
}

function Roles({ communityId, perms }: { communityId: string; perms: number }) {
  const roles = useApp((s) => s.communities[communityId]?.roles);
  const sorted = Object.values(roles ?? {}).sort((a, b) => a.position - b.position);
  const [selected, setSelected] = useState(communityId);
  const role = roles?.[selected];
  const { busy, error, run } = useSubmit();
  return (
    <section className="card" aria-label="Roles">
      <h3>Roles</h3>
      <div className="row">
        {sorted.map((r) => (
          <Button key={r.id} variant={r.id === selected ? "primary" : "ghost"} onClick={() => setSelected(r.id)}>{r.name}</Button>
        ))}
        <Button variant="ghost" disabled={busy} onClick={() => void run(async () => {
          const r = await unwrap(client.api.POST("/api/communities/{id}/roles", {
            params: { path: { id: communityId } }, body: { name: "New role", permissions: 0 },
          }));
          client.apply("ROLE_CREATE", r);
          setSelected(r.id);
        })}>+ New role</Button>
      </div>
      <ErrorText error={error} />
      {role && <RoleEditor key={role.id} role={role} isEveryone={role.id === communityId} myPerms={perms} />}
    </section>
  );
}

function RoleEditor({ role, isEveryone, myPerms }: { role: Role; isEveryone: boolean; myPerms: number }) {
  const [name, setName] = useState(role.name);
  const [mask, setMask] = useState(role.permissions);
  const { busy, error, run } = useSubmit();
  const path = { params: { path: { id: role.community_id, roleID: role.id } } };
  const canEdit = hasPerm(myPerms, role.permissions);
  return (
    <form className="card" onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        client.apply("ROLE_UPDATE", await unwrap(client.api.PATCH("/api/communities/{id}/roles/{roleID}", {
          ...path, body: { ...(isEveryone ? {} : { name }), permissions: mask },
        })));
      });
    }}>
      {!isEveryone && <Field label="Role name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={32} />}
      {!canEdit && <p className="muted">This role has permissions you don't have, so you can't edit it.</p>}
      <div className="perm-grid">
        {PERM_LABELS.map((p) => (
          <label key={p.flag} style={{ display: "contents" }}>
            <span>{p.label}</span>
            <input type="checkbox" checked={hasPerm(mask, p.flag)} disabled={!canEdit || !hasPerm(myPerms, p.flag)}
              onChange={(e) => setMask(e.target.checked ? mask | p.flag : mask & ~p.flag & ALL_PERMS)} />
          </label>
        ))}
      </div>
      <ErrorText error={error} />
      <div className="row">
        <Button type="submit" disabled={busy || !canEdit}>Save role</Button>
        {!isEveryone && (
          <Button variant="danger" disabled={busy || !canEdit} onClick={() => {
            if (!window.confirm(`Delete the ${role.name} role?`)) return;
            void run(async () => {
              await unwrap(client.api.DELETE("/api/communities/{id}/roles/{roleID}", path));
              client.apply("ROLE_DELETE", { community_id: role.community_id, id: role.id });
            });
          }}>Delete role</Button>
        )}
      </div>
    </form>
  );
}

function Members({ communityId, perms }: { communityId: string; perms: number }) {
  const cs = useApp((s) => s.communities[communityId]);
  const me = useApp((s) => s.me);
  const [error, setError] = useState<string>();
  if (!cs) return null;
  const roles = Object.values(cs.roles).filter((r) => r.id !== communityId).sort((a, b) => a.position - b.position);
  const act = (fn: () => Promise<unknown>) => fn().catch((e) => setError(errorText(e)));

  return (
    <section className="card" aria-label="Members">
      <h3>Members</h3>
      <ErrorText error={error} />
      <table className="table">
        <tbody>
          {Object.values(cs.members).map((m) => {
            const isOwner = m.user.id === cs.community.owner_id;
            const memberPath = { params: { path: { id: communityId, userID: m.user.id } } };
            return (
              <tr key={m.user.id}>
                <td>{displayName(m.user)} <span className="muted">@{m.user.username}</span>{isOwner && " (owner)"}</td>
                <td>
                  {hasPerm(perms, Perm.ManageRoles) && roles.map((r) => (
                    <label key={r.id} className="row" style={{ display: "inline-flex", marginRight: "0.5rem" }}>
                      <input type="checkbox" checked={m.role_ids.includes(r.id)} disabled={!hasPerm(perms, r.permissions)}
                        onChange={(e) => {
                          const route = "/api/communities/{id}/members/{userID}/roles/{roleID}";
                          const init = { params: { path: { id: communityId, userID: m.user.id, roleID: r.id } } };
                          void act(() => unwrap(e.target.checked ? client.api.PUT(route, init) : client.api.DELETE(route, init)));
                        }} />
                      {r.name}
                    </label>
                  ))}
                </td>
                <td className="row">
                  {!isOwner && m.user.id !== me?.id && hasPerm(perms, Perm.Kick) && (
                    <Button variant="ghost" onClick={() => window.confirm(`Kick ${displayName(m.user)}?`) &&
                      act(() => unwrap(client.api.DELETE("/api/communities/{id}/members/{userID}", memberPath)))}>Kick</Button>
                  )}
                  {!isOwner && m.user.id !== me?.id && hasPerm(perms, Perm.Ban) && (
                    <Button variant="danger" onClick={() => window.confirm(`Ban ${displayName(m.user)}?`) &&
                      act(() => unwrap(client.api.PUT("/api/communities/{id}/bans/{userID}", { ...memberPath, body: {} })))}>Ban</Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Invites({ communityId }: { communityId: string }) {
  const [invites, setInvites] = useState<Invite[]>();
  const [error, setError] = useState<string>();
  const load = () => unwrap(client.api.GET("/api/communities/{id}/invites", { params: { path: { id: communityId } } }))
    .then(setInvites).catch((e) => setError(errorText(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [communityId]);
  return (
    <section className="card" aria-label="Invites">
      <h3>Active invites</h3>
      <ErrorText error={error} />
      {invites?.length === 0 && <p className="muted">No active invites.</p>}
      <table className="table">
        <tbody>
          {invites?.map((i) => (
            <tr key={i.code}>
              <td><code>{i.code}</code></td>
              <td>{i.uses}{i.max_uses ? ` / ${i.max_uses}` : ""} uses</td>
              <td>{i.expires_at ? `expires ${new Date(i.expires_at).toLocaleString()}` : "never expires"}</td>
              <td><Button variant="ghost" onClick={() => unwrap(client.api.DELETE("/api/invites/{code}", { params: { path: { code: i.code } } }))
                .then(load).catch((e) => setError(errorText(e)))}>Revoke</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Bans({ communityId }: { communityId: string }) {
  const [bans, setBans] = useState<Ban[]>();
  const [error, setError] = useState<string>();
  const load = () => unwrap(client.api.GET("/api/communities/{id}/bans", { params: { path: { id: communityId } } }))
    .then(setBans).catch((e) => setError(errorText(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [communityId]);
  return (
    <section className="card" aria-label="Bans">
      <h3>Bans</h3>
      <ErrorText error={error} />
      {bans?.length === 0 && <p className="muted">Nobody is banned.</p>}
      <table className="table">
        <tbody>
          {bans?.map((b) => (
            <tr key={b.user.id}>
              <td>{displayName(b.user)} <span className="muted">@{b.user.username}</span></td>
              <td className="muted">{b.reason}</td>
              <td><Button variant="ghost" onClick={() => unwrap(client.api.DELETE("/api/communities/{id}/bans/{userID}",
                { params: { path: { id: communityId, userID: b.user.id } } })).then(load).catch((e) => setError(errorText(e)))}>Unban</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Leave({ communityId }: { communityId: string }) {
  const nav = useNavigate();
  const { busy, error, run } = useSubmit();
  return (
    <section className="card" aria-label="Leave">
      <Button variant="danger" disabled={busy} onClick={() => {
        if (!window.confirm("Leave this community?")) return;
        void run(async () => {
          await unwrap(client.api.DELETE("/api/communities/{id}/members/{userID}", { params: { path: { id: communityId, userID: "@me" } } }));
          nav("/");
        });
      }}>Leave community</Button>
      <ErrorText error={error} />
    </section>
  );
}
```

- [ ] **Step 5: Write `clients/web/src/app/settings/UserSettings.tsx`**

```tsx
import { unwrap, type PresenceStatus, type Session } from "@datrope/core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { choosePresence, client, errorText, useApp } from "../../session";
import { Button, ErrorText, Field, useSubmit } from "../../ui";

export function UserSettings() {
  const me = useApp((s) => s.me);
  const presence = useApp((s) => s.presence);
  const [name, setName] = useState(me?.display_name ?? "");
  const [sessions, setSessions] = useState<Session[]>();
  const [error, setError] = useState<string>();
  const { busy, error: saveError, run } = useSubmit();

  const loadSessions = () => unwrap(client.api.GET("/api/sessions")).then(setSessions).catch((e) => setError(errorText(e)));
  useEffect(() => { void loadSessions(); }, []);

  if (!me) return null;
  return (
    <main className="main">
      <header className="main-header"><h2>Your settings</h2></header>
      <div className="page">
        <section className="card" aria-label="Profile">
          <h3>Profile</h3>
          <form className="row" onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const u = await unwrap(client.api.PATCH("/api/users/@me", { body: { display_name: name } }));
              client.apply("USER_UPDATE", { id: u.id, username: u.username, display_name: u.display_name });
            });
          }}>
            <Field label="Display name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={32} />
            <Button type="submit" disabled={busy}>Save</Button>
          </form>
          <ErrorText error={saveError} />
          <label className="field">
            <span>Status</span>
            <select value={presence} onChange={(e) => choosePresence(e.target.value as PresenceStatus)}>
              <option value="online">Online</option>
              <option value="idle">Idle</option>
              <option value="invisible">Invisible (appear offline)</option>
            </select>
          </label>
        </section>

        <section className="card" aria-label="Sessions">
          <h3>Signed-in devices</h3>
          <ErrorText error={error} />
          <table className="table">
            <tbody>
              {sessions?.map((s) => (
                <tr key={s.id}>
                  <td>{s.device_name}{s.current && <strong> (this device)</strong>}</td>
                  <td className="muted">last used {new Date(s.last_used_at).toLocaleString()}</td>
                  <td>{!s.current && (
                    <Button variant="ghost" onClick={() => unwrap(client.api.DELETE("/api/sessions/{id}", { params: { path: { id: s.id } } }))
                      .then(loadSessions).catch((e) => setError(errorText(e)))}>Sign out</Button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button variant="danger" onClick={() => unwrap(client.api.POST("/api/auth/logout")).finally(() => {
            client.disconnect();
            window.location.assign("/login");
          })}>Sign out of this device</Button>
        </section>

        {me.is_admin && <Link to="/admin">Server administration →</Link>}
      </div>
    </main>
  );
}
```

- [ ] **Step 6: Write `clients/web/src/app/settings/AdminSettings.tsx`**

```tsx
import { unwrap, type Settings, type User } from "@datrope/core";
import { useEffect, useState } from "react";
import { client, errorText, useApp } from "../../session";
import { Button, ErrorText, Field, useSubmit } from "../../ui";

export function AdminSettings() {
  const me = useApp((s) => s.me);
  const [settings, setSettings] = useState<Settings>();
  const [users, setUsers] = useState<User[]>();
  const [error, setError] = useState<string>();
  const load = () => Promise.all([
    unwrap(client.api.GET("/api/admin/settings")).then(setSettings),
    unwrap(client.api.GET("/api/admin/users")).then(setUsers),
  ]).catch((e) => setError(errorText(e)));
  useEffect(() => { if (me?.is_admin) void load(); }, [me?.is_admin]);

  if (!me?.is_admin) return <main className="main center muted">Only the server admin can see this page.</main>;
  return (
    <main className="main">
      <header className="main-header"><h2>Server administration</h2></header>
      <div className="page">
        <ErrorText error={error} />
        {settings && <InstanceSettings initial={settings} onSaved={setSettings} />}
        <CreateUser onCreated={load} />
        <section className="card" aria-label="Users">
          <h3>Users</h3>
          <table className="table">
            <tbody>
              {users?.map((u) => <UserRow key={u.id} u={u} isMe={u.id === me.id} onChange={load} />)}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}

function InstanceSettings({ initial, onSaved }: { initial: Settings; onSaved: (s: Settings) => void }) {
  const [mode, setMode] = useState(initial.registration_mode);
  const [allow, setAllow] = useState(initial.allow_community_creation);
  const { busy, error, run } = useSubmit();
  return (
    <form className="card" aria-label="Registration" onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        onSaved(await unwrap(client.api.PATCH("/api/admin/settings", {
          body: { registration_mode: mode, allow_community_creation: allow },
        })));
      });
    }}>
      <h3>Registration</h3>
      <label className="field">
        <span>Who can create an account</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as Settings["registration_mode"])}>
          <option value="invite_only">People with an invite</option>
          <option value="open">Anyone</option>
          <option value="admin_only">Only the admin</option>
        </select>
      </label>
      <label className="row">
        <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
        Everyone can create communities
      </label>
      <ErrorText error={error} />
      <Button type="submit" disabled={busy}>Save</Button>
    </form>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();
  return (
    <form className="card" aria-label="Create account" onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        await unwrap(client.api.POST("/api/admin/users", { body: { username, password } }));
        setUsername("");
        setPassword("");
        onCreated();
      });
    }}>
      <h3>Create an account</h3>
      <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={2} maxLength={32} />
      <Field label="Temporary password" type="password" autoComplete="new-password" value={password}
        onChange={(e) => setPassword(e.target.value)} required minLength={8} />
      <ErrorText error={error} />
      <Button type="submit" disabled={busy}>Create</Button>
    </form>
  );
}

function UserRow({ u, isMe, onChange }: { u: User; isMe: boolean; onChange: () => void }) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();
  const path = { params: { path: { id: u.id } } };
  return (
    <tr>
      <td>{u.display_name} <span className="muted">@{u.username}</span>{u.is_admin && " (admin)"}{u.disabled && " — disabled"}</td>
      <td>
        {resetting ? (
          <form className="row" onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await unwrap(client.api.PUT("/api/admin/users/{id}/password", { ...path, body: { password } }));
              setResetting(false);
              setPassword("");
            });
          }}>
            <input type="password" aria-label={`New password for ${u.username}`} value={password} minLength={8} required
              onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <Button type="submit" disabled={busy}>Set</Button>
            <Button variant="ghost" onClick={() => setResetting(false)}>Cancel</Button>
          </form>
        ) : (
          <div className="row">
            <Button variant="ghost" onClick={() => setResetting(true)}>Reset password</Button>
            {!isMe && (
              <Button variant={u.disabled ? "ghost" : "danger"} disabled={busy} onClick={() => void run(async () => {
                await unwrap(client.api.PUT("/api/admin/users/{id}/disabled", { ...path, body: { disabled: !u.disabled } }));
                onChange();
              })}>{u.disabled ? "Enable" : "Disable"}</Button>
            )}
          </div>
        )}
        <ErrorText error={error} />
      </td>
    </tr>
  );
}
```

- [ ] **Step 7: Add the routes and the settings link**

In `clients/web/src/router.tsx`, add to the `AppShell` children (after the `c/:communityId/:channelId?` route; React Router ranks the static `settings` segment above `:channelId`):

```tsx
        { path: "c/:communityId/settings", element: <CommunitySettings /> },
        { path: "settings", element: <UserSettings /> },
        { path: "admin", element: <AdminSettings /> },
```

with imports from `./app/settings/…`.

In `clients/web/src/app/CommunityRail.tsx`, add right after `<div className="rail-spacer" />`:

```tsx
      <NavLink to="/settings" className={({ isActive }) => `rail-item ${isActive ? "active" : ""}`} title="Settings" aria-label="Settings">⚙</NavLink>
```

- [ ] **Step 8: Typecheck, lint, and build**

Run: `pnpm --filter @datrope/web build && pnpm lint`
Expected: success.

- [ ] **Step 9: Manual check** (dev setup from Task 13)

1. As the owner: **+ Add channel** "staff"; open its ⚙ → Permissions → `@everyone` → View channels = Deny → Save. The second user's sidebar drops `#staff` without a reload.
2. Community ⚙ → Roles → **+ New role**, name it "Staff", tick *View channels* … Save; Members → tick *Staff* for the second user. In `#staff` permissions, set role *Staff* → View channels = Allow. The second user sees `#staff` again.
3. As the second user (with only *Kick* added to their role), confirm in Roles that boxes for permissions they lack are disabled.
4. Kick and ban the second user from Members; they are moved out of the community. Unban from Bans.
5. Your settings: change display name (others see it update), set Invisible (others see you grey), revoke another device's session (that window is sent to the sign-in page).
6. Admin page: switch registration to "Only the admin", create an account, reset its password, disable it.

- [ ] **Step 10: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(web): channel, community, account, and admin settings`

---

### Task 16: Docker Compose deployment and end-to-end tests

**Files:**
- Modify: `server/cmd/datrope/main.go` (add `healthcheck` command)
- Create: `server/Dockerfile`, `server/.dockerignore`
- Create: `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/caddy.Dockerfile`, `deploy/.env.example`, `deploy/.env.e2e`, `deploy/README.md`
- Create: `.dockerignore` (repo root, for the Caddy image build)
- Create: `clients/web/playwright.config.ts`, `clients/web/e2e/chat.spec.ts`

**Interfaces:**
- Consumes: the whole server (Tasks 1–11) and web app (Tasks 13–15).
- Produces: `datrope healthcheck`; a stack started with `docker compose up -d --build` from `deploy/`; `pnpm --filter @datrope/web e2e` (expects a fresh stack at `https://localhost`, override with `E2E_BASE_URL`).

- [ ] **Step 1: Write the failing end-to-end test**

`clients/web/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://localhost",
    ignoreHTTPSErrors: true, // Caddy's local CA for "localhost"
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

`clients/web/e2e/chat.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

// Runs against a fresh instance: the first account becomes the admin.
test.beforeAll(async ({ request }) => {
  await expect(async () => {
    expect((await request.get("/api/instance")).ok()).toBe(true);
  }).toPass({ timeout: 60_000 });
});

async function register(page: Page, username: string) {
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Create account" }).click();
}

test("admin sets up a community, a friend joins by invite, they chat in real time", async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await admin.goto("/register");
  await expect(admin.getByRole("heading", { name: "Create the admin account" })).toBeVisible();
  await register(admin, "admin");

  await admin.getByRole("button", { name: "Create a community" }).click();
  await admin.getByLabel("Name").fill("E2E Club");
  await admin.getByRole("button", { name: "Create", exact: true }).click();
  await expect(admin.getByRole("heading", { name: "# general" })).toBeVisible();

  await admin.getByRole("button", { name: "Invite" }).click();
  const link = admin.getByLabel("Invite link");
  await expect(link).toHaveValue(/\/invite\//);
  const inviteUrl = await link.inputValue();
  await admin.getByRole("button", { name: "Done" }).click();

  const friend = await (await browser.newContext()).newPage();
  await friend.goto(inviteUrl);
  await expect(friend.getByRole("heading", { name: "Join E2E Club" })).toBeVisible();
  await friend.getByRole("link", { name: "Create account" }).click();
  await register(friend, "friend");
  await expect(friend.getByRole("heading", { name: "# general" })).toBeVisible();

  await admin.getByLabel("Message").fill("hello from admin");
  await admin.getByLabel("Message").press("Enter");
  await expect(friend.getByText("hello from admin")).toBeVisible();

  await friend.getByLabel("Message").pressSequentially("hi b");
  await expect(admin.getByText("friend is typing…")).toBeVisible();
  await friend.getByLabel("Message").pressSequentially("ack");
  await friend.getByLabel("Message").press("Enter");
  await expect(admin.getByText("hi back")).toBeVisible();

  await admin.reload();
  await expect(admin.getByText("hello from admin")).toBeVisible();
  await expect(admin.getByText("hi back")).toBeVisible();
});
```

Run: `pnpm --filter @datrope/web exec playwright install chromium && pnpm --filter @datrope/web e2e`
Expected: FAIL — `/api/instance` never answers (no stack running yet).

- [ ] **Step 2: Add the healthcheck command** — `server/cmd/datrope/main.go`

In `run`, add a case:

```go
	case "healthcheck":
		return healthcheck()
```

and the function (add `"strings"` to the imports):

```go
// healthcheck is used by Docker: the image has no shell or curl.
func healthcheck() error {
	addr := os.Getenv("DATROPE_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + addr + "/healthz")
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz: %s", resp.Status)
	}
	return nil
}
```

- [ ] **Step 3: Write the images**

`server/Dockerfile`:

```dockerfile
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/datrope ./cmd/datrope

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/datrope /datrope
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s CMD ["/datrope", "healthcheck"]
ENTRYPOINT ["/datrope"]
```

`server/.dockerignore`:

```
datrope
datrope.exe
**/*_test.go
```

`deploy/caddy.Dockerfile` (built with the repo root as context):

```dockerfile
FROM node:22-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY clients/core/package.json clients/core/
COPY clients/web/package.json clients/web/
RUN pnpm install --frozen-lockfile
COPY clients/core clients/core
COPY clients/web clients/web
RUN pnpm --filter @datrope/web build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /src/clients/web/dist /srv
```

`.dockerignore` (repo root):

```
**/node_modules
**/dist
server
.git
.claude
.serena
.impeccable
```

`deploy/Caddyfile`:

```
{$DATROPE_DOMAIN} {
	encode zstd gzip

	@backend path /api/* /ws
	handle @backend {
		reverse_proxy server:8080
	}

	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}

	header {
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		X-Frame-Options "DENY"
		Content-Security-Policy "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
	}
}
```

- [ ] **Step 4: Write the Compose files**

`deploy/docker-compose.yml`:

```yaml
name: datrope

services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: datrope
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in deploy/.env}
      POSTGRES_DB: datrope
    volumes:
      - postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U datrope -d datrope"]
      interval: 5s
      timeout: 3s
      retries: 20

  server:
    build: ../server
    restart: unless-stopped
    environment:
      DATROPE_DATABASE_URL: postgres://datrope:${POSTGRES_PASSWORD}@postgres:5432/datrope?sslmode=disable
      DATROPE_PUBLIC_URL: https://${DATROPE_DOMAIN:?set DATROPE_DOMAIN in deploy/.env}
      DATROPE_TRUST_PROXY: "true"
    depends_on:
      postgres:
        condition: service_healthy

  caddy:
    build:
      context: ..
      dockerfile: deploy/caddy.Dockerfile
    restart: unless-stopped
    environment:
      DATROPE_DOMAIN: ${DATROPE_DOMAIN}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      server:
        condition: service_healthy

volumes:
  postgres:
  caddy_data:
  caddy_config:
```

`deploy/.env.example`:

```
# The domain people use to reach this server. Caddy gets a TLS certificate
# for it automatically (ports 80 and 443 must be reachable from the internet).
# For a quick local try-out use "localhost": Caddy then uses its own local CA.
DATROPE_DOMAIN=chat.example.com

# Database password. Letters and digits only: it is placed in a connection URL.
POSTGRES_PASSWORD=change-me-to-a-long-random-string
```

`deploy/.env.e2e` (committed; only for throwaway test stacks):

```
DATROPE_DOMAIN=localhost
POSTGRES_PASSWORD=e2eonlypassword
```

`deploy/README.md`:

````markdown
# Running Datrope

Requirements: a machine with Docker and Docker Compose, and a domain pointing at it.

```bash
cd deploy
cp .env.example .env   # then edit DATROPE_DOMAIN and POSTGRES_PASSWORD
docker compose up -d --build
```

Open `https://<your domain>/register`. The first account you create is the server admin.
New accounts need an invite by default; change this under Settings → Server administration.

## Backups

Back up the database:

```bash
docker compose exec -T postgres pg_dump -U datrope datrope > datrope-$(date +%F).sql
```

Restore into a fresh stack:

```bash
docker compose exec -T postgres psql -U datrope datrope < datrope-YYYY-MM-DD.sql
```

## Updating

```bash
git pull && docker compose up -d --build
```

Database migrations run automatically when the server starts.
````

- [ ] **Step 5: Build the stack and run the end-to-end test**

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e down -v
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait
pnpm --filter @datrope/web e2e
```

Expected: `1 passed`. On failure, `docker compose -p datrope-e2e logs server` and the Playwright trace in `clients/web/test-results/` show what happened. Run the `down -v` line again before each re-run (the test needs a fresh instance).

When done: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e down -v`

- [ ] **Step 6: Checkpoint**

Stop; the user reviews and commits. Suggested message: `feat(deploy): docker compose stack and end-to-end test`

---

### Task 17: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: every test and build command defined above.
- Produces: three jobs — `server` (vet, staticcheck, tests with `-race`), `clients` (generated types up to date, typecheck, lint, unit tests), `e2e` (Compose stack + Playwright).

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  server:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: server
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: server/go.mod
          cache-dependency-path: server/go.sum
      - run: go vet ./...
      - run: go run honnef.co/go/tools/cmd/staticcheck@2025.1.1 ./...
      - run: go test -race ./...

  clients:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: server/go.mod
          cache-dependency-path: server/go.sum
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Generated API types match the server
        run: |
          pnpm --filter @datrope/core gen
          git diff --exit-code clients/core
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test

  e2e:
    runs-on: ubuntu-latest
    needs: [server, clients]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @datrope/web exec playwright install --with-deps chromium
      - run: docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait
      - run: pnpm --filter @datrope/web e2e
      - if: failure()
        run: docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e logs
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-traces
          path: clients/web/test-results/
```

If `staticcheck@2025.1.1` reports that it does not support the Go version in `go.mod`, bump it to the newest staticcheck release.

- [ ] **Step 2: Verify locally what CI runs**

```bash
cd server && go vet ./... && go run honnef.co/go/tools/cmd/staticcheck@2025.1.1 ./... && go test -race ./...
```

```bash
pnpm --filter @datrope/core gen && git diff --exit-code clients/core && pnpm typecheck && pnpm lint && pnpm test
```

Expected: both succeed with no diff. (The e2e job was verified in Task 16.)

- [ ] **Step 3: Checkpoint**

Stop; the user reviews and commits. Suggested message: `ci: server, clients, and end-to-end jobs`

---

## Spec coverage (milestone 1)

| Spec | Where |
|---|---|
| §1 Go backend, React web, shared TS core, Compose deployment | Tasks 1–17 |
| §2.1 modular monolith, packages own tables, interfaces between packages, in-process event bus, no Redis | Tasks 3–11 (consumer-side interfaces in each package; one migration file per owning package) |
| §2.3 repo layout, OpenAPI → generated TS types | Tasks 4, 12, 17 (drift check) |
| §3 domain model, instance admin, registration modes, community creation toggle, Snowflake IDs, paging, 4000-char messages, edit/soft delete | Tasks 1, 3, 5–10 |
| §4 permission flags, `@everyone`, `Effective()` as the only calculation, DM fixed perms | Tasks 2, 9 (server); Task 12 mirrors it for UI hints only |
| §5.1 writes over REST with nonce, delivery to viewers | Tasks 10, 11, 12 |
| §5.2 IDENTIFY/READY, events, sequence numbers, RESUME with ~2 min buffer, INVALID_SESSION, heartbeat 30/45 s, presence incl. idle and appear-offline | Task 11 (server), Task 12 (client) |
| §6 argon2id, 32-byte tokens stored as SHA-256, cookie + CSRF / bearer, list/revoke sessions, revocation closes WebSockets, rate limits, admin password reset | Tasks 3, 5, 6, 11 |
| §8 notifications | Not in milestone 1 (desktop/web push arrive with M4; mobile with M5) |
| §9 error shape, request-ID-only 500s, WebSocket close codes | Tasks 4, 11 |
| §10 Go unit + integration tests on real Postgres, `clients/core` Vitest with a fake server, Playwright on the Compose stack, CI | Tasks 1–12, 16, 17 |
| §11 goose migrations on startup, env config, `/healthz`, slog JSON logs, backup docs | Tasks 3, 4, 16 |

Deferred from §11: the optional Prometheus `/metrics` endpoint (not needed for milestone 1).
