# System dashboard: metrics, server updates and yt-dlp updates

Date: 2026-10-11
Status: approved design, pending plan

## Goal

Give the instance admin one place in the web app to see how the machine is doing and to keep the
install up to date, without SSH and `docker compose` by hand:

- **Metrics.** Host CPU, RAM and disk, uptime, database and file storage size, per-container CPU/RAM
  and status, open websockets and people in voice calls. Live, with the last ~10 minutes as sparklines.
- **Server updates.** See how far the install is behind `origin/main` (commit list as changelog),
  then pull, rebuild and restart from the browser with a live build log. Restart single containers.
- **yt-dlp updates.** YouTube breaks yt-dlp often. See the installed vs latest version and update it
  in place in seconds, without a restart and without interrupting playing music.

Out of scope: metric history beyond ~10 minutes (nothing stored in Postgres), alerts or
notifications, rollback of a server update, tracking a branch other than `main`, automatic
installation of updates (checks are automatic, installing is always a click).

## Current state

- Install is `git clone` + `cd deploy && docker compose up -d --build` (`deploy/docker-compose.yml`:
  postgres, server, imgproxy, livekit, caddy). The server image builds from `server/Dockerfile`.
- The server runs as uid 65532 with no Docker socket. yt-dlp is baked into the image
  (`ADD .../yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp`) and found by
  `music.lookPath(cfg.YtDlp, "yt-dlp")` once, in `music.NewService`.
- Instance admin: `users.is_admin`; server endpoints guard with `auth.requireAdmin`
  (`server/internal/auth/admin.go`); web sections in the "Instance" group of
  `clients/web/src/app/server-settings/ServerSettings.tsx` use `visible: admin`.

## Decisions

### Security model

- Docker socket access equals root on the host. Only a new `updater` sidecar gets it. The Go server
  never does; the browser never talks to the updater.
- The updater publishes no ports and is reachable only on the compose network. Every request needs
  `Authorization: Bearer $DATROPE_UPDATER_TOKEN` (new `deploy/.env` variable, passed to both
  `server` and `updater`, compared in constant time).
- Without the token the updater refuses to start and the server runs the dashboard read-only:
  host metrics and yt-dlp work, container table and server update show "Updater not configured".
- Server-side, every `/api/admin/system/*` endpoint uses `requireAdmin`. Container restart takes a
  service name from a whitelist: the services in the compose project, read from container labels.

### Updater sidecar

- Go binary `server/cmd/updater` in the existing module, packages under `server/internal/updater`.
  Image `deploy/updater.Dockerfile`: alpine with `git`, `docker-cli`, `docker-cli-compose`.
- Compose service `updater`: `restart: unless-stopped`, mounts `/var/run/docker.sock`,
  the repo root (`..`) at `/repo`, and a named volume `updater` at `/state` (job logs).
- **Host paths.** Compose run inside the container would resolve `./livekit.yaml` and build contexts
  against `/repo/...`, but the Docker daemon reads bind-mount sources on the host. At startup the
  updater inspects its own container (Docker API, hostname = container ID), finds the host source
  of the `/repo` mount, creates a symlink at that same path pointing to `/repo`, and runs compose
  with `--project-directory <host path>/deploy` and `-p <project>` (project name from its own
  `com.docker.compose.project` label). Paths then match on both sides.
- **Git.** Runs as root in the container on a repo owned by the host user: set
  `safe.directory` for `/repo` and the host path. Checks: `git fetch origin main`, then
  `rev-list --count HEAD..origin/main` and `log --format=%H%x1f%s%x1f%an%x1f%cI HEAD..origin/main`
  (cap 100 commits). Daily check plus on demand; result cached in memory with `checked_at`.
- **Update job** (one at a time, 409 otherwise), steps stop at the first failure:
  1. `git pull --ff-only origin main`
  2. `docker compose build`
  3. `docker compose up -d <every service except updater>`
  4. mark the job `succeeded`, flush the log, then `docker compose up -d --no-deps updater`.
     The old updater process dies here; that is the last step on purpose.
  If step 1 or 2 fails, running containers are untouched.
- **Job log.** Lines (stdout+stderr of each step, plus step headers) appended to
  `/state/jobs/<id>.log`, status in `/state/jobs/<id>.json`. Only the latest 10 jobs are kept.
  A restarted updater reads them, so the result of a self-updating job survives. A job found
  `running` at startup is marked `failed` ("interrupted"); step 4 marks success before it runs,
  so a self-update is never reported as interrupted.
- **Container stats.** List containers of the project; one-shot `stats?stream=false` per running
  container for CPU % and memory; status and start time from inspect.
- **Restart** a service: `docker compose restart <service>`. Restarting `server` takes the dashboard
  down briefly; the UI handles it like an update.
- **API** (internal, token-guarded):
  `GET /status` (git state), `POST /check`, `POST /update` -> `{job_id}`,
  `GET /jobs/{id}?after=N` -> `{status, lines[], next}`, `GET /containers`,
  `POST /containers/{service}/restart`.

### Server: `server/internal/system`

- **Sampler.** Every 5 s, ring buffer of 120 samples (10 min), in memory only:
  - CPU %: delta of the `/proc/stat` aggregate line. RAM: `/proc/meminfo` (`MemTotal`,
    `MemAvailable`). Inside a container without lxcfs these are host values, which is what we want.
  - Disk: `statfs` on `DataDir` (the `files` volume lives on the host disk).
  - Host uptime from `/proc/uptime`; process uptime from start time.
  - Open websockets (gateway connection count) and people in voice (voice service), via small
    interfaces injected from `app`.
  - `/proc` is read through an injectable `fs.FS` so tests use fixtures.
- **Slow stats**, every 5 min: `pg_database_size(current_database())` and total size of
  `DataDir/files` (walk).
- **Updater client.** Thin HTTP client to `DATROPE_UPDATER_URL` (default `http://updater:8090`) with
  the token. Unset token -> no client, endpoints report `configured: false`.

### yt-dlp in place

- New path `DataDir/bin/yt-dlp`. The music service resolves yt-dlp through a small holder
  (`atomic.Pointer[string]`) instead of a fixed string: `DataDir/bin/yt-dlp` if present and
  executable, else the configured/`PATH` binary. Each yt-dlp call reads the current path, so a swap
  applies to the next call; running ones are untouched.
- `DATROPE_YTDLP` set explicitly disables in-place updates (the admin pinned a binary): the UI shows
  the version and "managed by DATROPE_YTDLP".
- Installed version: `yt-dlp --version`. Latest: GitHub API
  `repos/yt-dlp/yt-dlp/releases/latest` (`tag_name`). Daily check plus on demand.
- Update: download the `yt-dlp` asset and `SHA2-256SUMS` from that release, verify sha256, write to
  `DataDir/bin/yt-dlp.tmp` mode 0755, run `--version` on it, `rename` over `DataDir/bin/yt-dlp`,
  swap the holder. Any failure leaves the old binary in place.

### HTTP API (server, all `requireAdmin`)

| Endpoint | Result |
|---|---|
| `GET /api/admin/system/stats` | Latest sample, 10-min series, DB/files size, containers (empty + `configured:false` without updater) |
| `GET /api/admin/system/updates` | `server`: current/latest commit, behind count, commits, checked_at, configured. `ytdlp`: installed, latest, checked_at, managed |
| `POST /api/admin/system/updates/check` | Check both now |
| `POST /api/admin/system/updates/server` | Start update job -> `{job_id}`; 409 if one runs |
| `POST /api/admin/system/updates/ytdlp` | Update yt-dlp (synchronous, seconds) |
| `GET /api/admin/system/jobs/{id}?after=N` | Log lines after offset N, status |
| `POST /api/admin/system/containers/{service}/restart` | Restart one service |

Updater unreachable -> 503 "Updater unreachable" on the endpoints that need it; the rest still
works. The nav badge count comes from `GET /updates` (server behind > 0, yt-dlp latest != installed).

### Web

- Two new sections in the "Instance" group, `visible: admin`: **System** and **Updates**
  (`clients/web/src/app/server-settings/System.tsx`, `Updates.tsx`).
- **System:** `card` per CPU / RAM / Disk with `progress` and a small inline-SVG sparkline (no chart
  library). A row of figures: uptime, database size, files size, websockets, in voice. `table` of
  containers: name, status, CPU, RAM, uptime, "Restart" behind an `alert-dialog`. Polls
  `GET /stats` every 5 s while mounted.
- **Updates:** *Server* card: current -> latest commit, "N commits behind", commit list, "Check now",
  "Update" (`alert-dialog`), then a log panel (monospace, autoscroll) and status. *yt-dlp* card:
  installed / latest, "Update". Not-configured and managed states show a short explanation instead
  of buttons.
- **During an update** the UI polls `GET /jobs/{id}?after=N` every second. While the server is down
  it shows "Restarting..." and keeps polling; when it answers again it fetches the remaining log
  from the (possibly new) updater and shows "Updated to `<sha>`" or the failure.
- A count `badge` next to "Updates" in the settings nav when updates are available.
- Colours via existing tokens only; components from shadcn (`card`, `progress`, `table`,
  `alert-dialog`, `badge`, `spinner` are already in `src/components/ui`).

### Deploy and docs

- `deploy/docker-compose.yml`: `updater` service and `updater` volume; `server` gets
  `DATROPE_UPDATER_URL` and `DATROPE_UPDATER_TOKEN`.
- `deploy/.env.example`: `DATROPE_UPDATER_TOKEN` (e.g. `openssl rand -hex 32`), with a comment that
  the updater has root-equivalent access to the machine and that leaving it empty disables it.
- `deploy/README.md` / `README.md`: the dashboard, the updater and its security trade-off.
- `docker-compose.e2e.yml` does not get the updater.

## Testing

- **system:** sampler with `/proc` fixtures (CPU delta, meminfo, uptime); ring buffer size; stats
  endpoint returns 403 for non-admins, `configured:false` without updater, 503 when the updater is
  down.
- **yt-dlp:** against `httptest` GitHub fakes: version check, checksum match -> swap, mismatch ->
  old binary kept, failed `--version` on the new file -> old kept, `DATROPE_YTDLP` -> managed.
  Music resolver picks up a swapped path on the next call.
- **updater:** job runner with a fake command runner: step order, stop on first failure, updater
  last, log and status persisted, interrupted job marked failed on restart; git output parsing;
  token check; service whitelist; host-path discovery from a fake inspect response.
- **web:** vitest for System and Updates against mocked API (states: not configured, update
  available, running job, failed job); Playwright e2e: admin sees System and Updates, non-admin
  does not.
- **Manual:** a real update on a compose stack (path trick, self-update, reconnect) and a real
  yt-dlp update while music plays. These cannot be covered by automated tests.
