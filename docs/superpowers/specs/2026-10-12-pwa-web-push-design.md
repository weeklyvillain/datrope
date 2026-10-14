# PWA and Web Push

Date: 2026-10-12
Status: approved design, pending plan

## Goal

Use Datrope from a phone as an installed app that gets notifications while closed.

- **Installable.** The web client is a PWA: home-screen icon, standalone window, named after the
  community the instance hosts.
- **Push.** The server sends Web Push notifications for new messages to devices that are not in
  active use. Works on Android (Chrome, Firefox) and on iOS 16.4+ when installed to the home screen.
- **Per-device preferences.** Each device keeps its own level (`all` / `mentions` / `nothing`), so a
  phone can be set differently from a desktop.
- **Offline shell.** The installed app opens without network and shows the existing reconnecting
  state until the server is reachable.
- **Self-host friendly.** No Firebase, Apple developer account or other central service. Each
  instance generates its own VAPID keys.

Out of scope: the mobile UX pass (separate spec, next); offline message data or queued sends; native
iOS/Android apps (FCM/APNs); per-channel or per-server mutes; push for voice calls, reactions or
anything other than new messages.

## Current state

- Notifications are client-only. `clients/web/src/notify/notify.ts` (`shouldNotify`,
  `notificationTitle`, `notificationBody`, `claimMessage`) decides; the browser `Notification` API
  or the desktop bridge (`clients/web/src/desktop.ts`, `desktop_notify`) shows. They fire only while
  a websocket is live.
- Per-device prefs: `clients/web/src/notify/prefs.ts`, localStorage key `datrope.notifyPrefs`,
  `{enabled, level: all|mentions|nothing}`. UI in `src/app/settings/NotificationSettings.tsx`.
- No service worker, manifest, VAPID, FCM or APNs anywhere.
- Message create: `server/internal/messages/handlers.go` parses mentions
  (`messages/mentions.go`), stores `mentions`, `mention_everyone`, `mention_roles`, then publishes
  `MESSAGE_CREATE` on the event bus (`server/internal/events/events.go`) with a channel `Scope`.
  `Audience.Resolve` turns a scope into user IDs.
- Gateway (`server/internal/gateway/gateway.go`) tracks sessions and presence (`online`, `idle`,
  `invisible`). `StatusOf` returns the presence others see.
- Auth: opaque session tokens; `Authorization: Bearer` or `datrope_session` cookie + CSRF header
  (`server/internal/auth/service.go`).
- Web client already has a phone layout (sidebar in a `Sheet`, `src/app/mobile-nav.tsx`).
- Caddy (`deploy/Caddyfile`) serves the built web app from `/srv` and proxies backend routes.
- Latest migration: `00039_albums.sql`.

## Server

### Package `server/internal/push`

**Migration `00040_push.sql`**

```sql
CREATE TABLE push_subscriptions (
  id           BIGINT PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('all', 'mentions', 'nothing')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX ON push_subscriptions (user_id);

CREATE TABLE vapid_keys (
  id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  public_key  TEXT NOT NULL,
  private_key TEXT NOT NULL
);
```

Table and column names for `users` / `sessions` follow the existing schema; the plan confirms them.
A subscription belongs to the auth session that created it, so logout, session revoke and password
change delete it.

**VAPID keys.** On startup, if `vapid_keys` is empty, generate a P-256 keypair and insert it. Keys
never leave the DB except the public key. VAPID subject: the instance's public URL.

**Endpoints** (existing auth: bearer, or cookie + CSRF):

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/push/key` | — | `{public_key}` (base64url) |
| PUT | `/api/push/subscription` | `{endpoint, keys: {p256dh, auth}, level}` | upsert by endpoint, bound to the current user and session; 204 |
| DELETE | `/api/push/subscription` | `{endpoint}` | delete if owned by the current user; 204 |

`PUT` also handles level changes. An endpoint already owned by another user is reassigned (the
browser profile changed hands).

### Fan-out

A bus subscriber handles `MESSAGE_CREATE`. It must not block the bus: it enqueues a job onto a
bounded queue (size 1024) consumed by a small worker pool (4). On overflow the job is dropped and
logged.

Per job:

1. Resolve recipients with `Audience.Resolve(event.Scope)`. Channel permissions are checked at send
   time, so someone who lost access gets nothing.
2. Skip the author.
3. Skip users who are active: new `Gateway.Active(userID) bool` — true if the user has any connected
   session whose own status is `online` or `invisible` (not `idle`). A phone with the app open has
   its own websocket, so it gets the live in-app notification instead.
4. Load the recipient's subscriptions. For each, apply its level:
   - `all` → send.
   - `mentions` → send if the channel is a DM, or the message mentions the user, one of their roles,
     or `@everyone` (stored `mention_everyone`).
   - `nothing` → skip.
5. Rate cap: at most one push per (subscription, channel) per 10 seconds, kept in memory. Later
   messages inside the window are not sent; the `tag` makes the shown notification represent the
   channel anyway.

### Payload

JSON, encrypted by Web Push, under 1 KB:

```json
{ "title": "#general", "body": "alice: see you at 8", "url": "/channels/123", "tag": "channel:123" }
```

- `title`: `#channel-name` for channels, the other person's display name (or group name) for DMs.
- `body`: `author: snippet`, snippet is plain text with markdown stripped, cut at 120 characters.
  Attachment-only messages read `author sent a file`.
- `url`: the in-app route to the channel or DM (route shape confirmed in the plan).
- `tag`: per channel, so repeat notifications replace each other.

### Sending

`webpush-go` behind a small `Sender` interface (fake in tests). Options: TTL 24 h, urgency `high`
for DMs and mentions, `normal` otherwise.

- 404 / 410 → delete the subscription.
- Other errors (413, 429, 5xx, network) → log, no retry. The next message pushes again.
- Success → update `last_used_at`.

## Web client

### PWA shell

- Add `vite-plugin-pwa` in `injectManifest` mode with a custom `src/sw.ts`.
- Workbox precaches the build output. Navigation requests fall back to `index.html`. Denylist:
  `/api`, `/ws`, `/livekit`, file download routes.
- Update strategy `autoUpdate`: a new service worker activates on the next launch; no prompt.
- Register the service worker only in a browser (`desktop === null`). The desktop app has its own
  notifications.
- `index.html` adds `<link rel="manifest" href="/manifest.webmanifest">`, `apple-touch-icon`,
  `apple-mobile-web-app-capable`, `theme-color`, and `apple-mobile-web-app-status-bar-style`
  `default`. The viewport meta keeps its default (no `viewport-fit=cover`): edge-to-edge safe-area
  handling (`viewport-fit=cover` + `env(safe-area-inset-*)`) is deferred to the mobile UX pass,
  because padding `body` overflowed the full-height layouts on notched iPhones.
- Icons: PNG 192, 512 and maskable 512 generated once from `src/assets/datrope-logo.svg` into
  `public/icons/`.

### Manifest (served by the Go server)

`GET /manifest.webmanifest` (no auth). Each instance is its own community, so:

- `name` / `short_name`: the community name (fallback "Datrope").
- `icons`: the community icon if set, else the static Datrope icons.
- `display: standalone`, `start_url: /`, `scope: /`, `background_color` / `theme_color` from the
  dark theme background token value.

Caddy routes `/manifest.webmanifest` to the backend. In development Vite proxies it.
`/sw.js` is served with `Cache-Control: no-cache`.

### Push subscription — `src/notify/push.ts`

The existing per-device prefs stay the source of truth; no new settings model.

- **Enable** (from the `NotificationSettings` toggle, a user gesture as iOS requires): request
  notification permission → `GET /api/push/key` → `registration.pushManager.subscribe({
  userVisibleOnly: true, applicationServerKey })` → `PUT /api/push/subscription` with the current
  level.
- **Level change** → `PUT` again with the new level.
- **Disable**, and **logout** → `subscription.unsubscribe()` and `DELETE /api/push/subscription`.
- **App start**: if enabled and a subscription exists, `PUT` it again (endpoints rotate; the server
  may have pruned it). Sync and disable look up the registration with
  `navigator.serviceWorker.getRegistration()` and do nothing without one, so sign-out never waits on
  a missing service worker.
- Push is attempted only when `serviceWorker` and `PushManager` exist and not in the desktop app.
  Live in-app notifications keep working as today.

### Settings UI

`NotificationSettings.tsx` keeps its controls. Additions:

- On iOS Safari outside an installed app (`navigator.standalone !== true`): a short note "Add Datrope
  to your Home Screen to get notifications when the app is closed." instead of a toggle that cannot
  work.
- Permission denied: the toggle returns to off with the note "Notifications are blocked in your
  browser settings." (The permission-denied note already existed in the notification settings; only
  the iOS note is new.)

### Service worker handlers (`src/sw.ts`)

- `push`: parse the payload. Always `showNotification(title, { body, tag, icon, badge, data: { url } })`.
  Safari revokes subscriptions whose pushes show nothing; the server's active-user check already
  covers an open app. An empty or unreadable push still shows a generic "Datrope" notification that
  opens `/`.
- `notificationclick`: close the notification. If a window client exists, focus it and
  `postMessage({ type: "navigate", url })`; the app listens and routes there. Otherwise
  `clients.openWindow(url)`.

## Error handling and edge cases

- Permission denied → toggle off plus note (above).
- Revoked session or password change → subscriptions cascade-delete; logged-out phones get nothing.
- Lost channel access → resolved at send time; no push.
- Payload size → snippet is truncated server-side; full message content is never sent.
- VAPID keys live in the DB. Deleting the `vapid_keys` row invalidates every subscription; clients
  re-subscribe when the user toggles notifications again. Documented in `deploy/README.md`.

## Testing

**Go unit (`push`):** level matrix (`all` / `mentions` / `nothing` × DM / user mention / role mention
/ `@everyone` / plain message); author skipped; active user skipped, idle user pushed; rate cap per
subscription and channel; 410 prunes; payload title/body/url for channel and DM, snippet truncation,
attachment-only body. Sender faked.

**Go integration (`pgtest` / `apptest`):** `PUT`/`DELETE` subscription, ownership; logout deletes
subscriptions; VAPID keys generated once and stable across restarts; `/manifest.webmanifest` uses
the community name and falls back.

**Web vitest:** `push.ts` enable / level change / disable / startup resync with mocked
`PushManager` and fetch; iOS-not-installed note; permission-denied revert.

**Playwright (Chromium):** manifest is linked and parses; service worker registers; after going
offline (`context.setOffline(true)`) a reload still renders the app shell.

**Manual (listed in the plan's final checklist):** install on Android Chrome and on iOS (Add to Home
Screen), enable notifications, close the app, receive a mention push, tap it and land in the
channel; confirm no push while the same user is active on desktop.
