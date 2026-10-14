# PWA and Web Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web client an installable PWA with an offline shell, and have the Go server send Web Push notifications for new messages to devices whose user is not active.

**Architecture:** A new Go package `server/internal/push` owns subscriptions, VAPID keys (generated into the DB), the subscription endpoints, the PWA manifest endpoint, and a `MESSAGE_CREATE` bus subscriber that filters per subscription level and sends via `webpush-go` on a worker pool. The web client adds `vite-plugin-pwa` (`injectManifest`) with a custom `src/sw.ts` for precache + push + click, and `src/notify/push.ts` keeps the browser's push subscription in step with the existing per-device notification prefs.

**Tech Stack:** Go 1.25, pgx, huma v2, goose migrations, `github.com/SherClockHolmes/webpush-go`; React 18, Vite 5, `vite-plugin-pwa` 0.21, Workbox 7, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-pwa-web-push-design.md`

## Global Constraints

- **Never commit.** AGENTS.md: the user makes all commits. Each task ends with a review pause, not a commit.
- Prefix shell commands with `rtk` (user's global CLAUDE.md), e.g. `rtk go test ./...`, `rtk pnpm ...`.
- Go integration tests need Docker running (`pgtest`).
- Migration number: `00040_push.sql` (latest existing is `00039_albums.sql`).
- Levels: exactly `all`, `mentions`, `nothing`.
- Payload: `{title, body, url, tag}`, body cut at 120 characters, never the full message.
- Rate cap: at most one push per (subscription, channel) per 10 seconds.
- Fan-out queue size 1024, 4 workers; overflow drops the job and logs.
- Web Push options: TTL 24 h; urgency `high` for DMs and mentions, `normal` otherwise.
- 404 / 410 from the push service deletes the subscription; other errors are logged, never retried.
- Web client UI: shadcn + token classes only, dark-only, keep accessible names stable (`Desktop notifications` switch label, `Notify me about` radio group).
- Service worker is never registered inside the desktop app (`desktop !== null`) or in Vite dev.
- **Spec deviation (deliberate):** the service worker always shows a notification for a push. It does not skip when a window is focused, because Safari revokes subscriptions that receive pushes without a shown notification, and Chrome shows a generic one instead. The server's active-user check covers that case. Task 8 updates the spec.

## Review Focus

1. **Logout on a phone** → that phone stops getting pushes at once. Pinned by the cascade test in Task 1 and `signOut` unsubscribing in Task 7.
2. **Spoilers and markdown in previews** → a lock screen never shows spoiler text or raw markdown. Pinned by `TestBody` cases in Task 3.
3. **Same browser profile, second account** → an endpoint re-registered by another user moves to them; the first user no longer gets pushes there. Pinned by `TestSubscriptionMovesToNewUser` in Task 1.
4. **Thread and forum-post messages** → push opens the parent channel and is titled with the parent's name. Pinned by `TestPushThreadOpensParent` in Task 4.
5. **Busy channel at level `all`** → at most one push per 10 s per channel per device. Pinned by `TestRateCap` in Task 4.

---

## File map

**Server**
- Create `server/internal/db/migrations/00040_push.sql` — tables.
- Create `server/internal/push/push.go` — `Service`, `Options`, deps interfaces, VAPID keys, subscription store.
- Create `server/internal/push/handlers.go` — huma endpoints + manifest handler.
- Create `server/internal/push/text.go` — notification title/body/url (pure).
- Create `server/internal/push/fanout.go` — bus subscriber, worker pool, filtering, rate cap.
- Create `server/internal/push/sender.go` — `Sender` interface, `webpushSender`.
- Create tests `server/internal/push/text_test.go`, `push_test.go`, `fanout_test.go`.
- Modify `server/internal/gateway/gateway.go` — add `Active`.
- Modify `server/internal/gateway/gateway_test.go` — test `Active`.
- Modify `server/internal/app/app.go`, `server/internal/app/config.go` — wire service, `Push` option, `App.Push`.
- Modify `server/go.mod` / `go.sum` — `webpush-go`.

**Deploy**
- Modify `deploy/Caddyfile` — route manifest to backend; `sw.js` no-cache.
- Modify `deploy/README.md` — push notes.

**Web**
- Modify `clients/web/package.json`, `vite.config.ts`, `index.html`, `tsconfig.json` (if needed for SW types).
- Create `clients/web/public/icons/*.png` — generated once.
- Create `clients/web/src/sw.ts` — service worker.
- Create `clients/web/src/sw-register.ts` — registration.
- Create `clients/web/src/notify/push.ts` + `push.test.ts`.
- Create `clients/web/src/app/PushBridge.tsx` — sync prefs → push, SW navigate messages.
- Modify `clients/web/src/main.tsx`, `src/app/AppShell.tsx`, `src/app/settings/NotificationSettings.tsx`, `src/session.ts`, `src/app/NotificationListener.tsx`.
- Modify `clients/core/openapi.json`, `clients/core/src/schema.d.ts` — regenerated.
- Create `clients/web/e2e/pwa.spec.ts`.

---

### Task 1: Push service skeleton — migration, VAPID keys, subscription endpoints, wiring

**Files:**
- Create: `server/internal/db/migrations/00040_push.sql`
- Create: `server/internal/push/push.go`, `server/internal/push/handlers.go`, `server/internal/push/sender.go`
- Create: `server/internal/push/push_test.go`
- Modify: `server/internal/app/app.go`, `server/internal/app/config.go`, `server/go.mod`

**Interfaces:**
- Produces:
  - `push.Options{Sender Sender; Inline bool}` — `Sender` nil = real webpush; `Inline` handles fan-out synchronously in `Bus.Publish` (tests only).
  - `push.Subscription{ID id.ID; UserID id.ID; Endpoint, P256dh, Auth, Level string}`
  - `push.Sender` interface: `Send(ctx context.Context, sub Subscription, payload []byte, urgent bool) (status int, err error)`
  - `push.NewService(pool *pgxpool.Pool, bus *events.Bus, d Deps, o Options) *Service`
  - `push.Deps{Audience Audience; Channels Channels; Server ServerInfo; PublicURL string}`; presence set later via `(*Service).SetPresence(Presence)`.
  - `(*Service).PublicKey(ctx) (string, error)`; `(*Service).Start()`, `(*Service).Close()`.
  - `push.Register(api huma.API, s *Service)`; `(*Service).ManifestHandler() http.Handler`.
  - `app.Config.Push push.Options`; `app.App.Push *push.Service`.

- [ ] **Step 1: Add the dependency**

Run: `cd server && rtk go get github.com/SherClockHolmes/webpush-go@v1.4.0`
Expected: `go.mod` lists `github.com/SherClockHolmes/webpush-go v1.4.0`.

- [ ] **Step 2: Write the migration**

`server/internal/db/migrations/00040_push.sql`:

```sql
-- +goose Up
-- Web Push: one row per browser that asked for notifications. A subscription
-- belongs to the auth session that made it, so signing out stops pushes.
CREATE TABLE push_subscriptions (
    id           BIGINT PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    session_id   BIGINT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL UNIQUE,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    level        TEXT NOT NULL CHECK (level IN ('all', 'mentions', 'nothing')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- The instance's VAPID keypair, made on first use. Deleting it invalidates every subscription.
CREATE TABLE vapid_keys (
    id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    public_key  TEXT NOT NULL,
    private_key TEXT NOT NULL
);

-- +goose Down
DROP TABLE vapid_keys;
DROP TABLE push_subscriptions;
```

- [ ] **Step 3: Write the failing integration tests**

`server/internal/push/push_test.go`:

```go
package push_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
)

type key struct {
	PublicKey string `json:"public_key"`
}

func sub(endpoint, level string) map[string]any {
	return map[string]any{
		"endpoint": endpoint,
		"keys":     map[string]string{"p256dh": "BPk", "auth": "au"},
		"level":    level,
	}
}

func count(t *testing.T, env *apptest.Env, where string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, env.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_subscriptions WHERE "+where, args...).Scan(&n))
	return n
}

func TestPublicKeyIsStable(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var a, b key
	alice.Do(http.MethodGet, "/api/push/key", nil, http.StatusOK, &a)
	alice.Do(http.MethodGet, "/api/push/key", nil, http.StatusOK, &b)
	require.NotEmpty(t, a.PublicKey)
	require.Equal(t, a.PublicKey, b.PublicKey)
	env.Anon().Fail(http.MethodGet, "/api/push/key", nil, http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestPutAndDeleteSubscription(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPut, "/api/push/subscription", sub("https://push.example/a", "mentions"), http.StatusNoContent, nil)
	require.Equal(t, 1, count(t, env, "level = 'mentions'"))

	alice.Do(http.MethodPut, "/api/push/subscription", sub("https://push.example/a", "all"), http.StatusNoContent, nil)
	require.Equal(t, 1, count(t, env, "level = 'all'"), "same endpoint updates in place")

	alice.Fail(http.MethodPut, "/api/push/subscription", sub("https://push.example/a", "loud"), http.StatusUnprocessableEntity, "VALIDATION_FAILED")
	alice.Fail(http.MethodPut, "/api/push/subscription", sub("http://push.example/a", "all"), http.StatusBadRequest, "VALIDATION_FAILED")

	bob := env.Register("bob")
	bob.Do(http.MethodDelete, "/api/push/subscription", map[string]any{"endpoint": "https://push.example/a"}, http.StatusNoContent, nil)
	require.Equal(t, 1, count(t, env, "true"), "bob cannot delete alice's subscription")

	alice.Do(http.MethodDelete, "/api/push/subscription", map[string]any{"endpoint": "https://push.example/a"}, http.StatusNoContent, nil)
	require.Equal(t, 0, count(t, env, "true"))
}

func TestSubscriptionMovesToNewUser(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	alice.Do(http.MethodPut, "/api/push/subscription", sub("https://push.example/shared", "all"), http.StatusNoContent, nil)
	bob.Do(http.MethodPut, "/api/push/subscription", sub("https://push.example/shared", "all"), http.StatusNoContent, nil)
	require.Equal(t, 0, count(t, env, "user_id = $1", alice.User.ID))
	require.Equal(t, 1, count(t, env, "user_id = $1", bob.User.ID))
}

func TestLogoutDeletesSubscriptions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPut, "/api/push/subscription", sub("https://push.example/a", "all"), http.StatusNoContent, nil)
	alice.Do(http.MethodPost, "/api/auth/logout", nil, http.StatusNoContent, nil)
	require.Equal(t, 0, count(t, env, "true"))
}
```

Check the actual status code `/api/auth/logout` returns (`server/internal/auth/handlers.go`) and the unauthenticated error code (`grep -rn UNAUTH server/internal/httpx`); adjust the two literals if they differ.

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd server && rtk go test ./internal/push/...`
Expected: FAIL — 404 on `/api/push/key` (package has no non-test code yet; first create an empty `push.go` with `package push` if the compiler complains about no Go files).

- [ ] **Step 5: Write `sender.go`**

```go
package push

import (
	"context"
	"io"
	"net/http"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Sender delivers one encrypted push message. status is the push service's
// HTTP status (0 when the request never got a response).
type Sender interface {
	Send(ctx context.Context, sub Subscription, payload []byte, urgent bool) (status int, err error)
}

type webpushSender struct {
	keys       func(ctx context.Context) (vapidKeys, error)
	subscriber string // the instance's public URL, sent to push services as the VAPID contact
}

func (w webpushSender) Send(ctx context.Context, sub Subscription, payload []byte, urgent bool) (int, error) {
	k, err := w.keys(ctx)
	if err != nil {
		return 0, err
	}
	urgency := webpush.UrgencyNormal
	if urgent {
		urgency = webpush.UrgencyHigh
	}
	res, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys:     webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
	}, &webpush.Options{
		Subscriber:      w.subscriber,
		VAPIDPublicKey:  k.public,
		VAPIDPrivateKey: k.private,
		TTL:             int((24 * time.Hour).Seconds()),
		Urgency:         urgency,
	})
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	return res.StatusCode, nil
}

// gone reports whether the push service says the subscription no longer exists.
func gone(status int) bool { return status == http.StatusNotFound || status == http.StatusGone }
```

- [ ] **Step 6: Write `push.go`**

```go
// Package push sends Web Push notifications for new messages to browsers
// whose user is not active in Datrope right now (spec: PWA and Web Push).
package push

import (
	"context"
	"errors"
	"sync"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
)

// Audience turns an event scope into user IDs (the gateway's resolver).
type Audience interface {
	Resolve(ctx context.Context, s events.Scope) ([]id.ID, error)
}

// Presence says whether someone is using Datrope right now (the gateway).
type Presence interface {
	Active(userID id.ID) bool
}

type Channels interface {
	Get(ctx context.Context, channelID id.ID) (*channels.Channel, error)
}

// ServerInfo gives the manifest the community's name and icon.
type ServerInfo interface {
	Server(ctx context.Context) (*communities.Server, error)
}

type Deps struct {
	Audience  Audience
	Channels  Channels
	Server    ServerInfo
	PublicURL string
}

type Options struct {
	Sender Sender // nil: real Web Push
	Inline bool   // handle MESSAGE_CREATE inside Bus.Publish (tests)
}

type Subscription struct {
	ID       id.ID
	UserID   id.ID
	Endpoint string
	P256dh   string
	Auth     string
	Level    string
}

type vapidKeys struct{ public, private string }

type Service struct {
	db     *pgxpool.Pool
	d      Deps
	o      Options
	sender Sender

	presenceMu sync.RWMutex
	presence   Presence

	keyMu  sync.Mutex
	cached *vapidKeys

	fan *fanout // see fanout.go
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, d Deps, o Options) *Service {
	s := &Service{db: pool, d: d, o: o, sender: o.Sender}
	if s.sender == nil {
		s.sender = webpushSender{keys: s.keys, subscriber: d.PublicURL}
	}
	s.fan = newFanout(s)
	if bus != nil {
		bus.Subscribe(s.fan.onEvent)
	}
	return s
}

// SetPresence is called once the gateway exists (it is built after the services).
func (s *Service) SetPresence(p Presence) {
	s.presenceMu.Lock()
	defer s.presenceMu.Unlock()
	s.presence = p
}

func (s *Service) active(userID id.ID) bool {
	s.presenceMu.RLock()
	defer s.presenceMu.RUnlock()
	return s.presence != nil && s.presence.Active(userID)
}

func (s *Service) Start() { s.fan.start() }
func (s *Service) Close() { s.fan.close() }

// keys loads the VAPID keypair, making it on first use. Concurrent first calls
// on several servers agree through ON CONFLICT DO NOTHING plus a re-read.
func (s *Service) keys(ctx context.Context) (vapidKeys, error) {
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	if s.cached != nil {
		return *s.cached, nil
	}
	var k vapidKeys
	err := s.db.QueryRow(ctx, `SELECT public_key, private_key FROM vapid_keys`).Scan(&k.public, &k.private)
	if errors.Is(err, pgx.ErrNoRows) {
		priv, pub, gerr := webpush.GenerateVAPIDKeys()
		if gerr != nil {
			return k, gerr
		}
		if _, err = s.db.Exec(ctx, `INSERT INTO vapid_keys (public_key, private_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, pub, priv); err != nil {
			return k, err
		}
		err = s.db.QueryRow(ctx, `SELECT public_key, private_key FROM vapid_keys`).Scan(&k.public, &k.private)
	}
	if err != nil {
		return k, err
	}
	s.cached = &k
	return k, nil
}

func (s *Service) PublicKey(ctx context.Context) (string, error) {
	k, err := s.keys(ctx)
	return k.public, err
}

// save upserts a subscription by endpoint. An endpoint registered by another
// user moves to this one (the browser profile changed hands).
func (s *Service) save(ctx context.Context, userID, sessionID id.ID, endpoint, p256dh, auth, level string) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, level)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (endpoint) DO UPDATE SET
			user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id,
			p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, level = EXCLUDED.level`,
		id.New(), userID, sessionID, endpoint, p256dh, auth, level)
	return err
}

func (s *Service) remove(ctx context.Context, userID id.ID, endpoint string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, userID, endpoint)
	return err
}

func (s *Service) removeByID(ctx context.Context, subID id.ID) error {
	_, err := s.db.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1`, subID)
	return err
}

func (s *Service) touch(ctx context.Context, subID id.ID) error {
	_, err := s.db.Exec(ctx, `UPDATE push_subscriptions SET last_used_at = now() WHERE id = $1`, subID)
	return err
}

// subscriptionsOf lists the subscriptions of these users, skipping level 'nothing'.
func (s *Service) subscriptionsOf(ctx context.Context, userIDs []id.ID) ([]Subscription, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, user_id, endpoint, p256dh, auth, level FROM push_subscriptions
		WHERE user_id = ANY($1) AND level <> 'nothing'`, id.Int64s(userIDs))
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Subscription, error) {
		var x Subscription
		err := r.Scan(&x.ID, &x.UserID, &x.Endpoint, &x.P256dh, &x.Auth, &x.Level)
		return x, err
	})
}

// roleIDs lists the roles a user holds (one server per instance).
func (s *Service) roleIDs(ctx context.Context, userID id.ID) ([]id.ID, error) {
	rows, err := s.db.Query(ctx, `SELECT role_id FROM member_roles WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}
```

Check: `id.ID` scans from BIGINT (it does elsewhere, e.g. `audit.go`) and `id.Int64s` exists (used in `messages.go:320`). If `pgx.RowTo[id.ID]` does not compile, scan into `int64` and convert the way other packages do.

For now add a stub `fanout.go` so the package compiles (Task 4 replaces it):

```go
package push

import "github.com/datrope/datrope/server/internal/events"

type fanout struct{ s *Service }

func newFanout(s *Service) *fanout  { return &fanout{s: s} }
func (f *fanout) onEvent(events.Event) {}
func (f *fanout) start()               {}
func (f *fanout) close()               {}
```

- [ ] **Step 7: Write `handlers.go` (endpoints only; manifest comes in Task 5)**

```go
package push

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

type SubscriptionKeys struct {
	P256dh string `json:"p256dh" minLength:"1" maxLength:"200"`
	Auth   string `json:"auth" minLength:"1" maxLength:"100"`
}

type SubscriptionInput struct {
	Endpoint string           `json:"endpoint" minLength:"1" maxLength:"2000" doc:"The push service URL from PushSubscription.endpoint"`
	Keys     SubscriptionKeys `json:"keys"`
	Level    string           `json:"level" enum:"all,mentions,nothing" doc:"This device's notification level"`
}

type EndpointInput struct {
	Endpoint string `json:"endpoint" minLength:"1" maxLength:"2000"`
}

type PublicKey struct {
	PublicKey string `json:"public_key" doc:"VAPID application server key, base64url"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"push"}
	op := func(oid, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: oid, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}

	huma.Register(api, op("get-push-key", http.MethodGet, "/api/push/key", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body PublicKey }, error) {
			k, err := s.PublicKey(ctx)
			return &struct{ Body PublicKey }{PublicKey{k}}, err
		})

	huma.Register(api, op("put-push-subscription", http.MethodPut, "/api/push/subscription", http.StatusNoContent),
		func(ctx context.Context, in *struct{ Body SubscriptionInput }) (*struct{}, error) {
			if !strings.HasPrefix(in.Body.Endpoint, "https://") {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "endpoint must be an https URL")
			}
			p := auth.Current(ctx)
			return nil, s.save(ctx, p.User.ID, p.SessionID, in.Body.Endpoint, in.Body.Keys.P256dh, in.Body.Keys.Auth, in.Body.Level)
		})

	huma.Register(api, op("delete-push-subscription", http.MethodDelete, "/api/push/subscription", http.StatusNoContent),
		func(ctx context.Context, in *struct{ Body EndpointInput }) (*struct{}, error) {
			return nil, s.remove(ctx, auth.Current(ctx).User.ID, in.Body.Endpoint)
		})
}
```

- [ ] **Step 8: Wire into the app**

In `server/internal/app/config.go` add to `Config`:

```go
	Push push.Options // zero value = real Web Push; tests inject a fake sender
```

In `server/internal/app/app.go`: add `Push *push.Service // nil when built without a database` to `App`, import `push`, and after the albums block, before `registerEventSchemas(api)`:

```go
	pushSvc := push.NewService(pool, a.Bus, push.Deps{
		Audience: audience{communities: commSvc, channels: chanSvc}, Channels: chanSvc,
		Server: commSvc, PublicURL: cfg.PublicURL,
	}, cfg.Push)
	push.Register(api, pushSvc)
	if pool != nil { // nil only for `datrope openapi`
		pushSvc.Start()
		a.closers = append(a.closers, pushSvc.Close)
		a.Push = pushSvc
	}
```

After `commSvc.SetPresence(gw)` add `pushSvc.SetPresence(gw)`. (This will not compile until Task 2 adds `Gateway.Active`; do Task 2 first if executing in order matters, or temporarily leave that line out and add it in Task 2.)

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd server && rtk go test ./internal/push/... ./internal/app/...`
Expected: PASS.

- [ ] **Step 10: Review pause** — show the diff; the user commits.

---

### Task 2: `Gateway.Active`

**Files:**
- Modify: `server/internal/gateway/gateway.go` (next to `StatusOf`, ~line 165)
- Modify: `server/internal/gateway/gateway_test.go`
- Modify: `server/internal/app/app.go` (`pushSvc.SetPresence(gw)` if left out in Task 1)

**Interfaces:**
- Produces: `func (g *Gateway) Active(userID id.ID) bool` — true if any connected session's own status is `online` or `invisible`.

- [ ] **Step 1: Write the failing test** (append to `gateway_test.go`)

```go
func TestActive(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	gw := env.App.Gateway
	require.False(t, gw.Active(alice.User.ID), "no connection")

	ws, _ := alice.Connect()
	require.Eventually(t, func() bool { return gw.Active(alice.User.ID) }, 2*time.Second, 10*time.Millisecond)

	ws.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: "idle"})
	require.Eventually(t, func() bool { return !gw.Active(alice.User.ID) }, 2*time.Second, 10*time.Millisecond, "idle is not active")

	ws.Send(gateway.OpPresenceSet, gateway.PresenceSet{Status: "invisible"})
	require.Eventually(t, func() bool { return gw.Active(alice.User.ID) }, 2*time.Second, 10*time.Millisecond, "invisible is still using the app")

	ws.Close()
	require.Eventually(t, func() bool { return !gw.Active(alice.User.ID) }, 2*time.Second, 10*time.Millisecond, "a dropped connection is not active")
}
```

Add `"time"` to the imports if missing.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && rtk go test ./internal/gateway/ -run TestActive`
Expected: FAIL — `gw.Active undefined`.

- [ ] **Step 3: Implement**

```go
// Active reports whether the user is using Datrope right now: some open
// connection whose own status is online or invisible (idle is away).
func (g *Gateway) Active(userID id.ID) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	for s := range g.byUser[userID] {
		if s.conn != nil && (s.status == StatusOnline || s.status == StatusInvisible) {
			return true
		}
	}
	return false
}
```

Ensure `pushSvc.SetPresence(gw)` is in `app.go` after `commSvc.SetPresence(gw)`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && rtk go test ./internal/gateway/ ./internal/push/...`
Expected: PASS.

- [ ] **Step 5: Review pause.**

---

### Task 3: Notification text

**Files:**
- Create: `server/internal/push/text.go`
- Test: `server/internal/push/text_test.go`

**Interfaces:**
- Produces:
  - `type Payload struct { Title string `json:"title"`; Body string `json:"body"`; URL string `json:"url"`; Tag string `json:"tag"` }`
  - `func body(content string, attachments int) string`
  - `func title(author string, webhook bool, ch, parent *channels.Channel) string`
  - `func target(ch *channels.Channel) (url, tag string)`

These mirror `clients/web/src/notify/notify.ts` (`notificationAuthor`, `notificationTitle`, `notificationBody`) so a push reads like a live notification.

- [ ] **Step 1: Write the failing tests**

```go
package push

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
)

func TestBody(t *testing.T) {
	cases := map[string]struct {
		content string
		files   int
		want    string
	}{
		"plain":       {"see you at 8", 0, "see you at 8"},
		"spoiler":     {"the killer is ||the butler||", 0, "the killer is (spoiler)"},
		"link":        {"look [here](https://x.example)", 0, "look here"},
		"bold":        {"**big** and __under__ and ~~gone~~ and `code`", 0, "big and under and gone and code"},
		"italic":      {"so *very* nice", 0, "so very nice"},
		"heading":     {"# Title\n- item\n> quote", 0, "Title item quote"},
		"code block":  {"```go\nfmt.Println()\n```", 0, "fmt.Println()"},
		"one file":    {"", 1, "Sent a file"},
		"files":       {"  ", 3, "Sent 3 files"},
		"empty":       {"", 0, ""},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) { require.Equal(t, c.want, body(c.content, c.files)) })
	}
}

func TestBodyCutsAt120Runes(t *testing.T) {
	got := body(strings.Repeat("é", 200), 0)
	require.Equal(t, 120, len([]rune(got)))
	require.True(t, strings.HasSuffix(got, "…"))
}

func TestTitleAndTarget(t *testing.T) {
	parentID := id.ID(7)
	general := &channels.Channel{ID: 7, Type: "text", Name: "general"}
	thread := &channels.Channel{ID: 9, Type: "thread", Name: "plans", ParentChannelID: &parentID}
	dm := &channels.Channel{ID: 5, Type: "dm"}

	require.Equal(t, "alice in #general", title("alice", false, general, nil))
	require.Equal(t, "hook (webhook) in #general", title("hook", true, general, nil))
	require.Equal(t, "alice (direct message)", title("alice", false, dm, nil))
	require.Equal(t, "alice in #general", title("alice", false, thread, general), "threads use the parent's name")
	require.Equal(t, "alice in #plans", title("alice", false, thread, nil), "parent unknown: the thread's own name")

	u, tag := target(general)
	require.Equal(t, "/channels/7", u)
	require.Equal(t, "channel:7", tag)
	u, tag = target(dm)
	require.Equal(t, "/messages/5", u)
	require.Equal(t, "channel:5", tag)
	u, tag = target(thread)
	require.Equal(t, "/channels/7", u, "threads open their parent")
	require.Equal(t, "channel:9", tag)
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && rtk go test ./internal/push/ -run 'TestBody|TestTitle'`
Expected: FAIL — `undefined: body`.

- [ ] **Step 3: Implement `text.go`**

```go
package push

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/datrope/datrope/server/internal/channels"
)

// Payload is what the service worker receives (clients/web/src/sw.ts).
type Payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
}

const maxBody = 120

// Same steps as notificationBody in clients/web/src/notify/notify.ts. RE2 has no
// lookahead, so the italic rule keeps the trailing character as its own group.
var bodyRules = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`\|\|[\s\S]+?\|\|`), "(spoiler)"},
	{regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`), "$1"},
	{regexp.MustCompile("```[^\\n]*\\n?"), ""},
	{regexp.MustCompile("\\*\\*|__|~~|`"), ""},
	{regexp.MustCompile(`(?m)^\s*#{1,6}\s+`), ""},
	{regexp.MustCompile(`(?m)^\s*[-*+]\s+`), ""},
	{regexp.MustCompile(`(?m)^\s*>\s?`), ""},
	{regexp.MustCompile(`(^|[\s(])([*_])([^*_\n]+)[*_]($|[\s).,!?:;])`), "$1$3$4"},
	{regexp.MustCompile(`\s+`), " "},
}

// body is the message as plain text, cut to 120 characters. It never carries spoilers.
func body(content string, attachments int) string {
	text := content
	for _, r := range bodyRules {
		text = r.re.ReplaceAllString(text, r.with)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		switch attachments {
		case 0:
			return ""
		case 1:
			return "Sent a file"
		default:
			return fmt.Sprintf("Sent %d files", attachments)
		}
	}
	runes := []rune(text)
	if len(runes) <= maxBody {
		return text
	}
	return string(runes[:maxBody-1]) + "…"
}

// title names the author and where they wrote. parent is a thread's parent channel, if known.
func title(author string, webhook bool, ch, parent *channels.Channel) string {
	if webhook {
		author += " (webhook)"
	}
	if ch.Type == "dm" {
		return author + " (direct message)"
	}
	name := ch.Name
	if ch.ParentChannelID != nil && parent != nil && parent.Name != "" {
		name = parent.Name
	}
	if name == "" {
		return author + " in a thread"
	}
	return author + " in #" + name
}

// target is the in-app route a tap opens and the tag that collapses repeats.
func target(ch *channels.Channel) (url, tag string) {
	tag = "channel:" + ch.ID.String()
	switch {
	case ch.Type == "dm":
		return "/messages/" + ch.ID.String(), tag
	case ch.ParentChannelID != nil:
		return "/channels/" + ch.ParentChannelID.String(), tag
	default:
		return "/channels/" + ch.ID.String(), tag
	}
}
```

If `id.ID(7)` literal does not compile (non-integer underlying type), build IDs with whatever constructor `id` exposes (`grep -n "^func" server/internal/id/*.go`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && rtk go test ./internal/push/ -run 'TestBody|TestTitle'`
Expected: PASS.

- [ ] **Step 5: Review pause.**

---

### Task 4: Fan-out

**Files:**
- Replace: `server/internal/push/fanout.go`
- Test: `server/internal/push/fanout_test.go`

**Interfaces:**
- Consumes: `Service.subscriptionsOf`, `Service.roleIDs`, `Service.active`, `Service.removeByID`, `Service.touch`, `Service.sender`, `Deps.Audience`, `Deps.Channels` (Task 1); `Gateway.Active` (Task 2); `body`, `title`, `target`, `Payload` (Task 3).
- Produces: pushes for `MESSAGE_CREATE` events whose `Data` is `messages.Message` or `*messages.Message`.

- [ ] **Step 1: Write the failing tests**

`server/internal/push/fanout_test.go`:

```go
package push_test

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/push"
)

type sent struct {
	Endpoint string
	Payload  push.Payload
	Urgent   bool
}

type fakeSender struct {
	mu     sync.Mutex
	got    []sent
	status int // 0 → 201
}

func (f *fakeSender) Send(_ context.Context, sub push.Subscription, payload []byte, urgent bool) (int, error) {
	var p push.Payload
	if err := json.Unmarshal(payload, &p); err != nil {
		return 0, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, sent{sub.Endpoint, p, urgent})
	if f.status != 0 {
		return f.status, nil
	}
	return http.StatusCreated, nil
}

func (f *fakeSender) take() []sent {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.got
	f.got = nil
	return out
}

func newEnv(t *testing.T) (*apptest.Env, *fakeSender) {
	f := &fakeSender{}
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.Push = push.Options{Sender: f, Inline: true} })
	return env, f
}

func subscribe(c *apptest.Client, endpoint, level string) {
	c.Do(http.MethodPut, "/api/push/subscription", sub(endpoint, level), http.StatusNoContent, nil)
}

func TestLevels(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	dave := env.Register("dave")
	subscribe(bob, "https://push.example/bob", "all")
	subscribe(carol, "https://push.example/carol", "mentions")
	subscribe(dave, "https://push.example/dave", "nothing")
	general := alice.General()

	alice.Send(general, "plain hello")
	got := f.take()
	require.Len(t, got, 1)
	require.Equal(t, "https://push.example/bob", got[0].Endpoint)
	require.Equal(t, "alice in #general", got[0].Payload.Title)
	require.Equal(t, "plain hello", got[0].Payload.Body)
	require.False(t, got[0].Urgent)

	alice.Send(general, "hey @carol")
	got = f.take()
	require.ElementsMatch(t, []string{"https://push.example/carol"}, endpoints(got),
		"bob's 10 s cap on #general holds back the second push; carol is mentioned")
	require.True(t, got[0].Urgent)
}

func TestAuthorAndActiveAreSkipped(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(alice, "https://push.example/alice", "all")
	subscribe(bob, "https://push.example/bob", "all")

	ws, _ := bob.Connect()
	require.Eventually(t, func() bool { return env.App.Gateway.Active(bob.User.ID) }, 2*time.Second, 10*time.Millisecond)
	alice.Send(alice.General(), "hi")
	require.Empty(t, f.take(), "alice wrote it; bob is active")

	ws.Close()
	require.Eventually(t, func() bool { return !env.App.Gateway.Active(bob.User.ID) }, 2*time.Second, 10*time.Millisecond)
	alice.Send(alice.CreateTextChannel("other"), "hi again")
	require.Equal(t, []string{"https://push.example/bob"}, endpoints(f.take()))
}

func TestRoleAndEveryoneMentions(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "mentions")

	var role struct{ ID string }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Crew", "mentionable": true}, http.StatusCreated, &role)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+role.ID, nil, http.StatusNoContent, nil)

	alice.Send(alice.General(), "<@&"+role.ID+"> meeting")
	require.Len(t, f.take(), 1, "role mention")

	alice.Send(alice.CreateTextChannel("news"), "@everyone big news")
	require.Len(t, f.take(), 1, "@everyone from the owner")
}

func TestDMCountsAsMention(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "mentions")
	dm := alice.OpenDM(bob.User.ID)
	alice.Send(dm, "psst")
	got := f.take()
	require.Len(t, got, 1)
	require.Equal(t, "alice (direct message)", got[0].Payload.Title)
	require.Equal(t, "/messages/"+dm.String(), got[0].Payload.URL)
	require.True(t, got[0].Urgent)
}

func TestPushThreadOpensParent(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "all")
	general := alice.General()
	root := alice.Send(general, "start")
	f.take()
	thread := alice.CreateThread(general, root.ID, "plans")
	alice.Send(thread, "in the thread")
	got := f.take()
	require.Len(t, got, 1)
	require.Equal(t, "alice in #general", got[0].Payload.Title)
	require.Equal(t, "/channels/"+general.String(), got[0].Payload.URL)
}

func TestRateCap(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "all")
	general := alice.General()
	for i := 0; i < 5; i++ {
		alice.Send(general, "spam")
	}
	require.Len(t, f.take(), 1, "one push per channel per 10 s")
	alice.Send(alice.CreateTextChannel("other"), "elsewhere")
	require.Len(t, f.take(), 1, "the cap is per channel")
}

func TestGoneSubscriptionIsPruned(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "all")
	f.status = http.StatusGone
	alice.Send(alice.General(), "hi")
	require.Equal(t, 0, count(t, env, "true"))
}

func TestNoAccessNoPush(t *testing.T) {
	env, f := newEnv(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	subscribe(bob, "https://push.example/bob", "all")
	private := alice.CreatePrivateChannel("secret") // denies ViewChannel to @everyone
	alice.Send(private, "hidden")
	require.Empty(t, f.take())
}

func endpoints(s []sent) []string {
	out := make([]string, len(s))
	for i, x := range s {
		out[i] = x.Endpoint
	}
	return out
}
```

Helper check before running: `apptest.Client` has `Send`, `General`, `CreateTextChannel`, `Connect`. For `OpenDM`, `CreateThread`, `CreatePrivateChannel` and the role-mention syntax, look for existing helpers or test patterns (`grep -rn "func (c \*Client)" server/internal/apptest`, `grep -rn "dms\|threads\|overrides" server/internal/messages/*_test.go | head`, `server/internal/messages/mentions.go` for the role-mention token). Add any missing helper to `apptest.go` as a thin wrapper over the existing endpoint, matching the style of `CreateTextChannel`. Adjust the role body fields to what `/api/server/roles` accepts.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && rtk go test ./internal/push/ -run 'TestLevels|TestAuthor|TestRole|TestDM|TestPushThread|TestRateCap|TestGone|TestNoAccess'`
Expected: FAIL — no pushes sent (stub fan-out).

- [ ] **Step 3: Implement `fanout.go`**

```go
package push

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
)

const (
	queueSize = 1024
	workers   = 4
	capWindow = 10 * time.Second
	sendLimit = 15 * time.Second
)

type fanout struct {
	s     *Service
	queue chan *messages.Message
	done  chan struct{}
	stop  sync.Once
	wg    sync.WaitGroup

	capMu sync.Mutex
	last  map[capKey]time.Time
}

type capKey struct{ sub, channel id.ID }

func newFanout(s *Service) *fanout {
	return &fanout{s: s, queue: make(chan *messages.Message, queueSize), done: make(chan struct{}), last: map[capKey]time.Time{}}
}

func (f *fanout) start() {
	if f.s.o.Inline {
		return
	}
	for range workers {
		f.wg.Add(1)
		go func() {
			defer f.wg.Done()
			for {
				select {
				case m := <-f.queue:
					f.handle(context.Background(), m)
				case <-f.done:
					return
				}
			}
		}()
	}
}

func (f *fanout) close() {
	f.stop.Do(func() { close(f.done) })
	f.wg.Wait()
}

// onEvent runs inside Bus.Publish, so it only enqueues.
func (f *fanout) onEvent(e events.Event) {
	if e.Type != "MESSAGE_CREATE" {
		return
	}
	var m *messages.Message
	switch d := e.Data.(type) {
	case *messages.Message:
		m = d
	case messages.Message:
		m = &d
	default:
		return
	}
	if m.Kind != "" || m.Deleted { // "X left the group" is not worth a push
		return
	}
	if f.s.o.Inline {
		f.handle(context.Background(), m)
		return
	}
	select {
	case f.queue <- m:
	default:
		slog.Warn("push: queue full, dropping message", "message_id", m.ID)
	}
}

func (f *fanout) handle(ctx context.Context, m *messages.Message) {
	if err := f.deliver(ctx, m); err != nil {
		slog.Error("push: deliver", "message_id", m.ID, "err", err)
	}
}

func (f *fanout) deliver(ctx context.Context, m *messages.Message) error {
	s := f.s
	ch, err := s.d.Channels.Get(ctx, m.ChannelID)
	if err != nil {
		return err
	}
	users, err := s.d.Audience.Resolve(ctx, events.Scope{ChannelID: m.ChannelID})
	if err != nil {
		return err
	}
	var authorID id.ID
	if m.Author != nil {
		authorID = m.Author.ID
	}
	users = slices.DeleteFunc(users, func(u id.ID) bool { return u == authorID || s.active(u) })
	if len(users) == 0 {
		return nil
	}
	subs, err := s.subscriptionsOf(ctx, users)
	if err != nil || len(subs) == 0 {
		return err
	}

	var parent *channels.Channel
	if ch.ParentChannelID != nil {
		parent, _ = s.d.Channels.Get(ctx, *ch.ParentChannelID) // only for the title; a missing parent falls back to the thread's name
	}
	author, webhook := "Someone", false
	switch {
	case m.Webhook != nil:
		author, webhook = m.Webhook.Name, true
	case m.Author != nil && m.Author.DisplayName != "":
		author = m.Author.DisplayName
	case m.Author != nil:
		author = m.Author.Username
	}
	url, tag := target(ch)
	isDM := ch.Type == "dm"

	roles := map[id.ID][]id.ID{} // per recipient, loaded only when a role was pinged
	for _, sub := range subs {
		mentioned := isDM || m.MentionEveryone || slices.Contains(m.Mentions, sub.UserID)
		if !mentioned && len(m.MentionRoles) > 0 {
			r, ok := roles[sub.UserID]
			if !ok {
				if r, err = s.roleIDs(ctx, sub.UserID); err != nil {
					return err
				}
				roles[sub.UserID] = r
			}
			mentioned = slices.ContainsFunc(m.MentionRoles, func(x id.ID) bool { return slices.Contains(r, x) })
		}
		if sub.Level == "mentions" && !mentioned {
			continue
		}
		if !f.allow(sub.ID, m.ChannelID, time.Now()) {
			continue
		}
		payload, _ := json.Marshal(Payload{Title: title(author, webhook, ch, parent), Body: body(m.Content, len(m.Attachments)), URL: url, Tag: tag})
		f.send(ctx, sub, payload, mentioned)
	}
	return nil
}

// allow applies the per-subscription, per-channel cap.
func (f *fanout) allow(sub, channel id.ID, now time.Time) bool {
	f.capMu.Lock()
	defer f.capMu.Unlock()
	k := capKey{sub, channel}
	if t, ok := f.last[k]; ok && now.Sub(t) < capWindow {
		return false
	}
	f.last[k] = now
	if len(f.last) > 10_000 { // forget expired entries now and then
		for k, t := range f.last {
			if now.Sub(t) >= capWindow {
				delete(f.last, k)
			}
		}
	}
	return true
}

func (f *fanout) send(ctx context.Context, sub Subscription, payload []byte, urgent bool) {
	ctx, cancel := context.WithTimeout(ctx, sendLimit)
	defer cancel()
	status, err := f.s.sender.Send(ctx, sub, payload, urgent)
	switch {
	case err != nil:
		slog.Warn("push: send", "subscription", sub.ID, "err", err)
	case gone(status):
		if err := f.s.removeByID(ctx, sub.ID); err != nil {
			slog.Error("push: prune", "subscription", sub.ID, "err", err)
		}
	case status >= 300:
		slog.Warn("push: rejected", "subscription", sub.ID, "status", status)
	default:
		if err := f.s.touch(ctx, sub.ID); err != nil {
			slog.Warn("push: touch", "subscription", sub.ID, "err", err)
		}
	}
}
```

Notes for the implementer:
- `MentionRoles` already only contains roles the author was allowed to ping (`messages/mentions.go`), and `MentionEveryone` is only set with the MentionEveryone permission, so no extra permission check is needed here.
- `range workers` over an int needs Go ≥ 1.22 (module is 1.25).

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && rtk go test ./internal/push/...`
Expected: PASS.

- [ ] **Step 5: Full server suite**

Run: `cd server && rtk go test ./...`
Expected: PASS (other packages unaffected; `Inline` is false outside push tests so fan-out runs on workers).

- [ ] **Step 6: Review pause.**

---

### Task 5: Manifest endpoint and Caddy

**Files:**
- Modify: `server/internal/push/handlers.go`
- Modify: `server/internal/app/app.go`
- Modify: `deploy/Caddyfile`, `clients/web/vite.config.ts` (dev proxy)
- Test: `server/internal/push/push_test.go`

**Interfaces:**
- Consumes: `Deps.Server` (`communities.Service.Server`), static icons at `/icons/pwa-192x192.png`, `/icons/pwa-512x512.png`, `/icons/maskable-icon-512x512.png` (created in Task 6).
- Produces: `GET /manifest.webmanifest`, content type `application/manifest+json`, no auth.

- [ ] **Step 1: Write the failing test** (append to `push_test.go`)

```go
func TestManifest(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPatch, "/api/server", map[string]any{"name": "Lofoten Crew"}, http.StatusOK, nil)

	res, raw := env.Anon().Raw(http.MethodGet, "/manifest.webmanifest", nil, "", http.StatusOK)
	require.Equal(t, "application/manifest+json", res.Header.Get("Content-Type"))
	var m struct {
		Name, ShortName, StartURL, Display, Scope string
		Icons                                      []struct{ Src, Sizes, Purpose string }
	}
	require.NoError(t, json.Unmarshal(raw, &m))
	require.Equal(t, "Lofoten Crew", m.Name)
	require.Equal(t, "Lofoten Crew", m.ShortName)
	require.Equal(t, "/", m.StartURL)
	require.Equal(t, "standalone", m.Display)
	require.Equal(t, "/icons/pwa-192x192.png", m.Icons[0].Src)
}
```

Use the real JSON tags in the anonymous struct (`json:"short_name"`, `json:"start_url"`), and adjust the server-rename call to the actual update endpoint (`grep -rn "update-server" server/internal/communities`). Add `encoding/json` to imports.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && rtk go test ./internal/push/ -run TestManifest`
Expected: FAIL — 404.

- [ ] **Step 3: Implement** (append to `handlers.go`)

```go
type manifestIcon struct {
	Src     string `json:"src"`
	Sizes   string `json:"sizes"`
	Type    string `json:"type,omitempty"`
	Purpose string `json:"purpose,omitempty"`
}

type manifest struct {
	Name            string         `json:"name"`
	ShortName       string         `json:"short_name"`
	StartURL        string         `json:"start_url"`
	Scope           string         `json:"scope"`
	Display         string         `json:"display"`
	BackgroundColor string         `json:"background_color"`
	ThemeColor      string         `json:"theme_color"`
	Icons           []manifestIcon `json:"icons"`
}

// background is --background in clients/web/src/styles.css.
const background = "#131313"

// ManifestHandler serves the PWA manifest, named after this instance's server
// so two installed servers on one phone stay apart.
func (s *Service) ManifestHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := "Datrope"
		icons := []manifestIcon{
			{Src: "/icons/pwa-192x192.png", Sizes: "192x192", Type: "image/png"},
			{Src: "/icons/pwa-512x512.png", Sizes: "512x512", Type: "image/png"},
			{Src: "/icons/maskable-icon-512x512.png", Sizes: "512x512", Type: "image/png", Purpose: "maskable"},
		}
		if sv, err := s.d.Server.Server(r.Context()); err == nil && sv != nil {
			if sv.Name != "" {
				name = sv.Name
			}
			if sv.IconURL != nil {
				icons = append(icons, manifestIcon{Src: *sv.IconURL, Sizes: "any"})
			}
		}
		w.Header().Set("Content-Type", "application/manifest+json")
		w.Header().Set("Cache-Control", "no-cache")
		_ = json.NewEncoder(w).Encode(manifest{
			Name: name, ShortName: name, StartURL: "/", Scope: "/", Display: "standalone",
			BackgroundColor: background, ThemeColor: background, Icons: icons,
		})
	})
}
```

Add `encoding/json` to the imports. In `app.go`, inside the `if pool != nil` block for push: `mux.Handle("GET /manifest.webmanifest", pushSvc.ManifestHandler())`.

- [ ] **Step 4: Route it in Caddy and Vite**

`deploy/Caddyfile`: change the matcher to

```
	@backend path /api/* /ws /manifest.webmanifest
```

and inside the final `handle { ... }` before `root * /srv` add

```
		# The service worker must be re-checked on every launch so updates arrive.
		@sw path /sw.js
		header @sw Cache-Control "no-cache"
```

`clients/web/vite.config.ts` `server.proxy`: add `"/manifest.webmanifest": \`http://${server}\`,`.

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && rtk go test ./internal/push/`
Expected: PASS.

- [ ] **Step 6: Review pause.**

---

### Task 6: PWA shell — icons, index.html, service worker precache, registration

**Files:**
- Modify: `clients/web/package.json`, `clients/web/vite.config.ts`, `clients/web/index.html`, `clients/web/src/main.tsx`
- Create: `clients/web/public/icons/{pwa-64x64,pwa-192x192,pwa-512x512,maskable-icon-512x512,apple-touch-icon-180x180}.png`
- Create: `clients/web/src/sw.ts`, `clients/web/src/sw-register.ts`
- Test: `clients/web/e2e/pwa.spec.ts`

**Interfaces:**
- Produces: `/sw.js` built from `src/sw.ts`; `registerServiceWorker(): void` in `sw-register.ts`. Task 7 adds push/click handlers to `src/sw.ts`.

- [ ] **Step 1: Add dependencies**

From `clients/web`: `rtk pnpm add -D vite-plugin-pwa@0.21.1 workbox-precaching@7.3.0 workbox-routing@7.3.0 workbox-core@7.3.0`
Expected: added to `devDependencies`.

- [ ] **Step 2: Generate icons once**

From `clients/web`: `rtk pnpm dlx @vite-pwa/assets-generator@0.2.6 --preset minimal-2023 src/assets/datrope-logo.svg`
Then move the generated `pwa-64x64.png`, `pwa-192x192.png`, `pwa-512x512.png`, `maskable-icon-512x512.png`, `apple-touch-icon-180x180.png` from `src/assets/` into `public/icons/`, and delete the generated `favicon.ico` if one appears (the app keeps its SVG favicon). Look at the maskable icon: the logo should sit inside the safe zone on the `#131313` background; if the generator used white, re-run with `--preset` options or a small `pwa-assets.config.ts` setting `maskable.resizeOptions.background: "#131313"` and `apple.resizeOptions.background: "#131313"`.

- [ ] **Step 3: Write the failing e2e test**

`clients/web/e2e/pwa.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("manifest is linked and names the server", async ({ page, request }) => {
  await page.goto("/login");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.display).toBe("standalone");
  expect(m.icons.length).toBeGreaterThanOrEqual(3);
});

test("the app shell opens offline once installed", async ({ page, context }) => {
  await page.goto("/login");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload(); // now controlled by the service worker
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: /sign in|log in/i })).toBeVisible();
  await context.setOffline(false);
});
```

Check the login page's heading text in `src/pages/Login.tsx` and match it.

- [ ] **Step 4: Run to verify it fails**

The e2e suite runs against the Docker stack (`playwright.config.ts` baseURL `https://localhost`). Rebuild it with the current code (see `deploy/README.md` / `docker-compose.e2e.yml`), then from `clients/web`: `rtk playwright test e2e/pwa.spec.ts`
Expected: FAIL — no manifest link.

- [ ] **Step 5: Configure the plugin**

`clients/web/vite.config.ts`:

```ts
import { VitePWA } from "vite-plugin-pwa";
// ...
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false, // src/sw-register.ts registers it, and not inside the desktop app
      manifest: false, // the server serves /manifest.webmanifest, named after the instance
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,woff2,mp3,ogg,wasm}"], maximumFileSizeToCacheInBytes: 8 * 1024 * 1024 },
      devOptions: { enabled: false },
    }),
  ],
```

Adjust `globPatterns` to the file types actually in `dist/` after a build (`ls dist/assets`). Skip any single file over the limit rather than raising it further.

- [ ] **Step 6: Write `src/sw.ts`**

```ts
/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope;

// The build's files. A new worker waits until every window is closed, so an open
// page never loses the chunks it was built with ("updates on next launch").
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Every in-app route opens the cached app shell, so the installed app starts offline.
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"), {
  denylist: [/^\/api\//, /^\/ws/, /^\/livekit\//, /^\/manifest\.webmanifest$/],
}));
```

If `tsc` complains about `ServiceWorkerGlobalScope` / `__WB_MANIFEST`, add `"WebWorker"` handling the way vite-plugin-pwa documents: a separate `src/sw.tsconfig.json` is not needed if the `/// <reference lib="webworker" />` line is present and `vite-plugin-pwa/client` types are referenced; otherwise exclude `src/sw.ts` from the app `tsconfig.json` and add `clients/web/tsconfig.sw.json` with `"lib": ["ESNext", "WebWorker"]` and run both in `typecheck`.

- [ ] **Step 7: Register it**

`clients/web/src/sw-register.ts`:

```ts
import { desktop } from "./desktop";

/** Registers the service worker in a browser production build (not Vite dev, not the desktop app). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || desktop !== null || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => console.warn("service worker:", err));
  });
}
```

`clients/web/src/main.tsx`: import and call `registerServiceWorker();` before `createRoot`.

- [ ] **Step 8: Update `index.html` head**

```html
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#131313" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="icon" type="image/svg+xml" href="/src/assets/favicon.svg" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon-180x180.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>Datrope</title>
```

`viewport-fit=cover` + `black-translucent` lets content draw under the iPhone notch; the mobile UX pass (next spec) adds the `env(safe-area-inset-*)` padding. Until then, add one rule to `src/styles.css` so nothing hides under the notch:

```css
body { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
```

(Check `styles.css` for an existing `body` rule and merge into it.)

- [ ] **Step 9: Build and run checks**

From `clients/web`: `rtk pnpm build` — expect `dist/sw.js` and `dist/icons/*`. Then `rtk pnpm typecheck` and `rtk vitest run`. Rebuild the e2e stack and `rtk playwright test e2e/pwa.spec.ts`.
Expected: all PASS.

- [ ] **Step 10: Review pause.**

---

### Task 7: Push in the client — subscription sync, SW handlers, settings, sign-out

**Files:**
- Modify: `clients/core/openapi.json`, `clients/core/src/schema.d.ts` (regenerated)
- Create: `clients/web/src/notify/push.ts`, `clients/web/src/notify/push.test.ts`
- Create: `clients/web/src/app/PushBridge.tsx`
- Modify: `clients/web/src/sw.ts`, `src/app/AppShell.tsx`, `src/app/settings/NotificationSettings.tsx`, `src/session.ts`, `src/app/NotificationListener.tsx`

**Interfaces:**
- Consumes: `/api/push/key`, `PUT|DELETE /api/push/subscription` (Task 1); payload `{title, body, url, tag}` (Task 3); `notifyPrefs` / `NotifyLevel` (`src/notify/prefs.ts`).
- Produces:
  - `pushSupported(): boolean`
  - `needsHomeScreen(): boolean` — iOS/iPadOS Safari, not installed.
  - `syncPush(prefs: NotifyPrefs, permission: NotificationPermission | "unsupported"): Promise<void>`
  - `disablePush(): Promise<void>`
  - `<PushBridge />` — renders nothing.

- [ ] **Step 1: Regenerate API types**

From `clients/core`: `rtk pnpm gen`
Expected: `schema.d.ts` contains `"/api/push/key"` and `"/api/push/subscription"`.

- [ ] **Step 2: Write the failing tests**

`clients/web/src/notify/push.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  GET: vi.fn(async () => ({ data: { public_key: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" }, response: new Response(null, { status: 200 }) })),
  PUT: vi.fn(async () => ({ response: new Response(null, { status: 204 }) })),
  DELETE: vi.fn(async () => ({ response: new Response(null, { status: 204 }) })),
}));
vi.mock("../session", () => ({ client: { api } }));
vi.mock("../desktop", () => ({ desktop: null }));

import { disablePush, needsHomeScreen, syncPush } from "./push";

function fakeSub(endpoint = "https://push.example/1") {
  return {
    endpoint,
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  };
}

let current: ReturnType<typeof fakeSub> | null;
const pushManager = {
  getSubscription: vi.fn(async () => current),
  subscribe: vi.fn(async () => (current = fakeSub())),
};

beforeEach(() => {
  vi.clearAllMocks();
  current = null;
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve({ pushManager }) } });
  Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
});

describe("syncPush", () => {
  it("subscribes and saves the level when enabled", async () => {
    await syncPush({ enabled: true, level: "mentions" }, "granted");
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(api.PUT).toHaveBeenCalledWith("/api/push/subscription", {
      body: { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" }, level: "mentions" },
    });
  });

  it("reuses an existing subscription and re-saves it (startup resync, level change)", async () => {
    current = fakeSub("https://push.example/old");
    await syncPush({ enabled: true, level: "all" }, "granted");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.PUT).toHaveBeenCalledWith("/api/push/subscription", expect.objectContaining({
      body: expect.objectContaining({ endpoint: "https://push.example/old", level: "all" }),
    }));
  });

  it("unsubscribes when disabled or not permitted", async () => {
    current = fakeSub();
    const sub = current;
    await syncPush({ enabled: false, level: "all" }, "granted");
    expect(api.DELETE).toHaveBeenCalledWith("/api/push/subscription", { body: { endpoint: "https://push.example/1" } });
    expect(sub.unsubscribe).toHaveBeenCalled();

    current = fakeSub();
    await syncPush({ enabled: true, level: "all" }, "denied");
    expect(current.unsubscribe).toHaveBeenCalled();
  });

  it("does nothing without push support", async () => {
    // @ts-expect-error test removes the API
    delete window.PushManager;
    await syncPush({ enabled: true, level: "all" }, "granted");
    expect(api.PUT).not.toHaveBeenCalled();
  });
});

describe("disablePush", () => {
  it("is a no-op with no subscription", async () => {
    await disablePush();
    expect(api.DELETE).not.toHaveBeenCalled();
  });
});

describe("needsHomeScreen", () => {
  it("is true on iPhone Safari outside the installed app", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1");
    Object.defineProperty(navigator, "standalone", { configurable: true, value: false });
    expect(needsHomeScreen()).toBe(true);
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    expect(needsHomeScreen()).toBe(false);
  });

  it("is false elsewhere", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 14) Chrome/129 Mobile");
    expect(needsHomeScreen()).toBe(false);
  });
});
```

Check how `unwrap` from `@datrope/core` treats `{ response }` without `error` (look at `clients/core/src/api.ts`) and shape the mock returns so `unwrap` succeeds.

- [ ] **Step 3: Run to verify they fail**

From `clients/web`: `rtk vitest run src/notify/push.test.ts`
Expected: FAIL — cannot resolve `./push`.

- [ ] **Step 4: Implement `src/notify/push.ts`**

```ts
import { unwrap } from "@datrope/core";
import { desktop } from "../desktop";
import { client } from "../session";
import type { NotifyPrefs } from "./prefs";

/** Web Push works here: a browser (not the desktop app) with a service worker and the Push API. */
export function pushSupported(): boolean {
  return desktop === null && "serviceWorker" in navigator && "PushManager" in window;
}

/** iPhone and iPad only allow notifications from an app added to the Home Screen. */
export function needsHomeScreen(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  return ios && (navigator as Navigator & { standalone?: boolean }).standalone !== true;
}

function keyBytes(base64url: string): Uint8Array {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Keeps this browser's push subscription in step with the device's notification settings. */
export async function syncPush(prefs: NotifyPrefs, permission: NotificationPermission | "unsupported"): Promise<void> {
  if (!pushSupported()) return;
  if (!prefs.enabled || permission !== "granted") return disablePush();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { public_key } = await unwrap(client.api.GET("/api/push/key"));
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) });
  }
  const json = sub.toJSON();
  await unwrap(client.api.PUT("/api/push/subscription", {
    body: { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" }, level: prefs.level },
  }));
}

/** Stops pushes to this browser: tells the server, then drops the subscription. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const sub = await currentSubscription();
  if (!sub) return;
  try {
    await unwrap(client.api.DELETE("/api/push/subscription", { body: { endpoint: sub.endpoint } }));
  } finally {
    await sub.unsubscribe();
  }
}
```

- [ ] **Step 5: Run to verify they pass**

From `clients/web`: `rtk vitest run src/notify/push.test.ts`
Expected: PASS.

- [ ] **Step 6: Push and click handlers in `src/sw.ts`** (append)

```ts
type PushPayload = { title: string; body: string; url: string; tag: string };

// Always show the notification: Safari revokes subscriptions whose pushes show
// nothing. The server already skips people who are using the app.
self.addEventListener("push", (event) => {
  let p: PushPayload;
  try {
    p = event.data?.json() as PushPayload;
  } catch {
    return;
  }
  event.waitUntil(self.registration.showNotification(p.title, {
    body: p.body, tag: p.tag, icon: "/icons/pwa-192x192.png", badge: "/icons/pwa-64x64.png", data: { url: p.url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows[0];
    if (open) {
      await open.focus();
      open.postMessage({ type: "navigate", url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
```

- [ ] **Step 7: `src/app/PushBridge.tsx`**

```tsx
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { notifyPrefs } from "../notify/prefs";
import { pushSupported, syncPush } from "../notify/push";

const permission = () => ("Notification" in window ? Notification.permission : "unsupported" as const);

/** Keeps Web Push in step with this device's notification settings and follows notification taps. Renders nothing. */
export function PushBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!pushSupported()) return;
    const sync = () => void syncPush(notifyPrefs.getState(), permission()).catch((err) => console.warn("push:", err));
    sync(); // the endpoint may have rotated, or the server pruned it
    return notifyPrefs.subscribe(sync);
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "navigate" && typeof e.data.url === "string" && e.data.url.startsWith("/")) navigate(e.data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [navigate]);

  return null;
}
```

Mount `<PushBridge />` in `src/app/AppShell.tsx` next to `<NotificationListener />` (line ~73).

- [ ] **Step 8: Sign-out**

`src/session.ts` `signOut`:

```ts
export async function signOut() {
  await disablePush().catch(() => undefined); // the server drops it with the session anyway; this frees the browser's
  await unwrap(client.api.POST("/api/auth/logout"));
  client.disconnect();
  window.location.assign("/login");
}
```

Import `disablePush` from `./notify/push`. If this creates an import cycle problem (`push.ts` imports `client` from `session.ts`), move the `disablePush` import to a dynamic `await import("./notify/push")` inside `signOut`.

- [ ] **Step 9: Settings — Home Screen note**

In `NotificationSettings.tsx`, import `needsHomeScreen` and replace the unsupported line:

```tsx
          {permission === "unsupported" && (
            <p id="notify-unsupported" className="m-0 text-sm text-muted-foreground">
              {needsHomeScreen()
                ? "Add Datrope to your Home Screen to get notifications when the app is closed."
                : "This browser cannot show notifications."}
            </p>
          )}
```

(The switch label and radio group names stay unchanged; the denied note already exists.)

- [ ] **Step 10: Live notifications on Android**

Android Chrome throws on `new Notification(...)`. In `NotificationListener.tsx`, replace the empty `catch` with a service-worker fallback:

```ts
    } catch {
      // Android Chrome only allows notifications from a service worker.
      const url = where.type === "dm" ? `/messages/${where.id}` : `/channels/${where.parent_id || where.id}`;
      void navigator.serviceWorker?.ready.then((reg) => reg.showNotification(title, {
        body, tag: m.id, icon: icon ? new URL(icon, window.location.origin).href : undefined, data: { url },
      })).catch(() => undefined);
    }
```

The SW `notificationclick` handler from Step 6 handles the tap.

- [ ] **Step 11: Run checks**

From `clients/web`: `rtk pnpm typecheck`, `rtk vitest run`, `rtk pnpm build`.
Expected: all PASS.

- [ ] **Step 12: Review pause.**

---

### Task 8: Docs and spec touch-up

**Files:**
- Modify: `deploy/README.md`
- Modify: `docs/superpowers/specs/2026-10-12-pwa-web-push-design.md`

- [ ] **Step 1: `deploy/README.md`** — add a short "Phone app and notifications" section:

```markdown
## Phone app and notifications

Datrope installs as an app from the browser: on Android use Chrome's "Install app", on iPhone/iPad
open the site in Safari and choose Share → Add to Home Screen (iOS 16.4+). The app is named after
your server.

Notifications while the app is closed use Web Push. Nothing to configure: the server makes its own
VAPID keys on first use and keeps them in the database (`vapid_keys`). Deleting that row
invalidates every device's subscription; people turn notifications off and on again to recover.
Push needs HTTPS (Caddy provides it).
```

- [ ] **Step 2: Spec** — in the "Service worker handlers" section, replace "If a visible, focused window client exists, do nothing. Otherwise" with "Always" and add one sentence: "Safari revokes subscriptions whose pushes show nothing; the server's active-user check already covers an open app." Also note under Settings UI that the permission-denied note already existed.

- [ ] **Step 3: Review pause.**

---

### Task 9: Manual verification on real phones

No code. Run against a deployed instance with HTTPS (the user's VPS or `localhost` with Caddy's CA trusted on the phone).

- [ ] Android Chrome: open the site, Install app, sign in, Settings → turn on notifications (level Mentions). Close the app. From desktop as another user, @mention them → push arrives titled "<name> in #channel". Tap → app opens in that channel.
- [ ] Same phone, level Mentions: plain message from another user → no push. Switch to All → plain message pushes (once per 10 s per channel).
- [ ] Keep the desktop app open and active as the phone's user → mention → no push to the phone. Set desktop presence Idle → mention → push arrives.
- [ ] iPhone Safari (not installed): Settings shows the Home Screen note. Add to Home Screen, open, enable notifications, close → DM pushes and tap opens the DM.
- [ ] Phone in airplane mode → open installed app → shell renders with the reconnecting state; reconnects when back online.
- [ ] Sign out on the phone → mention → no push.
- [ ] Desktop (Tauri) app: no service worker registered (DevTools → Application), notifications behave as before.
