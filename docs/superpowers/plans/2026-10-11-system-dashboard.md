# System Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-only System and Updates area in Server settings: live host/container metrics, in-place yt-dlp updates, and pull/rebuild/restart of the compose stack through a token-guarded `updater` sidecar.

**Architecture:** New Go package `server/internal/system` (sampler over `/proc` + `statfs`, yt-dlp updater, HTTP API, client for the updater). New Go package `server/internal/updater` + binary `server/cmd/updater` (git, Docker Engine API over the unix socket, `docker compose` via exec, job log on disk), run as a compose service that alone holds the Docker socket. The web client gets two settings sections that poll the API.

**Tech Stack:** Go 1.25, huma v2, pgx, testify; React 18 + shadcn/ui + Tailwind v4, openapi-fetch (`@datrope/core`), vitest, Playwright; Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-11-system-dashboard-design.md`

## Global Constraints

- Never `git commit`/`push` (AGENTS.md). Each task ends by **staging** its files; the user commits.
- On this machine git needs `-c safe.directory=*` (exFAT): `git -c safe.directory=* add ...`.
- The dev machine is Windows (no cgo, no gcc). Go code and tests must build and pass on Windows: Linux-only syscalls go behind `//go:build unix` files with a stub for other platforms; tests that need symlinks or exec bits skip on Windows.
- Only the `updater` container mounts `/var/run/docker.sock`. The server never does; the browser never talks to the updater.
- Updater requests need `Authorization: Bearer $DATROPE_UPDATER_TOKEN`, compared with `crypto/subtle.ConstantTimeCompare`.
- Ring buffer: sample every 5 s, keep 120 samples (10 min). Slow stats (DB size, files size) every 5 min. Nothing stored in Postgres.
- yt-dlp lives at `DataDir/bin/yt-dlp` once updated; `DATROPE_YTDLP` set pins the binary (no in-place update).
- Update job steps in order: `git pull --ff-only origin main`, `docker compose build`, `docker compose up -d <all services except updater>`, mark succeeded, `docker compose up -d --no-deps updater`. Stop at the first failure.
- Keep the latest 10 jobs in `/state/jobs`. A job found `running` at updater start becomes `failed` with error `interrupted`.
- Web: shadcn components from `src/components/ui`, token colours only, no `dark:` classes, `cn()` from `@/lib/utils`, `Button` defaults to `type="button"`.
- Accessible names used by tests: nav links "System" and "Updates"; headings "Host", "Containers", "Server", "yt-dlp"; buttons "Check now", "Update server", "Update yt-dlp", "Restart <service>".
- Deliberate deviations from the spec: (1) git runs as the checkout's owner (`su-exec uid:gid`) instead of root + `safe.directory`, so `git pull` never leaves root-owned files in the user's checkout; (2) without a token the updater idles (logs "disabled", waits for SIGTERM) instead of exiting, so `restart: unless-stopped` does not crash-loop; (3) the pinned flag is called `pinned` in the API (spec: "managed").

## Review Focus

- **Server down mid-update:** the Updates page must keep polling through 502/503/network errors and resume the log from its last offset once the server and the new updater answer; never show "failed" just because a poll failed. (Test: `nextPoll` in Task 12.)
- **Updater unreachable or not configured:** System still shows host metrics (the Containers section shows the reason), Updates still shows yt-dlp; only server-update and restart are replaced by an explanation. (Tests: Task 10 `TestSystemUpdaterDown`/`TestSystemWithoutUpdater`, Task 11/12 view tests.)
- **Concurrent update clicks:** a second `POST /updates/server` while one runs returns 409 `UPDATE_RUNNING`. (Tests: Task 6 `TestJobBusy`, mapping in Task 10.)
- **Bad yt-dlp download:** checksum mismatch, a missing SHA2-256SUMS entry, or a new binary whose `--version` fails leaves the old binary and path in use. (Test: Task 5 `TestYtDlpUpdateKeepsOldBinaryOnFailure`.)
- **Hostile path input:** job IDs that are not all digits and service names outside the compose project (or `updater` itself) are rejected and never reach the filesystem or `docker compose`. (Tests: Task 6 `TestJobRejectsBadIDs`, Task 9 `TestServerRestartWhitelist`.)

---

### Task 1: `/proc` parsing

**Files:**
- Create: `server/internal/system/proc.go`
- Test: `server/internal/system/proc_test.go`

**Interfaces:**
- Produces (package-internal): `type cpuTimes struct{ idle, total uint64 }`, `parseCPU([]byte) (cpuTimes, error)`, `cpuPercent(prev, cur cpuTimes) float64`, `type memInfo struct{ total, available uint64 }` (bytes), `parseMeminfo([]byte) (memInfo, error)`, `parseUptime([]byte) (time.Duration, error)`.

- [ ] **Step 1: Write the failing test**

```go
package system

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestParseCPU(t *testing.T) {
	// user nice system idle iowait irq softirq steal guest guest_nice
	stat := "cpu  100 0 50 800 50 0 0 0 30 0\ncpu0 1 2 3 4 5 6 7 8 9 10\nintr 1\n"
	c, err := parseCPU([]byte(stat))
	require.NoError(t, err)
	require.Equal(t, cpuTimes{idle: 850, total: 1000}, c, "guest is already in user; idle includes iowait")

	_, err = parseCPU([]byte("intr 1\n"))
	require.Error(t, err)
}

func TestCPUPercent(t *testing.T) {
	require.InDelta(t, 25.0, cpuPercent(cpuTimes{idle: 850, total: 1000}, cpuTimes{idle: 1000, total: 1200}), 0.001)
	require.Zero(t, cpuPercent(cpuTimes{idle: 1, total: 10}, cpuTimes{idle: 1, total: 10}), "no time passed")
	require.Zero(t, cpuPercent(cpuTimes{idle: 5, total: 10}, cpuTimes{idle: 1, total: 4}), "counters reset")
}

func TestParseMeminfo(t *testing.T) {
	m, err := parseMeminfo([]byte("MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    4000000 kB\n"))
	require.NoError(t, err)
	require.Equal(t, memInfo{total: 16000000 * 1024, available: 4000000 * 1024}, m)

	_, err = parseMeminfo([]byte("MemFree: 1 kB\n"))
	require.Error(t, err)
}

func TestParseUptime(t *testing.T) {
	d, err := parseUptime([]byte("3600.50 7000.00\n"))
	require.NoError(t, err)
	require.Equal(t, 3600*time.Second+500*time.Millisecond, d)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/system/`
Expected: FAIL (`undefined: parseCPU` ...)

- [ ] **Step 3: Write minimal implementation**

```go
package system

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Parsers for /proc files. Inside a container without lxcfs they describe the host,
// which is what the dashboard shows.

type cpuTimes struct{ idle, total uint64 }

// parseCPU reads the aggregate "cpu" line of /proc/stat.
func parseCPU(stat []byte) (cpuTimes, error) {
	line, _, _ := bytes.Cut(stat, []byte("\n"))
	f := strings.Fields(string(line))
	if len(f) < 5 || f[0] != "cpu" {
		return cpuTimes{}, errors.New("system: no cpu line in /proc/stat")
	}
	var t cpuTimes
	for i, s := range f[1:] {
		if i >= 8 { // guest and guest_nice are already counted in user and nice
			break
		}
		n, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return cpuTimes{}, fmt.Errorf("system: /proc/stat: %w", err)
		}
		t.total += n
		if i == 3 || i == 4 { // idle, iowait
			t.idle += n
		}
	}
	return t, nil
}

// cpuPercent is the busy share of the time between two readings.
func cpuPercent(prev, cur cpuTimes) float64 {
	if cur.total <= prev.total || cur.idle < prev.idle {
		return 0
	}
	dt, di := cur.total-prev.total, cur.idle-prev.idle
	if di > dt {
		return 0
	}
	return float64(dt-di) / float64(dt) * 100
}

type memInfo struct{ total, available uint64 } // bytes

func parseMeminfo(b []byte) (memInfo, error) {
	var m memInfo
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) == 0 {
			continue
		}
		n, err := strconv.ParseUint(f[0], 10, 64)
		if err != nil {
			continue
		}
		switch k {
		case "MemTotal":
			m.total = n * 1024
		case "MemAvailable":
			m.available = n * 1024
		}
	}
	if m.total == 0 {
		return m, errors.New("system: no MemTotal in /proc/meminfo")
	}
	return m, nil
}

func parseUptime(b []byte) (time.Duration, error) {
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0, errors.New("system: empty /proc/uptime")
	}
	s, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0, fmt.Errorf("system: /proc/uptime: %w", err)
	}
	return time.Duration(s * float64(time.Second)), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/system/`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git -c safe.directory=* add server/internal/system/proc.go server/internal/system/proc_test.go
```

---

### Task 2: Sampler and ring buffer

**Files:**
- Create: `server/internal/system/sampler.go`, `server/internal/system/disk_unix.go`, `server/internal/system/disk_other.go`
- Test: `server/internal/system/sampler_test.go`

**Interfaces:**
- Consumes: Task 1 parsers.
- Produces:

```go
type SystemSample struct { At time.Time; CPUPercent float64; MemUsed, MemTotal, DiskUsed, DiskTotal uint64; Connections, InVoice int }
// json: at, cpu_percent, mem_used, mem_total, disk_used, disk_total, connections, in_voice
type HostStats struct { Latest *SystemSample; Series []SystemSample; HostUptimeSeconds, ProcessUptimeSeconds, DatabaseBytes, FilesBytes int64 }
// json: latest, series, host_uptime_seconds, process_uptime_seconds, database_bytes, files_bytes
type Sources struct {
	Proc         fs.FS                                              // /proc; nil off Linux
	DataDir      string
	Disk         func(path string) (used, total uint64, err error) // nil: diskUsage
	Connections  func() int                                         // nil: 0
	InVoice      func() int                                         // nil: 0
	DatabaseSize func(ctx context.Context) (int64, error)           // nil: 0
}
func NewSampler(src Sources, started time.Time) *Sampler
func (s *Sampler) Sample(now time.Time)
func (s *Sampler) SampleSlow(ctx context.Context)
func (s *Sampler) Snapshot(now time.Time) HostStats
func (s *Sampler) Run(ctx context.Context)
```

- [ ] **Step 1: Write the failing test**

```go
package system

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/stretchr/testify/require"
)

func procFS(stat string) fstest.MapFS {
	return fstest.MapFS{
		"stat":    {Data: []byte(stat)},
		"meminfo": {Data: []byte("MemTotal: 1000 kB\nMemAvailable: 250 kB\n")},
		"uptime":  {Data: []byte("7200.00 1.00\n")},
	}
}

func TestSamplerSamples(t *testing.T) {
	proc := procFS("cpu  100 0 0 900 0 0 0 0\n")
	conns := 3
	s := NewSampler(Sources{
		Proc:        proc,
		DataDir:     t.TempDir(),
		Disk:        func(string) (uint64, uint64, error) { return 40, 100, nil },
		Connections: func() int { return conns },
		InVoice:     func() int { return 2 },
	}, time.Unix(1000, 0))

	s.Sample(time.Unix(1005, 0))
	proc["stat"] = &fstest.MapFile{Data: []byte("cpu  150 0 0 950 0 0 0 0\n")}
	conns = 4
	s.Sample(time.Unix(1010, 0))

	snap := s.Snapshot(time.Unix(1010, 0))
	require.Len(t, snap.Series, 2)
	require.Zero(t, snap.Series[0].CPUPercent, "the first sample has nothing to compare with")
	require.Equal(t, SystemSample{
		At: time.Unix(1010, 0), CPUPercent: 50, MemUsed: 750 * 1024, MemTotal: 1000 * 1024,
		DiskUsed: 40, DiskTotal: 100, Connections: 4, InVoice: 2,
	}, *snap.Latest)
	require.Equal(t, int64(7200), snap.HostUptimeSeconds)
	require.Equal(t, int64(10), snap.ProcessUptimeSeconds)
}

func TestSamplerKeepsTenMinutes(t *testing.T) {
	s := NewSampler(Sources{Proc: procFS("cpu  1 0 0 1 0 0 0 0\n"), Disk: func(string) (uint64, uint64, error) { return 0, 0, nil }}, time.Unix(0, 0))
	for i := 0; i < keepSamples+5; i++ {
		s.Sample(time.Unix(int64(i*5), 0))
	}
	snap := s.Snapshot(time.Unix(0, 0))
	require.Len(t, snap.Series, keepSamples)
	require.Equal(t, time.Unix(25, 0), snap.Series[0].At, "oldest five dropped")
}

func TestSamplerWithoutProc(t *testing.T) {
	s := NewSampler(Sources{Disk: func(string) (uint64, uint64, error) { return 1, 2, nil }}, time.Unix(0, 0))
	s.Sample(time.Unix(5, 0))
	snap := s.Snapshot(time.Unix(5, 0))
	require.Equal(t, uint64(2), snap.Latest.DiskTotal, "disk still works off Linux")
	require.Zero(t, snap.Latest.MemTotal)
}

func TestSamplerSlow(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "files", "ab"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "files", "a"), make([]byte, 10), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "files", "ab", "b"), make([]byte, 5), 0o644))
	s := NewSampler(Sources{DataDir: dir, DatabaseSize: func(context.Context) (int64, error) { return 1234, nil }}, time.Unix(0, 0))
	s.SampleSlow(context.Background())
	snap := s.Snapshot(time.Unix(0, 0))
	require.Equal(t, int64(1234), snap.DatabaseBytes)
	require.Equal(t, int64(15), snap.FilesBytes)
	require.Nil(t, snap.Latest)
	require.NotNil(t, snap.Series, "an empty series is [] in JSON, not null")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/system/ -run TestSampler`
Expected: FAIL (`undefined: NewSampler`)

- [ ] **Step 3: Write the implementation**

`server/internal/system/disk_unix.go`:

```go
//go:build unix

package system

import "syscall"

// diskUsage reports the filesystem holding path. used counts what ordinary users can no longer write.
func diskUsage(path string) (used, total uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize)
	total = st.Blocks * bs
	return total - st.Bavail*bs, total, nil
}
```

`server/internal/system/disk_other.go`:

```go
//go:build !unix

package system

import "errors"

func diskUsage(string) (used, total uint64, err error) {
	return 0, 0, errors.New("system: disk usage needs a unix system")
}
```

`server/internal/system/sampler.go`:

```go
package system

import (
	"context"
	"io/fs"
	"log/slog"
	"path/filepath"
	"sync"
	"time"
)

const (
	sampleEvery = 5 * time.Second
	keepSamples = 120 // 10 minutes
	slowEvery   = 5 * time.Minute
)

// SystemSample is one reading of the host.
type SystemSample struct {
	At          time.Time `json:"at"`
	CPUPercent  float64   `json:"cpu_percent"`
	MemUsed     uint64    `json:"mem_used"`
	MemTotal    uint64    `json:"mem_total"`
	DiskUsed    uint64    `json:"disk_used"`
	DiskTotal   uint64    `json:"disk_total"`
	Connections int       `json:"connections" doc:"Open gateway WebSockets"`
	InVoice     int       `json:"in_voice" doc:"People in voice channels"`
}

// HostStats is what the dashboard shows about the machine.
type HostStats struct {
	Latest               *SystemSample  `json:"latest"`
	Series               []SystemSample `json:"series" doc:"Oldest first, every 5 s, up to 10 minutes"`
	HostUptimeSeconds    int64          `json:"host_uptime_seconds"`
	ProcessUptimeSeconds int64          `json:"process_uptime_seconds"`
	DatabaseBytes        int64          `json:"database_bytes"`
	FilesBytes           int64          `json:"files_bytes"`
}

// Sources are where the sampler reads from; tests replace them.
type Sources struct {
	Proc         fs.FS // /proc; nil off Linux
	DataDir      string
	Disk         func(path string) (used, total uint64, err error) // nil: diskUsage
	Connections  func() int
	InVoice      func() int
	DatabaseSize func(ctx context.Context) (int64, error)
}

// Sampler keeps the last ten minutes of host readings in memory.
type Sampler struct {
	src     Sources
	started time.Time

	mu         sync.Mutex
	prev       cpuTimes
	havePrev   bool
	ring       []SystemSample
	hostUptime time.Duration
	dbBytes    int64
	filesBytes int64
}

func NewSampler(src Sources, started time.Time) *Sampler {
	if src.Disk == nil {
		src.Disk = diskUsage
	}
	return &Sampler{src: src, started: started}
}

// Sample takes one reading. Sources that fail leave their fields zero.
func (s *Sampler) Sample(now time.Time) {
	x := SystemSample{At: now}
	var cpu cpuTimes
	cpuOK := false
	var up time.Duration
	if s.src.Proc != nil {
		if b, err := fs.ReadFile(s.src.Proc, "stat"); err == nil {
			cpu, err = parseCPU(b)
			cpuOK = err == nil
		}
		if b, err := fs.ReadFile(s.src.Proc, "meminfo"); err == nil {
			if m, err := parseMeminfo(b); err == nil {
				x.MemTotal, x.MemUsed = m.total, m.total-min(m.available, m.total)
			}
		}
		if b, err := fs.ReadFile(s.src.Proc, "uptime"); err == nil {
			up, _ = parseUptime(b)
		}
	}
	if used, total, err := s.src.Disk(s.src.DataDir); err == nil {
		x.DiskUsed, x.DiskTotal = used, total
	}
	if s.src.Connections != nil {
		x.Connections = s.src.Connections()
	}
	if s.src.InVoice != nil {
		x.InVoice = s.src.InVoice()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if cpuOK {
		if s.havePrev {
			x.CPUPercent = cpuPercent(s.prev, cpu)
		}
		s.prev, s.havePrev = cpu, true
	}
	if up > 0 {
		s.hostUptime = up
	}
	s.ring = append(s.ring, x)
	if len(s.ring) > keepSamples {
		s.ring = append(s.ring[:0], s.ring[len(s.ring)-keepSamples:]...)
	}
}

// SampleSlow measures the database and the stored files.
func (s *Sampler) SampleSlow(ctx context.Context) {
	var db int64
	if s.src.DatabaseSize != nil {
		n, err := s.src.DatabaseSize(ctx)
		if err != nil {
			slog.Warn("system: database size", "err", err)
		}
		db = n
	}
	var files int64
	if s.src.DataDir != "" {
		_ = filepath.WalkDir(filepath.Join(s.src.DataDir, "files"), func(_ string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // removed while walking, or no files dir yet
			}
			if d.Type().IsRegular() {
				if info, err := d.Info(); err == nil {
					files += info.Size()
				}
			}
			return nil
		})
	}
	s.mu.Lock()
	s.dbBytes, s.filesBytes = db, files
	s.mu.Unlock()
}

func (s *Sampler) Snapshot(now time.Time) HostStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := HostStats{
		Series:               append([]SystemSample{}, s.ring...),
		HostUptimeSeconds:    int64(s.hostUptime / time.Second),
		ProcessUptimeSeconds: int64(now.Sub(s.started) / time.Second),
		DatabaseBytes:        s.dbBytes,
		FilesBytes:           s.filesBytes,
	}
	if n := len(h.Series); n > 0 {
		last := h.Series[n-1]
		h.Latest = &last
	}
	return h
}

// Run samples until ctx ends.
func (s *Sampler) Run(ctx context.Context) {
	s.Sample(time.Now())
	s.SampleSlow(ctx)
	fast, slow := time.NewTicker(sampleEvery), time.NewTicker(slowEvery)
	defer fast.Stop()
	defer slow.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-fast.C:
			s.Sample(now)
		case <-slow.C:
			s.SampleSlow(ctx)
		}
	}
}
```

- [ ] **Step 4: Run tests**

Run: `cd server && go test ./internal/system/ && go vet ./internal/system/`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git -c safe.directory=* add server/internal/system/
```

---

### Task 3: Connection and voice counters

**Files:**
- Modify: `server/internal/gateway/gateway.go` (new method after `StatusOf`, ~line 172)
- Modify: `server/internal/voice/voice.go` (new method after `States`, ~line 595)
- Modify: `server/internal/app/app.go` (`App` struct; gateway block ~line 202)
- Test: `server/internal/gateway/connections_test.go`, `server/internal/voice/participants_test.go`

**Interfaces:**
- Produces: `func (g *Gateway) Connections() int`, `func (s *voice.Service) Participants() int`, `App.Gateway *gateway.Gateway` (nil without a database).

- [ ] **Step 1: Write the failing tests**

`server/internal/gateway/connections_test.go`:

```go
package gateway_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
)

func TestConnections(t *testing.T) {
	env := apptest.New(t)
	require.Zero(t, env.App.Gateway.Connections())
	ws, _ := env.Register("alice").Connect()
	require.Equal(t, 1, env.App.Gateway.Connections())
	ws.Close()
	require.Eventually(t, func() bool { return env.App.Gateway.Connections() == 0 }, 5*time.Second, 20*time.Millisecond,
		"a closed socket stops counting even while its session waits to be resumed")
}
```

`server/internal/voice/participants_test.go`:

```go
package voice

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
)

func TestParticipants(t *testing.T) {
	s := NewService(Config{}, &events.Bus{}, nil, nil)
	require.Zero(t, s.Participants())
	s.users[id.ID(1)] = &participant{}
	s.users[id.ID(2)] = &participant{}
	require.Equal(t, 2, s.Participants())
}
```

(If the voice package's existing tests are an external `voice_test` package only, this internal test file is still fine: Go allows both.)

- [ ] **Step 2: Run to verify failure**

Run: `cd server && go test ./internal/gateway/ -run TestConnections` and `go test ./internal/voice/ -run TestParticipants`
Expected: FAIL (`env.App.Gateway undefined`, `s.Participants undefined`)

- [ ] **Step 3: Implement**

`gateway.go`, after `StatusOf`:

```go
// Connections counts sessions with an open WebSocket (not those waiting to be resumed).
func (g *Gateway) Connections() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, s := range g.sessions {
		if s.conn != nil {
			n++
		}
	}
	return n
}
```

`voice.go`, after `States`:

```go
// Participants counts the people in voice channels.
func (s *Service) Participants() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.users)
}
```

`app.go`: add to `App` after `Music`:

```go
	Gateway      *gateway.Gateway // nil when built without a database
```

and in the gateway block, after `commSvc.SetPresence(gw)`, add `a.Gateway = gw`.

- [ ] **Step 4: Run tests**

Run: `cd server && go test ./internal/gateway/ ./internal/voice/`
Expected: PASS (Postgres runs in testcontainers: Docker must be running)

- [ ] **Step 5: Stage**

```bash
git -c safe.directory=* add server/internal/gateway/ server/internal/voice/ server/internal/app/app.go
```

---
### Task 4: Swappable yt-dlp path

**Files:**
- Create: `server/internal/music/ytdlp_path.go`, `server/internal/system/ytdlp_binary.go`
- Modify: `server/internal/music/music.go` (Config ~line 29, NewService ~line 142), `server/internal/music/source.go` (`ytDlp` ~line 81, `run` ~line 94)
- Test: `server/internal/music/ytdlp_path_test.go`, `server/internal/system/ytdlp_binary_test.go`

**Interfaces:**
- Produces:
  - `music.YtDlpPath`: `music.NewYtDlpPath(path string) *YtDlpPath`, `(*YtDlpPath).Get() string`, `(*YtDlpPath).Set(path string)`.
  - `music.Config.YtDlpPath *YtDlpPath`: when non-nil, the music service uses it (YouTube is on only if `Get() != ""` at startup) and ignores `YtDlp`.
  - `system.YtDlpBinary(configured, dataDir string) (path string, pinned bool)`; `system.ManagedYtDlp(dataDir string) string` = `filepath.Join(dataDir, "bin", "yt-dlp")`.

- [ ] **Step 1: Write the failing tests**

`server/internal/music/ytdlp_path_test.go`:

```go
package music

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestYtDlpPathSwap(t *testing.T) {
	p := NewYtDlpPath("/usr/local/bin/yt-dlp")
	y := ytDlp{path: p}
	require.Equal(t, "/usr/local/bin/yt-dlp", y.path.Get())
	p.Set("/data/bin/yt-dlp")
	require.Equal(t, "/data/bin/yt-dlp", y.path.Get(), "the resolver sees a swap on its next call")
}
```

`server/internal/system/ytdlp_binary_test.go`:

```go
package system

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestYtDlpBinary(t *testing.T) {
	dir := t.TempDir()
	_, pinned := YtDlpBinary("", dir)
	require.False(t, pinned)

	require.NoError(t, os.MkdirAll(filepath.Join(dir, "bin"), 0o755))
	require.NoError(t, os.WriteFile(ManagedYtDlp(dir), []byte("x"), 0o755))
	path, pinned := YtDlpBinary("", dir)
	require.Equal(t, ManagedYtDlp(dir), path, "an updated copy wins over the image's")
	require.False(t, pinned)

	_, pinned = YtDlpBinary("/opt/yt-dlp", dir)
	require.True(t, pinned, "DATROPE_YTDLP pins the binary")
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && go test ./internal/music/ -run TestYtDlpPath` and `go test ./internal/system/ -run TestYtDlpBinary`
Expected: FAIL (undefined)

- [ ] **Step 3: Implement**

`server/internal/music/ytdlp_path.go`:

```go
package music

import "sync/atomic"

// YtDlpPath is the yt-dlp binary in use. The system dashboard swaps it after an update;
// the next yt-dlp call uses the new one and running calls finish on the old.
type YtDlpPath struct{ p atomic.Pointer[string] }

func NewYtDlpPath(path string) *YtDlpPath {
	y := &YtDlpPath{}
	y.Set(path)
	return y
}

func (y *YtDlpPath) Get() string { return *y.p.Load() }

func (y *YtDlpPath) Set(path string) { y.p.Store(&path) }
```

`music.go` Config, after `YtDlp  string`:

```go
	// YtDlpPath, when set, is the yt-dlp to use (it may change at run time); YtDlp is then ignored.
	YtDlpPath *YtDlpPath
```

`music.go` NewService, replace the `if yt := lookPath(cfg.YtDlp, "yt-dlp"); ...` block with:

```go
	switch {
	case cfg.YtDlpPath != nil:
		if cfg.YtDlpPath.Get() != "" {
			s.resolver = ytDlp{path: cfg.YtDlpPath, sources: cfg.Sources}
		}
	default:
		if yt := lookPath(cfg.YtDlp, "yt-dlp"); yt != "" {
			s.resolver = ytDlp{path: NewYtDlpPath(yt), sources: cfg.Sources}
		}
	}
```

`source.go`: change the field to `path    *YtDlpPath` and in `run` use `exec.CommandContext(ctx, y.path.Get(), y.args(args...)...)`. `internal_test.go:20` (`ytDlp{sources: ...}.args(...)`) still compiles: it never touches `path`.

`server/internal/system/ytdlp_binary.go`:

```go
package system

import (
	"os"
	"os/exec"
	"path/filepath"
)

// ManagedYtDlp is where in-place updates put yt-dlp (the data volume, so it survives restarts).
func ManagedYtDlp(dataDir string) string { return filepath.Join(dataDir, "bin", "yt-dlp") }

// YtDlpBinary picks the yt-dlp to use. DATROPE_YTDLP (configured) pins it; otherwise an updated
// copy on the data volume wins over the one in the image. path is "" when there is none.
func YtDlpBinary(configured, dataDir string) (path string, pinned bool) {
	if configured != "" {
		p, err := exec.LookPath(configured)
		if err != nil {
			return "", true
		}
		return p, true
	}
	if st, err := os.Stat(ManagedYtDlp(dataDir)); err == nil && st.Mode().IsRegular() {
		return ManagedYtDlp(dataDir), false
	}
	p, err := exec.LookPath("yt-dlp")
	if err != nil {
		return "", false
	}
	return p, false
}
```

- [ ] **Step 4: Run tests**

Run: `cd server && go test ./internal/music/ ./internal/system/ && go vet ./...`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git -c safe.directory=* add server/internal/music/ server/internal/system/
```

---

### Task 5: yt-dlp check and in-place update

**Files:**
- Create: `server/internal/system/ytdlp.go`
- Test: `server/internal/system/ytdlp_test.go`

**Interfaces:**
- Consumes: `music.YtDlpPath`, `ManagedYtDlp` (Task 4).
- Produces:

```go
type YtDlpOptions struct {
	Path    *music.YtDlpPath // never nil; Get() == "" when there is no yt-dlp
	Managed string           // ManagedYtDlp(DataDir)
	Pinned  bool
	API     string           // GitHub API base; "" = https://api.github.com
	Client  *http.Client     // nil = 60 s timeout
	Version func(ctx context.Context, path string) (string, error) // nil = run "<path> --version"
}
type YtDlpStatus struct { Available bool; Installed, Latest string; CheckedAt *time.Time; Pinned bool; Error string }
// json: available, installed, latest, checked_at (omitempty), pinned, error (omitempty)
var ErrPinned error
func NewYtDlp(o YtDlpOptions) *YtDlp
func (y *YtDlp) Check(ctx context.Context) error
func (y *YtDlp) Update(ctx context.Context) error
func (y *YtDlp) Status() YtDlpStatus
func (y *YtDlp) RunDaily(ctx context.Context) // first check after 1 minute, then every 24 h
```

- [ ] **Step 1: Write the failing test**

```go
package system

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/music"
)

// fakeGitHub serves a latest release whose yt-dlp asset is body; sums is its SHA2-256SUMS file.
func fakeGitHub(t *testing.T, tag string, body []byte, sums string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/yt-dlp/yt-dlp/releases/latest":
			fmt.Fprintf(w, `{"tag_name":%q,"assets":[{"name":"yt-dlp","browser_download_url":"%s/dl/yt-dlp"},{"name":"yt-dlp.exe","browser_download_url":"%s/dl/exe"},{"name":"SHA2-256SUMS","browser_download_url":"%s/dl/sums"}]}`, tag, srv.URL, srv.URL, srv.URL)
		case "/dl/yt-dlp":
			_, _ = w.Write(body)
		case "/dl/sums":
			_, _ = w.Write([]byte(sums))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// fakeVersion: a file containing "good-<v>" reports version v; anything else fails like a broken binary.
func fakeVersion(_ context.Context, path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var v string
	if _, err := fmt.Sscanf(string(b), "good-%s", &v); err != nil {
		return "", fmt.Errorf("exec format error")
	}
	return v, nil
}

func newTestYtDlp(t *testing.T, api string) (*YtDlp, *music.YtDlpPath, string) {
	dir := t.TempDir()
	old := filepath.Join(dir, "image-yt-dlp")
	require.NoError(t, os.WriteFile(old, []byte("good-2026.01.01"), 0o755))
	p := music.NewYtDlpPath(old)
	return NewYtDlp(YtDlpOptions{Path: p, Managed: ManagedYtDlp(dir), API: api, Version: fakeVersion}), p, old
}

func TestYtDlpCheck(t *testing.T) {
	gh := fakeGitHub(t, "2026.10.01", nil, "")
	y, _, _ := newTestYtDlp(t, gh.URL)
	require.NoError(t, y.Check(context.Background()))
	st := y.Status()
	require.Equal(t, "2026.01.01", st.Installed)
	require.Equal(t, "2026.10.01", st.Latest)
	require.True(t, st.Available)
	require.NotNil(t, st.CheckedAt)
}

func TestYtDlpUpdate(t *testing.T) {
	bin := []byte("good-2026.10.01")
	gh := fakeGitHub(t, "2026.10.01", bin, sum([]byte("other"))+"  yt-dlp.exe\n"+sum(bin)+"  yt-dlp\n")
	y, p, _ := newTestYtDlp(t, gh.URL)
	require.NoError(t, y.Update(context.Background()))

	managed := y.opts.Managed
	require.Equal(t, managed, p.Get(), "music now uses the updated copy")
	got, err := os.ReadFile(managed)
	require.NoError(t, err)
	require.Equal(t, bin, got)
	require.Equal(t, "2026.10.01", y.Status().Installed)
	_, err = os.Stat(managed + ".tmp")
	require.True(t, os.IsNotExist(err))
}

func TestYtDlpUpdateKeepsOldBinaryOnFailure(t *testing.T) {
	cases := map[string]struct {
		body []byte
		sums string
	}{
		"checksum mismatch":       {[]byte("good-2026.10.01"), sum([]byte("tampered")) + "  yt-dlp\n"},
		"not in SHA2-256SUMS":     {[]byte("good-2026.10.01"), sum([]byte("x")) + "  yt-dlp.exe\n"},
		"new binary will not run": {[]byte("garbage"), sum([]byte("garbage")) + "  yt-dlp\n"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			gh := fakeGitHub(t, "2026.10.01", c.body, c.sums)
			y, p, old := newTestYtDlp(t, gh.URL)
			require.Error(t, y.Update(context.Background()))
			require.Equal(t, old, p.Get())
			_, err := os.Stat(y.opts.Managed)
			require.True(t, os.IsNotExist(err), "nothing installed")
			_, err = os.Stat(y.opts.Managed + ".tmp")
			require.True(t, os.IsNotExist(err), "no temp file left behind")
			require.NotEmpty(t, y.Status().Error)
		})
	}
}

func TestYtDlpPinned(t *testing.T) {
	y := NewYtDlp(YtDlpOptions{Path: music.NewYtDlpPath("/opt/yt-dlp"), Pinned: true, Version: fakeVersion})
	require.ErrorIs(t, y.Update(context.Background()), ErrPinned)
	require.True(t, y.Status().Pinned)
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && go test ./internal/system/ -run TestYtDlp`
Expected: FAIL (`undefined: NewYtDlp`)

- [ ] **Step 3: Implement**

```go
package system

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/music"
)

// ErrPinned: DATROPE_YTDLP names the binary, so the dashboard does not replace it.
var ErrPinned = errors.New("yt-dlp is pinned by DATROPE_YTDLP")

const maxYtDlpBytes = 64 << 20

type YtDlpOptions struct {
	Path    *music.YtDlpPath
	Managed string
	Pinned  bool
	API     string
	Client  *http.Client
	Version func(ctx context.Context, path string) (string, error)
}

type YtDlpStatus struct {
	Available bool       `json:"available" doc:"The server has a yt-dlp binary"`
	Installed string     `json:"installed"`
	Latest    string     `json:"latest"`
	CheckedAt *time.Time `json:"checked_at,omitempty"`
	Pinned    bool       `json:"pinned" doc:"DATROPE_YTDLP names the binary; it is not updated here"`
	Error     string     `json:"error,omitempty" doc:"The last check or update failure"`
}

// YtDlp checks GitHub for yt-dlp releases and installs them on the data volume.
type YtDlp struct {
	opts     YtDlpOptions
	updating sync.Mutex // one update at a time

	mu        sync.Mutex
	installed string
	latest    string
	checkedAt *time.Time
	err       string
}

type ghRelease struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func (r ghRelease) asset(name string) string {
	for _, a := range r.Assets {
		if a.Name == name {
			return a.URL
		}
	}
	return ""
}

func NewYtDlp(o YtDlpOptions) *YtDlp {
	if o.API == "" {
		o.API = "https://api.github.com"
	}
	if o.Client == nil {
		o.Client = &http.Client{Timeout: 60 * time.Second}
	}
	if o.Version == nil {
		o.Version = runVersion
	}
	if o.Path == nil {
		o.Path = music.NewYtDlpPath("")
	}
	return &YtDlp{opts: o}
}

func runVersion(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	return strings.TrimSpace(string(out)), err
}

func (y *YtDlp) Status() YtDlpStatus {
	y.mu.Lock()
	defer y.mu.Unlock()
	return YtDlpStatus{
		Available: y.opts.Path.Get() != "", Installed: y.installed, Latest: y.latest,
		CheckedAt: y.checkedAt, Pinned: y.opts.Pinned, Error: y.err,
	}
}

// setErr records err (or clears the last one) for Status and returns it.
func (y *YtDlp) setErr(err error) error {
	y.mu.Lock()
	y.err = ""
	if err != nil {
		y.err = err.Error()
	}
	y.mu.Unlock()
	return err
}

// Check reads the installed version and the latest release.
func (y *YtDlp) Check(ctx context.Context) error {
	var installed string
	if p := y.opts.Path.Get(); p != "" {
		v, err := y.opts.Version(ctx, p)
		if err != nil {
			return y.setErr(fmt.Errorf("yt-dlp --version: %w", err))
		}
		installed = v
	}
	rel, err := y.release(ctx)
	if err != nil {
		return y.setErr(err)
	}
	now := time.Now()
	y.mu.Lock()
	y.installed, y.latest, y.checkedAt = installed, rel.Tag, &now
	y.mu.Unlock()
	return y.setErr(nil)
}

// Update installs the latest release. Any failure leaves the current binary in use.
func (y *YtDlp) Update(ctx context.Context) error {
	if y.opts.Pinned {
		return ErrPinned
	}
	y.updating.Lock()
	defer y.updating.Unlock()
	return y.setErr(y.update(ctx))
}

func (y *YtDlp) update(ctx context.Context) error {
	rel, err := y.release(ctx)
	if err != nil {
		return err
	}
	binURL, sumsURL := rel.asset("yt-dlp"), rel.asset("SHA2-256SUMS")
	if binURL == "" || sumsURL == "" {
		return fmt.Errorf("yt-dlp %s: the release has no yt-dlp or SHA2-256SUMS asset", rel.Tag)
	}
	sums, err := y.get(ctx, sumsURL, 1<<20)
	if err != nil {
		return err
	}
	want := checksumFor(sums, "yt-dlp")
	if want == "" {
		return errors.New("yt-dlp: SHA2-256SUMS does not list yt-dlp")
	}
	bin, err := y.get(ctx, binURL, maxYtDlpBytes)
	if err != nil {
		return err
	}
	got := sha256.Sum256(bin)
	if hex.EncodeToString(got[:]) != want {
		return errors.New("yt-dlp: checksum mismatch, download discarded")
	}
	if err := os.MkdirAll(filepath.Dir(y.opts.Managed), 0o755); err != nil {
		return err
	}
	tmp := y.opts.Managed + ".tmp"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return err
	}
	v, err := y.opts.Version(ctx, tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("yt-dlp: the new binary does not run: %w", err)
	}
	if err := os.Rename(tmp, y.opts.Managed); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	y.opts.Path.Set(y.opts.Managed)
	now := time.Now()
	y.mu.Lock()
	y.installed, y.latest, y.checkedAt = v, rel.Tag, &now
	y.mu.Unlock()
	slog.Info("yt-dlp updated", "version", v)
	return nil
}

func (y *YtDlp) release(ctx context.Context) (ghRelease, error) {
	var rel ghRelease
	b, err := y.get(ctx, y.opts.API+"/repos/yt-dlp/yt-dlp/releases/latest", 1<<20)
	if err != nil {
		return rel, err
	}
	if err := json.Unmarshal(b, &rel); err != nil {
		return rel, fmt.Errorf("yt-dlp: release: %w", err)
	}
	if rel.Tag == "" {
		return rel, errors.New("yt-dlp: the release has no tag")
	}
	return rel, nil
}

func (y *YtDlp) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := y.opts.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("yt-dlp: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("yt-dlp: GET %s: %s", url, res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("yt-dlp: %s is larger than %d bytes", url, limit)
	}
	return b, nil
}

// checksumFor finds name in a sha256sum-style file ("<hex>  <name>" or "<hex> *<name>").
func checksumFor(sums []byte, name string) string {
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return strings.ToLower(f[0])
		}
	}
	return ""
}

// RunDaily checks a minute after start (not at once, so tests and restarts stay quiet), then daily.
func (y *YtDlp) RunDaily(ctx context.Context) {
	t := time.NewTimer(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := y.Check(ctx); err != nil {
				slog.Warn("yt-dlp: update check", "err", err)
			}
			t.Reset(24 * time.Hour)
		}
	}
}
```

Known limit: a server that started with no yt-dlp at all keeps YouTube off until a restart even after an update installs one (the music service decides at startup). Images always ship yt-dlp, so this only affects odd dev setups.

- [ ] **Step 4: Run tests**

Run: `cd server && go test ./internal/system/`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git -c safe.directory=* add server/internal/system/
```

---
### Task 6: Updater job store

**Files:**
- Create: `server/internal/updater/jobs.go`
- Test: `server/internal/updater/jobs_test.go`

**Interfaces:**
- Produces:

```go
type Step struct {
	Title string
	Run   func(ctx context.Context, w io.Writer) error
}
const StatusRunning, StatusSucceeded, StatusFailed = "running", "succeeded", "failed"
type UpdateJob struct { ID, Status, Error string; StartedAt time.Time; FinishedAt *time.Time }
// json: id, status (enum running/succeeded/failed), error (omitempty), started_at, finished_at (omitempty)
type UpdateJobLog struct { Job UpdateJob; Lines []string; Next int } // json: job, lines, next
var ErrBusy, ErrNoJob error
func OpenJobs(dir string) (*Jobs, error)
func (j *Jobs) Start(steps []Step, final *Step) (id string, err error)
func (j *Jobs) Log(id string, after int) (UpdateJobLog, error)
func (j *Jobs) Wait() // blocks until the running job is done (tests)
```

- [ ] **Step 1: Write the failing test**

```go
package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func say(title, out string, err error) Step {
	return Step{Title: title, Run: func(_ context.Context, w io.Writer) error {
		fmt.Fprintln(w, out)
		return err
	}}
}

func TestJobRunsStepsInOrder(t *testing.T) {
	j, err := OpenJobs(t.TempDir())
	require.NoError(t, err)
	var order []string
	rec := func(name string) Step {
		return Step{Title: name, Run: func(context.Context, io.Writer) error { order = append(order, name); return nil }}
	}
	final := rec("self")
	id, err := j.Start([]Step{rec("pull"), rec("build"), rec("up")}, &final)
	require.NoError(t, err)
	j.Wait()
	require.Equal(t, []string{"pull", "build", "up", "self"}, order)
	log, err := j.Log(id, 0)
	require.NoError(t, err)
	require.Equal(t, StatusSucceeded, log.Job.Status)
	require.Contains(t, log.Lines, "==> pull")
}

func TestJobStopsAtFirstFailure(t *testing.T) {
	j, _ := OpenJobs(t.TempDir())
	ran := false
	final := Step{Title: "self", Run: func(context.Context, io.Writer) error { ran = true; return nil }}
	id, _ := j.Start([]Step{say("pull", "Already up to date.", nil), say("build", "boom", errors.New("exit status 1")), say("up", "never", nil)}, &final)
	j.Wait()
	log, _ := j.Log(id, 0)
	require.Equal(t, StatusFailed, log.Job.Status)
	require.Contains(t, log.Job.Error, "build")
	require.NotContains(t, log.Lines, "never")
	require.False(t, ran, "the updater does not replace itself after a failed update")
}

func TestJobFinalStepRunsAfterSuccessIsRecorded(t *testing.T) {
	dir := t.TempDir()
	j, _ := OpenJobs(dir)
	var statusDuringFinal string
	ids := make(chan string, 1)
	final := Step{Title: "self", Run: func(context.Context, io.Writer) error {
		id := <-ids
		var job UpdateJob
		b, _ := os.ReadFile(filepath.Join(dir, id+".json"))
		_ = json.Unmarshal(b, &job)
		statusDuringFinal = job.Status
		return nil
	}}
	id, _ := j.Start([]Step{say("pull", "ok", nil)}, &final)
	ids <- id
	j.Wait()
	require.Equal(t, StatusSucceeded, statusDuringFinal, "a self-update that ends the process must already be recorded as succeeded")
}

func TestJobLogOffsets(t *testing.T) {
	j, _ := OpenJobs(t.TempDir())
	id, _ := j.Start([]Step{say("a", "one\ntwo", nil)}, nil)
	j.Wait()
	all, _ := j.Log(id, 0)
	require.Equal(t, []string{"==> a", "one", "two"}, all.Lines)
	rest, _ := j.Log(id, 2)
	require.Equal(t, []string{"two"}, rest.Lines)
	require.Equal(t, 3, rest.Next)
	past, _ := j.Log(id, 1000)
	require.Empty(t, past.Lines)
	require.Equal(t, 3, past.Next)
}

func TestJobBusy(t *testing.T) {
	j, _ := OpenJobs(t.TempDir())
	release := make(chan struct{})
	_, err := j.Start([]Step{{Title: "slow", Run: func(context.Context, io.Writer) error { <-release; return nil }}}, nil)
	require.NoError(t, err)
	_, err = j.Start([]Step{say("b", "", nil)}, nil)
	require.ErrorIs(t, err, ErrBusy)
	close(release)
	j.Wait()
}

func TestJobInterruptedOnRestart(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "00000000000000000001.json"), []byte(`{"id":"00000000000000000001","status":"running"}`), 0o644))
	j, err := OpenJobs(dir)
	require.NoError(t, err)
	log, err := j.Log("00000000000000000001", 0)
	require.NoError(t, err)
	require.Equal(t, StatusFailed, log.Job.Status)
	require.Equal(t, "interrupted", log.Job.Error)
}

func TestJobRejectsBadIDs(t *testing.T) {
	j, _ := OpenJobs(t.TempDir())
	for _, id := range []string{"", "../etc/passwd", "12a", "999"} {
		_, err := j.Log(id, 0)
		require.ErrorIs(t, err, ErrNoJob, id)
	}
}

func TestJobsKeepTen(t *testing.T) {
	dir := t.TempDir()
	j, _ := OpenJobs(dir)
	for i := 0; i < 12; i++ {
		_, err := j.Start([]Step{say("a", "x", nil)}, nil)
		require.NoError(t, err)
		j.Wait()
	}
	m, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	require.Len(t, m, keepJobs)
	logs, _ := filepath.Glob(filepath.Join(dir, "*.log"))
	require.Len(t, logs, keepJobs)
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && go test ./internal/updater/`
Expected: FAIL (undefined: OpenJobs ...)

- [ ] **Step 3: Implement**

```go
// Package updater pulls, rebuilds and restarts the compose stack for the system dashboard.
// It runs in its own container, the only one with the Docker socket.
package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	StatusRunning   = "running"
	StatusSucceeded = "succeeded"
	StatusFailed    = "failed"
	keepJobs        = 10
)

var (
	ErrBusy  = errors.New("an update is already running")
	ErrNoJob = errors.New("no such job")
)

// Step is one stage of a job; it writes its output to w.
type Step struct {
	Title string
	Run   func(ctx context.Context, w io.Writer) error
}

type UpdateJob struct {
	ID         string     `json:"id"`
	Status     string     `json:"status" enum:"running,succeeded,failed"`
	Error      string     `json:"error,omitempty"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

type UpdateJobLog struct {
	Job   UpdateJob `json:"job"`
	Lines []string  `json:"lines"`
	Next  int       `json:"next" doc:"Pass as after to get the lines that follow"`
}

// Jobs runs one job at a time and keeps each job's status (<id>.json) and output (<id>.log) in
// dir, so a restarted updater can still report how the last update ended.
type Jobs struct {
	dir string
	wg  sync.WaitGroup

	mu      sync.Mutex
	running bool
	last    int64 // the last ID handed out, so IDs stay unique and ordered
}

func OpenJobs(dir string) (*Jobs, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	j := &Jobs{dir: dir}
	for _, id := range j.ids() {
		job, err := j.read(id)
		if err != nil || job.Status != StatusRunning {
			continue
		}
		now := time.Now()
		job.Status, job.Error, job.FinishedAt = StatusFailed, "interrupted", &now
		if err := j.write(job); err != nil {
			return nil, err
		}
	}
	j.prune()
	return j, nil
}

// validID: IDs are zero-padded nanosecond times, so anything else (like "../x") is refused.
func validID(id string) bool {
	if id == "" || len(id) > 20 {
		return false
	}
	for _, c := range id {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// ids lists the stored jobs, oldest first.
func (j *Jobs) ids() []string {
	m, _ := filepath.Glob(filepath.Join(j.dir, "*.json"))
	ids := make([]string, 0, len(m))
	for _, p := range m {
		if id := strings.TrimSuffix(filepath.Base(p), ".json"); validID(id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func (j *Jobs) prune() {
	ids := j.ids()
	for len(ids) > keepJobs {
		_ = os.Remove(filepath.Join(j.dir, ids[0]+".json"))
		_ = os.Remove(filepath.Join(j.dir, ids[0]+".log"))
		ids = ids[1:]
	}
}

func (j *Jobs) read(id string) (UpdateJob, error) {
	var job UpdateJob
	b, err := os.ReadFile(filepath.Join(j.dir, id+".json"))
	if err != nil {
		return job, err
	}
	return job, json.Unmarshal(b, &job)
}

// write replaces <id>.json atomically.
func (j *Jobs) write(job UpdateJob) error {
	b, err := json.Marshal(job)
	if err != nil {
		return err
	}
	tmp := filepath.Join(j.dir, job.ID+".json.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(j.dir, job.ID+".json"))
}

// Start runs steps in the background, stopping at the first error. When all succeed the job is
// recorded as succeeded and only then final runs: final may end this process (the updater
// replacing itself), and the record must not be left saying "running".
func (j *Jobs) Start(steps []Step, final *Step) (string, error) {
	j.mu.Lock()
	if j.running {
		j.mu.Unlock()
		return "", ErrBusy
	}
	n := time.Now().UnixNano()
	if n <= j.last {
		n = j.last + 1
	}
	j.last, j.running = n, true
	j.mu.Unlock()

	job := UpdateJob{ID: fmt.Sprintf("%020d", n), Status: StatusRunning, StartedAt: time.Now()}
	if err := j.write(job); err != nil {
		j.mu.Lock()
		j.running = false
		j.mu.Unlock()
		return "", err
	}
	j.prune()
	j.wg.Add(1)
	go j.run(job, steps, final)
	return job.ID, nil
}

func (j *Jobs) run(job UpdateJob, steps []Step, final *Step) {
	defer j.wg.Done()
	defer func() {
		j.mu.Lock()
		j.running = false
		j.mu.Unlock()
	}()
	f, err := os.OpenFile(filepath.Join(j.dir, job.ID+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		j.finish(job, fmt.Errorf("log: %w", err))
		return
	}
	defer f.Close()
	w := &syncWriter{w: f} // compose writes stdout and stderr from two goroutines
	ctx := context.Background()
	for _, s := range steps {
		fmt.Fprintf(w, "==> %s\n", s.Title)
		if err := s.Run(ctx, w); err != nil {
			fmt.Fprintf(w, "!! %s failed: %v\n", s.Title, err)
			j.finish(job, fmt.Errorf("%s: %w", s.Title, err))
			return
		}
	}
	j.finish(job, nil)
	if final != nil {
		fmt.Fprintf(w, "==> %s\n", final.Title)
		if err := final.Run(ctx, w); err != nil {
			fmt.Fprintf(w, "!! %s failed: %v (the rest of the update is done)\n", final.Title, err)
		}
	}
}

func (j *Jobs) finish(job UpdateJob, err error) {
	now := time.Now()
	job.FinishedAt, job.Status = &now, StatusSucceeded
	if err != nil {
		job.Status, job.Error = StatusFailed, err.Error()
	}
	_ = j.write(job)
}

// Log returns the job and its complete output lines from index after on. A line still being
// written is left for the next call.
func (j *Jobs) Log(id string, after int) (UpdateJobLog, error) {
	if !validID(id) {
		return UpdateJobLog{}, ErrNoJob
	}
	job, err := j.read(id)
	if err != nil {
		return UpdateJobLog{}, ErrNoJob
	}
	b, _ := os.ReadFile(filepath.Join(j.dir, id+".log"))
	text := string(b)
	if i := strings.LastIndexByte(text, '\n'); i >= 0 {
		text = text[:i] // drop the trailing newline and any unfinished line
	} else {
		text = ""
	}
	lines := []string{}
	if text != "" {
		lines = strings.Split(text, "\n")
	}
	after = max(0, min(after, len(lines)))
	return UpdateJobLog{Job: job, Lines: lines[after:], Next: len(lines)}, nil
}

// Wait blocks until the running job, if any, is done.
func (j *Jobs) Wait() { j.wg.Wait() }

type syncWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(p)
}
```

- [ ] **Step 4: Run tests**

Run: `cd server && go test ./internal/updater/`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git -c safe.directory=* add server/internal/updater/
```

---

### Task 7: Updater git status and commands

**Files:**
- Create: `server/internal/updater/git.go`, `server/internal/updater/owner_unix.go`, `server/internal/updater/owner_other.go`
- Test: `server/internal/updater/git_test.go`

**Interfaces:**
- Consumes: `Step` (Task 6).
- Produces:

```go
type Cmd func(ctx context.Context, w io.Writer, name string, args ...string) error
func ExecCmd(ctx context.Context, w io.Writer, name string, args ...string) error
type GitCommit struct { SHA, Subject, Author string; Date time.Time } // json: sha, subject, author, date
type GitStatus struct { Current, Latest string; Behind int; Commits []GitCommit; CheckedAt *time.Time; Error string }
// json: current, latest, behind, commits, checked_at (omitempty), error (omitempty)
type Git struct { Dir string; As []string; Run Cmd }
func (g *Git) Check(ctx context.Context) GitStatus
func (g *Git) Status() GitStatus
func (g *Git) PullStep() Step
func (g *Git) RunDaily(ctx context.Context)
func RunAs(dir string) ([]string, error) // ["su-exec","uid:gid"]; nil when root owns dir, or off unix
func LinkRepo(target, at string) error
```

- [ ] **Step 1: Write the failing test**

```go
package updater

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeCmd answers commands by the end of their joined arguments and records every call.
type fakeCmd struct {
	out   map[string]string
	fail  map[string]bool
	calls []string
}

func (f *fakeCmd) run(_ context.Context, w io.Writer, name string, args ...string) error {
	line := strings.Join(append([]string{name}, args...), " ")
	f.calls = append(f.calls, line)
	for k, v := range f.out {
		if strings.HasSuffix(line, k) {
			fmt.Fprint(w, v)
		}
	}
	for k := range f.fail {
		if strings.HasSuffix(line, k) {
			return errors.New("exit status 1")
		}
	}
	return nil
}

func TestGitCheck(t *testing.T) {
	f := &fakeCmd{out: map[string]string{
		"rev-parse HEAD":                     "aaa\n",
		"rev-parse origin/main":              "ccc\n",
		"rev-list --count HEAD..origin/main": "2\n",
		"--format=%H%x1f%s%x1f%an%x1f%cI HEAD..origin/main": "ccc\x1fFix voice\x1fFilip\x1f2026-10-11T10:00:00+02:00\nbbb\x1fAdd polls\x1fFilip\x1f2026-10-10T09:00:00Z\n",
	}}
	g := &Git{Dir: "/home/f/datrope", As: []string{"su-exec", "1000:1000"}, Run: f.run}
	st := g.Check(context.Background())
	require.Empty(t, st.Error)
	require.Equal(t, "aaa", st.Current)
	require.Equal(t, "ccc", st.Latest)
	require.Equal(t, 2, st.Behind)
	require.Len(t, st.Commits, 2)
	c := st.Commits[0]
	require.Equal(t, "ccc", c.SHA)
	require.Equal(t, "Fix voice", c.Subject)
	require.True(t, c.Date.Equal(time.Date(2026, 10, 11, 8, 0, 0, 0, time.UTC)))
	require.NotNil(t, st.CheckedAt)
	require.Equal(t, "su-exec 1000:1000 git -C /home/f/datrope fetch origin main", f.calls[0])
	require.Equal(t, st, g.Status())
}

func TestGitCheckFetchFails(t *testing.T) {
	f := &fakeCmd{fail: map[string]bool{"fetch origin main": true}}
	g := &Git{Dir: "/r", Run: f.run}
	st := g.Check(context.Background())
	require.Contains(t, st.Error, "fetch")
	require.NotNil(t, st.Commits, "commits is [] in JSON, not null")
}

func TestGitPullStep(t *testing.T) {
	f := &fakeCmd{}
	g := &Git{Dir: "/r", Run: f.run}
	require.NoError(t, g.PullStep().Run(context.Background(), io.Discard))
	require.Equal(t, []string{"git -C /r pull --ff-only origin main"}, f.calls)
}

func TestLinkRepo(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows; the updater runs on Linux")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "repo")
	require.NoError(t, os.Mkdir(target, 0o755))
	at := filepath.Join(dir, "home", "f", "datrope")
	require.NoError(t, LinkRepo(target, at))
	require.NoError(t, LinkRepo(target, at), "idempotent")
	require.NoError(t, LinkRepo(target, target), "same path: nothing to do")
	got, err := os.Readlink(at)
	require.NoError(t, err)
	require.Equal(t, target, got)
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && go test ./internal/updater/ -run 'TestGit|TestLinkRepo'`
Expected: FAIL (undefined: Git)

- [ ] **Step 3: Implement**

`server/internal/updater/git.go`:

```go
package updater

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Cmd runs a program and writes its stdout and stderr to w.
type Cmd func(ctx context.Context, w io.Writer, name string, args ...string) error

func ExecCmd(ctx context.Context, w io.Writer, name string, args ...string) error {
	c := exec.CommandContext(ctx, name, args...)
	c.Stdout, c.Stderr = w, w
	return c.Run()
}

type GitCommit struct {
	SHA     string    `json:"sha"`
	Subject string    `json:"subject"`
	Author  string    `json:"author"`
	Date    time.Time `json:"date"`
}

type GitStatus struct {
	Current   string      `json:"current" doc:"The commit the install runs"`
	Latest    string      `json:"latest" doc:"origin/main at the last check"`
	Behind    int         `json:"behind"`
	Commits   []GitCommit `json:"commits" doc:"Newest first, at most 100"`
	CheckedAt *time.Time  `json:"checked_at,omitempty"`
	Error     string      `json:"error,omitempty"`
}

// Git checks and pulls the checkout the stack is built from. As prefixes every git command
// (su-exec to the checkout's owner) so pulled files are not owned by root.
type Git struct {
	Dir string
	As  []string
	Run Cmd

	mu     sync.Mutex
	status GitStatus
}

func (g *Git) cmd(ctx context.Context, w io.Writer, args ...string) error {
	full := append(append(append([]string{}, g.As...), "git", "-C", g.Dir), args...)
	return g.Run(ctx, w, full[0], full[1:]...)
}

func (g *Git) output(ctx context.Context, args ...string) (string, error) {
	var b bytes.Buffer
	if err := g.cmd(ctx, &b, args...); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(b.String()))
	}
	return strings.TrimSpace(b.String()), nil
}

// Check fetches origin/main and compares it with HEAD.
func (g *Git) Check(ctx context.Context) GitStatus {
	now := time.Now()
	st := GitStatus{Commits: []GitCommit{}, CheckedAt: &now}
	if err := g.check(ctx, &st); err != nil {
		st.Error = err.Error()
	}
	g.mu.Lock()
	g.status = st
	g.mu.Unlock()
	return st
}

func (g *Git) check(ctx context.Context, st *GitStatus) error {
	if _, err := g.output(ctx, "fetch", "origin", "main"); err != nil {
		return err
	}
	var err error
	if st.Current, err = g.output(ctx, "rev-parse", "HEAD"); err != nil {
		return err
	}
	if st.Latest, err = g.output(ctx, "rev-parse", "origin/main"); err != nil {
		return err
	}
	n, err := g.output(ctx, "rev-list", "--count", "HEAD..origin/main")
	if err != nil {
		return err
	}
	if st.Behind, err = strconv.Atoi(n); err != nil {
		return fmt.Errorf("git rev-list: %w", err)
	}
	out, err := g.output(ctx, "log", "-n", "100", "--format=%H%x1f%s%x1f%an%x1f%cI", "HEAD..origin/main")
	if err != nil {
		return err
	}
	commits, err := parseLog(out)
	if err != nil {
		return err
	}
	st.Commits = commits
	return nil
}

func parseLog(out string) ([]GitCommit, error) {
	commits := []GitCommit{}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\x1f")
		if len(f) != 4 {
			return nil, fmt.Errorf("git log: unexpected line %q", line)
		}
		d, err := time.Parse(time.RFC3339, f[3])
		if err != nil {
			return nil, fmt.Errorf("git log: %w", err)
		}
		commits = append(commits, GitCommit{SHA: f[0], Subject: f[1], Author: f[2], Date: d})
	}
	return commits, nil
}

func (g *Git) Status() GitStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.status
}

func (g *Git) PullStep() Step {
	return Step{Title: "git pull", Run: func(ctx context.Context, w io.Writer) error {
		return g.cmd(ctx, w, "pull", "--ff-only", "origin", "main")
	}}
}

// RunDaily checks at start and then every 24 hours.
func (g *Git) RunDaily(ctx context.Context) {
	for {
		if st := g.Check(ctx); st.Error != "" {
			slog.Warn("updater: git check", "err", st.Error)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(24 * time.Hour):
		}
	}
}

// LinkRepo makes the checkout, mounted at target, reachable at its host path (at) inside the
// container. Compose then resolves relative paths to host paths the Docker daemon can use.
func LinkRepo(target, at string) error {
	if at == target {
		return nil
	}
	if _, err := os.Lstat(at); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(at), 0o755); err != nil {
		return err
	}
	return os.Symlink(target, at)
}
```

`server/internal/updater/owner_unix.go`:

```go
//go:build unix

package updater

import (
	"fmt"
	"os"
	"syscall"
)

// RunAs is the su-exec prefix that runs a command as dir's owner; nil when root owns it.
func RunAs(dir string) ([]string, error) {
	st, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok || sys.Uid == 0 {
		return nil, nil
	}
	return []string{"su-exec", fmt.Sprintf("%d:%d", sys.Uid, sys.Gid)}, nil
}
```

`server/internal/updater/owner_other.go`:

```go
//go:build !unix

package updater

func RunAs(string) ([]string, error) { return nil, nil }
```

- [ ] **Step 4: Run tests**

Run: `cd server && go test ./internal/updater/ && go vet ./internal/updater/`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git -c safe.directory=* add server/internal/updater/
```

---
### Task 8: Docker Engine client (containers, stats, self-discovery)

**Files:**
- Create: `server/internal/updater/docker.go`
- Test: `server/internal/updater/docker_test.go`

**Interfaces:**
- Produces:

```go
type ContainerInfo struct { Service, Name, State, Status string; CPUPercent float64; MemBytes, MemLimit uint64 }
// json: service, name, state, status, cpu_percent, mem_bytes, mem_limit
func NewDocker(socket string) *Docker
func (d *Docker) Containers(ctx context.Context, project string) ([]ContainerInfo, error) // sorted by service
func (d *Docker) Self(ctx context.Context, containerID, mountedAt string) (hostPath, project string, err error)
```

- [ ] **Step 1: Write the failing test**

```go
package updater

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func fakeDocker(t *testing.T) *Docker {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/containers/json":
			var f map[string][]string
			require.NoError(t, json.Unmarshal([]byte(r.URL.Query().Get("filters")), &f))
			require.Equal(t, []string{"com.docker.compose.project=datrope"}, f["label"])
			require.Equal(t, "true", r.URL.Query().Get("all"))
			_, _ = w.Write([]byte(`[
				{"Id":"s1","Names":["/datrope-server-1"],"State":"running","Status":"Up 2 hours (healthy)","Labels":{"com.docker.compose.service":"server"}},
				{"Id":"c1","Names":["/datrope-caddy-1"],"State":"exited","Status":"Exited (1) 3 minutes ago","Labels":{"com.docker.compose.service":"caddy"}}]`))
		case "/containers/s1/stats":
			require.Equal(t, "false", r.URL.Query().Get("stream"))
			_, _ = w.Write([]byte(`{
				"cpu_stats":{"cpu_usage":{"total_usage":3000},"system_cpu_usage":20000,"online_cpus":4},
				"precpu_stats":{"cpu_usage":{"total_usage":1000},"system_cpu_usage":10000,"online_cpus":4},
				"memory_stats":{"usage":5000,"limit":100000,"stats":{"inactive_file":1000}}}`))
		case "/containers/self/json":
			_, _ = w.Write([]byte(`{"Mounts":[{"Source":"/var/run/docker.sock","Destination":"/var/run/docker.sock"},{"Source":"/home/f/datrope","Destination":"/repo"}],
				"Config":{"Labels":{"com.docker.compose.project":"datrope"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return &Docker{hc: srv.Client(), base: srv.URL}
}

func TestContainers(t *testing.T) {
	cs, err := fakeDocker(t).Containers(context.Background(), "datrope")
	require.NoError(t, err)
	// CPU: (3000-1000)/(20000-10000) * 4 cores * 100 = 80. Memory: 5000 - 1000 inactive_file.
	require.Equal(t, []ContainerInfo{
		{Service: "caddy", Name: "datrope-caddy-1", State: "exited", Status: "Exited (1) 3 minutes ago"},
		{Service: "server", Name: "datrope-server-1", State: "running", Status: "Up 2 hours (healthy)", CPUPercent: 80, MemBytes: 4000, MemLimit: 100000},
	}, cs)
}

func TestSelf(t *testing.T) {
	host, project, err := fakeDocker(t).Self(context.Background(), "self", "/repo")
	require.NoError(t, err)
	require.Equal(t, "/home/f/datrope", host)
	require.Equal(t, "datrope", project)

	_, _, err = fakeDocker(t).Self(context.Background(), "self", "/elsewhere")
	require.Error(t, err)
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && go test ./internal/updater/ -run 'TestContainers|TestSelf'`
Expected: FAIL (undefined: Docker)

- [ ] **Step 3: Implement**

```go
package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"
)

// Docker talks to the Docker Engine API over its unix socket (three endpoints, so no SDK).
type Docker struct {
	hc   *http.Client
	base string
}

func NewDocker(socket string) *Docker {
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socket)
	}}
	return &Docker{hc: &http.Client{Transport: tr, Timeout: 30 * time.Second}, base: "http://docker"}
}

func (d *Docker) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.base+path, nil)
	if err != nil {
		return err
	}
	res, err := d.hc.Do(req)
	if err != nil {
		return fmt.Errorf("docker: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("docker: GET %s: %s", path, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

type ContainerInfo struct {
	Service    string  `json:"service"`
	Name       string  `json:"name"`
	State      string  `json:"state" doc:"running, exited, restarting, ..."`
	Status     string  `json:"status" doc:"Docker's description, e.g. Up 3 hours (healthy)"`
	CPUPercent float64 `json:"cpu_percent" doc:"100 = one core"`
	MemBytes   uint64  `json:"mem_bytes"`
	MemLimit   uint64  `json:"mem_limit"`
}

type listed struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
}

type cpuStats struct {
	Usage struct {
		Total uint64 `json:"total_usage"`
	} `json:"cpu_usage"`
	System uint64 `json:"system_cpu_usage"`
	Online uint32 `json:"online_cpus"`
}

type statsJSON struct {
	CPU    cpuStats `json:"cpu_stats"`
	PreCPU cpuStats `json:"precpu_stats"`
	Memory struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
}

// Containers lists the project's containers, with CPU and memory for the running ones.
func (d *Docker) Containers(ctx context.Context, project string) ([]ContainerInfo, error) {
	filters, _ := json.Marshal(map[string][]string{"label": {"com.docker.compose.project=" + project}})
	var ls []listed
	if err := d.get(ctx, "/containers/json?all=true&filters="+url.QueryEscape(string(filters)), &ls); err != nil {
		return nil, err
	}
	out := make([]ContainerInfo, len(ls))
	var g errgroup.Group
	for i, c := range ls {
		out[i] = ContainerInfo{Service: c.Labels["com.docker.compose.service"], State: c.State, Status: c.Status}
		if len(c.Names) > 0 {
			out[i].Name = strings.TrimPrefix(c.Names[0], "/")
		}
		if c.State != "running" {
			continue
		}
		g.Go(func() error {
			var s statsJSON
			if err := d.get(ctx, "/containers/"+url.PathEscape(c.ID)+"/stats?stream=false", &s); err != nil {
				return nil // it just stopped: show it without numbers
			}
			out[i].CPUPercent = cpuPercentOf(s)
			out[i].MemBytes, out[i].MemLimit = memOf(s), s.Memory.Limit
			return nil
		})
	}
	_ = g.Wait()
	sort.Slice(out, func(a, b int) bool { return out[a].Service < out[b].Service })
	return out, nil
}

func cpuPercentOf(s statsJSON) float64 {
	if s.CPU.Usage.Total < s.PreCPU.Usage.Total || s.CPU.System <= s.PreCPU.System {
		return 0
	}
	cpus := float64(s.CPU.Online)
	if cpus == 0 {
		cpus = 1
	}
	return float64(s.CPU.Usage.Total-s.PreCPU.Usage.Total) / float64(s.CPU.System-s.PreCPU.System) * cpus * 100
}

// memOf is what `docker stats` shows: usage minus page cache that can be dropped.
func memOf(s statsJSON) uint64 {
	inactive := s.Memory.Stats["inactive_file"] // cgroup v2
	if v, ok := s.Memory.Stats["total_inactive_file"]; ok { // cgroup v1
		inactive = v
	}
	if inactive > s.Memory.Usage {
		return s.Memory.Usage
	}
	return s.Memory.Usage - inactive
}

// Self finds the host directory mounted at mountedAt in this container, and the compose project
// this container belongs to.
func (d *Docker) Self(ctx context.Context, containerID, mountedAt string) (hostPath, project string, err error) {
	var c struct {
		Mounts []struct {
			Source      string `json:"Source"`
			Destination string `json:"Destination"`
		} `json:"Mounts"`
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if err := d.get(ctx, "/containers/"+url.PathEscape(containerID)+"/json", &c); err != nil {
		return "", "", err
	}
	project = c.Config.Labels["com.docker.compose.project"]
	for _, m := range c.Mounts {
		if m.Destination == mountedAt {
			hostPath = m.Source
		}
	}
	if hostPath == "" || project == "" {
		return "", "", fmt.Errorf("updater: run me with docker compose and the repo mounted at %s", mountedAt)
	}
	return hostPath, project, nil
}
```

`golang.org/x/sync` is already a direct dependency in `server/go.mod`. The loop relies on Go 1.22+ per-iteration loop variables (`go.mod` says 1.25).

- [ ] **Step 4: Run tests**

Run: `cd server && go test ./internal/updater/`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git -c safe.directory=* add server/internal/updater/
```

---

### Task 9: Updater HTTP API, binary, image and compose service

**Files:**
- Create: `server/internal/updater/compose.go`, `server/internal/updater/server.go`, `server/cmd/updater/main.go`, `deploy/updater.Dockerfile`
- Modify: `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/README.md`, `README.md` (Install table)
- Test: `server/internal/updater/compose_test.go`, `server/internal/updater/server_test.go`

**Interfaces:**
- Consumes: `Jobs`, `Step` (6); `Git`, `Cmd`, `ExecCmd`, `RunAs`, `LinkRepo` (7); `Docker`, `ContainerInfo` (8).
- Produces (HTTP; every request needs `Authorization: Bearer <token>`, else 401 `{"error": ...}`):
  - `GET /status` → `GitStatus`; `POST /check` → `GitStatus`
  - `POST /update` → 202 `{"job_id": "..."}`; 409 `{"error": ...}` when busy
  - `GET /jobs/{id}?after=N` → `UpdateJobLog`; 404 unknown
  - `GET /containers` → `[]ContainerInfo`
  - `POST /containers/{service}/restart` → 204; 404 unknown service or `updater`; 500 with output on failure
- Go: `type Compose struct{ Dir, Project string; Run Cmd }`, `func UpdateSteps(g *Git, c Compose) (steps []Step, final *Step)`, `type Lister interface{ Containers(ctx context.Context, project string) ([]ContainerInfo, error) }`, `type Server struct{ Token string; Git *Git; Jobs *Jobs; Docker Lister; Compose Compose }`, `func (s *Server) Handler() http.Handler`.

- [ ] **Step 1: Write the failing tests**

`server/internal/updater/compose_test.go`:

```go
package updater

import (
	"context"
	"io"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUpdateSteps(t *testing.T) {
	f := &fakeCmd{out: map[string]string{"config --services": "postgres\nserver\nupdater\ncaddy\n"}}
	c := Compose{Dir: "/home/f/datrope/deploy", Project: "datrope", Run: f.run}
	g := &Git{Dir: "/home/f/datrope", Run: f.run}
	steps, final := UpdateSteps(g, c)
	for _, s := range steps {
		require.NoError(t, s.Run(context.Background(), io.Discard))
	}
	require.NoError(t, final.Run(context.Background(), io.Discard))
	base := "docker compose -p datrope --project-directory /home/f/datrope/deploy -f /home/f/datrope/deploy/docker-compose.yml "
	require.Equal(t, []string{
		"git -C /home/f/datrope pull --ff-only origin main",
		base + "build",
		base + "config --services",
		base + "up -d postgres server caddy",
		base + "up -d --no-deps updater",
	}, f.calls)
}
```

`server/internal/updater/server_test.go`:

```go
package updater

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type fakeLister []ContainerInfo

func (f fakeLister) Containers(context.Context, string) ([]ContainerInfo, error) { return f, nil }

func newTestServer(t *testing.T) (*httptest.Server, *fakeCmd, *Jobs) {
	f := &fakeCmd{out: map[string]string{"config --services": "server\n", "rev-list --count HEAD..origin/main": "0\n"}}
	jobs, err := OpenJobs(t.TempDir())
	require.NoError(t, err)
	s := &Server{
		Token:   "secret",
		Git:     &Git{Dir: "/r", Run: f.run},
		Jobs:    jobs,
		Docker:  fakeLister{{Service: "server"}, {Service: "updater"}},
		Compose: Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run},
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return srv, f, jobs
}

func call(t *testing.T, srv *httptest.Server, method, path, token string) *http.Response {
	req, _ := http.NewRequest(method, srv.URL+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestServerNeedsToken(t *testing.T) {
	srv, _, _ := newTestServer(t)
	require.Equal(t, http.StatusUnauthorized, call(t, srv, "GET", "/status", "").StatusCode)
	require.Equal(t, http.StatusUnauthorized, call(t, srv, "GET", "/status", "wrong").StatusCode)
	require.Equal(t, http.StatusOK, call(t, srv, "GET", "/status", "secret").StatusCode)
}

func TestServerUpdateAndJobLog(t *testing.T) {
	srv, _, jobs := newTestServer(t)
	res := call(t, srv, "POST", "/update", "secret")
	require.Equal(t, http.StatusAccepted, res.StatusCode)
	var started struct {
		JobID string `json:"job_id"`
	}
	require.NoError(t, json.NewDecoder(res.Body).Decode(&started))
	jobs.Wait()

	res = call(t, srv, "GET", "/jobs/"+started.JobID+"?after=0", "secret")
	require.Equal(t, http.StatusOK, res.StatusCode)
	var log UpdateJobLog
	require.NoError(t, json.NewDecoder(res.Body).Decode(&log))
	require.Equal(t, StatusSucceeded, log.Job.Status)

	require.Equal(t, http.StatusNotFound, call(t, srv, "GET", "/jobs/12a?after=0", "secret").StatusCode)
}

func TestServerRestartWhitelist(t *testing.T) {
	srv, f, _ := newTestServer(t)
	require.Equal(t, http.StatusNoContent, call(t, srv, "POST", "/containers/server/restart", "secret").StatusCode)
	require.True(t, strings.HasSuffix(f.calls[len(f.calls)-1], "restart server"))
	n := len(f.calls)
	require.Equal(t, http.StatusNotFound, call(t, srv, "POST", "/containers/updater/restart", "secret").StatusCode)
	require.Equal(t, http.StatusNotFound, call(t, srv, "POST", "/containers/nope/restart", "secret").StatusCode)
	require.Len(t, f.calls, n, "rejected names never reach docker compose")
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && go test ./internal/updater/ -run 'TestUpdateSteps|TestServer'`
Expected: FAIL (undefined: Compose, Server)

- [ ] **Step 3: Implement**

`server/internal/updater/compose.go`:

```go
package updater

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"path"
	"slices"
	"strings"
)

// Compose runs docker compose for the stack. Dir is the deploy directory's host path (reachable
// in this container through LinkRepo), so relative paths in docker-compose.yml mean the same to
// compose here as to the Docker daemon on the host.
type Compose struct {
	Dir     string
	Project string
	Run     Cmd
}

func (c Compose) cmd(ctx context.Context, w io.Writer, args ...string) error {
	full := append([]string{"compose", "-p", c.Project, "--project-directory", c.Dir, "-f", path.Join(c.Dir, "docker-compose.yml")}, args...)
	return c.Run(ctx, w, "docker", full...)
}

func (c Compose) services(ctx context.Context) ([]string, error) {
	var b bytes.Buffer
	if err := c.cmd(ctx, &b, "config", "--services"); err != nil {
		return nil, fmt.Errorf("compose config: %w: %s", err, strings.TrimSpace(b.String()))
	}
	return strings.Fields(b.String()), nil
}

// UpdateSteps pulls, builds and restarts everything but the updater; final then replaces the
// updater itself, which ends this process.
func UpdateSteps(g *Git, c Compose) (steps []Step, final *Step) {
	steps = []Step{
		g.PullStep(),
		{Title: "docker compose build", Run: func(ctx context.Context, w io.Writer) error { return c.cmd(ctx, w, "build") }},
		{Title: "docker compose up", Run: func(ctx context.Context, w io.Writer) error {
			all, err := c.services(ctx) // read after the pull: an update may add services
			if err != nil {
				return err
			}
			others := slices.DeleteFunc(all, func(s string) bool { return s == "updater" })
			return c.cmd(ctx, w, append([]string{"up", "-d"}, others...)...)
		}},
	}
	final = &Step{Title: "restart the updater", Run: func(ctx context.Context, w io.Writer) error {
		return c.cmd(ctx, w, "up", "-d", "--no-deps", "updater")
	}}
	return steps, final
}
```

`server/internal/updater/server.go`:

```go
package updater

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"time"
)

type Lister interface {
	Containers(ctx context.Context, project string) ([]ContainerInfo, error)
}

// Server is the updater's HTTP API. Only the Datrope server calls it, with the shared token.
type Server struct {
	Token   string
	Git     *Git
	Jobs    *Jobs
	Docker  Lister
	Compose Compose
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, s.Git.Status())
	})
	mux.HandleFunc("POST /check", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, s.Git.Check(r.Context()))
	})
	mux.HandleFunc("POST /update", func(w http.ResponseWriter, r *http.Request) {
		steps, final := UpdateSteps(s.Git, s.Compose)
		id, err := s.Jobs.Start(steps, final)
		switch {
		case errors.Is(err, ErrBusy):
			writeErr(w, http.StatusConflict, err.Error())
		case err != nil:
			writeErr(w, http.StatusInternalServerError, err.Error())
		default:
			writeJSON(w, http.StatusAccepted, map[string]string{"job_id": id})
		}
	})
	mux.HandleFunc("GET /jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		after, _ := strconv.Atoi(r.URL.Query().Get("after"))
		log, err := s.Jobs.Log(r.PathValue("id"), after)
		if err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, log)
	})
	mux.HandleFunc("GET /containers", func(w http.ResponseWriter, r *http.Request) {
		cs, err := s.Docker.Containers(r.Context(), s.Compose.Project)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, cs)
	})
	mux.HandleFunc("POST /containers/{service}/restart", func(w http.ResponseWriter, r *http.Request) {
		svc := r.PathValue("service")
		cs, err := s.Docker.Containers(r.Context(), s.Compose.Project)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		known := slices.ContainsFunc(cs, func(c ContainerInfo) bool { return c.Service == svc })
		if !known || svc == "updater" {
			writeErr(w, http.StatusNotFound, "no such service")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		var out bytes.Buffer
		if err := s.Compose.cmd(ctx, &out, "restart", svc); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error()+": "+out.String())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	return s.auth(mux)
}

func (s *Server) auth(next http.Handler) http.Handler {
	want := []byte("Bearer " + s.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			writeErr(w, http.StatusUnauthorized, "bad token")
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

`server/cmd/updater/main.go`:

```go
// Command updater pulls, rebuilds and restarts the Datrope compose stack for the system
// dashboard. It runs in its own container with the Docker socket and the repo mounted:
//
//	DATROPE_UPDATER_TOKEN   shared with the server; empty disables the updater
//	DATROPE_UPDATER_ADDR    listen address (default :8090)
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path"
	"syscall"
	"time"

	"github.com/datrope/datrope/server/internal/updater"
)

const (
	repoMount = "/repo"
	stateDir  = "/state/jobs"
	socket    = "/var/run/docker.sock"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	token := os.Getenv("DATROPE_UPDATER_TOKEN")
	if token == "" {
		// Idle rather than exit: restart: unless-stopped would restart us forever.
		slog.Info("updater disabled: DATROPE_UPDATER_TOKEN is not set")
		<-ctx.Done()
		return nil
	}
	addr := os.Getenv("DATROPE_UPDATER_ADDR")
	if addr == "" {
		addr = ":8090"
	}

	docker := updater.NewDocker(socket)
	self, err := os.Hostname() // Docker sets the hostname to the container's short ID
	if err != nil {
		return err
	}
	repo, project, err := docker.Self(ctx, self, repoMount)
	if err != nil {
		return err
	}
	if err := updater.LinkRepo(repoMount, repo); err != nil {
		return err
	}
	as, err := updater.RunAs(repoMount)
	if err != nil {
		return err
	}
	jobs, err := updater.OpenJobs(stateDir)
	if err != nil {
		return err
	}
	git := &updater.Git{Dir: repo, As: as, Run: updater.ExecCmd}
	go git.RunDaily(ctx)

	s := &updater.Server{
		Token: token, Git: git, Jobs: jobs, Docker: docker,
		Compose: updater.Compose{Dir: path.Join(repo, "deploy"), Project: project, Run: updater.ExecCmd},
	}
	srv := &http.Server{Addr: addr, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	slog.Info("updater listening", "addr", addr, "repo", repo, "project", project)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
```

`deploy/updater.Dockerfile`:

```dockerfile
FROM golang:1.25-alpine AS build
ENV GOTOOLCHAIN=local
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/updater ./cmd/updater

# git pulls the checkout, docker compose rebuilds the stack, su-exec runs git as the
# checkout's owner. Runs as root: it needs the Docker socket anyway.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates git docker-cli docker-cli-compose su-exec
ENV HOME=/tmp
COPY --from=build /out/updater /updater
ENTRYPOINT ["/updater"]
```

`deploy/docker-compose.yml`, in `server.environment` add:

```yaml
      DATROPE_UPDATER_URL: http://updater:8090
      DATROPE_UPDATER_TOKEN: ${DATROPE_UPDATER_TOKEN:-}
```

add after the `caddy` service:

```yaml
  # Server settings → Updates: pulls this checkout, rebuilds and restarts the stack. It holds
  # the Docker socket, which is root on this machine, so it publishes no ports and answers only
  # requests with the token (only the server has it). Without DATROPE_UPDATER_TOKEN it idles.
  updater:
    build:
      context: ..
      dockerfile: deploy/updater.Dockerfile
    restart: unless-stopped
    environment:
      DATROPE_UPDATER_TOKEN: ${DATROPE_UPDATER_TOKEN:-}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ..:/repo
      - updater:/state
```

and `updater:` under the top-level `volumes:`. Leave `docker-compose.e2e.yml` alone.

`deploy/.env.example`, append:

```
# Lets admins update and restart the server from Server settings → Updates. The updater
# container that does this has full control of Docker on this machine (root-equivalent);
# only the Datrope server can reach it, with this token. Leave empty to turn it off (the
# System page and yt-dlp updates work either way). For example: openssl rand -hex 32
DATROPE_UPDATER_TOKEN=
```

`deploy/README.md`: add a section `## System dashboard and updates`: Server settings → System shows host CPU, memory and disk, database and file sizes, and the containers (with restart); Server settings → Updates shows how far the checkout is behind `main` and runs `git pull --ff-only`, `docker compose build`, `docker compose up -d` with a live log; yt-dlp updates download the latest release to the data volume (`/data/bin/yt-dlp`), checked against its SHA2-256SUMS, with no restart. Explain the token and the root-equivalent trade-off; that local changes or commits in the checkout make the pull fail and nothing changes; that `DATROPE_YTDLP` pins yt-dlp. `README.md` Install table: add a row `DATROPE_UPDATER_TOKEN` — "Optional. Turns on updates from the browser (see deploy/README.md)."

- [ ] **Step 4: Run tests and build**

Run: `cd server && go test ./internal/updater/ && go vet ./... && go build ./...`
Run, if Docker is available: `DATROPE_DOMAIN=x POSTGRES_PASSWORD=x LIVEKIT_API_SECRET=x docker compose -f deploy/docker-compose.yml config --quiet`
Expected: PASS; compose file valid

- [ ] **Step 5: Stage**

```bash
git -c safe.directory=* add server/internal/updater/ server/cmd/updater/ deploy/ README.md
```

---
### Task 10: System service, HTTP API and app wiring

**Files:**
- Create: `server/internal/system/updater_client.go`, `server/internal/system/service.go`, `server/internal/system/handlers.go`
- Modify: `server/internal/app/config.go`, `server/internal/app/app.go`, `server/internal/app/config_test.go`
- Test: `server/internal/system/handlers_test.go`

**Interfaces:**
- Consumes: `Sampler`, `Sources`, `HostStats` (2); `YtDlpBinary`, `ManagedYtDlp`, `music.YtDlpPath` (4); `YtDlp`, `YtDlpOptions`, `YtDlpStatus`, `ErrPinned` (5); `updater.GitStatus`, `updater.ContainerInfo`, `updater.UpdateJobLog` (6–8); `App.Gateway`, `voice.Service.Participants` (3).
- Produces:
  - `app.Config.UpdaterURL`, `app.Config.UpdaterToken`, `app.Config.GitHubAPI` ("" = real GitHub).
  - `system.Deps{Sources Sources; YtDlp YtDlpOptions; UpdaterURL, UpdaterToken string}`, `system.NewService(Deps) *Service`, `(*Service).Start()`, `(*Service).Close()`, `system.Register(huma.API, *Service)`.
  - `SystemStats{Host HostStats; Containers []updater.ContainerInfo; UpdaterConfigured bool; UpdaterError string}` (json: host, containers, updater_configured, updater_error omitempty); `ServerUpdate{Configured bool; Error string; Status *updater.GitStatus}` (json: configured, error, status); `SystemUpdates{Server ServerUpdate; YtDlp YtDlpStatus}` (json: server, ytdlp); `UpdateStarted{JobID string}` (json: job_id).
  - Endpoints from the spec's table. Errors: 503 `UPDATER_NOT_CONFIGURED`, 503 `UPDATER_UNREACHABLE`, 409 `UPDATE_RUNNING`, 404 `NOT_FOUND`, 409 `YTDLP_PINNED`, 502 `UPDATER_ERROR`, 502 `YTDLP_UPDATE_FAILED`.

- [ ] **Step 1: Write the failing tests**

`server/internal/system/handlers_test.go`:

```go
package system_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/system"
	"github.com/datrope/datrope/server/internal/updater"
)

// fakeUpdater answers like the updater container, checking the token.
func fakeUpdater(t *testing.T) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /containers", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]updater.ContainerInfo{{Service: "server", State: "running", Status: "Up 1 hour"}})
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(updater.GitStatus{Current: "aaa", Latest: "bbb", Behind: 1, Commits: []updater.GitCommit{{SHA: "bbb", Subject: "Fix"}}})
	})
	mux.HandleFunc("POST /update", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"job_id":"00000000000000000042"}`))
	})
	mux.HandleFunc("GET /jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != "00000000000000000042" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"no such job"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(updater.UpdateJobLog{Job: updater.UpdateJob{ID: "00000000000000000042", Status: "running"}, Lines: []string{"x"}, Next: 4})
	})
	mux.HandleFunc("POST /containers/{service}/restart", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("service") != "server" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"no such service"}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func withUpdater(url string) func(*app.Config) {
	return func(c *app.Config) { c.UpdaterURL, c.UpdaterToken = url, "tok" }
}

func TestSystemAdminOnly(t *testing.T) {
	env := apptest.New(t)
	env.Register("admin")
	bob := env.Register("bob")
	bob.Fail(http.MethodGet, "/api/admin/system/stats", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodGet, "/api/admin/system/updates", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPost, "/api/admin/system/updates/server", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPost, "/api/admin/system/updates/ytdlp", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPost, "/api/admin/system/containers/server/restart", nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestSystemWithoutUpdater(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	var st system.SystemStats
	admin.Do(http.MethodGet, "/api/admin/system/stats", nil, http.StatusOK, &st)
	require.False(t, st.UpdaterConfigured)
	require.NotNil(t, st.Containers)

	var up system.SystemUpdates
	admin.Do(http.MethodGet, "/api/admin/system/updates", nil, http.StatusOK, &up)
	require.False(t, up.Server.Configured)
	admin.Fail(http.MethodPost, "/api/admin/system/updates/server", nil, http.StatusServiceUnavailable, "UPDATER_NOT_CONFIGURED")
	admin.Fail(http.MethodPost, "/api/admin/system/containers/server/restart", nil, http.StatusServiceUnavailable, "UPDATER_NOT_CONFIGURED")
}

func TestSystemWithUpdater(t *testing.T) {
	up := fakeUpdater(t)
	env := apptest.NewWithConfig(t, withUpdater(up.URL))
	admin := env.Register("admin")

	var st system.SystemStats
	admin.Do(http.MethodGet, "/api/admin/system/stats", nil, http.StatusOK, &st)
	require.True(t, st.UpdaterConfigured)
	require.Empty(t, st.UpdaterError)
	require.Equal(t, "server", st.Containers[0].Service)

	var u system.SystemUpdates
	admin.Do(http.MethodGet, "/api/admin/system/updates", nil, http.StatusOK, &u)
	require.Equal(t, 1, u.Server.Status.Behind)

	var started system.UpdateStarted
	admin.Do(http.MethodPost, "/api/admin/system/updates/server", nil, http.StatusAccepted, &started)
	require.Equal(t, "00000000000000000042", started.JobID)

	var log updater.UpdateJobLog
	admin.Do(http.MethodGet, "/api/admin/system/jobs/00000000000000000042?after=3", nil, http.StatusOK, &log)
	require.Equal(t, 4, log.Next)
	admin.Fail(http.MethodGet, "/api/admin/system/jobs/00000000000000000043", nil, http.StatusNotFound, "NOT_FOUND")

	admin.Do(http.MethodPost, "/api/admin/system/containers/server/restart", nil, http.StatusNoContent, nil)
	admin.Fail(http.MethodPost, "/api/admin/system/containers/nope/restart", nil, http.StatusNotFound, "NOT_FOUND")
}

func TestSystemUpdaterDown(t *testing.T) {
	up := fakeUpdater(t)
	url := up.URL
	up.Close()
	env := apptest.NewWithConfig(t, withUpdater(url))
	admin := env.Register("admin")

	var st system.SystemStats
	admin.Do(http.MethodGet, "/api/admin/system/stats", nil, http.StatusOK, &st)
	require.NotEmpty(t, st.UpdaterError, "host metrics still load")
	admin.Fail(http.MethodPost, "/api/admin/system/updates/server", nil, http.StatusServiceUnavailable, "UPDATER_UNREACHABLE")
}
```

Add to `server/internal/app/config_test.go`, in its existing style (it sets env vars with `t.Setenv`): with `DATROPE_UPDATER_TOKEN=x` and no `DATROPE_UPDATER_URL`, `UpdaterURL` is `http://updater:8090`; with neither set, both are empty.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && go test ./internal/system/ ./internal/app/`
Expected: FAIL (undefined: system.SystemStats, Config.UpdaterURL)

- [ ] **Step 3: Implement**

`server/internal/system/updater_client.go`:

```go
package system

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/datrope/datrope/server/internal/updater"
)

var errUpdaterDown = errors.New("updater unreachable")

// upstreamError is an error status from the updater.
type upstreamError struct {
	status int
	msg    string
}

func (e *upstreamError) Error() string { return fmt.Sprintf("updater: %d %s", e.status, e.msg) }

// updaterClient calls the updater container with the shared token.
type updaterClient struct {
	base, token string
	hc          *http.Client
}

func newUpdaterClient(base, token string) *updaterClient {
	if token == "" || base == "" {
		return nil
	}
	// Long enough for git fetch (check) and a compose restart; stats answer in about a second.
	return &updaterClient{base: strings.TrimSuffix(base, "/"), token: token, hc: &http.Client{Timeout: 3 * time.Minute}}
}

func (c *updaterClient) do(ctx context.Context, method, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	res, err := c.hc.Do(req)
	if err != nil {
		return errUpdaterDown
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		var e struct {
			Error string `json:"error"`
		}
		b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		if json.Unmarshal(b, &e) != nil || e.Error == "" {
			e.Error = strings.TrimSpace(string(b))
		}
		return &upstreamError{status: res.StatusCode, msg: e.Error}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (c *updaterClient) status(ctx context.Context) (updater.GitStatus, error) {
	var s updater.GitStatus
	return s, c.do(ctx, http.MethodGet, "/status", &s)
}

func (c *updaterClient) check(ctx context.Context) (updater.GitStatus, error) {
	var s updater.GitStatus
	return s, c.do(ctx, http.MethodPost, "/check", &s)
}

func (c *updaterClient) update(ctx context.Context) (string, error) {
	var r struct {
		JobID string `json:"job_id"`
	}
	return r.JobID, c.do(ctx, http.MethodPost, "/update", &r)
}

func (c *updaterClient) job(ctx context.Context, id string, after int) (updater.UpdateJobLog, error) {
	var l updater.UpdateJobLog
	return l, c.do(ctx, http.MethodGet, "/jobs/"+url.PathEscape(id)+"?after="+strconv.Itoa(after), &l)
}

func (c *updaterClient) containers(ctx context.Context) ([]updater.ContainerInfo, error) {
	var cs []updater.ContainerInfo
	return cs, c.do(ctx, http.MethodGet, "/containers", &cs)
}

func (c *updaterClient) restart(ctx context.Context, service string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(service)+"/restart", nil)
}
```

`server/internal/system/service.go`:

```go
// Package system is the instance admin's dashboard: host metrics, and updates of the server
// (through the updater container) and of yt-dlp.
package system

import (
	"context"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/updater"
)

type Deps struct {
	Sources      Sources
	YtDlp        YtDlpOptions
	UpdaterURL   string
	UpdaterToken string // empty: no updater; server updates and restarts are off
}

type Service struct {
	sampler *Sampler
	yt      *YtDlp
	up      *updaterClient // nil when not configured

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func NewService(d Deps) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{
		sampler: NewSampler(d.Sources, time.Now()),
		yt:      NewYtDlp(d.YtDlp),
		up:      newUpdaterClient(d.UpdaterURL, d.UpdaterToken),
		ctx:     ctx, cancel: cancel,
	}
}

// Start samples the host and checks yt-dlp daily until Close.
func (s *Service) Start() {
	s.wg.Add(2)
	go func() { defer s.wg.Done(); s.sampler.Run(s.ctx) }()
	go func() { defer s.wg.Done(); s.yt.RunDaily(s.ctx) }()
}

func (s *Service) Close() {
	s.cancel()
	s.wg.Wait()
}

type SystemStats struct {
	Host              HostStats               `json:"host"`
	Containers        []updater.ContainerInfo `json:"containers"`
	UpdaterConfigured bool                    `json:"updater_configured"`
	UpdaterError      string                  `json:"updater_error,omitempty"`
}

type ServerUpdate struct {
	Configured bool               `json:"configured" doc:"DATROPE_UPDATER_TOKEN is set"`
	Error      string             `json:"error,omitempty"`
	Status     *updater.GitStatus `json:"status,omitempty"`
}

type SystemUpdates struct {
	Server ServerUpdate `json:"server"`
	YtDlp  YtDlpStatus  `json:"ytdlp"`
}

type UpdateStarted struct {
	JobID string `json:"job_id"`
}

func (s *Service) stats(ctx context.Context) SystemStats {
	st := SystemStats{Host: s.sampler.Snapshot(time.Now()), Containers: []updater.ContainerInfo{}, UpdaterConfigured: s.up != nil}
	if s.up != nil {
		cs, err := s.up.containers(ctx)
		switch {
		case err != nil:
			st.UpdaterError = err.Error()
		case cs != nil:
			st.Containers = cs
		}
	}
	return st
}

func (s *Service) serverUpdate(ctx context.Context, check bool) ServerUpdate {
	u := ServerUpdate{Configured: s.up != nil}
	if s.up == nil {
		return u
	}
	get := s.up.status
	if check {
		get = s.up.check
	}
	st, err := get(ctx)
	if err != nil {
		u.Error = err.Error()
		return u
	}
	u.Status = &st
	return u
}

// updates reports both; check first asks GitHub and the updater for news (in parallel).
func (s *Service) updates(ctx context.Context, check bool) SystemUpdates {
	var u SystemUpdates
	if check {
		done := make(chan struct{})
		go func() { defer close(done); _ = s.yt.Check(ctx) }()
		u.Server = s.serverUpdate(ctx, true)
		<-done
	} else {
		u.Server = s.serverUpdate(ctx, false)
	}
	u.YtDlp = s.yt.Status()
	return u
}
```

`server/internal/system/handlers.go`:

```go
package system

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/updater"
)

func requireAdmin(ctx context.Context) error {
	if p := auth.Current(ctx); p == nil || !p.User.IsAdmin {
		return httpx.MissingPermission()
	}
	return nil
}

func (s *Service) needUpdater() error {
	if s.up == nil {
		return httpx.E(http.StatusServiceUnavailable, "UPDATER_NOT_CONFIGURED", "set DATROPE_UPDATER_TOKEN to update the server from here")
	}
	return nil
}

// updaterErr turns an updater failure into the API error; what names the missing thing on a 404.
func updaterErr(err error, what string) error {
	var up *upstreamError
	switch {
	case errors.Is(err, errUpdaterDown):
		return httpx.E(http.StatusServiceUnavailable, "UPDATER_UNREACHABLE", "Updater unreachable")
	case errors.As(err, &up) && up.status == http.StatusConflict:
		return httpx.E(http.StatusConflict, "UPDATE_RUNNING", "an update is already running")
	case errors.As(err, &up) && up.status == http.StatusNotFound:
		return httpx.NotFound(what)
	default:
		return httpx.E(http.StatusBadGateway, "UPDATER_ERROR", err.Error())
	}
}

func Register(api huma.API, s *Service) {
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: []string{"admin"}, Security: httpx.Authed, DefaultStatus: status}
	}

	huma.Register(api, op("admin-system-stats", http.MethodGet, "/api/admin/system/stats", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body SystemStats }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			return &struct{ Body SystemStats }{s.stats(ctx)}, nil
		})

	huma.Register(api, op("admin-system-updates", http.MethodGet, "/api/admin/system/updates", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body SystemUpdates }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			return &struct{ Body SystemUpdates }{s.updates(ctx, false)}, nil
		})

	huma.Register(api, op("admin-system-check-updates", http.MethodPost, "/api/admin/system/updates/check", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body SystemUpdates }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			return &struct{ Body SystemUpdates }{s.updates(ctx, true)}, nil
		})

	huma.Register(api, op("admin-system-update-server", http.MethodPost, "/api/admin/system/updates/server", http.StatusAccepted),
		func(ctx context.Context, _ *struct{}) (*struct{ Body UpdateStarted }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			if err := s.needUpdater(); err != nil {
				return nil, err
			}
			id, err := s.up.update(ctx)
			if err != nil {
				return nil, updaterErr(err, "update")
			}
			return &struct{ Body UpdateStarted }{UpdateStarted{JobID: id}}, nil
		})

	huma.Register(api, op("admin-system-update-ytdlp", http.MethodPost, "/api/admin/system/updates/ytdlp", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body YtDlpStatus }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			if err := s.yt.Update(ctx); err != nil {
				if errors.Is(err, ErrPinned) {
					return nil, httpx.E(http.StatusConflict, "YTDLP_PINNED", err.Error())
				}
				return nil, httpx.E(http.StatusBadGateway, "YTDLP_UPDATE_FAILED", err.Error())
			}
			return &struct{ Body YtDlpStatus }{s.yt.Status()}, nil
		})

	huma.Register(api, op("admin-system-job", http.MethodGet, "/api/admin/system/jobs/{id}", 0),
		func(ctx context.Context, in *struct {
			ID    string `path:"id" pattern:"^[0-9]{1,20}$"`
			After int    `query:"after" minimum:"0"`
		}) (*struct{ Body updater.UpdateJobLog }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			if err := s.needUpdater(); err != nil {
				return nil, err
			}
			l, err := s.up.job(ctx, in.ID, in.After)
			if err != nil {
				return nil, updaterErr(err, "job")
			}
			return &struct{ Body updater.UpdateJobLog }{l}, nil
		})

	huma.Register(api, op("admin-system-restart", http.MethodPost, "/api/admin/system/containers/{service}/restart", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			Service string `path:"service" pattern:"^[a-z0-9][a-z0-9_.-]{0,62}$"`
		}) (*struct{}, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			if err := s.needUpdater(); err != nil {
				return nil, err
			}
			if err := s.up.restart(ctx, in.Service); err != nil {
				return nil, updaterErr(err, "service")
			}
			return nil, nil
		})
}
```

(If `auth.Current` returns a value rather than a pointer, drop the `p == nil` check; `admin.go:37` shows its use.)

`server/internal/app/config.go`, add to `Config`:

```go
	// UpdaterURL and UpdaterToken reach the updater container (Server settings → Updates).
	// Without a token the dashboard cannot update or restart the server.
	UpdaterURL   string
	UpdaterToken string
	GitHubAPI    string // GitHub's API base for yt-dlp releases; "" is the real one (tests point it at a fake)
```

In `ConfigFromEnv`'s `c := Config{...}` literal add:

```go
		UpdaterURL:   strings.TrimSuffix(os.Getenv("DATROPE_UPDATER_URL"), "/"),
		UpdaterToken: os.Getenv("DATROPE_UPDATER_TOKEN"),
```

and after the `DataDir` default:

```go
	if c.UpdaterToken != "" && c.UpdaterURL == "" {
		c.UpdaterURL = "http://updater:8090"
	}
```

`server/internal/app/app.go`:
1. Just before `musicSvc := music.NewService(...)`:

```go
	ytPath, ytPinned := system.YtDlpBinary(cfg.Music.YtDlp, cfg.DataDir)
	ytDlp := music.NewYtDlpPath(ytPath)
	cfg.Music.YtDlpPath = ytDlp
```

2. Declare `var gw *gateway.Gateway` before the gateway `if pool != nil {` block and change `gw := gateway.New(` to `gw = gateway.New(`.
3. After the gateway block, before `mux.HandleFunc("GET /healthz", ...)`:

```go
	sysDeps := system.Deps{
		Sources: system.Sources{DataDir: cfg.DataDir, InVoice: voiceSvc.Participants},
		YtDlp: system.YtDlpOptions{
			Path: ytDlp, Managed: system.ManagedYtDlp(cfg.DataDir), Pinned: ytPinned, API: cfg.GitHubAPI,
		},
		UpdaterURL: cfg.UpdaterURL, UpdaterToken: cfg.UpdaterToken,
	}
	if runtime.GOOS == "linux" {
		sysDeps.Sources.Proc = os.DirFS("/proc")
	}
	if pool != nil { // nil only for `datrope openapi`
		sysDeps.Sources.Connections = gw.Connections
		sysDeps.Sources.DatabaseSize = func(ctx context.Context) (n int64, err error) {
			err = pool.QueryRow(ctx, "SELECT pg_database_size(current_database())").Scan(&n)
			return n, err
		}
	}
	sysSvc := system.NewService(sysDeps)
	system.Register(api, sysSvc)
	if pool != nil {
		sysSvc.Start()
		a.closers = append(a.closers, sysSvc.Close)
	}
```

Add imports `os`, `runtime`, `github.com/datrope/datrope/server/internal/system`.

- [ ] **Step 4: Run tests**

Run: `cd server && go test ./internal/system/ ./internal/app/ ./internal/music/ && go vet ./... && go build ./...`
Expected: PASS (needs Docker for the Postgres testcontainer)

Then run the whole suite once: `cd server && go test ./...`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git -c safe.directory=* add server/
```

---
### Task 11: Web — generated client, helpers and System page

**Files:**
- Modify (generated): `clients/core/openapi.json`, `clients/core/src/schema.d.ts`
- Modify: `clients/core/src/types.ts` (type aliases)
- Create: `clients/web/src/lib/system.ts`, `clients/web/src/lib/system.test.ts`, `clients/web/src/app/server-settings/Sparkline.tsx`, `clients/web/src/app/server-settings/System.tsx`, `clients/web/src/app/server-settings/System.test.tsx`
- Modify: `clients/web/src/app/server-settings/ServerSettings.tsx` (section entry)

**Interfaces:**
- Consumes: Task 10 endpoints.
- Produces: in `@datrope/core`: types `SystemStats`, `SystemSample`, `HostStats`, `ContainerInfo`, `SystemUpdates`, `YtDlpStatus`, `GitStatus`, `GitCommit`, `UpdateJobLog`. In `@/lib/system`: `formatBytes(n: number): string`, `formatDuration(seconds: number): string`, `sparklinePoints(values: number[], max: number, width: number, height: number): string`, `updatesAvailable(u: SystemUpdates): number`. Components: `Sparkline({ values, max })`, `System()`, `SystemView({ stats, onRestart })`.

- [ ] **Step 1: Regenerate the API client**

Run (from the repo root): `pnpm --filter @datrope/core gen`
Expected: `clients/core/openapi.json` and `clients/core/src/schema.d.ts` gain the `/api/admin/system/*` paths and the schemas above.

Add to `clients/core/src/types.ts`:

```ts
export type SystemStats = Schemas["SystemStats"];
export type SystemSample = Schemas["SystemSample"];
export type HostStats = Schemas["HostStats"];
export type ContainerInfo = Schemas["ContainerInfo"];
export type SystemUpdates = Schemas["SystemUpdates"];
export type YtDlpStatus = Schemas["YtDlpStatus"];
export type GitStatus = Schemas["GitStatus"];
export type GitCommit = Schemas["GitCommit"];
export type UpdateJobLog = Schemas["UpdateJobLog"];
```

(If huma named a schema differently, use the name it has in `schema.d.ts`.)

- [ ] **Step 2: Write the failing tests**

`clients/web/src/lib/system.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, sparklinePoints, updatesAvailable } from "./system";

describe("formatBytes", () => {
  it("picks a unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 ** 3)).toBe("20 GB");
    expect(formatBytes(3.25 * 1024 ** 4)).toBe("3.3 TB");
  });
});

describe("formatDuration", () => {
  it("shows the two largest units", () => {
    expect(formatDuration(59)).toBe("0m");
    expect(formatDuration(3 * 60)).toBe("3m");
    expect(formatDuration(4 * 3600 + 12 * 60)).toBe("4h 12m");
    expect(formatDuration(3 * 86400 + 4 * 3600 + 5)).toBe("3d 4h");
  });
});

describe("sparklinePoints", () => {
  it("scales to the box, newest on the right", () => {
    expect(sparklinePoints([0, 50, 100], 100, 100, 20)).toBe("0,20 50,10 100,0");
  });
  it("is empty without two points and clamps above max", () => {
    expect(sparklinePoints([5], 100, 100, 20)).toBe("");
    expect(sparklinePoints([0, 200], 100, 10, 10)).toBe("0,10 10,0");
  });
});

describe("updatesAvailable", () => {
  const base = { server: { configured: true }, ytdlp: { available: true, installed: "1", latest: "1", pinned: false } };
  it("counts the server and yt-dlp", () => {
    expect(updatesAvailable(base as never)).toBe(0);
    expect(updatesAvailable({ ...base, server: { configured: true, status: { behind: 3 } } } as never)).toBe(1);
    expect(updatesAvailable({ ...base, ytdlp: { ...base.ytdlp, latest: "2" } } as never)).toBe(1);
  });
  it("ignores a pinned or unknown yt-dlp", () => {
    expect(updatesAvailable({ ...base, ytdlp: { ...base.ytdlp, latest: "2", pinned: true } } as never)).toBe(0);
    expect(updatesAvailable({ ...base, ytdlp: { ...base.ytdlp, latest: "" } } as never)).toBe(0);
  });
});
```

`clients/web/src/app/server-settings/System.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SystemStats } from "@datrope/core";
import { SystemView } from "./System";

vi.mock("@/session", () => ({ client: {} }));

const sample = {
  at: "2026-10-11T10:00:00Z", cpu_percent: 12.5, mem_used: 2 * 1024 ** 3, mem_total: 8 * 1024 ** 3,
  disk_used: 10 * 1024 ** 3, disk_total: 100 * 1024 ** 3, connections: 4, in_voice: 2,
};
const stats = (over: Partial<SystemStats> = {}): SystemStats => ({
  host: { latest: sample, series: [sample, sample], host_uptime_seconds: 90000, process_uptime_seconds: 600, database_bytes: 1024 ** 2, files_bytes: 5 * 1024 ** 3 },
  containers: [{ service: "server", name: "datrope-server-1", state: "running", status: "Up 2 hours", cpu_percent: 3, mem_bytes: 100 * 1024 ** 2, mem_limit: 0 }],
  updater_configured: true,
  ...over,
});

describe("SystemView", () => {
  it("shows host figures and containers", () => {
    const html = renderToStaticMarkup(<SystemView stats={stats()} onRestart={() => {}} />);
    expect(html).toContain("13%"); // CPU, rounded
    expect(html).toContain("2 GB of 8 GB");
    expect(html).toContain("5 GB"); // uploaded files
    expect(html).toContain("1d 1h"); // host uptime
    expect(html).toContain("datrope-server-1");
    expect(html).toContain('aria-label="Restart server"');
  });

  it("explains a missing updater instead of the table", () => {
    const html = renderToStaticMarkup(<SystemView stats={stats({ updater_configured: false, containers: [] })} onRestart={() => {}} />);
    expect(html).toContain("DATROPE_UPDATER_TOKEN");
    expect(html).not.toContain("Restart server");
  });

  it("shows why the updater did not answer", () => {
    const html = renderToStaticMarkup(<SystemView stats={stats({ updater_error: "updater unreachable", containers: [] })} onRestart={() => {}} />);
    expect(html).toContain("updater unreachable");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd clients/web && pnpm vitest run src/lib/system.test.ts src/app/server-settings/System.test.tsx`
Expected: FAIL (modules not found)

- [ ] **Step 4: Implement**

`clients/web/src/lib/system.ts`:

```ts
import type { SystemUpdates } from "@datrope/core";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 1536 → "1.5 KB": one decimal below 10, none above. */
export function formatBytes(n: number): string {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  const s = i === 0 || n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
  return `${s} ${UNITS[i]}`;
}

/** The two largest units: "3d 4h", "4h 12m", "12m". */
export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** SVG polyline points for values in [0, max], spread over width, 0 at the bottom. */
export function sparklinePoints(values: number[], max: number, width: number, height: number): string {
  if (values.length < 2 || max <= 0) return "";
  const step = width / (values.length - 1);
  return values
    .map((v, i) => {
      const y = height - (Math.min(Math.max(v, 0), max) / max) * height;
      return `${+(i * step).toFixed(2)},${+y.toFixed(2)}`;
    })
    .join(" ");
}

/** How many things can be updated (for the nav badge). */
export function updatesAvailable(u: SystemUpdates): number {
  let n = 0;
  if ((u.server.status?.behind ?? 0) > 0) n++;
  const y = u.ytdlp;
  if (!y.pinned && y.latest && y.installed && y.latest !== y.installed) n++;
  return n;
}
```

`clients/web/src/app/server-settings/Sparkline.tsx`:

```tsx
import { sparklinePoints } from "@/lib/system";

const W = 120;
const H = 32;

/** A small line of the last ten minutes. Decorative: the figure next to it carries the value. */
export function Sparkline({ values, max }: { values: number[]; max: number }) {
  const points = sparklinePoints(values, max, W, H);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-full text-primary" preserveAspectRatio="none" aria-hidden>
      {points && <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
```

`clients/web/src/app/server-settings/System.tsx`:

```tsx
import { unwrap, type ContainerInfo, type SystemStats } from "@datrope/core";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSubmit } from "@/hooks/use-submit";
import { formatBytes, formatDuration } from "@/lib/system";
import { client } from "@/session";
import { Sparkline } from "./Sparkline";

const POLL_MS = 5000;

/** Host and container metrics (instance admin). Polls while open. */
export function System() {
  const [stats, setStats] = useState<SystemStats>();
  const [error, setError] = useState<unknown>();
  const { error: restartError, run } = useSubmit();

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const s = await unwrap(client.api.GET("/api/admin/system/stats"));
        if (live) { setStats(s); setError(undefined); }
      } catch (e) {
        if (live) setError(e);
      }
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  const restart = (service: string) => run(async () => {
    await unwrap(client.api.POST("/api/admin/system/containers/{service}/restart", { params: { path: { service } } }));
  });

  return (
    <>
      <ErrorText error={error ?? restartError} />
      {stats && <SystemView stats={stats} onRestart={(s) => void restart(s)} />}
    </>
  );
}

function Meter({ title, value, detail, series }: { title: string; value: number; detail: string; series: number[] }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-2 px-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-semibold tabular-nums">{Math.round(value)}%</span>
          <span className="text-xs text-muted-foreground">{detail}</span>
        </div>
        <Progress value={value} aria-label={`${title} ${Math.round(value)}%`} />
        <Sparkline values={series} max={100} />
      </CardContent>
    </Card>
  );
}

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

/** The page body for given stats (rendered on its own in tests). */
export function SystemView({ stats, onRestart }: { stats: SystemStats; onRestart: (service: string) => void }) {
  const { host } = stats;
  const s = host.latest;
  const series = host.series;
  const figures: [string, string][] = [
    ["Host uptime", formatDuration(host.host_uptime_seconds)],
    ["Server uptime", formatDuration(host.process_uptime_seconds)],
    ["Database", formatBytes(host.database_bytes)],
    ["Uploaded files", formatBytes(host.files_bytes)],
    ["Connections", String(s?.connections ?? 0)],
    ["In voice", String(s?.in_voice ?? 0)],
  ];
  return (
    <>
      <section className="grid gap-3" aria-labelledby="host-h">
        <h3 id="host-h" className="text-sm font-semibold">Host</h3>
        {s ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Meter title="CPU" value={s.cpu_percent} detail="all cores" series={series.map((x) => x.cpu_percent)} />
            <Meter title="Memory" value={pct(s.mem_used, s.mem_total)} detail={`${formatBytes(s.mem_used)} of ${formatBytes(s.mem_total)}`}
              series={series.map((x) => pct(x.mem_used, x.mem_total))} />
            <Meter title="Disk" value={pct(s.disk_used, s.disk_total)} detail={`${formatBytes(s.disk_used)} of ${formatBytes(s.disk_total)}`}
              series={series.map((x) => pct(x.disk_used, x.disk_total))} />
          </div>
        ) : (
          <p className="text-muted-foreground">Collecting the first sample…</p>
        )}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
          {figures.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="grid gap-3" aria-labelledby="containers-h">
        <h3 id="containers-h" className="text-sm font-semibold">Containers</h3>
        {!stats.updater_configured ? (
          <p className="max-w-[68ch] text-muted-foreground">
            Container status and restarts need the updater. Set <code>DATROPE_UPDATER_TOKEN</code> in <code>deploy/.env</code>
            {" "}and run <code>docker compose up -d</code> once (see <code>deploy/README.md</code>).
          </p>
        ) : stats.updater_error ? (
          <p role="alert" className="text-destructive">The updater did not answer: {stats.updater_error}</p>
        ) : (
          <ContainerTable containers={stats.containers} onRestart={onRestart} />
        )}
      </section>
    </>
  );
}

function ContainerTable({ containers, onRestart }: { containers: ContainerInfo[]; onRestart: (service: string) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Container</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">CPU</TableHead>
          <TableHead className="text-right">Memory</TableHead>
          <TableHead><span className="sr-only">Actions</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {containers.map((c) => {
          const running = c.state === "running";
          return (
            <TableRow key={c.name}>
              <TableCell className="font-medium">{c.name}</TableCell>
              <TableCell>
                <Badge variant={running ? "secondary" : "destructive"}>{c.state}</Badge>
                <span className="ml-2 text-xs text-muted-foreground">{c.status}</span>
              </TableCell>
              <TableCell className="text-right tabular-nums">{running ? `${c.cpu_percent.toFixed(1)}%` : "–"}</TableCell>
              <TableCell className="text-right tabular-nums">{running ? formatBytes(c.mem_bytes) : "–"}</TableCell>
              <TableCell className="text-right">
                {c.service !== "updater" && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <RefButton variant="outline" size="sm" aria-label={`Restart ${c.service}`}>Restart</RefButton>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Restart {c.service}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {c.service === "server"
                            ? "Everyone is disconnected for a few seconds and reconnects on their own."
                            : `The ${c.service} container stops and starts again.`}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => onRestart(c.service)}>Restart</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
```

`ServerSettings.tsx`: add `Activity` to the `lucide-react` import, `import { System } from "./System";`, and after the `integrations` entry:

```tsx
  { id: "system", label: "System", group: "Instance", icon: Activity, visible: admin, element: <System /> },
```

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `cd clients/web && pnpm vitest run && pnpm typecheck`, then from the repo root `pnpm lint`
Expected: PASS

- [ ] **Step 6: Check in the browser**

Start the dev setup the way this repo does (`.claude/launch.json` if present; otherwise ask the user; memory notes port 8080 is taken on this machine). Sign in as the admin, open Server settings → System: three meters fill in within 10 s (on Windows only Disk may stay empty; that is expected off Linux), figures show, Containers shows the "needs the updater" text. Take a screenshot for the user.

- [ ] **Step 7: Stage**

```bash
git -c safe.directory=* add clients/core/ clients/web/src/
```

---
### Task 12: Web — Updates page, live log and nav badge

**Files:**
- Create: `clients/web/src/app/server-settings/Updates.tsx`, `clients/web/src/app/server-settings/Updates.test.tsx`, `clients/web/src/app/server-settings/use-update-count.ts`
- Modify: `clients/web/src/lib/system.ts` (add `nextPoll`), `clients/web/src/lib/system.test.ts`
- Modify: `clients/web/src/app/server-settings/ServerSettings.tsx` (section + badge)

**Interfaces:**
- Consumes: Task 10 endpoints; Task 11 helpers and types.
- Produces: `Updates()`, `UpdatesView(props)`, `useUpdateCount(enabled: boolean): number`, and in `@/lib/system`:

```ts
export type JobPhase = "running" | "restarting" | "succeeded" | "failed";
export interface JobView { phase: JobPhase; lines: string[]; next: number }
export function nextPoll(prev: JobView, result: UpdateJobLog | undefined): JobView;
```

- [ ] **Step 1: Write the failing tests**

Append to `clients/web/src/lib/system.test.ts` (add `nextPoll` to the existing import):

```ts
describe("nextPoll", () => {
  const start = { phase: "running" as const, lines: ["a"], next: 1 };
  const log = (status: string, lines: string[], next: number) => ({ job: { id: "1", status, started_at: "" }, lines, next }) as never;

  it("appends new lines and follows the status", () => {
    expect(nextPoll(start, log("running", ["b"], 2))).toEqual({ phase: "running", lines: ["a", "b"], next: 2 });
    expect(nextPoll(start, log("succeeded", [], 1)).phase).toBe("succeeded");
    expect(nextPoll(start, log("failed", ["!! boom"], 2)).phase).toBe("failed");
  });

  it("treats a failed poll as the server restarting, not as a failed update", () => {
    const r = nextPoll(start, undefined);
    expect(r).toEqual({ phase: "restarting", lines: ["a"], next: 1 });
    expect(nextPoll(r, log("running", ["c"], 2))).toEqual({ phase: "running", lines: ["a", "c"], next: 2 });
  });

  it("stays finished", () => {
    expect(nextPoll({ ...start, phase: "succeeded" }, undefined).phase).toBe("succeeded");
  });
});
```

`clients/web/src/app/server-settings/Updates.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SystemUpdates } from "@datrope/core";
import { UpdatesView } from "./Updates";

vi.mock("@/session", () => ({ client: {} }));

const ytdlp = { available: true, installed: "2026.01.01", latest: "2026.10.01", pinned: false };
const updates = (over: Partial<SystemUpdates> = {}): SystemUpdates => ({
  server: {
    configured: true,
    status: {
      current: "aaaaaaa1", latest: "ccccccc3", behind: 2, commits: [
        { sha: "ccccccc3", subject: "Fix voice", author: "Filip", date: "2026-10-11T10:00:00Z" },
        { sha: "bbbbbbb2", subject: "Add polls", author: "Filip", date: "2026-10-10T10:00:00Z" },
      ],
    },
  },
  ytdlp,
  ...over,
});
const noop = () => {};
const props = { busy: false, job: undefined, onCheck: noop, onUpdateServer: noop, onUpdateYtDlp: noop };

describe("UpdatesView", () => {
  it("lists the commits behind and offers the updates", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates()} />);
    expect(html).toContain("2 commits behind");
    expect(html).toContain("Fix voice");
    expect(html).toContain("Update server");
    expect(html).toContain("2026.01.01");
    expect(html).toContain("Update yt-dlp");
  });

  it("says when everything is current", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates({
      server: { configured: true, status: { current: "a", latest: "a", behind: 0, commits: [] } },
      ytdlp: { ...ytdlp, latest: "2026.01.01" },
    })} />);
    expect(html).toContain("Up to date");
    expect(html).not.toContain("Update server");
    expect(html).not.toContain("Update yt-dlp");
  });

  it("explains a missing updater and a pinned yt-dlp", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates({ server: { configured: false }, ytdlp: { ...ytdlp, pinned: true } })} />);
    expect(html).toContain("DATROPE_UPDATER_TOKEN");
    expect(html).toContain("managed by DATROPE_YTDLP");
    expect(html).not.toContain("Update yt-dlp");
  });

  it("shows the log of a running job and hides the update button", () => {
    const html = renderToStaticMarkup(<UpdatesView {...props} updates={updates()} job={{ phase: "restarting", lines: ["==> docker compose up"], next: 1 }} />);
    expect(html).toContain("==&gt; docker compose up");
    expect(html).toContain("Restarting");
    expect(html).not.toContain("Update server");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd clients/web && pnpm vitest run src/lib/system.test.ts src/app/server-settings/Updates.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

Add to `clients/web/src/lib/system.ts` (extend the type import to `import type { SystemUpdates, UpdateJobLog } from "@datrope/core";`):

```ts
export type JobPhase = "running" | "restarting" | "succeeded" | "failed";
export interface JobView { phase: JobPhase; lines: string[]; next: number }

/**
 * Folds one poll of the update log into what the page shows. The server goes away while the
 * update restarts it, so a failed poll means "restarting", never "failed"; finished jobs stay put.
 */
export function nextPoll(prev: JobView, result: UpdateJobLog | undefined): JobView {
  if (prev.phase === "succeeded" || prev.phase === "failed") return prev;
  if (!result) return { ...prev, phase: "restarting" };
  const s = result.job.status;
  const phase: JobPhase = s === "succeeded" ? "succeeded" : s === "failed" ? "failed" : "running";
  return { phase, lines: [...prev.lines, ...result.lines], next: result.next };
}
```

`clients/web/src/app/server-settings/Updates.tsx`:

```tsx
import { unwrap, type SystemUpdates } from "@datrope/core";
import { useEffect, useRef, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useSubmit } from "@/hooks/use-submit";
import { nextPoll, type JobView } from "@/lib/system";
import { client } from "@/session";

const JOB_POLL_MS = 1000;
const JOB_KEY = "datrope.updateJob"; // lets a reload during the server restart find the job again

function readJobId(): string | undefined {
  try { return sessionStorage.getItem(JOB_KEY) ?? undefined; } catch { return undefined; }
}
function writeJobId(id: string | undefined) {
  try { if (id) sessionStorage.setItem(JOB_KEY, id); else sessionStorage.removeItem(JOB_KEY); } catch { /* storage blocked */ }
}

/** Server and yt-dlp updates (instance admin). */
export function Updates() {
  const [updates, setUpdates] = useState<SystemUpdates>();
  const [jobId, setJobId] = useState<string | undefined>(readJobId);
  const [job, setJob] = useState<JobView>();
  const { busy, error, run } = useSubmit();

  const load = () => run(async () => setUpdates(await unwrap(client.api.GET("/api/admin/system/updates"))));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the job's log until it ends, through the server restart.
  useEffect(() => {
    if (!jobId) return;
    let view: JobView = { phase: "running", lines: [], next: 0 };
    setJob(view);
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let result;
      try {
        result = await unwrap(client.api.GET("/api/admin/system/jobs/{id}", {
          params: { path: { id: jobId }, query: { after: view.next } },
        }));
      } catch {
        result = undefined;
      }
      if (!live) return;
      view = nextPoll(view, result);
      setJob(view);
      if (view.phase === "succeeded" || view.phase === "failed") {
        writeJobId(undefined);
        void load();
        return;
      }
      timer = setTimeout(() => void tick(), JOB_POLL_MS);
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  return (
    <>
      <ErrorText error={error} />
      {updates && (
        <UpdatesView
          updates={updates}
          busy={busy}
          job={job}
          onCheck={() => void run(async () => setUpdates(await unwrap(client.api.POST("/api/admin/system/updates/check"))))}
          onUpdateServer={() => void run(async () => {
            const { job_id } = await unwrap(client.api.POST("/api/admin/system/updates/server"));
            writeJobId(job_id);
            setJobId(job_id);
          })}
          onUpdateYtDlp={() => void run(async () => {
            const ytdlp = await unwrap(client.api.POST("/api/admin/system/updates/ytdlp"));
            setUpdates((u) => (u ? { ...u, ytdlp } : u));
          })}
        />
      )}
    </>
  );
}

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function UpdatesView({ updates, busy, job, onCheck, onUpdateServer, onUpdateYtDlp }: {
  updates: SystemUpdates;
  busy: boolean;
  job: JobView | undefined;
  onCheck: () => void;
  onUpdateServer: () => void;
  onUpdateYtDlp: () => void;
}) {
  const srv = updates.server;
  const st = srv.status;
  const y = updates.ytdlp;
  const ytNewer = !!y.latest && !!y.installed && y.latest !== y.installed;
  const jobRunning = job?.phase === "running" || job?.phase === "restarting";
  return (
    <>
      <div>
        <Button variant="outline" size="sm" disabled={busy || jobRunning} onClick={onCheck}>Check now</Button>
      </div>

      <Card className="gap-3 py-4" aria-labelledby="srv-h">
        <CardHeader className="px-4"><h3 id="srv-h" className="text-sm font-semibold">Server</h3></CardHeader>
        <CardContent className="grid gap-3 px-4">
          {!srv.configured ? (
            <p className="max-w-[68ch] text-muted-foreground">
              Updating from here needs the updater. Set <code>DATROPE_UPDATER_TOKEN</code> in <code>deploy/.env</code> and
              run <code>docker compose up -d</code> once (see <code>deploy/README.md</code>).
            </p>
          ) : srv.error ? (
            <p role="alert" className="text-destructive">The updater did not answer: {srv.error}</p>
          ) : st ? (
            <>
              <p>
                Running <code>{short(st.current)}</code>
                {st.behind > 0
                  ? <> · <strong>{plural(st.behind, "commit")} behind</strong> <code>{short(st.latest)}</code></>
                  : " · Up to date"}
                {st.checked_at && <span className="text-muted-foreground"> · checked {new Date(st.checked_at).toLocaleString()}</span>}
              </p>
              {st.error && <p role="alert" className="text-destructive">{st.error}</p>}
              {st.commits.length > 0 && (
                <ul className="grid max-h-64 gap-1 overflow-y-auto text-sm">
                  {st.commits.map((c) => (
                    <li key={c.sha} className="flex gap-2">
                      <code className="text-muted-foreground">{short(c.sha)}</code>
                      <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                      <span className="text-xs text-muted-foreground">{c.author} · {new Date(c.date).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
              )}
              {st.behind > 0 && !jobRunning && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <RefButton className="justify-self-start" disabled={busy}>Update server</RefButton>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Update the server?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Pulls {plural(st.behind, "commit")}, rebuilds and restarts everything. Building takes a few minutes;
                        everyone is disconnected for a moment at the end. If the pull or the build fails, nothing changes.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={onUpdateServer}>Update</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">Not checked yet.</p>
          )}
          {job && <JobLog job={job} />}
        </CardContent>
      </Card>

      <Card className="gap-3 py-4" aria-labelledby="yt-h">
        <CardHeader className="px-4"><h3 id="yt-h" className="text-sm font-semibold">yt-dlp</h3></CardHeader>
        <CardContent className="grid gap-3 px-4">
          {!y.available ? (
            <p className="text-muted-foreground">This server has no yt-dlp, so the music bot only plays uploaded tracks.</p>
          ) : (
            <p>
              Installed <code>{y.installed || "unknown"}</code>
              {y.latest && <> · latest <code>{y.latest}</code></>}
              {y.latest && !ytNewer && " · Up to date"}
            </p>
          )}
          {y.error && <p role="alert" className="text-destructive">{y.error}</p>}
          {y.pinned ? (
            <p className="text-muted-foreground">This binary is managed by DATROPE_YTDLP and is not updated here.</p>
          ) : ytNewer && (
            <Button className="justify-self-start" disabled={busy} onClick={onUpdateYtDlp}>Update yt-dlp</Button>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function JobLog({ job }: { job: JobView }) {
  const end = useRef<HTMLSpanElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [job.lines.length]);
  const label = { running: "Updating…", restarting: "Restarting…", succeeded: "Updated", failed: "Update failed" }[job.phase];
  const busy = job.phase === "running" || job.phase === "restarting";
  return (
    <div className="grid gap-2">
      <p role="status" className={job.phase === "failed" ? "text-destructive" : undefined}>
        {busy && <Spinner className="mr-2 inline size-4" />}
        {label}
      </p>
      <pre aria-label="Update log" className="max-h-80 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs">
        {job.lines.join("\n")}
        <span ref={end} />
      </pre>
    </div>
  );
}
```

`clients/web/src/app/server-settings/use-update-count.ts`:

```ts
import { unwrap } from "@datrope/core";
import { useEffect, useState } from "react";
import { updatesAvailable } from "@/lib/system";
import { client } from "@/session";

/** How many updates are waiting, for the settings nav badge (admins only; 0 otherwise). */
export function useUpdateCount(enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    unwrap(client.api.GET("/api/admin/system/updates"))
      .then((u) => { if (live) setN(updatesAvailable(u)); })
      .catch(() => {});
    return () => { live = false; };
  }, [enabled]);
  return n;
}
```

`ServerSettings.tsx`:
- add `RefreshCw` to the `lucide-react` import; import `{ Updates } from "./Updates"`, `{ useUpdateCount } from "./use-update-count"`, `{ Badge } from "@/components/ui/badge"`.
- after the `system` entry: `{ id: "updates", label: "Updates", group: "Instance", icon: RefreshCw, visible: admin, element: <Updates /> },`
- in the component, next to `const me = useApp((s) => s.me);`: `const updateCount = useUpdateCount(!!me?.is_admin);`
- in the nav `Link`, after `{body}`: `{s.id === "updates" && updateCount > 0 && <Badge className="ml-auto">{updateCount}</Badge>}`. The link's accessible name becomes "Updates 1"; e2e matches `/^Updates/`.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `cd clients/web && pnpm vitest run && pnpm typecheck`, then from the repo root `pnpm lint`
Expected: PASS

- [ ] **Step 5: Check in the browser**

As admin: Server settings → Updates shows the Server card ("needs the updater") and the yt-dlp card (installed version, or "no yt-dlp" on the Windows dev box). "Check now" works without errors in the console. Screenshot.

- [ ] **Step 6: Stage**

```bash
git -c safe.directory=* add clients/web/src/
```

---

### Task 13: End-to-end test and README

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts` (new test at the end)
- Modify: `README.md` (Features → "Server and integrations")

**Interfaces:**
- Consumes: nav links "System" and "Updates"; headings "Host", "Containers", "Server", "yt-dlp"; users `alice` (instance admin) and `bob` (member) created by the first test; helpers `signIn`, `openServerSettings` already in the file.

- [ ] **Step 1: Write the test**

```ts
// Runs after the first test: alice is the instance admin, bob a member.
test("the instance admin sees the system dashboard and updates", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  await openServerSettings(alice);
  await alice.getByRole("link", { name: "System" }).click();
  await expect(alice.getByRole("heading", { name: "Host" })).toBeVisible();
  await expect(alice.getByRole("heading", { name: "Containers" })).toBeVisible();
  await expect(alice.getByText("Uploaded files")).toBeVisible();
  // The e2e stack runs without the updater.
  await expect(alice.getByText("DATROPE_UPDATER_TOKEN").first()).toBeVisible();

  await alice.getByRole("link", { name: /^Updates/ }).click();
  await expect(alice.getByRole("heading", { name: "Server" })).toBeVisible();
  await expect(alice.getByRole("heading", { name: "yt-dlp" })).toBeVisible();

  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");
  await bob.goto("/server-settings/system");
  await expect(bob.getByRole("link", { name: "System" })).toHaveCount(0);
  await expect(bob.getByRole("heading", { name: "Host" })).toHaveCount(0);
});
```

- [ ] **Step 2: Run it**

Bring up the e2e stack the way the repo does (`deploy/docker-compose.e2e.yml`), then `cd clients/web && pnpm e2e`. If it cannot run on this machine, say so in the hand-off; do not claim it passed.
Expected: PASS

- [ ] **Step 3: README bullet**

In `README.md` → Features → "Server and integrations", add:

```markdown
- A system dashboard for the instance admin: CPU, memory, disk and container status, and one-click updates of the server and yt-dlp.
```

- [ ] **Step 4: Stage**

```bash
git -c safe.directory=* add clients/web/e2e/chat.spec.ts README.md
```

---

## Manual verification (the user, on the Linux host)

1. Set `DATROPE_UPDATER_TOKEN` in `deploy/.env`, run `docker compose up -d --build`.
2. Server settings → System: the container table shows CPU and memory; "Restart caddy" works.
3. On a checkout one commit behind `origin/main` (for example a test box after `git reset --hard HEAD~1`): Updates shows "1 commit behind"; "Update server" streams the log, survives the restart, ends with "Updated"; `ls -l` in the checkout shows the pulled files owned by the user, not root.
4. While music plays, press "Update yt-dlp" (shown when a newer release exists): playback continues, and the next YouTube link uses the new version (`/data/bin/yt-dlp --version` in the server container).