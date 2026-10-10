# Datrope — Guest Invites (design)

**Date:** 2026-10-10
**Status:** Draft, awaiting review
**Builds on:** `2026-10-09-one-server-design.md` (joining, kick, ban, roles).

## 1. Why

Sometimes the server wants a visitor for an evening — a friend of a friend for a game night, someone joining one voice call. Today that person has to register a full account (username, password) that then lingers forever. A **guest link** lets them type a nickname and be in, with limited access, and removes them automatically when their time is up.

## 2. Decisions

| Topic | Decision |
|---|---|
| Guest link | An invite with a **guest lifetime** set. Anyone opening it while signed out types a nickname and joins as a guest. No password, no email. |
| Registration modes | Guest links work in every mode (`invite_only`, `open`, `admin_only`). The link itself is the authorization. |
| Lifetime | Per invite, counted from each guest's join: `guest_expires_at = joined + guest_ttl`. Choices 1h, 6h, 24h, 3d, 7d, 30d (server accepts 3600–2592000 s). The link's own `max_uses` and `expires_at` work as today. |
| Limited access | A **Guest system role**, created on first guest join and edited by admins like any role (permissions, channel overrides). It cannot be deleted. Default permissions: ViewChannel, ReadHistory, SendMessages, ConnectVoice, Speak. |
| Nicknames | Shown exactly as typed (trimmed, 1–32 chars), duplicates allowed, with a **Guest** badge wherever the name appears. The internal username is `guest-<random>` and never shown. |
| Expiry | Membership removed, account **disabled** (retired, never deleted), sessions revoked. Messages stay, shown under the nick with the Guest badge. |
| Early removal | Kick or ban as usual. Kicking a guest also retires the account (disable + revoke sessions). |
| Signed-in users | Opening a guest link while signed in uses the normal Join flow; it never turns a member into a guest. |

## 3. Data model

Migration `00022_guests.sql`:

```sql
ALTER TABLE invites ADD COLUMN guest_ttl_seconds INT NULL
  CHECK (guest_ttl_seconds BETWEEN 3600 AND 2592000);
ALTER TABLE users ADD COLUMN guest_expires_at TIMESTAMPTZ NULL;
ALTER TABLE roles ADD COLUMN is_guest BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX roles_one_guest ON roles (community_id) WHERE is_guest;
CREATE INDEX users_guest_expiry ON users (guest_expires_at)
  WHERE guest_expires_at IS NOT NULL AND NOT disabled;
```

- `invites.guest_ttl_seconds` non-NULL ⇔ guest link.
- `users.guest_expires_at` non-NULL ⇔ guest account. It is the flag and the deadline in one column.
- `password_hash` stays `NOT NULL`. Guests get the hash of a random secret that is discarded, so password login can never succeed for them.

## 4. Server

### 4.1 Creating guest links

`POST /api/server/invites` accepts optional `guest_ttl_seconds` (3600–2592000). It is gated by CreateInvite, the same as today. Invite list items include `guest_ttl_seconds`.

`GET /api/invites/{code}` (public preview) adds `guest_ttl_seconds` (null for normal links).

### 4.2 Joining as a guest

`POST /api/invites/{code}/guest`, body `{ "nick": string }`, unauthenticated, rate-limited per IP with the same limiter as register.

The handler runs one transaction:

1. Lock the invite row. Fail if it is not usable (`inviteUsable`) or `guest_ttl_seconds` is NULL.
2. Validate the nick: trim; 1–32 characters; no control characters.
3. Insert the user: `username = 'guest-' + random`, `display_name = nick`, random `password_hash`, `guest_expires_at = now() + ttl`.
4. Ensure the Guest role exists (`is_guest = true`, default permissions, lowest position above @everyone), then insert into `members` and `member_roles`. `accepted_rules_at` follows the same rules-gate behaviour as a normal join.
5. Increment `invites.uses`.

After commit it publishes `MEMBER_ADD` and starts a session via `startSession` (cookie for web, token for native).

Errors: 404 for an unknown or non-guest code, 410 for an expired or used-up link, 422 for a bad nick, 429 when rate-limited.

If the request already carries a valid session, it returns 409. The client uses the normal accept flow in that case.

### 4.3 Guest restrictions on the account

These apply regardless of role permissions. Guests get 403 on:

- password change, email change, and session list/revoke endpoints;
- invite creation (even if an admin grants CreateInvite to the Guest role).

Guests may edit their display name and other profile fields.

DMs and every other feature follow the guest's normal permissions. There is no special DM handling.

### 4.4 Guest role protection

`DELETE` on the role with `is_guest = true` returns 409. Everything else about it (name, colour, permissions, position, channel overrides) is editable through existing endpoints and hierarchy rules.

### 4.5 Expiry sweep

A ticker started from `app.go` and stopped via `App.Close`, following the `files.Start` pattern:

- It runs every 1 minute, plus a catch-up pass at startup.
- Each pass selects `id FROM users WHERE guest_expires_at <= now() AND NOT disabled LIMIT 100` and **retires** each one.

**Retire(userID)** is shared with kick:

1. In one transaction: delete the `members` row (`member_roles` cascades) and set `users.disabled = true`.
2. After commit: publish `MEMBER_REMOVE` (server scope plus the user), then `RevokeSessions(userID)`.

Retire is idempotent. A crash before commit is retried on the next tick. A crash after commit is harmless, because session auth already rejects disabled users.

Kick (`DELETE /api/server/members/{userID}`) calls Retire when the target is a guest. Ban keeps its own path and additionally disables guests.

### 4.6 Payloads

The member object (READY, `MEMBER_ADD`, member list) and the `me` response gain `guest_expires_at` (nullable). Message author objects gain the same field so the badge renders for retired guests.

## 5. Clients

### 5.1 Core (`clients/core`)

Regenerate `schema.d.ts`. The store keeps `guest_expires_at` on members and on `me`.

It also adds an API call for `POST /api/invites/{code}/guest`.

### 5.2 Web (`clients/web`)

The UI uses shadcn components and tokens only, per AGENTS.md.

- **Invite page `/invite/:code`.** When the preview has `guest_ttl_seconds` and the visitor is signed out, show:
  - a card with the server name;
  - the line "Join as guest — access lasts 24 hours";
  - a **Nickname** field (`form-field`) and a **Join as guest** button (`use-submit`);
  - a "Have an account? Sign in" link to the existing flow.

  Errors go through `error-text`. Signed-in visitors see the existing Join button.
- **Server settings → Invites.** The create form gets a **Guest link** switch (shadcn `Switch`). When it is on, a **Guest access lasts** select appears with 1 hour, 6 hours, 24 hours, 3 days, 7 days and 30 days. Guest invites in the list show a "Guest · 24h" badge.
- **Guest badge.** A small shadcn `Badge` reading "Guest" appears next to the author name in messages and next to the name in the member list, wherever `guest_expires_at` is set.
- **Guest banner.** For the signed-in guest, a slim banner reads "You're a guest. Access ends in 5h 12m." It updates each minute.
- **Access ended.** When a guest's session is revoked or `MEMBER_REMOVE` targets them, the app shows a "Your guest access has ended" screen instead of the login page. The screen keys off the last-known `me.guest_expires_at`.
- **Roles settings.** The Guest role shows the note "System role for guests — can't be deleted", and its delete action is disabled. The help text says that @everyone permissions still apply, so restricting guests from a channel needs a channel override that denies the Guest role.

## 6. Testing

### Go (`apptest` + `pgtest`)

- Guest join creates the user, membership, Guest role and session, and publishes `MEMBER_ADD`.
- A guest link works in `admin_only` mode.
- `/guest` on a normal invite returns 404.
- Expired and used-up guest links return 410.
- Nick validation: empty, too long, control characters.
- A second guest reuses the same Guest role.
- Guests get 403 on password, email, session and invite-creation endpoints.
- Deleting the Guest role returns 409.
- Sweep: a guest whose `guest_expires_at` has passed is removed from members and disabled, sessions are revoked and `MEMBER_REMOVE` is published. An unexpired guest and a regular user are untouched. A second pass is a no-op.
- Kicking a guest retires the account.
- Migration test for `00022`.

### Core (vitest)

- The store keeps `guest_expires_at`.
- `MEMBER_REMOVE` for a guest `me` triggers `leaveServer`.

### E2E (Playwright)

An admin creates a guest link. An anonymous browser context opens it, joins with a nick and sends a message. The admin sees the message with the Guest badge.

Expiry is covered in Go only.

## 7. Out of scope

- Extending a guest's time, or converting a guest into a full member.
- Per-invite channel lists.
- Guest-specific DM rules.
- Deleting or anonymizing retired guest accounts.
