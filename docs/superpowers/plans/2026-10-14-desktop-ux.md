# Desktop UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Datrope's desktop experience (web client ≥ 768 px with a mouse, plus the Tauri desktop app) work at every window width and from the keyboard, with one merged title bar, virtualized lists and a consistent visual system.

**Architecture:** Three phases, each shippable. Phase 1 adds pure layout/keyboard/announcement modules in `src/lib` (Vitest) and wires them into the existing shell (`AppShell`, `ChannelView`, `TopBar`, `SidePanel`, `MessageList`). Phase 2 lets a server page claim the Tauri title bar through new narrow bridge commands, syncs its theme to the bundled screens, and moves message/member/gallery lists onto `react-virtuoso`. Phase 3 adds a shortcut registry, one settings layout, skeleton/empty states and type/motion tokens. The phone shell (< 768 px) is not changed.

**Tech Stack:** React 18, react-router-dom 6, zustand (vanilla stores), shadcn/ui new-york + Radix (`radix-ui`), Tailwind CSS v4, dnd-kit, `react-virtuoso` (new), vitest 2 (node environment, no testing-library; `renderToStaticMarkup` pattern), Playwright; Tauri 2 (Rust, `clients/desktop/src-tauri`).

**Spec:** `docs/superpowers/specs/2026-10-14-desktop-ux-design.md` (audit: `docs/superpowers/specs/2026-10-14-desktop-ux-audit.md`; product: `PRODUCT.md`; phone layout: `docs/superpowers/specs/2026-10-12-mobile-ux-design.md`)

## Global Constraints

- **Never commit.** AGENTS.md: no `git commit`/`push`/`stash`/amend/tag. Leave changes in the working tree; each task ends with "Stage and pause for review" and a suggested commit message the user may use.
- Paths are relative to `clients/web/` unless they start with `clients/desktop/`, `docs/` or `deploy/`.
- Desktop layout = viewport ≥ 768 px (`!useIsMobile()`, `MOBILE_QUERY = "(max-width: 767px)"`). Tiers: **wide** ≥ 1280, **medium** 1024–1279, **narrow** 768–1023. Phone rules from the mobile spec are untouched; every new desktop branch is guarded by `!mobile`.
- Widths: channel sidebar 240 px (`w-60`); docked member list 240 px; side panel 360 px; search box 260 px (wide) / 200 px (medium) / icon (narrow); slide-over member list 280 px.
- Message prose cap: `max-w-[80ch]`. Rows, hover backgrounds, embeds, attachments and the composer stay full width.
- Member list preference: `localStorage` key `datrope.members` (`"0"` hidden, `"1"` shown), default shown, read/write wrapped in try/catch.
- Message keys (row focused, no Ctrl/Meta/Alt): ↑/↓ prev/next, Home/End first/last loaded, Enter actions menu, `r` reply, `e` edit, `t` thread, `p` pin, `+` react, Delete delete, Esc → composer. Shift+F10/ContextMenu stay native (Radix).
- Shortcuts (Phase 3): Alt+↑/↓ channel, Alt+Shift+↑/↓ unread channel, ↑ in empty composer edit last, Esc in chat mark read + jump to present, Ctrl/Cmd+F search, Ctrl/Cmd+Shift+M mute, Ctrl/Cmd+Shift+D deafen, Ctrl/Cmd+/ shortcut sheet, printable key on nothing editable → composer. Ignored while `event.isComposing`.
- Tauri: server webviews get **no** `core:window:*` permissions. New commands `desktop_window`, `desktop_title_bar`, `desktop_set_theme`, `desktop_start_drag` only. Window/drag commands use their own limiter (30 per 10 s); theme uses another (10 per 10 s); the existing 5/10 s notify limiter is untouched.
- Theme payload: ≤ 64 entries, token names from the allowlist in Task 15, values matching `^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([^;{}<>]*\))$` and ≤ 200 chars; any invalid entry drops the whole payload.
- UI rules (AGENTS.md): fetch shadcn components with `pnpm dlx shadcn@latest add <name>` from `clients/web` (fallback: `https://ui.shadcn.com/r/styles/new-york-v4/<name>.json`, fix imports to `@/components/ui/*` and `@/lib/utils`); tokens only, no hardcoded colours; dark-only (strip `dark:`); `cn()` from `@/lib/utils`; `@/` imports; `React.forwardRef` for `asChild` triggers (or `RefButton` from `@/components/ref-button`); keep `Button` defaults (`type="button"`, destructive uses `text-destructive-foreground`), `Slider` aria-label on the thumb, `TooltipContent hideWhenDetached`.
- Keep accessible names and roles stable. E2E selects e.g. `getByRole("link", { name: "general" })`, `getByRole("heading", { name: "# general" })`, `getByLabel("Message", { exact: true })`, `getByRole("button", { name: "Datrope menu" })`, `getByRole("log", …)`/`"Messages"`, `Add reaction`, `Back to chat`. Headings keep their names when their level changes.
- Vitest runs in node without a DOM. Put logic in pure functions under `src/lib/` and test them; DOM behaviour is verified by Playwright (Tasks 12, 21, 28).
- Reduced motion: every new transition uses `motion-safe:` or the Phase 3 tokens' reduced-motion rule.
- Prefix shell commands with `rtk` where available (fallback plain `pnpm`/`cargo`).
- Run unit tests with `rtk pnpm --filter @datrope/web test`, typecheck with `rtk pnpm --filter @datrope/web typecheck`, lint with `rtk pnpm lint` (repo root), Rust with `rtk cargo test` in `clients/desktop/src-tauri`.

**Deliberate narrowing of the spec (report these in task reports, don't silently expand):**
- Spec 1.5 "ARIA tree" for the channel list: rows stay `link`s (e2e and screen-reader users rely on link semantics), with arrow-key roving focus and `aria-expanded` on category toggles, no `role="tree"`. Same for DM rows.
- Spec 1.1 "Inbox moves into ⋯" in the narrow tier: the Inbox keeps its icon button (it is a popover with its own state); Threads, Pins, Members and Leave group move into ⋯.
- Spec 1.7 "muted channels not announced": the app has no per-channel mute; only messages in the channel on screen, from others, while the window has focus, are announced.
- Spec 2.1 commands: `desktop_window` also accepts `"servers"` (open the drawer) and `"update"` (restart to update), needed because the page bar replaces the shell bar's buttons.

## Review Focus

1. **Resizing across 1280 / 1024 / 768 px with a panel or slide-over open** must keep the panel's content and never leave an invisible modal trapping focus. → Playwright step "resize keeps the thread" in Task 12.
2. **Typing a letter while a message row is focused vs. inside its reaction/link/button** — `r` on a focused link must not start a reply. → `messageKeyAction` "child target" cases in Task 6.
3. **An older server (web app without `claimTitleBar`) in the desktop app** keeps the 32 px shell bar and working window buttons. → Rust `layout_rects` "unclaimed" test in Task 13 and manual step in Task 28.
4. **Malformed or hostile theme payloads** (`url(...)`, `;`, 1000 entries, unknown names) are dropped whole and never reach `style`. → `validate_theme` tests in Task 15.
5. **Jump-to-message and unread line under virtualization** (target not rendered yet, or far back) still scroll to and flash the right message. → Playwright "jump from search to an old message" in Task 21.

---

## File map

**Phase 1 — window layout and keyboard**
- Create `src/lib/layout-tier.ts` (+ test), `src/hooks/use-layout-tier.ts`
- Create `src/lib/members-pref.ts` (+ test)
- Create `src/lib/roving.ts` (+ test), `src/hooks/use-arrow-nav.ts`
- Create `src/lib/message-keys.ts` (+ test)
- Create `src/lib/focus.ts` (+ test)
- Create `src/lib/announce.ts` (+ test), `src/app/MessageAnnouncer.tsx`
- Create `src/app/ChannelsButton.tsx`, `src/components/skip-links.tsx`
- Modify `src/app/AppShell.tsx`, `src/app/ChannelView.tsx`, `src/app/TopBar.tsx`, `src/app/search/SearchBox.tsx`, `src/app/side-panel/SidePanel.tsx`, `src/app/side-panel/panel.ts`, `src/app/MessageList.tsx`, `src/app/MessageToolbar.tsx`, `src/app/MemberList.tsx`, `src/app/DMList.tsx`, `src/app/ServerSidebar.tsx`, `src/app/sidebar/ChannelTree.tsx`, `src/app/sidebar/CategoryHeader.tsx`, `src/app/voice/CallControls.tsx`, `src/app/gallery/GalleryView.tsx`, `src/app/DMView.tsx`, `src/app/voice/VoiceChannelView.tsx`, `src/app/forum/*View.tsx` headings, `src/app/welcome/WelcomeMarkdown.tsx`, `src/styles.css`, `src/styles.test.ts`, `src/components/ui/*.tsx` (focus ring)
- Modify `playwright.config.ts`; create `e2e/desktop.spec.ts`

**Phase 2 — desktop app chrome and messages**
- Modify `clients/desktop/src-tauri/build.rs`, `src/commands.rs`, `src/shell.rs`, `src/lib.rs` (handler list), `src/state.rs`
- Create `clients/desktop/src-tauri/src/theme.rs`
- Modify `clients/desktop/src/{drawer.tsx,ServerDrawer.tsx,main.tsx,offline.tsx,picker.tsx,rail-api.ts}`; create `clients/desktop/src/theme.ts`
- Modify `src/desktop.ts` (+ `src/desktop.test.ts`), `src/app/DesktopBridge.tsx`, `src/app/TopBar.tsx`; create `src/app/WindowControls.tsx`, `src/lib/theme-tokens.ts` (+ test)
- Add `react-virtuoso`; modify `src/app/MessageList.tsx`, `src/app/MemberList.tsx`, `src/app/gallery/GalleryView.tsx`
- Create `src/lib/message-time.ts` (+ test), `src/lib/message-items.ts` (+ test)
- Modify image sites for `loading="lazy"`
- Modify `e2e/desktop.spec.ts`, `e2e/chat.spec.ts` (scroll-first where needed)

**Phase 3 — polish and shortcuts**
- Create `src/lib/shortcuts.ts` (+ test), `src/hooks/use-shortcuts.ts`, `src/components/shortcut-sheet.tsx`
- Fetch shadcn `kbd`, `skeleton`, `empty`
- Create `src/components/settings-layout.tsx`, `src/app/settings/UserSettingsPage.tsx`; modify `src/app/settings/settings-store.ts`, `src/router.tsx`, `src/app/server-settings/ServerSettings.tsx`, `src/app/settings/UserSettingsDialog.tsx` (removed on desktop)
- Modify `src/styles.css` (type + motion tokens), many components (type scale, raw buttons, sliders, empty/skeleton)
- Modify `clients/desktop/src/ServerDrawer.tsx`, `clients/desktop/src/Chrome.tsx`

---

## Phase 1 — Window layout and keyboard

### Task 1: Layout tiers

**Files:**
- Create: `src/lib/layout-tier.ts`
- Create: `src/lib/layout-tier.test.ts`
- Create: `src/hooks/use-layout-tier.ts`

**Interfaces:**
- Produces: `type LayoutTier = "phone" | "narrow" | "medium" | "wide"`; `tierFor(width: number): LayoutTier`; `TIER_QUERIES: { medium: string; wide: string }`; hook `useLayoutTier(): LayoutTier`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/layout-tier.test.ts
import { describe, expect, it } from "vitest";
import { tierFor } from "./layout-tier";

describe("tierFor", () => {
  it("maps widths to tiers at 768, 1024 and 1280", () => {
    expect(tierFor(375)).toBe("phone");
    expect(tierFor(767)).toBe("phone");
    expect(tierFor(768)).toBe("narrow");
    expect(tierFor(1023)).toBe("narrow");
    expect(tierFor(1024)).toBe("medium");
    expect(tierFor(1279)).toBe("medium");
    expect(tierFor(1280)).toBe("wide");
    expect(tierFor(2560)).toBe("wide");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm --filter @datrope/web test -- layout-tier`
Expected: FAIL, cannot resolve `./layout-tier`.

- [ ] **Step 3: Implement**

```ts
// src/lib/layout-tier.ts
/** Desktop layout tiers (see the desktop UX spec, 1.1). "phone" is the mobile shell below 768 px. */
export type LayoutTier = "phone" | "narrow" | "medium" | "wide";

export const TIER_QUERIES = { phone: "(max-width: 767px)", medium: "(min-width: 1024px)", wide: "(min-width: 1280px)" };

export function tierFor(width: number): LayoutTier {
  if (width < 768) return "phone";
  if (width < 1024) return "narrow";
  if (width < 1280) return "medium";
  return "wide";
}
```

```ts
// src/hooks/use-layout-tier.ts
import { useEffect, useState } from "react";
import { TIER_QUERIES, tierFor, type LayoutTier } from "@/lib/layout-tier";

const current = (): LayoutTier => (typeof window === "undefined" ? "wide" : tierFor(window.innerWidth));

/** The window's layout tier; follows resizing (one listener per breakpoint, not per resize event). */
export function useLayoutTier(): LayoutTier {
  const [tier, setTier] = useState(current);
  useEffect(() => {
    const mqs = Object.values(TIER_QUERIES).map((q) => window.matchMedia?.(q)).filter((m): m is MediaQueryList => !!m);
    const on = () => setTier(current());
    on();
    for (const m of mqs) m.addEventListener("change", on);
    return () => { for (const m of mqs) m.removeEventListener("change", on); };
  }, []);
  return tier;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm --filter @datrope/web test -- layout-tier`
Expected: PASS.

- [ ] **Step 5: Stage and pause for review**

`git add src/lib/layout-tier.ts src/lib/layout-tier.test.ts src/hooks/use-layout-tier.ts` — suggested message: `feat(web): desktop layout tiers`.

---

### Task 2: Member list toggle and slide-overs (members, side panel)

**Files:**
- Create: `src/lib/members-pref.ts`, `src/lib/members-pref.test.ts`
- Modify: `src/app/ChannelView.tsx` (members button, docked list, sheet)
- Modify: `src/app/MemberList.tsx:60` (drop `max-[760px]:hidden`)
- Modify: `src/app/side-panel/SidePanel.tsx` (docked vs sheet; focus; Esc)
- Modify: `src/app/side-panel/panel.ts` (remember opener, restore focus)

**Interfaces:**
- Consumes: `useLayoutTier()` (Task 1).
- Produces: `readMembersPref(storage?: Pick<Storage,"getItem">): boolean`; `writeMembersPref(open: boolean, storage?: Pick<Storage,"setItem">): void`; `panel.ts` `openPanel(p)` now records `document.activeElement` as the opener; `closePanel()` restores focus to it when still connected.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/members-pref.test.ts
import { describe, expect, it } from "vitest";
import { readMembersPref, writeMembersPref } from "./members-pref";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("members pref", () => {
  it("defaults to shown", () => expect(readMembersPref(mem())).toBe(true));
  it("round-trips", () => {
    const s = mem();
    writeMembersPref(false, s);
    expect(readMembersPref(s)).toBe(false);
    writeMembersPref(true, s);
    expect(readMembersPref(s)).toBe(true);
  });
  it("survives storage that throws", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readMembersPref(bad)).toBe(true);
    expect(() => writeMembersPref(false, bad)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm --filter @datrope/web test -- members-pref`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the pref**

```ts
// src/lib/members-pref.ts
const KEY = "datrope.members";
const store = (): Storage | undefined => {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
};

/** Whether the docked member list is shown (wide windows). Default: shown. */
export function readMembersPref(s: Pick<Storage, "getItem"> | undefined = store()): boolean {
  try { return s?.getItem(KEY) !== "0"; } catch { return true; }
}
export function writeMembersPref(open: boolean, s: Pick<Storage, "setItem"> | undefined = store()): void {
  try { s?.setItem(KEY, open ? "1" : "0"); } catch { /* private mode: not remembered */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm --filter @datrope/web test -- members-pref`
Expected: PASS.

- [ ] **Step 5: Wire the member list in `ChannelView.tsx`**

Add imports `useLayoutTier` and `readMembersPref, writeMembersPref`. Below `const mobile = useIsMobile();` add:

```tsx
  const tier = useLayoutTier();
  const docked = tier === "wide";
  const [membersDocked, setMembersDocked] = useState(readMembersPref);
  const toggleMembers = () => {
    if (!docked) return setShowMembers(true); // phone, narrow and medium: the member list slides over
    setMembersDocked((v) => { writeMembersPref(!v); return !v; });
  };
```

Replace the Members button (currently `className="text-muted-foreground md:hidden" onClick={() => setShowMembers(true)}`) with:

```tsx
            {members && !mobile && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex">
                    <Button variant="ghost" size="icon-sm" aria-label="Members" aria-pressed={docked ? membersDocked && !panel : showMembers}
                      className={(docked ? membersDocked && !panel : showMembers) ? "text-foreground" : "text-muted-foreground"}
                      onClick={toggleMembers}>
                      <Users />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{docked && membersDocked ? "Hide members" : "Show members"}</TooltipContent>
              </Tooltip>
            )}
```

(Phones keep reaching members through `phoneActions`, unchanged.)

Replace the docked fallback `) : members && <MemberList />}` with `) : members && docked && membersDocked && <MemberList />}`.

Change the members `SheetContent` class to `"w-[85vw] max-w-80 gap-0 p-0 sm:max-w-80 md:w-[280px]"`. When the tier becomes wide while the sheet is open, close it:

```tsx
  useEffect(() => { if (docked) setShowMembers(false); }, [docked]);
```

In `MemberList.tsx:60` change `sheet ? "h-full w-full border-l-0" : "max-[760px]:hidden"` to `sheet ? "h-full w-full border-l-0" : undefined`.

- [ ] **Step 6: Make `SidePanel` dock or slide over**

Replace `src/app/side-panel/SidePanel.tsx` body with:

```tsx
import { MessageSquare, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLayoutTier } from "@/hooks/use-layout-tier";

/** The right-hand panel next to a channel (a thread, the threads list, search, a gallery item, a voice channel's chat).
 *  Wide windows dock it beside the chat; narrow and medium windows slide it over the chat (a modal sheet: focus moves in,
 *  Esc closes, focus returns). Phones keep the full-screen overlay. */
export function SidePanel({ title, label = title, closeLabel = `Close ${title.toLowerCase()}`, icon, subtitle, actions, onClose, children }: {
  title: string; label?: string; closeLabel?: string; icon?: ReactNode; subtitle?: string; actions?: ReactNode;
  onClose: () => void; children: ReactNode;
}) {
  const mobile = useIsMobile();
  const tier = useLayoutTier();
  const heading = useRef<HTMLHeadingElement>(null);
  const docked = !mobile && tier === "wide";
  // Docked: move focus to the heading on open, so keyboard and screen reader users land in the panel.
  useEffect(() => { if (docked) heading.current?.focus({ preventScroll: true }); }, [docked, title]);

  const header = (
    <header className="flex min-h-14 flex-none items-center gap-2 border-b pl-4 pr-2 max-md:pt-[env(safe-area-inset-top,0px)]">
      <span className="flex-none text-muted-foreground [&_svg]:size-4" aria-hidden>{icon ?? <MessageSquare />}</span>
      <div className="min-w-0 flex-1">
        <h2 ref={heading} tabIndex={-1} className="truncate text-[15px] font-semibold outline-none">{title}</h2>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {actions}
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={closeLabel} title="Close" onClick={onClose}>
        <X />
      </Button>
    </header>
  );

  if (!mobile && !docked) {
    return (
      <Sheet open onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" aria-label={label} className="w-[360px] gap-0 p-0 sm:max-w-[360px] [&>button.absolute]:hidden">
          <SheetTitle className="sr-only">{label}</SheetTitle>
          <SheetDescription className="sr-only">{subtitle ?? title}</SheetDescription>
          {header}
          {children}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <aside aria-label={label}
      onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } }}
      className="flex min-h-0 w-[360px] max-w-full flex-none flex-col border-l bg-card max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-full max-md:border-l-0 max-md:pb-safe max-md:shadow-xl">
      {header}
      {children}
    </aside>
  );
}
```

`[&>button.absolute]:hidden` hides the sheet's built-in close button (our header has one with the stable `closeLabel`). Check `components/ui/sheet.tsx` renders its close as a direct child `button` with class `absolute`; if its selector differs, match it there.

- [ ] **Step 7: Remember and restore the opener in `panel.ts`**

```ts
let opener: HTMLElement | null = null;

export function openPanel(p: Panel) {
  if (!p) return closePanel();
  const wasOpen = panelStore.getState().panel !== null;
  if (!wasOpen && typeof document !== "undefined") opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // … existing body unchanged …
}

const restoreOpener = () => {
  const el = opener;
  opener = null;
  if (el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
};
const clearPanel = () => { panelStore.setState({ panel: null }); restoreOpener(); };
```

(`clearPanel` is already the layer's close callback, so Back, the close button and Esc all restore focus.)

- [ ] **Step 8: Typecheck and test**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test`
Expected: no errors; all tests pass.

- [ ] **Step 9: Check in the browser**

Start `datrope-server` and `datrope-web` (`.claude/launch.json`), sign in, open `#general`:
- 1440×900: Members button toggles the docked list; reload keeps the choice.
- 1100×800: the list is hidden; Members opens a 280 px slide-over; Esc closes it and focus is back on the Members button.
- 1100×800: Threads opens a 360 px slide-over; Esc closes it; focus returns to the Threads button.

- [ ] **Step 10: Stage and pause for review**

Suggested message: `feat(web): member toggle and slide-over panels on desktop`.

---

### Task 3: Narrow tier — Channels sheet, degrading top bar, no sideways scroll

**Files:**
- Create: `src/app/ChannelsButton.tsx`
- Modify: `src/app/AppShell.tsx` (hide docked sidebar in narrow)
- Modify: `src/app/TopBar.tsx` (Channels button; ⋯ menu in narrow; title min width)
- Modify: `src/app/search/SearchBox.tsx` (tier widths, icon in narrow)
- Modify: `src/app/ChannelView.tsx` (Pins sheet in narrow; pass `phoneActions` for the ⋯ menu)
- Modify: `src/app/MessageList.tsx` (scroller `overflow-x-hidden`)

**Interfaces:**
- Consumes: `useLayoutTier()`; `PhoneAction` type from `TopBar.tsx`.
- Produces: `ChannelsButton` (no props); TopBar renders `phoneActions` in a `DropdownMenu` labelled `More actions` when `tier === "narrow"`.

- [ ] **Step 1: `ChannelsButton`**

```tsx
// src/app/ChannelsButton.tsx
import { PanelLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ServerSidebar } from "./ServerSidebar";

/** Narrow desktop windows: the channel list lives in a left sheet behind this button. */
export function ChannelsButton() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]); // picking a channel closes the sheet
  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label="Channels" aria-expanded={open} className="-ml-1 text-muted-foreground" onClick={() => setOpen(true)}>
        <PanelLeft />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-60 gap-0 p-0 sm:max-w-60 [&>button.absolute]:hidden">
          <SheetTitle className="sr-only">Channels</SheetTitle>
          <SheetDescription className="sr-only">Channels and direct messages</SheetDescription>
          <ServerSidebar />
        </SheetContent>
      </Sheet>
    </>
  );
}
```

`ServerSidebar`'s `<nav>` has `w-60`; inside the sheet add `className` support if it needs `h-full`: change its root to `cn("flex w-60 flex-none flex-col border-r bg-sidebar", className)` with an optional `className` prop and pass `className="h-full border-r-0"` here.

- [ ] **Step 2: `AppShell` hides the docked sidebar in narrow**

```tsx
  const tier = useLayoutTier();
  …
            {!pathname.startsWith("/server-settings") && tier !== "narrow" && <ServerSidebar />}
```

- [ ] **Step 3: `TopBar` desktop branch**

In the non-phone branch of `TopBar`:

```tsx
  const tier = useLayoutTier();
  const narrow = tier === "narrow";
  return (
    <header className={header}>
      <BackButton className="-ml-1 md:hidden" />
      {narrow && <ChannelsButton />}
      <div className="flex min-w-0 flex-1 items-center gap-2 [&>:is(h1,h2)]:min-w-[12ch] [&>:is(h1,h2)]:shrink [&>:is(h1,h2)]:truncate">{children}</div>
      <div className="flex flex-none items-center gap-1">
        {narrow && phoneActions ? <MoreMenu actions={phoneActions} /> : actions}
        {tools && (
          <>
            <InboxButton />
            <SearchBox />
          </>
        )}
      </div>
    </header>
  );
```

and add, in the same file:

```tsx
/** Narrow desktop windows: a view's buttons as one ⋯ menu. */
function MoreMenu({ actions }: { actions: PhoneAction[] }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <RefButton variant="ghost" size="icon-sm" aria-label="More actions" className="text-muted-foreground"><MoreVertical /></RefButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {actions.map((a) => (
          <DropdownMenuItem key={a.label} variant={a.destructive ? "destructive" : "default"} onSelect={a.onSelect}>{a.icon}{a.label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Also update the phone branch selectors `[&>h2]:…` to `[&>:is(h1,h2)]:…` so Task 8's `<h1>` keeps truncating.

- [ ] **Step 4: `ChannelView` — Pins sheet and members in narrow**

The `Pinned messages` phone action opens `PinsSheet`, which only mounts when `mobile`. Mount it when `mobile || tier === "narrow"`:

```tsx
        {(mobile || tier === "narrow") && <PinsSheet channelId={channelId} open={pins} onOpenChange={setPins} onJump={jumpToPin} />}
```

and keep `ChannelInfoSheet` and `ChannelSettingsDialog` phone-only (move `PinsSheet` out of the `mobile &&` fragment). `phoneActions` already lists Threads, Pinned messages, Members, Start call, Leave group.

- [ ] **Step 5: `SearchBox` widths and icon**

```tsx
  const tier = useLayoutTier();
  const compact = mobile || tier === "narrow";
  const [expanded, setExpanded] = useState(false);
  …
  if (compact && !expanded && !query) { /* existing icon button, unchanged */ }
  …
        <div ref={box} className={cn("relative w-[260px] flex-none max-[1279px]:w-[200px]",
          compact && "absolute inset-x-2 top-1/2 z-10 w-auto -translate-y-1/2 bg-topbar max-[1279px]:w-auto")}>
  …
          <Input … autoFocus={compact} … />
```

Keep the `Commands` option `mobile`-only.

- [ ] **Step 6: No sideways scroll in the message list**

In `MessageList.tsx` add `overflow-x-hidden` to the scroller's class (`"flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden overscroll-y-contain pb-2 pt-4"`).

- [ ] **Step 7: Typecheck, test, check in the browser**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test`
At 820×700: the Channels button opens the list as a left sheet; picking `random` closes it and opens `# random`; the title `# general` is fully visible; ⋯ lists Threads, Pinned messages, Members; the search icon expands the box; `document.querySelector('[role=log]').scrollWidth === clientWidth`.

- [ ] **Step 8: Stage and pause for review**

Suggested message: `feat(web): narrow desktop windows keep a usable chat column`.

---

### Task 4: Readable line length

**Files:**
- Modify: `src/app/MessageList.tsx` (message content wrapper)
- Modify: `src/app/welcome/WelcomeMarkdown.tsx:69` wrapper
- Modify: forum post body (`src/app/forum/PostPanel.tsx`, the element that renders the post's `MessageList`/`Markdown`)
- Modify: `src/styles.test.ts`

- [ ] **Step 1: Write the failing test** (append to `src/styles.test.ts`)

```ts
describe("readable line length", () => {
  it("caps message prose at 80ch", () => {
    const src = readFileSync(new URL("./app/MessageList.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/wrap-anywhere max-w-\[80ch\]/);
  });
  it("caps welcome prose at 80ch", () => {
    const src = readFileSync(new URL("./app/welcome/WelcomeMarkdown.tsx", import.meta.url), "utf8");
    expect(src).toContain("max-w-[80ch]");
  });
});
```

- [ ] **Step 2: Run it**

Run: `rtk pnpm --filter @datrope/web test -- styles`
Expected: FAIL on both.

- [ ] **Step 3: Implement**

In `MessageRow`, the content `div` becomes `<div className={cn("wrap-anywhere max-w-[80ch]", m.pending && "opacity-60")}>`. In `WelcomeMarkdown.tsx` wrap the rendered groups' container with `max-w-[80ch]` (the element that maps groups to `<Markdown>`). Forum posts: check `PostPanel.tsx` (`rtk grep -n "MessageList\|<Markdown" src/app/forum`); if the post body renders through `MessageList` it inherits the cap, otherwise add `max-w-[80ch]` to the element wrapping its `<Markdown>`.

- [ ] **Step 4: Run tests**

Run: `rtk pnpm --filter @datrope/web test -- styles`
Expected: PASS. At 2560×1200 a long paragraph wraps at ≈ 80 characters; the hover background still spans the row.

- [ ] **Step 5: Stage and pause for review**

Suggested message: `feat(web): cap message prose at 80 characters per line`.

---

### Task 5: Arrow-key roving focus primitive

**Files:**
- Create: `src/lib/roving.ts`, `src/lib/roving.test.ts`
- Create: `src/hooks/use-arrow-nav.ts`

**Interfaces:**
- Produces: `nextIndex(key: string, current: number, count: number, orientation?: "vertical" | "horizontal" | "grid", columns?: number): number | null`; hook `useArrowNav(ref: RefObject<HTMLElement>, selector: string, opts?: { orientation?: "vertical" | "horizontal" | "grid"; columns?: () => number }): void` — roving `tabIndex` (one item `0`, the rest `-1`) over `ref.current.querySelectorAll(selector)`, arrow/Home/End move focus.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/roving.test.ts
import { describe, expect, it } from "vitest";
import { nextIndex } from "./roving";

describe("nextIndex", () => {
  it("moves vertically and clamps (no wrap)", () => {
    expect(nextIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextIndex("ArrowDown", 2, 3)).toBe(2);
    expect(nextIndex("ArrowUp", 0, 3)).toBe(0);
    expect(nextIndex("Home", 2, 3)).toBe(0);
    expect(nextIndex("End", 0, 3)).toBe(2);
  });
  it("ignores keys of the other axis", () => {
    expect(nextIndex("ArrowLeft", 1, 3)).toBeNull();
    expect(nextIndex("ArrowDown", 1, 3, "horizontal")).toBeNull();
    expect(nextIndex("ArrowRight", 1, 3, "horizontal")).toBe(2);
  });
  it("moves by rows in a grid", () => {
    expect(nextIndex("ArrowDown", 1, 10, "grid", 4)).toBe(5);
    expect(nextIndex("ArrowDown", 8, 10, "grid", 4)).toBe(8);
    expect(nextIndex("ArrowRight", 3, 10, "grid", 4)).toBe(4);
  });
  it("handles an empty list and unknown keys", () => {
    expect(nextIndex("ArrowDown", 0, 0)).toBeNull();
    expect(nextIndex("a", 0, 3)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `rtk pnpm --filter @datrope/web test -- roving`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/roving.ts
/** Where an arrow/Home/End key moves focus in a list of `count` items, or null when the key doesn't move it. */
export function nextIndex(key: string, current: number, count: number,
  orientation: "vertical" | "horizontal" | "grid" = "vertical", columns = 1): number | null {
  if (count === 0) return null;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const v = orientation !== "horizontal", h = orientation !== "vertical";
  const row = orientation === "grid" ? columns : 1;
  if (v && key === "ArrowDown") return current + row < count ? current + row : current;
  if (v && key === "ArrowUp") return current - row >= 0 ? current - row : current;
  if (h && key === "ArrowRight") return clamp(current + 1);
  if (h && key === "ArrowLeft") return clamp(current - 1);
  return null;
}
```

```ts
// src/hooks/use-arrow-nav.ts
import { useEffect, type RefObject } from "react";
import { nextIndex } from "@/lib/roving";

/** Roving focus over `selector` inside `ref`: one item is in the tab order; arrows, Home and End move between items. */
export function useArrowNav(ref: RefObject<HTMLElement>, selector: string,
  opts: { orientation?: "vertical" | "horizontal" | "grid"; columns?: () => number } = {}) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = () => [...root.querySelectorAll<HTMLElement>(selector)];
    const settle = (active?: HTMLElement) => {
      const all = items();
      const current = active ?? all.find((el) => el.tabIndex === 0) ?? all.find((el) => el.getAttribute("aria-current") === "page") ?? all[0];
      for (const el of all) el.tabIndex = el === current ? 0 : -1;
    };
    settle();
    const onFocus = (e: FocusEvent) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(selector);
      if (t && root.contains(t)) settle(t);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      const all = items();
      const i = all.indexOf(e.target as HTMLElement);
      if (i < 0) return; // keys inside an item's own controls are theirs
      const n = nextIndex(e.key, i, all.length, opts.orientation, opts.columns?.() ?? 1);
      if (n === null) return;
      e.preventDefault();
      all[n]?.focus();
    };
    const mo = new MutationObserver(() => settle());
    mo.observe(root, { childList: true, subtree: true });
    root.addEventListener("focusin", onFocus);
    root.addEventListener("keydown", onKey);
    return () => { mo.disconnect(); root.removeEventListener("focusin", onFocus); root.removeEventListener("keydown", onKey); };
  }, [ref, selector, opts.orientation, opts.columns]);
}
```

- [ ] **Step 4: Run tests**

Run: `rtk pnpm --filter @datrope/web test -- roving`
Expected: PASS.

- [ ] **Step 5: Stage and pause for review**

Suggested message: `feat(web): roving focus primitive`.

---

### Task 6: Message list keyboard model and focus return

**Files:**
- Create: `src/lib/message-keys.ts`, `src/lib/message-keys.test.ts`
- Create: `src/lib/focus.ts`, `src/lib/focus.test.ts`
- Modify: `src/app/MessageList.tsx` (roving rows, key handling, delete/edit/context-menu focus)
- Modify: `src/app/MessageToolbar.tsx` (data hooks for `+` and the actions menu — the menu itself is Task 9)

**Interfaces:**
- Produces: `type MessageKey = "prev" | "next" | "first" | "last" | "menu" | "reply" | "edit" | "thread" | "pin" | "react" | "delete" | "composer"`; `messageKeyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean }, onRow: boolean): MessageKey | null`.
- Produces: `shouldKeepFocus(active: { contains?(n: unknown): boolean } | null, trigger: { contains(n: unknown): boolean } | null, body: unknown): boolean` — true when focus already moved to something outside the trigger (so a menu/dialog must not pull it back).
- Produces: rows carry `data-message-row` and `tabIndex` (`0` for the remembered row, `-1` otherwise); the toolbar's react button carries `data-message-react`; Task 9's menu trigger carries `data-message-menu`.
- Produces (DOM contract used by Task 17): `focusRow(scroller: HTMLElement, id: string)` helper in `MessageList.tsx`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/message-keys.test.ts
import { describe, expect, it } from "vitest";
import { messageKeyAction } from "./message-keys";

const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("messageKeyAction", () => {
  it("maps keys on a focused row", () => {
    expect(messageKeyAction(k("ArrowUp"), true)).toBe("prev");
    expect(messageKeyAction(k("ArrowDown"), true)).toBe("next");
    expect(messageKeyAction(k("Home"), true)).toBe("first");
    expect(messageKeyAction(k("End"), true)).toBe("last");
    expect(messageKeyAction(k("Enter"), true)).toBe("menu");
    expect(messageKeyAction(k("r"), true)).toBe("reply");
    expect(messageKeyAction(k("R"), true)).toBe("reply");
    expect(messageKeyAction(k("e"), true)).toBe("edit");
    expect(messageKeyAction(k("t"), true)).toBe("thread");
    expect(messageKeyAction(k("p"), true)).toBe("pin");
    expect(messageKeyAction(k("+"), true)).toBe("react");
    expect(messageKeyAction(k("Delete"), true)).toBe("delete");
    expect(messageKeyAction(k("Escape"), true)).toBe("composer");
  });
  it("leaves keys inside a row's own controls alone (child target)", () => {
    for (const key of ["r", "e", "Enter", "ArrowUp", "Delete", "+"]) expect(messageKeyAction(k(key), false)).toBeNull();
  });
  it("ignores modified keys and IME composition", () => {
    expect(messageKeyAction(k("r", { ctrlKey: true }), true)).toBeNull();
    expect(messageKeyAction(k("ArrowUp", { altKey: true }), true)).toBeNull(); // Alt+↑ is channel switching
    expect(messageKeyAction(k("e", { metaKey: true }), true)).toBeNull();
    expect(messageKeyAction(k("r", { isComposing: true }), true)).toBeNull();
  });
  it("ignores other keys", () => expect(messageKeyAction(k("x"), true)).toBeNull());
});
```

```ts
// src/lib/focus.test.ts
import { describe, expect, it } from "vitest";
import { shouldKeepFocus } from "./focus";

const node = (kids: unknown[] = []) => ({ contains: (n: unknown) => n === node || kids.includes(n) });
describe("shouldKeepFocus", () => {
  const body = {};
  it("keeps focus that moved elsewhere (e.g. Reply focused the composer)", () => {
    const composer = node();
    expect(shouldKeepFocus(composer, node(), body)).toBe(true);
  });
  it("returns focus when nothing has it", () => {
    expect(shouldKeepFocus(null, node(), body)).toBe(false);
    expect(shouldKeepFocus(body as never, node(), body)).toBe(false);
  });
  it("returns focus when it is still inside the trigger", () => {
    const child = {};
    expect(shouldKeepFocus(child as never, node([child]), body)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them**

Run: `rtk pnpm --filter @datrope/web test -- message-keys focus`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the pure modules**

```ts
// src/lib/message-keys.ts
export type MessageKey = "prev" | "next" | "first" | "last" | "menu" | "reply" | "edit" | "thread" | "pin" | "react" | "delete" | "composer";

const KEYS: Record<string, MessageKey> = {
  ArrowUp: "prev", ArrowDown: "next", Home: "first", End: "last", Enter: "menu",
  r: "reply", e: "edit", t: "thread", p: "pin", "+": "react", Delete: "delete", Escape: "composer",
};

/** What a key does on a message row. `onRow`: the row itself has focus, not a link, button or field inside it. */
export function messageKeyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean }, onRow: boolean): MessageKey | null {
  if (!onRow || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
  return KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? null;
}
```

```ts
// src/lib/focus.ts
type Containing = { contains(n: unknown): boolean };

/** After a menu or dialog closes: true when focus already moved somewhere outside its trigger (leave it there),
 *  false when nothing has focus or it is still inside the trigger (return focus to the trigger). */
export function shouldKeepFocus(active: unknown, trigger: Containing | null, body: unknown): boolean {
  if (!active || active === body) return false;
  return !(trigger?.contains(active) ?? false);
}
```

- [ ] **Step 4: Run tests**

Run: `rtk pnpm --filter @datrope/web test -- message-keys focus`
Expected: PASS.

- [ ] **Step 5: Roving rows in `MessageList`**

In `MessageList` keep the id of the row that holds the tab stop:

```tsx
  const [tabId, setTabId] = useState<string>();
  const tabbable = tabId && list?.items.some((m) => m.id === tabId) ? tabId : list?.items.at(-1)?.id;
```

Pass `tabbable={m.id === tabbable}`, `onRowFocus={() => setTabId(m.id)}` and `scroller={scroller}` to both `MessageRow` call sites, and add those props to `MessageRow`'s signature. Add near `jumpTo`:

```tsx
/** Focuses a message row by id (and scrolls it into view). */
export function focusRow(scroller: HTMLElement | null, id: string) {
  const el = scroller?.querySelector<HTMLElement>(`#message-${CSS.escape(id)}`);
  el?.focus({ preventScroll: true });
  el?.scrollIntoView({ block: "nearest" });
}
const composer = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
```

- [ ] **Step 6: Row focus, keys and focus return in `MessageRow`**

Add `const row = useRef<HTMLElement>(null);` and on the `<article>`:

```tsx
    <article id={`message-${m.id}`} ref={row} data-message-row tabIndex={tabbable ? 0 : -1}
      aria-labelledby={`message-${m.id}-name`}
      onFocus={(e) => { if (e.target === e.currentTarget) onRowFocus(); }}
      onKeyDown={(e) => {
        lastTouch.current = false;
        const act = messageKeyAction({ ...e, isComposing: e.nativeEvent.isComposing }, e.target === e.currentTarget);
        if (!act) return;
        const rows = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-message-row]") ?? [])];
        const i = rows.indexOf(e.currentTarget);
        const go = (j: number) => { const t = rows[Math.max(0, Math.min(rows.length - 1, j))]; t?.focus(); t?.scrollIntoView({ block: "nearest" }); };
        const run: Record<typeof act, (() => void) | undefined> = {
          prev: () => go(i - 1), next: () => go(i + 1), first: () => go(0), last: () => go(rows.length - 1),
          menu: () => e.currentTarget.querySelector<HTMLElement>("[data-message-menu]")?.click(),
          reply: onReply, edit: onEdit, thread: openThread, pin: onPin,
          react: () => e.currentTarget.querySelector<HTMLElement>("[data-message-react]")?.click(),
          delete: onDelete,
          composer: () => composer()?.focus(),
        };
        const fn = run[act];
        if (!fn) return;
        e.preventDefault();
        fn();
      }}
      className={cn("group relative grid … outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", …)}>
```

(Keep every existing pointer handler and class; add only `outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`.) Add `id={`message-${m.id}-name`}` to the visible name button, and for grouped rows render `<span id={`message-${m.id}-name`} className="sr-only">{name}</span>` in the gutter `<span />` so every row has a name.

Edit end: wrap the two `setEditing(false)` exits (Esc handlers and successful `save`) in a helper:

```tsx
  const stopEditing = () => { setEditing(false); requestAnimationFrame(() => row.current?.focus({ preventScroll: true })); };
```

Delete focus: in `remove()` pick the neighbour before the request:

```tsx
  const remove = async () => {
    setConfirming(false);
    const rows = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-message-row]") ?? [])];
    const i = rows.indexOf(row.current!);
    const neighbour = rows[i + 1] ?? rows[i - 1];
    try {
      await unwrap(client.api.DELETE("/api/channels/{id}/messages/{messageID}", path));
      requestAnimationFrame(() => (neighbour?.isConnected ? neighbour : composer())?.focus());
    } catch (e) {
      setError(errorText(e));
      row.current?.focus();
    }
  };
```

Delete → Cancel: on the confirm `DialogContent` add `onCloseAutoFocus={(e) => { e.preventDefault(); if (row.current?.isConnected) row.current.focus({ preventScroll: true }); }}`.

Context menu: replace `onCloseAutoFocus={(e) => e.preventDefault()}` on this file's `ContextMenuContent` with:

```tsx
onCloseAutoFocus={(e) => {
  e.preventDefault();
  if (!shouldKeepFocus(document.activeElement, row.current, document.body)) row.current?.focus({ preventScroll: true });
}}
```

- [ ] **Step 7: `MessageToolbar` data hooks**

Add `data-message-react` to `ReactAction`'s `RefButton`. (Task 9 adds the ⋯ menu with `data-message-menu`.)

- [ ] **Step 8: Typecheck, test, check in the browser**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test`
In `#general` at 1440: Tab into the list lands on the newest message; ↑ walks through grouped continuations; the toolbar shows on the focused row; `r` sets the reply banner; Esc focuses the composer; Delete → Cancel puts focus back on the row (`document.activeElement.id` starts with `message-`).

- [ ] **Step 9: Stage and pause for review**

Suggested message: `feat(web): keyboard model for messages and focus return`.

---

### Task 7: Focus return for the other context menus

**Files:**
- Modify: `src/app/sidebar/ChannelTree.tsx:404`, `src/app/ServerSidebar.tsx:120`, `src/app/MemberList.tsx:89`, `src/app/sidebar/CategoryHeader.tsx:57`, `src/app/DMList.tsx` (its `ContextMenuContent`)

**Interfaces:**
- Consumes: `shouldKeepFocus` (Task 6).

- [ ] **Step 1: Replace each blanket `preventDefault`**

Each of these menus has a non-focusable trigger (`div`/`li`) wrapping a focusable link or button. Give the trigger a ref and replace `onCloseAutoFocus={(e) => e.preventDefault()}` with:

```tsx
onCloseAutoFocus={(e) => {
  e.preventDefault();
  if (!shouldKeepFocus(document.activeElement, trigger.current, document.body))
    trigger.current?.querySelector<HTMLElement>("a,button")?.focus({ preventScroll: true });
}}
```

`ChannelRow`: the trigger is the row `div` (add `const trigger = useRef<HTMLDivElement>(null)`, merge with `drop.setNodeRef` via a callback ref: `ref={(el) => { drop.setNodeRef(el); trigger.current = el; }}`). `MemberList`: the `<li>`. `CategoryHeader`: its header row. `ServerSidebar` `CreateMenu`: the wrapping `div` (focus falls back to its first link, the Gallery link is outside — use `querySelector("a")`). `DMList`: the `<li>`.

- [ ] **Step 2: Typecheck and check**

Run: `rtk pnpm --filter @datrope/web typecheck`
Tab to `general`, Shift+F10, Esc: focus is on the `general` link again. Pick "Copy link": focus returns to the link.

- [ ] **Step 3: Stage and pause for review**

Suggested message: `fix(web): context menus return focus to their row`.

---

### Task 8: Skip links, page heading, arrow keys in lists and call controls

**Files:**
- Create: `src/components/skip-links.tsx`
- Modify: `src/app/AppShell.tsx` (render skip links first)
- Modify: `src/app/ChannelView.tsx:121`, `src/app/DMView.tsx`, `src/app/voice/VoiceChannelView.tsx`, gallery/forum/settings view headers: page title `h2` → `h1` (same text)
- Modify: `src/styles.css` (`h1` keeps today's `h2` size inside top bars)
- Modify: `src/app/sidebar/ChannelTree.tsx`, `src/app/DMList.tsx`, `src/app/MemberList.tsx`, `src/app/gallery/GalleryView.tsx`, `src/app/voice/CallControls.tsx` (arrow nav)
- Modify: `src/app/sidebar/CategoryHeader.tsx` (`aria-expanded`, ←/→)

**Interfaces:**
- Consumes: `useArrowNav` (Task 5).

- [ ] **Step 1: Skip links**

```tsx
// src/components/skip-links.tsx
const link = "sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-popover-foreground focus:ring-2 focus:ring-ring";

/** First stops in the tab order: jump past the sidebar to the messages or the composer. */
export function SkipLinks() {
  const go = (selector: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.querySelector<HTMLElement>(selector)?.focus();
  };
  return (
    <div className="contents">
      <a href="#messages" className={link} onClick={go('[data-message-row][tabindex="0"]')}>Skip to messages</a>
      <a href="#composer" className={link} onClick={go('textarea[aria-label="Message"]')}>Skip to composer</a>
    </div>
  );
}
```

Render `{!mobile && <SkipLinks />}` as the first child of `AppShell`'s outer `div`.

- [ ] **Step 2: Page heading level**

Change the page-title `<h2>` to `<h1>` in `ChannelView.tsx:121`, `VoiceChannelView.tsx`, the gallery, forum and server-settings page headers (`ServerSettings.tsx` `<h2 className="min-w-0 flex-1 truncate font-semibold">`). Panel titles stay `<h2>`. In `styles.css` change `h1 { font-size: 1rem; }` to `h1 { font-size: 1.05rem; }` so top bars look the same. E2E `getByRole("heading", { name: "# general" })` is level-agnostic.

- [ ] **Step 3: Channel list arrows**

In `ChannelTree`, give the tree's outer `div className="select-none p-2"` a ref `treeRef` and call:

```tsx
  useArrowNav(treeRef, "[data-tree-item]");
```

Add `data-tree-item` to every channel `Link` and to each `CategoryHeader` toggle button. dnd-kit's keyboard sensor only starts on Space (`keyboardCodes.start: ["Space"]`), so arrows don't collide; while a drag is active dnd-kit handles arrows itself (it calls `preventDefault`, which `useArrowNav` respects).

`CategoryHeader`: the collapse toggle gets `aria-expanded={!collapsed}` and

```tsx
onKeyDown={(e) => {
  if (e.key === "ArrowRight" && collapsed) { e.preventDefault(); onToggle(); }
  else if (e.key === "ArrowLeft" && !collapsed) { e.preventDefault(); onToggle(); }
}}
```

On a channel link, ← focuses its category header: in `ChannelRow`'s `Link` add

```tsx
onKeyDown={(e) => {
  if (e.key !== "ArrowLeft") return;
  const header = e.currentTarget.closest('[role="group"]')?.querySelector<HTMLElement>("[data-tree-item][aria-expanded]");
  if (header) { e.preventDefault(); header.focus(); }
}}
```

(merge with `handle`'s own `onKeyDown` if present: call `handle?.onKeyDown?.(e)` first).

- [ ] **Step 4: DMs, members, gallery, call controls**

- `DMList`: `ulRef` on the conversations `<ul>`, `useArrowNav(ulRef, "a[href^='/messages/']")`.
- `MemberList`: `asideRef`, `useArrowNav(asideRef, "li > button, li > [data-slot=button]")` — use the `RefButton`'s rendered element; add `data-member-row` to `RefButton` and use `"[data-member-row]"`.
- `GalleryView`: grid container ref; `useArrowNav(gridRef, "[data-tile]", { orientation: "grid", columns: () => Math.max(1, Math.round(gridRef.current!.clientWidth / (gridRef.current!.querySelector<HTMLElement>("[data-tile]")?.offsetWidth || 1))) })`; add `data-tile` to each tile's primary open button in `FileTile.tsx`.
- `CallControls`: `toolbarRef` on the desktop `role="toolbar"` div, `useArrowNav(toolbarRef, "button", { orientation: "horizontal" })`.

- [ ] **Step 5: Typecheck and check**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test`
Tab from page start: "Skip to messages" appears; Enter focuses the newest message. In the channel list ↓/↑ move between channels and category headers; ← on a channel goes to its header; ← on the header collapses it. In a call, ←/→ move along the controls and Tab leaves the toolbar in one step.

- [ ] **Step 6: Stage and pause for review**

Suggested message: `feat(web): skip links, page headings and arrow keys in lists`.

---

### Task 9: Keyboard routes to right-click-only actions

**Files:**
- Modify: `src/app/MessageToolbar.tsx` (⋯ "More actions" menu)
- Modify: `src/app/MessageList.tsx` (pass copy/album to the toolbar)
- Modify: `src/app/sidebar/ChannelTree.tsx` (row ⋯ menu)
- Modify: `src/app/people/ProfilePopover.tsx` (Copy user ID)

**Interfaces:**
- Consumes: `data-message-menu` contract (Task 6).
- Produces: `MessageToolbar` props gain `onCopy?: () => void`, `albumItems?: ReactNode` (rendered inside a submenu), and its ⋯ trigger has `data-message-menu` and `aria-label="More actions"`.

- [ ] **Step 1: Toolbar ⋯ menu**

At the end of `MessageToolbar`'s container add:

```tsx
      <DropdownMenu modal={false} onOpenChange={(o) => o && setPicking(true)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <RefButton data-message-menu variant="ghost" size="icon-sm" aria-label="More actions" className="text-muted-foreground"><Ellipsis /></RefButton>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-52" onCloseAutoFocus={() => setPicking(false)}>
          {onReply && <DropdownMenuItem onSelect={onReply}><Reply />Reply</DropdownMenuItem>}
          {onThread && <DropdownMenuItem onSelect={onThread}>{hasThread ? <><MessageSquare />Open thread</> : <><MessageSquarePlus />Create thread</>}</DropdownMenuItem>}
          {onEdit && <DropdownMenuItem onSelect={onEdit}><Pencil />Edit message</DropdownMenuItem>}
          {onPin && <DropdownMenuItem onSelect={onPin}>{pinned ? <><PinOff />Unpin message</> : <><Pin />Pin message</>}</DropdownMenuItem>}
          {onCopy && <DropdownMenuItem onSelect={onCopy}><Copy />Copy text</DropdownMenuItem>}
          {albumItems && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Images />Add to album</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">{albumItems}</DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {onDelete && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={onDelete}><Trash2 />Delete message</DropdownMenuItem></>}
        </DropdownMenuContent>
      </DropdownMenu>
```

Album items: `AddToAlbumContextItems` renders `ContextMenuItem`s. Add a sibling export `AddToAlbumMenuItems` in `gallery/AddToAlbum.tsx` that renders the same list with `DropdownMenuItem`s (same props: `attachmentIds`, `onNew`, `onError`); keep both using one shared data hook.

- [ ] **Step 2: Pass them from `MessageRow`**

```tsx
        <MessageToolbar …existing props…
          onCopy={m.content ? () => void navigator.clipboard?.writeText(m.content).catch(() => undefined) : undefined}
          albumItems={(m.attachments?.length ?? 0) > 0 && !isDM && !m.pending
            ? <AddToAlbumMenuItems attachmentIds={m.attachments!.map((a) => a.id)} onNew={() => setNewAlbum(true)} onError={showAlbumError} />
            : undefined} />
```

- [ ] **Step 3: Channel row ⋯**

In `ChannelRow`, replace the settings-only `Button` with a `DropdownMenu` (trigger `aria-label={`Options for ${ch.name}`}`, same reveal classes `opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100`) holding: Mark as read (when unread), Join voice (voice), Copy link, and for `manageable` rows: Channel settings, Move up, Move down — the same items and conditions as the row's context menu. Render it for every row (not only manageable ones). Keep `aria-label={`Settings for ${ch.name}`}` reachable: make "Channel settings" the menu item text and keep e2e selectors in mind — grep `e2e/` for `Settings for` and update those steps to open the ⋯ menu first (`getByRole("button", { name: "Options for general" })` then `getByRole("menuitem", { name: "Channel settings" })`).

- [ ] **Step 4: Copy user ID in the profile popover**

In `ProfilePopover.tsx` add a small ghost icon button `aria-label="Copy user ID"` (lucide `Copy`) next to the existing actions that writes `userId` to the clipboard.

- [ ] **Step 5: Typecheck, run e2e selectors check, verify**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk grep -n "Settings for" e2e`
Focus a message, Enter: the More actions menu opens with Copy text; on an image message "Add to album" opens its submenu. Tab to a channel row's ⋯ (Tab from the link): Mark as read / Copy link are there.

- [ ] **Step 6: Stage and pause for review**

Suggested message: `feat(web): keyboard routes to right-click actions`.

---

### Task 10: Quieter screen reader output for new messages

**Files:**
- Create: `src/lib/announce.ts`, `src/lib/announce.test.ts`
- Create: `src/app/MessageAnnouncer.tsx`
- Modify: `src/app/MessageList.tsx` (`aria-live="off"` on the log; mount the announcer)

**Interfaces:**
- Produces: `plainPreview(markdown: string, max?: number): string`; `announcement(batch: { author: string; text: string }[]): string`; `<MessageAnnouncer channelId={string} />`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/announce.test.ts
import { describe, expect, it } from "vitest";
import { announcement, plainPreview } from "./announce";

describe("plainPreview", () => {
  it("strips markdown and collapses whitespace", () => {
    expect(plainPreview("**hi** _there_\n\n> quote `x`")).toBe("hi there quote x");
  });
  it("hides spoilers and shortens custom emoji and mentions", () => {
    expect(plainPreview("a ||secret|| <:wave:123> <@456>")).toBe("a spoiler :wave: @mention");
  });
  it("cuts at 100 characters on a word", () => {
    const s = plainPreview("word ".repeat(40));
    expect(s.length).toBeLessThanOrEqual(101);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("announcement", () => {
  it("reads one message as author: text", () => {
    expect(announcement([{ author: "bob", text: "hello" }])).toBe("bob: hello");
  });
  it("summarises a burst", () => {
    expect(announcement([{ author: "bob", text: "a" }, { author: "amy", text: "b" }, { author: "bob", text: "c" }]))
      .toBe("bob: a, and 2 more");
  });
  it("says attachment when there is no text", () => {
    expect(announcement([{ author: "bob", text: "" }])).toBe("bob: attachment");
  });
  it("is empty for no messages", () => expect(announcement([])).toBe(""));
});
```

- [ ] **Step 2: Run it**

Run: `rtk pnpm --filter @datrope/web test -- announce`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/announce.ts
/** A message's text as one short spoken line: no Markdown, no spoilers, at most `max` characters. */
export function plainPreview(markdown: string, max = 100): string {
  const s = markdown
    .replace(/\|\|[\s\S]*?\|\|/g, "spoiler")
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/<@[!&]?\d+>/g, "@mention")
    .replace(/```[\s\S]*?```/g, "code")
    .replace(/[*_~`>#]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : max)}…`;
}

/** What the status region says for messages that arrived together. */
export function announcement(batch: { author: string; text: string }[]): string {
  const first = batch[0];
  if (!first) return "";
  const line = `${first.author}: ${first.text || "attachment"}`;
  return batch.length > 1 ? `${line}, and ${batch.length - 1} more` : line;
}
```

```tsx
// src/app/MessageAnnouncer.tsx
import { useEffect, useRef, useState } from "react";
import { useWindowFocus } from "@/hooks/use-window-focus";
import { announcement, plainPreview } from "@/lib/announce";
import { client, displayName, useApp } from "../session";

/** Speaks new messages from others in the channel on screen, one short line per burst (≤ 1 s). */
export function MessageAnnouncer({ channelId }: { channelId: string }) {
  const lastId = useApp((s) => s.messages[channelId]?.items.at(-1)?.id);
  const meId = useApp((s) => s.me?.id);
  const focused = useWindowFocus();
  const [text, setText] = useState("");
  const seen = useRef<string | undefined>(lastId);
  const batch = useRef<{ author: string; text: string }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => { seen.current = client.store.getState().messages[channelId]?.items.at(-1)?.id; }, [channelId]);
  useEffect(() => {
    const list = client.store.getState().messages[channelId];
    if (!list || list.hasNewer || !lastId) return;
    const from = seen.current ? list.items.findIndex((m) => m.id === seen.current) + 1 : list.items.length;
    seen.current = lastId;
    const fresh = list.items.slice(Math.max(0, from)).filter((m) => !m.pending && !m.kind && m.author && m.author.id !== meId);
    if (!focused || fresh.length === 0) return;
    batch.current.push(...fresh.map((m) => ({ author: displayName(m.author!), text: plainPreview(m.content) })));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { setText(announcement(batch.current)); batch.current = []; }, 1000);
  }, [channelId, lastId, meId, focused]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <div role="status" aria-live="polite" className="sr-only">{text}</div>;
}
```

(Loading older pages changes the first item, not `lastId`, so history loads are never spoken.)

- [ ] **Step 4: Wire it**

In `MessageList.tsx`: add `aria-live="off"` to the `role="log"` scroller, and render `<MessageAnnouncer channelId={channelId} />` just after it.

- [ ] **Step 5: Run tests and typecheck**

Run: `rtk pnpm --filter @datrope/web test -- announce && rtk pnpm --filter @datrope/web typecheck`
Expected: PASS. In the browser, a message from another account updates the hidden `role=status` text to `name: text`.

- [ ] **Step 6: Stage and pause for review**

Suggested message: `feat(web): announce new messages in one short line`.

---

### Task 11: Contrast tokens

**Files:**
- Modify: `src/styles.css` (`--input`, `--destructive`)
- Modify: `src/components/ui/*.tsx` (`ring-ring/50` → `ring-ring`)
- Modify: `src/app/MemberList.tsx:77` (offline rows)
- Modify: `src/styles.test.ts`

- [ ] **Step 1: Write the failing test** (append to `src/styles.test.ts`)

```ts
const hex = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
const lum = (h: string) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe("contrast", () => {
  it("form control borders reach 3:1 on background and card", () => {
    expect(ratio(hex("input")!, hex("background")!)).toBeGreaterThanOrEqual(3);
    expect(ratio(hex("input")!, hex("card")!)).toBeGreaterThanOrEqual(3);
  });
  it("destructive text reaches 4.5:1 on card and popover", () => {
    expect(ratio(hex("destructive")!, hex("card")!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex("destructive")!, hex("popover")!)).toBeGreaterThanOrEqual(4.5);
  });
  it("muted text reaches 4.5:1 on background, card, sidebar and muted", () => {
    for (const bg of ["background", "card", "sidebar", "muted"]) expect(ratio(hex("muted-foreground")!, hex(bg)!)).toBeGreaterThanOrEqual(4.5);
  });
  it("focus rings are solid", () => {
    const button = readFileSync(new URL("./components/ui/button.tsx", import.meta.url), "utf8");
    expect(button).not.toContain("ring-ring/50");
  });
});
```

- [ ] **Step 2: Run it**

Run: `rtk pnpm --filter @datrope/web test -- styles`
Expected: FAIL on input, destructive and focus ring.

- [ ] **Step 3: Implement**

- `styles.css`: `--input: #6b6b6b;` (`--border` stays `#424242`); `--destructive: #ef5b4c;` — then run the test; if a ratio is still short, lighten in steps of `#080808` until it passes and record the final values in the task report.
- `components/ui/*`: `rtk grep -ln "ring-ring/50" src/components/ui` and replace `ring-ring/50` with `ring-ring` and `ring-[3px]` with `ring-2` (keep `focus-visible:` prefixes). In `styles.css` base layer change `outline-ring/50` to `outline-ring`.
- Inputs already use `border-input`, so they pick up the new token.
- `MemberList.tsx:77`: remove `status === "offline" && "opacity-50"` from the button; add `status === "offline" && "text-muted-foreground"` on the name span (keeping role colour only when online: `style={{ color: status === "offline" ? undefined : colors[m.user.id] }}`) and pass `className={status === "offline" ? "opacity-60" : undefined}` to `UserAvatar` (check it accepts `className`; if not, wrap it in a `span` with that class).
- Where `text-muted-foreground` sits on `bg-secondary`: `rtk grep -n "bg-secondary" src` and for each element whose text is muted, use `text-secondary-foreground`.

- [ ] **Step 4: Run tests**

Run: `rtk pnpm --filter @datrope/web test`
Expected: PASS.

- [ ] **Step 5: Stage and pause for review**

Suggested message: `fix(web): AA contrast for borders, focus rings, destructive and offline rows`.

---

### Task 12: Playwright desktop projects for Phase 1

**Files:**
- Modify: `playwright.config.ts`
- Create: `e2e/desktop.spec.ts`

**Interfaces:**
- Consumes: everything in Phase 1. Reuses the sign-in pattern from `e2e/mobile.spec.ts` (accounts created by `chat.spec.ts`: `alice`/`bob`, password `password123`).

- [ ] **Step 1: Projects**

Add to `projects` (after `chromium`; `chromium` gains `testIgnore: /(mobile|desktop)\.spec\.ts/`):

```ts
  { name: "desktop-820", testMatch: /desktop\.spec\.ts/, dependencies: ["chromium"], use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 700 } } },
  { name: "desktop-1100", testMatch: /desktop\.spec\.ts/, dependencies: ["chromium"], use: { ...devices["Desktop Chrome"], viewport: { width: 1100, height: 800 } } },
  { name: "desktop-1440", testMatch: /desktop\.spec\.ts/, dependencies: ["chromium"], use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
```

- [ ] **Step 2: Write the spec**

```ts
// e2e/desktop.spec.ts
import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, username = "alice") {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
}
const width = (page: Page) => page.viewportSize()!.width;

test.beforeEach(async ({ page }) => { await signIn(page); });

test("the channel title stays visible and the list never scrolls sideways", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1, name: /# general/ })).toBeVisible();
  const log = page.getByRole("log", { name: "Messages" });
  expect(await log.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

test("narrow: the channel list opens as a sheet", async ({ page }) => {
  test.skip(width(page) >= 1024, "narrow only");
  await page.getByRole("button", { name: "Channels" }).click();
  await page.getByRole("link", { name: "random" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /# random/ })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("medium and narrow: members slide over; Esc returns focus", async ({ page }) => {
  test.skip(width(page) >= 1280, "slide-over tiers only");
  const button = width(page) < 1024 ? null : page.getByRole("button", { name: "Members" });
  if (button) await button.click();
  else { await page.getByRole("button", { name: "More actions" }).click(); await page.getByRole("menuitem", { name: "Members" }).click(); }
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  if (button) await expect(button).toBeFocused();
});

test("wide: the members toggle persists across reload", async ({ page }) => {
  test.skip(width(page) < 1280, "wide only");
  const list = page.getByRole("complementary", { name: "Members" });
  await expect(list).toBeVisible();
  await page.getByRole("button", { name: "Members" }).click();
  await expect(list).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
  await expect(list).toHaveCount(0);
  await page.getByRole("button", { name: "Members" }).click();
  await expect(list).toBeVisible();
});

test("keyboard only: skip link, reply to a grouped message, delete then cancel", async ({ page }) => {
  for (const t of ["first", "second, grouped"]) {
    await page.getByLabel("Message", { exact: true }).fill(t);
    await page.getByLabel("Message", { exact: true }).press("Enter");
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // start from the top of the page
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to messages" })).toBeFocused();
  await page.keyboard.press("Enter");
  const focusedText = () => page.evaluate(() => document.activeElement?.textContent ?? "");
  await expect.poll(focusedText).toContain("second, grouped");
  await page.keyboard.press("r");
  await expect(page.getByText(/Replying to/)).toBeVisible();
  await page.getByLabel("Cancel reply").click();
  await page.locator('[data-message-row][tabindex="0"]').focus();
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-message-row"))).toBe(true);
});

test("the threads panel closes on Esc and focus returns", async ({ page }) => {
  const threads = width(page) < 1024 ? null : page.getByRole("button", { name: "Threads" });
  test.skip(!threads, "narrow keeps Threads in ⋯");
  await threads!.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Threads" })).toHaveCount(0);
  await expect(threads!).toBeFocused();
});

test("resize keeps the thread", async ({ page }) => {
  test.skip(width(page) < 1280, "starts wide");
  await page.getByRole("button", { name: "Threads" }).click();
  await expect(page.getByRole("heading", { name: "Threads" })).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Threads" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Threads" })).toBeVisible();
});
```

Check the reply banner's actual text in `Composer.tsx` (`rtk grep -n "Replying" src/app/Composer.tsx`) and use it.

- [ ] **Step 3: Run**

Run (stack up per `.github/workflows/ci.yml`): `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait` then `rtk playwright test --project=chromium --project=desktop-820 --project=desktop-1100 --project=desktop-1440 --project=pixel-7 --project=iphone-14` from `clients/web`.
Expected: all pass. Fix code, not tests, unless a selector is wrong.

- [ ] **Step 4: Re-audit**

Run `/impeccable audit` at 820, 1440 and 2560 px and append the Phase 1 score to `docs/superpowers/specs/2026-10-14-desktop-ux-audit.md` under a new "Re-audit after Phase 1" heading.

- [ ] **Step 5: Stage and pause for review**

Suggested message: `test(web): desktop Playwright projects for layout and keyboard`.

---
## Phase 2 — Desktop app chrome and messages

### Task 13: Shell — per-server title bar, window commands, chrome state (Rust)

**Files:**
- Modify: `clients/desktop/src-tauri/src/shell.rs` (`Inner`, `layout_rects`, `drawer_rect`, `layout`, drawer slide y, `page_reset`, `emit_rail_state`, `RailState`)
- Modify: `clients/desktop/src-tauri/src/commands.rs` (new commands)
- Modify: `clients/desktop/src-tauri/src/lib.rs:71` (handler list), `clients/desktop/src-tauri/build.rs` (command list), `shell.rs` `SERVER_PERMISSIONS`

**Interfaces:**
- Produces (Rust): `Inner.claimed: HashSet<String>` (server webview labels), `Inner.window_limiter: RateLimiter` (30/10 s), `Inner.theme_limiter: RateLimiter` (10/10 s); `fn bar_height(inner: &Inner, label: &str) -> f64` (0 when claimed, else `TOP_BAR_HEIGHT`); `layout_rects(mode, w, h, bar: f64)`; `drawer_rect(h, bar: f64)`; `fn others_badge(inner: &Inner, id: &str) -> Badge`; `RailState.bar_hidden: bool`.
- Produces (commands, server webviews only): `desktop_title_bar { claimed: bool }`; `desktop_window { action: "minimize" | "toggle_maximize" | "close" | "servers" | "update" }`; `desktop_start_drag`.
- Produces (page event over the existing channel): `"chrome"` with payload `{ maximized: bool, updateReady: bool, platform: "windows" | "macos" | "linux", others: { unread: bool, mentions: u32 } }`, sent to every claimed page whenever `emit_rail_state` runs and right after a claim.

- [ ] **Step 1: Write the failing Rust tests** (in `shell.rs` `mod tests`)

```rust
    #[test]
    fn layout_rects_with_a_claimed_page() {
        let (w, h) = (1000.0, 600.0);
        let (bar, page, drawer) = layout_rects(ChromeMode::Drawer, w, h, 0.0);
        assert_eq!(bar.h, 0.0, "no shell bar when the page draws it");
        assert_eq!(page, Rect::new(0.0, 0.0, w, h), "the page fills the window");
        assert_eq!(drawer, Some(Rect::new(0.0, 0.0, DRAWER_WIDTH, h)), "the drawer starts at the top");
        let (full, _, _) = layout_rects(ChromeMode::Full, w, h, 0.0);
        assert_eq!(full, Rect::new(0.0, 0.0, w, h), "dialogs still take the whole window");
    }

    #[test]
    fn unclaimed_pages_keep_the_shell_bar() {
        let mut inner = Inner::new(Store::default(), "x/servers.json".into(), "x/webviews".into());
        assert_eq!(bar_height(&inner, "server-a"), TOP_BAR_HEIGHT);
        inner.claimed.insert("server-a".into());
        assert_eq!(bar_height(&inner, "server-a"), 0.0);
        inner.page_reset("server-a");
        assert_eq!(bar_height(&inner, "server-a"), TOP_BAR_HEIGHT, "a reload must claim again");
    }

    #[test]
    fn others_badge_sums_the_other_servers() {
        let mut inner = Inner::new(Store::default(), "x/servers.json".into(), "x/webviews".into());
        let a = inner.store.add("https://a.example".into(), "A".into()).unwrap();
        let b = inner.store.add("https://b.example".into(), "B".into()).unwrap();
        let c = inner.store.add("https://c.example".into(), "C".into()).unwrap();
        inner.badges.set(&a.id, Badge { unread: true, mentions: 2 });
        inner.badges.set(&b.id, Badge { unread: true, mentions: 1 });
        inner.badges.set(&c.id, Badge { unread: false, mentions: 0 });
        assert_eq!(others_badge(&inner, &a.id), Badge { unread: true, mentions: 1 });
        assert_eq!(others_badge(&inner, &c.id), Badge { unread: true, mentions: 3 });
    }
```

and in `commands.rs` tests (create `#[cfg(test)] mod tests` if missing):

```rust
    #[test]
    fn window_actions_parse() {
        let a: WindowAction = serde_json::from_str("\"toggle_maximize\"").unwrap();
        assert_eq!(a, WindowAction::ToggleMaximize);
        assert!(serde_json::from_str::<WindowAction>("\"set_position\"").is_err());
    }
```

Update the existing `layout_rects_per_mode` test to pass `TOP_BAR_HEIGHT` as the new last argument.

- [ ] **Step 2: Run them**

Run: `rtk cargo test` (in `clients/desktop/src-tauri`)
Expected: compile errors (`bar_height`, `others_badge`, `WindowAction`, `claimed` missing; `layout_rects` arity).

- [ ] **Step 3: Implement state and layout**

In `Inner` add `pub claimed: HashSet<String>, pub window_limiter: RateLimiter, pub theme_limiter: RateLimiter, pub themes: HashMap<String, std::collections::BTreeMap<String, String>>` (themes: Task 15) and initialise them (`RateLimiter::new(30, Duration::from_secs(10))`, `RateLimiter::new(10, Duration::from_secs(10))`). In `page_reset` add `self.claimed.remove(label); self.themes.remove(label);`.

```rust
/// The shell bar's height above a server page: none once that page draws the title bar itself.
pub fn bar_height(inner: &Inner, label: &str) -> f64 {
    if inner.claimed.contains(label) { 0.0 } else { TOP_BAR_HEIGHT }
}

/// Unread and mentions on every server but `id`: the badge on that page's Servers button.
pub fn others_badge(inner: &Inner, id: &str) -> Badge {
    inner.store.servers.iter().filter(|s| s.id != id).map(|s| inner.badges.get(&s.id))
        .fold(Badge::default(), |acc, b| Badge { unread: acc.unread || b.unread, mentions: acc.mentions.saturating_add(b.mentions) })
}

pub fn layout_rects(mode: ChromeMode, w: f64, h: f64, bar: f64) -> (Rect, Rect, Option<Rect>) {
    let chrome = Rect::new(0.0, 0.0, w, bar);
    let page = Rect::new(0.0, bar, w, h - bar);
    match mode {
        ChromeMode::Closed => (chrome, page, None),
        ChromeMode::Drawer => (chrome, page, Some(drawer_rect(h, bar))),
        ChromeMode::Full => (Rect::new(0.0, 0.0, w, h), page, None),
    }
}

fn drawer_rect(h: f64, bar: f64) -> Rect {
    Rect::new(0.0, bar, DRAWER_WIDTH, h - bar)
}
```

`Badge` needs `PartialEq, Debug` derives if missing (check `state.rs`).

In `layout()`: read `selected_bar = inner.selected.as_deref().map(|id| bar_height(&inner, &server_label(id))).unwrap_or(TOP_BAR_HEIGHT)` with the mode, call `layout_rects(mode, w, h, selected_bar)`, and for each server webview use its own `bar_height(&inner, label)` for the page rect (`Rect::new(0.0, b, w, h - b)`). For `RAIL`: when `chrome.h == 0.0` call `wv.hide()` and skip sizing, otherwise `wv.show()` then size it (the rail must be shown again in Full mode and for unclaimed servers). Replace the drawer slide's `TOP_BAR_HEIGHT` y (two `set_position` calls in the slide code) with the selected server's bar height read once at the start of the slide.

Add `bar_hidden: bool` to `RailState` (`= selected bar == 0.0`) and set it in `rail_state`.

- [ ] **Step 4: Chrome state to claimed pages**

```rust
/// Tells every page that draws the title bar what its buttons show: maximized, update ready, the other servers' badge.
pub fn send_chrome_state(app: &AppHandle) {
    let messages: Vec<(String, serde_json::Value)> = {
        let shell = app.state::<Shell>();
        let inner = shell.0.lock().unwrap();
        inner.claimed.iter().filter_map(|label| {
            let id = server_id(label)?;
            let o = others_badge(&inner, id);
            Some((label.clone(), serde_json::json!({
                "maximized": inner.maximized, "updateReady": inner.update_ready, "platform": platform(),
                "others": { "unread": o.unread, "mentions": o.mentions },
            })))
        }).collect()
    };
    for (label, payload) in messages {
        send_to_page(app, &label, "chrome", payload);
    }
}
```

Call `send_chrome_state(app)` at the end of `emit_rail_state` (it runs on badge, maximize, update and server changes).

- [ ] **Step 5: Commands**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowAction { Minimize, ToggleMaximize, Close, Servers, Update }

/// The page on screen asks for its title bar: hides the shell bar above it (or shows it again).
#[tauri::command]
pub fn desktop_title_bar(app: AppHandle, webview: Webview, claimed: bool) -> Result<(), String> {
    caller(&webview)?;
    let label = webview.label().to_string();
    let changed = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if claimed { inner.claimed.insert(label) } else { inner.claimed.remove(&label) }
    };
    if changed {
        shell::layout(&app).map_err(|e| e.to_string())?;
        shell::emit_rail_state(&app);
    }
    Ok(())
}

/// Only the visible page may move or close the window, within its own rate limit.
fn visible_caller(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    let id = caller(webview)?;
    let shell = app.state::<Shell>();
    let mut inner = shell.0.lock().unwrap();
    if inner.visible.as_deref() != Some(webview.label()) { return Err("not visible".into()); }
    if !inner.window_limiter.allow(&id, std::time::Instant::now()) { return Err("too many requests".into()); }
    Ok(())
}

#[tauri::command]
pub fn desktop_window(app: AppHandle, webview: Webview, action: WindowAction) -> Result<(), String> {
    visible_caller(&app, &webview)?;
    let window = shell::main_window(&app).ok_or("no window")?;
    match action {
        WindowAction::Minimize => window.minimize().map_err(|e| e.to_string()),
        WindowAction::ToggleMaximize => {
            if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() }.map_err(|e| e.to_string())
        }
        WindowAction::Close => window.close().map_err(|e| e.to_string()), // close-requested hides to the tray
        WindowAction::Servers => shell::set_chrome_mode(&app, ChromeMode::Drawer, true).map_err(|e| e.to_string()),
        WindowAction::Update => {
            if !app.state::<Shell>().0.lock().unwrap().update_ready { return Ok(()); }
            crate::updater::restart(&app) // the same call `update_restart` makes
        }
    }
}

#[tauri::command]
pub fn desktop_start_drag(app: AppHandle, webview: Webview) -> Result<(), String> {
    visible_caller(&app, &webview)?;
    shell::main_window(&app).ok_or("no window")?.start_dragging().map_err(|e| e.to_string())
}
```

`shell::set_chrome_mode` and `crate::updater::restart`: if the bodies of the existing `chrome_mode` and `update_restart` commands are inline, move them into these `pub fn`s (same behaviour) and have the old commands call them. `main_window` must be `pub`.

Add the three names to `build.rs` (under `// server pages`), to `generate_handler!` in `lib.rs`, and `"allow-desktop-title-bar"`, `"allow-desktop-window"`, `"allow-desktop-start-drag"` to `SERVER_PERMISSIONS` in `shell.rs`.

- [ ] **Step 6: Run tests and clippy**

Run: `rtk cargo test && rtk cargo clippy -- -D warnings` (in `clients/desktop/src-tauri`)
Expected: all pass, no warnings.

- [ ] **Step 7: Stage and pause for review**

Suggested message: `feat(desktop): pages can draw the title bar; window commands for server pages`.

---

### Task 14: Page bar in the desktop app (web)

**Files:**
- Modify: `src/desktop.ts`, `src/desktop.test.ts`
- Create: `src/app/desktop-chrome.ts` (store), `src/app/WindowControls.tsx` (`WindowControls`, `ServersButton`), `src/hooks/use-title-bar-edges.ts`
- Modify: `src/app/DesktopBridge.tsx` (claim, chrome events, drag listener)
- Modify: `src/app/TopBar.tsx`, `src/app/side-panel/SidePanel.tsx`, `src/app/MemberList.tsx`, `src/app/ServerSidebar.tsx` (`ServerHeader`), `src/app/server-settings/ServerSettings.tsx` headers, and every other 56 px view header (`rtk grep -n "min-h-14\|h-14" src/app`)

**Interfaces:**
- Consumes: Task 13 commands and `"chrome"` event.
- Produces: `Desktop.claimTitleBar(claimed: boolean)`, `Desktop.windowAction(a: "minimize" | "toggle_maximize" | "close" | "servers" | "update")`, `Desktop.startDrag()`, `Desktop.on("chrome", cb)`; `chromeStore` (`{ claimed: boolean; maximized: boolean; updateReady: boolean; platform: "windows" | "macos" | "linux"; others: { unread: boolean; mentions: number } }`) and `useChrome(select)`; `useTitleBarEdges(): RefCallback<HTMLElement>` (sets `data-edge-left` / `data-edge-right` while the element touches the window edge and the title bar is claimed); headers carry `data-titlebar-drag`.

- [ ] **Step 1: Write the failing bridge test** (append to `src/desktop.test.ts`)

```ts
  it("claims the title bar and sends window actions", async () => {
    const f = fake();
    const d = new Desktop(f.t);
    d.claimTitleBar(true);
    d.windowAction("toggle_maximize");
    d.startDrag();
    await tick();
    expect(f.calls).toContainEqual(["desktop_title_bar", { claimed: true }]);
    expect(f.calls).toContainEqual(["desktop_window", { action: "toggle_maximize" }]);
    expect(f.calls).toContainEqual(["desktop_start_drag", undefined]);
  });
  it("only re-sends the claim when it changes", async () => {
    const f = fake();
    const d = new Desktop(f.t);
    d.claimTitleBar(true); d.claimTitleBar(true); d.claimTitleBar(false);
    await tick();
    expect(f.calls.filter(([c]) => c === "desktop_title_bar")).toHaveLength(2);
  });
```

- [ ] **Step 2: Run it**

Run: `rtk pnpm --filter @datrope/web test -- desktop`
Expected: FAIL (`claimTitleBar` is not a function).

- [ ] **Step 3: Implement the bridge methods**

In `Desktop`:

```ts
  private claimed?: boolean;
  /** Asks the shell to hide its bar above this page: the page's own top bars carry the window buttons. */
  claimTitleBar(claimed: boolean) {
    if (claimed === this.claimed) return;
    this.claimed = claimed;
    void this.t.invoke("desktop_title_bar", { claimed }).catch(() => undefined);
  }
  windowAction(action: "minimize" | "toggle_maximize" | "close" | "servers" | "update") {
    void this.t.invoke("desktop_window", { action }).catch(() => undefined);
  }
  startDrag() {
    void this.t.invoke("desktop_start_drag").catch(() => undefined);
  }
```

and widen `on`'s event union with `"chrome"`.

- [ ] **Step 4: Run it**

Run: `rtk pnpm --filter @datrope/web test -- desktop`
Expected: PASS.

- [ ] **Step 5: Store, edges hook, controls**

```ts
// src/app/desktop-chrome.ts
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type ChromeState = { claimed: boolean; maximized: boolean; updateReady: boolean; platform: "windows" | "macos" | "linux"; others: { unread: boolean; mentions: number } };
export const chromeStore = createStore<ChromeState>(() => ({ claimed: false, maximized: false, updateReady: false, platform: "windows", others: { unread: false, mentions: 0 } }));
export const useChrome = <T,>(select: (s: ChromeState) => T) => useStore(chromeStore, select);
```

```ts
// src/hooks/use-title-bar-edges.ts
import { useCallback, useEffect, useRef } from "react";
import { useChrome } from "@/app/desktop-chrome";

/** For 56 px header bands in the desktop app: marks the one at the window's left edge (macOS traffic lights) and
 *  the one at its right edge (window buttons), so they can pad themselves. */
export function useTitleBarEdges() {
  const claimed = useChrome((s) => s.claimed);
  const el = useRef<HTMLElement | null>(null);
  const update = useCallback(() => {
    const e = el.current;
    if (!e) return;
    const r = e.getBoundingClientRect();
    e.toggleAttribute("data-edge-left", claimed && r.left <= 1);
    e.toggleAttribute("data-edge-right", claimed && r.right >= window.innerWidth - 1);
  }, [claimed]);
  useEffect(() => {
    update();
    const ro = new ResizeObserver(update);
    if (el.current) ro.observe(el.current);
    window.addEventListener("resize", update);
    return () => { ro.disconnect(); window.removeEventListener("resize", update); };
  }, [update]);
  return useCallback((node: HTMLElement | null) => { el.current = node; update(); }, [update]);
}
```

```tsx
// src/app/WindowControls.tsx
import { Copy, Menu, Minus, RefreshCw, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { desktop } from "../desktop";
import { useChrome } from "./desktop-chrome";

const win = "h-14 w-11 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-inset";

/** Minimize, maximize and close, fixed at the window's top right while this page draws the title bar (not on macOS). */
export function WindowControls() {
  const c = useChrome((s) => s);
  if (!desktop || !c.claimed) return null;
  return (
    <div className="fixed top-0 right-0 z-40 flex h-14 items-center">
      {c.updateReady && (
        <Button size="xs" className="mr-2" aria-label="Restart to update" title="Update ready — restart" onClick={() => desktop?.windowAction("update")}>
          <RefreshCw /> Update
        </Button>
      )}
      {c.platform !== "macos" && (
        <>
          <Button variant="ghost" size="icon" aria-label="Minimize" title="Minimize" className={win} onClick={() => desktop?.windowAction("minimize")}><Minus /></Button>
          <Button variant="ghost" size="icon" aria-label={c.maximized ? "Restore" : "Maximize"} title={c.maximized ? "Restore" : "Maximize"} className={win}
            onClick={() => desktop?.windowAction("toggle_maximize")}>
            {c.maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close" title="Close" className={cn(win, "hover:bg-destructive hover:text-destructive-foreground")}
            onClick={() => desktop?.windowAction("close")}><X /></Button>
        </>
      )}
    </div>
  );
}

/** Opens the desktop app's server drawer; shows the other servers' unread dot or mention count. */
export function ServersButton() {
  const claimed = useChrome((s) => s.claimed);
  const others = useChrome((s) => s.others);
  if (!desktop || !claimed) return null;
  const text = others.mentions > 0 ? `${others.mentions} mentions on other servers` : others.unread ? "Unread messages on other servers" : undefined;
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Servers" aria-describedby={text ? "servers-badge" : undefined}
      className="relative flex-none text-muted-foreground hover:text-foreground" onClick={() => desktop?.windowAction("servers")}>
      <Menu />
      {others.mentions > 0 ? (
        <span aria-hidden className="absolute -top-0.5 -right-1 min-w-4 rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-destructive-foreground">
          {others.mentions > 99 ? "99+" : others.mentions}
        </span>
      ) : others.unread ? <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground" /> : null}
      {text && <span id="servers-badge" className="sr-only">{text}</span>}
    </Button>
  );
}
```

(Window buttons are 44 × 56: the full bar height is the hit area, per spec.)

- [ ] **Step 6: Bridge wiring in `DesktopBridge.tsx`**

```tsx
  const mobile = useIsMobile();
  useEffect(() => {
    if (!desktop) return;
    desktop.claimTitleBar(!mobile);
    chromeStore.setState({ claimed: !mobile });
  }, [mobile]);
  useEffect(() => desktop?.on<Omit<ChromeState, "claimed">>("chrome", (p) => chromeStore.setState(p)), []);
  // Empty parts of the 56 px header bands drag the window; a double-click maximizes or restores it.
  useEffect(() => {
    if (!desktop) return;
    const d = desktop;
    const INTERACTIVE = "button, a, input, textarea, select, [role=button], [role=menuitem], [role=tab], [contenteditable], [data-no-drag]";
    const inBand = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el?.closest("[data-titlebar-drag]") && !el.closest(INTERACTIVE) && chromeStore.getState().claimed;
    };
    const down = (e: PointerEvent) => { if (e.button === 0 && e.detail < 2 && inBand(e.target)) d.startDrag(); };
    const dbl = (e: MouseEvent) => { if (inBand(e.target)) d.windowAction("toggle_maximize"); };
    window.addEventListener("pointerdown", down);
    window.addEventListener("dblclick", dbl);
    return () => { window.removeEventListener("pointerdown", down); window.removeEventListener("dblclick", dbl); };
  }, []);
```

Render `<WindowControls />` from `AppShell` next to `<DesktopBridge />` (`{desktop && <WindowControls />}`).

- [ ] **Step 7: Header bands**

For each 56 px header (`TopBar` desktop branch, `SidePanel` header, `ServerHeader` in `ServerSidebar.tsx`, `ServerSettings` nav header and main header, gallery/forum/voice view headers found by `rtk grep -n "min-h-14\|\bh-14\b" src/app`):
- add `ref={useTitleBarEdges()}` (merge with existing refs via a callback) and `data-titlebar-drag`;
- add classes `data-[edge-right]:pr-[calc(1rem+132px)]` and, for macOS, `data-[edge-left]:pl-[72px]` only when `useChrome((s) => s.platform) === "macos"` (compute the class in JS: `cn(base, mac && "data-[edge-left]:pl-[72px]")`).

`MemberList` (docked, desktop app only): when `useChrome((s) => s.claimed)`, render a 56 px header band at its top (`<div data-titlebar-drag ref={edges} className="flex h-14 flex-none items-center border-b bg-topbar px-3 data-[edge-right]:pr-[calc(0.75rem+132px)]"><h2 className="text-sm font-semibold">Members — {total}</h2></div>`) and move the list below it into a scrolling `div`. In the browser keep today's layout.

`ServerHeader`: render `<ServersButton />` first. `TopBar` desktop branch in the narrow tier (sidebar hidden): render `<ServersButton />` before `ChannelsButton`.

- [ ] **Step 8: Typecheck, test, check in the desktop app**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test`
Then `pnpm --filter @datrope/desktop tauri dev` (check `clients/desktop/package.json` for the dev script name) with a server at `http://localhost:5173` added: the 32 px shell bar disappears; the top bars carry Servers (left) and window buttons (right); dragging an empty bar area moves the window; double-click maximizes; Servers opens the drawer; resizing below 768 px brings the shell bar back.

- [ ] **Step 9: Stage and pause for review**

Suggested message: `feat(web): draw the desktop title bar in the page`.

---

### Task 15: Theme sync to the desktop app's own screens

**Files:**
- Create: `src/lib/theme-tokens.ts`, `src/lib/theme-tokens.test.ts`
- Modify: `src/desktop.ts` (`setTheme`), `src/app/DesktopBridge.tsx` (send on change)
- Create: `clients/desktop/src-tauri/src/theme.rs` (validate) and register `mod theme;` in `lib.rs`
- Modify: `clients/desktop/src-tauri/src/commands.rs` (`desktop_set_theme`), `build.rs`, `lib.rs` handler list, `shell.rs` (`SERVER_PERMISSIONS`, `RailState.theme`, `offline_url` fragment, `ScreenPickRequest.theme`)
- Create: `clients/desktop/src/theme.ts`; modify `clients/desktop/src/main.tsx`, `drawer.tsx`, `picker.tsx`, `offline.tsx`, `rail-api.ts`

**Interfaces:**
- Produces (web): `THEME_TOKENS: readonly string[]`; `readTokens(get: (name: string) => string): Record<string, string>`; `Desktop.setTheme(tokens: Record<string, string>)` (sends only when changed, command `desktop_set_theme { tokens }`).
- Produces (Rust): `theme::validate(tokens: &HashMap<String, String>) -> Option<BTreeMap<String, String>>`; `RailState.theme: BTreeMap<String, String>` (the selected server's tokens, empty if none).
- Produces (chrome): `applyTheme(tokens: Record<string, string>): void` in `clients/desktop/src/theme.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/theme-tokens.test.ts
import { describe, expect, it } from "vitest";
import { THEME_TOKENS, readTokens } from "./theme-tokens";

describe("readTokens", () => {
  it("reads the allowlisted tokens, trimmed, skipping empty ones", () => {
    const values: Record<string, string> = { "--background": " #101010 ", "--card": "#1c1c1c", "--secret": "x" };
    const out = readTokens((n) => values[n] ?? "");
    expect(out).toEqual({ background: "#101010", card: "#1c1c1c" });
  });
  it("covers the chrome's surfaces", () => {
    for (const t of ["background", "foreground", "card", "sidebar", "primary", "border", "ring", "destructive"]) expect(THEME_TOKENS).toContain(t);
    expect(THEME_TOKENS.length).toBeLessThanOrEqual(64);
  });
});
```

```rust
// clients/desktop/src-tauri/src/theme.rs (tests at the bottom)
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    fn m(pairs: &[(&str, &str)]) -> HashMap<String, String> { pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }

    #[test]
    fn accepts_colours() {
        let t = validate(&m(&[("background", "#131313"), ("primary", "oklch(0.7 0.15 250)"), ("ring", "rgb(46, 204, 113)")])).unwrap();
        assert_eq!(t.len(), 3);
    }
    #[test]
    fn drops_everything_on_one_bad_entry() {
        assert!(validate(&m(&[("background", "#131313"), ("card", "url(https://x)")])).is_none());
        assert!(validate(&m(&[("background", "#131313; color: red")])).is_none());
        assert!(validate(&m(&[("not-a-token", "#fff")])).is_none());
        assert!(validate(&m(&[("background", "red")])).is_none(), "keywords are not needed and not allowed");
        assert!(validate(&m(&[("background", "rgb(1,2,3")])).is_none(), "unbalanced");
    }
    #[test]
    fn limits_size() {
        let many: HashMap<String, String> = (0..65).map(|i| (format!("t{i}"), "#fff".into())).collect();
        assert!(validate(&many).is_none());
        assert!(validate(&m(&[("background", &format!("rgb({})", "1,".repeat(120)))])).is_none());
    }
}
```

- [ ] **Step 2: Run them**

Run: `rtk pnpm --filter @datrope/web test -- theme-tokens` and `rtk cargo test theme` (in `src-tauri`)
Expected: both FAIL (missing modules).

- [ ] **Step 3: Implement (web)**

```ts
// src/lib/theme-tokens.ts
/** The colour tokens the desktop app's own screens (title bar, drawer, dialogs, picker, offline page) use. */
export const THEME_TOKENS = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground",
  "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive",
  "destructive-foreground", "border", "input", "ring", "sidebar", "sidebar-foreground", "topbar", "topbar-foreground",
  "online", "idle", "offline",
] as const;

/** The current value of each token (`get("--background")` → "#131313"), without empty ones. */
export function readTokens(get: (name: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of THEME_TOKENS) {
    const v = get(`--${t}`).trim();
    if (v) out[t] = v;
  }
  return out;
}
```

`Desktop.setTheme`:

```ts
  private theme?: string;
  setTheme(tokens: Record<string, string>) {
    const key = JSON.stringify(tokens);
    if (key === this.theme) return;
    this.theme = key;
    void this.t.invoke("desktop_set_theme", { tokens }).catch(() => undefined);
  }
```

`DesktopBridge`: send now and whenever the root's inline style or class changes (themes and palettes set custom properties there):

```tsx
  useEffect(() => {
    if (!desktop) return;
    const d = desktop;
    const root = document.documentElement;
    let t: ReturnType<typeof setTimeout> | undefined;
    const send = () => { clearTimeout(t); t = setTimeout(() => { const cs = getComputedStyle(root); d.setTheme(readTokens((n) => cs.getPropertyValue(n))); }, 100); };
    send();
    const mo = new MutationObserver(send);
    mo.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
    return () => { clearTimeout(t); mo.disconnect(); };
  }, []);
```

- [ ] **Step 4: Implement (Rust)**

```rust
// clients/desktop/src-tauri/src/theme.rs
//! Colour tokens a server page sends for the app's own screens. Anything off-pattern drops the whole payload.
use std::collections::{BTreeMap, HashMap};

pub const TOKENS: &[&str] = &[
    "background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground",
    "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive",
    "destructive-foreground", "border", "input", "ring", "sidebar", "sidebar-foreground", "topbar", "topbar-foreground",
    "online", "idle", "offline",
];
const FUNCTIONS: &[&str] = &["rgb(", "rgba(", "hsl(", "hsla(", "oklch(", "oklab(", "color-mix("];

fn colour(v: &str) -> bool {
    if v.is_empty() || v.len() > 200 || v.chars().any(|c| matches!(c, ';' | '{' | '}' | '<' | '>' | '"' | '\'' | '\\')) {
        return false;
    }
    if let Some(hex) = v.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    let lower = v.to_ascii_lowercase();
    if lower.contains("url(") || lower.contains("expression") || lower.contains("/*") { return false; }
    if !FUNCTIONS.iter().any(|f| lower.starts_with(f)) || !lower.ends_with(')') { return false; }
    let mut depth = 0i32;
    for c in lower.chars() {
        match c { '(' => depth += 1, ')' => { depth -= 1; if depth < 0 { return false; } } _ => {} }
    }
    depth == 0
}

pub fn validate(tokens: &HashMap<String, String>) -> Option<BTreeMap<String, String>> {
    if tokens.len() > 64 { return None; }
    let mut out = BTreeMap::new();
    for (k, v) in tokens {
        let v = v.trim();
        if !TOKENS.contains(&k.as_str()) || !colour(v) { return None; }
        out.insert(k.clone(), v.to_string());
    }
    Some(out)
}
```

Command:

```rust
#[tauri::command]
pub fn desktop_set_theme(app: AppHandle, webview: Webview, tokens: HashMap<String, String>) -> Result<(), String> {
    let id = caller(&webview)?;
    let Some(theme) = crate::theme::validate(&tokens) else { return Ok(()) };
    let selected = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if !inner.theme_limiter.allow(&id, std::time::Instant::now()) { return Ok(()); }
        inner.themes.insert(webview.label().to_string(), theme);
        inner.selected.as_deref() == Some(id.as_str())
    };
    if selected { shell::emit_rail_state(&app); }
    Ok(())
}
```

Add `pub theme: BTreeMap<String, String>` to `RailState` (`inner.selected.as_deref().and_then(|id| inner.themes.get(&server_label(id))).cloned().unwrap_or_default()`), to `ScreenPickRequest` (the requesting server's theme) and append `#theme=<urlencoded JSON>` to the URL `offline_url` builds (use the stored theme for that server, if any). Register `desktop_set_theme` in `build.rs`, `generate_handler!` and `SERVER_PERMISSIONS` (`"allow-desktop-set-theme"`). Add a Rust test asserting `rail_state` returns the selected server's theme.

- [ ] **Step 5: Implement (chrome)**

```ts
// clients/desktop/src/theme.ts
let applied: string[] = [];
/** Puts a server's colour tokens on this bundled page (an empty object restores the bundled defaults). */
export function applyTheme(tokens: Record<string, string>) {
  const style = document.documentElement.style;
  for (const k of applied) if (!(k in tokens)) style.removeProperty(`--${k}`);
  for (const [k, v] of Object.entries(tokens)) style.setProperty(`--${k}`, v);
  applied = Object.keys(tokens);
}
```

Add `theme: Record<string, string>` and `barHidden: boolean` to `RailState` in `rail-api.ts` (defaults `{}` / `false` in `emptyRailState`), `theme` to `ScreenPickRequest`. In `main.tsx` (chrome) and `drawer.tsx` call `applyTheme(state.theme)` in an effect on `state.theme`; in `picker.tsx` after `fetchScreenPick()`; in `offline.tsx` on load parse `location.hash` (`#theme=`), `JSON.parse` in try/catch, keep only keys present in a local copy of the token list whose values pass `CSS.supports("color", v)`, then `applyTheme`.

- [ ] **Step 6: Run tests**

Run: `rtk pnpm --filter @datrope/web test && rtk cargo test` and `rtk pnpm --filter @datrope/desktop test`
Expected: PASS. In the desktop app, Server settings → Look → Ocean: the drawer and Add server dialog take the Ocean colours; switching to a server without a theme restores the defaults.

- [ ] **Step 7: Stage and pause for review**

Suggested message: `feat(desktop): bundled screens follow the server's theme`.

---

### Task 16: Drawer from the top with its own header

**Files:**
- Modify: `clients/desktop/src/drawer.tsx`, `clients/desktop/src/ServerDrawer.tsx`

**Interfaces:**
- Consumes: `RailState.barHidden` (Task 15 adds it to the TS type; Task 13 to Rust).

- [ ] **Step 1: Header when the bar is hidden**

`ServerDrawer` gains `header?: ReactNode` rendered first inside the `nav`. In `drawer.tsx` pass, when `state.barHidden`:

```tsx
header={(
  <div className="-mx-2 -mt-2 mb-1 flex h-14 flex-none items-center gap-2 border-b px-3">
    <h2 className="min-w-0 flex-1 text-sm font-semibold">Servers</h2>
    <Button variant="ghost" size="icon-sm" aria-label="Close servers" onClick={() => void setChromeMode("closed")}><X /></Button>
  </div>
)}
```

- [ ] **Step 2: Typecheck and check**

Run: `rtk pnpm --filter @datrope/desktop typecheck` (or `tsc -p clients/desktop`)
In the desktop app with a claimed page: Servers opens the drawer from the top of the window with the header; Close servers and Esc close it.

- [ ] **Step 3: Stage and pause for review**

Suggested message: `feat(desktop): full-height server drawer with its own header`.

---

### Task 17: Virtualized message list with scroll paging

**Files:**
- Modify: `clients/web/package.json` (add `react-virtuoso`)
- Create: `src/lib/message-items.ts`, `src/lib/message-items.test.ts`
- Modify: `src/app/MessageList.tsx` (Virtuoso, `jumpTo`, unread line, paging, skeleton rows, roving)

**Interfaces:**
- Produces: `type Item = { kind: "day"; key: string; date: Date } | { kind: "unread"; key: "unread" } | { kind: "message"; key: string; m: ClientMessage; grouped: boolean }`; `buildItems(messages: ClientMessage[], opts: { unreadAt: number; variant: "chat" | "cards" }): Item[]`; `prependedCount(prevFirstKey: string | undefined, items: Item[]): number`; `indexOfMessage(items: Item[], id: string): number`.
- Produces: module-level `listApi: Map<string, { scrollToId(id: string): boolean; scrollToBottom(): void }>` in `MessageList.tsx`, used by `jumpTo` and Phase 3's "jump to present".

- [ ] **Step 1: Add the dependency**

Run from `clients/web`: `rtk pnpm view react-virtuoso versions --json` and pick the newest `4.x` published at least two weeks ago; then `rtk pnpm add react-virtuoso@<that exact version>` (exact, no caret — check `package.json` shows no `^`).

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/message-items.test.ts
import type { ClientMessage } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { buildItems, indexOfMessage, prependedCount } from "./message-items";

const msg = (id: string, author: string, at: string, extra: Partial<ClientMessage> = {}) =>
  ({ id, channel_id: "c", content: id, created_at: at, author: { id: author, username: author }, ...extra }) as unknown as ClientMessage;

describe("buildItems", () => {
  const a = msg("1", "u1", "2026-10-14T08:00:00Z");
  const b = msg("2", "u1", "2026-10-14T08:03:00Z");
  const c = msg("3", "u1", "2026-10-14T08:09:00Z");
  const d = msg("4", "u2", "2026-10-14T08:10:00Z");
  const e = msg("5", "u2", "2026-10-15T08:10:00Z");

  it("adds a day divider before the first message of each day", () => {
    const items = buildItems([a, e], { unreadAt: -1, variant: "chat" });
    expect(items.map((i) => i.kind)).toEqual(["day", "message", "day", "message"]);
  });
  it("groups the same author within five minutes", () => {
    const items = buildItems([a, b, c, d], { unreadAt: -1, variant: "chat" }).filter((i) => i.kind === "message");
    expect(items.map((i) => i.kind === "message" && i.grouped)).toEqual([false, true, false, false]);
  });
  it("breaks groups at replies, the unread line and system messages", () => {
    const reply = msg("2", "u1", "2026-10-14T08:01:00Z", { reply_to: { id: "1" } as never });
    expect(buildItems([a, reply], { unreadAt: -1, variant: "chat" }).filter((i) => i.kind === "message").map((i) => i.kind === "message" && i.grouped)).toEqual([false, false]);
    const items = buildItems([a, b], { unreadAt: 1, variant: "chat" });
    expect(items.map((i) => i.kind)).toEqual(["day", "message", "unread", "message"]);
    expect(items.at(-1)).toMatchObject({ grouped: false });
    const left = msg("1", "u1", "2026-10-14T08:00:00Z", { kind: "member_leave" } as never);
    expect(buildItems([left, b], { unreadAt: -1, variant: "chat" }).at(-1)).toMatchObject({ grouped: false });
  });
  it("never groups cards", () => {
    expect(buildItems([a, b], { unreadAt: -1, variant: "cards" }).at(-1)).toMatchObject({ grouped: false });
  });
});

describe("prependedCount", () => {
  it("counts items added above the previous first item", () => {
    const before = buildItems([msg("3", "u1", "2026-10-14T09:00:00Z")], { unreadAt: -1, variant: "chat" });
    const after = buildItems([msg("1", "u2", "2026-10-14T08:00:00Z"), msg("3", "u1", "2026-10-14T09:00:00Z")], { unreadAt: -1, variant: "chat" });
    expect(prependedCount(before[0]!.key, after)).toBe(after.findIndex((i) => i.key === before[0]!.key));
    expect(prependedCount(undefined, after)).toBe(0);
    expect(prependedCount("gone", after)).toBe(0);
  });
});

describe("indexOfMessage", () => {
  it("finds a message's item index", () => {
    const items = buildItems([msg("1", "u1", "2026-10-14T08:00:00Z")], { unreadAt: -1, variant: "chat" });
    expect(indexOfMessage(items, "1")).toBe(1);
    expect(indexOfMessage(items, "x")).toBe(-1);
  });
});
```

- [ ] **Step 3: Run it**

Run: `rtk pnpm --filter @datrope/web test -- message-items`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `message-items.ts`**

```ts
// src/lib/message-items.ts
import type { ClientMessage } from "@datrope/core";
import { authorKey } from "@/app/message-author";

export type Item =
  | { kind: "day"; key: string; date: Date }
  | { kind: "unread"; key: "unread" }
  | { kind: "message"; key: string; m: ClientMessage; grouped: boolean };

const FIVE_MINUTES = 5 * 60 * 1000;

/** The rows of a message list: day dividers, the "New messages" line, and messages with their grouping
 *  (same author, under five minutes, not a reply, not after the unread line or a system/deleted message). */
export function buildItems(messages: ClientMessage[], { unreadAt, variant }: { unreadAt: number; variant: "chat" | "cards" }): Item[] {
  const out: Item[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const day = new Date(m.created_at);
    const newDay = !prev || new Date(prev.created_at).toDateString() !== day.toDateString();
    if (newDay) out.push({ kind: "day", key: `day-${day.toDateString()}`, date: day });
    if (i === unreadAt) out.push({ kind: "unread", key: "unread" });
    const grouped = variant === "chat" && !!prev && !newDay && !m.reply_to && i !== unreadAt && authorKey(prev) === authorKey(m)
      && !prev.deleted && !prev.kind && !m.kind && Date.parse(m.created_at) - Date.parse(prev.created_at) < FIVE_MINUTES;
    out.push({ kind: "message", key: m.id, m, grouped });
  });
  return out;
}

/** How many items now sit above the item that used to be first (older history was loaded). */
export function prependedCount(prevFirstKey: string | undefined, items: Item[]): number {
  if (!prevFirstKey) return 0;
  const i = items.findIndex((it) => it.key === prevFirstKey);
  return i < 0 ? 0 : i;
}

export const indexOfMessage = (items: Item[], id: string) => items.findIndex((it) => it.kind === "message" && it.m.id === id);
```

(The `!m.kind` term is new: a system message never joins a group. `MessageList` already renders `member_leave` rows without grouping.)

- [ ] **Step 5: Run it**

Run: `rtk pnpm --filter @datrope/web test -- message-items`
Expected: PASS.

- [ ] **Step 6: Replace the list body with `Virtuoso`**

In `MessageList`:

```tsx
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { buildItems, indexOfMessage, prependedCount, type Item } from "@/lib/message-items";

export const listApi = new Map<string, { scrollToId(id: string): boolean; scrollToBottom(): void }>();
const START = 1_000_000;
```

Inside the component:

```tsx
  const vref = useRef<VirtuosoHandle>(null);
  const items = useMemo(() => (list ? buildItems(list.items, { unreadAt, variant }) : []), [list, unreadAt, variant]);
  const firstKey = useRef<string>();
  const [base, setBase] = useState(START);
  useLayoutEffect(() => {
    const shift = prependedCount(firstKey.current, items);
    if (shift) setBase((b) => b - shift);
    firstKey.current = items[0]?.key;
  }, [items]);
  useEffect(() => { setBase(START); firstKey.current = undefined; }, [channelId]);

  const unreadIndex = items.findIndex((i) => i.kind === "unread");
  const [range, setRange] = useState({ startIndex: 0, endIndex: 0 });
  const dividerAbove = unreadIndex >= 0 && unreadIndex + base < range.startIndex;

  useEffect(() => {
    listApi.set(channelId, {
      scrollToId: (id) => {
        const i = indexOfMessage(items, id);
        if (i < 0) return false;
        vref.current?.scrollToIndex({ index: base + i, align: "center", behavior: "auto" });
        return true;
      },
      scrollToBottom: () => vref.current?.scrollToIndex({ index: "LAST", align: "end" }),
    });
    return () => { listApi.delete(channelId); };
  }, [channelId, items, base]);

  const [olderError, setOlderError] = useState<string>();
  const loadOlder = async () => {
    if (!list?.hasMore || loadingOlder) return;
    setLoadingOlder(true); setOlderError(undefined);
    try { await client.loadOlder(channelId); } catch (e) { setOlderError(errorText(e)); } finally { setLoadingOlder(false); }
  };
  const loadNewer = async () => {
    if (!list?.hasNewer || loadingNewer) return;
    setLoadingNewer(true);
    try { await client.loadNewer(channelId); } finally { setLoadingNewer(false); }
  };
```

Render (replacing the scroller `div`, both "Load … messages" buttons and the `items.map`):

```tsx
      <Virtuoso<Item>
        key={channelId}
        ref={vref}
        data={items}
        firstItemIndex={base}
        initialTopMostItemIndex={unreadIndex >= 0 ? { index: unreadIndex, align: "start" } : { index: Math.max(0, items.length - 1), align: "end" }}
        followOutput={(atBottom) => (!list.hasNewer && (atBottom || items.at(-1)?.kind === "message" && (items.at(-1) as Extract<Item, { kind: "message" }>).m.author?.id === meId) ? "auto" : false)}
        atBottomStateChange={(b) => { stick.current = b; setBottomVisible(b); if (b) void loadNewer(); }}
        atBottomThreshold={32}
        startReached={() => void loadOlder()}
        rangeChanged={setRange}
        increaseViewportBy={{ top: 800, bottom: 400 }}
        computeItemKey={(_, it) => it.key}
        scrollerRef={(el) => { scroller.current = el as HTMLDivElement | null; }}
        components={{ Scroller: LogScroller, Header: () => (loadingOlder ? <SkeletonRows /> : olderError ? <RetryRow error={olderError} onRetry={() => void loadOlder()} /> : null),
          Footer: () => (loadingNewer ? <SkeletonRows /> : <div className="h-2" />), EmptyPlaceholder: () => <p className="grid min-h-full place-items-center p-8 text-center text-muted-foreground">No messages yet. Say hi!</p> }}
        itemContent={(_, it) => it.kind === "day" ? <DayDivider date={it.date} />
          : it.kind === "unread" ? <UnreadDivider />
          : <Row it={it} />}
      />
```

with, at module level:

```tsx
/** The scroller Virtuoso renders: the message log landmark. */
const LogScroller = forwardRef<HTMLDivElement, ComponentProps<"div">>((props, ref) => (
  <div {...props} ref={ref} role="log" aria-label="Messages" aria-live="off" className="overflow-x-hidden overscroll-y-contain pt-4" />
));
LogScroller.displayName = "LogScroller";

function SkeletonRows() {
  return (
    <div aria-hidden className="grid gap-4 px-4 py-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3">
          <div className="size-10 rounded-full bg-muted motion-safe:animate-pulse" />
          <div className="grid content-start gap-2 pt-1">
            <div className="h-3 w-28 rounded bg-muted motion-safe:animate-pulse" />
            <div className="h-3 w-3/4 rounded bg-muted motion-safe:animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-muted motion-safe:animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RetryRow({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground">
      Couldn't load older messages.<Button variant="link" className="h-auto p-0" onClick={onRetry}>Retry</Button>
      <span className="sr-only">{error}</span>
    </div>
  );
}
```

`DayDivider` and `UnreadDivider` are the existing divider JSX moved into components (keep `role="separator" aria-label="New messages"` on the unread one). `Row` renders what the old map rendered for one message (`member_leave` paragraph, card, or `MessageRow` with `tabbable`/`onRowFocus`/`scroller`), wrapped in a `div` with `px-0 py-px` so Virtuoso can measure it. Phase 3 replaces `SkeletonRows`' divs with shadcn `Skeleton`.

Delete: the `bottom` sentinel, its IntersectionObserver, `measure()` and the `divider` ref measuring, the `opened` scroll effect (replaced by `initialTopMostItemIndex`). Keep the ResizeObserver for the phone keyboard but make it call `vref.current?.scrollToIndex({ index: "LAST", align: "end" })` when `stick.current && !hasNewer.current`.

`jumpTo` rewrite (same signature):

```ts
export async function jumpTo(channelId: string, messageId: string): Promise<boolean> {
  const loaded = () => client.store.getState().messages[channelId]?.items.some((m) => m.id === messageId) ?? false;
  const older = () => {
    const list = client.store.getState().messages[channelId];
    const oldest = list?.items.find((m) => !m.pending)?.id;
    return !!list?.hasMore && !!oldest && compareIds(messageId, oldest) < 0;
  };
  for (let page = 0; !loaded() && page < 2 && older(); page++) await client.loadOlder(channelId);
  if (!loaded()) {
    try { await client.loadAround(channelId, messageId); }
    catch (e) { if (e instanceof ApiError && e.status === 404) return false; throw e; }
  }
  await nextFrame();
  if (!listApi.get(channelId)?.scrollToId(messageId)) return false;
  await nextFrame();
  await nextFrame();
  const el = document.getElementById(`message-${messageId}`);
  if (!el) return false;
  el.classList.remove("message-flash");
  void el.offsetWidth;
  el.classList.add("message-flash");
  setTimeout(() => el.classList.remove("message-flash"), 1500);
  return true;
}
```

`jumpToUnread`: keep the page-loading loop, then `vref.current?.scrollToIndex({ index: base + items.findIndex((i) => i.kind === "unread"), align: "start" })` (fall back to index `base` — the oldest loaded — when there is no unread item). "Jump to present": `await client.loadLatest(channelId); await nextFrame(); listApi.get(channelId)?.scrollToBottom();`.

Roving with virtualization: in `MessageRow`'s key handler (Task 6) replace the DOM `rows` navigation with a call to a new prop `onNavigate(act: "prev" | "next" | "first" | "last")`; `MessageList` implements it with the item list: find the current message's index, pick the target message index (skipping day/unread items), then `vref.current?.scrollIntoView({ index: base + target, behavior: "auto", done: () => focusRow(scroller.current, targetId) })`. Delete's neighbour lookup uses the same items list.

- [ ] **Step 7: Typecheck, test, check**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test`
In a channel with > 200 messages: scrolling up shows skeleton rows then older messages without a jump; the DOM holds a bounded number of `article`s (`document.querySelectorAll("article").length` < 80); new messages keep you at the bottom; a search result far back opens, scrolls and flashes; the unread line opens at the top of the view; ↑/↓ walks past the rendered range.

- [ ] **Step 8: Stage and pause for review**

Suggested message: `perf(web): virtualized message list with scroll paging`.

---

### Task 18: Virtualized member list and gallery

**Files:**
- Modify: `src/app/MemberList.tsx` (`GroupedVirtuoso`)
- Modify: `src/app/gallery/GalleryView.tsx` (rows of tiles in `GroupedVirtuoso`)
- Create: `src/lib/chunk.ts`, `src/lib/chunk.test.ts`

**Interfaces:**
- Produces: `chunk<T>(items: T[], size: number): T[][]`.

- [ ] **Step 1: Failing test**

```ts
// src/lib/chunk.test.ts
import { describe, expect, it } from "vitest";
import { chunk } from "./chunk";
describe("chunk", () => {
  it("splits into rows", () => expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]));
  it("treats size < 1 as 1", () => expect(chunk([1, 2], 0)).toEqual([[1], [2]]));
  it("handles empty input", () => expect(chunk([], 3)).toEqual([]));
});
```

Run: `rtk pnpm --filter @datrope/web test -- chunk` → FAIL.

- [ ] **Step 2: Implement**

```ts
// src/lib/chunk.ts
/** `items` in rows of `size` (at least 1). */
export function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
```

Run again → PASS.

- [ ] **Step 3: Member list**

Replace the `groups.map(...)` body with:

```tsx
      <GroupedVirtuoso className="h-full"
        groupCounts={groups.map((g) => g.members.length)}
        groupContent={(gi) => <h3 className="bg-card px-0 pt-3 pb-1">{groups[gi]!.name} — {groups[gi]!.members.length}</h3>}
        itemContent={(index) => <MemberRow m={flat[index]!} />} />
```

where `flat = groups.flatMap((g) => g.members)` (memoised) and `MemberRow` is the existing `<ContextMenu>…</ContextMenu>` row extracted into a component (same props it reads: presences, activities, inVoice, colors, sheet, meId, nav). The `aside` becomes `flex flex-col` with the list in a `min-h-0 flex-1` wrapper; group headers are sticky by default in `GroupedVirtuoso`. Keep `aria-label="Members"` on the `aside`; each group's `section aria-label` is replaced by the visible `h3` (e2e: `rtk grep -n "region\|Members" e2e` and keep any selectors working).

- [ ] **Step 4: Gallery**

Measure the tile grid width with a `ResizeObserver` on the scroll container and compute `columns = Math.max(1, Math.floor((width - 32 + 8) / (160 + 8)))` (tile min 160 px, gap 8 px, padding 16 px). Build `rows = groups.map((g) => chunk(g.items, columns))`, then:

```tsx
            <GroupedVirtuoso className="h-full"
              groupCounts={rows.map((r) => r.length)}
              groupContent={(gi) => <h3 className="bg-background px-4 pt-4 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{groups[gi]!.label}</h3>}
              itemContent={(index, gi) => {
                const row = flatRows[index]!;
                return (
                  <div className="grid gap-2 px-4 pb-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                    {row.map((it) => <FileTile key={it.attachment.id} …same props as today… />)}
                  </div>
                );
              }}
              endReached={() => { if (files.hasMore && !files.loading) files.loadMore(); }}
              components={{ Footer: () => (files.loading ? <p className={note}>Loading…</p> : files.error ? <div className="px-4"><ErrorText error={files.error} /></div> : null) }} />
```

(`flatRows = rows.flat()`; remove the sentinel and its observer.) Arrow-key navigation from Task 8 still works because tiles in view are in the DOM; `columns` feeds `useArrowNav`'s `columns` option directly.

- [ ] **Step 5: Typecheck and check**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test`
Gallery with many files: scrolling loads more at the end; headings stay readable; member list scrolls with sticky group headers.

- [ ] **Step 6: Stage and pause for review**

Suggested message: `perf(web): virtualize the member list and gallery`.

---

### Task 19: Timestamps

**Files:**
- Create: `src/lib/message-time.ts`, `src/lib/message-time.test.ts`
- Modify: `src/app/MessageList.tsx` (header stamp, grouped gutter time)

**Interfaces:**
- Produces: `headStamp(d: Date, now?: Date, locale?: string): string`; `fullStamp(d: Date, locale?: string): string`; `clockTime(d: Date, locale?: string): string`.

- [ ] **Step 1: Failing test**

```ts
// src/lib/message-time.test.ts
import { describe, expect, it } from "vitest";
import { clockTime, fullStamp, headStamp } from "./message-time";

const now = new Date(2026, 9, 14, 12, 0); // 14 Oct 2026, local time
describe("headStamp", () => {
  it("says Today and Yesterday with the time", () => {
    expect(headStamp(new Date(2026, 9, 14, 8, 33), now, "en-GB")).toBe("Today 08:33");
    expect(headStamp(new Date(2026, 9, 13, 21, 10), now, "en-GB")).toBe("Yesterday 21:10");
  });
  it("gives the date for older days", () => {
    expect(headStamp(new Date(2026, 9, 9, 8, 33), now, "en-GB")).toBe("9 Oct 2026 08:33");
  });
  it("handles midnight on both sides", () => {
    expect(headStamp(new Date(2026, 9, 14, 0, 0), now, "en-GB")).toBe("Today 00:00");
    expect(headStamp(new Date(2026, 9, 13, 23, 59), now, "en-GB")).toBe("Yesterday 23:59");
  });
  it("follows the locale's clock", () => {
    expect(headStamp(new Date(2026, 9, 14, 20, 5), now, "en-US")).toMatch(/^Today 8:05\s?PM$/);
  });
});
describe("clockTime and fullStamp", () => {
  it("formats", () => {
    expect(clockTime(new Date(2026, 9, 14, 8, 4), "en-GB")).toBe("08:04");
    expect(fullStamp(new Date(2026, 9, 14, 8, 4), "en-GB")).toMatch(/14 October 2026/);
  });
});
```

Run: `rtk pnpm --filter @datrope/web test -- message-time` → FAIL.

- [ ] **Step 2: Implement**

```ts
// src/lib/message-time.ts
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** The locale uses a 12-hour clock. */
const twelve = (locale?: string) => /h1[12]/.test(new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle ?? "");
/** "08:33" (24-hour locales) or "8:33 AM" (12-hour locales). */
export const clockTime = (d: Date, locale?: string) =>
  new Intl.DateTimeFormat(locale, twelve(locale) ? { hour: "numeric", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

/** A message group's time: "Today 08:33", "Yesterday 21:10", or "9 Oct 2026 08:33". */
export function headStamp(d: Date, now = new Date(), locale?: string): string {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = clockTime(d, locale);
  if (sameDay(d, now)) return `Today ${time}`;
  if (sameDay(d, yesterday)) return `Yesterday ${time}`;
  return `${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(d)} ${time}`;
}

/** The full date and time, for tooltips. */
export const fullStamp = (d: Date, locale?: string) => new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(d);
```

Run again → PASS. (Node's ICU may put a narrow no-break space before "PM"; the test's `\s?` allows it.)

- [ ] **Step 3: Use it**

In `MessageRow`'s header: `<time className="text-xs text-muted-foreground" dateTime={m.created_at} title={fullStamp(new Date(m.created_at))}>{headStamp(new Date(m.created_at))}</time>`. In the grouped gutter (Task 6's `<span>` with the hidden name) add:

```tsx
<time dateTime={m.created_at} title={fullStamp(new Date(m.created_at))}
  className="invisible self-start pt-0.5 text-right text-[11px] text-muted-foreground group-hover:visible group-focus-within:visible">
  {clockTime(new Date(m.created_at))}
</time>
```

Keep the exported `stamp()` for the "New messages since …" bar and the delete dialog.

- [ ] **Step 4: Typecheck, test, stage**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test`
Suggested message: `feat(web): friendlier message timestamps and hover time on grouped messages`.

---

### Task 20: Lazy images

**Files:**
- Modify: `src/app/gallery/AlbumsView.tsx:77`, `src/app/people/ProfileCard.tsx:73`, `src/app/server-settings/Emoji.tsx:120,167`, `src/app/attachments/ImageViewer.tsx:232`
- Modify: `src/styles.test.ts`

- [ ] **Step 1: Failing test** (append)

```ts
describe("lazy images", () => {
  it.each(["app/gallery/AlbumsView.tsx", "app/people/ProfileCard.tsx", "app/server-settings/Emoji.tsx", "app/attachments/ImageViewer.tsx"])("%s lazy-loads its images", (f) => {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    const imgs = src.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0);
    for (const tag of imgs) expect(tag).toContain('loading="lazy"');
  });
});
```

Run → FAIL. Add `loading="lazy"` to each `<img` in those files (keep the main image in `ImageViewer` eager: if its main `<img>` is in this file, mark it `loading="eager"` and change the assertion to accept `loading=` either way for that one file). Run → PASS.

- [ ] **Step 2: Stage**

Suggested message: `perf(web): lazy-load covers, banners, emoji and thumbnails`.

---

### Task 21: Playwright for Phase 2 and the virtualized list

**Files:**
- Modify: `e2e/desktop.spec.ts`, `e2e/chat.spec.ts` (anything that clicked "Load older messages" or expected every message in the DOM)

- [ ] **Step 1: Update existing tests**

Run: `rtk grep -n "Load older\|Load newer\|article" e2e`. Replace button clicks with scrolling the log to the top until the message is visible:

```ts
async function scrollUntilVisible(page: Page, text: string) {
  const log = page.getByRole("log", { name: "Messages" });
  for (let i = 0; i < 20 && !(await page.getByText(text).isVisible()); i++) {
    await log.evaluate((el) => el.scrollTo({ top: 0 }));
    await page.waitForTimeout(200);
  }
  await expect(page.getByText(text)).toBeVisible();
}
```

- [ ] **Step 2: New tests** (append to `e2e/desktop.spec.ts`)

```ts
test("scrolling up loads older messages without a button", async ({ page }) => {
  test.skip(width(page) !== 1440, "once");
  for (let i = 0; i < 70; i++) {
    await page.getByLabel("Message", { exact: true }).fill(`bulk ${i}`);
    await page.getByLabel("Message", { exact: true }).press("Enter");
  }
  await page.reload();
  await expect(page.getByRole("button", { name: "Load older messages" })).toHaveCount(0);
  await scrollUntilVisible(page, "bulk 0");
  expect(await page.locator("article").count()).toBeLessThan(120);
});

test("jump from search to an old message", async ({ page }) => {
  test.skip(width(page) !== 1440, "once");
  await page.getByLabel("Search").fill("bulk 1");
  await page.getByLabel("Search").press("Enter");
  await page.getByRole("complementary", { name: /search/i }).getByText("bulk 1", { exact: true }).first().click();
  await expect(page.locator(".message-flash")).toContainText("bulk 1");
});
```

(Move `scrollUntilVisible` to a shared helper in `e2e/` if `chat.spec.ts` needs it too.)

- [ ] **Step 3: Run the whole suite**

Run the e2e stack (Task 12 Step 3 command) and `rtk playwright test`.
Expected: all projects pass.

- [ ] **Step 4: Re-audit and stage**

Run `/impeccable audit` at 820, 1440 and 2560 px; append "Re-audit after Phase 2" to the audit doc.
Suggested message: `test(web): e2e for scroll paging and jumps in the virtualized list`.

---

## Phase 3 — Polish and shortcuts

### Task 22: Shortcut registry, handlers and the shortcut sheet

**Files:**
- Fetch: shadcn `kbd` (`pnpm dlx shadcn@latest add kbd` from `clients/web`)
- Create: `src/lib/shortcuts.ts`, `src/lib/shortcuts.test.ts`, `src/hooks/use-shortcuts.ts`, `src/components/shortcut-sheet.tsx`, `src/app/chat-events.ts`
- Modify: `src/app/AppShell.tsx`, `src/app/Composer.tsx` (↑ to edit last), `src/app/MessageList.tsx` (listen for present/edit events), `src/app/ChannelView.tsx` (toggle members event), `src/app/palette/CommandPalette.tsx` (new entries), tooltips for Search, Members, Mute, Deafen

**Interfaces:**
- Produces: `type ShortcutId = "channel-prev" | "channel-next" | "unread-prev" | "unread-next" | "search" | "mute" | "deafen" | "sheet"`; `SHORTCUTS: { id: ShortcutId; keys: string[]; label: string; group: "Navigation" | "Messages" | "Voice" | "Help" }[]` (`keys` are display labels like `["Alt", "↑"]`, with `Ctrl` shown as `⌘` on macOS by the sheet); `matchShortcut(e: KeyLike, mac: boolean): ShortcutId | null`; `isEditableTarget(t: { tagName?: string; isContentEditable?: boolean } | null): boolean`; `isTypeToFocus(e: KeyLike, target: … ): boolean`; `KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean }`.
- Produces: `chatEvents` — `emitPresent(channelId)`, `onPresent(channelId, cb)`, `emitEditLast(channelId)`, `onEditLast(channelId, cb)`, `emitToggleMembers()`, `onToggleMembers(cb)` (tiny `EventTarget` wrappers).
- Message-level keys (Escape/Enter/r/e…) stay in Task 6; Ctrl+K stays in `CommandPalette`.

- [ ] **Step 1: Failing test**

```ts
// src/lib/shortcuts.test.ts
import { describe, expect, it } from "vitest";
import { isEditableTarget, isTypeToFocus, matchShortcut } from "./shortcuts";

const k = (key: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });

describe("matchShortcut", () => {
  it("matches navigation keys", () => {
    expect(matchShortcut(k("ArrowUp", { altKey: true }), false)).toBe("channel-prev");
    expect(matchShortcut(k("ArrowDown", { altKey: true }), false)).toBe("channel-next");
    expect(matchShortcut(k("ArrowUp", { altKey: true, shiftKey: true }), false)).toBe("unread-prev");
    expect(matchShortcut(k("ArrowDown", { altKey: true, shiftKey: true }), false)).toBe("unread-next");
  });
  it("uses Ctrl off macOS and Cmd on macOS", () => {
    expect(matchShortcut(k("f", { ctrlKey: true }), false)).toBe("search");
    expect(matchShortcut(k("f", { metaKey: true }), true)).toBe("search");
    expect(matchShortcut(k("f", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(k("M", { ctrlKey: true, shiftKey: true }), false)).toBe("mute");
    expect(matchShortcut(k("D", { ctrlKey: true, shiftKey: true }), false)).toBe("deafen");
    expect(matchShortcut(k("/", { ctrlKey: true }), false)).toBe("sheet");
  });
  it("ignores IME composition and stray modifiers", () => {
    expect(matchShortcut(k("f", { ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(matchShortcut(k("f", { ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});

describe("type to focus", () => {
  it("only for printable keys without modifiers outside fields", () => {
    expect(isTypeToFocus(k("a"), { tagName: "BODY" })).toBe(true);
    expect(isTypeToFocus(k("a", { ctrlKey: true }), { tagName: "BODY" })).toBe(false);
    expect(isTypeToFocus(k("Enter"), { tagName: "BODY" })).toBe(false);
    expect(isTypeToFocus(k(" "), { tagName: "BODY" })).toBe(false);
    expect(isTypeToFocus(k("a"), { tagName: "INPUT" })).toBe(false);
    expect(isTypeToFocus(k("a"), { tagName: "DIV", isContentEditable: true })).toBe(false);
    expect(isTypeToFocus(k("a", { isComposing: true }), { tagName: "BODY" })).toBe(false);
  });
  it("knows editable targets", () => {
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
  });
});
```

Run: `rtk pnpm --filter @datrope/web test -- shortcuts` → FAIL.

- [ ] **Step 2: Implement the registry**

```ts
// src/lib/shortcuts.ts
export type ShortcutId = "channel-prev" | "channel-next" | "unread-prev" | "unread-next" | "search" | "mute" | "deafen" | "sheet";
export type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean };
type Def = { id: ShortcutId; keys: string[]; label: string; group: "Navigation" | "Messages" | "Voice" | "Help"; alt?: boolean; mod?: boolean; shift?: boolean; key: string };

export const SHORTCUTS: Def[] = [
  { id: "channel-prev", keys: ["Alt", "↑"], label: "Previous channel", group: "Navigation", alt: true, key: "arrowup" },
  { id: "channel-next", keys: ["Alt", "↓"], label: "Next channel", group: "Navigation", alt: true, key: "arrowdown" },
  { id: "unread-prev", keys: ["Alt", "Shift", "↑"], label: "Previous unread channel", group: "Navigation", alt: true, shift: true, key: "arrowup" },
  { id: "unread-next", keys: ["Alt", "Shift", "↓"], label: "Next unread channel", group: "Navigation", alt: true, shift: true, key: "arrowdown" },
  { id: "search", keys: ["Ctrl", "F"], label: "Search", group: "Navigation", mod: true, key: "f" },
  { id: "mute", keys: ["Ctrl", "Shift", "M"], label: "Mute or unmute", group: "Voice", mod: true, shift: true, key: "m" },
  { id: "deafen", keys: ["Ctrl", "Shift", "D"], label: "Deafen or undeafen", group: "Voice", mod: true, shift: true, key: "d" },
  { id: "sheet", keys: ["Ctrl", "/"], label: "Keyboard shortcuts", group: "Help", mod: true, key: "/" },
];

/** Keys handled elsewhere, listed on the sheet only. */
export const OTHER_KEYS: { keys: string[]; label: string; group: Def["group"] }[] = [
  { keys: ["Ctrl", "K"], label: "Jump to or run a command", group: "Navigation" },
  { keys: ["↑"], label: "Edit your last message (empty message box)", group: "Messages" },
  { keys: ["Esc"], label: "Mark read and jump to newest", group: "Messages" },
  { keys: ["↑", "↓"], label: "Move between messages", group: "Messages" },
  { keys: ["R"], label: "Reply to the focused message", group: "Messages" },
  { keys: ["E"], label: "Edit the focused message", group: "Messages" },
  { keys: ["T"], label: "Open a thread on the focused message", group: "Messages" },
  { keys: ["P"], label: "Pin the focused message", group: "Messages" },
  { keys: ["+"], label: "React to the focused message", group: "Messages" },
  { keys: ["Enter"], label: "More actions for the focused message", group: "Messages" },
];

export function matchShortcut(e: KeyLike, mac: boolean): ShortcutId | null {
  if (e.isComposing) return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  if (otherMod) return null;
  const key = e.key.toLowerCase();
  for (const s of SHORTCUTS) {
    if (!!s.alt === e.altKey && !!s.mod === mod && !!s.shift === e.shiftKey && s.key === key) return s.id;
  }
  return null;
}

export function isEditableTarget(t: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!t) return false;
  return !!t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName ?? "");
}

/** A printable key typed while nothing editable has focus: it should land in the message box. */
export function isTypeToFocus(e: KeyLike, target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  return !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key !== " " && !isEditableTarget(target);
}
```

Run again → PASS.

- [ ] **Step 3: Events and the hook**

```ts
// src/app/chat-events.ts
const bus = new EventTarget();
const on = (type: string, cb: () => void) => { bus.addEventListener(type, cb); return () => bus.removeEventListener(type, cb); };
export const emitPresent = (channelId: string) => bus.dispatchEvent(new Event(`present:${channelId}`));
export const onPresent = (channelId: string, cb: () => void) => on(`present:${channelId}`, cb);
export const emitEditLast = (channelId: string) => bus.dispatchEvent(new Event(`edit-last:${channelId}`));
export const onEditLast = (channelId: string, cb: () => void) => on(`edit-last:${channelId}`, cb);
export const emitToggleMembers = () => bus.dispatchEvent(new Event("toggle-members"));
export const onToggleMembers = (cb: () => void) => on("toggle-members", cb);
```

`src/hooks/use-shortcuts.ts` (mounted in `AppShell` when `!mobile` and not touch-only):
- `keydown` on `window` (bubble phase). Skip when `e.defaultPrevented` or an open `[role=dialog],[role=menu]` exists (except `sheet`).
- `channel-prev/next`: `const ids = sidebarChannelIds(client.store.getState())` (from `@datrope/core`, as the palette uses; on `/messages/*` use `dmIds` instead); move from the current id in the URL; `navigate`.
- `unread-prev/next`: same list filtered by `isUnread(readStates[id])` and `isUnreadType(channels[id].type)` (import from where `ChannelTree` imports them), wrapping around.
- `search`: `preventDefault()`; focus `input[aria-label="Search"]`, or click `button[aria-label="Search"]` (narrow) and focus after a frame.
- `mute` / `deafen`: `const v = voice.store.getState(); if (v.status !== "idle") void voice.setMuted(!v.muted)` / `setDeafened(!v.deafened)` (check the deafened field name in `voice/voice.ts`).
- `sheet`: `shortcutSheetStore.setState({ open: true })`.
- Otherwise, `isTypeToFocus(e, document.activeElement)` and no open dialog/menu → focus `textarea[aria-label="Message"]` (don't `preventDefault`: the key lands in it).
- Esc (no modifiers, target not editable, no dialog/menu open, current route is a channel/DM) → `emitPresent(channelId)`.

`MessageList`: `useEffect(() => onPresent(channelId, () => { markRead(); if (list?.hasNewer) void client.loadLatest(channelId).then(() => listApi.get(channelId)?.scrollToBottom()); else listApi.get(channelId)?.scrollToBottom(); }), [channelId, list?.hasNewer])`. Also `onEditLast(channelId, …)`: find the last item whose `m.author?.id === meId && !m.deleted && !m.poll && !m.pending`, scroll it into view, then dispatch the edit: give `MessageRow` a prop `editRequest: number` (a counter `MessageList` bumps for that message id) and in `MessageRow` `useEffect(() => { if (editRequest) onEdit?.(); }, [editRequest])`.

`Composer`: in its keydown handler, `if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && value === "" && !replyTo) { e.preventDefault(); emitEditLast(channelId); }` (before the autocomplete handling only if autocomplete is closed).

`ChannelView`: `useEffect(() => onToggleMembers(toggleMembers), [toggleMembers])` (wrap `toggleMembers` in `useCallback`).

- [ ] **Step 4: Sheet and palette**

```tsx
// src/components/shortcut-sheet.tsx
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { OTHER_KEYS, SHORTCUTS } from "@/lib/shortcuts";

export const shortcutSheetStore = createStore<{ open: boolean }>(() => ({ open: false }));
const isMac = () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
const label = (k: string) => (k === "Ctrl" && isMac() ? "⌘" : k);

export function ShortcutSheet() {
  const open = useStore(shortcutSheetStore, (s) => s.open);
  const rows = [...SHORTCUTS, ...OTHER_KEYS];
  return (
    <Dialog open={open} onOpenChange={(o) => shortcutSheetStore.setState({ open: o })}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Work without the mouse.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {(["Navigation", "Messages", "Voice", "Help"] as const).map((g) => (
            <section key={g} aria-label={g}>
              <h3 className="mb-2">{g}</h3>
              <dl className="grid gap-1.5">
                {rows.filter((r) => r.group === g).map((r) => (
                  <div key={r.label} className="flex items-center justify-between gap-4">
                    <dt className="text-sm">{r.label}</dt>
                    <dd><KbdGroup>{r.keys.map((k) => <Kbd key={k}>{label(k)}</Kbd>)}</KbdGroup></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

Mount `<ShortcutSheet />` in `AppShell` (desktop). In `CommandPalette` add a "Actions" group with items: "Mark as read" (current channel: `client.ack(id, lastMessageId)`), "Leave voice" (when in a call: `voice.leave()`), "Toggle members" (`emitToggleMembers()`), "Keyboard shortcuts" (`shortcutSheetStore.setState({ open: true })`), each closing the palette first via the existing `act()`.

Tooltips: add `<Kbd>` hints to the Members tooltip (none — no shortcut), the Search box `title` → wrap in a Tooltip "Search Ctrl F", and `MuteControl`/`DeafenControl` tooltips (`voice/VoicePanel.tsx`) "Mute Ctrl Shift M" / "Deafen Ctrl Shift D".

- [ ] **Step 5: Typecheck, test, check**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test`
Alt+↓ moves to the next channel; Ctrl+/ opens the sheet; typing `h` with nothing focused puts `h` in the message box; ↑ in an empty box edits your last message; Esc in a channel scrolled up jumps to the newest message and clears the "New messages" bar.

- [ ] **Step 6: Stage**

Suggested message: `feat(web): keyboard shortcuts and a shortcut sheet`.

---

### Task 23: One settings layout

**Files:**
- Create: `src/components/settings-layout.tsx`, `src/app/settings/UserSettingsPage.tsx`
- Modify: `src/app/server-settings/ServerSettings.tsx` (desktop branch uses the layout), `src/app/settings/settings-store.ts` (desktop navigates), `src/router.tsx` (`settings/:section?`), `src/app/AppShell.tsx` (no `UserSettingsDialog`; register `setSettingsNavigate` on desktop; hide `ServerSidebar` on `/settings`)
- Delete: `src/app/settings/UserSettingsDialog.tsx` (after moving anything still used)

**Interfaces:**
- Produces: `SettingsLayout({ title, subtitle, icon, navLabel, groups, current, onBack, children })` where `groups: { label: string; items: { id: string; label: string; icon: LucideIcon; to?: string; onSelect?: () => void; badge?: ReactNode; soon?: string; state?: unknown }[] }[]`; Esc and "Back to chat" call `onBack`.
- Produces: route `/settings/:section?` → `UserSettingsRoute` (phone: `<Navigate to={`/you/${section ?? ""}`} replace />`; desktop: `UserSettingsPage`).

- [ ] **Step 1: Extract the layout**

Move the desktop JSX of `ServerSettings` (the `nav` with header, groups, `Back to chat` footer, and the `main` with its 56 px header and 860 px content) into `SettingsLayout`, parameterised as above. "Back to chat" becomes `<Button variant="ghost" className={cn(NAV, "w-full justify-start text-foreground")} onClick={onBack}>…<span className="ml-auto text-xs text-muted-foreground">Esc</span></Button>`. Move the Esc `useEffect` into the layout. `ServerSettings` desktop renders `<SettingsLayout title="Server settings" subtitle={name} icon={<ServerIcon size={26} />} navLabel="Server settings" … current={current?.label} onBack={close}>{current?.element ?? …}</SettingsLayout>`. Keep the nav's `aria-label="Server settings"` and the `link` roles (e2e: `getByRole("link", { name: "Invites" })`).

- [ ] **Step 2: User settings page**

```tsx
// src/app/settings/UserSettingsPage.tsx
import { Settings, UserRound } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { SettingsLayout } from "@/components/settings-layout";
import { lastVisited, useApp } from "../../session";
import { GROUPS, visibleSections } from "./sections";
import { closeNotice, useSettings } from "./settings-store";

/** /settings/:section on desktop: "Your settings" in the same layout as server settings. */
export function UserSettingsPage() {
  const { section } = useParams();
  const nav = useNavigate();
  const isAdmin = useApp((s) => !!s.me?.is_admin);
  const isGuest = useApp((s) => !!s.me?.guest_expires_at);
  const notice = useSettings((s) => s.notice);
  const sections = visibleSections({ guest: isGuest, admin: isAdmin });
  const current = sections.find((s) => s.id === section) ?? sections[0]!;
  const back = () => { closeNotice(); const last = lastVisited("channel"); nav(last ? `/channels/${last}` : "/"); };
  return (
    <SettingsLayout title="Your settings" icon={<UserRound className="size-5" aria-hidden />} navLabel="Settings sections" current={current.label} onBack={back}
      groups={[
        ...GROUPS.map((g) => ({ label: g, items: sections.filter((s) => s.group === g).map((s) => ({ id: s.id, label: s.label, icon: s.icon, to: `/settings/${s.id}` })) })),
        ...(isAdmin ? [{ label: "", items: [{ id: "server", label: "Server settings", icon: Settings, to: "/server-settings" }] }] : []),
      ]}>
      {notice && <p role="status" className="rounded-md border bg-card px-3 py-2 text-sm">{notice}</p>}
      {current.body()}
    </SettingsLayout>
  );
}
```

(Check how `UserSettingsDialog` showed `notice` today and keep that copy and placement; if it was rendered inside a section body, keep it there.)

- [ ] **Step 3: Routing and store**

`router.tsx`: replace `{ path: "settings", element: <SettingsRedirect /> }` with `{ path: "settings/:section?", element: <UserSettingsRoute /> }` (`UserSettingsRoute` in the same file as `UserSettingsPage`: phone → `/you/:section`, desktop → page). `settings-store.ts` `openSettings`: when `settingsNavigate` is set and not on a phone, `settingsStore.setState({ section, notice }); settingsNavigate(`/settings/${section}`)`. `AppShell` registers `setSettingsNavigate(navigate)` on desktop (in an effect; clear on unmount) — the phone shell keeps its own registration. `AppShell` hides `ServerSidebar` when `pathname.startsWith("/settings")` too, and stops rendering `UserSettingsDialog`. Delete `UserSettingsDialog.tsx` once nothing imports it (`rtk grep -rn "UserSettingsDialog" src`).

- [ ] **Step 4: E2E selectors**

`rtk grep -n "Your settings\|Settings sections" e2e` and update steps that expected a dialog (`getByRole("dialog", { name: "Your settings" })`) to the page (`getByRole("navigation", { name: "Settings sections" })`).

- [ ] **Step 5: Typecheck, test, check, stage**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test`
The profile strip gear opens `/settings/profile` as a full page; Esc returns to the last channel; phones still use `/you`.
Suggested message: `feat(web): user settings use the server settings layout`.

---

### Task 24: Skeletons and empty states

**Files:**
- Fetch: shadcn `skeleton`, `empty`
- Modify: every content-area "Loading…" (`rtk grep -rn "Loading…" src/app`) and the empty states listed below
- Modify: `src/app/MessageList.tsx` (`SkeletonRows` uses `Skeleton`)

- [ ] **Step 1: Fetch**

From `clients/web`: `pnpm dlx shadcn@latest add skeleton empty`. Strip any `dark:` classes; fix imports.

- [ ] **Step 2: Skeletons**

For each content-area "Loading…" (not inside a button and not a status line next to a control), replace the text with a skeleton shaped like the content, keeping an accessible status: `<div role="status" aria-label="Loading">…<Skeleton … />…</div>`.
- Message list (`MessageList.tsx` `!list` branch and `SkeletonRows`): avatar + three bars (as in Task 17, with `Skeleton`).
- Lists (DMs, threads list, pins, members, search results, sessions, invites, bans, sign-ups): 5 rows of `Skeleton className="h-8 w-full"`.
- Grids (gallery, albums, playlists): 8 tiles `Skeleton className="aspect-square"` in the same grid classes.
- Music view: 6 rows `Skeleton className="h-10 w-full"`.
Leave "Loading…" inside buttons (`{busy ? "Loading…" : "…"}`) as is.

- [ ] **Step 3: Empty states**

Use `Empty`, `EmptyHeader`, `EmptyMedia variant="icon"`, `EmptyTitle`, `EmptyDescription`, `EmptyContent` from `@/components/ui/empty` with this copy:

| Where | Icon | Title | Description | Action |
|---|---|---|---|---|
| `DMList.tsx:62` | `MessageCircle` | No conversations yet | Start one with a friend. | Button "New message" (opens the existing NewDMDialog) |
| `side-panel/ThreadsList.tsx:36` | `MessageSquare` | No threads yet | Start one from a message's menu. | — |
| `PinsPanel.tsx:53` | `Pin` | No pinned messages yet | Pin one from its menu to keep it here. | — |
| `MessageList` empty | `Hand` | This is the start of #name | Say hi! | — |
| search results empty (`search/SearchPanel.tsx`) | `SearchX` | Nothing found | Try fewer words or a different filter. | — |
| gallery `No files yet.` | `Images` | No files yet | Files shared in chat show up here. | — |
| gallery filtered | `FilterX` | No files match | — | Button "Clear filters" (existing) |
| albums / playlists empty | `Album` / `ListMusic` | No albums yet / No playlists yet | Make one to collect photos / songs. | existing create button |
| `server-settings/Emoji.tsx:153` | `Smile` | No custom emoji yet | Upload one to use it in chat. | — |

For the empty channel the title needs the channel name: pass it from `ChannelView` to `MessageList` as `emptyTitle` (DMs: "This is the start of your conversation").

- [ ] **Step 4: Typecheck and stage**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test && rtk grep -rn "Loading…" src/app` (only button/inline uses remain).
Suggested message: `feat(web): skeleton loading and teaching empty states`.

---

### Task 25: Type scale

**Files:**
- Modify: `src/styles.css` (`@theme inline` font sizes)
- Modify: every file using `text-[10px]`…`text-[16px]` (`rtk grep -rln "text-\[1[0-6]px\]" src`)
- Modify: `src/styles.test.ts`

- [ ] **Step 1: Failing test** (append)

```ts
import { readdirSync, statSync } from "node:fs";
const walk = (dir: URL): string[] => readdirSync(dir).flatMap((f) => {
  const u = new URL(`${f}${statSync(new URL(f, dir)).isDirectory() ? "/" : ""}`, dir);
  return statSync(u).isDirectory() ? walk(u) : /\.tsx?$/.test(f) ? [u.pathname] : [];
});
describe("type scale", () => {
  it("defines the scale tokens", () => {
    for (const t of ["caption", "meta", "ui", "body", "title", "heading"]) expect(css).toMatch(new RegExp(`--text-${t}:`));
  });
  it("uses no arbitrary pixel font sizes between 10 and 16 px", () => {
    const offenders = walk(new URL("./", import.meta.url)).filter((p) => !p.includes("/components/ui/"))
      .filter((p) => /text-\[1[0-6]px\]/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Tokens**

In `@theme inline` (root font-size is 15px, so use px):

```css
  --text-caption: 11px; --text-caption--line-height: 14px;
  --text-meta: 12px; --text-meta--line-height: 16px;
  --text-ui: 13px; --text-ui--line-height: 18px;
  --text-body: 15px; --text-body--line-height: 22px;
  --text-title: 16px; --text-title--line-height: 22px;
  --text-heading: 20px; --text-heading--line-height: 28px;
```

- [ ] **Step 3: Replace**

`text-[10px]`, `text-[11px]` → `text-caption`; `text-[12px]` → `text-meta`; `text-[13px]` → `text-ui`; `text-[14px]` → `text-sm`; `text-[15px]` → `text-body`; `text-[16px]` → `text-title`. Leave `components/ui/*` alone. Run the test → PASS. Spot-check the sidebar, message header, gallery filters and settings at 1440.

- [ ] **Step 4: Stage**

Suggested message: `refactor(web): one type scale`.

---

### Task 26: Motion tokens and reduced motion

**Files:**
- Modify: `src/styles.css`, `src/components/ui/sheet.tsx`, `dialog.tsx`, `popover.tsx`, `dropdown-menu.tsx`, `context-menu.tsx`, `tooltip.tsx` (durations)
- Modify: `src/styles.test.ts`

- [ ] **Step 1: Failing test** (append)

```ts
describe("motion", () => {
  it("defines duration and easing tokens", () => {
    for (const t of ["--dur-fast: 120ms", "--dur-base: 180ms", "--dur-slow: 240ms"]) expect(css).toContain(t);
    expect(css).toMatch(/--ease-out-quint:\s*cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
  });
  it("reduces Radix animations and the message flash", () => {
    const block = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("[data-state]");
    expect(block).toContain(".message-flash");
    expect(block).toContain("scroll-behavior: auto");
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

`:root`: `--dur-fast: 120ms; --dur-base: 180ms; --dur-slow: 240ms;`. `@theme inline`: `--ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);`. In the shadcn primitives replace hard durations (`duration-500`, `duration-300`, `duration-200`) on open/close animations with `duration-(--dur-base)` and add `ease-out-quint`; tooltips use `duration-(--dur-fast)`. Append:

```css
@media (prefers-reduced-motion: reduce) {
  [data-state][data-slot] { animation-duration: 1ms !important; transition-duration: 1ms !important; }
  .message-flash { animation: none; background-color: var(--accent); transition: background-color 1.5s linear; }
  html { scroll-behavior: auto; }
}
```

(Keep the existing vaul block.) Run the test → PASS. With reduced motion emulated in DevTools, sheets and dialogs appear without sliding and a jumped-to message is highlighted without the fade animation.

- [ ] **Step 3: Stage**

Suggested message: `feat(web): motion tokens and full reduced-motion coverage`.

---

### Task 27: Component vocabulary and small fixes

**Files:**
- Modify: files with raw `<button>` (`rtk grep -rn "<button" src/app src/chat | grep -v "components/ui"`), the four raw `type="range"` inputs (`settings/AvatarCropDialog.tsx:84`, `voice/PersonMenu.tsx:62`, `voice/SoundboardPanel.tsx:233`, `voice/StageView.tsx:60`), `src/app/DMList.tsx`, `src/app/MemberList.tsx`, `src/app/ProfileStrip.tsx`, `src/app/ServerSidebar.tsx` (`ServerIcon`), `src/app/gallery/GalleryView.tsx:117`
- Modify: `clients/desktop/src/ServerDrawer.tsx:21`, `clients/desktop/src/Chrome.tsx:82`
- Modify: `src/styles.test.ts`

- [ ] **Step 1: Failing test** (append)

```ts
describe("component vocabulary", () => {
  it("has no raw range inputs outside ui/", () => {
    const offenders = walk(new URL("./app/", import.meta.url)).filter((p) => /type="range"/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("keeps raw buttons to the documented exceptions", () => {
    const allowed = ["MessageList.tsx", "TopBar.tsx"]; // NameButton (forwardRef popover trigger), title overlay button
    const offenders = walk(new URL("./app/", import.meta.url)).filter((p) => /<button\b/.test(readFileSync(p, "utf8")))
      .filter((p) => !allowed.some((a) => p.endsWith(a)));
    expect(offenders).toEqual([]);
  });
});
```

Run → FAIL with the current list.

- [ ] **Step 2: Replace raw controls**

Each raw `<button>` → `Button` with the closest variant (`ghost` for list rows and nav items, `link` for inline text actions) and `className` for layout; nav-style rows (settings nav, YouPage rows) use `Button variant="ghost" className={cn(NAV, "justify-start")}`; segmented choices (SearchChips, soundboard tabs) use `ToggleGroup`. Where a ref is needed for `asChild`, use `RefButton`. Raw ranges → `Slider` (`value={[v]} onValueChange={([x]) => set(x)}`, `aria-label` on the `Slider` — the local component puts it on the thumb). Run the test → PASS.

- [ ] **Step 3: Small fixes**

- Sidebar rhythm: DM rows `p-2` with a 40 px avatar → `px-2 py-1.5` with `UserAvatar size="sm"` (32 px; check sizes in `user-avatar.tsx`) and `min-h-11`; member rows `min-h-11` with 32 px avatars; channel rows stay `py-1.5` (32 px).
- `ProfileStrip.tsx`: wrap the name in a `Tooltip` showing the full display name; give the name `min-w-0 flex-1 truncate` and the status line `truncate` so the icons never push the name out; change the "Set a status" hint to `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`.
- `ServerIcon` fallback: render initials (as `desktop/src/order.ts` `serverInitials` does — copy the 6-line helper into `src/lib/initials.ts` if the web app has none; `session.ts` exports `initials` — use that) in a `bg-card` square, never the image's alt text; render the `<img>` only after it loads (`onError` → fallback).
- Gallery Filter button: `aria-pressed={filtersOpen}` and, when filters are active, a `Badge` with the count (`<span className="sr-only"> active filters</span>`).
- Desktop drawer rows (`ServerDrawer.tsx:21`): use `buttonVariants({ variant: "ghost" })` classes plus `h-11 w-full justify-start gap-3 px-2`, keeping dnd-kit props; Remove server (`Chrome.tsx:82`): `className={buttonVariants({ variant: "destructive" })}` on `AlertDialogAction` instead of the inline classes.

- [ ] **Step 4: Typecheck, test, stage**

Run: `rtk pnpm --filter @datrope/web typecheck && rtk pnpm --filter @datrope/web test && rtk pnpm lint`
Suggested message: `refactor(web,desktop): shared controls and sidebar rhythm`.

---

### Task 28: Final Playwright pass, re-audit and manual checklist

**Files:**
- Modify: `e2e/desktop.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-14-desktop-ux-audit.md`

- [ ] **Step 1: Phase 3 e2e** (append)

```ts
test("shortcuts: sheet, channel switching, type to focus", async ({ page }) => {
  test.skip(width(page) !== 1440, "once");
  await page.locator("body").click({ position: { x: 600, y: 300 } });
  await page.keyboard.press("Control+/");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByRole("heading", { level: 1, name: /# random/ })).toBeVisible();
  await page.locator("body").click({ position: { x: 600, y: 300 } });
  await page.keyboard.type("h");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("h");
});

test("settings open as a page and Esc returns to chat", async ({ page }) => {
  test.skip(width(page) < 1024, "desktop settings");
  await page.getByRole("button", { name: /settings/i }).first().click();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
});
```

(Check the profile strip gear's accessible name and use it exactly.) Adjust the channel order expectation to the seeded server's order (`general` then `random` in `chat.spec.ts`).

- [ ] **Step 2: Full suite**

Run the e2e stack and `rtk playwright test`, `rtk pnpm -r test`, `rtk pnpm -r typecheck`, `rtk pnpm lint`, and `rtk cargo test` in `clients/desktop/src-tauri`.
Expected: all green.

- [ ] **Step 3: Re-audit**

Run `/impeccable audit` at 820, 1440 and 2560 px. Append "Re-audit after Phase 3" with the score (target ≥ 17/20) and any remaining findings.

- [ ] **Step 4: Manual checklist (desktop app)** — record results in the task report

- Windows: drag from each header band (sidebar header, chat top bar, docked members header, side panel header); double-click maximizes/restores; Minimize, Maximize/Restore, Close (hides to tray); Servers opens the full-height drawer; badge shows another server's mention; Update button appears when an update is ready (or simulate by setting `update_ready` in a debug build).
- An older server (check out `main` in a second worktree, run its web app on another port, add it): the 32 px shell bar stays and its buttons work.
- Theme: change server theme → drawer, Add server dialog, screen picker and offline page follow; a server without a theme shows the bundled colours.
- macOS (if available): traffic lights don't overlap the sidebar header (72 px inset). If Tauri 2.12 offers a runtime traffic-light position API (`set_traffic_light_position`), centre them in the 56 px band when a page claims the bar and restore on release; otherwise note it as a follow-up.
- Window < 768 px: phone layout, shell bar back.

- [ ] **Step 5: Stage and hand off**

Suggested message: `test: desktop UX final pass and re-audit`. Then use superpowers:finishing-a-development-branch.

