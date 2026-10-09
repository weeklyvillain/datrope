# Datrope — One Server, Feature Complete (design)

**Date:** 2026-10-09
**Status:** Draft, awaiting review
**Amends:** `2026-10-08-datrope-architecture-design.md` (the architecture spec). Where the two disagree, this document wins; everything it does not mention stays as written there.
**Mockups:** the Datrope Screens canvas (main view, messages, welcome page and its editor, server settings: look, roles, emoji; voice: stage and soundboard) and the Datrope Design System (tokens, components, logo). Both are private claude.ai artifacts owned by the project lead.

## 1. Why

Datrope is self-hosted by one group of friends on one machine. Supporting many communities per instance adds a rail, a second settings area, community IDs in every API and invite-to-community on top of registration — complexity a self-hoster never uses. This spec makes **the instance the community**, and adds the features that make day-to-day chat feel complete before the desktop app is built.

## 2. Decisions

| Topic | Decision |
|---|---|
| Communities | **One per instance: the server.** No rail, no "create community", no community IDs in the API or UI. |
| Joining | Registering (with an invite, or openly if the admin allows it) makes you a **member** of the server. |
| Kick / ban | Kick removes membership; the account can come back only with a new invite. Ban removes membership, blocks the account from rejoining and revokes its sessions. |
| Look | The admin picks a **palette** (Emerald, Ocean, Violet, Amber, Rose, Mint), a server **icon** and a **banner**. The palette sets the accent colour for everyone; the Datrope mark (an SVG in `currentColor`) is drawn in it when no icon is uploaded. Dark theme only. |
| Welcome page | A special channel whose page the admin writes in **Markdown** (images and channel cards allowed). If the admin turns on the rules gate, a new member sees **only the welcome page** until they press "I accept the rules". |
| DMs | Their **own view**: the sidebar switches between **Channels** and **Messages** with two tabs. Voice panel and profile strip stay at the bottom of both. |
| Threads | Open in a **side panel** next to the channel. |
| Voice channels | Have their own **side text chat**, opened from the voice header like a thread. |
| Soundboard | Sounds are short clips with an **emoji** as their picture. A played sound is sent to everyone in the call as an event; each client plays the clip itself at its own soundboard volume. Media never goes through LiveKit for this. |
| Per-user volume | Each listener sets other people's volume (0–200%), "mute for me" and "hide video" for themselves; stored on their device only. |
| Custom emoji | Uploaded by people with Manage expressions, **many at once**, each renamed before adding; used as `:name:` in messages and reactions. |
| Role hierarchy | Roles are ordered. You can only edit roles below your highest role, and only moderate (kick, ban, voice-mute, move, delete messages of) members whose highest role is below yours. The owner is above everyone. |

## 3. Domain model

```
Server (one row) ── Member ── Role (ordered, colour, "show separately", permission mask)
     │                 └─ accepted_rules_at
     ├─ Category ── Channel (text | voice | welcome) ── Message ── Attachment
     │                         │            ├─ Reaction (emoji, user)
     │                         │            ├─ reply_to → Message
     │                         │            └─ Thread (a child channel of type thread)
     │                         └─ ChannelOverride
     ├─ Emoji (name, image)      ├─ Sound (name, emoji, clip)
     ├─ WelcomePage (markdown, banner, rules gate)
     └─ Invite / Ban
DMChannel (2–10 users) ── Message (replies, reactions, attachments; no threads)
```

- **Server.** One row, created on first start: name ("Datrope" until the admin changes it), description, icon, banner, palette. The first registered user is its **owner** and the instance admin. Internally the existing `communities` tables keep their columns, pointing at this one row, so the change is mostly in the API and UI; nothing else may create a second row.
- **Member.** Every non-disabled user who joined. `accepted_rules_at` is null until they accept (always set when the gate is off).
- **Category.** A named, ordered group of channels. Collapsing is a per-device client setting.
- **Channel types.** `text`, `voice` (with its own messages: the side chat), `welcome` (exactly one; its content is the welcome page, it has no messages), `thread` (belongs to a parent message; inherits the parent channel's permissions), `dm`.
- **Message.** Gains `reply_to_id` (nullable, same channel), `mentions` (user IDs, parsed by the server from `@username`), `pinned`, and an embedded thread summary (reply count, last reply time, up to three participants).
- **Reaction.** `(message, emoji, user)`; `emoji` is a Unicode emoji or `custom:<emoji id>`.
- **Emoji / Sound.** Owned by a new `expressions` package; image and clip bytes live in the existing file store.

## 4. Permissions

Flags added to the architecture spec's list: `ADD_REACTIONS`, `CREATE_THREADS`, `USE_SOUNDBOARD`, `MANAGE_EXPRESSIONS` (emoji and sounds), `MANAGE_SERVER` (replaces `MANAGE_COMMUNITY`: name, look, welcome page). `@everyone` gets `ADD_REACTIONS`, `CREATE_THREADS` and `USE_SOUNDBOARD` by default.

Calculation is unchanged (`perms.Effective`), plus two rules:
1. **Rules gate.** While the gate is on and `accepted_rules_at` is null, a member's permissions are `VIEW_CHANNEL` on the welcome channel only; every other channel resolves to no flags.
2. **Hierarchy** (checked by the endpoints, not by `Effective`): editing a role needs `MANAGE_ROLES` and a highest role above it; moderating a member needs the permission and a highest role above theirs. Granting a permission you do not hold stays forbidden.

## 5. API and realtime changes

- Community-scoped routes become server routes: `GET/PATCH /api/server`, `/api/server/members/...`, `/api/server/roles/...`, `/api/server/invites`, `/api/server/bans/...`, `/api/server/channels`, `/api/server/categories`. Creating, deleting and leaving communities go away (leaving the server = deleting your account, admin rules permitting).
- `READY` carries `server` (with roles, members, categories, visible channels), DMs, presences, voice states, read states and, for this user, `accepted_rules_at`.
- New events: `SERVER_UPDATE`, `CATEGORY_CREATE/UPDATE/DELETE`, `MESSAGE_REACTION_ADD/REMOVE`, `THREAD_UPDATE` (summary on the parent), `EMOJI_UPDATE`, `SOUND_UPDATE`, `SOUNDBOARD_PLAY` (to the call's participants), `WELCOME_UPDATE`. `COMMUNITY_*` events become `SERVER_*`.
- Link previews: the server fetches the first link of a message (http/https only, public addresses only — no loopback, private, link-local or metadata ranges, checked after DNS resolution — 1 MB, 5 s, OpenGraph/`<title>`), caches the result for 24 h, and embeds `{url, site, title, description}` in the message. No preview images in this version.

## 6. Features by milestone

Each milestone gets its own implementation plan, built in this order. Every UI uses the design system's components first (shadcn/ui), and the screens follow the mockups.

### M4 — One server
- Collapse communities into the server (API, READY, events, store, UI). Existing data migrates by keeping the oldest community as the server and making every account that is not disabled or banned a member; other communities' channels move into the server, renamed `<community> · <channel>` (categories arrive in M6), and lose their role overrides.
- New app layout from the mockups: no rail; sidebar header with icon, name and member count; **Channels / Messages** tabs; channel list; voice panel and profile strip (with custom status text) at the bottom on the `card` surface.
- Server settings area (its own sidebar: Overview, Look, Welcome page, Channels, Members, Roles, Invites, Bans, Emoji, Soundboard, Sign-ups, Uploads and voice) replacing community and admin settings; this milestone fills Overview, Look, Welcome page, Members, Roles (colour, show separately, hierarchy, permission groups in plain words), Invites, Bans, Sign-ups, Uploads and voice.
- Palettes and server icon/banner; the logo mark recolours with the palette.
- Welcome channel and page: Markdown editor with live preview, banner, channel cards (`[[channel:<name> "<description>"]]`), images, rules gate with "I accept the rules".

### M5 — Messaging
- Safe Markdown rendering in messages: bold, italic, strikethrough, inline code, code blocks, quotes, lists, links (and bare URLs), spoilers `||…||`, `:emoji:`; no raw HTML.
- Replies (quote line above the message, jump to the original), editing and deleting from the message's hover menu, "(edited)".
- Mentions: `@` autocomplete in the composer, highlighted mentions and messages that mention you.
- Reactions with Unicode and custom emoji; an emoji picker shared by the composer and reactions.
- Custom emoji: bulk upload (PNG, GIF, WebP, ≤256 KB each, ≤200 per server), names from file names, edited and validated per tile (letters, digits, `_`; unique), delete.
- Link previews (§5).

### M6 — Organisation
- Categories: create, rename, delete, collapse (per device), drag to reorder categories and channels (`MANAGE_CHANNELS`).
- Channel topics in the header; pinned messages (pin/unpin with `MANAGE_MESSAGES`, a pins panel).
- Threads: start from a message's menu, side panel with its own composer, reply count and participants on the parent, notifications follow the thread.
- Voice channel side chat, opened from the voice header.
- Unread markers: "New messages" line and jump to the first unread.

### M7 — Voice extras
- Voice channel view from the mockups: stage layout (a watched screen share large, people in a strip) and grid layout, "Stop watching", screen-share audio volume, invite tile.
- Per-user volume, mute for me, hide video (local only), with a badge on a tile whose volume you changed.
- Soundboard: sounds uploaded by `MANAGE_EXPRESSIONS` (OGG, MP3 or WAV, ≤5 s, ≤512 KB, an emoji each), favourites per device, search, play (`USE_SOUNDBOARD`) → `SOUNDBOARD_PLAY`; a "played <sound>" chip on the player's tile; Shift-click previews locally; your own soundboard volume.

### M8 — People and catching up (to be mocked first)
Avatars, profile panel and popover, member list grouped by roles shown separately, message search, mentions inbox, browser notifications.

### M9 — Desktop app
The Tauri plan (`plans/2026-10-09-milestone-4-desktop.md`), revised for the one-server model.

## 7. Errors and edge cases

- The welcome channel cannot be deleted or have messages; its page can be empty (then the gate cannot be turned on).
- Deleting a role reassigns nothing; members simply lose it. A role cannot be moved above the editor's highest role.
- An emoji or sound in use can be deleted; messages then show its `:name:` as text and reactions with it disappear.
- A thread is deleted with its parent message; a deleted parent keeps its thread readable with "Original message deleted".
- Rate limits: reactions 10 per 10 s per user, soundboard plays 1 per 2 s per user, link-preview fetches 30 per minute per server.

## 8. Testing

As in the architecture spec (§10): Go tests against real Postgres (and LiveKit for voice), Vitest for `@datrope/core`, Playwright on the compose stack. Each milestone's e2e step covers its main flow (M4: accept the rules and reach #general; M5: reply, react with a custom emoji; M6: reply in a thread; M7: play a sound and see the chip in a second browser). Markdown rendering and link-preview address checks get table tests.
