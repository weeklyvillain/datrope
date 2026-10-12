<p align="center">
  <img src="clients/web/src/assets/favicon.svg" alt="" width="72">
</p>

<h1 align="center">Datrope</h1>

<p align="center">
  Self-hosted chat, voice and screen sharing for a group of friends.<br>
  One server on one machine that you own.
</p>

<p align="center">
  <img src="docs/images/chat.png" alt="A text channel with replies, reactions, a code block and a poll, next to the member list">
</p>

Datrope is an open source, Discord-style app that you run yourself. Each instance is **one server**:
its channels, voice channels, direct messages, roles and welcome page. Registering an account joins it,
so there is nothing to set up after installing.

- **You own the data.** Postgres and a file volume on your own machine. No federation, no third-party cloud.
- **Easy to run.** Docker Compose starts everything: the Go server, Postgres, [LiveKit](https://livekit.io) for calls, imgproxy for resizing images, and Caddy for HTTPS.
- **Built for 5–500 people.** A homelab box or a small VPS is enough.

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Install](#install)
- [Development](#development)
- [Project layout](#project-layout)

## Features

### Chat

- Text channels in collapsible categories, with Markdown topics.
- Messages in Markdown: bold, italic, strikethrough, code blocks, quotes, lists, links and `||spoilers||`.
- Replies, `@mentions`, `@everyone`, reactions (Unicode and custom emoji) and link previews.
- Threads in a side panel, pinned messages and a "New messages" line at the first unread message.
- Image, video and audio uploads with a gallery viewer and built-in players.
- Polls with emoji answers, one or several choices, an optional time limit and anonymous voting.
- Slash commands, including `/gif` and `/poll`, and a <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> command palette.
- Direct messages, one to one or in groups.
- Message search with `from:`, `in:`, `has:link`, `has:file`, `before:` and `after:`.
- A mentions inbox and browser notifications.

### Channel types

| Type | What it is for |
|---|---|
| Text | Everyday chat. |
| Voice | Calls, with a text chat beside every voice channel. |
| Announcement | Posts with a title, for news from the admins. |
| Forum | Posts with tags, each one its own thread. Sort and filter by tag. |
| Gallery | A photo and video wall, filterable by type and uploader. |
| Webhook | Messages posted by other services through a webhook URL. |
| Welcome | The page new members see first, written in Markdown, with an optional "accept the rules" gate. |

### Voice and video

- One click to join a voice channel. Voice, camera and screen sharing run through LiveKit.
- Grid or stage layout, and a call controls bar.
- Noise suppression, input and output device choice, and a connection quality indicator.
- Stream quality settings (resolution and frame rate) for screen sharing.
- Per-person volume (0–200 %) and "Mute for me", stored on your device only.
- A soundboard with short clips that anyone with permission can play.
- A music bot: queue YouTube links or searches, or tracks from the server's music library. Everyone in the channel shares the queue.

### People and moderation

- Profiles with avatar, banner (animated GIFs supported), pronouns, "About me", links and a custom status.
- A member list with presence, grouped by role.
- Ordered roles with colours, icons and permissions. You can only manage people below your highest role.
- Kick, ban, server mute, and moving people between voice channels.
- An audit log of who banned, kicked, moved or muted whom and who changed channels, roles and settings, kept for 90 days.
- Invite links, plus guest links: guests join with a nickname and are removed automatically after a set time.
- Sign-ups can be open, invite-only or admin-only.

### Server and integrations

- Six accent palettes (Emerald, Ocean, Violet, Amber, Rose, Mint), a server icon and a banner.
- Custom emoji (upload many at once) and soundboard sounds.
- Stream alerts: post a message when a YouTube channel uploads or a Twitch streamer goes live.
- Twitch and Spotify connections: show when members are live or what they are listening to.
- Works on phones: the web app adapts to small screens.
- A system dashboard for the instance admin: CPU, memory, disk and container status, and one-click updates of the server and yt-dlp.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/images/voice.png" alt="A voice channel in grid layout with five people, the call controls bar and the voice chat panel"><br><sub>Voice channel with its side chat</sub></td>
    <td width="50%"><img src="docs/images/forum.png" alt="A forum channel listing posts with tags, participants and activity"><br><sub>Forum with tags</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/gallery.png" alt="A gallery channel showing uploaded images as a grid"><br><sub>Gallery channel</sub></td>
    <td width="50%"><img src="docs/images/settings-look.png" alt="Server settings, Look section, with palette choices, a live preview, the server icon and banner"><br><sub>Server settings: palette, icon and banner</sub></td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/mobile.png" alt="The general channel on a phone" width="300"><br>
  <sub>On a phone</sub>
</p>

## Install

You need a machine with **Docker** and **Docker Compose**, and a **domain** pointing at it.

1. Get the code and create the config file:

   ```bash
   git clone https://github.com/weeklyvillain/datrope.git
   cd datrope/deploy
   cp .env.example .env
   ```

2. Edit `.env`:

   | Setting | Value |
   |---|---|
   | `DATROPE_DOMAIN` | The domain people use, for example `chat.example.com`. Use `localhost` for a quick local try-out. |
   | `POSTGRES_PASSWORD` | A long random password, letters and digits only. |
   | `LIVEKIT_API_SECRET` | At least 32 letters and digits, for example the output of `openssl rand -hex 32`. |
   | `DATROPE_UPDATER_TOKEN` | Optional. Turns on updates from the browser (see [deploy/README.md](deploy/README.md)). |

3. Start everything:

   ```bash
   docker compose up -d --build
   ```

4. Open `https://<your domain>/register`. **The first account you create owns the server** and is the instance admin.
   New accounts need an invite by default: create one under **Server settings → Invites**, or change the rule under **Server settings → Sign-ups**.

5. Open these ports to the machine (and forward them on your router if it is behind NAT). Calls do not go through Caddy:

   | Port | Used for |
   |---|---|
   | 80/tcp, 443/tcp, 443/udp | The web app and API (Caddy, HTTPS) |
   | 7882/udp | Call audio and video |
   | 7881/tcp | The same, for networks that block UDP |
   | 3478/udp | TURN, for people behind strict firewalls |
   | 30000–30050/udp | TURN relay |

Caddy gets a TLS certificate for your domain automatically. If voice cannot connect, text chat keeps working.

To update, run `git pull && docker compose up -d --build` in `deploy/`. Database migrations run when the server starts.

[`deploy/README.md`](deploy/README.md) covers the rest: backups and restores, the music bot, Twitch, YouTube and Spotify setup, and upgrade notes.

## Development

You need **Go 1.25**, **Node.js 22** with **pnpm 9** (`corepack enable`), and **Docker** for Postgres.

1. Install the JavaScript dependencies:

   ```bash
   pnpm install
   ```

2. Start a Postgres database:

   ```bash
   docker run -d --name datrope-dev-db -e POSTGRES_PASSWORD=dev -p 55432:5432 postgres:17-alpine
   ```

3. Start the server from the repo root, in its own terminal:

   ```bash
   DATROPE_DATABASE_URL='postgres://postgres:dev@localhost:55432/postgres?sslmode=disable' \
   DATROPE_PUBLIC_URL='http://localhost:5173' \
   DATROPE_ADDR=':8081' \
   DATROPE_DATA_DIR='./.data' \
   go -C server run ./cmd/datrope
   ```

4. Start the web app in another terminal. Vite forwards API calls to the server:

   ```bash
   DATROPE_DEV_SERVER=localhost:8081 pnpm --filter @datrope/web dev
   ```

5. Open http://localhost:5173/register and create the first account.

Voice needs a LiveKit server as well. Without one, joining a voice channel shows an error and everything else works.
To try calls locally, run LiveKit with a config like [`deploy/livekit.yaml`](deploy/livekit.yaml) (with `use_external_ip: false`
and the webhook pointed at your dev server), and set `DATROPE_LIVEKIT_URL`, `DATROPE_LIVEKIT_PUBLIC_URL`,
`DATROPE_LIVEKIT_API_KEY` and `DATROPE_LIVEKIT_API_SECRET` for the server.

Checks, the same as CI:

```bash
pnpm typecheck && pnpm lint && pnpm test   # TypeScript
go -C server test ./...                     # Go (needs Docker for the database tests)
```

### Desktop app

`clients/desktop` is a Tauri app: a rail of servers on the left, and each server's own web app in its own
webview, all connected at once. Native notifications, global push-to-talk during calls, and a tray icon.

Prerequisites: Rust (stable, MSVC on Windows), the "Desktop development with C++" build tools on Windows,
WebView2 (built into Windows 11). See https://tauri.app/start/prerequisites/ for macOS and Linux.

```bash
pnpm --filter @datrope/desktop dev     # opens the app; add http://localhost:5173 as a server
pnpm --filter @datrope/desktop build   # local installer in clients/desktop/src-tauri/target/release/bundle/
```

Dev builds accept http://localhost servers; release builds need https://. Linking Twitch/Spotify opens in
your browser and does not come back to the app — link accounts from the web app. Links that open in a new
window, including attachments on the server itself, open in your browser, which isn't signed in to the server.

Releases are switched off. To turn them on: run `pnpm --filter @datrope/desktop tauri signer generate`,
put the public key in `src-tauri/tauri.updater.conf.json`, add `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository secrets, and uncomment the tag trigger in
`.github/workflows/desktop-release.yml`. Builds are not code-signed: Windows SmartScreen shows "More info →
Run anyway", and on macOS right-click the app → Open the first time.

## Project layout

```
server/         Go server: API, WebSocket gateway, permissions, voice tokens
clients/core/   Shared TypeScript: API client (generated from the server's OpenAPI), state, gateway
clients/web/    React web app (Vite, Tailwind CSS v4, shadcn/ui)
clients/desktop/ Tauri desktop app: server rail, one webview per server, notifications, push-to-talk
deploy/         Docker Compose, Caddy and LiveKit config
docs/           Design specs and implementation plans
```
