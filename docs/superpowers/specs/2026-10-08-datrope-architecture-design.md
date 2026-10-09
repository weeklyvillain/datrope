# Datrope — Architecture Design

**Date:** 2026-10-08
**Status:** Draft, awaiting review

Datrope is an open source, self-hosted platform for text chat, voice, screen share, and file/image sharing — a Discord-style app that a community runs on its own box.

This spec defines the overall architecture and stack. Each milestone (see §12) gets its own implementation plan.

## 1. Decisions

| Topic | Decision | Why |
|---|---|---|
| Audience | Friends/communities, 5–500 users per instance, one machine | Discord-style use; homelab or small VPS |
| Federation | None. Each instance is standalone | Federation multiplies complexity (identity, sync, moderation) |
| Encryption | TLS in transit; server can read data | The self-hoster owns the box and is the trust anchor. Enables search, previews, moderation, simple multi-device |
| Clients | Web, desktop, and mobile in v1 | Built in that order (§12) |
| Backend | Go | Single binary, strong concurrency, same ecosystem as LiveKit |
| Video scope | Screen share / Go Live, plus camera video | Camera uses the same SFU tracks, so it is nearly free. No broadcast/HLS, no video on demand |
| Deployment | Docker Compose | Standard for self-hosters; lets us use proven components |
| Frontend | React web + Tauri desktop + React Native mobile, sharing a TS `core` package | Mobile voice needs native call integration and background audio, which a webview cannot provide |

## 2. Architecture

```
                 ┌──────────── Caddy (TLS, :443) ────────────┐
 clients ──────► │ /api, /ws  → datrope-server (Go)           │
 (web/desktop/   │ /          → web app (static files)        │
  mobile)        │ /livekit   → LiveKit (signalling)          │
                 └────────────────────────────────────────────┘
 datrope-server ──► Postgres          (data)
                ──► /data/files       (uploads, disk volume)
                ──► LiveKit API       (rooms, tokens, removals)
 LiveKit ◄──── UDP media + built-in TURN ────► clients
```

Compose services: `caddy`, `server`, `postgres`, `livekit`. The web app's static files are served by Caddy.

### 2.1 datrope-server

The only service we write. It is a modular monolith: one Go program, split into packages by area:

- `auth` — accounts, sessions, rate limits
- `communities` — communities, members, roles, invites, bans
- `channels` — text/voice channels, permission overrides, DMs
- `messages` — create/edit/delete/list messages
- `files` — uploads, thumbnails, downloads
- `voice` — LiveKit tokens, webhooks, voice state
- `gateway` — WebSocket connections and event delivery
- `perms` — the permission calculation (pure function, no I/O)

Rules:
- Each package owns its tables and HTTP handlers.
- Packages call each other through Go interfaces and never read another package's tables.
- Packages publish events to an in-process event bus. `gateway` subscribes and delivers them to clients. There is no Redis; one process is enough at this scale.

### 2.2 Voice and media

Voice, camera, and screen share run through **LiveKit**. Media never passes through datrope-server. The server's job is to check permissions, issue LiveKit tokens, and react to LiveKit webhooks.

### 2.3 Repo layout

```
server/            Go module
clients/core/      shared TS: API client, WebSocket, state, types
clients/web/       React (Vite); also the desktop UI
clients/desktop/   Tauri shell around clients/web
clients/mobile/    React Native (Expo)
deploy/            docker-compose.yml, Caddyfile, livekit.yaml, .env.example
docs/
```

The server publishes an **OpenAPI** document. TypeScript types in `clients/core` are generated from it, so server and clients cannot drift apart.

## 3. Domain model

```
User ── Member ── Community ── Channel (text | voice) ── Message ── Attachment
               └─ Role (permission bitmask)       └─ ChannelOverride (role/member allow/deny)
DMChannel (2–10 users, no community) ── Message
Invite (community, code, max uses, expiry)
Session (user, token hash, device name, last used)
```

- **Instance admin:** the first registered user. The admin sets the registration mode: `invite_only` (default), `open`, or `admin_only`. The admin can also disable community creation for non-admins.
- **Community:** a Discord "server". Any user can create one unless the admin disables it.
- **IDs:** Snowflake-style 64-bit, time-ordered. Lists page with `?before=<id>&limit=<n>` (max 100).
- **Messages:** text up to 4000 characters. Editing sets `edited_at` (no history kept). Deleting is a soft delete: the content is cleared and the row is kept.
- **Out of scope for v1:** threads, reactions, pins, custom emoji, bots, webhooks, search.

## 4. Permissions

Each role has a 64-bit permission bitmask. Flags (v1):

`VIEW_CHANNEL`, `SEND_MESSAGES`, `ATTACH_FILES`, `READ_HISTORY`, `CONNECT_VOICE`, `SPEAK`, `STREAM`, `MANAGE_MESSAGES`, `MUTE_MEMBERS`, `MOVE_MEMBERS`, `KICK`, `BAN`, `CREATE_INVITE`, `MANAGE_ROLES`, `MANAGE_CHANNELS`, `MANAGE_COMMUNITY`, `ADMIN`.

Every community has an `@everyone` role that all members hold.

`perms.Effective(member, channel) → Perms` is the only place permissions are calculated:

1. If the member is the community owner, or any of their roles has `ADMIN`: return all flags.
2. Start with the OR of all the member's role masks (including `@everyone`).
3. Apply the channel's `@everyone` override: remove its denies, then add its allows.
4. Apply role overrides for the member's roles: combine all their denies and remove them, then combine all their allows and add them.
5. Apply the member's own override (deny, then allow).
6. If the result lacks `VIEW_CHANNEL`, return no flags for that channel.

REST handlers, the gateway (who receives an event), and voice token issuing all call this function.

DMs have fixed permissions: each participant can view, send, attach, connect, speak, and stream.

## 5. Realtime protocol

### 5.1 Writes over REST, reads over WebSocket

Sending a message:
1. Client sends `POST /api/channels/{id}/messages` with a client-chosen `nonce`.
2. Server checks `SEND_MESSAGES`, saves the message, and publishes `MESSAGE_CREATE`.
3. The gateway delivers the event to every connected user with `VIEW_CHANNEL` on that channel.
4. The sender matches the `nonce` to replace its pending message.

### 5.2 Gateway

- The client connects to `/ws` and sends `IDENTIFY` with its session token.
- The server replies `READY` with the user, their communities, channels, roles, online members, current voice states, and read markers.
- After that the server sends change events (`MESSAGE_CREATE/UPDATE/DELETE`, `CHANNEL_*`, `MEMBER_*`, `ROLE_*`, `PRESENCE_UPDATE`, `VOICE_STATE_UPDATE`, `TYPING_START`).
- Every event has a per-connection sequence number. On reconnect the client sends `RESUME` with its last sequence number. The server replays missed events from a buffer that keeps about 2 minutes per session. If the gap is too old, the server sends `INVALID_SESSION` and the client starts over with `IDENTIFY`.
- The client sends a heartbeat every 30 s. A connection without a heartbeat for 45 s is closed.
- Presence: a user is online if they have at least one live connection. Clients can set `idle` themselves. Users can choose to appear offline.

### 5.3 Voice flow

1. Client sends `POST /api/voice/{channelId}/join`.
2. Server checks `CONNECT_VOICE`. It returns a LiveKit token whose grants match the user's rights: publishing audio needs `SPEAK`; publishing camera or screen needs `STREAM`.
3. The client connects to LiveKit directly with that token.
4. LiveKit webhooks (participant joined/left, track published) update the server's voice state. The server broadcasts `VOICE_STATE_UPDATE`.
5. When a user is kicked or banned, loses a permission, or is moderated (`MUTE_MEMBERS`, `MOVE_MEMBERS`), the server calls the LiveKit API to remove, mute, or update that participant.

A user can be in one voice channel at a time. Joining another leaves the first.

### 5.4 Screen share

A screen share is one more video track (plus optional audio) in the channel's LiveKit room. It uses simulcast, so each viewer gets a quality that fits their bandwidth. Viewers subscribe only when they click "watch".

## 6. Accounts and sign-in

- Username or email plus password, hashed with **argon2id**.
- A session token is 32 random bytes. The database stores only its SHA-256 hash, with the device name and last-used time.
  - Web: an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. State-changing requests also require a CSRF header.
  - Desktop and mobile: stored in the OS keychain and sent as `Authorization: Bearer`.
- Users can list and revoke their sessions. Banning a user or resetting their password revokes their sessions immediately and closes their WebSocket connections.
- Login and register are rate-limited per IP and per account.
- **Out of scope for v1:** OAuth/OIDC, two-factor auth, email verification, password reset by email (the admin can reset passwords).

## 7. Files and images

- Upload: `POST /api/attachments` (streamed multipart). The size limit is set by the admin (default 50 MB). The server checks `ATTACH_FILES` on the target channel.
- Files are stored at `/data/files/<sha256>`, so identical uploads share one copy.
- The upload returns an attachment ID. The client includes it when sending a message. Attachments not linked to a message within 24 h are deleted.
- Images (JPEG, PNG, WebP, GIF): the server records width and height, generates thumbnails, and strips EXIF metadata. Pure Go libraries only, no ffmpeg or ImageMagick.
- Download: `GET /api/attachments/{id}` checks the user can still view the channel. Responses set `Content-Disposition`, `X-Content-Type-Options: nosniff`, and a strict CSP, so uploaded files cannot run as pages on our origin.
- Storage sits behind a small `Store` interface. Local disk is the only implementation in v1.

## 8. Notifications

- **Desktop:** Tauri native notifications.
- **Web:** Web Push API.
- **Mobile:** two options, chosen per instance.
  - **UnifiedPush** (default): the server sends to a provider the user picks, for example ntfy. Needs nothing from the Datrope project.
  - **APNs/FCM via a push relay**: Apple and Google only accept pushes signed with the app's own credentials, so official app builds use a small relay run by the Datrope project. The push carries no message content, only a signal to fetch new data from the instance. People who build their own apps can point them at their own relay.
- Notification rules: mentions and DMs notify by default. Users can mute communities or channels.

## 9. Errors

- REST errors: `{ "code": "MISSING_PERMISSION", "message": "...", "details": {...}? }` with the matching HTTP status (400, 401, 403, 404, 409, 413, 429, 500). Clients branch on `code`, never on `message`.
- 500 errors are logged with a request ID. The response contains only that ID.
- WebSocket close codes separate three cases: session invalid (sign in again), rate limited (back off), and everything else (reconnect with exponential backoff).
- If LiveKit is unreachable, joining voice fails with `VOICE_UNAVAILABLE`. Text chat keeps working.

## 10. Testing

- **Go unit tests** for pure logic: `perms.Effective` (table-driven, covering every override combination), ID generation, event fan-out.
- **Go integration tests** against real Postgres via testcontainers: the HTTP API end to end and the gateway, including resume and replay. The database is never mocked.
- **Voice integration tests** against a real LiveKit container: token grants are enforced, and kicking removes the participant.
- **`clients/core`**: Vitest against a fake server built from the OpenAPI types.
- **Web**: Playwright end-to-end tests of the main flows (register, create community, send message, upload, join voice) against the real compose stack.
- **Desktop and mobile**: manual testing in v1.
- **CI (GitHub Actions)**: `go vet`, `staticcheck`, Go tests, `tsc`, ESLint, Vitest, Playwright, and Docker image builds.

## 11. Operations

- Migrations with `goose`, embedded in the binary, run on startup.
- Configuration from environment variables, documented in `deploy/.env.example`.
- `/healthz` for Docker health checks. Optional Prometheus `/metrics`.
- Structured JSON logs with `slog`.
- Backups: documented as `pg_dump` plus a copy of the `/data` volume.

## 12. Milestones

Each milestone gets its own implementation plan.

1. **Foundation:** server skeleton, accounts and sessions, communities, roles and permissions, invites, text channels and DMs, messaging over REST and WebSocket, web client, Docker Compose deployment. Self-hostable at the end.
2. **Files and images.**
3. **Voice, camera, and screen share** through LiveKit.
4. **Desktop app** (Tauri) with native notifications and global push-to-talk.
5. **Mobile app** (React Native/Expo) with CallKit/ConnectionService and push notifications, including the push relay.
