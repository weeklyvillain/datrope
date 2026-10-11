# Desktop App (Tauri, multi-server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri 2 desktop app with a Discord-style rail where several Datrope servers stay connected at once, each in its own webview, with native notifications, global push-to-talk, tray/background, and an installer + auto-updater that are built but switched off.

**Architecture:** `clients/desktop` is a Tauri shell. One window holds a bundled rail webview (72 px, React) and one child webview per server that loads `https://<server>/` directly, each with its own data directory (separate cookies). Server pages talk to the shell through five `desktop_*` commands, allowed only by a runtime capability scoped to that server's origin; the shell answers with targeted events (`ptt`, `leave_voice`, `visible`, `open_notification`). The web app gains `src/desktop.ts` (inert in a browser) and a `DesktopBridge` component; the Go server does not change.

**Tech Stack:** Rust · Tauri 2.12 (`unstable` multiwebview) + plugins notification, global-shortcut, single-instance, autostart, window-state, opener, updater (optional feature) · `tauri-winrt-notification` (Windows notification clicks) · `reqwest` · React 18 + shadcn/ui (reused from `clients/web`) + `@dnd-kit/sortable` · Vitest · GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-11-desktop-app-design.md` (read it first, including §6 *Planning amendments*).

## Global Constraints

- **Never commit** (AGENTS.md §5). Each task ends by staging its files with `git add`; the user commits.
- On this machine the Write/Edit tools are blocked for project files: write files with Bash heredocs (`cat > file <<'EOF'`) or write to the session scratchpad and `cp`. Tell subagents this up front.
- D: is exFAT with hoisted `node_modules` (`.npmrc node-linker=hoisted`); no symlinks. Workspace packages resolve via Vite aliases / tsconfig paths, never via `node_modules/@datrope/*`.
- Rust crate requirements (all have a release ≥ 2 weeks old at 2026-10-11; `~` keeps the minor fixed): `tauri ~2.12` (features `unstable`, `tray-icon`, `image-png`), `tauri-build ~2.7`, `tauri-plugin-notification ~2.5`, `tauri-plugin-global-shortcut ~2.4`, `tauri-plugin-single-instance ~2.5`, `tauri-plugin-autostart ~2.6`, `tauri-plugin-window-state ~2.5`, `tauri-plugin-opener ~2.6`, `tauri-plugin-updater ~2.13` (optional), `tauri-winrt-notification 0.8` (Windows only), `reqwest 0.13` (`json`), `serde 1`, `serde_json 1`, `url 2.5`, `uuid 1` (`v4`).
- npm pins (exact): `@tauri-apps/cli 2.12.0`, `@tauri-apps/api 2.12.0`. Other npm deps reuse the exact ranges already in `clients/web/package.json`.
- Web UI: shadcn/ui components from `clients/web/src/components/ui` (the rail imports them through the `@` alias), design tokens only, dark only, no `dark:` classes, stable accessible names.
- The release workflow runs on `workflow_dispatch` only; its tag trigger stays commented out. The updater is compiled only with the Cargo feature `updater`, which is off by default.
- Dev builds may add `http://localhost`/`127.0.0.1`/`[::1]` servers; release builds require `https://`.
- Rust code: `cargo fmt`, `cargo clippy --all-targets -- -D warnings` clean. `cargo` commands need the rail built once (`pnpm --filter @datrope/desktop exec vite build`) because `tauri::generate_context!` reads `../dist` at compile time.
- Desktop testing is manual in v1 (architecture spec §10); everything that can be a pure function is one, with unit tests.

## Review Focus

1. **A hidden server webview left for 30+ minutes** must still be connected and still notify (Chromium/WebKit background throttling can starve the gateway heartbeat) → Task 3 sets throttling-off browser args and tests `server_browser_args()`; Task 9's checklist waits 30 minutes.
2. **The push-to-talk key held down while its owner changes** (leaving voice, joining on another server, removing the server) must never leave a mic open → Task 2 `PttRouter` tests send a release to the old owner; Task 8 tests the web combiner releases when either source lets go.
3. **Removing the server that is in voice or owns push-to-talk** must end the call and free the key → Task 2 tests `VoiceTracker::forget` and `PttRouter::set(label, None)` while down; Task 5 calls both from `server_remove`.
4. **Untrusted input from a server page** (a 5 MB icon, a 10 000-character name, a notification flood, a `javascript:` target) must be capped or dropped, never crash or hang the shell → Task 5 tests `sanitize_server_info`, `sanitize_notification` and Task 2 tests `RateLimiter`.
5. **Messy addresses** (`  Chat.Example.com/channels/1 `, `chat.example.com:8443`, `http://chat.example.com`, `user:pw@host`, a duplicate with different case or a trailing slash) must normalise to one origin or a clear error → Task 1 tests `normalize_address` and duplicate detection.

---

## File Structure

```
clients/desktop/
  package.json, tsconfig.json, vite.config.ts, vitest.config.ts
  index.html                rail page
  offline.html              "Can't reach <host>" page loaded into a server webview
  src/main.tsx              rail entry
  src/Rail.tsx              server list, drag reorder, add/remove, badges, update button
  src/AddServerDialog.tsx   address form (inline when empty, dialog otherwise)
  src/rail-api.ts           typed invoke/listen wrappers for rail commands
  src/order.ts (+ .test.ts) moveId, serverInitials, mentionLabel
  src/offline.tsx           offline page entry
  src/rail.css              imports clients/web/src/styles.css
  src-tauri/
    Cargo.toml, build.rs, tauri.conf.json, tauri.updater.conf.json, .gitignore
    capabilities/rail.json, capabilities/offline.json
    icons/                  generated by `tauri icon`
    src/main.rs             calls lib::run
    src/lib.rs              builder, plugins, setup, run loop
    src/servers.rs          Server/Store, normalize_address, navigation_allowed, probe
    src/state.rs            VoiceTracker, PttRouter, RateLimiter, Badges
    src/shell.rs            window, webviews, layout, visibility, rail state
    src/commands.rs         rail + offline + server-page commands
    src/notify.rs           sanitize + show notifications (Windows click → channel)
    src/tray.rs             tray menu, dot icons, badges, close-to-tray
    src/update.rs           (feature "updater") check every 6 h, install on request
clients/web/src/
  desktop.ts (+ .test.ts)                 bridge detection + Desktop class
  app/desktop-sync.ts (+ .test.ts)        badgeFor, pttKeyFor, desktopPtt store
  app/DesktopBridge.tsx                   pushes unread/server info/voice/PTT, handles leave_voice
  app/NotificationListener.tsx            delivery through the bridge
  notify/prefs.ts                         default on in desktop
  app/settings/NotificationSettings.tsx   no permission prompt in desktop
  app/settings/VoiceSettings.tsx          PTT hints + global-key error
  voice/ptt.ts (+ test)                   combinePtt
  voice/call-audio.ts                     global PTT events
  app/AppShell.tsx                        renders <DesktopBridge />
.github/workflows/ci.yml                  desktop job
.github/workflows/desktop-release.yml     manual-only release
eslint.config.js                          react-hooks rules for clients/desktop
README.md                                 desktop section
```

---

### Task 1: Scaffold `clients/desktop` and the server store

**Files:**
- Create: `clients/desktop/package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `offline.html`, `src/main.tsx`, `src/offline.tsx`, `src/rail.css`
- Create: `clients/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,.gitignore,capabilities/rail.json,capabilities/offline.json,src/main.rs,src/lib.rs,src/servers.rs}`, `icons/` (generated)
- Modify: `pnpm-lock.yaml` (via `pnpm install`), `eslint.config.js`

**Interfaces:**
- Produces (Rust, `servers.rs`):
  - `pub struct Server { pub id: String, pub url: String, pub name: String, pub icon: Option<String> }` (serde camelCase)
  - `pub struct Store { pub servers: Vec<Server>, pub tray_notice_shown: bool }` with `load(&Path) -> Store`, `save(&self, &Path) -> io::Result<()>`, `add(&mut self, url: String, name: String) -> Result<Server, AddError>`, `remove(&mut self, id: &str) -> Option<Server>`, `reorder(&mut self, ids: &[String]) -> bool`, `get(&self, id) -> Option<&Server>`, `get_mut`.
  - `pub enum AddError { Invalid, Insecure, Duplicate, Unreachable, NotDatrope }` with `message(&self) -> &'static str`.
  - `pub fn normalize_address(input: &str, allow_http_localhost: bool) -> Result<String, AddError>` → origin like `https://chat.example.com` or `https://chat.example.com:8443`.
  - `pub fn navigation_allowed(server_origin: &str, target: &url::Url) -> bool`
  - `pub fn looks_like_datrope(v: &serde_json::Value) -> bool`, `pub async fn probe(origin: &str) -> Result<(), AddError>`
  - `pub fn host_of(origin: &str) -> String`

- [ ] **Step 1: Package and frontend skeleton**

`clients/desktop/package.json`:

```json
{
  "name": "@datrope/desktop",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "vite": "vite",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@dnd-kit/core": "6.3.1",
    "@dnd-kit/sortable": "10.0.0",
    "@dnd-kit/utilities": "3.2.2",
    "@tauri-apps/api": "2.12.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^1.54.0",
    "radix-ui": "^1.7.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tailwind-merge": "^3.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@tauri-apps/cli": "2.12.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "^4.3.3",
    "tw-animate-css": "^1.4.0",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vitest": "^2.1.8"
  }
}
```

`clients/desktop/vite.config.ts` (the rail reuses the web app's shadcn components and tokens through the `@` alias):

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: { alias: { "@": fileURLToPath(new URL("../web/src", import.meta.url)) } },
  server: { port: 1420, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        rail: fileURLToPath(new URL("./index.html", import.meta.url)),
        offline: fileURLToPath(new URL("./offline.html", import.meta.url)),
      },
    },
  },
});
```

`clients/desktop/vitest.config.ts`:

```ts
import { defineConfig, mergeConfig } from "vitest/config";
import vite from "./vite.config";

export default mergeConfig(vite, defineConfig({ test: { include: ["src/**/*.test.{ts,tsx}"] } }));
```

`clients/desktop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "baseUrl": ".",
    "paths": { "@/*": ["../web/src/*"] }
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

`clients/desktop/src/rail.css`:

```css
@import "../../web/src/styles.css";
@source "../../web/src/components/ui";
@source "./";

html, body, #root { height: 100%; }
body { background: var(--sidebar); overflow: hidden; user-select: none; }
```

`clients/desktop/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Datrope</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`clients/desktop/offline.html`: same as `index.html` with `<title>Can't reach server</title>` and `src="/src/offline.tsx"`.

`clients/desktop/src/main.tsx` (placeholder until Task 4):

```tsx
import { createRoot } from "react-dom/client";
import "./rail.css";

createRoot(document.getElementById("root")!).render(<div className="text-xs text-muted-foreground">Datrope</div>);
```

`clients/desktop/src/offline.tsx` (placeholder until Task 4):

```tsx
import { createRoot } from "react-dom/client";
import "./rail.css";

createRoot(document.getElementById("root")!).render(<p>Can't reach the server.</p>);
```

Add the desktop sources to the react-hooks block in `eslint.config.js`:

```js
    files: ["clients/web/**/*.{ts,tsx}", "clients/desktop/src/**/*.{ts,tsx}"],
```

Run from the repo root: `pnpm install` (updates `pnpm-lock.yaml`). Expected: success; `node_modules/@tauri-apps/cli` exists.

- [ ] **Step 2: Tauri skeleton**

`clients/desktop/src-tauri/Cargo.toml`:

```toml
[package]
name = "datrope-desktop"
version = "0.1.0"
edition = "2021"
publish = false

[lib]
name = "datrope_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[features]
default = []
updater = ["dep:tauri-plugin-updater"]

[build-dependencies]
tauri-build = { version = "~2.7", features = [] }

[dependencies]
tauri = { version = "~2.12", features = ["unstable", "tray-icon", "image-png"] }
tauri-plugin-notification = "~2.5"
tauri-plugin-global-shortcut = "~2.4"
tauri-plugin-single-instance = "~2.5"
tauri-plugin-autostart = "~2.6"
tauri-plugin-window-state = "~2.5"
tauri-plugin-opener = "~2.6"
tauri-plugin-updater = { version = "~2.13", optional = true }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
url = "2.5"
uuid = { version = "1", features = ["v4"] }
reqwest = { version = "0.13", features = ["json"] }

[target.'cfg(windows)'.dependencies]
tauri-winrt-notification = "0.8"
```

`clients/desktop/src-tauri/build.rs` (the app manifest turns every command into an `allow-<name>` permission, so nothing is callable unless a capability grants it):

```rust
fn main() {
    let commands = &[
        // rail
        "servers_list", "server_add", "server_remove", "servers_reorder", "server_select", "rail_expand", "update_restart",
        // offline page
        "server_retry",
        // server pages
        "desktop_notify", "desktop_set_unread", "desktop_voice_state", "desktop_ptt_set_key", "desktop_server_info",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri-build");
}
```

`clients/desktop/src-tauri/tauri.conf.json` (no windows in config: the shell builds the window and its webviews in code):

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Datrope",
  "version": "0.1.0",
  "identifier": "chat.datrope.desktop",
  "build": {
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist",
    "beforeDevCommand": "pnpm vite",
    "beforeBuildCommand": "pnpm vite build"
  },
  "app": {
    "windows": [],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis", "dmg", "appimage", "deb"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    "createUpdaterArtifacts": false
  }
}
```

`clients/desktop/src-tauri/capabilities/rail.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "rail",
  "description": "The bundled server rail",
  "webviews": ["rail"],
  "permissions": [
    "core:event:default",
    "core:menu:default",
    "allow-servers-list", "allow-server-add", "allow-server-remove", "allow-servers-reorder",
    "allow-server-select", "allow-rail-expand", "allow-update-restart"
  ]
}
```

`clients/desktop/src-tauri/capabilities/offline.json` (local pages only, so a remote server page in the same webview never gets it):

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "offline",
  "description": "The bundled offline page shown in a server webview",
  "webviews": ["server-*"],
  "permissions": ["allow-server-retry"]
}
```

`clients/desktop/src-tauri/.gitignore`:

```
/target/
/gen/schemas
```

`src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    datrope_desktop_lib::run();
}
```

`src/lib.rs` (grows in later tasks):

```rust
mod servers;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Datrope");
}
```

Generate icons from the web favicon: `pnpm --filter @datrope/desktop exec tauri icon ../web/src/assets/favicon.svg` (writes `src-tauri/icons/`). Then `pnpm --filter @datrope/desktop exec vite build`.

- [ ] **Step 3: Write the failing server-store tests** — append to `src-tauri/src/servers.rs` (create the file with just the test module first so it fails to compile)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_addresses() {
        let ok = |s: &str| normalize_address(s, false).unwrap();
        assert_eq!(ok("chat.example.com"), "https://chat.example.com");
        assert_eq!(ok("  Chat.Example.com/channels/1?x=1 "), "https://chat.example.com");
        assert_eq!(ok("https://chat.example.com/"), "https://chat.example.com");
        assert_eq!(ok("chat.example.com:8443"), "https://chat.example.com:8443");
        assert_eq!(ok("https://chat.example.com:443"), "https://chat.example.com");
        assert_eq!(normalize_address("", false), Err(AddError::Invalid));
        assert_eq!(normalize_address("ftp://x.example", false), Err(AddError::Invalid));
        assert_eq!(normalize_address("https://user:pw@x.example", false), Err(AddError::Invalid));
        assert_eq!(normalize_address("http://chat.example.com", false), Err(AddError::Insecure));
        assert_eq!(normalize_address("http://chat.example.com", true), Err(AddError::Insecure));
        assert_eq!(normalize_address("http://localhost:5173", false), Err(AddError::Insecure));
        assert_eq!(normalize_address("http://localhost:5173", true).unwrap(), "http://localhost:5173");
        assert_eq!(normalize_address("http://127.0.0.1:5173", true).unwrap(), "http://127.0.0.1:5173");
    }

    #[test]
    fn store_add_remove_reorder_round_trip() {
        let dir = std::env::temp_dir().join(format!("datrope-store-{}", uuid::Uuid::new_v4()));
        let path = dir.join("servers.json");
        let mut s = Store::default();
        let a = s.add("https://a.example".into(), "a.example".into()).unwrap();
        let b = s.add("https://b.example".into(), "b.example".into()).unwrap();
        assert_eq!(s.add("https://a.example".into(), "again".into()), Err(AddError::Duplicate));
        assert!(s.reorder(&[b.id.clone(), a.id.clone()]));
        assert!(!s.reorder(&[b.id.clone()]), "not a permutation: ignored");
        assert!(!s.reorder(&[b.id.clone(), "nope".into()]));
        s.tray_notice_shown = true;
        s.save(&path).unwrap();

        let loaded = Store::load(&path);
        assert_eq!(loaded.servers.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), [b.id.as_str(), a.id.as_str()]);
        assert!(loaded.tray_notice_shown);
        assert_eq!(loaded.get(&a.id).unwrap().url, "https://a.example");

        let mut loaded = loaded;
        assert_eq!(loaded.remove(&a.id).map(|x| x.id), Some(a.id.clone()));
        assert!(loaded.remove(&a.id).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_or_corrupt_file_loads_empty() {
        let dir = std::env::temp_dir().join(format!("datrope-store-{}", uuid::Uuid::new_v4()));
        assert!(Store::load(&dir.join("nope.json")).servers.is_empty());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bad.json"), b"{not json").unwrap();
        assert!(Store::load(&dir.join("bad.json")).servers.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn navigation_stays_on_the_server() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        let origin = "https://chat.example.com";
        assert!(navigation_allowed(origin, &u("https://chat.example.com/channels/1")));
        assert!(navigation_allowed(origin, &u("http://tauri.localhost/offline.html?id=x")));
        assert!(navigation_allowed(origin, &u("tauri://localhost/offline.html")));
        assert!(navigation_allowed(origin, &u("about:blank")));
        assert!(!navigation_allowed(origin, &u("https://evil.example/")));
        assert!(!navigation_allowed(origin, &u("https://chat.example.com.evil.example/")));
        assert!(!navigation_allowed(origin, &u("http://chat.example.com/")), "scheme is part of the origin");
        assert!(!navigation_allowed(origin, &u("javascript:alert(1)")));
    }

    #[test]
    fn recognises_a_datrope_instance() {
        let v = serde_json::json!({ "registration_mode": "open", "has_users": true, "max_upload_bytes": 1 });
        assert!(looks_like_datrope(&v));
        assert!(!looks_like_datrope(&serde_json::json!({ "status": "ok" })));
        assert!(!looks_like_datrope(&serde_json::json!({ "registration_mode": 1, "has_users": true })));
    }

    #[test]
    fn host_of_strips_scheme() {
        assert_eq!(host_of("https://chat.example.com:8443"), "chat.example.com:8443");
        assert_eq!(host_of("http://localhost:5173"), "localhost:5173");
    }
}
```

Add `mod servers;` is already in `lib.rs`. Run: `cd clients/desktop/src-tauri && cargo test servers` → Expected: FAIL (compile errors: `normalize_address`, `Store`, … not found).

- [ ] **Step 4: Implement `servers.rs`** (above the test module)

```rust
//! The list of servers this device has added, and the checks an address goes through first.

use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use url::Url;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    /// The server's origin, e.g. `https://chat.example.com`.
    pub url: String,
    /// The host until the page reports the server's name.
    pub name: String,
    /// A `data:image/...` URL reported by the page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// Everything the shell remembers between runs (`servers.json` in the app config dir).
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub tray_notice_shown: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddError {
    Invalid,
    Insecure,
    Duplicate,
    Unreachable,
    NotDatrope,
}

impl AddError {
    pub fn message(&self) -> &'static str {
        match self {
            AddError::Invalid => "That doesn't look like a server address.",
            AddError::Insecure => "The server must use https://.",
            AddError::Duplicate => "That server is already added.",
            AddError::Unreachable => "Couldn't reach the server.",
            AddError::NotDatrope => "That isn't a Datrope server.",
        }
    }
}

const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Turns what the user typed into a server origin. `https://` is assumed; plain `http://` is only allowed for
/// localhost, and only when `allow_http_localhost` (development builds).
pub fn normalize_address(input: &str, allow_http_localhost: bool) -> Result<String, AddError> {
    let t = input.trim();
    if t.is_empty() {
        return Err(AddError::Invalid);
    }
    let with_scheme = if t.contains("://") { t.to_string() } else { format!("https://{t}") };
    let url = Url::parse(&with_scheme).map_err(|_| AddError::Invalid)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AddError::Invalid);
    }
    let host = url.host_str().ok_or(AddError::Invalid)?;
    match url.scheme() {
        "https" => {}
        "http" if allow_http_localhost && LOCAL_HOSTS.contains(&host) => {}
        "http" => return Err(AddError::Insecure),
        _ => return Err(AddError::Invalid),
    }
    Ok(url.origin().ascii_serialization())
}

/// Whether a server webview may navigate to `target`: its own origin, the bundled offline page, or about:blank.
/// Everything else opens in the system browser.
pub fn navigation_allowed(server_origin: &str, target: &Url) -> bool {
    if target.as_str() == "about:blank" {
        return true;
    }
    if target.scheme() == "tauri" || target.host_str() == Some("tauri.localhost") {
        return true;
    }
    target.origin().ascii_serialization() == server_origin
}

pub fn host_of(origin: &str) -> String {
    origin.split_once("://").map_or(origin, |(_, h)| h).to_string()
}

/// `GET /api/instance` answers with these fields on every Datrope server.
pub fn looks_like_datrope(v: &serde_json::Value) -> bool {
    v.get("registration_mode").is_some_and(serde_json::Value::is_string)
        && v.get("has_users").is_some_and(serde_json::Value::is_boolean)
}

pub async fn probe(origin: &str) -> Result<(), AddError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| AddError::Unreachable)?;
    let res = client
        .get(format!("{origin}/api/instance"))
        .send()
        .await
        .map_err(|_| AddError::Unreachable)?;
    if !res.status().is_success() {
        return Err(AddError::NotDatrope);
    }
    let v: serde_json::Value = res.json().await.map_err(|_| AddError::NotDatrope)?;
    if looks_like_datrope(&v) { Ok(()) } else { Err(AddError::NotDatrope) }
}

impl Store {
    /// A missing or unreadable file means no servers yet.
    pub fn load(path: &Path) -> Store {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Writes through a temporary file, so a crash never leaves half a file.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)?;
        std::fs::rename(tmp, path)
    }

    pub fn add(&mut self, url: String, name: String) -> Result<Server, AddError> {
        if self.servers.iter().any(|s| s.url == url) {
            return Err(AddError::Duplicate);
        }
        let server = Server { id: uuid::Uuid::new_v4().to_string(), url, name, icon: None };
        self.servers.push(server.clone());
        Ok(server)
    }

    pub fn remove(&mut self, id: &str) -> Option<Server> {
        let i = self.servers.iter().position(|s| s.id == id)?;
        Some(self.servers.remove(i))
    }

    /// Applies a new order. `ids` must name every server exactly once; anything else is ignored.
    pub fn reorder(&mut self, ids: &[String]) -> bool {
        if ids.len() != self.servers.len() || !self.servers.iter().all(|s| ids.contains(&s.id)) {
            return false;
        }
        self.servers.sort_by_key(|s| ids.iter().position(|id| *id == s.id));
        true
    }

    pub fn get(&self, id: &str) -> Option<&Server> {
        self.servers.iter().find(|s| s.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Server> {
        self.servers.iter_mut().find(|s| s.id == id)
    }
}
```

Note: `normalize_address` lowercases the host (the `url` crate does), and `origin()` drops default ports, which is what makes duplicates with different case, path or `:443` collide.

- [ ] **Step 5: Run the tests**

Run: `cd clients/desktop/src-tauri && cargo test servers && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
Expected: 6 tests PASS; clippy/fmt clean (`#[allow(dead_code)]` is not allowed — if clippy flags unused items, add `pub` uses in later tasks; for now put `#![allow(dead_code)]` at the top of `servers.rs` and remove it in Task 3).

- [ ] **Step 6: Smoke run**

Run: `pnpm --filter @datrope/desktop dev`. Expected: Vite starts on :1420 and the Rust app compiles and keeps running with no window (none is configured yet). Stop it with Ctrl+C.

- [ ] **Step 7: Stage**

```bash
git add clients/desktop eslint.config.js pnpm-lock.yaml
```

---

### Task 2: Shell state machines

**Files:**
- Create: `clients/desktop/src-tauri/src/state.rs`
- Modify: `clients/desktop/src-tauri/src/lib.rs` (`mod state;`)

**Interfaces:**
- Produces:
  - `VoiceTracker::set(&mut self, label: &str, in_call: bool) -> Option<String>` (the webview that must leave), `forget(&mut self, label: &str)`, `in_call(&self) -> Option<&str>`
  - `PttRouter::set(&mut self, label: &str, key: Option<String>) -> PttUpdate`, `press(&mut self, pressed: bool) -> Option<(String, bool)>`
  - `pub struct PttUpdate { pub unregister: Option<String>, pub register: Option<String>, pub release: Option<String> }` — `release` names a webview that must get `ptt {down:false}`.
  - `RateLimiter::new(max: usize, window: Duration)`, `allow(&mut self, key: &str, now: Instant) -> bool`, `forget(&mut self, key: &str)`
  - `#[derive(Serialize)] Badge { unread: bool, mentions: u32 }`; `Badges::set(&mut self, id: &str, b: Badge) -> bool` (changed), `get(&self, id) -> Badge`, `remove(&mut self, id)`, `total_mentions(&self) -> u32`, `any_unread(&self) -> bool`

- [ ] **Step 1: Write the failing tests** — `state.rs` test module

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn joining_voice_elsewhere_makes_the_other_server_leave() {
        let mut v = VoiceTracker::default();
        assert_eq!(v.set("server-a", true), None);
        assert_eq!(v.set("server-a", true), None, "re-reporting is not a handoff");
        assert_eq!(v.set("server-b", true), Some("server-a".into()));
        assert_eq!(v.in_call(), Some("server-b"));
        assert_eq!(v.set("server-a", false), None, "a stale leave from a does not clear b");
        assert_eq!(v.in_call(), Some("server-b"));
        v.forget("server-b");
        assert_eq!(v.in_call(), None);
    }

    #[test]
    fn ptt_registers_for_its_owner_and_routes_presses() {
        let mut p = PttRouter::default();
        assert_eq!(p.press(true), None, "nobody owns the key");
        let u = p.set("server-a", Some("F8".into()));
        assert_eq!(u, PttUpdate { unregister: None, register: Some("F8".into()), release: None });
        assert_eq!(p.press(true), Some(("server-a".into(), true)));
        assert_eq!(p.press(true), None, "auto-repeat is ignored");
        assert_eq!(p.press(false), Some(("server-a".into(), false)));
        assert_eq!(p.set("server-a", Some("F8".into())), PttUpdate::default(), "same key, nothing to do");
    }

    #[test]
    fn ptt_releases_the_old_owner_when_ownership_moves_while_held() {
        let mut p = PttRouter::default();
        p.set("server-a", Some("F8".into()));
        p.press(true);
        let u = p.set("server-b", Some("F9".into()));
        assert_eq!(u, PttUpdate { unregister: Some("F8".into()), register: Some("F9".into()), release: Some("server-a".into()) });
        assert_eq!(p.press(false), None, "the old press ended with the handoff");
        assert_eq!(p.press(true), Some(("server-b".into(), true)));
    }

    #[test]
    fn ptt_owner_clearing_unregisters_and_releases() {
        let mut p = PttRouter::default();
        p.set("server-a", Some("F8".into()));
        assert_eq!(p.set("server-b", None), PttUpdate::default(), "only the owner can clear");
        p.press(true);
        let u = p.set("server-a", None);
        assert_eq!(u, PttUpdate { unregister: Some("F8".into()), register: None, release: Some("server-a".into()) });
        assert_eq!(p.press(true), None);
    }

    #[test]
    fn ptt_key_change_by_owner_swaps_registration() {
        let mut p = PttRouter::default();
        p.set("server-a", Some("F8".into()));
        let u = p.set("server-a", Some("Backquote".into()));
        assert_eq!(u, PttUpdate { unregister: Some("F8".into()), register: Some("Backquote".into()), release: None });
    }

    #[test]
    fn rate_limiter_allows_five_per_ten_seconds_per_key() {
        let mut r = RateLimiter::new(5, Duration::from_secs(10));
        let t0 = Instant::now();
        for _ in 0..5 {
            assert!(r.allow("a", t0));
        }
        assert!(!r.allow("a", t0 + Duration::from_secs(9)));
        assert!(r.allow("b", t0), "keys are independent");
        assert!(r.allow("a", t0 + Duration::from_secs(10)));
        r.forget("a");
        for _ in 0..5 {
            assert!(r.allow("a", t0 + Duration::from_secs(10)));
        }
    }

    #[test]
    fn badges_report_changes_and_totals() {
        let mut b = Badges::default();
        assert!(b.set("a", Badge { unread: true, mentions: 2 }));
        assert!(!b.set("a", Badge { unread: true, mentions: 2 }));
        b.set("b", Badge { unread: false, mentions: 3 });
        assert_eq!(b.total_mentions(), 5);
        assert!(b.any_unread());
        b.remove("a");
        assert_eq!(b.get("a"), Badge::default());
        assert!(!b.any_unread());
    }
}
```

Run: `cargo test state` → Expected: FAIL (types not found).

- [ ] **Step 2: Implement `state.rs`**

```rust
//! Small state machines the shell runs on behalf of all server webviews. Pure, so they are unit tested.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

/// Which server webview is in a call. Only one call at a time across servers.
#[derive(Default)]
pub struct VoiceTracker {
    in_call: Option<String>,
}

impl VoiceTracker {
    /// Records a join or leave. Returns the webview that must leave because `label` joined.
    pub fn set(&mut self, label: &str, in_call: bool) -> Option<String> {
        if in_call {
            self.in_call.replace(label.to_string()).filter(|prev| prev != label)
        } else {
            self.forget(label);
            None
        }
    }

    pub fn forget(&mut self, label: &str) {
        if self.in_call.as_deref() == Some(label) {
            self.in_call = None;
        }
    }

    pub fn in_call(&self) -> Option<&str> {
        self.in_call.as_deref()
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PttUpdate {
    /// Global shortcut to unregister.
    pub unregister: Option<String>,
    /// Global shortcut to register.
    pub register: Option<String>,
    /// Webview that must receive `ptt { down: false }` because its held key stopped counting.
    pub release: Option<String>,
}

/// Owns the one global push-to-talk shortcut: the webview that set it gets its presses.
#[derive(Default)]
pub struct PttRouter {
    owner: Option<String>,
    key: Option<String>,
    down: bool,
}

impl PttRouter {
    /// `key: Some` makes `label` the owner of that key; `None` from the owner gives it up (others are ignored).
    pub fn set(&mut self, label: &str, key: Option<String>) -> PttUpdate {
        let is_owner = self.owner.as_deref() == Some(label);
        match key {
            None if !is_owner => PttUpdate::default(),
            None => {
                let release = self.take_release();
                self.owner = None;
                PttUpdate { unregister: self.key.take(), register: None, release }
            }
            Some(k) if is_owner && self.key.as_deref() == Some(k.as_str()) => PttUpdate::default(),
            Some(k) => {
                let release = if is_owner { None } else { self.take_release() };
                if is_owner {
                    self.down = false;
                }
                self.owner = Some(label.to_string());
                PttUpdate { unregister: self.key.replace(k.clone()), register: Some(k), release }
            }
        }
    }

    fn take_release(&mut self) -> Option<String> {
        let held = std::mem::take(&mut self.down);
        if held { self.owner.clone() } else { None }
    }

    /// A press or release of the global shortcut. Returns where to send it, only when the state changes.
    pub fn press(&mut self, pressed: bool) -> Option<(String, bool)> {
        let owner = self.owner.clone()?;
        if pressed == self.down {
            return None;
        }
        self.down = pressed;
        Some((owner, pressed))
    }
}

/// At most `max` calls per `window`, per key (a server id).
pub struct RateLimiter {
    max: usize,
    window: Duration,
    hits: HashMap<String, VecDeque<Instant>>,
}

impl RateLimiter {
    pub fn new(max: usize, window: Duration) -> Self {
        Self { max, window, hits: HashMap::new() }
    }

    pub fn allow(&mut self, key: &str, now: Instant) -> bool {
        let q = self.hits.entry(key.to_string()).or_default();
        while q.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            q.pop_front();
        }
        if q.len() >= self.max {
            return false;
        }
        q.push_back(now);
        true
    }

    pub fn forget(&mut self, key: &str) {
        self.hits.remove(key);
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Badge {
    pub unread: bool,
    pub mentions: u32,
}

/// Unread state per server id, as reported by each page.
#[derive(Default)]
pub struct Badges(HashMap<String, Badge>);

impl Badges {
    pub fn set(&mut self, id: &str, b: Badge) -> bool {
        self.0.insert(id.to_string(), b) != Some(b)
    }

    pub fn get(&self, id: &str) -> Badge {
        self.0.get(id).copied().unwrap_or_default()
    }

    pub fn remove(&mut self, id: &str) {
        self.0.remove(id);
    }

    pub fn total_mentions(&self) -> u32 {
        self.0.values().map(|b| b.mentions).sum()
    }

    pub fn any_unread(&self) -> bool {
        self.0.values().any(|b| b.unread || b.mentions > 0)
    }
}
```

Note `ptt_releases_the_old_owner_when_ownership_moves_while_held`: after the handoff `down` is false (cleared by `take_release`) so the next `press(false)` returns `None`.

Add `#![allow(dead_code)]` at the top of `state.rs` until Task 5 uses everything (remove it then).

- [ ] **Step 3: Run tests**

Run: `cargo test state && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → Expected: 7 PASS, clean.

- [ ] **Step 4: Stage** — `git add clients/desktop/src-tauri/src`

---

### Task 3: Window, rail and server webviews; rail commands

**Files:**
- Create: `clients/desktop/src-tauri/src/shell.rs`, `clients/desktop/src-tauri/src/commands.rs`
- Modify: `clients/desktop/src-tauri/src/lib.rs`, `servers.rs` / `state.rs` (drop the `dead_code` allows once used)

**Interfaces:**
- Consumes: Task 1 `Store`, `normalize_address`, `probe`, `navigation_allowed`, `host_of`; Task 2 `Badges`, `VoiceTracker`, `PttRouter`, `RateLimiter`.
- Produces:
  - `pub const RAIL: &str = "rail"`, `pub const RAIL_WIDTH: f64 = 72.0`, `pub fn server_label(id: &str) -> String` (`server-<id>`), `pub fn server_id(label: &str) -> Option<&str>`
  - `pub struct Shell(pub Mutex<Inner>)` managed state; `Inner { store, path, data_root, selected, expanded, offline: HashSet<String>, badges, voice, ptt, limiter, update_ready }`
  - `#[serde(rename_all = "camelCase")] RailServer { id, url, name, icon, unread, mentions, online }`, `RailState { servers, selected, update_ready }`
  - `shell::create_main_window(app, hidden: bool)`, `shell::layout(app)`, `shell::apply_visibility(app)`, `shell::emit_rail_state(app)`, `shell::add_server_webview(app, &Server)`, `shell::select(app, id)`, `shell::rail_state(&Inner) -> RailState`, `shell::server_browser_args() -> Option<&'static str>`, `shell::purge_orphan_data(data_root, &Store)`
  - Rail commands: `servers_list() -> RailState`, `server_add(address: String) -> Result<RailState, String>`, `server_remove(id: String)`, `servers_reorder(ids: Vec<String>)`, `server_select(id: String)`, `rail_expand(expanded: bool)`, `server_retry(id: String) -> Result<(), String>`
  - Events: `rail_state` (to `rail`, payload `RailState`), `visible` (to a server webview, payload `{ "visible": bool }`).

- [ ] **Step 1: Write the failing tests** — test module at the bottom of `shell.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_round_trip() {
        assert_eq!(server_label("abc"), "server-abc");
        assert_eq!(server_id("server-abc"), Some("abc"));
        assert_eq!(server_id("rail"), None);
    }

    #[test]
    fn rail_state_merges_badges_and_offline() {
        let mut inner = Inner::new(Store::default(), "x/servers.json".into(), "x/webviews".into());
        let a = inner.store.add("https://a.example".into(), "A".into()).unwrap();
        let b = inner.store.add("https://b.example".into(), "B".into()).unwrap();
        inner.badges.set(&a.id, crate::state::Badge { unread: true, mentions: 3 });
        inner.offline.insert(b.id.clone());
        inner.selected = Some(b.id.clone());
        let s = rail_state(&inner);
        assert_eq!(s.selected.as_deref(), Some(b.id.as_str()));
        assert_eq!((s.servers[0].unread, s.servers[0].mentions, s.servers[0].online), (true, 3, true));
        assert!(!s.servers[1].online);
        let json = serde_json::to_value(&s).unwrap();
        assert!(json.get("updateReady").is_some(), "camelCase for the rail");
    }

    #[test]
    fn hidden_webviews_are_not_throttled() {
        if cfg!(windows) {
            let args = server_browser_args().unwrap();
            assert!(args.contains("--disable-background-timer-throttling"));
            assert!(args.contains("--disable-renderer-backgrounding"));
            assert!(args.contains("--disable-backgrounding-occluded-windows"));
            assert!(args.contains("msWebOOUI"), "keeps Tauri's default WebView2 flags");
        } else {
            assert!(server_browser_args().is_none());
        }
    }

    #[test]
    fn purges_data_dirs_of_removed_servers() {
        let root = std::env::temp_dir().join(format!("datrope-wv-{}", uuid::Uuid::new_v4()));
        let mut store = Store::default();
        let keep = store.add("https://a.example".into(), "A".into()).unwrap();
        std::fs::create_dir_all(root.join(&keep.id)).unwrap();
        std::fs::create_dir_all(root.join("gone")).unwrap();
        purge_orphan_data(&root, &store);
        assert!(root.join(&keep.id).exists());
        assert!(!root.join("gone").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
```

Run: `cargo test shell` → Expected: FAIL (compile errors).

- [ ] **Step 2: Implement `shell.rs`**

```rust
//! The main window: the rail on the left and one child webview per server, only the selected one visible.

use crate::servers::{host_of, navigation_allowed, Server, Store};
use crate::state::{Badges, PttRouter, RateLimiter, VoiceTracker};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, Window};

pub const RAIL: &str = "rail";
pub const MAIN: &str = "main";
pub const RAIL_WIDTH: f64 = 72.0;

pub fn server_label(id: &str) -> String {
    format!("server-{id}")
}

pub fn server_id(label: &str) -> Option<&str> {
    label.strip_prefix("server-")
}

pub struct Inner {
    pub store: Store,
    pub path: PathBuf,
    /// One data directory per server id below this, so cookies never mix.
    pub data_root: PathBuf,
    pub selected: Option<String>,
    /// The rail covers the whole window (add dialog, remove confirmation, or no servers yet).
    pub expanded: bool,
    pub offline: HashSet<String>,
    pub badges: Badges,
    pub voice: VoiceTracker,
    pub ptt: PttRouter,
    pub limiter: RateLimiter,
    pub update_ready: bool,
    /// The server webview that last got `visible: true`.
    pub visible: Option<String>,
}

impl Inner {
    pub fn new(store: Store, path: PathBuf, data_root: PathBuf) -> Self {
        let selected = store.servers.first().map(|s| s.id.clone());
        Self {
            store,
            path,
            data_root,
            selected,
            expanded: false,
            offline: HashSet::new(),
            badges: Badges::default(),
            voice: VoiceTracker::default(),
            ptt: PttRouter::default(),
            limiter: RateLimiter::new(5, Duration::from_secs(10)),
            update_ready: false,
            visible: None,
        }
    }

    pub fn save(&self) {
        if let Err(e) = self.store.save(&self.path) {
            eprintln!("saving {}: {e}", self.path.display());
        }
    }
}

pub struct Shell(pub Mutex<Inner>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailServer {
    pub id: String,
    pub url: String,
    pub name: String,
    pub icon: Option<String>,
    pub unread: bool,
    pub mentions: u32,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailState {
    pub servers: Vec<RailServer>,
    pub selected: Option<String>,
    pub update_ready: bool,
}

pub fn rail_state(inner: &Inner) -> RailState {
    RailState {
        servers: inner
            .store
            .servers
            .iter()
            .map(|s| {
                let b = inner.badges.get(&s.id);
                RailServer {
                    id: s.id.clone(),
                    url: s.url.clone(),
                    name: s.name.clone(),
                    icon: s.icon.clone(),
                    unread: b.unread,
                    mentions: b.mentions,
                    online: !inner.offline.contains(&s.id),
                }
            })
            .collect(),
        selected: inner.selected.clone(),
        update_ready: inner.update_ready,
    }
}

pub fn emit_rail_state(app: &AppHandle) {
    let state = rail_state(&app.state::<Shell>().0.lock().unwrap());
    let _ = app.emit_to(EventTarget::webview(RAIL), "rail_state", state);
}

/// Chromium flags for server webviews on Windows: Tauri's defaults plus no background throttling, so a hidden
/// server keeps its gateway heartbeat and voice running.
pub fn server_browser_args() -> Option<&'static str> {
    if cfg!(windows) {
        Some(concat!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
            "--disable-background-timer-throttling --disable-renderer-backgrounding ",
            "--disable-backgrounding-occluded-windows"
        ))
    } else {
        None
    }
}

/// Deletes data directories that belong to no server (left over when deleting failed while a webview held files).
pub fn purge_orphan_data(data_root: &Path, store: &Store) {
    let Ok(entries) = std::fs::read_dir(data_root) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if store.get(&name).is_none() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn main_window(app: &AppHandle) -> Option<Window> {
    app.get_window(MAIN)
}

fn content_size(window: &Window) -> tauri::Result<LogicalSize<f64>> {
    Ok(window.inner_size()?.to_logical(window.scale_factor()?))
}

pub fn create_main_window(app: &AppHandle, hidden: bool) -> tauri::Result<()> {
    let window = tauri::window::WindowBuilder::new(app, MAIN)
        .title("Datrope")
        .inner_size(1280.0, 800.0)
        .min_inner_size(720.0, 480.0)
        .visible(!hidden)
        .build()?;
    let size = content_size(&window)?;
    window.add_child(
        WebviewBuilder::new(RAIL, WebviewUrl::App("index.html".into())),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(RAIL_WIDTH, size.height),
    )?;
    let servers = app.state::<Shell>().0.lock().unwrap().store.servers.clone();
    for s in &servers {
        add_server_webview(app, s)?;
    }
    layout(app)?;
    apply_visibility(app);
    Ok(())
}

fn add_server_capability(app: &AppHandle, label: &str, origin: &str) -> tauri::Result<()> {
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new(label)
            .remote(format!("{origin}/*"))
            .webview(label)
            .permission("core:event:default")
            .permission("allow-desktop-notify")
            .permission("allow-desktop-set-unread")
            .permission("allow-desktop-voice-state")
            .permission("allow-desktop-ptt-set-key")
            .permission("allow-desktop-server-info"),
    )
}

pub fn offline_url(app: &AppHandle, s: &Server) -> Option<Url> {
    let rail = app.get_webview(RAIL)?;
    let mut url = rail.url().ok()?.join("offline.html").ok()?;
    url.query_pairs_mut().append_pair("id", &s.id).append_pair("host", &host_of(&s.url));
    Some(url)
}

/// Adds the webview for one server, loading the server's own web app. It starts hidden; `apply_visibility` shows it.
pub fn add_server_webview(app: &AppHandle, s: &Server) -> tauri::Result<()> {
    let Some(window) = main_window(app) else { return Ok(()) };
    let label = server_label(&s.id);
    let origin = s.url.clone();
    let url: Url = origin.parse().map_err(|e: url::ParseError| tauri::Error::Anyhow(e.into()))?;
    add_server_capability(app, &label, &origin)?;

    let data_root = app.state::<Shell>().0.lock().unwrap().data_root.clone();
    let nav_origin = origin.clone();
    let mut b = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |target| {
            let ok = navigation_allowed(&nav_origin, target);
            if !ok {
                open_external(target);
            }
            ok
        })
        .on_new_window(|target, _features| {
            open_external(&target);
            NewWindowResponse::Deny
        });
    if let Some(args) = server_browser_args() {
        b = b.additional_browser_args(args);
    }
    #[cfg(target_os = "macos")]
    {
        let id = uuid::Uuid::parse_str(&s.id).map_err(|e| tauri::Error::Anyhow(e.into()))?;
        b = b.data_store_identifier(*id.as_bytes());
    }
    #[cfg(not(target_os = "macos"))]
    {
        b = b.data_directory(data_root.join(&s.id));
    }

    let size = content_size(&window)?;
    let wv = window.add_child(
        b,
        LogicalPosition::new(RAIL_WIDTH, 0.0),
        LogicalSize::new((size.width - RAIL_WIDTH).max(0.0), size.height),
    )?;
    wv.hide()?;
    spawn_probe(app.clone(), s.clone());
    Ok(())
}

fn open_external(target: &Url) {
    if matches!(target.scheme(), "http" | "https" | "mailto") {
        let _ = tauri_plugin_opener::open_url(target.as_str(), None::<&str>);
    }
}

/// Checks the server answers; if not, shows the offline page in its webview and greys out its rail icon.
pub fn spawn_probe(app: AppHandle, s: Server) {
    tauri::async_runtime::spawn(async move {
        let online = crate::servers::probe(&s.url).await.is_ok();
        {
            let shell = app.state::<Shell>();
            let mut inner = shell.0.lock().unwrap();
            if online { inner.offline.remove(&s.id) } else { inner.offline.insert(s.id.clone()) };
        }
        if !online {
            if let (Some(wv), Some(url)) = (app.get_webview(&server_label(&s.id)), offline_url(&app, &s)) {
                let _ = wv.navigate(url);
            }
        }
        emit_rail_state(&app);
    });
}

/// Sizes the rail (72 px, or the whole window when expanded) and every server webview (the rest).
pub fn layout(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = main_window(app) else { return Ok(()) };
    let size = content_size(&window)?;
    let expanded = {
        let inner = app.state::<Shell>().0.lock().unwrap();
        inner.expanded || inner.store.servers.is_empty()
    };
    for wv in window.webviews() {
        if wv.label() == RAIL {
            wv.set_position(LogicalPosition::new(0.0, 0.0))?;
            wv.set_size(LogicalSize::new(if expanded { size.width } else { RAIL_WIDTH }, size.height))?;
        } else {
            wv.set_position(LogicalPosition::new(RAIL_WIDTH, 0.0))?;
            wv.set_size(LogicalSize::new((size.width - RAIL_WIDTH).max(0.0), size.height))?;
        }
    }
    Ok(())
}

/// Shows the selected server's webview and hides the others (all of them while the rail is expanded), and tells
/// pages when they become visible or hidden (the notification focus check uses it).
pub fn apply_visibility(app: &AppHandle) {
    let (show, previous) = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        let show = if inner.expanded { None } else { inner.selected.as_deref().map(server_label) };
        let previous = std::mem::replace(&mut inner.visible, show.clone());
        (show, previous)
    };
    let Some(window) = main_window(app) else { return };
    for wv in window.webviews() {
        if wv.label() == RAIL {
            continue;
        }
        let visible = show.as_deref() == Some(wv.label());
        let _ = if visible { wv.show() } else { wv.hide() };
    }
    if previous != show {
        if let Some(p) = previous {
            let _ = app.emit_to(EventTarget::webview(&p), "visible", serde_json::json!({ "visible": false }));
        }
        if let Some(s) = &show {
            let _ = app.emit_to(EventTarget::webview(s), "visible", serde_json::json!({ "visible": true }));
            if let Some(wv) = app.get_webview(s) {
                let _ = wv.set_focus();
            }
        }
    }
}

pub fn select(app: &AppHandle, id: &str) {
    {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if inner.store.get(id).is_none() {
            return;
        }
        inner.selected = Some(id.to_string());
    }
    apply_visibility(app);
    emit_rail_state(app);
}

pub fn show_window(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
```

> If the compiler reports a different name for `on_new_window` / `NewWindowResponse`, `background_throttling`, `data_store_identifier` or `Webview::hide/show` in tauri 2.12, check `cargo doc -p tauri --open` (search `WebviewBuilder`) and adapt the call; keep the behaviour.

- [ ] **Step 3: Implement the rail and offline commands** — `commands.rs`

```rust
//! Commands the rail, the offline page and the server pages call. Each checks who is calling, on top of the
//! capability that already limits which webview may call it.

use crate::servers::{host_of, normalize_address, probe, AddError};
use crate::shell::{self, server_id, server_label, RailState, Shell, RAIL};
use tauri::{AppHandle, Manager, Webview};

fn only_rail(webview: &Webview) -> Result<(), String> {
    if webview.label() == RAIL { Ok(()) } else { Err("not allowed".into()) }
}

#[tauri::command]
pub fn servers_list(app: AppHandle, webview: Webview) -> Result<RailState, String> {
    only_rail(&webview)?;
    Ok(shell::rail_state(&app.state::<Shell>().0.lock().unwrap()))
}

#[tauri::command]
pub async fn server_add(app: AppHandle, webview: Webview, address: String) -> Result<RailState, String> {
    only_rail(&webview)?;
    let origin = normalize_address(&address, cfg!(debug_assertions)).map_err(|e| e.message().to_string())?;
    if app.state::<Shell>().0.lock().unwrap().store.servers.iter().any(|s| s.url == origin) {
        return Err(AddError::Duplicate.message().into());
    }
    probe(&origin).await.map_err(|e| e.message().to_string())?;
    let server = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        let s = inner.store.add(origin.clone(), host_of(&origin)).map_err(|e| e.message().to_string())?;
        inner.save();
        inner.selected = Some(s.id.clone());
        inner.expanded = false;
        s
    };
    shell::add_server_webview(&app, &server).map_err(|e| e.to_string())?;
    shell::layout(&app).map_err(|e| e.to_string())?;
    shell::apply_visibility(&app);
    shell::emit_rail_state(&app);
    Ok(shell::rail_state(&app.state::<Shell>().0.lock().unwrap()))
}

#[tauri::command]
pub fn server_remove(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    only_rail(&webview)?;
    let label = server_label(&id);
    let dir = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if inner.store.remove(&id).is_none() {
            return Ok(());
        }
        inner.save();
        inner.badges.remove(&id);
        inner.offline.remove(&id);
        inner.limiter.forget(&id);
        inner.voice.forget(&label);
        let update = inner.ptt.set(&label, None);
        if let Some(key) = update.unregister {
            crate::ptt::unregister(&app, &key);
        }
        if inner.selected.as_deref() == Some(id.as_str()) {
            inner.selected = inner.store.servers.first().map(|s| s.id.clone());
        }
        inner.expanded = false;
        inner.data_root.join(&id)
    };
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.close();
    }
    remove_data_later(&app, &id, dir);
    let _ = shell::layout(&app);
    shell::apply_visibility(&app);
    shell::emit_rail_state(&app);
    crate::tray::refresh(&app);
    Ok(())
}

/// The closed webview's browser process may still hold its files for a moment: retry for a few seconds. Anything
/// left is removed on the next start (`purge_orphan_data`).
fn remove_data_later(app: &AppHandle, id: &str, dir: std::path::PathBuf) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(uuid) = uuid::Uuid::parse_str(id) {
            app.remove_data_store(*uuid.as_bytes(), |_| {});
        }
    }
    let _ = (app, id);
    std::thread::spawn(move || {
        for _ in 0..20 {
            if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

#[tauri::command]
pub fn servers_reorder(app: AppHandle, webview: Webview, ids: Vec<String>) -> Result<(), String> {
    only_rail(&webview)?;
    {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if inner.store.reorder(&ids) {
            inner.save();
        }
    }
    shell::emit_rail_state(&app);
    Ok(())
}

#[tauri::command]
pub fn server_select(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    only_rail(&webview)?;
    shell::select(&app, &id);
    Ok(())
}

#[tauri::command]
pub fn rail_expand(app: AppHandle, webview: Webview, expanded: bool) -> Result<(), String> {
    only_rail(&webview)?;
    app.state::<Shell>().0.lock().unwrap().expanded = expanded;
    shell::layout(&app).map_err(|e| e.to_string())?;
    shell::apply_visibility(&app);
    Ok(())
}

/// "Retry" on the offline page: load the server again if it answers now.
#[tauri::command]
pub async fn server_retry(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    if server_id(webview.label()) != Some(id.as_str()) {
        return Err("not allowed".into());
    }
    let url = app.state::<Shell>().0.lock().unwrap().store.get(&id).map(|s| s.url.clone()).ok_or("unknown server")?;
    probe(&url).await.map_err(|e| e.message().to_string())?;
    app.state::<Shell>().0.lock().unwrap().offline.remove(&id);
    webview.navigate(url.parse().map_err(|_| "bad url")?).map_err(|e| e.to_string())?;
    shell::emit_rail_state(&app);
    Ok(())
}
```

`server_remove` references `crate::ptt::unregister` and `crate::tray::refresh`, which Task 5/6 create. For this task, add minimal stubs so it compiles: `src/ptt.rs` with `pub fn unregister(_app: &tauri::AppHandle, _key: &str) {}` and `src/tray.rs` with `pub fn refresh(_app: &tauri::AppHandle) {}`. Tasks 5 and 6 replace them.

> `app.remove_data_store` is macOS-only; if its name/signature differs in tauri 2.12, check docs.rs and adapt. macOS is not built locally — the release workflow (Task 9) is the first macOS compile.

- [ ] **Step 4: Wire `lib.rs`**

```rust
mod commands;
mod ptt;
mod servers;
mod shell;
mod state;
mod tray;

use shell::{Inner, Shell};
use std::sync::Mutex;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config = app.path().app_config_dir()?;
            let data_root = app.path().app_local_data_dir()?.join("webviews");
            let path = config.join("servers.json");
            let store = servers::Store::load(&path);
            shell::purge_orphan_data(&data_root, &store);
            app.manage(Shell(Mutex::new(Inner::new(store, path, data_root))));
            let hidden = std::env::args().any(|a| a == "--hidden");
            shell::create_main_window(app.handle(), hidden)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Resized(_) = event {
                let _ = shell::layout(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::servers_list,
            commands::server_add,
            commands::server_remove,
            commands::servers_reorder,
            commands::server_select,
            commands::rail_expand,
            commands::server_retry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Datrope");
}
```

Remove the `#![allow(dead_code)]` from `servers.rs`; keep it in `state.rs` until Task 5.

- [ ] **Step 5: Run tests and lints**

Run: `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → Expected: all PASS (17 tests), clean.

- [ ] **Step 6: Manual check**

Start the dev server (`datrope-server` on :8081) and web (`datrope-web` on :5173) from `.claude/launch.json`, then `pnpm --filter @datrope/desktop dev`. The rail placeholder fills the window (no servers → expanded). Temporarily test the add command from the rail devtools console (right-click → Inspect): `await window.__TAURI_INTERNALS__.invoke("server_add", { address: "http://localhost:5173" })` → the web app appears right of a 72 px strip; signing in works and survives an app restart (cookies in `%LOCALAPPDATA%\chat.datrope.desktop\webviews\<id>`). Clicking a Markdown link to another site opens the system browser. Take a screenshot as proof.

- [ ] **Step 7: Stage** — `git add clients/desktop/src-tauri`

---

### Task 4: Rail UI and offline page

**Files:**
- Create: `clients/desktop/src/rail-api.ts`, `src/order.ts`, `src/order.test.ts`, `src/Rail.tsx`, `src/AddServerDialog.tsx`
- Modify: `clients/desktop/src/main.tsx`, `src/offline.tsx`

**Interfaces:**
- Consumes: Task 3 commands/events (`servers_list`, `server_add`, `server_remove`, `servers_reorder`, `server_select`, `rail_expand`, `server_retry`, event `rail_state`); `update_restart` (Task 9; the button only shows when `updateReady`).
- Produces: `moveId(ids: string[], active: string, over: string): string[]`, `serverInitials(name: string): string`, `mentionLabel(n: number): string`.

- [ ] **Step 1: Write the failing tests** — `clients/desktop/src/order.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { mentionLabel, moveId, serverInitials } from "./order";

describe("moveId", () => {
  it("moves an id to where another one was", () => {
    expect(moveId(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveId(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });
  it("leaves the order alone for unknown or identical ids", () => {
    expect(moveId(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(moveId(["a", "b"], "x", "a")).toEqual(["a", "b"]);
  });
});

describe("serverInitials", () => {
  it("uses up to two initials, falling back to the host", () => {
    expect(serverInitials("Friends of Datrope")).toBe("FO");
    expect(serverInitials("chat.example.com")).toBe("C");
    expect(serverInitials("  ")).toBe("?");
  });
});

describe("mentionLabel", () => {
  it("caps at 99+", () => {
    expect(mentionLabel(3)).toBe("3");
    expect(mentionLabel(120)).toBe("99+");
  });
});
```

Run: `pnpm --filter @datrope/desktop test` → Expected: FAIL (module not found).

- [ ] **Step 2: Implement `order.ts`**

```ts
/** Moves `active` to the position of `over` (drag and drop in the rail). */
export function moveId(ids: string[], active: string, over: string): string[] {
  const from = ids.indexOf(active);
  const to = ids.indexOf(over);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Up to two initials for a server without an icon. A host like "chat.example.com" gives "C". */
export function serverInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words.slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

export const mentionLabel = (n: number) => (n > 99 ? "99+" : String(n));
```

Run tests → Expected: PASS.

- [ ] **Step 3: `rail-api.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface RailServer {
  id: string;
  url: string;
  name: string;
  icon?: string | null;
  unread: boolean;
  mentions: number;
  online: boolean;
}

export interface RailState {
  servers: RailServer[];
  selected: string | null;
  updateReady: boolean;
}

export const listServers = () => invoke<RailState>("servers_list");
export const addServer = (address: string) => invoke<RailState>("server_add", { address });
export const removeServer = (id: string) => invoke<void>("server_remove", { id });
export const reorderServers = (ids: string[]) => invoke<void>("servers_reorder", { ids });
export const selectServer = (id: string) => invoke<void>("server_select", { id });
export const expandRail = (expanded: boolean) => invoke<void>("rail_expand", { expanded });
export const restartToUpdate = () => invoke<void>("update_restart");

export function onRailState(cb: (s: RailState) => void): () => void {
  let stop: (() => void) | undefined;
  let stopped = false;
  void getCurrentWebview().listen<RailState>("rail_state", (e) => cb(e.payload)).then((un) => {
    if (stopped) un();
    else stop = un;
  });
  return () => {
    stopped = true;
    stop?.();
  };
}
```

- [ ] **Step 4: `AddServerDialog.tsx`** — one form, shown inline when there are no servers and in a `Dialog` otherwise

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addServer } from "./rail-api";

export function AddServerForm({ onAdded }: { onAdded: () => void }) {
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await addServer(address);
      setAddress("");
      onAdded();
    } catch (err) {
      setError(typeof err === "string" ? err : "Couldn't add the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="server-address">Server address</Label>
        <Input id="server-address" autoFocus placeholder="chat.example.com" value={address}
          onChange={(e) => setAddress(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "server-address-error" : undefined} />
        {error && <p id="server-address-error" role="alert" className="m-0 text-sm text-destructive">{error}</p>}
      </div>
      <Button type="submit" disabled={busy || !address.trim()}>{busy ? "Checking…" : "Add server"}</Button>
    </form>
  );
}

export function AddServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>Enter the address of a Datrope server. You sign in on the next screen.</DialogDescription>
        </DialogHeader>
        <AddServerForm onAdded={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: `Rail.tsx`**

The rail is only 72 px wide, so anything wider (the add dialog, the remove confirmation) first calls `expandRail(true)`; the shell then hides the server webview and widens the rail to the whole window. The right-click menu is a native Tauri menu, so it is never clipped.

```tsx
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Menu } from "@tauri-apps/api/menu";
import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { AddServerDialog, AddServerForm } from "./AddServerDialog";
import { mentionLabel, moveId, serverInitials } from "./order";
import {
  expandRail, listServers, onRailState, removeServer, reorderServers, restartToUpdate, selectServer,
  type RailServer, type RailState,
} from "./rail-api";

function ServerButton({ s, selected, onMenu }: { s: RailServer; selected: boolean; onMenu: (s: RailServer) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  const label = `${s.name}${s.mentions ? `, ${s.mentions} mentions` : s.unread ? ", unread messages" : ""}${s.online ? "" : ", can't reach"}`;
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("relative flex justify-center", isDragging && "z-10 opacity-80")}>
      <span aria-hidden className={cn("absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r bg-foreground transition-all",
        selected ? "h-10" : s.unread ? "h-2" : "h-0")} />
      <button type="button" aria-label={label} aria-current={selected ? "page" : undefined} title={s.name}
        onClick={() => void selectServer(s.id)}
        onContextMenu={(e) => { e.preventDefault(); onMenu(s); }}
        {...attributes} {...listeners}
        className={cn("relative size-12 overflow-visible rounded-2xl bg-card text-sm font-semibold text-foreground outline-none",
          "transition-[border-radius] hover:rounded-xl focus-visible:ring-2 focus-visible:ring-ring",
          selected && "rounded-xl bg-primary text-primary-foreground", !s.online && "opacity-50 grayscale")}>
        {s.icon ? <img src={s.icon} alt="" className="size-full rounded-[inherit] object-cover" /> : serverInitials(s.name)}
        {s.mentions > 0 && (
          <span aria-hidden className="absolute -right-1 -bottom-1 min-w-5 rounded-full border-2 border-sidebar bg-destructive px-1 text-[11px] leading-4 text-destructive-foreground">
            {mentionLabel(s.mentions)}
          </span>
        )}
      </button>
    </li>
  );
}

export function Rail() {
  const [state, setState] = useState<RailState>({ servers: [], selected: null, updateReady: false });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<RailServer>();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    void listServers().then(setState);
    return onRailState(setState);
  }, []);

  const empty = state.servers.length === 0;

  function openAdd(open: boolean) {
    setAdding(open);
    void expandRail(open);
  }

  function confirmRemove(s: RailServer | undefined) {
    setRemoving(s);
    void expandRail(!!s);
  }

  async function showMenu(s: RailServer) {
    const menu = await Menu.new({ items: [{ id: "remove", text: `Remove ${s.name}`, action: () => confirmRemove(s) }] });
    await menu.popup();
  }

  function dragEnd(e: DragEndEvent) {
    if (!e.over) return;
    const ids = moveId(state.servers.map((s) => s.id), String(e.active.id), String(e.over.id));
    const byId = new Map(state.servers.map((s) => [s.id, s]));
    setState({ ...state, servers: ids.map((id) => byId.get(id)!) });
    void reorderServers(ids);
  }

  return (
    <div className="flex h-full">
      <nav aria-label="Servers" className="flex h-full w-[72px] shrink-0 flex-col items-center gap-2 bg-sidebar py-3">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
          <SortableContext items={state.servers.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ul className="m-0 flex w-full list-none flex-col gap-2 p-0">
              {state.servers.map((s) => (
                <ServerButton key={s.id} s={s} selected={s.id === state.selected} onMenu={(x) => void showMenu(x)} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        {!empty && (
          <button type="button" aria-label="Add a server" title="Add a server" onClick={() => openAdd(true)}
            className="flex size-12 items-center justify-center rounded-2xl bg-card text-primary hover:rounded-xl hover:bg-primary hover:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <Plus className="size-5" />
          </button>
        )}
        <div className="grow" />
        {state.updateReady && (
          <button type="button" aria-label="Restart to update" title="Update ready — restart" onClick={() => void restartToUpdate()}
            className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <RefreshCw className="size-5" />
          </button>
        )}
      </nav>

      {empty && (
        <main className="flex grow items-center justify-center bg-background p-6">
          <div className="grid w-full max-w-sm gap-4">
            <h1 className="m-0 text-xl font-semibold text-foreground">Add your first server</h1>
            <p className="m-0 text-sm text-muted-foreground">Enter the address of a Datrope server, like chat.example.com.</p>
            <AddServerForm onAdded={() => undefined} />
          </div>
        </main>
      )}

      <AddServerDialog open={adding} onOpenChange={openAdd} />

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && confirmRemove(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>You'll be signed out of this server on this device. You can add it again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (removing) void removeServer(removing.id); setRemoving(undefined); }}>
              Remove server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

(`server_remove` un-expands the rail itself, so the action button only clears local state.)

`main.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { Rail } from "./Rail";
import "./rail.css";

createRoot(document.getElementById("root")!).render(<Rail />);
```

- [ ] **Step 6: Offline page** — `offline.tsx`

```tsx
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import "./rail.css";

function Offline() {
  const params = new URLSearchParams(location.search);
  const id = params.get("id") ?? "";
  const host = params.get("host") ?? "the server";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function retry() {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("server_retry", { id });
    } catch (e) {
      setError(typeof e === "string" ? e : "Still can't reach it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-full items-center justify-center bg-background p-6">
      <div className="grid max-w-sm gap-3 text-center">
        <h1 className="m-0 text-xl font-semibold text-foreground">Can't reach {host}</h1>
        <p className="m-0 text-sm text-muted-foreground">Check your connection, or whether the server is running.</p>
        {error && <p role="alert" className="m-0 text-sm text-destructive">{error}</p>}
        <Button onClick={() => void retry()} disabled={busy}>{busy ? "Trying…" : "Retry"}</Button>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Offline />);
```

`body` in `rail.css` uses the sidebar colour; the offline page's `<main>` covers it with `bg-background`.

- [ ] **Step 7: Checks**

Run: `pnpm --filter @datrope/desktop typecheck && pnpm --filter @datrope/desktop test && pnpm lint` → Expected: PASS.

- [ ] **Step 8: Manual check** (with the dev stack from Task 3)

1. Delete `%APPDATA%\chat.datrope.desktop\servers.json` → "Add your first server" fills the window. Typing `example.com` shows "That isn't a Datrope server." (or "Couldn't reach the server."); `http://localhost:5173` adds it and the web app appears.
2. "+" → the dialog opens over the whole window; Escape closes it and the server comes back.
3. Add a second server (`http://127.0.0.1:5173` counts as a separate origin) → two icons; drag one above the other; restart the app → the order is kept.
4. Right-click → "Remove …" → confirm → it disappears and its webview data directory is deleted.
5. Stop the web dev server and restart the app → the offline page shows "Can't reach localhost:5173" and the icon is greyed; start it again and press Retry → the app loads.
Screenshot the rail with two servers as proof.

- [ ] **Step 9: Stage** — `git add clients/desktop`

---

### Task 5: Server-page bridge in the shell (notifications, unread, voice, PTT, server info)

**Files:**
- Create: `clients/desktop/src-tauri/src/notify.rs`
- Modify: `clients/desktop/src-tauri/src/ptt.rs` (replace stub), `commands.rs`, `lib.rs`, `state.rs` (drop `dead_code` allow)

**Interfaces:**
- Consumes: Task 2 state machines; Task 3 `Shell`, `server_label`, `server_id`, `select`, `show_window`, `emit_rail_state`; `tray::refresh` (stub until Task 6).
- Produces (commands, called by server pages):
  - `desktop_notify(title: String, body: String, target: String) -> Result<(), String>`
  - `desktop_set_unread(unread: bool, mentions: u32)`
  - `desktop_voice_state(in_call: bool)` (JS arg `inCall`)
  - `desktop_ptt_set_key(key: Option<String>) -> Result<(), String>` (error text when the key can't be registered globally)
  - `desktop_server_info(name: String, icon: Option<String>)`
  - Events to server pages: `ptt {down}`, `leave_voice`, `open_notification {target}`
  - `notify::sanitize_notification(title, body, target) -> Option<(String, String, String)>`, `commands::sanitize_server_info(name, icon) -> Option<(String, Option<String>)>`

- [ ] **Step 1: Write the failing tests**

In `notify.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifications_are_trimmed_and_targets_checked() {
        let (t, b, target) = sanitize_notification(" Alice in #general ", "hi", "123").unwrap();
        assert_eq!((t.as_str(), b.as_str(), target.as_str()), ("Alice in #general", "hi", "123"));
        let (t, b, _) = sanitize_notification(&"x".repeat(500), &"y".repeat(5000), "1").unwrap();
        assert_eq!(t.chars().count(), 120);
        assert_eq!(b.chars().count(), 300);
        assert!(sanitize_notification("", "body", "1").is_none(), "no title, no notification");
        assert!(sanitize_notification("t", "b", "javascript:alert(1)").is_none(), "targets are message ids");
        assert!(sanitize_notification("t", "b", &"9".repeat(40)).is_none());
    }
}
```

In `commands.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_info_is_capped() {
        assert_eq!(sanitize_server_info(" Friends ", None), Some(("Friends".into(), None)));
        assert_eq!(sanitize_server_info("", None), None);
        assert_eq!(sanitize_server_info(&"n".repeat(1000), None).unwrap().0.chars().count(), 100);
        let png = format!("data:image/png;base64,{}", "A".repeat(100));
        assert_eq!(sanitize_server_info("A", Some(png.clone())).unwrap().1, Some(png));
        assert_eq!(sanitize_server_info("A", Some("https://x/icon.png".into())).unwrap().1, None, "only data: images");
        let huge = format!("data:image/png;base64,{}", "A".repeat(400_000));
        assert_eq!(sanitize_server_info("A", Some(huge)).unwrap().1, None, "too big: dropped");
    }
}
```

Run: `cargo test notify commands` → Expected: FAIL.

- [ ] **Step 2: `notify.rs`**

```rust
//! Native notifications for server pages. On Windows a click opens the message's channel; on macOS and Linux a
//! click only brings the app forward.

use tauri::{AppHandle, Emitter, EventTarget};

const MAX_TITLE: usize = 120;
const MAX_BODY: usize = 300;

fn cap(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

/// Caps what a page asks to show. `target` is the message id the page wants back on click.
pub fn sanitize_notification(title: &str, body: &str, target: &str) -> Option<(String, String, String)> {
    let title = cap(title, MAX_TITLE);
    if title.is_empty() || target.is_empty() || target.len() > 32 || !target.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((title, cap(body, MAX_BODY), target.to_string()))
}

/// Brings the app forward on that server and tells its page which notification was clicked.
pub fn open(app: &AppHandle, server_id: &str, target: &str) {
    crate::shell::show_window(app);
    crate::shell::select(app, server_id);
    let _ = app.emit_to(
        EventTarget::webview(crate::shell::server_label(server_id)),
        "open_notification",
        serde_json::json!({ "target": target }),
    );
}

#[cfg(windows)]
pub fn show(app: &AppHandle, server_id: &str, server_name: &str, title: &str, body: &str, target: &str) -> Result<(), String> {
    use tauri_winrt_notification::Toast;
    // Installed builds are registered under the bundle identifier; `tauri dev` borrows PowerShell's.
    let app_id = if tauri::is_dev() { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
    let (app2, id, target) = (app.clone(), server_id.to_string(), target.to_string());
    Toast::new(&app_id)
        .title(title)
        .text1(body)
        .text2(server_name)
        .on_activated(move |_action| {
            open(&app2, &id, &target);
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub fn show(app: &AppHandle, _server_id: &str, server_name: &str, title: &str, body: &str, _target: &str) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(format!("{title} · {server_name}"))
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}
```

> If `tauri-winrt-notification` 0.8's `on_activated` closure signature differs (e.g. takes `Option<String>` and returns `windows::core::Result<()>`), match it; `Ok(())` stays the body's last line.

- [ ] **Step 3: `ptt.rs`** (replaces the stub)

```rust
//! The global push-to-talk shortcut, registered only while a server page is in a call with push-to-talk on.

use crate::shell::Shell;
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The plugin's handler: every press/release of the registered shortcut lands here.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            let pressed = event.state() == ShortcutState::Pressed;
            let routed = app.state::<Shell>().0.lock().unwrap().ptt.press(pressed);
            if let Some((label, down)) = routed {
                let _ = app.emit_to(EventTarget::webview(&label), "ptt", serde_json::json!({ "down": down }));
            }
        })
        .build()
}

pub fn register(app: &AppHandle, key: &str) -> Result<(), String> {
    app.global_shortcut().register(key).map_err(|e| e.to_string())
}

pub fn unregister(app: &AppHandle, key: &str) {
    let _ = app.global_shortcut().unregister(key);
}

pub fn release(app: &AppHandle, label: &str) {
    let _ = app.emit_to(EventTarget::webview(label), "ptt", serde_json::json!({ "down": false }));
}
```

- [ ] **Step 4: Server-page commands** — append to `commands.rs`

```rust
use crate::state::Badge;

fn caller(webview: &Webview) -> Result<String, String> {
    server_id(webview.label()).map(str::to_string).ok_or_else(|| "not allowed".into())
}

const MAX_NAME: usize = 100;
const MAX_ICON: usize = 300_000; // characters of the data: URL (~220 KB of image)

pub fn sanitize_server_info(name: &str, icon: Option<String>) -> Option<(String, Option<String>)> {
    let name: String = name.trim().chars().take(MAX_NAME).collect();
    if name.is_empty() {
        return None;
    }
    let icon = icon.filter(|i| i.starts_with("data:image/") && i.len() <= MAX_ICON);
    Some((name, icon))
}

#[tauri::command]
pub fn desktop_notify(app: AppHandle, webview: Webview, title: String, body: String, target: String) -> Result<(), String> {
    let id = caller(&webview)?;
    let Some((title, body, target)) = crate::notify::sanitize_notification(&title, &body, &target) else {
        return Ok(());
    };
    let server_name = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if !inner.limiter.allow(&id, std::time::Instant::now()) {
            return Ok(());
        }
        inner.store.get(&id).map(|s| s.name.clone()).unwrap_or_default()
    };
    crate::notify::show(&app, &id, &server_name, &title, &body, &target)
}

#[tauri::command]
pub fn desktop_set_unread(app: AppHandle, webview: Webview, unread: bool, mentions: u32) -> Result<(), String> {
    let id = caller(&webview)?;
    let changed = app.state::<Shell>().0.lock().unwrap().badges.set(&id, Badge { unread, mentions: mentions.min(9999) });
    if changed {
        shell::emit_rail_state(&app);
        crate::tray::refresh(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_voice_state(app: AppHandle, webview: Webview, in_call: bool) -> Result<(), String> {
    caller(&webview)?;
    let leave = app.state::<Shell>().0.lock().unwrap().voice.set(webview.label(), in_call);
    if let Some(label) = leave {
        let _ = app.emit_to(tauri::EventTarget::webview(&label), "leave_voice", ());
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_ptt_set_key(app: AppHandle, webview: Webview, key: Option<String>) -> Result<(), String> {
    caller(&webview)?;
    let label = webview.label().to_string();
    let update = app.state::<Shell>().0.lock().unwrap().ptt.set(&label, key);
    if let Some(l) = &update.release {
        crate::ptt::release(&app, l);
    }
    if let Some(k) = &update.unregister {
        crate::ptt::unregister(&app, k);
    }
    if let Some(k) = &update.register {
        if let Err(e) = crate::ptt::register(&app, k) {
            app.state::<Shell>().0.lock().unwrap().ptt.set(&label, None);
            return Err(e);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_server_info(app: AppHandle, webview: Webview, name: String, icon: Option<String>) -> Result<(), String> {
    let id = caller(&webview)?;
    let Some((name, icon)) = sanitize_server_info(&name, icon) else { return Ok(()) };
    let changed = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        let Some(s) = inner.store.get_mut(&id) else { return Ok(()) };
        let changed = s.name != name || s.icon != icon;
        s.name = name;
        s.icon = icon;
        if changed {
            inner.save();
        }
        changed
    };
    if changed {
        shell::emit_rail_state(&app);
    }
    Ok(())
}
```

Note in `desktop_ptt_set_key`: when registering fails, `ptt.set(&label, None)` returns an update asking to unregister the failed key; unregistering a key that was never registered is harmless, so the returned update is ignored there.

- [ ] **Step 5: Wire `lib.rs`** — add `mod notify;`, register plugins and commands:

```rust
        .plugin(tauri_plugin_notification::init())
        .plugin(ptt::plugin())
```

and add to `generate_handler!`: `commands::desktop_notify, commands::desktop_set_unread, commands::desktop_voice_state, commands::desktop_ptt_set_key, commands::desktop_server_info`. Remove `#![allow(dead_code)]` from `state.rs`.

- [ ] **Step 6: Run** `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → Expected: PASS (19 tests), clean.

- [ ] **Step 7: Manual check** — from a server webview's devtools console (right-click → Inspect in the web app):
  - `await window.__TAURI_INTERNALS__.invoke("desktop_notify", { title: "Test", body: "Hello", target: "1" })` → a Windows toast with the server name; clicking it focuses the app on that server.
  - Run it 8 times quickly → only 5 toasts.
  - `await window.__TAURI_INTERNALS__.invoke("desktop_set_unread", { unread: true, mentions: 4 })` → the rail icon shows "4".
  - `await window.__TAURI_INTERNALS__.invoke("desktop_ptt_set_key", { key: "F8" })` resolves; `{ key: "ShiftLeft" }` rejects with an error string.
  - In the rail's devtools, `invoke("desktop_notify", …)` is rejected (rail has no permission).

- [ ] **Step 8: Stage** — `git add clients/desktop/src-tauri`

---

### Task 6: Tray, close to tray, start on login, single instance, window state

**Files:**
- Modify: `clients/desktop/src-tauri/src/tray.rs` (replace stub), `lib.rs`

**Interfaces:**
- Consumes: Task 3 `Shell`, `show_window`, `MAIN`; Task 2 `Badges::any_unread`, `total_mentions`.
- Produces: `tray::build(app) -> tauri::Result<()>`, `tray::refresh(app)`, `tray::with_dot(rgba: &mut [u8], width: u32, height: u32)`, `tray::dot_icon(size: u32) -> Vec<u8>` (RGBA), `tray::on_close_requested(window, api)`.

- [ ] **Step 1: Write the failing tests** — in `tray.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn px(rgba: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * w + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    #[test]
    fn dot_is_painted_bottom_right_only() {
        let (w, h) = (32, 32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        with_dot(&mut rgba, w, h);
        assert_eq!(px(&rgba, w, 26, 26), DOT);
        assert_eq!(px(&rgba, w, 2, 2), [0, 0, 0, 0]);
    }

    #[test]
    fn overlay_icon_is_a_full_dot() {
        let rgba = dot_icon(16);
        assert_eq!(rgba.len(), 16 * 16 * 4);
        assert_eq!(px(&rgba, 16, 8, 8), DOT);
        assert_eq!(px(&rgba, 16, 0, 0)[3], 0, "corners stay transparent");
    }
}
```

Run: `cargo test tray` → Expected: FAIL.

- [ ] **Step 2: `tray.rs`**

```rust
//! The tray icon (with a dot for unread mentions), the taskbar/dock badge, and hiding to the tray on close.

use crate::shell::{show_window, Shell, MAIN};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

const TRAY: &str = "tray";
/// `--destructive` from clients/web/src/styles.css (#e74c3c).
pub const DOT: [u8; 4] = [0xe7, 0x4c, 0x3c, 0xff];

/// Paints a dot over the bottom-right third of an RGBA image.
pub fn with_dot(rgba: &mut [u8], width: u32, height: u32) {
    let r = width.min(height) as f32 / 4.0;
    let (cx, cy) = (width as f32 - r - 0.5, height as f32 - r - 0.5);
    for y in 0..height {
        for x in 0..width {
            let (dx, dy) = (x as f32 - cx, y as f32 - cy);
            if dx * dx + dy * dy <= r * r {
                let i = ((y * width + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&DOT);
            }
        }
    }
}

/// A round dot filling a `size`×`size` image (the Windows taskbar overlay).
pub fn dot_icon(size: u32) -> Vec<u8> {
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let r = size as f32 / 2.0;
    for y in 0..size {
        for x in 0..size {
            let (dx, dy) = (x as f32 + 0.5 - r, y as f32 + 0.5 - r);
            if dx * dx + dy * dy <= (r - 0.5) * (r - 0.5) {
                let i = ((y * size + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&DOT);
            }
        }
    }
    rgba
}

fn tray_icon(app: &AppHandle, dot: bool) -> Option<Image<'static>> {
    let base = app.default_window_icon()?;
    let mut rgba = base.rgba().to_vec();
    if dot {
        with_dot(&mut rgba, base.width(), base.height());
    }
    Some(Image::new_owned(rgba, base.width(), base.height()))
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Datrope", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start on login", true,
        app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Datrope", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &autostart, &PredefinedMenuItem::separator(app)?, &quit])?;
    let toggle = autostart.clone();
    let mut b = TrayIconBuilder::with_id(TRAY)
        .tooltip("Datrope")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, e| match e.id().as_ref() {
            "show" => show_window(app),
            "autostart" => {
                let on = toggle.is_checked().unwrap_or(false);
                let al = app.autolaunch();
                let _ = if on { al.enable() } else { al.disable() };
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = tray_icon(app, false) {
        b = b.icon(icon);
    }
    b.build(app)?;
    Ok(())
}

/// Updates the tray dot, the tooltip and the taskbar overlay (Windows) or badge count (macOS/Linux).
pub fn refresh(app: &AppHandle) {
    let (dot, mentions) = {
        let inner = app.state::<Shell>().0.lock().unwrap();
        (inner.badges.total_mentions() > 0, inner.badges.total_mentions())
    };
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_icon(tray_icon(app, dot));
        let _ = tray.set_tooltip(Some(if mentions > 0 { format!("Datrope — {mentions} unread mentions") } else { "Datrope".into() }));
    }
    if let Some(window) = app.get_window(MAIN) {
        #[cfg(windows)]
        let _ = window.set_overlay_icon(dot.then(|| Image::new_owned(dot_icon(16), 16, 16)));
        #[cfg(not(windows))]
        let _ = window.set_badge_count(dot.then_some(i64::from(mentions)));
    }
}

/// Closing the window hides it; everything stays connected. The first time, say so.
pub fn on_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    api.prevent_close();
    let _ = window.hide();
    let app = window.app_handle();
    let first = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        let first = !inner.store.tray_notice_shown;
        if first {
            inner.store.tray_notice_shown = true;
            inner.save();
        }
        first
    };
    if first {
        let _ = app.notification().builder()
            .title("Datrope is still running")
            .body("It keeps you connected in the tray. Quit from the tray icon's menu.")
            .show();
    }
}
```

`tray_by_id` / `set_overlay_icon` / `set_badge_count`: adapt names if the compiler disagrees (check docs.rs `tauri::Window`).

- [ ] **Step 3: Wire `lib.rs`** — final builder order (single-instance must be first):

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::show_window(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(ptt::plugin())
        .setup(|app| {
            // ... as in Task 3 ...
            shell::create_main_window(app.handle(), hidden)?;
            tray::build(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Resized(_) => {
                let _ = shell::layout(window.app_handle());
            }
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == shell::MAIN => {
                tray::on_close_requested(window, api);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![ /* all commands so far */ ])
        .build(tauri::generate_context!())
        .expect("error while building Datrope")
        .run(|app, event| {
            // macOS: clicking the dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                shell::show_window(app);
            }
            let _ = (app, event);
        });
}
```

- [ ] **Step 4: Run** `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → PASS.

- [ ] **Step 5: Manual check**
  1. Close the window → it hides; a one-off "still running" notification appears; closing again shows none.
  2. Tray left-click → window back. Tray menu → Quit exits.
  3. Start a second instance → the first window comes forward, no second process stays.
  4. `invoke("desktop_set_unread", { unread: true, mentions: 2 })` from a server page → tray icon dot and taskbar overlay dot; `mentions: 0` clears them.
  5. Tray → "Start on login" on → `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` has a Datrope entry with `--hidden` (in dev it points at the dev exe; that's expected). Turn it off again.
  6. Resize/move the window, restart → same size and position.

- [ ] **Step 6: Stage** — `git add clients/desktop/src-tauri`

---

### Task 7: Web — `desktop.ts` bridge

**Files:**
- Create: `clients/web/src/desktop.ts`, `clients/web/src/desktop.test.ts`
- Modify: `clients/web/package.json` (`"@tauri-apps/api": "2.12.0"`), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 5 commands and events.
- Produces:
  - `export interface DesktopTransport { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>; listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> }`
  - `export class Desktop` with `readonly visible: boolean` (getter), `notify(n: { title: string; body: string; target: string }): void`, `setUnread(unread: boolean, mentions: number): void`, `setVoice(inCall: boolean): void`, `setPttKey(key: string | null): Promise<string | null>` (error text or null), `setServerInfo(name: string, icon?: string): void`, `on<T>(event: "ptt" | "leave_voice" | "open_notification", cb: (payload: T) => void): () => void`
  - `export const desktop: Desktop | null`

- [ ] **Step 1: Write the failing tests** — `clients/web/src/desktop.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { Desktop, type DesktopTransport } from "./desktop";

function fake() {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const handlers = new Map<string, (p: unknown) => void>();
  let fail: string | undefined;
  const t: DesktopTransport = {
    invoke: async <T,>(cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (fail) throw fail;
      return undefined as T;
    },
    listen: async <T,>(event: string, cb: (p: T) => void) => {
      handlers.set(event, cb as (p: unknown) => void);
      return () => handlers.delete(event);
    },
  };
  return { t, calls, handlers, failWith: (e: string | undefined) => (fail = e) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Desktop", () => {
  it("sends notifications through the shell", async () => {
    const f = fake();
    new Desktop(f.t).notify({ title: "Alice in #general", body: "hi", target: "42" });
    await tick();
    expect(f.calls).toContainEqual(["desktop_notify", { title: "Alice in #general", body: "hi", target: "42" }]);
  });

  it("only sends unread and voice state when they change", async () => {
    const f = fake();
    const d = new Desktop(f.t);
    d.setUnread(true, 2);
    d.setUnread(true, 2);
    d.setUnread(false, 0);
    d.setVoice(true);
    d.setVoice(true);
    await tick();
    expect(f.calls.filter(([c]) => c === "desktop_set_unread")).toHaveLength(2);
    expect(f.calls.filter(([c]) => c === "desktop_voice_state")).toEqual([["desktop_voice_state", { inCall: true }]]);
  });

  it("tracks whether its webview is the visible one", async () => {
    const f = fake();
    const d = new Desktop(f.t);
    await tick();
    expect(d.visible).toBe(true);
    f.handlers.get("visible")!({ visible: false });
    expect(d.visible).toBe(false);
  });

  it("reports why a push-to-talk key can't be global", async () => {
    const f = fake();
    const d = new Desktop(f.t);
    expect(await d.setPttKey("F8")).toBeNull();
    f.failWith("HotKey already registered");
    expect(await d.setPttKey("F9")).toBe("HotKey already registered");
    expect(f.calls).toContainEqual(["desktop_ptt_set_key", { key: "F9" }]);
  });

  it("stops listening even if unsubscribed before listen resolves", async () => {
    const f = fake();
    const d = new Desktop(f.t);
    const cb = vi.fn();
    const stop = d.on("ptt", cb);
    stop();
    await tick();
    expect(f.handlers.has("ptt")).toBe(false);
  });
});
```

Run: `pnpm --filter @datrope/web exec vitest run src/desktop.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 2: Implement `desktop.ts`**

```ts
/**
 * The desktop app's bridge (clients/desktop). In a browser `desktop` is null and everything behaves as before.
 * Inside the desktop app this page runs in its own webview, and the shell shows notifications, keeps the rail's
 * badges, routes the global push-to-talk key and makes sure only one server is in a call.
 */
export interface DesktopTransport {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
}

export class Desktop {
  private shown = true;
  private unread?: string;
  private inCall?: boolean;

  constructor(private t: DesktopTransport) {
    this.on<{ visible: boolean }>("visible", (p) => {
      this.shown = p.visible;
    });
  }

  /** Whether the rail shows this server right now (hidden servers always notify). */
  get visible(): boolean {
    return this.shown;
  }

  notify(n: { title: string; body: string; target: string }) {
    void this.t.invoke("desktop_notify", n).catch(() => undefined);
  }

  setUnread(unread: boolean, mentions: number) {
    const key = `${unread}:${mentions}`;
    if (key === this.unread) return;
    this.unread = key;
    void this.t.invoke("desktop_set_unread", { unread, mentions }).catch(() => undefined);
  }

  setVoice(inCall: boolean) {
    if (inCall === this.inCall) return;
    this.inCall = inCall;
    void this.t.invoke("desktop_voice_state", { inCall }).catch(() => undefined);
  }

  /** Registers (or with null, frees) the global push-to-talk key. Resolves to why it failed, or null. */
  async setPttKey(key: string | null): Promise<string | null> {
    try {
      await this.t.invoke("desktop_ptt_set_key", { key });
      return null;
    } catch (e) {
      return typeof e === "string" ? e : "This key can't be used outside Datrope.";
    }
  }

  setServerInfo(name: string, icon?: string) {
    void this.t.invoke("desktop_server_info", { name, icon: icon ?? null }).catch(() => undefined);
  }

  on<T>(event: "ptt" | "leave_voice" | "open_notification" | "visible", cb: (payload: T) => void): () => void {
    let stop: (() => void) | undefined;
    let stopped = false;
    void this.t.listen<T>(event, cb).then((un) => {
      if (stopped) un();
      else stop = un;
    }).catch(() => undefined);
    return () => {
      stopped = true;
      stop?.();
    };
  }
}

/** Loads @tauri-apps/api only inside the desktop app, so the browser bundle never pays for it. */
function tauriTransport(): DesktopTransport {
  return {
    invoke: (cmd, args) => import("@tauri-apps/api/core").then((m) => m.invoke(cmd, args)),
    listen: (event, cb) =>
      import("@tauri-apps/api/webview").then((m) => m.getCurrentWebview().listen(event, (e) => cb(e.payload as never))),
  };
}

export const desktop: Desktop | null =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? new Desktop(tauriTransport()) : null;
```

Add `"@tauri-apps/api": "2.12.0"` to `clients/web/package.json` dependencies and run `pnpm install` at the root.

- [ ] **Step 3: Run** `pnpm --filter @datrope/web exec vitest run src/desktop.test.ts && pnpm --filter @datrope/web typecheck` → PASS.

- [ ] **Step 4: Stage** — `git add clients/web/src/desktop.ts clients/web/src/desktop.test.ts clients/web/package.json pnpm-lock.yaml`

---

### Task 8: Web — use the bridge (notifications, badges, server info, voice, push-to-talk)

**Files:**
- Create: `clients/web/src/app/desktop-sync.ts`, `clients/web/src/app/desktop-sync.test.ts`, `clients/web/src/app/DesktopBridge.tsx`
- Modify: `clients/web/src/app/NotificationListener.tsx`, `clients/web/src/notify/prefs.ts`, `clients/web/src/app/settings/NotificationSettings.tsx`, `clients/web/src/voice/ptt.ts`, `clients/web/src/voice/ptt.test.ts`, `clients/web/src/voice/call-audio.ts`, `clients/web/src/app/settings/VoiceSettings.tsx`, `clients/web/src/app/AppShell.tsx`

**Interfaces:**
- Consumes: Task 7 `desktop`; `isUnread` and `client`/`useApp` from `@/session`; `voice` from `voice/voice.ts`; `audioPrefs` from `voice/audio-prefs.ts`.
- Produces:
  - `badgeFor(s: Pick<State, "readStates" | "channels" | "dmIds" | "mentions">): { unread: boolean; mentions: number }`
  - `pttKeyFor(mode: "vad" | "ptt", code: string, inCall: boolean): string | null`
  - `desktopPtt` zustand store `{ error: string | null }`, `useDesktopPttError()`
  - `combinePtt(onChange: (down: boolean) => void): { set(source: "local" | "global", down: boolean): void }` in `voice/ptt.ts`

- [ ] **Step 1: Write the failing tests**

`clients/web/src/app/desktop-sync.test.ts` (check the real `State` field names in `clients/core/src/store.ts` — `readStates`, `channels`, `dmIds`, `mentions.unread` — before running):

```ts
import { describe, expect, it } from "vitest";
import { badgeFor, pttKeyFor } from "./desktop-sync";

const ch = (type: string) => ({ type }) as never;

describe("badgeFor", () => {
  it("counts unread mentions plus unread DMs", () => {
    const b = badgeFor({
      channels: { t1: ch("text"), v1: ch("voice"), d1: ch("dm"), d2: ch("dm") },
      dmIds: ["d1", "d2"],
      readStates: {
        t1: { lastMessageId: "5", lastReadId: "4" },
        d1: { lastMessageId: "9", lastReadId: "8" },
        d2: { lastMessageId: "3", lastReadId: "3" },
      },
      mentions: { items: [], unread: 2, hasMore: false, loaded: true },
    } as never);
    expect(b).toEqual({ unread: true, mentions: 3 });
  });

  it("is quiet when everything is read", () => {
    const b = badgeFor({ channels: { t1: ch("text") }, dmIds: [], readStates: { t1: { lastMessageId: "5", lastReadId: "5" } },
      mentions: { items: [], unread: 0, hasMore: false, loaded: true } } as never);
    expect(b).toEqual({ unread: false, mentions: 0 });
  });

  it("ignores channel types without unread state (voice)", () => {
    const b = badgeFor({ channels: { v1: ch("voice") }, dmIds: [], readStates: { v1: { lastMessageId: "5" } },
      mentions: { items: [], unread: 0, hasMore: false, loaded: true } } as never);
    expect(b.unread).toBe(false);
  });
});

describe("pttKeyFor", () => {
  it("registers the key only in a call with push to talk on", () => {
    expect(pttKeyFor("ptt", "F8", true)).toBe("F8");
    expect(pttKeyFor("ptt", "F8", false)).toBeNull();
    expect(pttKeyFor("vad", "F8", true)).toBeNull();
  });
});
```

Append to `clients/web/src/voice/ptt.test.ts`:

```ts
import { combinePtt } from "./ptt";

describe("combinePtt", () => {
  it("is down while either source holds the key, and reports changes only", () => {
    const seen: boolean[] = [];
    const p = combinePtt((d) => seen.push(d));
    p.set("local", true);
    p.set("global", true);
    p.set("local", false);
    p.set("global", false);
    p.set("global", false);
    expect(seen).toEqual([true, false]);
  });
});
```

(Merge the import with the file's existing imports from `./ptt`; add `describe`/`expect`/`it` to the vitest import if missing.)

Run: `pnpm --filter @datrope/web exec vitest run src/app/desktop-sync.test.ts src/voice/ptt.test.ts` → FAIL.

- [ ] **Step 2: `combinePtt`** — append to `voice/ptt.ts`

```ts
/** Push to talk from two places (keys in the window, the desktop app's global shortcut): down while either is. */
export function combinePtt(onChange: (down: boolean) => void) {
  const held = { local: false, global: false };
  let down = false;
  return {
    set(source: "local" | "global", d: boolean) {
      held[source] = d;
      const next = held.local || held.global;
      if (next === down) return;
      down = next;
      onChange(next);
    },
  };
}
```

`voice/call-audio.ts` constructor (replace the `watchPtt` line; add `import { desktop } from "../desktop";` and `combinePtt` to the `./ptt` import):

```ts
    const ptt = combinePtt((down) => this.processor.setPtt(down));
    this.stops.push(watchPtt(window, () => audioPrefs.getState().pttKey.code, (down) => ptt.set("local", down)));
    if (desktop) this.stops.push(desktop.on<{ down: boolean }>("ptt", (p) => ptt.set("global", p.down)));
```

- [ ] **Step 3: `app/desktop-sync.ts`**

```ts
import type { State } from "@datrope/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { isUnread } from "../session";
import { isUnreadType } from "./channel-types";

/** What the desktop rail shows for this server: a dot for unread channels, a count of mentions and unread DMs. */
export function badgeFor(s: Pick<State, "readStates" | "channels" | "dmIds" | "mentions">): { unread: boolean; mentions: number } {
  const dms = s.dmIds.filter((id) => isUnread(s.readStates[id])).length;
  const unread = Object.entries(s.readStates).some(([id, rs]) => isUnreadType(s.channels[id]?.type) && isUnread(rs));
  return { unread: unread || dms > 0, mentions: s.mentions.unread + dms };
}

/** The global push-to-talk key to hold registered: only during a call with push to talk on. */
export function pttKeyFor(mode: "vad" | "ptt", code: string, inCall: boolean): string | null {
  return inCall && mode === "ptt" ? code : null;
}

/** Why the global push-to-talk key couldn't be registered (shown in voice settings). */
export const desktopPtt = createStore<{ error: string | null }>(() => ({ error: null }));
export const useDesktopPttError = () => useStore(desktopPtt, (s) => s.error);
```

Check `State` is exported from `@datrope/core` and `isUnreadType("dm")` — if DMs already count in `isUnreadType`, keep `dms` only in `mentions` (the test above pins the totals either way).

- [ ] **Step 4: `app/DesktopBridge.tsx`**

```tsx
import { useEffect } from "react";
import { desktop } from "../desktop";
import { client, useApp } from "../session";
import { audioPrefs } from "../voice/audio-prefs";
import { voice } from "../voice/voice";
import { badgeFor, desktopPtt, pttKeyFor } from "./desktop-sync";

const MAX_ICON_BYTES = 200_000;

async function iconDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(client.url(url));
    if (!res.ok) return undefined;
    const blob = await res.blob();
    if (blob.size > MAX_ICON_BYTES || !blob.type.startsWith("image/")) return undefined;
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === "string" ? r.result : undefined);
      r.onerror = () => resolve(undefined);
      r.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/** Keeps the desktop app's rail, voice handoff and global push-to-talk in step with this server. Renders nothing. */
export function DesktopBridge() {
  const name = useApp((s) => s.server?.server.name);
  const iconUrl = useApp((s) => s.server?.server.icon_url);

  useEffect(() => {
    if (!desktop || !name) return;
    let live = true;
    void (iconUrl ? iconDataUrl(iconUrl) : Promise.resolve(undefined)).then((icon) => {
      if (live) desktop?.setServerInfo(name, icon);
    });
    return () => {
      live = false;
    };
  }, [name, iconUrl]);

  useEffect(() => {
    if (!desktop) return;
    const d = desktop;
    const push = () => {
      const b = badgeFor(client.store.getState());
      d.setUnread(b.unread, b.mentions);
    };
    push();
    return client.store.subscribe(push);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    const d = desktop;
    let key: string | null = null;
    const sync = () => {
      const v = voice.store.getState();
      const inCall = v.status !== "idle";
      d.setVoice(inCall);
      const p = audioPrefs.getState();
      const next = pttKeyFor(p.mode, p.pttKey.code, inCall);
      if (next === key) return;
      key = next;
      void d.setPttKey(next).then((error) => desktopPtt.setState({ error: next ? error : null }));
    };
    sync();
    const stops = [
      voice.store.subscribe(sync),
      audioPrefs.subscribe(sync),
      d.on("leave_voice", () => voice.leave()),
    ];
    return () => stops.forEach((s) => s());
  }, []);

  return null;
}
```

`AppShell.tsx`: add `import { desktop } from "../desktop";` and `import { DesktopBridge } from "./DesktopBridge";`, and next to `<NotificationListener />`:

```tsx
        {desktop && <DesktopBridge />}
```

(Check `client.url` exists with that name in `clients/core/src/client.ts`; it does per `client.url(path)` usage in `components/user-avatar.tsx`.)

- [ ] **Step 5: Notifications through the bridge**

`notify/prefs.ts` — notifications start on inside the desktop app:

```ts
import { desktop } from "../desktop";
...
const defaults: NotifyPrefs = { enabled: desktop !== null, level: "mentions" };
```

`app/NotificationListener.tsx`:
1. `import { desktop } from "../desktop";`
2. In `shouldNotify({...})`: `permission: desktop ? "granted" : "Notification" in window ? Notification.permission : "unsupported",` and `hidden: document.visibilityState === "hidden" || !document.hasFocus() || (desktop !== null && !desktop.visible),`
3. Keep a module-level map from message id to its click action, and deliver through the shell. Replace the `try { const n = new Notification(...) ... } catch {}` block with:

```tsx
    const title = notificationTitle(notificationAuthor(displayName(author), !m.author), where);
    const body = notificationBody(m.content, m.attachments?.length ?? 0);
    const open = () => openMessage(nav.current, where, m.id);
    if (desktop) {
      remember(m.id, open);
      desktop.notify({ title, body, target: m.id });
      return;
    }
    try {
      const n = new Notification(title, { body, icon: icon ? new URL(icon, window.location.origin).href : undefined, tag: m.id });
      n.onclick = () => {
        window.focus();
        void open();
        n.close();
      };
    } catch {
      // Some mobile browsers only allow notifications from a service worker.
    }
```

and above the component:

```tsx
/** Desktop app: what to open when the shell reports a notification click (by message id). Keeps the last 50. */
const clickActions = new Map<string, () => void>();
function remember(id: string, open: () => void) {
  clickActions.set(id, open);
  if (clickActions.size > 50) clickActions.delete(clickActions.keys().next().value!);
}
```

and inside the component, a second effect:

```tsx
  useEffect(() => desktop?.on<{ target: string }>("open_notification", ({ target }) => clickActions.get(target)?.()), []);
```

(`openMessage` returns a promise; the `void open()` / `?.()` calls discard it as before.)

`app/settings/NotificationSettings.tsx` — the desktop app needs no permission prompt:

```tsx
import { desktop } from "../../desktop";

const currentPermission = (): NotificationPermission | "unsupported" =>
  desktop ? "granted" : "Notification" in window ? Notification.permission : "unsupported";
```

(`toggle` then never calls `requestPermission` in the desktop app because the permission is already `"granted"`.)

- [ ] **Step 6: Voice settings hints** — `app/settings/VoiceSettings.tsx`

1. Imports: `import { desktop } from "../../desktop";` and `import { useDesktopPttError } from "../desktop-sync";`
2. Replace the PTT hint in `modes`:

```tsx
  { value: "ptt", title: "Push to talk", hint: desktop
    ? "Hold a key to talk. While you're in a call it works in other apps too."
    : "Hold a key to talk. Works while Datrope is the active tab." },
```

3. In the PTT branch, under the key row:

```tsx
            {desktop && <PttGlobalNote />}
```

and define near `KeyCapture`:

```tsx
/** Desktop app: the key is taken system-wide during calls, or couldn't be (Wayland, macOS permission, taken). */
function PttGlobalNote() {
  const error = useDesktopPttError();
  return error ? (
    <p role="alert" className="m-0 text-sm text-destructive">
      Couldn't use this key outside Datrope ({error}). It still works while Datrope is the active window.
    </p>
  ) : (
    <p className="m-0 text-sm text-muted-foreground">While you're in a call, other apps won't receive this key.</p>
  );
}
```

- [ ] **Step 7: Run all web checks**

Run: `pnpm --filter @datrope/web test && pnpm --filter @datrope/web typecheck && pnpm lint` → Expected: PASS (existing notify/ptt tests unchanged and passing).

- [ ] **Step 8: Browser regression** — start `datrope-server` + `datrope-web` (launch.json), open the web app in the browser pane, sign in with a throwaway account per the memory notes, and check: no console errors, `@tauri-apps/api` is not requested (Network: no chunk named `core-*`/`webview-*` loads), Notifications settings still show the permission flow, Voice settings show the old PTT hint.

- [ ] **Step 9: Desktop check** — `pnpm --filter @datrope/desktop dev` with the dev server added:
  1. A second account sends a DM while the window is hidden → native toast; clicking it opens that DM.
  2. Rail badge shows the DM count and clears once read.
  3. Server name/icon replace the host initials after sign-in.
  4. Push to talk on, join voice, focus Notepad, hold the key → the speaking ring shows in a second browser; release → it stops. Leave voice → the key types in Notepad again.
  5. Add `http://127.0.0.1:5173` as a second server, sign in as another user, join voice there → the first server's call ends.

- [ ] **Step 10: Stage** — `git add clients/web`

---

### Task 9: Updater (feature-gated), release workflow (manual only), CI job, docs, final checklist

**Files:**
- Create: `clients/desktop/src-tauri/src/update.rs`, `clients/desktop/src-tauri/tauri.updater.conf.json`, `.github/workflows/desktop-release.yml`
- Modify: `clients/desktop/src-tauri/src/lib.rs`, `src/commands.rs` (`update_restart`), `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: Task 3 `Shell.update_ready`, `emit_rail_state`; Task 4 `restartToUpdate()`.
- Produces: `update_restart` command; `update::start(app)` (feature `updater`).

- [ ] **Step 1: `update.rs`**

```rust
//! Auto-update (Cargo feature "updater", off by default): check at start and every 6 hours, download in the
//! background, and install only when the user presses "Restart to update" — never mid-call.

use crate::shell::{emit_rail_state, Shell};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Pending(pub Mutex<Option<(Update, Vec<u8>)>>);

pub fn start(app: AppHandle) {
    app.manage(Pending::default());
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = check(&app).await {
                eprintln!("update check: {e}");
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

async fn check(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if app.state::<Pending>().0.lock().unwrap().is_some() {
        return Ok(());
    }
    let Some(update) = app.updater()?.check().await? else { return Ok(()) };
    let bytes = update.download(|_, _| {}, || {}).await?;
    *app.state::<Pending>().0.lock().unwrap() = Some((update, bytes));
    app.state::<Shell>().0.lock().unwrap().update_ready = true;
    emit_rail_state(app);
    Ok(())
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    let pending = app.state::<Pending>().0.lock().unwrap().take();
    let Some((update, bytes)) = pending else { return Err("no update ready".into()) };
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}
```

`tokio` is Tauri's runtime; if `tokio::time` isn't reachable, add `tokio = { version = "1", features = ["time"] }` to `[dependencies]`.

- [ ] **Step 2: Command + wiring**

`commands.rs`:

```rust
#[tauri::command]
pub fn update_restart(app: AppHandle, webview: Webview) -> Result<(), String> {
    only_rail(&webview)?;
    #[cfg(feature = "updater")]
    return crate::update::install(&app);
    #[cfg(not(feature = "updater"))]
    {
        let _ = app;
        Err("updates are not enabled in this build".into())
    }
}
```

`lib.rs`: `#[cfg(feature = "updater")] mod update;`, add `commands::update_restart` to the handler, and:

```rust
    let builder = tauri::Builder::default() /* ...plugins... */;
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
```

and at the end of `setup`: `#[cfg(feature = "updater")] update::start(app.handle().clone());`

`tauri.updater.conf.json` (merged in by the release workflow only; `pubkey` is filled in when the user generates the key):

```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "REPLACE_WITH_THE_PUBLIC_KEY_FROM_tauri_signer_generate",
      "endpoints": ["https://github.com/OWNER/datrope/releases/latest/download/latest.json"]
    }
  }
}
```

Replace `OWNER` with the GitHub owner from `git remote get-url origin`. The `pubkey` placeholder is intentional and documented: the release workflow refuses to run until it is replaced (Step 3).

Run: `cargo clippy --all-targets -- -D warnings && cargo clippy --all-targets --features updater -- -D warnings && cargo test` → PASS.

- [ ] **Step 3: Release workflow** — `.github/workflows/desktop-release.yml`

```yaml
name: Desktop release

# Switched off: runs only when started by hand. To release on tags, uncomment `push`, add the
# TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) secrets, and put the public key in tauri.updater.conf.json.
on:
  workflow_dispatch:
  # push:
  #   tags: ["desktop-v*"]

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows-latest
            args: ""
          - platform: macos-latest
            args: "--target universal-apple-darwin"
          - platform: ubuntu-22.04
            args: ""
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - name: Updater key is configured
        shell: bash
        run: |
          if grep -q REPLACE_WITH clients/desktop/src-tauri/tauri.updater.conf.json; then
            echo "Put the updater public key in clients/desktop/src-tauri/tauri.updater.conf.json first." >&2
            exit 1
          fi
      - if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: clients/desktop/src-tauri -> target
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          projectPath: clients/desktop
          tagName: desktop-v__VERSION__
          releaseName: Datrope desktop v__VERSION__
          releaseDraft: true
          prerelease: false
          includeUpdaterJson: true
          args: ${{ matrix.args }} --features updater --config src-tauri/tauri.updater.conf.json
```

- [ ] **Step 4: CI job** — append to `.github/workflows/ci.yml` under `jobs:`

```yaml
  desktop:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: clients/desktop/src-tauri -> target
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Build the rail (tauri::generate_context! reads dist/)
        run: pnpm --filter @datrope/desktop exec vite build
      - working-directory: clients/desktop/src-tauri
        run: |
          cargo fmt --check
          cargo clippy --all-targets -- -D warnings
          cargo clippy --all-targets --features updater -- -D warnings
          cargo test
```

(The rail's typecheck, lint and Vitest already run in the `clients` job through `pnpm typecheck`/`pnpm lint`/`pnpm test`.)

- [ ] **Step 5: README** — add a `### Desktop app` subsection under *Development* (and a line in *Project layout* for `clients/desktop/`):

```markdown
### Desktop app

`clients/desktop` is a Tauri app: a rail of servers on the left, and each server's own web app in its own
webview, all connected at once. Native notifications, global push-to-talk during calls, and a tray icon.

Prerequisites: Rust (stable, MSVC on Windows), the "Desktop development with C++" build tools on Windows,
WebView2 (built into Windows 11). See https://tauri.app/start/prerequisites/ for macOS and Linux.

    pnpm --filter @datrope/desktop dev     # opens the app; add http://localhost:5173 as a server
    pnpm --filter @datrope/desktop build   # local installer in clients/desktop/src-tauri/target/release/bundle/

Dev builds accept http://localhost servers; release builds need https://. Linking Twitch/Spotify opens in
your browser and does not come back to the app — link accounts from the web app.

Releases are switched off. To turn them on: run `pnpm --filter @datrope/desktop exec tauri signer generate`,
put the public key in `src-tauri/tauri.updater.conf.json`, add `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository secrets, and uncomment the tag trigger in
`.github/workflows/desktop-release.yml`. Builds are not code-signed: Windows SmartScreen shows "More info →
Run anyway", and on macOS right-click the app → Open the first time.
```

- [ ] **Step 6: Full checks**

Run from the repo root: `pnpm typecheck && pnpm lint && pnpm test`, then in `clients/desktop/src-tauri`: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. Expected: all PASS.

- [ ] **Step 7: Local installer + manual checklist** (spec §5). Run `pnpm --filter @datrope/desktop build`, install `target/release/bundle/nsis/Datrope_0.1.0_x64-setup.exe`, and go through:
  1. Add two servers; a message on the hidden one shows its badge.
  2. Reorder by drag and drop; the order survives a restart.
  3. Join voice on server A, then on server B: A leaves the call.
  4. Global PTT works while another app has focus; the key is free again after leaving voice.
  5. Close to tray; a DM or mention on any server shows a native notification; clicking it opens that channel.
  6. Start on login starts the app hidden in the tray (sign out/in of Windows).
  7. Remove a server: it is signed out and its data directory is gone.
  8. Leave a server hidden for 30 minutes; it is still connected (a new DM notifies, no "Reconnecting…").
  Note any failure as a finding instead of marking the step done. Uninstall afterwards if wanted.

- [ ] **Step 8: Stage** — `git add clients/desktop .github README.md`
