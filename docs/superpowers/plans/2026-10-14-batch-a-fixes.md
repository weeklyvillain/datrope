# Batch A (bugs and quick fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five things:
- screenshares overflow their box (item 10)
- desktop links do not open in the system browser (item 11)
- a refresh drops you from voice (item 12)
- long-pressing a message on a phone marks its text (item 3)
- the System page is slow (item 13)

**Architecture:** Every fix is local to its own area, and they share no code:
- a CSS change in the voice tile
- a Tauri command plus a link router in the web client
- a small resume/retry module that `voice.ts` uses
- a CSS change plus a clipboard helper for the message row and sheet
- a background container-stats cache in the updater

**Tech Stack:** React 18, Tailwind v4, Vitest (node environment, no DOM), livekit-client, Tauri 2 (Rust), Go (updater).

**Spec:** `docs/superpowers/specs/2026-10-14-multi-features-design.md`, sections A1–A5.

## Global Constraints

- Never commit (AGENTS.md §5). Each task ends with staging its files. The user commits.
- Never hardcode colors. Use token utilities only.
- Keep accessible names stable. The Playwright tests select by role and label.
- Prefix shell commands with `rtk` (user CLAUDE.md).
- Vitest runs in node, so there is no `document` or `window`. Put logic in pure functions and test those.

## Review Focus

1. **Portrait or 4:3 screenshares and phone-shaped windows.** The whole share stays visible and letterboxed, in the stage and in the strip/grid tiles. Covered by a manual browser check in Task 1.
2. **Same-origin links with `target=_blank`** (attachment downloads, `/api/...` URLs) in the desktop app. They open in the system browser and do not navigate the webview away from the app. Covered by a test in Task 2.
3. **A refresh while LiveKit says `CLIENT_INITIATED`** (pagehide). The saved call must not be cleared, or the reload has nothing to resume. Covered by a test in Task 3.
4. **Being kicked or joining from a second tab.** No retry loop and no resume. Covered by a test in Task 3.
5. **Copy where there is no Clipboard API** (http LAN servers, old WebViews). The copy still works, through the fallback. Covered by a test in Task 4.

---

### Task 1: Screenshare fits its tile (A1)

**Root cause.** The tile card is `grid place-items-center`, with one auto-sized row. `TrackVideo`'s `size-full` height resolves against that auto track, so the video takes its intrinsic height. A share that is taller than 16:9 (a portrait window, 4:3, or a phone) grows past the box, and `overflow-hidden` crops it. Taking the video out of the flow fixes it: it then fills the box exactly, and `object-contain` letterboxes the picture.

**Files:**
- Modify: `clients/web/src/app/voice/TrackVideo.tsx:22`

**Interfaces:** none.

- [ ] **Step 1: Position the video absolutely inside its tile**

In `clients/web/src/app/voice/TrackVideo.tsx`, replace the return line with:

```tsx
  // Out of the tile's grid flow: an auto grid row would otherwise size to the video's own height and crop it.
  return <video ref={ref} className={cn("absolute inset-0 size-full object-contain", mirror && "-scale-x-100")} autoPlay playsInline muted />;
```

Every `TrackVideo` parent is a `Tile` card that is `relative ... overflow-hidden`, so `inset-0` is the card. Check this with `rtk grep "TrackVideo" clients/web/src`. If any other parent is not `relative`, add `relative` to it.

- [ ] **Step 2: Typecheck**

Run: `rtk pnpm --filter @datrope/web typecheck`
Expected: no errors.

- [ ] **Step 3: Check in the browser**

Start `datrope-server` and `datrope-web` (`.claude/launch.json`). Join a voice channel and share a portrait-sized window. Then:
- Resize the browser to 1400×600 and to 600×900.
- Each time, use `javascript_tool` to check that the `<video>`'s `getBoundingClientRect()` equals its tile's rect.
- Check that the picture is letterboxed and not cropped, in the stage view and in grid view.
- Take a screenshot as proof.

- [ ] **Step 4: Stage**

```bash
rtk git add clients/web/src/app/voice/TrackVideo.tsx
```

---

### Task 2: Desktop links open in the system browser (A2)

**Files:**
- Modify: `clients/desktop/src-tauri/src/shell.rs` (`open_external` ~:861 and `SERVER_PERMISSIONS` :681, plus its test ~:1298)
- Modify: `clients/desktop/src-tauri/src/commands.rs` (new command at the end)
- Modify: `clients/desktop/src-tauri/src/lib.rs:72-93` (`generate_handler!`)
- Modify: `clients/desktop/src-tauri/build.rs` (commands list)
- Modify: `clients/web/src/desktop.ts` (new `openUrl` method and the `linkToOpen` function)
- Modify: `clients/web/src/app/DesktopBridge.tsx` (install the listener)
- Test: `clients/web/src/desktop.test.ts`

**Interfaces:**
- Produces (Rust): `#[tauri::command] desktop_open_url(app, webview, url: String) -> Result<(), String>` and `pub fn open_external(target: &Url) -> bool`.
- Produces (TS): `Desktop.openUrl(url: string): void` and `export function linkToOpen(link: { href: string; target: string }, pageOrigin: string, button: number): string | null`.

- [ ] **Step 1: Write the failing web tests**

Append to `clients/web/src/desktop.test.ts`. Also add `linkToOpen` to its import from `./desktop`.

```ts
describe("linkToOpen", () => {
  const page = "https://chat.example.com";
  it("opens other sites in the browser", () =>
    expect(linkToOpen({ href: "https://youtube.com/watch?v=1", target: "" }, page, 0)).toBe("https://youtube.com/watch?v=1"));
  it("opens same-origin new-tab links (downloads) in the browser", () =>
    expect(linkToOpen({ href: `${page}/api/attachments/5`, target: "_blank" }, page, 0)).toBe(`${page}/api/attachments/5`));
  it("leaves in-app links to the router", () =>
    expect(linkToOpen({ href: `${page}/channels/1`, target: "" }, page, 0)).toBeNull());
  it("opens a middle-clicked in-app link in the browser", () =>
    expect(linkToOpen({ href: `${page}/channels/1`, target: "" }, page, 1)).toBe(`${page}/channels/1`));
  it("handles mailto", () =>
    expect(linkToOpen({ href: "mailto:a@b.c", target: "" }, page, 0)).toBe("mailto:a@b.c"));
  it("ignores other schemes and right clicks", () => {
    expect(linkToOpen({ href: "javascript:alert(1)", target: "_blank" }, page, 0)).toBeNull();
    expect(linkToOpen({ href: "https://x.com", target: "" }, page, 2)).toBeNull();
  });
  it("sends openUrl to the shell", async () => {
    const f = fake();
    new Desktop(f.t).openUrl("https://x.com/");
    await tick();
    expect(f.calls).toContainEqual(["desktop_open_url", { url: "https://x.com/" }]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `rtk vitest run src/desktop.test.ts` (from `clients/web`)
Expected: FAIL, because `linkToOpen` and `openUrl` do not exist.

- [ ] **Step 3: Implement the web side**

In `clients/web/src/desktop.ts`, add this method to `class Desktop`, after `startDrag()`:

```ts
  /** Opens a link in the system browser. */
  openUrl(url: string) {
    void this.t.invoke("desktop_open_url", { url }).catch(() => undefined);
  }
```

Add this exported function above `eventDispatcher`:

```ts
/**
 * Which URL a click on `link` should open in the system browser, or null to let the page handle it: links to other
 * sites, new-tab links (downloads included) and middle clicks. The webview itself only shows this server's app.
 */
export function linkToOpen(link: { href: string; target: string }, pageOrigin: string, button: number): string | null {
  if (button !== 0 && button !== 1) return null;
  let url: URL;
  try {
    url = new URL(link.href, pageOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return null;
  const external = url.origin !== pageOrigin;
  return external || link.target === "_blank" || button === 1 ? url.href : null;
}
```

In `clients/web/src/app/DesktopBridge.tsx`, add `linkToOpen` to the `../desktop` import. Add this effect inside `DesktopBridge()`, after the theme effect:

```tsx
  // Links leave the app through the shell: the webview's new-window hook alone is not reliable on every platform.
  useEffect(() => {
    if (!desktop) return;
    const d = desktop;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement)) return;
      const url = linkToOpen(a, location.origin, e.button);
      if (!url) return;
      e.preventDefault();
      d.openUrl(url);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
    };
  }, []);
```

- [ ] **Step 4: Run the web tests and watch them pass**

Run: `rtk vitest run src/desktop.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Rust test**

In `clients/desktop/src-tauri/src/shell.rs`, find the test at ~:1298 that asserts `SERVER_PERMISSIONS.contains(&"allow-desktop-subscribe")`. Add next to it:

```rust
        assert!(SERVER_PERMISSIONS.contains(&"allow-desktop-open-url"));
```

Run: `rtk cargo test --manifest-path clients/desktop/src-tauri/Cargo.toml`
Expected: FAIL on that assertion.

- [ ] **Step 6: Implement the Rust side**

In `shell.rs`:
- Append `"allow-desktop-open-url",` to `SERVER_PERMISSIONS`.
- Change `open_external` to:

```rust
/// Opens `target` in the system's default handler; only http, https and mailto. Whether it was handed off.
pub fn open_external(target: &Url) -> bool {
    if !matches!(target.scheme(), "http" | "https" | "mailto") {
        return false;
    }
    tauri_plugin_opener::open_url(target.as_str(), None::<&str>).is_ok()
}
```

The existing callers (`on_navigation` and `on_new_window`) ignore the result. Leave them as they are.

In `commands.rs`, append:

```rust
/// A link the server page wants opened in the system browser (the page routes link clicks here).
#[tauri::command]
pub fn desktop_open_url(app: AppHandle, webview: Webview, url: String) -> Result<(), String> {
    visible_caller(&app, &webview)?; // a hidden server page cannot open browser tabs, and calls are rate limited
    let target: tauri::Url = url.parse().map_err(|_| "invalid url".to_string())?;
    if shell::open_external(&target) {
        Ok(())
    } else {
        Err("unsupported link".into())
    }
}
```

In `lib.rs`, add `commands::desktop_open_url,` after `commands::desktop_set_theme,` in `generate_handler!`. In `build.rs`, add `"desktop_open_url",` after `"desktop_set_theme",`.

- [ ] **Step 7: Run the Rust tests and build**

Run: `rtk cargo test --manifest-path clients/desktop/src-tauri/Cargo.toml`
Expected: PASS. The build regenerates `permissions/autogenerated/desktop_open_url.toml`.

- [ ] **Step 8: Check in the desktop dev build**

Run the desktop dev build against the local server. Click:
- a message link (https)
- an attachment's download link
- a profile link

Each must open in the default browser, and the app's webview must not change.

- [ ] **Step 9: Stage**

```bash
rtk git add clients/web/src/desktop.ts clients/web/src/desktop.test.ts clients/web/src/app/DesktopBridge.tsx clients/desktop/src-tauri/src clients/desktop/src-tauri/build.rs clients/desktop/src-tauri/permissions
```

---

### Task 3: Stay in the call across a refresh and a dropped connection (A3)

**Files:**
- Create: `clients/web/src/voice/resume.ts`
- Test: `clients/web/src/voice/resume.test.ts`
- Modify: `clients/web/src/voice/voice.ts` (`VoiceView`, `idle`, the constructor, `join`, `leave`, `disconnect`, and the `Disconnected` handler)
- Modify: `clients/web/src/app/voice/VoicePanel.tsx:23,47` (status text)
- Modify: `clients/web/src/app/mobile/MiniBars.tsx:75` (status text)

**Interfaces:**
- Produces (`resume.ts`):
  - `interface Resume { channelId: string; muted: boolean; deafened: boolean }`
  - `saveResume(s: Pick<Storage,"setItem">, r: Resume): void`
  - `loadResume(s: Pick<Storage,"getItem">): Resume | null`
  - `clearResume(s: Pick<Storage,"removeItem">): void`
  - `retryDelay(attempt: number, elapsedMs: number): number | null`, where `attempt` starts at 1 and the result is ms, or null to give up
  - `terminalReason(reason: DisconnectReason | undefined): boolean`
  - `terminalJoinError(e: unknown): boolean`
- Produces (`VoiceView`): a new field `retry?: number`, the attempt number while `status === "reconnecting"` and waiting for our own rejoin.

- [ ] **Step 1: Write the failing tests**

Create `clients/web/src/voice/resume.test.ts`:

```ts
import { ApiError } from "@datrope/core";
import { DisconnectReason } from "livekit-client";
import { describe, expect, it } from "vitest";
import { clearResume, loadResume, retryDelay, saveResume, terminalJoinError, terminalReason } from "./resume";

function storage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe("resume storage", () => {
  it("round-trips and clears", () => {
    const s = storage();
    expect(loadResume(s)).toBeNull();
    saveResume(s, { channelId: "42", muted: true, deafened: false });
    expect(loadResume(s)).toEqual({ channelId: "42", muted: true, deafened: false });
    clearResume(s);
    expect(loadResume(s)).toBeNull();
  });
  it("ignores garbage", () => {
    const s = storage();
    s.setItem("voice.resume", "{nope");
    expect(loadResume(s)).toBeNull();
    s.setItem("voice.resume", JSON.stringify({ channelId: 5 }));
    expect(loadResume(s)).toBeNull();
  });
});

describe("retryDelay", () => {
  it("backs off 1, 2, 5, 10, 15, 15 … seconds", () =>
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelay(n, 0))).toEqual([1000, 2000, 5000, 10000, 15000, 15000, 15000]));
  it("gives up after two minutes", () => expect(retryDelay(9, 120_000)).toBeNull());
});

describe("terminal", () => {
  it("does not retry kicks, duplicates or closed rooms", () => {
    for (const r of [DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason.DUPLICATE_IDENTITY, DisconnectReason.ROOM_DELETED, DisconnectReason.USER_REJECTED])
      expect(terminalReason(r)).toBe(true);
  });
  it("retries network trouble and page-leave disconnects", () => {
    for (const r of [undefined, DisconnectReason.SIGNAL_CLOSE, DisconnectReason.SERVER_SHUTDOWN, DisconnectReason.CLIENT_INITIATED, DisconnectReason.CONNECTION_TIMEOUT])
      expect(terminalReason(r)).toBe(false);
  });
  it("treats 4xx join refusals as final and 5xx/network as retryable", () => {
    expect(terminalJoinError(new ApiError(403, "MISSING_PERMISSION", "no"))).toBe(true);
    expect(terminalJoinError(new ApiError(404, "NOT_FOUND", "gone"))).toBe(true);
    expect(terminalJoinError(new ApiError(503, "X", "down"))).toBe(false);
    expect(terminalJoinError(new TypeError("Failed to fetch"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `rtk vitest run src/voice/resume.test.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `resume.ts`**

```ts
import { ApiError } from "@datrope/core";
import { DisconnectReason } from "livekit-client";

/** The call this tab was in, kept in sessionStorage so a reload (or a dropped connection) can join it again. */
export interface Resume {
  channelId: string;
  muted: boolean;
  deafened: boolean;
}

const KEY = "voice.resume";

export function saveResume(s: Pick<Storage, "setItem">, r: Resume) {
  try {
    s.setItem(KEY, JSON.stringify(r));
  } catch {
    // Storage full or blocked: a reload just won't rejoin.
  }
}

export function loadResume(s: Pick<Storage, "getItem">): Resume | null {
  try {
    const v: unknown = JSON.parse(s.getItem(KEY) ?? "null");
    if (!v || typeof v !== "object" || typeof (v as Resume).channelId !== "string") return null;
    const r = v as Resume;
    return { channelId: r.channelId, muted: r.muted === true, deafened: r.deafened === true };
  } catch {
    return null;
  }
}

export function clearResume(s: Pick<Storage, "removeItem">) {
  try {
    s.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

const DELAYS = [1000, 2000, 5000, 10000, 15000];
const GIVE_UP_MS = 120_000;

/** How long to wait before rejoin attempt `attempt` (1-based), or null once we have tried for two minutes. */
export function retryDelay(attempt: number, elapsedMs: number): number | null {
  if (elapsedMs >= GIVE_UP_MS) return null;
  return DELAYS[Math.min(attempt, DELAYS.length) - 1];
}

const FINAL = new Set<DisconnectReason>([
  DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason.DUPLICATE_IDENTITY, DisconnectReason.ROOM_DELETED,
  DisconnectReason.USER_REJECTED,
]);

/** A disconnect we must not undo by rejoining: kicked, joined elsewhere, channel gone. */
export const terminalReason = (reason: DisconnectReason | undefined) => reason !== undefined && FINAL.has(reason);

/** A join failure that retrying cannot fix: the server said no (no permission, channel gone, full). */
export const terminalJoinError = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500;
```

- [ ] **Step 4: Run them and watch them pass**

Run: `rtk vitest run src/voice/resume.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `voice.ts`**

1. Imports: add `import { clearResume, loadResume, retryDelay, saveResume, terminalJoinError, terminalReason } from "./resume";`.
2. `VoiceView`: add `retry?: number; // our own rejoin attempt, while status is "reconnecting" after a lost connection`. In `idle`, add `retry: undefined`.
3. Class fields: add `private retryTimer?: ReturnType<typeof setTimeout>;` and `private retryStart = 0;`.
4. Add the helper `const tabStorage = () => (typeof sessionStorage === "undefined" ? undefined : sessionStorage);` at module level.
5. Constructor: after the `client.onEvent` block, add:

```ts
    // A reload (or a new page load in this tab) rejoins the call the tab was in, once the gateway is ready.
    const resume = tabStorage() && loadResume(tabStorage()!);
    if (resume) {
      const stop = client.store.subscribe((s) => {
        if (s.connection !== "ready") return;
        stop();
        if (this.store.getState().status === "idle") void this.join(resume.channelId, 0);
      });
    }
```

6. `join(channelId)` becomes `join(channelId: string, retry?: number)`. The value of `retry` means:
   - `undefined`: a click by the user. A failure reports at once, as it does today.
   - `0`: a resume after reload.
   - `n`: rejoin attempt n.

   Make these changes:
   - The early return becomes `if (retry === undefined && prev.channelId === channelId && prev.status !== "idle") return;`.
   - Add `clearTimeout(this.retryTimer);` before `this.disconnect();`.
   - Replace `this.set({ ...idle, channelId, status: "connecting" });` with `this.set({ ...idle, channelId, status: retry ? "reconnecting" : "connecting", retry: retry || undefined });`.
   - After `this.set({ status: "connected", audioBlocked: ... });`, add:

```ts
      this.set({ retry: undefined });
      const saved = tabStorage();
      if (saved) saveResume(saved, { channelId, muted: this.store.getState().muted, deafened: this.store.getState().deafened });
```

   - Mute and deafen change while in a call, so also call `saveResume` with the new values at the end of `report()`, the method that sends self mute and deafen. Do this only while `status === "connected"`.
   - In `catch (e)`, replace the body after `if (this.room !== room) return;` with:

```ts
      this.disconnect();
      if (retry !== undefined && !terminalJoinError(e) && this.scheduleRetry(channelId, retry)) return;
      const ss = tabStorage();
      if (ss) clearResume(ss);
      this.set({ error: e instanceof ApiError ? e.message : "Could not connect to voice." });
```

   - In the constructor's resume block (item 5), apply the saved state first. Use `this.set({ muted: resume.muted, deafened: resume.deafened })` before the subscribe, and call `void this.join(resume.channelId, 0)`.

7. Add the method:

```ts
  /** Schedules rejoin attempt `prev + 1`. False once we have tried for long enough (the caller reports the loss). */
  private scheduleRetry(channelId: string, prev: number): boolean {
    if (prev === 0) this.retryStart = Date.now();
    const attempt = prev + 1;
    const delay = retryDelay(attempt, Date.now() - this.retryStart);
    if (delay === null) return false;
    this.set({ channelId, status: "reconnecting", retry: attempt });
    const now = () => {
      clearTimeout(this.retryTimer);
      window.removeEventListener("online", now);
      if (this.store.getState().retry === attempt) void this.join(channelId, attempt);
    };
    this.retryTimer = setTimeout(now, delay);
    window.addEventListener("online", now, { once: true });
    return true;
  }
```

8. `leave()`: add `clearTimeout(this.retryTimer); const ss = tabStorage(); if (ss) clearResume(ss);` before `this.disconnect();`. Also make `play("leave")` depend on `status !== "idle"` as it does now.
9. The `RoomEvent.Disconnected` handler becomes:

```ts
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!mine()) return; // we left on purpose
        if (this.store.getState().status === "connecting") return; // join() reports the failure
        const channelId = this.store.getState().channelId;
        this.disconnect();
        // Network trouble or the page being frozen: get back in. A kick, another tab or a closed room: stay out.
        if (!terminalReason(reason) && channelId && this.scheduleRetry(channelId, 0)) return;
        play("leave");
        const ss = tabStorage();
        if (ss) clearResume(ss);
        this.set({ error: (reason !== undefined && goodbye[reason]) || "The voice connection was lost." });
      });
```

10. The `VOICE_MOVE` handler: when `channel_id` is missing (moved out), call `this.leave()` instead of joining `undefined`. Check what the server sends first. If it never sends an empty move, leave this as it is.

- [ ] **Step 6: Show the attempt in the UI**

`VoicePanel.tsx`: read `retry` in the `useShallow` selector (`retry: x.retry`), and render the status as:

```tsx
                {v.status === "reconnecting" && v.retry ? `Disconnected · reconnecting… (attempt ${v.retry})` : STATUS[v.status]}
```

The Disconnect button already calls `voice.leave()`, which now also cancels the retry. In `MiniBars.tsx:75`, do the same: add `retry` to the selector and use `v.retry ? \`Reconnecting… (${v.retry})\` : STATUS[v.status]` in the `reconnecting` branch.

- [ ] **Step 7: Typecheck and run the voice tests**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk vitest run src/voice`
Expected: no type errors, and all voice tests pass. That includes the existing `voice.test.ts`, whose session mock has `store.subscribe`.

- [ ] **Step 8: Check in the browser**

With the dev stack running:
1. Join a voice channel, then reload the page. You must be back in the call within a few seconds, with the same mute and deafen state. Check that the members list shows you rejoining.
2. Stop the LiveKit container for 10 s, then start it. The panel shows "Disconnected · reconnecting… (attempt n)", then "Voice connected".
3. Click Disconnect while it is retrying. You must go idle with no further attempts.
4. Open a second tab and join the same channel there. The first tab shows "You joined voice somewhere else." and does not retry.

- [ ] **Step 9: Stage**

```bash
rtk git add clients/web/src/voice/resume.ts clients/web/src/voice/resume.test.ts clients/web/src/voice/voice.ts clients/web/src/app/voice/VoicePanel.tsx clients/web/src/app/mobile/MiniBars.tsx
```

---

### Task 4: Copy messages on the phone without marking text (A4)

**Root cause.** On a coarse pointer, the browser's own long-press text selection starts at the same moment as our 500 ms long-press. `preventDefault()` on `pointerdown` does not stop selection on iOS or Android. `copy` uses `navigator.clipboard`, which is undefined outside secure contexts and fails silently.

**Files:**
- Create: `clients/web/src/lib/clipboard.ts`
- Test: `clients/web/src/lib/clipboard.test.ts`
- Modify: `clients/web/src/app/MessageList.tsx` (row class ~:761, and the three `navigator.clipboard` calls at :868, :888, :934)
- Modify: `clients/web/src/app/message-actions.ts:14` (move `copy` first)
- Modify: `clients/web/src/app/message-actions.test.ts` (expected order)

**Interfaces:**
- Produces: `copyText(text: string, env?: { clipboard?: { writeText(t: string): Promise<void> }; fallback?: (t: string) => boolean }): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

Create `clients/web/src/lib/clipboard.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  it("uses the Clipboard API when there is one", async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyText("hi", { clipboard: { writeText }, fallback: () => false })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hi");
  });
  it("falls back when the API is missing", async () => {
    const fallback = vi.fn(() => true);
    expect(await copyText("hi", { clipboard: undefined, fallback })).toBe(true);
    expect(fallback).toHaveBeenCalledWith("hi");
  });
  it("falls back when the API rejects", async () => {
    const fallback = vi.fn(() => true);
    expect(await copyText("hi", { clipboard: { writeText: async () => { throw new Error("denied"); } }, fallback })).toBe(true);
  });
  it("reports failure when both fail", async () =>
    expect(await copyText("hi", { clipboard: undefined, fallback: () => false })).toBe(false));
});
```

In `message-actions.test.ts`, change the first expectation to `["react", "copy", "reply", "thread", "edit", "pin", "album", "delete"]`, and the "respects permissions" one to `["copy", "reply", "thread", "pin"]`.

- [ ] **Step 2: Run them and watch them fail**

Run: `rtk vitest run src/lib/clipboard.test.ts src/app/message-actions.test.ts`
Expected: FAIL. The module is missing, and the order is wrong.

- [ ] **Step 3: Implement**

`clients/web/src/lib/clipboard.ts`:

```ts
/** execCommand copy through a hidden textarea: works where the Clipboard API is missing (http, old WebViews). */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.append(el);
  el.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    el.remove();
  }
}

/** Copies `text`; whether it worked. */
export async function copyText(
  text: string,
  env: { clipboard?: { writeText(t: string): Promise<void> }; fallback?: (t: string) => boolean } = {
    clipboard: typeof navigator === "undefined" ? undefined : navigator.clipboard,
    fallback: legacyCopy,
  },
): Promise<boolean> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // permission denied or not focused: try the old way
    }
  }
  return env.fallback?.(text) ?? false;
}
```

`message-actions.ts`: move `if (m.content) out.push("copy");` up to just after `if (can.react) out.push("react");`.

`MessageList.tsx`:
- Import `copyText` from `@/lib/clipboard`.
- Replace each `navigator.clipboard?.writeText(m.content).catch(() => undefined)` with `copyText(m.content)`, so each becomes `() => void copyText(m.content)`.
- In the row's `className` string (~:761), add `pointer-coarse:select-none` next to `pointer-coarse:[-webkit-touch-callout:none]`.

- [ ] **Step 4: Run them and watch them pass**

Run: `rtk vitest run src/lib/clipboard.test.ts src/app/message-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Check in mobile emulation**

Use `resize_window` with the `mobile` preset, reload, and open a channel. Press and hold a message: use `left_click_drag` with the same start and end and hold, or check the computed `user-select` on the row with `javascript_tool`, which must be `none`. Check that:
- the sheet opens with "Copy text" right under the reactions row;
- after tapping it, `await navigator.clipboard.readText()` (in `javascript_tool`) returns the message.

Reset with the `desktop` preset afterwards.

- [ ] **Step 6: Stage**

```bash
rtk git add clients/web/src/lib/clipboard.ts clients/web/src/lib/clipboard.test.ts clients/web/src/app/MessageList.tsx clients/web/src/app/message-actions.ts clients/web/src/app/message-actions.test.ts
```

---

### Task 5: System page answers fast (A5)

**Root cause.** Every 5 s poll of `/api/admin/system/stats` waits on the updater's `GET /containers`. That calls Docker `stats?stream=false` for each running container (`updater/docker.go:102`), and Docker blocks about 1–2 s on each call while it takes a second CPU sample. The page renders nothing until the response arrives.

**Files:**
- Create: `server/internal/updater/cache.go`
- Test: `server/internal/updater/cache_test.go`
- Modify: `server/cmd/updater/main.go` (wrap the docker client in the cache and start it)
- Modify: `clients/web/src/app/server-settings/System.tsx:60` (loading text)

**Interfaces:**
- Consumes: `Lister` (`server.go:15`), `ContainerInfo`.
- Produces: `type CachedLister struct`, `func NewCachedLister(inner Lister, project string, every time.Duration) *CachedLister`, `func (c *CachedLister) Run(ctx context.Context)`, and `func (c *CachedLister) Containers(ctx context.Context, project string) ([]ContainerInfo, error)` (it satisfies `Lister`).

- [ ] **Step 1: Write the failing test**

`server/internal/updater/cache_test.go`:

```go
package updater

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type slowLister struct {
	calls atomic.Int32
	delay time.Duration
}

func (s *slowLister) Containers(ctx context.Context, _ string) ([]ContainerInfo, error) {
	n := s.calls.Add(1)
	select {
	case <-time.After(s.delay):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return []ContainerInfo{{Service: "server", CPUPercent: float64(n)}}, nil
}

func TestCachedListerAnswersFromCache(t *testing.T) {
	inner := &slowLister{delay: 200 * time.Millisecond}
	c := NewCachedLister(inner, "datrope", 20*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	// Before the first sample: falls through to the slow call once.
	cs, err := c.Containers(ctx, "datrope")
	require.NoError(t, err)
	require.Len(t, cs, 1)

	// After that every call is instant.
	require.Eventually(t, func() bool { return inner.calls.Load() >= 2 }, 2*time.Second, 10*time.Millisecond)
	start := time.Now()
	cs, err = c.Containers(ctx, "datrope")
	require.NoError(t, err)
	require.Less(t, time.Since(start), 20*time.Millisecond)
	require.Equal(t, "server", cs[0].Service)
}

func TestCachedListerIgnoresOtherProjects(t *testing.T) {
	inner := &slowLister{}
	c := NewCachedLister(inner, "datrope", time.Hour)
	_, err := c.Containers(context.Background(), "other")
	require.NoError(t, err)
	require.EqualValues(t, 1, inner.calls.Load()) // passed through, not cached
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `rtk go -C server test ./internal/updater -run CachedLister`
Expected: FAIL, because `NewCachedLister` is undefined.

- [ ] **Step 3: Implement `cache.go`**

```go
package updater

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// CachedLister keeps the project's container list, with CPU and memory, fresh in the background, so the System page's
// poll answers at once instead of waiting a second or two per container for Docker's stats.
type CachedLister struct {
	inner   Lister
	project string
	every   time.Duration

	mu   sync.Mutex
	last []ContainerInfo // nil until the first sample
}

func NewCachedLister(inner Lister, project string, every time.Duration) *CachedLister {
	return &CachedLister{inner: inner, project: project, every: every}
}

// Run samples until ctx ends.
func (c *CachedLister) Run(ctx context.Context) {
	t := time.NewTicker(c.every)
	defer t.Stop()
	for {
		c.sample(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (c *CachedLister) sample(ctx context.Context) {
	cs, err := c.inner.Containers(ctx, c.project)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("updater: container stats", "err", err)
		}
		return
	}
	c.mu.Lock()
	c.last = cs
	c.mu.Unlock()
}

// Containers answers from the last sample; before the first one (or for another project) it asks Docker directly.
func (c *CachedLister) Containers(ctx context.Context, project string) ([]ContainerInfo, error) {
	if project == c.project {
		c.mu.Lock()
		last := c.last
		c.mu.Unlock()
		if last != nil {
			return last, nil
		}
	}
	return c.inner.Containers(ctx, project)
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `rtk go -C server test ./internal/updater`
Expected: PASS, including the existing server tests.

- [ ] **Step 5: Wire it in `cmd/updater/main.go`**

After `compose` is built (where `project` is known), and before the `Server` is created:

```go
	containers := updater.NewCachedLister(docker, project, 5*time.Second)
	go containers.Run(ctx)
```

Set the `Server`'s `Docker` field to `containers` instead of `docker`. Add the `time` import if it is missing.

The restart handler uses the same lister to check whether a service is known. For that check, a 5 s old list is fine.

- [ ] **Step 6: Show a loading line on the client**

In `System.tsx`, after `<ErrorText error={error} />`, add:

```tsx
      {!stats && !error && <p className="text-muted-foreground" role="status">Loading…</p>}
```

- [ ] **Step 7: Build and run the tests**

Run: `rtk go -C server build ./... && rtk go -C server test ./internal/updater ./internal/system && rtk vitest run src/app/server-settings` (the last from `clients/web`)
Expected: all pass.

- [ ] **Step 8: Measure (if the dev updater runs under Docker)**

```bash
rtk curl -s -o /dev/null -w "%{time_total}\n" -H "Authorization: Bearer $DATROPE_UPDATER_TOKEN" http://localhost:8090/containers
```

Expected: under 0.2 s after the first sample. If no updater runs locally, say so in the report rather than claiming a measurement.

- [ ] **Step 9: Stage**

```bash
rtk git add server/internal/updater/cache.go server/internal/updater/cache_test.go server/cmd/updater/main.go clients/web/src/app/server-settings/System.tsx
```

---

## Final verification (after all tasks)

- `rtk pnpm -r typecheck`
- `rtk pnpm --filter @datrope/web test`
- `rtk go -C server test ./internal/updater ./internal/system`
- `rtk cargo test --manifest-path clients/desktop/src-tauri/Cargo.toml`
- `rtk lint`

Report each result as it came out. Do not commit; the user commits.
