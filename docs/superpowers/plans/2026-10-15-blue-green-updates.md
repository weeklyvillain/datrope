# Zero-downtime Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Updating Datrope keeps the old server serving until the new one is built, migrated and healthy, then switches traffic atomically; the admin sees a staged progress bar and every client gets a Reload banner.

**Architecture:** Two compose server slots (`server-blue`, `server-green`) share one definition. A `switch` volume holds the active slot plus two Caddy snippets; the updater starts the idle slot, waits for health, rewrites the snippets and runs `caddy reload`, then stops the old slot. Servers gate their background jobs on the `slot` file. The web build moves from the Caddy image to a `web` volume filled by a one-shot `web` service.

**Tech Stack:** Go 1.25 (server, updater), goose migrations, Docker Compose v2, Caddy 2, React 18 + Vite + vitest, workbox service worker.

**Spec:** `docs/superpowers/specs/2026-10-15-blue-green-updates-design.md`

## Global Constraints

- Never commit: AGENTS.md §5. The "Commit" steps below are replaced with "stage and report"; the user commits.
- Run commands with the `rtk` prefix (user CLAUDE.md), e.g. `rtk go test ./...`, `rtk pnpm ...`.
- Build ID default is the literal `dev`; the banner never shows when either side is `dev`.
- Health wait timeout: 2 minutes. Old slot SIGTERM grace: 10 s (the server's existing shutdown timeout).
- Keep the 3 newest web builds; never delete the active one.
- Migration guard applies to migrations with version > 42.
- Escape-hatch marker line is exactly `-- datrope:contract`.
- UI: shadcn components only, token colors only, no `dark:` classes, `Button` needs explicit `type="submit"` only for forms; keep accessible names stable.
- Switch files: `slot`, `upstream.caddy` (`reverse_proxy server-<slot>:8080`), `root.caddy` (`root * /web/<build>`), each written temp-file + rename.
- Without `DATROPE_SLOT` the server is always active (dev, tests, Playwright e2e).

## Review Focus

- Updater crashes or is restarted mid-switch → the three switch files must never be half-written; the slot file is written last so servers and Caddy agree. (Task 4 test: write order + atomic rename.)
- Health check passes on the *old* image because compose did not recreate the slot → wait must check `/healthz` reports the new build, not only Docker health. (Task 5 test: healthy but wrong build keeps waiting until timeout.)
- PWA user presses Reload → a waiting service worker would serve the old shell forever; the button must activate the waiting worker first. (Task 9 test: `reloadToNewBuild` posts `SKIP_WAITING` when a worker is waiting.)
- Fresh install: no `switch/slot` yet → the `web` service writes defaults and Caddy starts with blue. (Task 7 test: publish script on an empty volume writes all three files.)
- An open tab on the previous build lazy-loads a chunk after the switch → old hashed assets must still be served. (Task 7 test: merge keeps the previous build's `assets/*`; Task 11 e2e asserts an old asset returns 200.)

---

### Task 1: Build ID in the server (version package, /healthz, READY)

**Files:**
- Create: `server/internal/version/version.go`
- Modify: `server/Dockerfile`
- Modify: `server/internal/app/app.go` (the `GET /healthz` handler near line 291)
- Modify: `server/internal/app/realtime.go` (`Ready` struct and `readyBuilder.Build`)
- Test: `server/internal/app/app_test.go`

**Interfaces:**
- Produces: `version.Build string` (default `"dev"`); `/healthz` body `{"build":"<sha>"}` with status 200; READY field `build` (Go `Ready.Build string \`json:"build"\``), so the TS type `Ready["build"]: string` after `pnpm --filter @datrope/core gen`.

- [ ] **Step 1: Write the failing test** in `server/internal/app/app_test.go`, replacing `TestHealthz`:

```go
func TestHealthz(t *testing.T) {
	env := apptest.New(t)
	resp, err := http.Get(env.Server.URL + "/healthz")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.NotEmpty(t, resp.Header.Get("X-Request-ID"))
	var body struct{ Build string `json:"build"` }
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Equal(t, "dev", body.Build)
}
```
(add `"encoding/json"` to the imports if missing)

- [ ] **Step 2: Run** `rtk go -C server test ./internal/app -run TestHealthz` → FAIL (body is `ok`).

- [ ] **Step 3: Implement.** `server/internal/version/version.go`:

```go
// Package version holds the build the binary was made from.
package version

// Build is the git commit the image was built from, set with
// -ldflags "-X github.com/datrope/datrope/server/internal/version.Build=<sha>"; "dev" otherwise.
var Build = "dev"
```

`app.go` healthz handler:

```go
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"build": version.Build})
	})
```

`realtime.go`: add `Build string \`json:"build" doc:"The commit the server was built from; dev for local builds"\`` as the first field after `SessionID` in `Ready`, and in `Build(...)` set `r := Ready{SessionID: sessionID, Build: version.Build, ...}`.

`server/Dockerfile` build stage:

```dockerfile
ARG DATROPE_BUILD=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X github.com/datrope/datrope/server/internal/version.Build=${DATROPE_BUILD}" -o /out/datrope ./cmd/datrope \
 && mkdir -p /out/data/files
```

The `healthcheck` subcommand in `cmd/datrope/main.go` only checks the status code; leave it.

- [ ] **Step 4: Run** `rtk go -C server test ./internal/app/...` → PASS. Then `rtk pnpm --filter @datrope/core gen` and confirm `clients/core/src/schema.d.ts` has `build: string` in `Ready`.

- [ ] **Step 5: Stage and report** (`rtk git add server/internal/version server/Dockerfile server/internal/app clients/core/openapi.json clients/core/src/schema.d.ts`).

---

### Task 2: Slot watcher and background-job gating

**Files:**
- Create: `server/internal/slot/slot.go`, `server/internal/slot/slot_test.go`
- Modify: `server/internal/app/config.go` (fields `Slot`, `SlotFile`)
- Modify: `server/internal/app/app.go` (wire the gate)
- Modify: `server/internal/audit/audit.go`, `server/internal/communities/guests.go`, `server/internal/files/files.go`, `server/internal/integrations/integrations.go`, `server/internal/voice/voice.go` (add `SetActive`, check it per tick)
- Test: `server/internal/slot/slot_test.go`, `server/internal/files/files_test.go` (one gate test as the pattern)

**Interfaces:**
- Produces: `slot.Gate` with `func (g *Gate) Active() bool` (nil-safe: nil → true), `func Watch(ctx context.Context, g *Gate, path, mine string, every time.Duration)`; `Config.Slot string` (env `DATROPE_SLOT`), `Config.SlotFile string` (env `DATROPE_SLOT_FILE`, default `/switch/slot`); each gated service gets `SetActive(func() bool)`.

- [ ] **Step 1: Write the failing tests** `server/internal/slot/slot_test.go`:

```go
package slot

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestNilGateIsActive(t *testing.T) {
	var g *Gate
	require.True(t, g.Active())
}

func TestReadActive(t *testing.T) {
	p := filepath.Join(t.TempDir(), "slot")
	require.False(t, readActive(p, "blue"), "missing file: inactive")
	require.NoError(t, os.WriteFile(p, []byte("blue\n"), 0o644))
	require.True(t, readActive(p, "blue"))
	require.False(t, readActive(p, "green"))
}

func TestWatchFlips(t *testing.T) {
	p := filepath.Join(t.TempDir(), "slot")
	require.NoError(t, os.WriteFile(p, []byte("green\n"), 0o644))
	g := &Gate{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Watch(ctx, g, p, "blue", 10*time.Millisecond)
	require.Eventually(t, func() bool { return !g.Active() }, time.Second, 5*time.Millisecond)
	require.NoError(t, os.WriteFile(p, []byte("blue\n"), 0o644))
	require.Eventually(t, g.Active, time.Second, 5*time.Millisecond)
}
```

- [ ] **Step 2: Run** `rtk go -C server test ./internal/slot` → FAIL (package missing).

- [ ] **Step 3: Implement** `server/internal/slot/slot.go`:

```go
// Package slot tells a server whether it is the live one of the two update slots (blue/green).
// The updater writes the live slot's name to a file on a shared volume; the other slot keeps
// answering HTTP but pauses its background jobs.
package slot

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// Gate reports whether this server is live. A nil Gate is always live (no slots configured).
type Gate struct{ inactive atomic.Bool }

func (g *Gate) Active() bool { return g == nil || !g.inactive.Load() }

func readActive(path, mine string) bool {
	b, err := os.ReadFile(path)
	return err == nil && strings.TrimSpace(string(b)) == mine
}

// Watch sets g from path every interval until ctx ends. It sets g once before returning control
// to the ticker, so callers can start it with go and rely on the state soon after.
func Watch(ctx context.Context, g *Gate, path, mine string, every time.Duration) {
	set := func() {
		active := readActive(path, mine)
		if was := !g.inactive.Swap(!active); was != active {
			slog.Info("slot", "slot", mine, "active", active)
		}
	}
	set()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			set()
		}
	}
}
```

Note: a fresh `Gate{}` starts active; for a slotted server `app.New` must call the first read synchronously before starting services (Step 5).

- [ ] **Step 4: Run** `rtk go -C server test ./internal/slot` → PASS.

- [ ] **Step 5: Wire into services and app.**

Pattern for each service (shown for `files`; add the same field + setter to `audit.Service`, `communities.Service`, `integrations.Service`, `voice.Service`):

```go
// in the Service struct
	active func() bool // nil: always; set by SetActive

// SetActive makes the background loop skip its work while active reports false (the standby
// update slot).
func (s *Service) SetActive(active func() bool) { s.active = active }

func (s *Service) isActive() bool { return s.active == nil || s.active() }
```

and in the loop, guard every unit of work (the initial catch-up included):

```go
		if s.isActive() {
			if err := s.Sweep(context.Background(), time.Now()); err != nil { // catch up after downtime
				slog.Error("files: sweep", "err", err)
			}
		}
		...
			case now := <-t.C:
				if !s.isActive() {
					continue
				}
```

Per service: `audit.Start` guards `prune(...)`; `communities.StartGuestSweep` guards `sweep(...)`; `integrations.Start` guards `s.Poll(ctx)` (skip before creating ctx); `voice.refresh` returns early at the top when `!s.isActive()` (covers the tick, the poke and the initial call). The sampler, push fan-out, music and watch are not gated (sampler only reads; the others act on requests and events, which a standby slot never gets).

`config.go`: add `Slot string // DATROPE_SLOT: blue or green under the update slots; empty: always live` and `SlotFile string`; in `ConfigFromEnv` read `DATROPE_SLOT`, `DATROPE_SLOT_FILE`, default `SlotFile` to `/switch/slot`.

`app.go`: build the gate locally in `New`:

```go
	var active func() bool
	if cfg.Slot != "" && pool != nil {
		g := &slot.Gate{}
		ctx, cancel := context.WithCancel(context.Background())
		if !slot.ReadActive(cfg.SlotFile, cfg.Slot) {
			g.SetInactive() // know the state before any service starts
		}
		go slot.Watch(ctx, g, cfg.SlotFile, cfg.Slot, time.Second)
		a.closers = append(a.closers, cancel)
		active = g.Active
	}
```

For this, export the reader and add a setter in `slot.go`: rename `readActive` → `ReadActive` (update the test) and add `func (g *Gate) SetInactive() { g.inactive.Store(true) }`. Place this block right after `a := &App{...}`, and call `X.SetActive(active)` before each of `commSvc.StartGuestSweep()`, `filesSvc.Start()`, `voiceSvc.Start()`, `intSvc.Start()`, `auditSvc.Start()`.

- [ ] **Step 6: Gate test.** One internal test per gated package pins the setter (the loops themselves are exercised by the e2e in Task 11). Example `server/internal/files/active_internal_test.go` (package `files`; repeat for audit, communities, integrations, voice with their own constructor-free zero value `&Service{}`):

```go
package files

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestIsActive(t *testing.T) {
	s := &Service{}
	require.True(t, s.isActive(), "no gate: always active")
	s.SetActive(func() bool { return false })
	require.False(t, s.isActive())
}
```

For `voice`, also assert `refresh` returns before touching LiveKit when inactive: `s := &Service{}; s.SetActive(func() bool { return false }); s.refresh(true)` must not panic (a zero `Service` has no rooms client, so reaching `Sync` would panic).

- [ ] **Step 7: Run** `rtk go -C server test ./...` → PASS.

- [ ] **Step 8: Stage and report.**

---

### Task 3: Migration guard

**Files:**
- Create: `server/internal/db/guard_test.go`
- Create: `server/internal/db/migrations/README.md`

**Interfaces:**
- Produces: `func breaking(sql string) []string` (test-file helper) returning the offending statement keywords.

- [ ] **Step 1: Write the test** `server/internal/db/guard_test.go`:

```go
package db

import (
	"io/fs"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// guardFrom: migrations up to this version predate the expand/contract rule.
const guardFrom = 42

var (
	sqlComment = regexp.MustCompile(`(?m)--.*$`)
	breakingRe = regexp.MustCompile(`(?i)\b(DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)|RENAME\b|SET\s+NOT\s+NULL|ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE|DELETE\s+FROM|TRUNCATE)\b`)
)

// breaking lists what in a migration's Up section the previous release might not survive.
func breaking(sql string) []string {
	if strings.Contains(sql, "-- datrope:contract") {
		return nil
	}
	up := sql
	if i := strings.Index(up, "-- +goose Down"); i >= 0 {
		up = up[:i]
	}
	up = sqlComment.ReplaceAllString(up, "")
	return breakingRe.FindAllString(up, -1)
}

func TestBreaking(t *testing.T) {
	require.Empty(t, breaking("-- +goose Up\nALTER TABLE a ADD COLUMN b TEXT;\n-- +goose Down\nALTER TABLE a DROP COLUMN b;"))
	require.Equal(t, []string{"DROP COLUMN"}, breaking("-- +goose Up\nALTER TABLE a DROP COLUMN b;"))
	require.NotEmpty(t, breaking("-- +goose Up\nALTER TABLE a ALTER COLUMN b SET NOT NULL;"))
	require.NotEmpty(t, breaking("-- +goose Up\nALTER TABLE a RENAME COLUMN b TO c;"))
	require.NotEmpty(t, breaking("-- +goose Up\nALTER TABLE a ALTER COLUMN b TYPE BIGINT;"))
	require.NotEmpty(t, breaking("-- +goose Up\nDELETE FROM a;"))
	require.Empty(t, breaking("-- +goose Up\n-- drop column later\nCREATE TABLE a (id INT);"), "comments are ignored")
	require.Empty(t, breaking("-- +goose Up\n-- datrope:contract\nALTER TABLE a DROP COLUMN b;"))
}

// Every migration must work with the previous release's code: it runs while the old update slot
// still serves (deploy/README.md, "Updates"). See migrations/README.md.
func TestMigrationsAreBackwardCompatible(t *testing.T) {
	err := fs.WalkDir(migrations, "migrations", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(p) != ".sql" {
			return err
		}
		n, _ := strconv.Atoi(strings.SplitN(filepath.Base(p), "_", 2)[0])
		if n <= guardFrom {
			return nil
		}
		b, err := fs.ReadFile(migrations, p)
		if err != nil {
			return err
		}
		require.Empty(t, breaking(string(b)), "%s: breaks the running release; split it (expand now, contract next release) or mark it -- datrope:contract", p)
		return nil
	})
	require.NoError(t, err)
}
```

Check the name of the embedded FS in `server/internal/db/db.go` (`fsys` is built from it in `migrate`); use that variable instead of `migrations` if it differs, and the matching root dir.

- [ ] **Step 2: Run** `rtk go -C server test ./internal/db -run 'TestBreaking|TestMigrationsAreBackwardCompatible'` → PASS (no migrations above 42 on this branch). Prove the guard bites: temporarily add `00043_tmp.sql` with `-- +goose Up\nALTER TABLE users DROP COLUMN x;`, see FAIL, delete it.

- [ ] **Step 3: Write** `server/internal/db/migrations/README.md`:

```markdown
# Migrations

Migrations run when a server starts. During an update the new server starts — and migrates —
while the previous release is still serving, so every migration must work with the previous
release's code (expand/contract):

- Expand: add tables, nullable columns, columns with defaults, indexes. Ship code that uses them.
- Contract (a later release, once no running code reads it): drop or rename columns, add
  NOT NULL, change types, delete rows. Put `-- datrope:contract` on its own line in that
  migration to tell the guard test (`../guard_test.go`) you checked.

Renames are an expand (add the new column, write both) then a contract (drop the old one).
```

- [ ] **Step 4: Stage and report.**

---

### Task 4: Switch files (updater)

**Files:**
- Create: `server/internal/updater/switch.go`, `server/internal/updater/switch_test.go`

**Interfaces:**
- Produces:
  - `type Switch struct{ Dir string }`
  - `func (s Switch) Active() (string, error)` — the live slot, `"blue"` if the file is missing.
  - `func Other(slot string) string` — `blue`↔`green`.
  - `func (s Switch) Write(slot, build string) (restore func() error, err error)` — writes `upstream.caddy`, `root.caddy`, then `slot`, each via temp + rename; `restore` puts back the previous contents (or removes files that did not exist).

- [ ] **Step 1: Write the failing test** `switch_test.go`:

```go
package updater

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func read(t *testing.T, p string) string {
	b, err := os.ReadFile(p)
	require.NoError(t, err)
	return string(b)
}

func TestSwitchWriteAndRestore(t *testing.T) {
	dir := t.TempDir()
	s := Switch{Dir: dir}
	slot, err := s.Active()
	require.NoError(t, err)
	require.Equal(t, "blue", slot, "no file yet: blue")

	_, err = s.Write("blue", "aaa")
	require.NoError(t, err)
	restore, err := s.Write("green", "bbb")
	require.NoError(t, err)
	require.Equal(t, "green\n", read(t, filepath.Join(dir, "slot")))
	require.Equal(t, "reverse_proxy server-green:8080\n", read(t, filepath.Join(dir, "upstream.caddy")))
	require.Equal(t, "root * /web/bbb\n", read(t, filepath.Join(dir, "root.caddy")))

	require.NoError(t, restore())
	require.Equal(t, "blue\n", read(t, filepath.Join(dir, "slot")))
	require.Equal(t, "root * /web/aaa\n", read(t, filepath.Join(dir, "root.caddy")))
	m, _ := filepath.Glob(filepath.Join(dir, "*.tmp"))
	require.Empty(t, m, "no temp files left")
}

func TestSwitchRestoreRemovesNewFiles(t *testing.T) {
	dir := t.TempDir()
	restore, err := Switch{Dir: dir}.Write("green", "bbb")
	require.NoError(t, err)
	require.NoError(t, restore())
	_, err = os.Stat(filepath.Join(dir, "slot"))
	require.True(t, os.IsNotExist(err))
}

func TestSwitchRejectsBadInput(t *testing.T) {
	_, err := Switch{Dir: t.TempDir()}.Write("red", "aaa")
	require.Error(t, err)
	_, err = Switch{Dir: t.TempDir()}.Write("blue", "../x")
	require.Error(t, err)
}

func TestOther(t *testing.T) {
	require.Equal(t, "green", Other("blue"))
	require.Equal(t, "blue", Other("green"))
}
```

- [ ] **Step 2: Run** `rtk go -C server test ./internal/updater -run 'Switch|Other'` → FAIL.

- [ ] **Step 3: Implement** `switch.go`:

```go
package updater

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Switch is the directory (the switch volume) that says which server slot is live and which web
// build Caddy serves. Caddy imports upstream.caddy and root.caddy; servers read slot.
type Switch struct{ Dir string }

var buildRe = regexp.MustCompile(`^[0-9a-zA-Z._-]{1,64}$`)

func Other(slot string) string {
	if slot == "blue" {
		return "green"
	}
	return "blue"
}

func (s Switch) Active() (string, error) {
	b, err := os.ReadFile(filepath.Join(s.Dir, "slot"))
	if errors.Is(err, os.ErrNotExist) {
		return "blue", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// Write points Caddy and the servers at slot and build. slot goes last, so a crash in between
// leaves the servers on the old slot. restore undoes the write.
func (s Switch) Write(slot, build string) (restore func() error, err error) {
	if slot != "blue" && slot != "green" {
		return nil, fmt.Errorf("switch: bad slot %q", slot)
	}
	if !buildRe.MatchString(build) || strings.Contains(build, "..") {
		return nil, fmt.Errorf("switch: bad build %q", build)
	}
	files := []struct{ name, body string }{
		{"upstream.caddy", "reverse_proxy server-" + slot + ":8080\n"},
		{"root.caddy", "root * /web/" + build + "\n"},
		{"slot", slot + "\n"},
	}
	type saved struct {
		name string
		body []byte
		ok   bool
	}
	var prev []saved
	restore = func() error {
		var errs []error
		for i := len(prev) - 1; i >= 0; i-- {
			p := prev[i]
			if p.ok {
				errs = append(errs, s.put(p.name, p.body))
			} else {
				errs = append(errs, os.Remove(filepath.Join(s.Dir, p.name)))
			}
		}
		return errors.Join(errs...)
	}
	for _, f := range files {
		b, rerr := os.ReadFile(filepath.Join(s.Dir, f.name))
		prev = append(prev, saved{f.name, b, rerr == nil})
		if err := s.put(f.name, []byte(f.body)); err != nil {
			_ = restore()
			return nil, err
		}
	}
	return restore, nil
}

func (s Switch) put(name string, body []byte) error {
	tmp := filepath.Join(s.Dir, name+".tmp")
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.Dir, name))
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Stage and report.**

---

### Task 5: Waiting for the new slot (updater)

**Files:**
- Create: `server/internal/updater/health.go`, `server/internal/updater/health_test.go`

**Interfaces:**
- Consumes: `Compose.cmd` / `Compose.Run` (existing `Cmd`).
- Produces:
  - `type Probe func(ctx context.Context, url string) (build string, err error)`; `HTTPProbe` (real one: GET, decode `{"build"}`).
  - `func (c Compose) WaitHealthy(ctx context.Context, w io.Writer, service, build string, probe Probe, timeout, every time.Duration) error` — loops: `docker compose ps -q <service>` → container ID; `docker inspect --format {{.State.Health.Status}} <id>` → must be `healthy`; `probe("http://<service>:8080/healthz")` → must equal `build`. Writes a line per state change. Returns an error naming the last state after `timeout`.

- [ ] **Step 1: Write the failing test** `health_test.go`:

```go
package updater

import (
	"context"
	"io"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestWaitHealthy(t *testing.T) {
	f := &fakeCmd{out: map[string]string{
		"ps -q server-green": "abc123\n",
		"{{.State.Health.Status}} abc123": "healthy\n",
	}}
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run}
	probe := func(_ context.Context, url string) (string, error) {
		require.Equal(t, "http://server-green:8080/healthz", url)
		return "bbb", nil
	}
	require.NoError(t, c.WaitHealthy(context.Background(), io.Discard, "server-green", "bbb", probe, time.Second, time.Millisecond))
}

func TestWaitHealthyWrongBuildTimesOut(t *testing.T) {
	f := &fakeCmd{out: map[string]string{
		"ps -q server-green": "abc123\n",
		"{{.State.Health.Status}} abc123": "healthy\n",
	}}
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run}
	probe := func(context.Context, string) (string, error) { return "aaa", nil }
	err := c.WaitHealthy(context.Background(), io.Discard, "server-green", "bbb", probe, 50*time.Millisecond, time.Millisecond)
	require.ErrorContains(t, err, "aaa")
}

func TestWaitHealthyUnhealthyTimesOut(t *testing.T) {
	f := &fakeCmd{out: map[string]string{
		"ps -q server-green": "abc123\n",
		"{{.State.Health.Status}} abc123": "starting\n",
	}}
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run}
	probe := func(context.Context, string) (string, error) { t.Fatal("probe before healthy"); return "", nil }
	err := c.WaitHealthy(context.Background(), io.Discard, "server-green", "bbb", probe, 50*time.Millisecond, time.Millisecond)
	require.ErrorContains(t, err, "starting")
}
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `health.go`:

```go
package updater

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Probe fetches a server's /healthz and returns the build it reports.
type Probe func(ctx context.Context, url string) (string, error)

func HTTPProbe(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("healthz: %s", res.Status)
	}
	var b struct{ Build string `json:"build"` }
	if err := json.NewDecoder(res.Body).Decode(&b); err != nil {
		return "", fmt.Errorf("healthz: %w", err)
	}
	return b.Build, nil
}

// WaitHealthy waits until service's container is healthy and its /healthz reports build: being
// healthy alone could be the previous image if the container was not recreated.
func (c Compose) WaitHealthy(ctx context.Context, w io.Writer, service, build string, probe Probe, timeout, every time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	last, state := "", "no container"
	for {
		state = c.healthState(ctx, service, build, probe)
		if state == "ready" {
			fmt.Fprintf(w, "%s is healthy and runs %s\n", service, build)
			return nil
		}
		if state != last {
			fmt.Fprintf(w, "%s: %s\n", service, state)
			last = state
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%s not ready after %s: %s", service, timeout, state)
		case <-time.After(every):
		}
	}
}

func (c Compose) healthState(ctx context.Context, service, build string, probe Probe) string {
	var b bytes.Buffer
	if err := c.cmd(ctx, &b, "ps", "-q", service); err != nil || strings.TrimSpace(b.String()) == "" {
		return "no container"
	}
	id := strings.TrimSpace(b.String())
	b.Reset()
	if err := c.Run(ctx, &b, "docker", "inspect", "--format", "{{.State.Health.Status}}", id); err != nil {
		return "inspect failed"
	}
	if h := strings.TrimSpace(b.String()); h != "healthy" {
		return h
	}
	got, err := probe(ctx, "http://"+service+":8080/healthz")
	if err != nil {
		return err.Error()
	}
	if got != build {
		return "healthy but runs " + got
	}
	return "ready"
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Stage and report.**

---

### Task 6: New update steps, job stages, `deploy` CLI

**Files:**
- Modify: `server/internal/updater/compose.go` (`UpdateSteps`, `Compose` gains `Switch Switch` and `Probe Probe`, add `EnvBuild`)
- Modify: `server/internal/updater/jobs.go` (`UpdateJob` stage fields, `run` updates them)
- Modify: `server/internal/updater/compose_test.go`, `server/internal/updater/jobs_test.go`
- Modify: `server/cmd/updater/main.go` (switch dir, probe, `deploy` subcommand)
- Modify: `server/internal/updater/server.go` (nothing but the `UpdateSteps` call if its signature changes)

**Interfaces:**
- Consumes: `Switch`, `Other`, `Compose.WaitHealthy`, `HTTPProbe` (Tasks 4–5); `Git.output`, `Git.markDeployed`.
- Produces:
  - `UpdateJob.Stage int \`json:"stage"\``, `Stages int \`json:"stages"\``, `StageTitle string \`json:"stage_title,omitempty"\``.
  - `func UpdateSteps(g *Git, c Compose) (steps []Step, final *Step)` — same signature; step titles exactly: `git pull`, `build`, `publish web app`, `start new server`, `wait until healthy`, `switch traffic`, `stop old server`; final `restart the updater`.
  - `updater deploy` subcommand: POSTs `/update` to the running updater and prints the job log until it ends (shares the job lock and the dashboard record).

Build flags: compose reads `DATROPE_BUILD` for the build arg; `Cmd` has no env, so pass it as `--build-arg DATROPE_BUILD=<sha>` to `build` (applies to every service declaring that arg: the server slots and `web`).

- [ ] **Step 1: Replace `TestUpdateSteps`** in `compose_test.go`:

```go
func TestUpdateSteps(t *testing.T) {
	f := updateFake()
	f.out["ps -q server-green"] = "g1\n"
	f.out["{{.State.Health.Status}} g1"] = "healthy\n"
	sw := Switch{Dir: t.TempDir()}
	_, err := sw.Write("blue", "aaa")
	require.NoError(t, err)
	probe := func(context.Context, string) (string, error) { return "ccc", nil }
	c := Compose{Dir: "/home/f/datrope/deploy", Project: "datrope", Image: "sha256:abc", Run: f.run, Switch: sw, Probe: probe}
	deployed := filepath.Join(t.TempDir(), "deployed")
	g := &Git{Dir: "/home/f/datrope", Run: f.run, DeployedFile: deployed}
	steps, final := UpdateSteps(g, c)
	titles := []string{}
	for _, s := range steps {
		titles = append(titles, s.Title)
		require.NoError(t, s.Run(context.Background(), io.Discard), s.Title)
	}
	require.Equal(t, []string{"git pull", "build", "publish web app", "start new server", "wait until healthy", "switch traffic", "stop old server"}, titles)
	require.NoError(t, final.Run(context.Background(), io.Discard))
	base := "docker compose -p datrope --project-directory /home/f/datrope/deploy -f /home/f/datrope/deploy/docker-compose.yml "
	require.Equal(t, append(append([]string{}, gitAfterPull...),
		"git -C /home/f/datrope rev-parse HEAD",
		base+"build --build-arg DATROPE_BUILD=ccc",
		base+"run --rm web",
		base+"up -d --no-deps --remove-orphans postgres imgproxy livekit",
		base+"up -d --no-deps server-green",
		base+"ps -q server-green",
		"docker inspect --format {{.State.Health.Status}} g1",
		base+"exec -T caddy caddy reload --config /etc/caddy/Caddyfile --force",
		base+"stop server-blue",
		"git -C /home/f/datrope rev-parse HEAD",
		"docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v /home/f/datrope:/home/f/datrope --entrypoint docker sha256:abc "+strings.TrimPrefix(base, "docker ")+"up -d --no-deps updater",
	), f.calls)
	slot, _ := sw.Active()
	require.Equal(t, "green", slot)
	require.Equal(t, "ccc\n", read(t, deployed))
}

func TestUpdateStepsUnhealthyKeepsOldSlot(t *testing.T) {
	f := updateFake()
	f.out["ps -q server-green"] = "g1\n"
	f.out["{{.State.Health.Status}} g1"] = "unhealthy\n"
	sw := Switch{Dir: t.TempDir()}
	_, _ = sw.Write("blue", "aaa")
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run, Switch: sw,
		Probe: func(context.Context, string) (string, error) { return "ccc", nil }, HealthTimeout: 20 * time.Millisecond}
	steps, _ := UpdateSteps(&Git{Dir: "/r", Run: f.run}, c)
	var err error
	for _, s := range steps {
		if err = s.Run(context.Background(), io.Discard); err != nil {
			require.Equal(t, "wait until healthy", s.Title)
			break
		}
	}
	require.Error(t, err)
	require.Contains(t, f.calls[len(f.calls)-1], "stop server-green", "the failed slot is stopped")
	slot, _ := sw.Active()
	require.Equal(t, "blue", slot)
}

func TestUpdateStepsReloadFailureRestores(t *testing.T) {
	f := updateFake()
	f.out["ps -q server-green"] = "g1\n"
	f.out["{{.State.Health.Status}} g1"] = "healthy\n"
	f.fail = map[string]bool{"--force": true}
	sw := Switch{Dir: t.TempDir()}
	_, _ = sw.Write("blue", "aaa")
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run, Switch: sw,
		Probe: func(context.Context, string) (string, error) { return "ccc", nil }}
	steps, _ := UpdateSteps(&Git{Dir: "/r", Run: f.run}, c)
	for _, s := range steps {
		if err := s.Run(context.Background(), io.Discard); err != nil {
			require.Equal(t, "switch traffic", s.Title)
			break
		}
	}
	slot, _ := sw.Active()
	require.Equal(t, "blue", slot)
	require.Equal(t, "root * /web/aaa\n", read(t, filepath.Join(sw.Dir, "root.caddy")))
	require.Contains(t, f.calls[len(f.calls)-1], "stop server-green")
}
```

Delete `TestUpdateStepsFailedBuildKeepsDeployed`'s index assumptions: steps[1] is now `build` still, so keep it but it stays valid (`build` is index 1). Update `TestUpdateStepsComposeFiles` expectations to the new call list (`build --build-arg DATROPE_BUILD=ccc` at index `n+1` after the extra `rev-parse HEAD`; drop the `up -d postgres server caddy` assertion; keep the final-helper assertion). Add `"time"` to imports.

- [ ] **Step 2: Run** `rtk go -C server test ./internal/updater` → FAIL.

- [ ] **Step 3: Implement** in `compose.go`. Add to `Compose`:

```go
	Switch        Switch        // the switch volume (live slot, Caddy snippets)
	Probe         Probe         // nil: HTTPProbe
	HealthTimeout time.Duration // 0: 2 minutes
```

Replace `UpdateSteps`:

```go
// UpdateSteps pulls and builds, starts the idle server slot next to the live one, switches Caddy
// and the servers to it once it is healthy, then stops the old slot. final replaces the updater
// itself, which ends this process. The live slot serves throughout; a failure before the switch
// leaves it untouched.
func UpdateSteps(g *Git, c Compose) (steps []Step, final *Step) {
	probe, timeout := c.Probe, c.HealthTimeout
	if probe == nil {
		probe = HTTPProbe
	}
	if timeout == 0 {
		timeout = 2 * time.Minute
	}
	var build, live, next string // set as the steps run
	stopNext := func(ctx context.Context, w io.Writer) {
		if err := c.cmd(ctx, w, "stop", "server-"+next); err != nil {
			fmt.Fprintf(w, "could not stop server-%s: %v\n", next, err)
		}
	}
	steps = []Step{
		g.PullStep(),
		{Title: "build", Run: func(ctx context.Context, w io.Writer) error {
			sha, err := g.output(ctx, "rev-parse", "HEAD")
			if err != nil {
				return err
			}
			build = sha
			return c.cmd(ctx, w, "build", "--build-arg", "DATROPE_BUILD="+build)
		}},
		{Title: "publish web app", Run: func(ctx context.Context, w io.Writer) error {
			return c.cmd(ctx, w, "run", "--rm", "web")
		}},
		{Title: "start new server", Run: func(ctx context.Context, w io.Writer) error {
			var err error
			if live, err = c.Switch.Active(); err != nil {
				return err
			}
			next = Other(live)
			// Services other than the slots, Caddy and the updater: normally a no-op; picks up
			// changed images or config, and removes containers of services an update dropped.
			if err := c.cmd(ctx, w, "up", "-d", "--no-deps", "--remove-orphans", "postgres", "imgproxy", "livekit"); err != nil {
				return err
			}
			return c.cmd(ctx, w, "up", "-d", "--no-deps", "server-"+next)
		}},
		{Title: "wait until healthy", Run: func(ctx context.Context, w io.Writer) error {
			if err := c.WaitHealthy(ctx, w, "server-"+next, build, probe, timeout, 2*time.Second); err != nil {
				stopNext(ctx, w)
				return err
			}
			return nil
		}},
		{Title: "switch traffic", Run: func(ctx context.Context, w io.Writer) error {
			restore, err := c.Switch.Write(next, build)
			if err != nil {
				stopNext(ctx, w)
				return err
			}
			// --force: the Caddyfile is unchanged, only the files it imports are.
			if err := c.cmd(ctx, w, "exec", "-T", "caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--force"); err != nil {
				if rerr := restore(); rerr != nil {
					fmt.Fprintf(w, "could not restore the switch files: %v\n", rerr)
				}
				stopNext(ctx, w)
				return err
			}
			fmt.Fprintf(w, "traffic now goes to server-%s\n", next)
			return nil
		}},
		{Title: "stop old server", Run: func(ctx context.Context, w io.Writer) error {
			if err := c.cmd(ctx, w, "stop", "server-"+live); err != nil {
				return err
			}
			// The live slot now runs HEAD. Failing to record that does not undo the update.
			if err := g.markDeployed(ctx); err != nil {
				fmt.Fprintf(w, "could not record the deployed commit: %v\n", err)
			}
			return nil
		}},
	}
	final = ... // unchanged "restart the updater" step
	return steps, final
}
```

Remove the now unused `services` helper and `slices` import if nothing else uses them (`server.go` uses `slices` itself, so leave that file).

Note the `--remove-orphans` call: on the first update into this layout it removes the old `server` container. The updater itself is protected because the call names services with `--no-deps` and the updater is defined in the file (orphans are only containers whose service is gone).

- [ ] **Step 4: Job stages** in `jobs.go`. Add to `UpdateJob`:

```go
	Stage      int    `json:"stage" doc:"1-based index of the running (or last) step"`
	Stages     int    `json:"stages" doc:"How many steps the job has, the updater's restart included"`
	StageTitle string `json:"stage_title,omitempty"`
```

In `Start`, set `job.Stages = len(steps)`, plus 1 when `final != nil`. In `run`, iterate with an index and before each step do `job.Stage, job.StageTitle = i+1, s.Title; _ = j.write(job)`. Change `finish` to return the `UpdateJob` it wrote; before running `final`, take that returned job (status succeeded), set `job.Stage, job.StageTitle = job.Stages, final.Title` and write it again. Test in `jobs_test.go`:

```go
func TestJobStages(t *testing.T) {
	j, err := OpenJobs(t.TempDir())
	require.NoError(t, err)
	var id string
	seen := []UpdateJob{}
	gate := make(chan struct{})
	look := func(context.Context, io.Writer) error {
		<-gate
		l, err := j.Log(id, 0)
		if err != nil {
			return err
		}
		seen = append(seen, l.Job)
		return nil
	}
	final := &Step{Title: "last", Run: func(context.Context, io.Writer) error { return nil }}
	id, err = j.Start([]Step{{Title: "one", Run: look}, {Title: "two", Run: look}}, final)
	require.NoError(t, err)
	close(gate)
	j.Wait()
	require.Len(t, seen, 2)
	require.Equal(t, 1, seen[0].Stage)
	require.Equal(t, "one", seen[0].StageTitle)
	require.Equal(t, 2, seen[1].Stage)
	require.Equal(t, 3, seen[1].Stages)
	l, err := j.Log(id, 0)
	require.NoError(t, err)
	require.Equal(t, StatusSucceeded, l.Job.Status)
	require.Equal(t, 3, l.Job.Stage)
	require.Equal(t, "last", l.Job.StageTitle)
}
```

- [ ] **Step 5: CLI.** A second process cannot share the running updater's job lock, so `deploy` asks the running updater over HTTP: it POSTs `/update` with the token from its environment (it runs via `docker compose exec updater`, same env), then polls `/jobs/{id}` every second, printing new lines, until the job ends; exit code 1 on `failed`. In `main.go`:

```go
func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	run := runServer
	if len(os.Args) > 1 && os.Args[1] == "deploy" {
		run = deploy
	}
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

// deploy starts an update through the running updater and prints its log until it ends
// (docker compose exec updater /updater deploy).
func deploy() error {
	token := os.Getenv("DATROPE_UPDATER_TOKEN")
	if token == "" {
		return errors.New("DATROPE_UPDATER_TOKEN is not set")
	}
	addr := os.Getenv("DATROPE_UPDATER_ADDR")
	if addr == "" {
		addr = ":8090"
	}
	base := "http://127.0.0.1" + addr
	if !strings.HasPrefix(addr, ":") {
		base = "http://" + addr
	}
	call := func(method, path string, out any) error {
		req, _ := http.NewRequest(method, base+path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode >= 300 {
			b, _ := io.ReadAll(res.Body)
			return fmt.Errorf("%s %s: %s %s", method, path, res.Status, strings.TrimSpace(string(b)))
		}
		return json.NewDecoder(res.Body).Decode(out)
	}
	var started struct{ JobID string `json:"job_id"` }
	if err := call(http.MethodPost, "/update", &started); err != nil {
		return err
	}
	next := 0
	for {
		var l updater.UpdateJobLog
		if err := call(http.MethodGet, fmt.Sprintf("/jobs/%s?after=%d", started.JobID, next), &l); err != nil {
			return err // the updater restarting itself at the very end ends this too
		}
		for _, line := range l.Lines {
			fmt.Println(line)
		}
		next = l.Next
		switch l.Job.Status {
		case updater.StatusSucceeded:
			return nil
		case updater.StatusFailed:
			return errors.New(l.Job.Error)
		}
		time.Sleep(time.Second)
	}
}
```

Rename the existing `run` to `runServer`. Add `switchDir = "/switch"` to the const block and set `Switch: updater.Switch{Dir: switchDir}` in the `updater.Compose{...}` literal. Add imports `encoding/json`, `fmt`, `io`. After `succeeded` the updater restarts itself; `deploy` has returned by then.

- [ ] **Step 6: Run** `rtk go -C server test ./internal/updater ./cmd/updater` → PASS. `rtk go -C server vet ./...`.

- [ ] **Step 7:** `rtk pnpm --filter @datrope/core gen` (UpdateJob gained fields). **Stage and report.**

---

### Task 7: Web build as a one-shot publisher

**Files:**
- Create: `deploy/web.Dockerfile`, `deploy/web-publish.sh`, `deploy/web-publish.test.sh`
- Delete: `deploy/caddy.Dockerfile`
- Modify: `clients/web/src/vite-env.d.ts` (or wherever `ImportMetaEnv` is declared) to add `VITE_DATROPE_BUILD`

**Interfaces:**
- Produces: image whose default command publishes `/dist` to `/web/<build>` and initialises `/switch` on a fresh install. Env: `DATROPE_BUILD` (baked), `WEB_DIR=/web`, `SWITCH_DIR=/switch`, `KEEP=3`.

- [ ] **Step 1: Write the test script** `deploy/web-publish.test.sh` (plain POSIX sh, runs on any machine with sh):

```sh
#!/bin/sh
# Tests web-publish.sh against temp directories: sh deploy/web-publish.test.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
mkdir -p "$t/dist/assets" "$t/web" "$t/switch"
echo new > "$t/dist/index.html"; echo b > "$t/dist/assets/b.js"

# fresh install: defaults written
DIST="$t/dist" WEB_DIR="$t/web" SWITCH_DIR="$t/switch" DATROPE_BUILD=bbb KEEP=3 sh "$here/web-publish.sh"
[ "$(cat "$t/switch/slot")" = blue ] || fail "slot default"
[ "$(cat "$t/switch/upstream.caddy")" = "reverse_proxy server-blue:8080" ] || fail upstream
[ "$(cat "$t/switch/root.caddy")" = "root * /web/bbb" ] || fail root
[ -f "$t/web/bbb/index.html" ] || fail publish

# next build keeps old hashed assets, does not touch switch
echo c > "$t/dist/assets/c.js"; rm "$t/dist/assets/b.js"
DIST="$t/dist" WEB_DIR="$t/web" SWITCH_DIR="$t/switch" DATROPE_BUILD=ccc KEEP=3 sh "$here/web-publish.sh"
[ -f "$t/web/ccc/assets/b.js" ] || fail "old asset merged"
[ -f "$t/web/ccc/assets/c.js" ] || fail "new asset"
[ "$(cat "$t/switch/root.caddy")" = "root * /web/bbb" ] || fail "switch untouched"

# prune: keep 3 newest, never the live one
for b in d1 d2 d3; do
  sleep 1
  DIST="$t/dist" WEB_DIR="$t/web" SWITCH_DIR="$t/switch" DATROPE_BUILD=$b KEEP=3 sh "$here/web-publish.sh"
done
[ -d "$t/web/bbb" ] || fail "live build pruned"
[ ! -d "$t/web/ccc" ] || fail "old build kept"
[ -d "$t/web/d3" ] || fail "newest pruned"
echo ok
```

- [ ] **Step 2: Run** `sh deploy/web-publish.test.sh` (Git Bash) → FAIL (script missing).

- [ ] **Step 3: Implement** `deploy/web-publish.sh`:

```sh
#!/bin/sh
# Publishes this web build to the web volume ($WEB_DIR/$DATROPE_BUILD) for Caddy. It does not
# switch to it: the updater does, together with the server (deploy/README.md, "Updates").
set -eu
DIST=${DIST:-/dist}
WEB_DIR=${WEB_DIR:-/web}
SWITCH_DIR=${SWITCH_DIR:-/switch}
KEEP=${KEEP:-3}
b=$DATROPE_BUILD
case "$b" in *[!0-9A-Za-z._-]*|''|*..*) echo "bad build: $b" >&2; exit 1 ;; esac

live=""
[ -f "$SWITCH_DIR/root.caddy" ] && live=$(sed -n 's#^root \* /web/##p' "$SWITCH_DIR/root.caddy")
prev=$(ls -1t "$WEB_DIR" 2>/dev/null | grep -v '\.tmp$' | head -n 1 || true)

rm -rf "$WEB_DIR/$b.tmp"
cp -a "$DIST" "$WEB_DIR/$b.tmp"
# Open tabs of earlier builds lazy-load their own hashed chunks after the switch.
if [ -n "$prev" ] && [ "$prev" != "$b" ] && [ -d "$WEB_DIR/$prev/assets" ]; then
  mkdir -p "$WEB_DIR/$b.tmp/assets"
  cp -an "$WEB_DIR/$prev/assets/." "$WEB_DIR/$b.tmp/assets/"
fi
rm -rf "$WEB_DIR/$b"
mv "$WEB_DIR/$b.tmp" "$WEB_DIR/$b"
touch "$WEB_DIR/$b"

# Fresh install: serve this build from the blue slot.
if [ ! -f "$SWITCH_DIR/slot" ]; then
  printf 'reverse_proxy server-blue:8080\n' > "$SWITCH_DIR/upstream.caddy"
  printf 'root * /web/%s\n' "$b" > "$SWITCH_DIR/root.caddy"
  printf 'blue\n' > "$SWITCH_DIR/slot"
  live=$b
fi

ls -1t "$WEB_DIR" | grep -v '\.tmp$' | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$live" ] || rm -rf "${WEB_DIR:?}/$old"
done
echo "published web build $b"
```

(`cp -an` is supported by busybox and GNU cp. On the developer's Git Bash `cp -an` also works.)

- [ ] **Step 4: Run** `sh deploy/web-publish.test.sh` → `ok`.

- [ ] **Step 5:** `deploy/web.Dockerfile`:

```dockerfile
FROM node:22-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY clients/core/package.json clients/core/
COPY clients/web/package.json clients/web/
RUN pnpm install --frozen-lockfile
COPY clients/core clients/core
COPY clients/web clients/web
ARG DATROPE_BUILD=dev
ENV VITE_DATROPE_BUILD=$DATROPE_BUILD
RUN pnpm --filter @datrope/web build

# Copies the build into the web volume Caddy serves from (deploy/web-publish.sh).
FROM alpine:3.20
ARG DATROPE_BUILD=dev
ENV DATROPE_BUILD=$DATROPE_BUILD
COPY --from=web /src/clients/web/dist /dist
COPY deploy/web-publish.sh /web-publish.sh
CMD ["sh", "/web-publish.sh"]
```

Delete `deploy/caddy.Dockerfile`. Copy any `.dockerignore` it relied on: if `deploy/caddy.Dockerfile.dockerignore` exists rename it to `deploy/web.Dockerfile.dockerignore` (only `updater.Dockerfile.dockerignore` exists today, so the build context is the repo root with the root `.dockerignore`; check one exists and excludes `node_modules`).

In `clients/web/src/vite-env.d.ts` add to `ImportMetaEnv`: `readonly VITE_DATROPE_BUILD?: string;` (create the interface block if it is not there).

- [ ] **Step 6: Stage and report.**

---

### Task 8: Compose, Caddyfile, e2e override, CI

**Files:**
- Modify: `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/docker-compose.e2e.yml`, `.github/workflows/ci.yml` (only if `--wait` trips on the one-shot `web`)

**Interfaces:**
- Consumes: `web.Dockerfile` (Task 7), `DATROPE_SLOT`/`DATROPE_SLOT_FILE` (Task 2), build arg `DATROPE_BUILD` (Task 1), `/switch` in the updater (Task 6).

- [ ] **Step 1: Compose.** Replace the `server` service with:

```yaml
x-server: &server
  build:
    context: ../server
    args:
      DATROPE_BUILD: ${DATROPE_BUILD:-dev}
  restart: unless-stopped
  environment: &server-env
    DATROPE_DATABASE_URL: postgres://datrope:${POSTGRES_PASSWORD}@postgres:5432/datrope?sslmode=disable
    DATROPE_PUBLIC_URL: https://${DATROPE_DOMAIN:?set DATROPE_DOMAIN in deploy/.env}
    DATROPE_TRUST_PROXY: "true"
    DATROPE_DATA_DIR: /data
    DATROPE_LIVEKIT_URL: http://livekit:7880
    DATROPE_LIVEKIT_API_KEY: datrope
    DATROPE_LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET in deploy/.env}
    DATROPE_IMGPROXY_URL: http://imgproxy:8080
    DATROPE_UPDATER_URL: http://updater:8090
    DATROPE_UPDATER_TOKEN: ${DATROPE_UPDATER_TOKEN:-}
  volumes:
    - files:/data
    - switch:/switch:ro
  depends_on:
    postgres:
      condition: service_healthy
    web:
      condition: service_completed_successfully # writes /switch/slot on a fresh install
```

(top level, before `services:`), and in `services:`:

```yaml
  # Two slots of the same server. One is live (deploy/README.md, "Updates"); an update starts the
  # other, switches Caddy to it once it is healthy, and stops the old one.
  server-blue:
    <<: *server
    environment:
      <<: *server-env
      DATROPE_SLOT: blue
  server-green:
    <<: *server
    environment:
      <<: *server-env
      DATROPE_SLOT: green

  # Copies the web app into the web volume, then exits. Caddy serves the build /switch names.
  web:
    build:
      context: ..
      dockerfile: deploy/web.Dockerfile
      args:
        DATROPE_BUILD: ${DATROPE_BUILD:-dev}
    restart: "no"
    volumes:
      - web:/web
      - switch:/switch
```

Both slots building from the same context build the image twice; the second is all cache hits. Give them one image name to avoid a second tag: add `image: datrope-server:local` under `x-server` (compose builds it once per service but the result is the same image ID).

`caddy`:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    environment:
      DATROPE_DOMAIN: ${DATROPE_DOMAIN}
    ports: [unchanged]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - switch:/switch:ro
      - web:/web:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      web:
        condition: service_completed_successfully
```

`updater` volumes: add `- switch:/switch`. Top-level `volumes:` add `switch:` and `web:`.

A plain `docker compose up -d` starts both slots: the non-live one idles (Task 2). Mention in README (Task 12).

- [ ] **Step 2: Caddyfile.** Replace the backend `reverse_proxy server:8080` with `import /switch/upstream.caddy` (keep the comment), and in the static `handle` replace `root * /srv` with `import /switch/root.caddy`.

- [ ] **Step 3: e2e override.** In `deploy/docker-compose.e2e.yml` add:

```yaml
  # One slot is enough for the browser tests.
  server-green:
    profiles: ["green"]
```

- [ ] **Step 4: Validate.** `docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e config -q` → no error. Then the CI command locally:

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait
```

Expected: exits 0, `curl -k https://localhost/healthz` (or the e2e domain) returns `{"build":"dev"}`. If `--wait` fails because `web` exited, change the CI line (and the README) to `up -d --build --wait server-blue caddy` — `depends_on` still runs `web` first.

- [ ] **Step 5:** Run Playwright e2e against that stack the way CI does (`rtk pnpm --filter @datrope/web e2e` with the env CI sets; read `.github/workflows/ci.yml` lines ~55-70 for it) → green. Tear down with `docker compose ... -p datrope-e2e down -v`.

- [ ] **Step 6: Stage and report.**

---

### Task 9: Reload banner (all clients)

**Files:**
- Modify: `clients/core/src/store.ts` (`State.serverBuild`, set in `applyReady`)
- Create: `clients/web/src/lib/build.ts`, `clients/web/src/lib/build.test.ts`
- Create: `clients/web/src/components/update-banner.tsx`
- Modify: `clients/web/src/app/AppShell.tsx`, `clients/web/src/app/mobile/MobileShell.tsx`
- Modify: `clients/web/src/sw.ts` (SKIP_WAITING message)
- Test: `clients/core/src/store.test.ts`, `clients/web/src/lib/build.test.ts`

**Interfaces:**
- Consumes: READY `build` (Task 1), `VITE_DATROPE_BUILD` (Task 7).
- Produces: `State.serverBuild: string | null`; `export const clientBuild: string`; `export function isStale(client: string, server: string | null): boolean`; `export async function reloadToNewBuild(sw?: ServiceWorkerContainer, reload?: () => void): Promise<void>`; `<UpdateBanner />`.

- [ ] **Step 1: Failing tests.** `store.test.ts` (next to the existing applyReady tests, reuse their READY fixture):

```ts
it("keeps the server build from READY", () => {
  const s = applyReady(initialState, { ...ready, build: "abc" });
  expect(s.serverBuild).toBe("abc");
});
```

`clients/web/src/lib/build.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { isStale, reloadToNewBuild } from "./build";

describe("isStale", () => {
  it("compares real builds only", () => {
    expect(isStale("aaa", "bbb")).toBe(true);
    expect(isStale("aaa", "aaa")).toBe(false);
    expect(isStale("dev", "bbb")).toBe(false);
    expect(isStale("aaa", "dev")).toBe(false);
    expect(isStale("aaa", null)).toBe(false);
  });
});

describe("reloadToNewBuild", () => {
  it("reloads straight away without a service worker", async () => {
    const reload = vi.fn();
    await reloadToNewBuild(undefined, reload);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("activates a waiting worker first, then reloads on controllerchange", async () => {
    const reload = vi.fn();
    const waiting = { postMessage: vi.fn() };
    let onChange: (() => void) | undefined;
    const sw = {
      getRegistration: async () => ({ update: async () => undefined, waiting }),
      addEventListener: (_: string, fn: () => void) => { onChange = fn; },
    } as unknown as ServiceWorkerContainer;
    const done = reloadToNewBuild(sw, reload);
    await vi.waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" }));
    expect(reload).not.toHaveBeenCalled();
    onChange?.();
    await done;
    expect(reload).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run** `rtk vitest run --root clients/core` and `rtk vitest run --root clients/web src/lib/build.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `store.ts`: add `serverBuild: string | null; // the build the server reports in READY` to `State`, `serverBuild: null` to `initialState`, and in `applyReady` return `serverBuild: r.build ?? null` alongside the other fields.

`clients/web/src/lib/build.ts`:

```ts
/** The commit this web bundle was built from; "dev" for local builds. */
export const clientBuild: string = import.meta.env.VITE_DATROPE_BUILD || "dev";

/** True when the server runs a newer build than this page (never for dev builds). */
export function isStale(client: string, server: string | null): boolean {
  return !!server && client !== "dev" && server !== "dev" && client !== server;
}

/**
 * Reloads into the new build. An installed PWA keeps serving the old app shell from a waiting
 * service worker until every window closes, so tell the waiting worker to take over first.
 */
export async function reloadToNewBuild(
  sw: ServiceWorkerContainer | undefined = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined,
  reload: () => void = () => location.reload(),
): Promise<void> {
  const reg = await sw?.getRegistration().catch(() => undefined);
  if (!sw || !reg) return reload();
  await reg.update().catch(() => undefined);
  if (!reg.waiting) return reload();
  await new Promise<void>((resolve) => {
    sw.addEventListener("controllerchange", () => resolve(), { once: true });
    reg.waiting!.postMessage({ type: "SKIP_WAITING" });
  });
  reload();
}
```

`sw.ts`, after `cleanupOutdatedCaches();`:

```ts
// The "Datrope was updated" banner's Reload: take over now instead of on next launch.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});
```

Also update the comment above `precacheAndRoute` to: "A new worker waits until every window is closed (or the update banner's Reload asks it to take over), so an open page keeps the chunks it was built with."

`clients/web/src/components/update-banner.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clientBuild, isStale, reloadToNewBuild } from "@/lib/build";
import { cn } from "@/lib/utils";
import { useApp } from "@/session";

/** "Datrope was updated" with Reload, once the server runs a newer build than this page. */
export function UpdateBanner({ className }: { className?: string }) {
  const serverBuild = useApp((s) => s.serverBuild);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isStale(clientBuild, serverBuild) || dismissed === serverBuild) return null;
  return (
    <div role="status" className={cn("fixed left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-card py-1.5 pl-4 pr-1.5 text-card-foreground shadow-lg", className)}>
      <span>Datrope was updated.</span>
      <Button size="sm" disabled={busy} onClick={() => { setBusy(true); void reloadToNewBuild(); }}>Reload</Button>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(serverBuild)}>Later</Button>
    </div>
  );
}
```

`AppShell.tsx` next to the Reconnecting pill (line ~128): `{!mobile && connection !== "reconnecting" && <UpdateBanner className="bottom-safe" />}`. `MobileShell.tsx`: render `<UpdateBanner className={...same bottom classes as its Reconnecting pill...} />` when not reconnecting.

- [ ] **Step 4: Run** the two vitest commands → PASS, then `rtk tsc --noEmit -p clients/web` and `rtk lint` → clean.

- [ ] **Step 5: Visual check.** Run the web dev server with `VITE_DATROPE_BUILD=aaa` against a dev server built with `DATROPE_BUILD=bbb` (or temporarily set `serverBuild` in the store from devtools), open the browser pane, screenshot the banner on desktop and at 375 px. Per the user's memory, show a mockup before building if a design choice is open; the banner reuses the Reconnecting pill shape, so no new design decision — skip mockups unless the user asks.

- [ ] **Step 6: Stage and report.**

---

### Task 10: Admin progress bar

**Files:**
- Modify: `clients/web/src/lib/system.ts` (`JobView` stage fields, `nextPoll`, `stageLabel`)
- Modify: `clients/web/src/lib/system.test.ts`
- Modify: `clients/web/src/app/server-settings/Updates.tsx` (render `Progress`)

**Interfaces:**
- Consumes: `UpdateJob.stage`, `stages`, `stage_title` (Task 6, regenerated types).
- Produces: `JobView.stage?: number; stages?: number; stageTitle?: string`; `export function stageLabel(v: JobView): { label: string; percent: number } | null`.

- [ ] **Step 1: Failing tests** in `system.test.ts`:

```ts
describe("stageLabel", () => {
  it("names the running step", () => {
    expect(stageLabel({ phase: "running", lines: [], next: 0, stage: 4, stages: 8, stageTitle: "start new server" }))
      .toEqual({ label: "Step 4 of 8 — Start new server", percent: 37.5 });
  });
  it("is full when done", () => {
    expect(stageLabel({ phase: "succeeded", lines: [], next: 0, stage: 8, stages: 8, stageTitle: "restart the updater" })?.percent).toBe(100);
  });
  it("is null before the first poll", () => {
    expect(stageLabel({ phase: "running", lines: [], next: 0 })).toBeNull();
  });
});

describe("nextPoll stages", () => {
  it("copies the stage from the job", () => {
    const v = nextPoll({ phase: "running", lines: [], next: 0 }, {
      log: { job: { id: "1", status: "running", started_at: "", stage: 2, stages: 8, stage_title: "build" }, lines: [], next: 0 },
    } as PollResult);
    expect(v.stage).toBe(2);
    expect(v.stageTitle).toBe("build");
  });
});
```

(Percent while running = completed steps / stages = (stage-1)/stages ×100; 4 of 8 → 37.5.)

- [ ] **Step 2: Run** `rtk vitest run --root clients/web src/lib/system.test.ts` → FAIL.

- [ ] **Step 3: Implement** in `system.ts`:

```ts
export interface JobView {
  phase: JobPhase; lines: string[]; next: number; message?: string; sha?: string;
  stage?: number; stages?: number; stageTitle?: string;
}
```

In `nextPoll`'s last line: `return { ...prev, phase, lines: [...prev.lines, ...(log.lines ?? [])], next: log.next, stage: log.job.stage, stages: log.job.stages, stageTitle: log.job.stage_title };` — keep `message`/`sha` from prev as before (today they are dropped; use the same field set as today plus the three new ones to avoid behaviour change: `{ phase, lines, next, stage, stages, stageTitle }`).

```ts
/** "Step 4 of 8 — Start new server" and how far along the update is. */
export function stageLabel(v: JobView): { label: string; percent: number } | null {
  if (!v.stage || !v.stages) return null;
  const title = v.stageTitle ? v.stageTitle[0].toUpperCase() + v.stageTitle.slice(1) : "";
  const done = v.phase === "succeeded" ? v.stages : v.stage - 1;
  return { label: `Step ${v.stage} of ${v.stages}${title ? ` — ${title}` : ""}`, percent: (done / v.stages) * 100 };
}
```

In `Updates.tsx`, where the job log is rendered while `jobRunning || job.phase === "succeeded"`, add above the log:

```tsx
{job && stageLabel(job) && (
  <div className="grid gap-1.5">
    <p className="text-sm text-muted-foreground">{stageLabel(job)!.label}</p>
    <Progress value={stageLabel(job)!.percent} aria-label="Update progress" />
  </div>
)}
```

(import `Progress` from `@/components/ui/progress`, `stageLabel` from `@/lib/system`; compute `const progress = job ? stageLabel(job) : null;` once at the top of `UpdatesView` instead of calling it three times.)

- [ ] **Step 4: Run** tests → PASS; `rtk tsc --noEmit -p clients/web`; any existing `UpdatesView` test still passes (`rtk vitest run --root clients/web`).

- [ ] **Step 5: Stage and report.**

---

### Task 11: Compose blue/green end-to-end check

**Files:**
- Create: `deploy/e2e-bluegreen.sh`

**Interfaces:**
- Consumes: everything above. Runs on Linux (the updater needs Linux host paths, as the README already says): on this Windows machine, run it inside WSL2 with Docker Desktop's WSL integration. Needs `git`, `curl`, `docker compose`.

The updater builds HEAD's sha and pulls `origin main`, so the script works on a throwaway clone whose `origin` is itself and whose `main` is the commit under test. The stack starts with build `one`; the update must move `/healthz` to the clone's HEAD sha without a single failed request.

- [ ] **Step 1: Write the script**:

```sh
#!/bin/sh
# Zero-downtime update check against a throwaway stack (Linux/WSL2, Docker):
#   sh deploy/e2e-bluegreen.sh
# Clones this checkout to a temp dir (origin = itself, main = HEAD), starts the stack there with
# build "one", runs an update through the updater, and checks that no request failed, the new
# build is live, the old slot stopped, and an old hashed asset still loads.
set -eu
src=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
tmp=$(mktemp -d)
P=datrope-bg
git clone -q "$src" "$tmp/repo"
git -C "$tmp/repo" checkout -q -B main "$(git -C "$src" rev-parse HEAD)"
git -C "$tmp/repo" remote set-url origin "$tmp/repo"
sha=$(git -C "$tmp/repo" rev-parse HEAD)
cp "$src/deploy/.env.e2e" "$tmp/repo/deploy/.env.e2e"
cd "$tmp/repo/deploy"
C="docker compose -p $P -f docker-compose.yml -f docker-compose.e2e.yml --env-file .env.e2e --profile updater"
export DATROPE_UPDATER_TOKEN=bgtest
cleanup() { $C down -v >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }

DATROPE_BUILD=one $C up -d --build --wait server-blue caddy updater
base=https://localhost
curl -ksf $base/healthz | grep -q '"one"' || fail "build one not live"
old_asset=$(curl -ksf $base/ | grep -o '/assets/[^"]*\.js' | head -n 1)
[ -n "$old_asset" ] || fail "no asset in index.html"

# Hit /healthz through Caddy every 100 ms during the update; count failures.
: > "$tmp/fails"
( while [ ! -f "$tmp/stop" ]; do
    curl -ksf -o /dev/null --max-time 2 $base/healthz || echo x >> "$tmp/fails"
    sleep 0.1
  done ) &
loop=$!

$C exec -T updater /updater deploy || fail "deploy failed"

touch "$tmp/stop"; wait $loop
n=$(wc -l < "$tmp/fails")
[ "$n" -eq 0 ] || fail "$n requests failed during the update"
curl -ksf $base/healthz | grep -q "\"$sha\"" || fail "build $sha not live"
[ -z "$($C ps -q server-blue)" ] || fail "old slot still running"
curl -ksf -o /dev/null "$base$old_asset" || fail "old asset $old_asset gone"
echo ok
```

Check `deploy/.env.e2e` sets `DATROPE_DOMAIN=localhost` (or adapt `base`). `docker compose ps -q` lists running containers only, so a stopped `server-blue` gives an empty string.

- [ ] **Step 2: Run** `sh deploy/e2e-bluegreen.sh` in WSL2 → `ok`. Fix what it finds in the code (likely suspects: `--wait` with the one-shot `web`, Caddy reload output, file ownership on the `switch` volume — `web` and the updater write as root, Caddy and the servers only read).

- [ ] **Step 3:** The gateway reconnect after the switch (WebSocket closed by `caddy reload`, RESUME fails on the new server, IDENTIFY gets READY with the new `build`) needs a logged-in session, so check it by hand once: comment out the `trap`, run the script up to the deploy, open `https://localhost` in the browser pane, sign up a test user, run the deploy, and confirm the "Reconnecting…" pill shows briefly and then "Datrope was updated." (page build `one`, server build the sha). Screenshot it.

- [ ] **Step 4: Stage and report** with the script output and the screenshot.

---

### Task 12: Docs

**Files:**
- Modify: `deploy/README.md` ("System dashboard and updates", "Updating")

- [ ] **Step 1: Rewrite** "System dashboard and updates" → keep the existing paragraphs about the token, Linux host and HTTPS remote; replace the paragraph on how an update runs with:

```markdown
### How an update runs

The server runs in two slots, `server-blue` and `server-green`; one is live. An update pulls,
builds, copies the new web app into the `web` volume, and starts the idle slot next to the live
one. The new server migrates the database and, once Docker reports it healthy and it answers
`/healthz` with the new commit, the updater points Caddy at it (`caddy reload`) and stops the old
slot. Nothing is down: requests keep going to the old server until the switch.

What a switch costs: every open connection reconnects once, watch-together sessions end, and the
music bot stops playing. Open apps show "Datrope was updated" with a Reload button.

If the new server does not get healthy within two minutes, the update stops, the new slot is
stopped and the old one keeps serving. The log under Server settings → Updates says why.

Migrations run while the previous release still serves, so they must work with its code: see
`server/internal/db/migrations/README.md`.

The `switch` volume holds which slot is live (`slot`) and the two snippets Caddy imports. A plain
`docker compose up -d` starts both slots; the one `slot` does not name stays idle (it answers
health checks but runs no background jobs) until the next update stops it.
```

"Updating" section: replace its commands with

```bash
git pull
docker compose exec updater /updater deploy
```

and a note: "This is what the Update button runs. `docker compose up -d --build` also works but restarts everything at once (a short outage). Moving an existing install to the two-slot layout: the first update (from the button or by hand) still restarts the stack once; afterwards updates are seamless."

- [ ] **Step 2: Stage and report.** Leave the final summary of staged files for the user to commit.

---

## Self-review notes

- Spec §1 compose/Caddy/standby → Tasks 2, 7, 8. §2 flow + manual CLI + progress fields → Tasks 4–6. §3 build ID, slot watcher, guard → Tasks 1–3. §4 progress bar + banner → Tasks 9–10. §5 testing → per task + Task 11. §6 docs → Task 12.
- Spec said the `deploy` CLI "runs the same steps in the foreground"; the plan routes it through the running updater's HTTP API instead, so the job lock and the dashboard record are shared. Same steps, same output.
- Spec mentioned `up -d --no-deps postgres imgproxy livekit` between publish and start; Task 6 does it at the start of "start new server" with `--remove-orphans` added for the layout migration.
- Spec §5 has the e2e script hold a gateway WebSocket; that needs a logged-in session, so Task 11 scripts HTTP continuity and checks the gateway reconnect + banner by hand in the browser pane (Step 3).
