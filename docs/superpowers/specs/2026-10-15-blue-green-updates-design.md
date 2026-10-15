# Zero-downtime updates (blue/green server slots)

Date: 2026-10-15
Status: design approved in chat, awaiting spec review

## Goal

Updating Datrope from Server settings → Updates (or from a shell) must not take the chat down.
The old server keeps serving until the new one is built, migrated and healthy; then traffic
switches over at once. The admin watches a staged progress bar; every connected client then gets
a non-blocking "Datrope was updated — Reload" banner.

### Decisions made

- Single host, one docker compose stack (no Swarm/k8s).
- A brief WebSocket reconnect at switch time is acceptable.
- **Migrations follow expand/contract:** every migration must work with the previous release's
  code. A guard test enforces it. Updates are always zero-downtime; there is no stop-the-world
  fallback.
- **Progress:** the admin sees a staged progress bar. Other users see nothing until the switch,
  then a dismissible reload banner (web, PWA and desktop alike).
- **Approach:** blue/green server slots with an atomic Caddy reload; the web build moves out of
  the Caddy image into a shared volume. Rejected: `--scale server=2` (Docker DNS would split
  traffic between two servers that keep gateway state in memory) and build-ahead fast swap
  (still 5–10 s down).

### Today

`docker compose up -d` (run by the updater after `git pull` + `build`) recreates `server` and
`caddy` (the web build is baked into the Caddy image). All HTTP, WebSocket and TLS connections
drop, and nothing answers until the new server has migrated and passed its healthcheck.

## Non-goals

- Rolling back to the previous release after a successful switch.
- Handing in-memory state to the new server. Watch sessions, music-bot playback and gateway
  resume state are lost on a switch; clients re-IDENTIFY.
- Multi-host or more than one server serving traffic at a time.

## 1. Topology

### Compose (`deploy/docker-compose.yml`)

- `server` becomes `server-blue` and `server-green`, built from one YAML anchor (`x-server`).
  They differ only in `DATROPE_SLOT: blue|green`. Both mount the `switch` volume read-only at
  `/switch`. `restart: unless-stopped` means a slot the updater stopped stays stopped after a
  host or daemon restart.
- Both server images get the build arg `DATROPE_BUILD: ${DATROPE_BUILD:-dev}`.
- New named volume `switch` holding three files (see Caddyfile below):
  - `slot`: one line, `blue` or `green`, the slot that takes traffic and runs background jobs.
  - `upstream.caddy`: `reverse_proxy server-<slot>:8080`.
  - `root.caddy`: `root * /web/<build>`.
- New named volume `web`: one directory per web build, `/web/<build>`.
- New one-shot service `web` (image: a new `deploy/web.Dockerfile`, the Node build stage from
  today's `caddy.Dockerfile` plus a tiny alpine stage with the `dist` and a publish script). Build
  arg `DATROPE_BUILD`. On run it:
  1. copies `dist` to `/web/<build>.tmp`, then copies the hashed files of the newest existing
     build's `assets/` into it without overwriting (`cp -n`), so open tabs on the old build can
     still lazy-load their chunks; renames to `/web/<build>`;
  2. if `/switch/slot` does not exist (fresh install), writes the defaults: `slot` = `blue`,
     `upstream.caddy` for blue, `root.caddy` for `<build>`. The `web` service mounts `switch`
     read-write for this;
  3. deletes all but the 3 newest build directories, never the one `active` points at.
  `restart: "no"`.
- `caddy` uses the stock `caddy:2-alpine` image. `deploy/Caddyfile` is bind-mounted read-only;
  `switch` and `web` volumes are mounted read-only. `depends_on: web: service_completed_successfully`
  (instead of `server: service_healthy`; Caddy can start before a server is healthy and just
  returns 502 for `/api` until it is).
- `updater` additionally mounts `switch` read-write.
- `deploy/caddy.Dockerfile` is deleted.
- `deploy/docker-compose.e2e.yml` gets the matching changes.

### Caddyfile

The two places that change import snippets from the switch volume:

```
@backend path /api/* /ws /manifest.webmanifest
handle @backend {
	import /switch/upstream.caddy
}

handle {
	...
	import /switch/root.caddy
	try_files {path} /index.html
	file_server
}
```

The updater writes all three switch files; the `web` service writes them only on a fresh install.

### Standby gating

Each server reads `/switch/slot` once a second. While it does not name the server's own
`DATROPE_SLOT`, the server answers HTTP (including `/healthz`) but its background jobs are
paused: audit pruning, guest sweep, file sweep, integrations polling, voice sync/reconcile. (The
system sampler only reads host metrics and may run in both.) When the file switches to its slot it starts them;
the old slot pauses its jobs when the file switches away, before it receives SIGTERM.

Without `DATROPE_SLOT` (dev, tests, Playwright e2e) the server is always active, as today. If an
admin runs `docker compose up -d` and both slots start, the inactive one is an idle standby: no
traffic, no jobs.

## 2. Update flow (updater)

`UpdateSteps` becomes (one stage per step):

1. **Pull**: unchanged.
2. **Build**: `docker compose build` with `DATROPE_BUILD=<HEAD sha>` in the environment.
3. **Publish web**: `docker compose run --rm web`. Adds `/web/<sha>`; nothing switches yet.
4. **Start new slot**: idle = the slot not in `/switch/slot`.
   `docker compose up -d --no-deps server-<idle>`. The new server migrates; expand/contract keeps
   the old slot working on the new schema.
5. **Wait healthy**: poll the container's Docker health status and `/healthz` build until it
   reports `<sha>`, timeout 2 minutes. On failure or timeout: `docker compose stop server-<idle>`,
   fail the job. The old slot never stopped serving.
6. **Switch**: write `upstream.caddy`, `root.caddy`, then `slot`, each via temp file + rename,
   then `docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile`. If the reload
   fails, the three files are restored to their previous content and the job fails (the new slot
   is stopped). Reload is graceful for plain HTTP; proxied WebSockets are closed, and clients
   reconnect to the new slot.
7. **Retire old slot**: `docker compose stop server-<old>` (SIGTERM, 10 s graceful shutdown).
   Record the deployed commit (as today's `markDeployed`).
8. **Restart the updater** (`final` step): unchanged, via the detached helper.

Other services (`postgres`, `imgproxy`, `livekit`) get `docker compose up -d --no-deps <svc>`
between steps 3 and 4 only if their configuration changed: compose leaves unchanged containers
alone, so this is `up -d --no-deps postgres imgproxy livekit` and is normally a no-op.

Caddyfile edits in a release are picked up by the reload in step 6; Caddy is never recreated by
an update.

### Manual updates

`updater` gets a CLI subcommand: `docker compose exec updater /updater deploy` runs the same steps
in the foreground and prints the log. README "Updating" becomes `git pull` followed by that
command. A plain `docker compose up -d --build` still works, with today's downtime.

### Job progress

`UpdateJob` gains `stage` (1-based index of the running step), `stages` (total, counting
`final`) and `stage_title`. Exposed through the existing `/api/admin/system/jobs/{id}`.

## 3. Server

- **Build ID**: new package `server/internal/version` with `Build` set via
  `-ldflags -X` from the `DATROPE_BUILD` build arg, default `dev`. It is returned by `/healthz`
  (JSON `{"build": "..."}`, still 200) and in the gateway READY payload as `build`.
- **Slot watcher**: new package `server/internal/slot`. `Watch(ctx, path, mine string) <-chan bool`
  emits the current state, then each change; polls once a second; a missing/unreadable file means
  "inactive" when `mine` is set. `app` wires it to start/pause the background services. Each
  service gets whichever is less invasive: a restartable `Start`/`Stop`, or an active flag checked
  at the top of its tick.
- **Migration guard**: test in `server/internal/db` over `migrations/*.sql` with version > 42. In
  the `-- +goose Up` section (comments stripped) it fails on `DROP TABLE|COLUMN|CONSTRAINT|INDEX`
  (without `IF EXISTS` exemption), `RENAME`, `SET NOT NULL`, `ALTER COLUMN ... TYPE`, `DELETE`,
  `TRUNCATE`, unless the file contains a line `-- datrope:contract`. That line asserts the
  previous release no longer uses what it removes. The rule and the expand/contract recipe are in
  `server/internal/db/migrations/README.md`.

## 4. Clients

- **Admin progress bar** (`clients/web/src/app/server-settings/Updates.tsx`, `lib/system.ts`): a
  shadcn `Progress` with "Step 4 of 8 — Start new server" above the existing log, from
  `stage`/`stages`/`stage_title`. The `restarting` phase stays for the updater's own restart.
- **Reload banner** (all clients): the web bundle bakes `VITE_DATROPE_BUILD` (same SHA, `dev` by
  default). `@datrope/core`'s gateway client exposes the READY `build`. When the gateway's build
  differs from the bundle's and neither is `dev`, AppShell shows a non-blocking bar: "Datrope was
  updated." with a **Reload** button (`location.reload()`) and a dismiss button. Dismissed
  per server build, so it returns on the next update. On phones it renders in MobileShell next to
  where the Reconnecting pill goes. The desktop app's server webview runs the same web app, so
  it gets the same banner.

## 5. Testing

- Go unit tests: slot watcher (missing file, flip, unset slot); migration guard (fixture SQL that
  passes, fails, and passes with `datrope:contract`); updater steps with the fake `Cmd`
  (health fail stops the new slot and never switches; reload failure restores files; stage
  numbering; switch writes are atomic); snippet rendering; `web` publish script (merge, prune).
- Web unit tests: banner shown/hidden by build mismatch and `dev`; dismissal; progress label and
  percentage from stage/stages.
- Compose e2e, run locally: `deploy/e2e-bluegreen.sh` brings up the stack, runs a request loop
  through Caddy and holds a gateway WebSocket, runs `updater deploy` with a new `DATROPE_BUILD`,
  then asserts: no failed HTTP requests, the WebSocket closed and a new one got READY with the
  new build, the old slot is stopped, `/` serves the new web build and an old hashed asset still
  loads.
- Existing Go tests, web unit tests and Playwright e2e stay green.

## 6. Docs

`deploy/README.md`: rewrite "System dashboard and updates" and "Updating" to cover the two slots,
the switch volume, the manual `deploy` command, the expand/contract rule, and what a switch loses
(watch sessions, music playback, one reconnect).

## Risks and overlaps

- **watch-buffer-sync session** may change `server/internal/watch`; watch state is simply lost on
  a switch here, so no code overlap expected beyond documentation.
- Background-job audit: any job not listed in "Standby gating" that runs in two processes at once
  must be found during implementation and gated too.
- Upgrading an existing install to this layout itself has one ordinary downtime (the first
  `up -d` that introduces the slots); the release notes in the README say so.
