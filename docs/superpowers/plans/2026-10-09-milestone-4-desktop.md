# Milestone 4: Desktop App — Implementation Plan

> **Superseded** by `docs/superpowers/specs/2026-10-11-desktop-app-design.md` (multi-server, webview per server). Kept for history; do not execute.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri desktop app that wraps the web client, connects to any Datrope server the user names, keeps the session token in the OS keychain, shows native notifications for direct messages and mentions (respecting per-community and per-channel mutes stored on the server), and offers global push-to-talk.

**Architecture:** `clients/desktop` is a small Tauri 2 shell whose frontend is the built `clients/web` app; Rust adds three keychain commands plus the official notification and global-shortcut plugins. The web app gains a `platform.ts` module that hides the few desktop/browser differences (server address, bearer token instead of cookie, notifications, push-to-talk key binding). Because the desktop web view runs on its own origin, the server answers CORS requests from the Tauri origins (bearer tokens only, never cookies) and attachments are fetched with the token into blob URLs. A new `notifications` server package stores mutes so they follow the user across devices; the decision whether to notify is a pure function in `@datrope/core` that both the browser (Notification API) and the desktop app use.

**Tech Stack:** Tauri 2.11 (Rust, WebView2 on Windows) · `tauri-plugin-notification` 2.4 · `tauri-plugin-global-shortcut` 2.3 · `keyring` 3.6.3 · existing Go/Huma/pgx server · `@datrope/core` (Vitest) · React + shadcn/ui · Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-datrope-architecture-design.md` — §1 (clients), §2.3 (`clients/desktop/` Tauri shell around `clients/web`), §6 (desktop token in the OS keychain, sent as `Authorization: Bearer`), §8 (desktop: Tauri native notifications; mentions and DMs notify by default; users can mute communities or channels), §10 (desktop: manual testing in v1), §12 item 4. Milestones 1–3 plans in `docs/superpowers/plans/` describe the code this builds on.

## Global Constraints

- **Never commit.** (CLAUDE.md §5.) Each task ends with a *Checkpoint*: the controller stages the task with `git add` after review; nobody commits.
- Desktop and mobile store the session token in the **OS keychain** and send it as **`Authorization: Bearer`**; the web app keeps the `HttpOnly` cookie + CSRF header. The desktop app never uses the cookie.
- Desktop notifications are **Tauri native notifications**. **Mentions and DMs notify by default.** **Users can mute communities or channels.**
- `clients/desktop/` is a **Tauri shell around `clients/web`** — no second UI.
- Desktop testing in v1 is **manual** (spec §10); automated checks are Rust unit tests, `cargo clippy`, and the web/core checks. CI gains a desktop job (clippy + tests on Linux).
- Rust/Tauri versions (verified to exist; all ≥ 2 weeks old): crate `tauri` `~2.11` (2.11.6), `tauri-build` `~2.6`, `tauri-plugin-notification` `~2.4`, `tauri-plugin-global-shortcut` `~2.3`, `keyring` `3.6.3`; npm `@tauri-apps/cli` `2.11.5`, `@tauri-apps/api` `2.11.1`, `@tauri-apps/plugin-notification` `2.4.0`, `@tauri-apps/plugin-global-shortcut` `2.3.2`. Use `~` (tilde) requirements in Cargo so 2.12 / 3.0-alpha are never picked up; pin npm versions exactly.
- Web UI: **use shadcn/ui components before building your own**; add missing ones with the shadcn CLI from `clients/web` (on this exFAT drive the CLI's install step can fail after it has written the component file; the needed packages — `radix-ui`, `lucide-react` — are already installed, so check the file was written and that its imports resolve; fix a stray `cn` import to `@/lib/utils`). Style with the existing tokens only.
- Project conventions (still binding): Go `go 1.25.6`, `GOTOOLCHAIN=local`; Huma path params declared on input structs; nil slices initialised non-nil server-side and `?? []` client-side; packages talk through consumer-declared interfaces; Go DB tests via `apptest`/`pgtest`; Go tests run from PowerShell on Windows.
- Out of scope: Web Push (browser background push), mobile push relay, auto-update, installer signing, system tray, deep links (`datrope://`), notification click-to-navigate, per-user notification levels beyond on/off + mutes, `@everyone`/role mentions, server-side mention parsing.

## Decisions this plan makes (confirm with the user if any matter)

1. **Server address:** on first start the desktop app asks for the server address (e.g. `chat.example.com`, `https://` assumed), checks it answers `GET /api/instance`, and remembers it. "Change server" in settings signs out and asks again. One server at a time.
2. **Token storage:** the keychain entry is service `datrope`, account = the server address, so tokens for different servers never mix. Desktop sign-in/registration uses `client: "native"` (the server already returns a token for it).
3. **CORS:** the server lets `http://tauri.localhost`, `https://tauri.localhost` and `tauri://localhost` (the Tauri web view origins) read API responses, without credentials. Cookies therefore stay same-origin only; the desktop sends `credentials: "omit"`.
4. **Attachments on desktop:** images and downloads are fetched with the bearer token and shown/saved from blob URLs (an `<img>` or link cannot carry the token). Clicking an image downloads it instead of opening a new window.
5. **Mentions** are detected in the client: `@username` (case-insensitive, whole word) of the current user. A message notifies when it is not mine, not deleted, is in a DM or mentions me, its channel and community are not muted, and I am not looking at that channel in a focused window.
6. **Mutes** live on the server (`notification_mutes`), are listed in `READY`, change via `PUT`/`DELETE /api/notifications/mutes/{targetType}/{targetID}`, and are announced to the user's other sessions with `MUTE_UPDATE`. Muting needs nothing beyond seeing the community/channel; unmuting always works.
7. **Notifications on/off** is a per-device setting (desktop: on by default; browser: off until the user turns it on and grants permission). The browser uses the Notification API while the tab is open.
8. **Push-to-talk** is a per-device setting (voice activity by default). The key is captured from a key press (e.g. `F8`, `Backquote`, `Control+KeyM`). In the desktop app it is a **global** shortcut, registered only while connected to voice (so the key is not swallowed system-wide the rest of the time); in the browser it works while the tab is focused. While push-to-talk is on, the microphone is sent only while the key is held.
9. Desktop dev: `pnpm --filter @datrope/desktop dev` runs Vite and opens the app on `http://localhost:5173`; enter `http://localhost:5173` as the server (same origin through Vite's proxy, so no CORS is involved in development).

## File Structure

```
server/internal/httpx/cors.go (+ cors_test.go)       CORS for the desktop origins
server/internal/notifications/                       mutes: table owner, API, MUTE_UPDATE
  notifications.go, handlers.go, notifications_test.go
server/internal/db/migrations/00007_notifications.sql
server/internal/app/                                 CORS + notifications wiring, READY mutes, schemas
clients/core/src/                                    credentials by auth mode, mutes in store, notificationFor, client.setMute
clients/desktop/                                     Tauri shell: package.json, src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/,icons/,src/}
clients/web/src/platform.ts                          desktop/browser differences
clients/web/src/attachments.ts                       authed blob URLs + downloads
clients/web/src/pages/ServerPicker.tsx               choose a server (desktop)
clients/web/src/app/useNotifications.ts, usePushToTalk.ts
clients/web/src/app/settings/UserSettings.tsx        notifications, push-to-talk, change server
clients/web/src/voice/voice.ts                       push-to-talk in the engine
.github/workflows/ci.yml                             desktop job
```

---
### Task 1: CORS for the desktop app

**Files:**
- Create: `server/internal/httpx/cors.go`, `server/internal/httpx/cors_test.go`
- Modify: `server/internal/app/app.go` (middleware chain), `server/internal/app/app_test.go`

**Interfaces:**
- Produces: `httpx.DesktopOrigins []string`; `httpx.CORS(origins ...string) func(http.Handler) http.Handler`.

- [ ] **Step 1: Write the failing tests** — `server/internal/httpx/cors_test.go`

```go
package httpx_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/httpx"
)

func TestCORS(t *testing.T) {
	called := 0
	h := httpx.CORS(httpx.DesktopOrigins...)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		w.WriteHeader(http.StatusTeapot)
	}))
	do := func(method, origin string, preflight bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/api/users/@me", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if preflight {
			r.Header.Set("Access-Control-Request-Method", "PATCH")
			r.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	w := do(http.MethodGet, "http://tauri.localhost", false)
	require.Equal(t, http.StatusTeapot, w.Code)
	require.Equal(t, "http://tauri.localhost", w.Header().Get("Access-Control-Allow-Origin"))
	require.Empty(t, w.Header().Get("Access-Control-Allow-Credentials"), "cookies must never be readable cross-origin")
	require.Contains(t, w.Header().Values("Vary"), "Origin")

	w = do(http.MethodGet, "https://evil.example", false)
	require.Equal(t, http.StatusTeapot, w.Code)
	require.Empty(t, w.Header().Get("Access-Control-Allow-Origin"))
	require.Contains(t, w.Header().Values("Vary"), "Origin")

	before := called
	w = do(http.MethodOptions, "tauri://localhost", true)
	require.Equal(t, http.StatusNoContent, w.Code)
	require.Equal(t, before, called, "a preflight is answered without reaching the API")
	require.Equal(t, "tauri://localhost", w.Header().Get("Access-Control-Allow-Origin"))
	require.Contains(t, w.Header().Get("Access-Control-Allow-Methods"), "PATCH")
	require.Contains(t, w.Header().Get("Access-Control-Allow-Headers"), "Authorization")

	w = do(http.MethodOptions, "https://evil.example", true)
	require.Equal(t, http.StatusTeapot, w.Code, "other origins' preflights get no CORS answer")
}
```

In `server/internal/app/app_test.go` add:

```go
func TestDesktopCORS(t *testing.T) {
	env := apptest.New(t)
	req, err := http.NewRequest(http.MethodOptions, env.Server.URL+"/api/users/@me", nil)
	require.NoError(t, err)
	req.Header.Set("Origin", "http://tauri.localhost")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "authorization")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode, "the preflight is answered before authentication")
	require.Equal(t, "http://tauri.localhost", resp.Header.Get("Access-Control-Allow-Origin"))
}
```

- [ ] **Step 2: Run them to verify they fail**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server test ./internal/httpx/ ./internal/app/ -run 'CORS'`
Expected: FAIL to compile (`httpx.CORS` undefined).

- [ ] **Step 3: Write `server/internal/httpx/cors.go`**

```go
package httpx

import "net/http"

// DesktopOrigins are the origins of the desktop app's web view (Tauri on
// Windows, and on macOS/Linux). It authenticates with a bearer token.
var DesktopOrigins = []string{"http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"}

// CORS lets the given origins call the API. Credentials are never allowed,
// so the session cookie only ever works same-origin; cross-origin callers
// must send a bearer token.
func CORS(origins ...string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[o] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Add("Vary", "Origin")
			origin := r.Header.Get("Origin")
			if !allowed[origin] {
				next.ServeHTTP(w, r)
				return
			}
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Expose-Headers", "Content-Disposition, X-Request-ID")
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

- [ ] **Step 4: Wire it** — in `server/internal/app/app.go` change the handler chain to:

```go
	a.Handler = httpx.Chain(mux, httpx.RequestID, httpx.CORS(httpx.DesktopOrigins...), httpx.ClientIP(cfg.TrustProxy), httpx.Logger, httpx.Recover)
```

- [ ] **Step 5: Run the tests** — `go -C server test ./internal/httpx/ ./internal/app/` then `go -C server test -p 2 ./...` (PowerShell). Expected: PASS. `gofmt -l server` empty, `go -C server vet ./...` clean.

- [ ] **Step 6: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(server): CORS for the desktop app's origins (bearer only)`

---

### Task 2: Notification mutes

**Files:**
- Create: `server/internal/db/migrations/00007_notifications.sql`
- Create: `server/internal/notifications/notifications.go`, `server/internal/notifications/handlers.go`
- Test: `server/internal/notifications/notifications_test.go`
- Modify: `server/internal/app/app.go`, `server/internal/app/realtime.go`, `server/internal/app/app_test.go`

**Interfaces:**
- Consumes: `channels.Service.Access(ctx, userID, channelID, need) (*channels.Channel, perms.Perms, error)`; `communities.Service.PermMember(ctx, communityID, userID) (communities.PermMember, error)` with `communities.ErrNotMember`.
- Produces: `notifications.Mute{TargetType string ("community"|"channel"); TargetID id.ID}` (JSON `target_type`, `target_id`); `notifications.MuteUpdate{TargetType; TargetID; Muted bool}` (JSON adds `muted`); event `MUTE_UPDATE` (to the user only); operations `list-mutes` `GET /api/notifications/mutes` → `[]Mute`, `mute` `PUT /api/notifications/mutes/{targetType}/{targetID}` → 204, `unmute` `DELETE` same path → 204; `app.Ready.Mutes []notifications.Mute` (JSON `mutes`).

- [ ] **Step 1: Write the failing tests** — `server/internal/notifications/notifications_test.go`

```go
package notifications_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/notifications"
	"github.com/datrope/datrope/server/internal/perms"
)

func mutePath(targetType string, targetID id.ID) string {
	return "/api/notifications/mutes/" + targetType + "/" + targetID.String()
}

func TestMutes(t *testing.T) {
	env := apptest.New(t)
	alice, bob := env.Register("alice"), env.Register("bob")
	c := alice.CreateCommunity("Club")
	bob.JoinCommunity(alice, c.ID)
	general := bob.General(c.ID)
	ws, ready := bob.Connect()
	require.NotNil(t, ready.Mutes)
	require.Empty(t, ready.Mutes)

	bob.Do(http.MethodPut, mutePath("community", c.ID), nil, http.StatusNoContent, nil)
	var u notifications.MuteUpdate
	ws.ExpectDispatch("MUTE_UPDATE", &u)
	require.Equal(t, notifications.MuteUpdate{TargetType: "community", TargetID: c.ID, Muted: true}, u)
	bob.Do(http.MethodPut, mutePath("community", c.ID), nil, http.StatusNoContent, nil) // muting twice is fine
	bob.Do(http.MethodPut, mutePath("channel", general), nil, http.StatusNoContent, nil)

	var list []notifications.Mute
	bob.Do(http.MethodGet, "/api/notifications/mutes", nil, http.StatusOK, &list)
	require.ElementsMatch(t, []notifications.Mute{{TargetType: "community", TargetID: c.ID}, {TargetType: "channel", TargetID: general}}, list)
	_, ready = bob.Connect()
	require.Len(t, ready.Mutes, 2, "READY lists mutes")

	alice.Do(http.MethodGet, "/api/notifications/mutes", nil, http.StatusOK, &list)
	require.Empty(t, list, "mutes are per user")

	bob.Do(http.MethodDelete, mutePath("community", c.ID), nil, http.StatusNoContent, nil)
	for u = (notifications.MuteUpdate{}); u.Muted || u.TargetType != "community"; {
		ws.ExpectDispatch("MUTE_UPDATE", &u)
	}
	bob.Do(http.MethodGet, "/api/notifications/mutes", nil, http.StatusOK, &list)
	require.Equal(t, []notifications.Mute{{TargetType: "channel", TargetID: general}}, list)
}

func TestMutingNeedsAccess(t *testing.T) {
	env := apptest.New(t)
	alice, bob, eve := env.Register("alice"), env.Register("bob"), env.Register("eve")
	c := alice.CreateCommunity("Club")
	bob.JoinCommunity(alice, c.ID)
	general := alice.General(c.ID)

	eve.Fail(http.MethodPut, mutePath("community", c.ID), nil, http.StatusNotFound, "NOT_FOUND")
	eve.Fail(http.MethodPut, mutePath("channel", general), nil, http.StatusNotFound, "NOT_FOUND")
	eve.Fail(http.MethodPut, mutePath("channel", id.New()), nil, http.StatusNotFound, "NOT_FOUND")

	bob.Do(http.MethodPut, mutePath("channel", general), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPut, "/api/channels/"+general.String()+"/overrides/role/"+c.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)
	bob.Fail(http.MethodPut, mutePath("channel", general), nil, http.StatusNotFound, "NOT_FOUND")
	bob.Do(http.MethodDelete, mutePath("channel", general), nil, http.StatusNoContent, nil) // unmuting always works
}
```

In `server/internal/app/app_test.go`, add `"MuteUpdate"` and `"Mute"` to `TestOpenAPIHasEventSchemas`.

- [ ] **Step 2: Run them to verify they fail**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server test ./internal/notifications/ ./internal/app/`
Expected: FAIL to compile (package `notifications` and `Ready.Mutes` missing).

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00007_notifications.sql`

```sql
-- +goose Up
-- Owned by the notifications package. target_id is a community or channel ID;
-- rows for deleted targets are harmless and ignored by clients.
CREATE TABLE notification_mutes (
    user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('community', 'channel')),
    target_id   BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, target_type, target_id)
);

-- +goose Down
DROP TABLE notification_mutes;
```

- [ ] **Step 4: `server/internal/notifications/notifications.go`**

```go
// Package notifications stores what each user has muted (spec section 8:
// mentions and DMs notify by default; users can mute communities or
// channels). Clients decide whether a message notifies; the server only
// keeps the mutes so they follow the user across devices.
package notifications

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

const (
	TargetCommunity = "community"
	TargetChannel   = "channel"
)

type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
}

type Communities interface {
	PermMember(ctx context.Context, communityID, userID id.ID) (communities.PermMember, error)
}

type Mute struct {
	TargetType string `json:"target_type" enum:"community,channel"`
	TargetID   id.ID  `json:"target_id"`
}

// MuteUpdate tells a user's other sessions that a mute changed.
type MuteUpdate struct {
	TargetType string `json:"target_type" enum:"community,channel"`
	TargetID   id.ID  `json:"target_id"`
	Muted      bool   `json:"muted"`
}

type Service struct {
	db          *pgxpool.Pool
	bus         *events.Bus
	channels    Channels
	communities Communities
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, ch Channels, c Communities) *Service {
	return &Service{db: pool, bus: bus, channels: ch, communities: c}
}

// List returns a user's mutes.
func (s *Service) List(ctx context.Context, userID id.ID) ([]Mute, error) {
	rows, err := s.db.Query(ctx, `SELECT target_type, target_id FROM notification_mutes WHERE user_id = $1 ORDER BY target_type, target_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Mute{}
	for rows.Next() {
		var m Mute
		if err := rows.Scan(&m.TargetType, &m.TargetID); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Mute mutes a community the user belongs to or a channel they can see.
func (s *Service) Mute(ctx context.Context, userID id.ID, m Mute) error {
	if m.TargetType == TargetCommunity {
		_, err := s.communities.PermMember(ctx, m.TargetID, userID)
		if errors.Is(err, communities.ErrNotMember) {
			return httpx.NotFound("community")
		}
		if err != nil {
			return err
		}
	} else if _, _, err := s.channels.Access(ctx, userID, m.TargetID, perms.ViewChannel); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `
		INSERT INTO notification_mutes (user_id, target_type, target_id) VALUES ($1, $2, $3)
		ON CONFLICT DO NOTHING`, userID, m.TargetType, m.TargetID); err != nil {
		return err
	}
	s.publish(userID, m, true)
	return nil
}

// Unmute always succeeds, even for places the user can no longer see.
func (s *Service) Unmute(ctx context.Context, userID id.ID, m Mute) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM notification_mutes WHERE user_id = $1 AND target_type = $2 AND target_id = $3`,
		userID, m.TargetType, m.TargetID); err != nil {
		return err
	}
	s.publish(userID, m, false)
	return nil
}

func (s *Service) publish(userID id.ID, m Mute, muted bool) {
	s.bus.Publish(events.Event{Type: "MUTE_UPDATE", Data: MuteUpdate{TargetType: m.TargetType, TargetID: m.TargetID, Muted: muted},
		Scope: events.Scope{UserIDs: []id.ID{userID}}})
}
```

- [ ] **Step 5: `server/internal/notifications/handlers.go`**

```go
package notifications

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

func Register(api huma.API, s *Service) {
	tags := []string{"notifications"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	type target struct {
		TargetType string `path:"targetType" enum:"community,channel"`
		TargetID   string `path:"targetID"`
	}
	parse := func(in *target) (Mute, error) {
		tid, err := httpx.ParseID(in.TargetID, in.TargetType)
		return Mute{TargetType: in.TargetType, TargetID: tid}, err
	}

	huma.Register(api, op("list-mutes", http.MethodGet, "/api/notifications/mutes", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Mute }, error) {
			ms, err := s.List(ctx, auth.Current(ctx).User.ID)
			return &struct{ Body []Mute }{ms}, err
		})

	huma.Register(api, op("mute", http.MethodPut, "/api/notifications/mutes/{targetType}/{targetID}", http.StatusNoContent),
		func(ctx context.Context, in *target) (*struct{}, error) {
			m, err := parse(in)
			if err != nil {
				return nil, err
			}
			return nil, s.Mute(ctx, auth.Current(ctx).User.ID, m)
		})

	huma.Register(api, op("unmute", http.MethodDelete, "/api/notifications/mutes/{targetType}/{targetID}", http.StatusNoContent),
		func(ctx context.Context, in *target) (*struct{}, error) {
			m, err := parse(in)
			if err != nil {
				return nil, err
			}
			return nil, s.Unmute(ctx, auth.Current(ctx).User.ID, m)
		})
}
```

(`target` is a named type used as the whole input, not an embedded struct, so Huma fills its path fields.)

- [ ] **Step 6: Wire it** — in `server/internal/app/app.go`, import `notifications`, and after `channels.Register(api, chanSvc)`:

```go
	notifSvc := notifications.NewService(pool, a.Bus, chanSvc, commSvc)
	notifications.Register(api, notifSvc)
```

pass it to the READY builder (`readyBuilder{..., notifications: notifSvc}`). In `server/internal/app/realtime.go`: add `Mutes []notifications.Mute \`json:"mutes" doc:"Communities and channels the user muted"\`` to `Ready` (after `VoiceStates`), a `notifications *notifications.Service` field on `readyBuilder`, and in `Build`, before `return r, nil`:

```go
	if r.Mutes, err = b.notifications.List(ctx, u.ID); err != nil {
		return nil, err
	}
```

and add `notifications.Mute{}, notifications.MuteUpdate{}` to `registerEventSchemas`.

- [ ] **Step 7: Run the tests** — `go -C server test ./internal/notifications/ ./internal/app/ ./internal/gateway/` then `go -C server test -p 2 ./...` (PowerShell). Expected: PASS. gofmt/vet clean.

- [ ] **Step 8: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(server): per-user notification mutes for communities and channels`

---
### Task 3: Core — token auth without cookies, mutes, notification rules

**Files:**
- Modify (regenerate): `clients/core/openapi.json`, `clients/core/src/schema.d.ts`
- Modify: `clients/core/src/api.ts`, `clients/core/src/client.ts`, `clients/core/src/types.ts`, `clients/core/src/store.ts`, `clients/core/src/index.ts`
- Create: `clients/core/src/notify.ts`
- Test: `clients/core/src/notify.test.ts`, `clients/core/src/store.test.ts`, `clients/core/src/client.test.ts`

**Interfaces:**
- Consumes: Task 2's `GET/PUT/DELETE /api/notifications/mutes...`, `Ready.mutes`, event `MUTE_UPDATE`.
- Produces: `createApi` sends `credentials: "omit"` when `token` is given (else `"include"`), and `DatropeClient.upload` likewise; types `Mute`, `MuteUpdate`; `State.mutes: { community: Record<string, true>; channel: Record<string, true> }`; `isMuted(s: State, channelId: string): boolean` (the channel or its community muted); `DatropeClient.setMute(targetType: "community" | "channel", targetId: string, muted: boolean): Promise<void>`; `notificationFor(s: State, m: Message, view: { channelId?: string; focused: boolean }): Notice | null` with `interface Notice { title: string; body: string; channelId: string }`; `mentions(content: string, username: string): boolean`.

- [ ] **Step 1: Regenerate the API types** — `GOTOOLCHAIN=local pnpm --filter @datrope/core gen`. Expected: `Mute`, `MuteUpdate`, the three mute operations and `Ready.mutes` (typed `Mute[] | null`) appear in `schema.d.ts`.

- [ ] **Step 2: Write the failing tests**

`clients/core/src/notify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mentions, notificationFor } from "./notify";
import { applyEvent, applyReady, initialState, type State } from "./store";
import type { Message, Ready } from "./types";

const me = { id: "1", username: "alice", display_name: "Alice", is_admin: false, disabled: false, created_at: "2026-01-01T00:00:00Z" };
const bob = { id: "2", username: "bob", display_name: "Bob" };

const ready: Ready = {
  session_id: "s", user: me, presences: [], read_states: [], voice_states: [], mutes: [],
  communities: [{
    id: "100", name: "Friends", owner_id: "2", created_at: "2026-01-01T00:00:00Z",
    roles: [{ id: "100", community_id: "100", name: "@everyone", permissions: 1, position: 0 }],
    members: [],
    channels: [{ id: "300", community_id: "100", type: "text", name: "general", position: 0, overrides: [] }],
  }],
  dms: [{ id: "400", type: "dm", name: "", position: 0, overrides: [], participants: [{ id: "1", username: "alice", display_name: "Alice" }, bob] }],
};

function msg(channel: string, content: string, extra: Partial<Message> = {}): Message {
  return { id: "9", channel_id: channel, author: bob, content, created_at: "2026-01-01T00:00:00Z", deleted: false, attachments: [], ...extra };
}

const away = { focused: false };

describe("mentions", () => {
  it("matches @username as a whole word, any case", () => {
    expect(mentions("hi @alice!", "alice")).toBe(true);
    expect(mentions("@ALICE look", "alice")).toBe(true);
    expect(mentions("hi @alicea", "alice")).toBe(false);
    expect(mentions("mail alice@example.com", "alice")).toBe(false);
    expect(mentions("hi alice", "alice")).toBe(false);
    expect(mentions("hey @a.b", "a.b")).toBe(true); // usernames may contain . - _
  });
});

describe("notificationFor", () => {
  const s: State = applyReady(initialState, ready);

  it("notifies for DMs and mentions only", () => {
    expect(notificationFor(s, msg("400", "hello"), away)).toEqual({ title: "Bob", body: "hello", channelId: "400" });
    expect(notificationFor(s, msg("300", "hello everyone"), away)).toBeNull();
    expect(notificationFor(s, msg("300", "hey @alice"), away)).toEqual({ title: "Bob in #general (Friends)", body: "hey @alice", channelId: "300" });
  });

  it("stays quiet for my own, deleted, and currently viewed messages", () => {
    expect(notificationFor(s, msg("400", "x", { author: { id: "1", username: "alice", display_name: "Alice" } }), away)).toBeNull();
    expect(notificationFor(s, msg("400", "", { deleted: true }), away)).toBeNull();
    expect(notificationFor(s, msg("400", "x"), { channelId: "400", focused: true })).toBeNull();
    expect(notificationFor(s, msg("400", "x"), { channelId: "400", focused: false })).not.toBeNull(); // window in the background
  });

  it("respects channel and community mutes", () => {
    let m = applyEvent(s, "MUTE_UPDATE", { target_type: "channel", target_id: "400", muted: true });
    expect(notificationFor(m, msg("400", "x"), away)).toBeNull();
    m = applyEvent(s, "MUTE_UPDATE", { target_type: "community", target_id: "100", muted: true });
    expect(notificationFor(m, msg("300", "@alice"), away)).toBeNull();
    m = applyEvent(m, "MUTE_UPDATE", { target_type: "community", target_id: "100", muted: false });
    expect(notificationFor(m, msg("300", "@alice"), away)).not.toBeNull();
  });

  it("describes attachment-only messages and shortens long ones", () => {
    expect(notificationFor(s, msg("400", "", { attachments: [{ id: "1", channel_id: "400", filename: "a.png", content_type: "image/png", size: 1, inline: true, url: "/x" }] }), away)?.body)
      .toBe("Sent an attachment");
    expect(notificationFor(s, msg("400", "x".repeat(300)), away)?.body).toHaveLength(140);
  });
});
```

In `clients/core/src/store.test.ts`: add `voice_states: []` is already there — add `mutes: []` to the `ready` fixture, import `isMuted`, and add:

```ts
  it("tracks mutes from READY and MUTE_UPDATE", () => {
    let s = applyReady(initialState, { ...ready, mutes: [{ target_type: "community", target_id: "100" }] });
    expect(isMuted(s, "300")).toBe(true); // #general is in the muted community
    s = applyEvent(s, "MUTE_UPDATE", { target_type: "community", target_id: "100", muted: false });
    expect(isMuted(s, "300")).toBe(false);
    s = applyEvent(s, "MUTE_UPDATE", { target_type: "channel", target_id: "300", muted: true });
    expect(isMuted(s, "300")).toBe(true);
    expect(s.mutes.channel).toEqual({ "300": true });
  });
```

In `clients/core/src/client.test.ts`: add `mutes: []` to the `ready` fixture, and add:

```ts
it("mutes and unmutes", async () => {
  const calls: string[] = [];
  server.use(
    http.put(`${BASE}/api/notifications/mutes/:type/:id`, ({ params }) => {
      calls.push(`PUT ${params.type} ${params.id}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${BASE}/api/notifications/mutes/:type/:id`, ({ params }) => {
      calls.push(`DELETE ${params.type} ${params.id}`);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const client = readyClient();
  await client.setMute("community", "100", true);
  await client.setMute("channel", "300", false);
  expect(calls).toEqual(["PUT community 100", "DELETE channel 300"]);
});

it("never sends cookies when it has a token", async () => {
  const seen: RequestCredentials[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(input instanceof Request ? input.credentials : init?.credentials ?? "same-origin");
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const native = new DatropeClient({ baseUrl: BASE, wsUrl: "ws://unused", token: () => "t" });
    await native.api.GET("/api/users/@me");
    await native.upload("300", new Blob(["x"]), "x.txt");
    const web = new DatropeClient({ baseUrl: BASE, wsUrl: "ws://unused" });
    await web.api.GET("/api/users/@me");
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(seen).toEqual(["omit", "omit", "include"]);
});
```

(If openapi-fetch captured `fetch` at creation time, create the clients after replacing `globalThis.fetch`, as above.)

- [ ] **Step 3: Run them to verify they fail** — `pnpm --filter @datrope/core test`. Expected: FAIL (`./notify` missing, `isMuted`/`setMute` undefined, credentials `include`).

- [ ] **Step 4: Auth mode** — in `clients/core/src/api.ts`, `createApi`:

```ts
  // Token clients (desktop, mobile) never use the session cookie: cross-origin
  // servers do not allow credentials, and the cookie belongs to the browser app.
  const client = createClient<paths>({ baseUrl: opts.baseUrl, credentials: opts.token ? "omit" : "include" });
```

In `clients/core/src/client.ts`, `upload`: replace `credentials: "include"` with `credentials: this.o.token ? "omit" : "include"`.

- [ ] **Step 5: Types and store**

`types.ts`: add `export type Mute = Schemas["Mute"];` and `export type MuteUpdate = Schemas["MuteUpdate"];`, and `MUTE_UPDATE: MuteUpdate;` to `EventMap`.

`store.ts`: import `MuteUpdate`; add to `State` `mutes: { community: Record<string, true>; channel: Record<string, true> };` and to `initialState` `mutes: { community: {}, channel: {} },`. In `applyReady`, add:

```ts
    mutes: {
      community: Object.fromEntries((r.mutes ?? []).filter((m) => m.target_type === "community").map((m) => [m.target_id, true as const])),
      channel: Object.fromEntries((r.mutes ?? []).filter((m) => m.target_type === "channel").map((m) => [m.target_id, true as const])),
    },
```

In `applyEvent`, before `default:`:

```ts
    case "MUTE_UPDATE": {
      const u = data as MuteUpdate;
      const set = { ...s.mutes[u.target_type] };
      if (u.muted) set[u.target_id] = true;
      else delete set[u.target_id];
      return { ...s, mutes: { ...s.mutes, [u.target_type]: set } };
    }
```

and export after `voiceMembers`:

```ts
/** Whether a channel is muted, directly or through its community. */
export function isMuted(s: State, channelId: string): boolean {
  if (s.mutes.channel[channelId]) return true;
  const communityId = s.channels[channelId]?.community_id;
  return !!communityId && !!s.mutes.community[communityId];
}
```

- [ ] **Step 6: `clients/core/src/notify.ts`**

```ts
import { isMuted, type State } from "./store";
import type { Message, PublicUser } from "./types";

export interface Notice {
  title: string;
  body: string;
  channelId: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameOf = (u: Pick<PublicUser, "display_name" | "username">) => u.display_name || u.username;

/** Whether content mentions @username (case-insensitive, as a whole word). */
export function mentions(content: string, username: string): boolean {
  return new RegExp(`(^|[^\\w@.])@${escape(username)}(?![\\w.-])`, "i").test(content);
}

/**
 * Decides whether a new message deserves a notification (spec section 8):
 * DMs and mentions of me, unless muted, mine, deleted, or already on screen.
 */
export function notificationFor(s: State, m: Message, view: { channelId?: string; focused: boolean }): Notice | null {
  const me = s.me;
  if (!me || m.deleted || m.author.id === me.id) return null;
  if (view.focused && view.channelId === m.channel_id) return null;
  if (isMuted(s, m.channel_id)) return null;
  const ch = s.channels[m.channel_id];
  if (!ch) return null;
  if (ch.type !== "dm" && !mentions(m.content, me.username)) return null;
  const community = ch.community_id ? s.communities[ch.community_id]?.community.name : undefined;
  const title = ch.type === "dm" ? nameOf(m.author) : `${nameOf(m.author)} in #${ch.name}${community ? ` (${community})` : ""}`;
  const text = m.content.trim() || ((m.attachments ?? []).length > 0 ? "Sent an attachment" : "");
  return { title, body: text.length > 140 ? `${text.slice(0, 139)}…` : text, channelId: m.channel_id };
}
```

Export it from `index.ts` (`export * from "./notify";`).

- [ ] **Step 7: Client** — in `client.ts`, after `disconnectVoice`:

```ts
  /** Mutes or unmutes notifications from a community or channel. */
  async setMute(targetType: "community" | "channel", targetId: string, muted: boolean) {
    const params = { path: { targetType, targetID: targetId } };
    await unwrap(muted
      ? this.api.PUT("/api/notifications/mutes/{targetType}/{targetID}", { params })
      : this.api.DELETE("/api/notifications/mutes/{targetType}/{targetID}", { params }));
    this.apply("MUTE_UPDATE", { target_type: targetType, target_id: targetId, muted }); // before the event arrives
  }
```

- [ ] **Step 8: Run tests and checks** — `pnpm --filter @datrope/core test` (PASS), `pnpm typecheck` (fix any `Ready` fixtures elsewhere that now need `mutes`), `pnpm lint`.

- [ ] **Step 9: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(core): bearer clients omit cookies; mutes; notification rules`

---
### Task 4: Desktop shell (Tauri)

**Files:**
- Create: `clients/desktop/package.json`, `clients/desktop/README.md`
- Create: `clients/desktop/src-tauri/Cargo.toml`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`, `src/main.rs`, `src/lib.rs`, `icons/*` (generated), `Cargo.lock` (generated), `gen/schemas/*` (generated by the build; keep)
- Create: `clients/desktop/app-icon.png` (icon source)
- Modify: `.gitignore`, `.github/workflows/ci.yml`, `pnpm-lock.yaml`

**Interfaces:**
- Produces (Tauri commands, called from the web app in Task 5): `token_get({ instance: string }) → string | null`, `token_set({ instance: string, token: string }) → void`, `token_delete({ instance: string }) → void` (deleting a missing token is fine). Plugins available to the web view: notification (`notification:default`), global shortcuts (register/unregister/isRegistered). Window label `main`.

- [ ] **Step 1: Package** — `clients/desktop/package.json`:

```json
{
  "name": "@datrope/desktop",
  "private": true,
  "type": "module",
  "scripts": {
    "tauri": "tauri",
    "dev": "tauri dev",
    "build": "tauri build"
  },
  "devDependencies": {
    "@tauri-apps/cli": "2.11.5"
  }
}
```

Run `pnpm install` from the repo root (the workspace already includes `clients/*`). On this exFAT drive pnpm may fail at a symlink/bin-link step after resolving; check `pnpm-lock.yaml` gained `@tauri-apps/cli` and that `node_modules/@tauri-apps/cli` exists, and run the CLI as `pnpm --filter @datrope/desktop exec tauri --version` (or `node node_modules/@tauri-apps/cli/tauri.js --version` from the repo root if the bin link is missing). Record what worked.

- [ ] **Step 2: Rust crate** — `clients/desktop/src-tauri/Cargo.toml`:

```toml
[package]
name = "datrope-desktop"
version = "0.1.0"
description = "Datrope desktop app"
edition = "2021"

[lib]
name = "datrope_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "~2.6", features = [] }

[dependencies]
tauri = { version = "~2.11", features = [] }
tauri-plugin-notification = "~2.4"
tauri-plugin-global-shortcut = "~2.3"
keyring = { version = "3.6.3", features = ["apple-native", "windows-native", "sync-secret-service", "crypto-rust"] }
```

`clients/desktop/src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

`clients/desktop/src-tauri/src/main.rs`:

```rust
// No console window behind the app in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    datrope_desktop_lib::run()
}
```

- [ ] **Step 3: Write the failing test first** — create `clients/desktop/src-tauri/src/lib.rs` with only the test module and stub functions:

```rust
use keyring::Entry;

pub fn get(_entry: &Entry) -> keyring::Result<Option<String>> {
    unimplemented!()
}

pub fn set(_entry: &Entry, _token: &str) -> keyring::Result<()> {
    unimplemented!()
}

pub fn delete(_entry: &Entry) -> keyring::Result<()> {
    unimplemented!()
}

pub fn run() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_reads_and_forgets_a_token() {
        // The mock store keeps one credential per Entry value, so the test
        // reuses a single entry (real keychains are shared by name).
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let entry = Entry::new("datrope", "https://chat.example.com").unwrap();
        assert_eq!(get(&entry).unwrap(), None);
        set(&entry, "secret-token").unwrap();
        assert_eq!(get(&entry).unwrap().as_deref(), Some("secret-token"));
        delete(&entry).unwrap();
        assert_eq!(get(&entry).unwrap(), None);
        delete(&entry).unwrap(); // already gone is fine
    }
}
```

Build the web app first (the Tauri build embeds it): `pnpm --filter @datrope/web build`. Then run `cargo test --manifest-path clients/desktop/src-tauri/Cargo.toml`.
Expected: FAIL — the test panics at `unimplemented!()`. (The first build downloads and compiles Tauri; it takes several minutes. If `tauri_build::build()` complains about missing icons, do Step 6 first and rerun.)

- [ ] **Step 4: Write `clients/desktop/src-tauri/src/lib.rs`**

```rust
//! Datrope desktop: a Tauri shell around the web app (spec section 2.3).
//! The session token lives in the OS keychain (spec section 6); the web
//! app reads and writes it through the token_* commands.

use keyring::Entry;

const SERVICE: &str = "datrope";

/// The keychain entry for one server: tokens for different servers never mix.
fn entry(instance: &str) -> keyring::Result<Entry> {
    Entry::new(SERVICE, instance)
}

pub fn get(entry: &Entry) -> keyring::Result<Option<String>> {
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn set(entry: &Entry, token: &str) -> keyring::Result<()> {
    entry.set_password(token)
}

pub fn delete(entry: &Entry) -> keyring::Result<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn token_get(instance: String) -> Result<Option<String>, String> {
    entry(&instance).and_then(|e| get(&e)).map_err(|e| e.to_string())
}

#[tauri::command]
fn token_set(instance: String, token: String) -> Result<(), String> {
    entry(&instance).and_then(|e| set(&e, &token)).map_err(|e| e.to_string())
}

#[tauri::command]
fn token_delete(instance: String) -> Result<(), String> {
    entry(&instance).and_then(|e| delete(&e)).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![token_get, token_set, token_delete])
        .run(tauri::generate_context!())
        .expect("failed to start Datrope");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_reads_and_forgets_a_token() {
        // The mock store keeps one credential per Entry value, so the test
        // reuses a single entry (real keychains are shared by name).
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let entry = Entry::new("datrope", "https://chat.example.com").unwrap();
        assert_eq!(get(&entry).unwrap(), None);
        set(&entry, "secret-token").unwrap();
        assert_eq!(get(&entry).unwrap().as_deref(), Some("secret-token"));
        delete(&entry).unwrap();
        assert_eq!(get(&entry).unwrap(), None);
        delete(&entry).unwrap(); // already gone is fine
    }
}
```

- [ ] **Step 5: Tauri config** — `clients/desktop/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Datrope",
  "version": "0.1.0",
  "identifier": "org.datrope.desktop",
  "build": {
    "beforeDevCommand": "pnpm --filter @datrope/web dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "pnpm --filter @datrope/web build",
    "frontendDist": "../../web/dist"
  },
  "app": {
    "windows": [
      { "label": "main", "title": "Datrope", "width": 1200, "height": 800, "minWidth": 720, "minHeight": 480 }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost https: wss: http: ws:; img-src 'self' blob: data:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]
  }
}
```

The server address is chosen at run time, so `connect-src` allows any `https:`/`wss:` (and `http:`/`ws:` for servers on a LAN without TLS). Media from LiveKit uses `mediastream:`; attachments are shown from `blob:` URLs (Task 5).

`clients/desktop/src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "What the Datrope window may use",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "notification:default",
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister",
    "global-shortcut:allow-is-registered"
  ]
}
```

(App-defined commands such as `token_get` need no capability entry in Tauri 2.)

- [ ] **Step 6: Icons** — write a 1024×1024 PNG to `clients/desktop/app-icon.png`: the app's primary colour `#2ecc71` as a rounded square on a transparent background with a dark (`#131313`) letter-like mark (any simple shape is fine; generate it with a short Go program using `image/png` in a scratch directory outside the repo — do not add it to `server/`). Then generate the icon set: `pnpm --filter @datrope/desktop tauri icon app-icon.png` (run inside `clients/desktop`; it writes `src-tauri/icons/`). Keep only the files the config lists plus whatever the CLI writes for Windows Store/macOS (all generated files may stay).

- [ ] **Step 7: Run the tests and lints**

```bash
pnpm --filter @datrope/web build
cargo test --manifest-path clients/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path clients/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path clients/desktop/src-tauri/Cargo.toml --check
```

Expected: the test passes; clippy and fmt are clean. Then check the app builds and starts: `pnpm --filter @datrope/desktop tauri build --debug --no-bundle` (compiles the app with the built web UI). Start the produced executable (`clients/desktop/src-tauri/target/debug/datrope-desktop(.exe)`) by PID, check a window titled "Datrope" opens showing the web app, then stop it by that PID. If you cannot see windows, say so and rely on the build succeeding.

- [ ] **Step 8: Housekeeping**

`.gitignore`: add `clients/desktop/src-tauri/target/`.

`clients/desktop/README.md`:

````markdown
# Datrope desktop

A [Tauri](https://tauri.app) shell around the web client (`clients/web`). The session token is
kept in the operating system's keychain.

## Develop

Run a development server (see the repository README), then:

```bash
pnpm --filter @datrope/desktop dev
```

This starts Vite and opens the app on `http://localhost:5173`. When it asks for a server, enter
`http://localhost:5173` (Vite forwards API calls to your local server).

## Build

```bash
pnpm --filter @datrope/desktop build
```

Installers are written to `src-tauri/target/release/bundle/`. Building needs Rust and, on Linux,
the WebKitGTK development packages
(`libwebkit2gtk-4.1-dev libssl-dev libdbus-1-dev librsvg2-dev libxdo-dev`).
````

`.github/workflows/ci.yml` — add a job:

```yaml
  desktop:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libssl-dev libdbus-1-dev librsvg2-dev libxdo-dev
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @datrope/web build # the desktop build embeds the web app
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: clients/desktop/src-tauri
      - run: cargo fmt --manifest-path clients/desktop/src-tauri/Cargo.toml --check
      - run: cargo clippy --manifest-path clients/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
      - run: cargo test --manifest-path clients/desktop/src-tauri/Cargo.toml
```

- [ ] **Step 9: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(desktop): Tauri shell with keychain token storage, notifications and global shortcuts`

---
### Task 5: The web app in desktop mode

**Files:**
- Modify: `clients/web/package.json`, `pnpm-lock.yaml` (Tauri JS packages)
- Create: `clients/web/src/platform.ts`, `clients/web/src/attachments.ts`, `clients/web/src/pages/ServerPicker.tsx`
- Modify: `clients/web/src/session.ts`, `clients/web/src/main.tsx`, `clients/web/src/pages/Login.tsx`, `clients/web/src/pages/Register.tsx`, `clients/web/src/app/settings/UserSettings.tsx`, `clients/web/src/app/MessageList.tsx`, `clients/web/src/app/dialogs/InviteDialog.tsx`

**Interfaces:**
- Consumes: Task 4's commands `token_get/token_set/token_delete`; Task 3's `credentials` behaviour; Task 1's CORS.
- Produces (used by Tasks 6–7): `platform.ts` exports `isDesktop: boolean`, `instanceUrl(): string`, `setInstanceUrl(url: string | undefined): void`, `publicOrigin(): string`, `currentToken(): string | undefined`, `loadToken(): Promise<void>`, `saveToken(token: string): Promise<void>`, `forgetToken(): Promise<void>`, `invoke<T>(cmd, args): Promise<T>`; `attachments.ts` exports `useAuthedUrl(path: string): string | undefined`, `downloadAttachment(path: string, filename: string): Promise<void>`.

No web unit-test runner: verify with typecheck, build, lint, and a manual run in the desktop shell (Step 9).

- [ ] **Step 1: Dependencies** — `pnpm --filter @datrope/web add @tauri-apps/api@2.11.1 @tauri-apps/plugin-notification@2.4.0 @tauri-apps/plugin-global-shortcut@2.3.2` (pin exactly; if pnpm fails at the exFAT link step, add them to `clients/web/package.json` by hand as in milestone 3 and check `pnpm-lock.yaml` and `node_modules` have them). They are only imported dynamically, so the browser bundle loads them only inside the desktop app.

- [ ] **Step 2: `clients/web/src/platform.ts`**

```ts
/**
 * The few things that differ between the browser and the desktop app
 * (spec sections 2.3, 6 and 8). In the browser the app talks to its own
 * origin with the session cookie; in the desktop app it talks to the server
 * the user chose, with a bearer token kept in the OS keychain.
 */
export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const INSTANCE_KEY = "datrope.instance";

/** The server's origin, e.g. "https://chat.example.com"; "" in the browser (same origin). */
export function instanceUrl(): string {
  if (!isDesktop) return "";
  try {
    return localStorage.getItem(INSTANCE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setInstanceUrl(url: string | undefined) {
  if (url) localStorage.setItem(INSTANCE_KEY, url);
  else localStorage.removeItem(INSTANCE_KEY);
}

/** Where other people can reach this server (for invite links). */
export function publicOrigin(): string {
  return instanceUrl() || location.origin;
}

/** Calls a desktop command (only inside the desktop app). */
export async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

let token: string | undefined;

/** The desktop session token (undefined in the browser, which uses the cookie). */
export const currentToken = () => token;

/** Reads the token for the chosen server from the keychain; call before the app starts. */
export async function loadToken() {
  if (!isDesktop || !instanceUrl()) return;
  token = (await invoke<string | null>("token_get", { instance: instanceUrl() })) ?? undefined;
}

export async function saveToken(t: string) {
  token = t;
  await invoke("token_set", { instance: instanceUrl(), token: t });
}

export async function forgetToken() {
  token = undefined;
  if (isDesktop && instanceUrl()) await invoke("token_delete", { instance: instanceUrl() }).catch(() => undefined);
}
```

- [ ] **Step 3: Client setup** — in `clients/web/src/session.ts`, import `currentToken, forgetToken, instanceUrl, isDesktop` from `./platform` and replace the `wsUrl` constant and `client` construction with:

```ts
const base = instanceUrl();
const wsUrl = base
  ? `${base.replace(/^http/, "ws")}/ws`
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export const client = new DatropeClient({
  baseUrl: base,
  wsUrl,
  token: isDesktop ? currentToken : undefined,
  onSignedOut: () => {
    void forgetToken().finally(() => window.location.assign("/login"));
  },
});
```

and make `deviceName()` say where it runs:

```ts
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "desktop";
  if (isDesktop) return `Datrope for ${os}`;
  const browser = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} (web)`;
}
```

- [ ] **Step 4: Server picker** — `clients/web/src/pages/ServerPicker.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { setInstanceUrl } from "../platform";
import { AuthLayout } from "./AuthLayout";

/** "chat.example.com" -> "https://chat.example.com"; keeps an explicit http:// (LAN, development). */
export function normalizeServer(input: string): string | undefined {
  const raw = input.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Desktop only: asks which server to use, checks it is a Datrope server, then restarts the app. */
export function ServerPicker() {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <AuthLayout title="Connect to a server">
      <p className="text-muted-foreground">Enter the address of the Datrope server you use.</p>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const url = normalizeServer(address);
        if (!url) {
          setError("That is not a valid address.");
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          const res = await fetch(`${url}/api/instance`);
          const info = res.ok ? ((await res.json()) as { registration_mode?: string }) : undefined;
          if (!info?.registration_mode) throw new Error("not datrope");
          setInstanceUrl(url);
          window.location.assign("/login");
        } catch {
          setError("Could not reach a Datrope server at that address.");
          setBusy(false);
        }
      }}>
        <FormField label="Server address" placeholder="chat.example.com" value={address} onChange={(e) => setAddress(e.target.value)} required autoFocus />
        <ErrorText error={error} />
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Connecting…" : "Connect"}</Button>
      </form>
    </AuthLayout>
  );
}
```

(`registration_mode` is part of `InstanceInfo`; check the field name in `schema.d.ts`.)

- [ ] **Step 5: Start-up** — replace `clients/web/src/main.tsx` with:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServerPicker } from "./pages/ServerPicker";
import { instanceUrl, isDesktop, loadToken } from "./platform";
import { router } from "./router";
import "./styles.css";

async function start() {
  // The desktop app needs its token from the keychain before the first request.
  await loadToken().catch((e: unknown) => console.warn("datrope: could not read the saved session", e));
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider>
        {isDesktop && !instanceUrl() ? <ServerPicker /> : <RouterProvider router={router} />}
      </TooltipProvider>
    </StrictMode>,
  );
}

void start();
```

(Keep whatever `main.tsx` already wraps the app in — e.g. `TooltipProvider` — as it is.)

- [ ] **Step 6: Sign-in, registration, sign-out**

`pages/Login.tsx` — import `isDesktop, saveToken` from `../platform`; the submit becomes:

```tsx
          const res = await unwrap(client.api.POST("/api/auth/login", {
            body: { login, password, device_name: deviceName(), client: isDesktop ? "native" : "web" },
          }));
          if (isDesktop && res.token) await saveToken(res.token);
          nav(safeNext(params.get("next")), { replace: true });
```

`pages/Register.tsx` — the same pattern: `client: isDesktop ? "native" : "web"`, keep the result, and `if (isDesktop && res.token) await saveToken(res.token);` before `nav("/", { replace: true })`.

`app/settings/UserSettings.tsx` — import `forgetToken, instanceUrl, isDesktop, setInstanceUrl` from `../../platform`. In "Sign out of this device", after the logout request succeeds: `await forgetToken();` before `client.disconnect()`. When `isDesktop`, add below that button:

```tsx
          {isDesktop && (
            <p className="text-muted-foreground">
              Connected to {instanceUrl()}.{" "}
              <Button variant="link" className="h-auto p-0" onClick={async () => {
                await unwrap(client.api.POST("/api/auth/logout")).catch(() => undefined);
                await forgetToken();
                client.disconnect();
                setInstanceUrl(undefined);
                window.location.assign("/");
              }}>Change server</Button>
            </p>
          )}
```

`app/dialogs/InviteDialog.tsx` — build the link from `publicOrigin()` (import from `../../platform`) instead of `location.origin`.

- [ ] **Step 7: Attachments** — `clients/web/src/attachments.ts`:

```ts
import { useEffect, useState } from "react";
import { currentToken, isDesktop } from "./platform";
import { client } from "./session";

async function blobUrl(path: string): Promise<string> {
  const res = await fetch(client.url(path), { headers: { Authorization: `Bearer ${currentToken() ?? ""}` } });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

/**
 * A URL an <img> can load for an attachment path. The browser sends its
 * cookie; the desktop app must send its token, so it fetches the file and
 * uses a blob URL (released when the component goes away).
 */
export function useAuthedUrl(path: string): string | undefined {
  const [url, setUrl] = useState(() => (isDesktop ? undefined : client.url(path)));
  useEffect(() => {
    if (!isDesktop) return;
    let gone = false;
    let made: string | undefined;
    blobUrl(path).then((u) => {
      if (gone) URL.revokeObjectURL(u);
      else setUrl((made = u));
    }).catch(() => undefined);
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  return url;
}

/** Saves an attachment (desktop: links cannot carry the token). */
export async function downloadAttachment(path: string, filename: string) {
  const url = await blobUrl(path);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
```

In `app/MessageList.tsx`, replace the `Attachments` component's items with a per-attachment component so the hook can be used:

```tsx
function Attachments({ items }: { items: Attachment[] }) {
  if (items.length === 0) return null;
  return <div className="mt-1 flex flex-wrap gap-2">{items.map((a) => <AttachmentItem key={a.id} a={a} />)}</div>;
}

function AttachmentItem({ a }: { a: Attachment }) {
  const src = useAuthedUrl(showable(a) ? a.thumbnail_url || a.url : a.url);
  // Desktop: links cannot carry the token, so clicking downloads through a blob.
  const onClick = isDesktop ? (e: React.MouseEvent) => {
    e.preventDefault();
    void downloadAttachment(a.url, a.filename);
  } : undefined;
  if (showable(a)) {
    return (
      <a href={client.url(a.url)} target="_blank" rel="noopener noreferrer" onClick={onClick}>
        <img className="block h-auto max-w-full rounded-lg border bg-card" src={src} alt={a.filename} loading="lazy" {...fitBox(a.width, a.height)} />
      </a>
    );
  }
  return (
    <a className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-foreground no-underline" href={client.url(a.url)}
      download={a.filename} onClick={onClick}>
      <span aria-hidden="true">📎</span>
      <span>{a.filename}</span>
      <span className="text-muted-foreground">{formatBytes(a.size)}</span>
    </a>
  );
}
```

(Import `useAuthedUrl, downloadAttachment` from `../attachments` and `isDesktop` from `../platform`; use the existing React type import style in the file. For non-image files `src` is unused — call the hook unconditionally anyway, but skip fetching: pass the image path only when `showable(a)`; for files, make `useAuthedUrl` not fetch by giving it `""` and returning `undefined` for an empty path — add `if (!path) return;` at the top of its effect and `!path ? undefined :` in the initial state.)

- [ ] **Step 8: Verify** — `pnpm --filter @datrope/web typecheck`, `pnpm --filter @datrope/web build`, `pnpm lint`, `pnpm --filter @datrope/core test`. Expected: all pass. In a normal browser nothing changes (no desktop code runs).

- [ ] **Step 9: Manual desktop check** — with a local dev server running (the controller provides one: Go server on :8081 behind Vite on :5173), run `pnpm --filter @datrope/desktop dev`, enter `http://localhost:5173`, register or sign in, send a message with an image, see the image, download a file, sign out, sign in again (token survives an app restart: close and re-run, you stay signed in). Stop the processes you started by PID. If you cannot drive a desktop window, say so; the controller will check by hand.

- [ ] **Step 10: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(web): desktop mode — server picker, keychain token, bearer attachments`

---
### Task 6: Notifications and mutes in the UI

**Files:**
- Create (shadcn CLI): `clients/web/src/components/ui/switch.tsx`
- Modify: `clients/web/src/platform.ts` (notifications)
- Create: `clients/web/src/app/useNotifications.ts`, `clients/web/src/app/MuteToggle.tsx`
- Modify: `clients/web/src/app/AppShell.tsx`, `clients/web/src/app/ChannelSidebar.tsx`, `clients/web/src/app/ChannelView.tsx`, `clients/web/src/app/DMView.tsx`, `clients/web/src/app/settings/UserSettings.tsx`

**Interfaces:**
- Consumes: Task 3's `notificationFor`, `isMuted`, `State.mutes`, `client.setMute`, `client.onEvent`; Task 5's `isDesktop`.
- Produces: `platform.ts` adds `notificationsEnabled(): boolean`, `setNotificationsEnabled(on: boolean): Promise<boolean>` (asks permission when turning on; returns whether they are on), `showNotification(title: string, body: string): Promise<void>`. UI names (Task 8's e2e uses them): a toggle button **"Mute community"** (pressed when muted; tooltip "Unmute community"/"Mute community") in the community header; a toggle **"Mute channel"** in a text channel's or DM's header; a switch labelled **"Desktop notifications"** in Your settings.

- [ ] **Step 1: Add the shadcn switch** — from `clients/web`: `pnpm dlx shadcn@latest add switch` (see Global Constraints for the exFAT install quirk).

- [ ] **Step 2: Platform notifications** — append to `clients/web/src/platform.ts`:

```ts
const NOTIFY_KEY = "datrope.notifications";

/** Notifications are per device: on by default in the desktop app, off in the browser until turned on. */
export function notificationsEnabled(): boolean {
  let v: string | null = null;
  try {
    v = localStorage.getItem(NOTIFY_KEY);
  } catch {
    // storage unavailable: use the default
  }
  if (v === null) return isDesktop;
  return v === "on" && (isDesktop || ("Notification" in window && Notification.permission === "granted"));
}

/** Turns notifications on (asking the OS or browser for permission) or off; returns whether they are on. */
export async function setNotificationsEnabled(on: boolean): Promise<boolean> {
  let granted = on;
  if (on) {
    if (isDesktop) {
      const n = await import("@tauri-apps/plugin-notification");
      granted = (await n.isPermissionGranted()) || (await n.requestPermission()) === "granted";
    } else {
      granted = "Notification" in window && (await Notification.requestPermission()) === "granted";
    }
  }
  try {
    localStorage.setItem(NOTIFY_KEY, granted ? "on" : "off");
  } catch {
    // storage unavailable: the choice lasts for this session only
  }
  return granted;
}

export async function showNotification(title: string, body: string) {
  if (isDesktop) {
    const n = await import("@tauri-apps/plugin-notification");
    n.sendNotification({ title, body });
  } else if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, tag: "datrope" });
  }
}
```

- [ ] **Step 3: `clients/web/src/app/useNotifications.ts`**

```ts
import { notificationFor, type Message } from "@datrope/core";
import { useEffect, useRef } from "react";
import { useMatch } from "react-router-dom";
import { notificationsEnabled, showNotification } from "../platform";
import { client } from "../session";

/** Shows a notification for DMs and mentions that arrive while you are elsewhere (spec section 8). */
export function useNotifications() {
  const community = useMatch("/c/:communityId/:channelId")?.params.channelId;
  const dm = useMatch("/dm/:channelId")?.params.channelId;
  const viewing = useRef<string | undefined>(undefined);
  viewing.current = community ?? dm;

  useEffect(() => client.onEvent((type, data) => {
    if (type !== "MESSAGE_CREATE" || !notificationsEnabled()) return;
    const notice = notificationFor(client.store.getState(), data as Message, { channelId: viewing.current, focused: document.hasFocus() });
    if (notice) void showNotification(notice.title, notice.body).catch(() => undefined);
  }), []);
}
```

Call `useNotifications()` at the top of `AppShell` (it renders inside the router).

- [ ] **Step 4: Mute toggles**

Create `clients/web/src/app/MuteToggle.tsx`:

```tsx
import { Bell, BellOff } from "lucide-react";
import { useState } from "react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { client, errorText, useApp } from "../session";

/** Mutes notifications from a community or channel (stored on the server, so every device follows it). */
export function MuteToggle({ targetType, targetId }: { targetType: "community" | "channel"; targetId: string }) {
  const muted = useApp((s) => !!s.mutes[targetType][targetId]);
  const [error, setError] = useState<string>();
  const label = targetType === "community" ? "Mute community" : "Mute channel";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Toggle size="sm" aria-label={label} pressed={muted} className="text-muted-foreground"
            onPressedChange={(on) => client.setMute(targetType, targetId, on).then(() => setError(undefined), (e: unknown) => setError(errorText(e)))}>
            {muted ? <BellOff /> : <Bell />}
          </Toggle>
        </span>
      </TooltipTrigger>
      <TooltipContent>{error ?? (muted ? `Unmute ${targetType}` : label)}</TooltipContent>
    </Tooltip>
  );
}
```

Use it:
- `ChannelSidebar.tsx` header: add `<MuteToggle targetType="community" targetId={communityId} />` next to the settings link.
- `ChannelView.tsx` header (text channels and DMs): add `<MuteToggle targetType="channel" targetId={channelId} />` at the right of the header, next to the DM call button.
- Muted places look quiet: in `ChannelSidebar.tsx` give a channel link `opacity-60` and never the unread bold when `isMuted(state, id)`; in `DMView.tsx` the same for muted DMs (select `s.mutes` and use `isMuted` from `@datrope/core`; keep selectors stable — select `s.mutes`, compute in render).

- [ ] **Step 5: Settings** — in `app/settings/UserSettings.tsx`, add a card after the profile card:

```tsx
        <Card role="region" aria-label="Notifications" className="gap-3 p-4">
          <h3>Notifications</h3>
          <div className="flex items-center gap-3">
            <Switch id={notifyId} checked={notify} onCheckedChange={async (on) => setNotify(await setNotificationsEnabled(on))} />
            <Label htmlFor={notifyId}>Desktop notifications</Label>
          </div>
          <p className="text-sm text-muted-foreground">
            For direct messages and when someone writes @{me.username}. Mute a community or channel with its bell button.
            {!isDesktop && " In the browser, notifications only appear while Datrope is open in a tab."}
          </p>
        </Card>
```

with `const notifyId = useId();` and `const [notify, setNotify] = useState(notificationsEnabled);` among the hooks, and imports of `Switch`, `Label`, `notificationsEnabled`, `setNotificationsEnabled`, `isDesktop`.

- [ ] **Step 6: Verify** — `pnpm --filter @datrope/web typecheck`, `pnpm --filter @datrope/web build`, `pnpm lint`. Manual (if a dev stack is available; otherwise say so): in two browser profiles, turn notifications on for one, get a DM and an `@mention` from the other while that tab is in the background → notifications appear; mute the channel → no notification; mute state survives a reload.

- [ ] **Step 7: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(web): native notifications for DMs and mentions, mute toggles`

---

### Task 7: Push-to-talk

**Files:**
- Modify: `clients/web/src/voice/voice.ts`, `clients/web/src/platform.ts`
- Create: `clients/web/src/app/usePushToTalk.ts`
- Modify: `clients/web/src/app/AppShell.tsx`, `clients/web/src/app/voice/VoicePanel.tsx`, `clients/web/src/app/settings/UserSettings.tsx`

**Interfaces:**
- Consumes: Task 6/5 platform module; the voice engine from milestone 3 (`applyMic` decides whether the microphone is sent).
- Produces: `VoiceView` gains `pushToTalk: { enabled: boolean; key: string }` and `talking: boolean`; `voice.setPushToTalk(settings)` (persisted in `localStorage` key `datrope.voice.ptt`), `voice.setTalking(held: boolean)`; `platform.ts` adds `bindKey(key: string, onChange: (down: boolean) => void): Promise<() => void>` and `keyFromEvent(e: KeyboardEvent): string | undefined`. UI names: in Your settings a region **"Voice"** with radio options **"Voice activity"** and **"Push to talk"** and a button **"Change key"**.

- [ ] **Step 1: Engine** — in `clients/web/src/voice/voice.ts`:

Add to `VoiceView`:

```ts
  pushToTalk: { enabled: boolean; key: string }; // per device
  talking: boolean; // push-to-talk key held
```

Load the saved setting when creating the store (outside `idle`, so leaving a call keeps it):

```ts
const PTT_KEY = "datrope.voice.ptt";

function savedPushToTalk(): { enabled: boolean; key: string } {
  try {
    const v = JSON.parse(localStorage.getItem(PTT_KEY) ?? "null") as { enabled?: unknown; key?: unknown } | null;
    if (v && typeof v.key === "string") return { enabled: v.enabled === true, key: v.key };
  } catch {
    // unreadable: use the default
  }
  return { enabled: false, key: "F8" };
}
```

and initialise the store with `{ ...idle, muted: false, deafened: false, pushToTalk: savedPushToTalk(), talking: false }`; add `talking: false` to `idle`.

Add methods:

```ts
  /** Chooses voice activity or push-to-talk, and the key, for this device. */
  setPushToTalk(pushToTalk: { enabled: boolean; key: string }) {
    try {
      localStorage.setItem(PTT_KEY, JSON.stringify(pushToTalk));
    } catch {
      // storage unavailable: the choice lasts for this session only
    }
    this.set({ pushToTalk, talking: false });
    void this.applyMic();
  }

  /** The push-to-talk key went down or up. */
  setTalking(held: boolean) {
    if (this.store.getState().talking === held) return;
    this.set({ talking: held });
    void this.applyMic();
  }
```

In `applyMic`, include push-to-talk in the decision: the microphone is enabled only when `allowed && !muted && (!pushToTalk.enabled || talking)` (read `pushToTalk` and `talking` from the store next to `muted`).

- [ ] **Step 2: Key binding** — append to `clients/web/src/platform.ts`:

```ts
/**
 * A key as stored in settings: modifiers then KeyboardEvent.code, e.g.
 * "F8", "Backquote", "Control+KeyM" (also valid as a Tauri global shortcut).
 * Returns undefined for a lone modifier.
 */
export function keyFromEvent(e: KeyboardEvent): string | undefined {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return undefined;
  return [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super", e.code].filter(Boolean).join("+");
}

const editable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/**
 * Calls onChange(true) while the key is held and onChange(false) when it is
 * released. Desktop: a global shortcut (works while Datrope is in the
 * background). Browser: only while the tab is focused, and not while typing
 * a character into a text field.
 */
export async function bindKey(key: string, onChange: (down: boolean) => void): Promise<() => void> {
  if (isDesktop) {
    const gs = await import("@tauri-apps/plugin-global-shortcut");
    await gs.register(key, (e) => onChange(e.state === "Pressed"));
    return () => {
      void gs.unregister(key).catch(() => undefined);
    };
  }
  const down = (e: KeyboardEvent) => {
    if (e.repeat || keyFromEvent(e) !== key) return;
    if (editable(e.target) && e.key.length === 1) return; // typing, not talking
    onChange(true);
  };
  const up = (e: KeyboardEvent) => {
    if (e.code === key.split("+").at(-1)) onChange(false);
  };
  const blur = () => onChange(false);
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", blur);
  return () => {
    window.removeEventListener("keydown", down);
    window.removeEventListener("keyup", up);
    window.removeEventListener("blur", blur);
  };
}
```

- [ ] **Step 3: `clients/web/src/app/usePushToTalk.ts`**

```ts
import { useEffect } from "react";
import { bindKey } from "../platform";
import { useVoice, voice } from "../voice/voice";

/**
 * Binds the push-to-talk key while in a call with push-to-talk on. Binding
 * only during calls keeps a global shortcut from swallowing the key the
 * rest of the time.
 */
export function usePushToTalk() {
  const inCall = useVoice((v) => v.status !== "idle");
  const enabled = useVoice((v) => v.pushToTalk.enabled);
  const key = useVoice((v) => v.pushToTalk.key);
  useEffect(() => {
    if (!inCall || !enabled) return;
    let unbind: (() => void) | undefined;
    let cancelled = false;
    bindKey(key, (down) => voice.setTalking(down)).then((u) => {
      if (cancelled) u();
      else unbind = u;
    }).catch((e: unknown) => console.warn(`datrope: cannot use ${key} for push-to-talk`, e));
    return () => {
      cancelled = true;
      unbind?.();
      voice.setTalking(false);
    };
  }, [inCall, enabled, key]);
}
```

Call `usePushToTalk()` at the top of `AppShell`.

- [ ] **Step 4: Settings** — in `app/settings/UserSettings.tsx`, add a card after Notifications:

```tsx
        <Card role="region" aria-label="Voice" className="gap-3 p-4">
          <h3>Voice</h3>
          <RadioGroup value={ptt.enabled ? "ptt" : "vad"} className="grid gap-2"
            onValueChange={(v) => voice.setPushToTalk({ ...ptt, enabled: v === "ptt" })}>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="vad" id={`${voiceId}-vad`} />
              <Label htmlFor={`${voiceId}-vad`}>Voice activity</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="ptt" id={`${voiceId}-ptt`} />
              <Label htmlFor={`${voiceId}-ptt`}>Push to talk</Label>
            </div>
          </RadioGroup>
          <div className="flex items-center gap-3">
            <span>Key: <kbd className="rounded border bg-muted px-1.5 py-0.5 text-sm">{capturing ? "Press a key…" : ptt.key}</kbd></span>
            <Button variant="outline" size="sm" onClick={() => setCapturing(true)} onKeyDown={(e) => {
              if (!capturing) return;
              e.preventDefault();
              if (e.key === "Escape") return setCapturing(false);
              const key = keyFromEvent(e.nativeEvent);
              if (key) {
                voice.setPushToTalk({ ...ptt, key });
                setCapturing(false);
              }
            }}>Change key</Button>
          </div>
          {isDesktop && <p className="text-sm text-muted-foreground">While you are in a call, this key works even when Datrope is in the background, and other apps will not receive it.</p>}
        </Card>
```

with `const voiceId = useId();`, `const ptt = useVoice((v) => v.pushToTalk);`, `const [capturing, setCapturing] = useState(false);` among the hooks, and imports of `RadioGroup, RadioGroupItem`, `Label`, `keyFromEvent`, `voice`, `useVoice`.

- [ ] **Step 5: Panel hint** — in `VoicePanel.tsx`, when `pushToTalk.enabled`, show under the controls a line `Push to talk: <key>` that turns `text-online` while `talking` (select both from `useVoice` with primitives / the existing `useShallow` object).

- [ ] **Step 6: Verify** — `pnpm --filter @datrope/web typecheck`, `pnpm --filter @datrope/web build`, `pnpm lint`. Manual (dev stack + LiveKit; skip and say so if unavailable): turn on push to talk, join voice in the browser, hold the key → your speaking ring lights in the other profile; release → it stops. In the desktop app, the same works while another window has focus.

- [ ] **Step 7: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(web,desktop): push-to-talk (global in the desktop app)`

---

### Task 8: End-to-end check and docs

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts`, `deploy/README.md`

- [ ] **Step 1: Mute persists (e2e)** — in `clients/web/e2e/chat.spec.ts`, after the `admin.reload()` checks (before the voice step):

```ts
  // Mutes are stored on the server and come back after a reload.
  const muteCommunity = admin.getByRole("button", { name: "Mute community" });
  await expect(muteCommunity).toHaveAttribute("aria-pressed", "false");
  await muteCommunity.click();
  await expect(muteCommunity).toHaveAttribute("aria-pressed", "true");
  await admin.reload();
  await expect(admin.getByRole("button", { name: "Mute community" })).toHaveAttribute("aria-pressed", "true");
  await admin.getByRole("button", { name: "Mute community" }).click();
  await expect(admin.getByRole("button", { name: "Mute community" })).toHaveAttribute("aria-pressed", "false");
```

Run the e2e as in milestone 3 (`docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait`, `pnpm --filter @datrope/web e2e`, then `down -v`; only that project). Expected: `1 passed`.

- [ ] **Step 2: Docs** — in `deploy/README.md`, add a section after "Voice and video":

````markdown
## Desktop app

The desktop app (Windows, macOS, Linux) connects to any Datrope server: start it, enter your
server's address (e.g. `chat.example.com`), and sign in. It keeps your session in the operating
system's keychain, shows notifications for direct messages and mentions, and offers push-to-talk
that works while it is in the background. To build it from source see `clients/desktop/README.md`.
````

- [ ] **Step 3: Checkpoint** — stop; the controller reviews and stages. Suggested message: `test(e2e): mutes persist; docs: desktop app`

---

## Spec coverage (§1, §2.3, §6, §8, §10, §12 item 4)

| Spec requirement | Task |
|---|---|
| Desktop client built after web, as a Tauri shell around `clients/web` | 4, 5 |
| Desktop token in the OS keychain, sent as `Authorization: Bearer` | 4 (keychain commands), 5 (token mode), 3 (no cookies), 1 (CORS) |
| Desktop: Tauri native notifications | 4 (plugin), 6 |
| Mentions and DMs notify by default | 3 (`notificationFor`), 6 |
| Users can mute communities or channels | 2 (server), 3 (store), 6 (UI), 8 (e2e) |
| Global push-to-talk | 4 (plugin), 7 |
| Desktop testing manual in v1; CI builds and checks | 4 (Rust test, clippy, CI job), 5–7 (manual steps) |
