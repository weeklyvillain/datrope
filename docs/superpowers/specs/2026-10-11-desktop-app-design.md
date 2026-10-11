# Desktop app (Tauri, multi-server) — design

Date: 2026-10-11. Supersedes `docs/superpowers/plans/2026-10-09-milestone-4-desktop.md` (written before the one-server model; its CORS, bearer-token, keychain and server-side mutes work is no longer needed). This is M9 from `2026-10-09-one-server-design.md`.

## Goals

A desktop app that gives Datrope users what a browser tab can't:

1. **Several servers, all connected at once**, switched from a Discord-style rail, with unread and mention badges for each.
2. **Global push-to-talk** that works while another app (e.g. a game) has focus.
3. **Native notifications**, also while the window is hidden.
4. **Tray and background**: close to tray, start on login, unread badge.
5. **Installer and auto-update** for Windows, macOS and Linux — built now, but release automation and update checks stay **switched off** until local development has shown the app works.

Non-goals (v1): paid OS code signing, deep links (`datrope://`), a multi-server web client, server changes, mobile.

## 1. Architecture

```
┌ Tauri window ──────────────────────────────────────────────┐
│ rail webview │ server webview (visible)  ← https://a.example │
│ (bundled,    │ server webview (hidden)   ← https://b.example │
│  local)      │ server webview (hidden)   ← https://c.example │
└────────────────────────────────────────────────────────────┘
```

Each server runs in its **own child webview that loads that server's own hosted web app** (`https://server/`). The web app's cookies, CSRF, relative media URLs, router and module singletons keep working unchanged, the UI always matches the server's version, and the server needs no CORS or bearer-token support. One webview is visible; the others stay loaded and connected.

Rejected alternatives: a bundled web build per webview pointed at a remote API (needs CORS, bearer tokens, blob media, and risks app/server version skew); one webview with a multi-client React app (refactors ~84 web files; possible later).

### 1.1 `clients/desktop/` — Tauri 2 app

- **Rust shell (`src-tauri/`)**
  - Owns the main window, the server list and the layout of the child webviews (Tauri `unstable` multiwebview feature).
  - Plugins: tray, notification, global-shortcut, updater, single-instance, autostart, window-state, opener (external links).
  - Stores the server list in the app config dir as `servers.json`: `{ id, url, name, iconUrl, order }[]`.
  - Each server webview gets its **own persistent data directory** (keyed by server `id`), so cookies and sessions are separate per server and survive restarts. A server can be added only once.
- **Rail (`src/`)**
  - A small bundled Vite + React page: server icons with unread dot and mention count, a **"+" button** to add a server, **drag and drop to reorder**, and right-click → **Remove**.
  - Reuses the web app's design tokens (`clients/web/src/styles.css`) so it looks native to the app; it does not import web app code.
  - Shows the "Update ready — restart" pill (§3.1).
- **Bridge**
  - A Tauri capability added at runtime, scoped to exactly the origins of the added servers. It allows only these commands:
    - `desktop_notify(title, body, path)`
    - `desktop_set_unread(unread: bool, mentions: number)`
    - `desktop_voice_state(inCall: bool)`
    - `desktop_ptt_set_key(code: string)`
  - Events from the shell to a server page: `ptt` (`{ down: bool }`), `leave_voice`, `navigate` (`{ path }`), `visible` (`{ visible: bool }`, sent when the rail shows or hides that webview, and used by the focus check in §2.2).
  - The rail has its own capability (server list commands); server pages cannot call those.

### 1.2 Web app changes (`clients/web`)

New `src/desktop.ts` checks for the Tauri internals global (`window.__TAURI_INTERNALS__`). In a normal browser it is inert and the app behaves exactly as today. Inside the desktop app:

- **Notifications:** the existing decision logic (`shouldNotify`, all/mentions/nothing level, focus check, `claimMessage` dedupe) is unchanged; delivery goes through `desktop_notify` instead of `new Notification`. Notifications default to **on** (no permission prompt is needed).
- **Unread:** totals for unread and mentions (DMs count as mentions) are pushed with `desktop_set_unread` whenever they change.
- **Push-to-talk:** registers the configured key with `desktop_ptt_set_key`, listens for `ptt` events, and combines them with the existing in-window `watchPtt` so a key held both ways counts once.
- **Voice:** reports `desktop_voice_state` on join/leave; on `leave_voice` it leaves the call.
- **Navigation:** on `navigate` it routes to the path (used by notification clicks).

No server changes.

### 1.3 Voice across servers

Only one call at a time. When a server page reports `inCall=true`, the shell sends `leave_voice` to the webview that was in a call before. A hidden webview keeps its call (audio keeps playing), so you can chat on one server while in voice on another.

## 2. Tray, background, notifications, push-to-talk

### 2.1 Tray and background

- Closing the window **hides it to the tray**; all webviews stay connected. The tray menu has Show, Start on login (toggle) and Quit.
- The first close to tray shows a one-off notification that the app is still running.
- Badge: the tray icon gets a dot when any server has unread mentions or DMs; on Windows the taskbar also shows an overlay badge, and on macOS the dock shows the count.
- Start on login: off by default (autostart plugin). When on, the app starts hidden in the tray.
- Single instance: starting the app again focuses the existing window.
- Window size and position are remembered (window-state plugin).

### 2.2 Notifications

- The web page decides **whether** to notify; the shell decides **how**: a native notification titled with the server name.
- Clicking a notification focuses the window, selects that server in the rail and sends `navigate` with the channel path. Where a platform doesn't support notification click handling (some Linux setups), the click just focuses the app.
- Each server keeps its own notification level (each webview has its own localStorage).
- A page counts as "focused" only when the window is focused **and** its webview is the visible one; hidden server webviews always notify.

### 2.3 Push-to-talk

- The key is the one from voice settings (`KeyboardEvent.code`).
- In the desktop app it is also registered as a **global** shortcut, but **only while some server is in a call**, so the key isn't taken system-wide the rest of the time.
- The shell maps the shortcut's pressed/released state to `ptt` events and sends them **only to the webview that's in the call**.
- Platform caveats:
  - **macOS** may need Input Monitoring permission. If registration fails, voice settings show a hint.
  - **Linux Wayland** has no global shortcuts: the app falls back to in-window PTT and voice settings show a note.
  - A bare key (e.g. `Backquote`) is allowed globally. Voice settings warn that it can't be typed in other apps while in a call.

## 3. Updates, release, development

### 3.1 Auto-update (built, switched off)

- Uses the Tauri updater plugin with the endpoint `https://github.com/<owner>/datrope/releases/latest/download/latest.json`.
- The check runs at startup and then every 6 hours, **only when `updater.enabled` is true in the app config. It is `false` for now.**
- When an update is downloaded, the rail shows "Update ready — restart". The app never restarts by itself, because that would cut a call.
- Updates are signed with a Tauri updater keypair. The user generates it once with `pnpm tauri signer generate`:
  - The public key goes in `tauri.conf.json`.
  - The private key and its password go in GitHub secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
  - The implementation never creates or stores keys.

### 3.2 Release workflow (written, switched off)

- `.github/workflows/desktop-release.yml` uses `tauri-apps/tauri-action` on a matrix:
  - `windows-latest` → NSIS `.exe`
  - `macos-latest` → universal `.dmg`
  - `ubuntu-22.04` → `.AppImage` and `.deb`
- It uploads to a **draft** GitHub Release with `latest.json`.
- **Trigger: `workflow_dispatch` only.** The `push: tags: ['desktop-v*']` trigger is present but commented out. To turn it on, uncomment it, add the signing secrets, and set `updater.enabled`.
- No OS code signing in v1. The README documents the SmartScreen warning and Gatekeeper's right-click → Open.
- Desktop versions are separate from server versions.

### 3.3 Regular CI

`ci.yml` gains a `desktop` job (Ubuntu): `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, and rail typecheck and lint.

### 3.4 Local development

- `pnpm --filter @datrope/desktop dev` runs `tauri dev`; add `http://localhost:5173` (the web app's Vite dev server) as a server.
- Dev builds allow `http://localhost` servers; release builds require `https://`.
- `pnpm --filter @datrope/desktop build` runs `tauri build` and makes a local NSIS installer (no signing key needed while updater artifacts are off), for testing install, start on login and tray as a real install.
- Prerequisites on Windows:
  - The Rust toolchain (MSVC target).
  - **MSVC Build Tools** ("Desktop development with C++"). This machine has no gcc, and Tauri on Windows needs MSVC anyway.
  - WebView2, which ships with Windows 11.

## 4. Errors and edge cases

- **Adding a server:**
  - The address is normalised (`chat.example.com` → `https://chat.example.com`), then the shell fetches `GET /api/instance` with a 10-second timeout and checks the response looks like Datrope.
  - Errors are shown inline in the add dialog: "Couldn't reach the server", "Not a Datrope server", "Already added".
- **A server goes down while running:** the web app's own reconnect handling covers it. If the page itself fails to load, the shell shows a local "Can't reach <host> — Retry" page in that webview's place, and the rail icon greys out.
- **Removing a server:** asks for confirmation, closes the webview, then deletes its data directory (that device is signed out). If voice was on that server, the call ends.
- **Navigation:** only same-origin navigation stays in a server webview. Every other link (Markdown links, link previews) opens in the system browser. This keeps the bridge capability limited to the server's own origin.
- **Notification flood:** the shell limits `desktop_notify` to 5 per 10 seconds per server and drops the rest.
- **Older servers** without `desktop.ts` never call the bridge: they work, just without native notifications, badges or global PTT.

## 5. Testing

- **Rust unit tests:** URL normalisation; `servers.json` load/save/reorder round-trip; PTT routing (only the in-call webview gets `ptt`, and only while in a call); voice handoff (`leave_voice` goes to the previous call); notify rate limiter.
- **Vitest (web):** `desktop.ts` detection and delivery choice (bridge vs browser Notification); combined in-window and global PTT key state.
- **Vitest (rail):** drag-reorder logic; badge totals.
- **Playwright:** existing web e2e keeps passing; `desktop.ts` is inert in a browser.
- **Manual checklist** (desktop testing is manual in v1, per the architecture spec §10):
  1. Add two servers; both stay connected (a message on the hidden one shows its badge).
  2. Reorder by drag and drop; the order survives a restart.
  3. Join voice on server A, then on server B: A leaves the call.
  4. Global PTT works while another app has focus; the key is free again after leaving voice.
  5. Close to tray; a DM or mention on any server shows a native notification; clicking it opens that channel.
  6. Start on login starts the app hidden in the tray.
  7. Remove a server: it is signed out and its data is gone.
  8. Install the local NSIS build and repeat 1, 5 and 6.

## 6. Planning amendments

Made while writing the implementation plan (`docs/superpowers/plans/2026-10-11-desktop-app.md`); they override the sections above.

- **Server name and icon** come from the page (new command `desktop_server_info(name, icon)`, icon as a `data:image/...` URL ≤ 300 000 characters), because `GET /api/instance` has neither and the rail's webview has no cookies for the server. Until the page reports them, the rail shows initials of the host.
- **Notification clicks:** `desktop_notify(title, body, target)` where `target` is the message id; a click sends `open_notification { target }` to the page, which opens the message. Click-to-open works on **Windows**; on macOS and Linux a click only brings the app forward.
- **Push-to-talk errors:** instead of detecting macOS permission or Wayland specifically, voice settings show the registration error and that the key still works while Datrope is the active window.
- **Updater switch:** a Cargo feature `updater` (off by default) instead of a config flag; the updater endpoint and public key live in `src-tauri/tauri.updater.conf.json`, merged only by the release workflow.
- **Rail overlays:** the add dialog, the remove confirmation and the "no servers yet" screen expand the rail webview to the whole window (`rail_expand`), hiding the server webview meanwhile; the right-click menu is a native menu. Server names show as native tooltips (`title`).
- **Stored state:** `servers.json` keeps servers in rail order (array order, no `order` field) plus `trayNoticeShown`.
- **Background throttling** is turned off for server webviews (WebView2 browser flags on Windows, `background_throttling` elsewhere) so hidden servers stay connected.
- **OAuth account linking** (Twitch, Spotify) leaves the server's origin, so it opens in the system browser and doesn't return to the app; link accounts from the web app.
- **Title bar and server drawer (user feedback after the first build):** the 72 px rail is replaced by a 32 px custom title bar (native decorations off on Windows/Linux, overlay title bar on macOS) with ☰ (dot/count for activity on other servers), the current server's icon and name, a drag region and our own minimize/maximize/close (close still hides to the tray). ☰ opens a 260 px server drawer (list, add, drag to reorder, right-click remove) that pushes the page right while open — server webviews sit above the chrome webview, so it cannot overlay a live page. `rail_expand` became `chrome_mode(closed | drawer | full)`.
