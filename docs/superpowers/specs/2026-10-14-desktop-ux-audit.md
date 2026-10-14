# Desktop UX audit (≥768px, mouse and keyboard)

Date: 2026-10-14
Method: `/impeccable audit` — live walkthrough of the dev instance at 820×700, 1440×900 and 2560×1200
(measured widths and hit areas in the DOM), plus two code sweeps (keyboard/screen reader; layout,
consistency, performance) over `clients/web` and `clients/desktop`. Paths are relative to
`clients/web/src/` unless prefixed with `desktop/`.
Companion to `2026-10-12-mobile-ux-audit.md`; phone/touch issues are out of scope here.

## Health score

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 2 | Grouped messages' actions unreachable by keyboard; focus lost after dialogs, edit, side panel; no skip link |
| 2 | Performance | 2 | Message list, member list and gallery not virtualized; button paging for history |
| 3 | Responsive (desktop widths) | 2 | Chat column crushed to ~290px at 768–1000px; header overflows; unbounded line length on wide screens |
| 4 | Theming | 3 | Tokens used consistently; input borders and focus ring below 3:1; Tauri chrome ignores server theme |
| 5 | Anti-patterns | 3 | Calm, familiar; inconsistent settings shells, off-scale type sizes, bare "Loading…" text |
| | **Total** | **12/20** | **Acceptable — significant work needed** |

Anti-patterns verdict: not AI slop. It reads as a solid Discord-familiar app whose layout was tuned
for one window size (≈1440px) and whose keyboard path was never walked end to end.

## P0 — blocks a task

1. **Chat column crushed on narrow desktop windows.** Sidebar `w-60` (`app/ServerSidebar.tsx:48`) +
   fixed 240px member list hidden only below 760px (`app/MemberList.tsx:60`) leave ~290px at 768px.
   The TopBar's fixed 260px search (`app/search/SearchBox.tsx:50`) plus Threads/Pins/Inbox push the
   channel title to nothing; the message list scrolls sideways (seen live at 820px).
   Snapped half-screen windows are unusable.
2. **Member list can't be hidden on desktop.** The Members toggle is `md:hidden`
   (`app/ChannelView.tsx:99`); the list only goes away when a side panel replaces it
   (`ChannelView.tsx:157-165`).
3. **Grouped messages' actions unreachable by keyboard.** `MessageToolbar` is `hidden` until
   `group-hover`/`group-focus-within` (`app/MessageToolbar.tsx:27`); the `<article>` has no tabIndex
   (`app/MessageList.tsx:474`), avatar is `tabIndex={-1}` (`:503`), continuation rows render an empty
   `<span />` gutter (`:502`). A continuation message without a link/reaction has nothing focusable:
   no Reply/Edit/Delete/Pin/React, no Shift+F10.

## P1 — major difficulty / WCAG 2.2 AA

- **Side panel squeeze and no focus management.** `SidePanel` is fixed `w-[360px]`, overlay only
  below 900px (`app/side-panel/SidePanel.tsx:23`): at 901px chat ≈ 300px. Focus doesn't move in on
  open or back on close, Esc doesn't close it, the 768–900px overlay doesn't contain focus. No panel
  is resizable.
- **Unbounded line length on wide screens.** No max-width on message rows or composer
  (`MessageList.tsx:280,496`, `Composer.tsx:174`): ~260 characters per line and a 1880px composer at
  2560px (measured). Forum and gallery uncapped too.
- **Focus lost after actions.** Delete → Cancel returns focus to a toolbar button that is
  `display:none` again → `<body>` (`MessageList.tsx:623`); edit textarea unmounts on Esc/save
  without restoring focus (`:543`); all context menus `preventDefault` `onCloseAutoFocus`
  (`MessageList.tsx:599`, `sidebar/ChannelTree.tsx:404`, `ServerSidebar.tsx:120`,
  `MemberList.tsx:89`, `sidebar/CategoryHeader.tsx:57`).
- **No skip link**; sidebar `<nav>` precedes `<main>` (`app/AppShell.tsx:85-107`), so reaching the
  composer means tabbing through every channel, voice member and footer control.
- **Right-click-only actions**: message Copy text, Add to album (`MessageList.tsx:606-614`); channel
  Mark as read, Copy link, Move up/down (`ChannelTree.tsx:405-421`); member Copy user ID
  (`MemberList.tsx:97`).
- **Noisy live region.** `role="log"` (`MessageList.tsx:280`) reads whole articles (header, time,
  edited, reactions, embeds) and whole pages on "Load older/newer".
- **Contrast**: input/border `#424242` is 1.7–1.85:1 against card/background (1.4.11 needs 3:1);
  focus ring `ring-ring/50` ≈ 3.0:1 (borderline); `--destructive` on card 4.46:1; offline member
  rows `opacity-50` → 3.3:1 name, 2.5:1 secondary (`MemberList.tsx:77`); muted-foreground on
  `--secondary` 3.7:1.
- **Chrome stacks and mismatches (Tauri).** `desktop/src/TopBar.tsx:26` is `h-8 bg-sidebar`
  (#0d0d0d) directly above the web TopBar `min-h-14 bg-topbar` (#1c1c1c): 88px of chrome in two
  tones. The chrome webview only loads bundled `styles.css` (`desktop/src/rail.css:1`), so per-server
  themes/palettes (`theme/themes.ts:64`) never reach it.
- **No virtualization.** Messages render every loaded item (`MessageList.tsx:297`) with manual
  "Load older/newer" buttons (`:287`, `:338`); member list (`MemberList.tsx:63-77`) and gallery
  (`gallery/GalleryView.tsx:206-216`) unwindowed.

## P2 — annoyance, workaround exists

- **Grouped messages show no time**, not even on hover (`MessageList.tsx:502`). Every group head
  shows a full `DD/MM/YYYY, HH:MM` stamp, noisy for today's messages.
- **Two settings shells.** User settings: modal ≤1000×85vh, 220px nav
  (`settings/UserSettingsDialog.tsx:25`). Server settings: full page, 260px nav, 860px content
  (`server-settings/ServerSettings.tsx:148,202`), raw `<button>` Back (`:191`).
- **Loading = "Loading…" text** in 29 places (e.g. `MessageList.tsx:269`, `gallery/MusicView.tsx:75`);
  no Skeleton; Spinner in ~8 files.
- **Empty states** are bare text with padding from p-2 to p-8 (`DMList.tsx:62`,
  `side-panel/ThreadsList.tsx:36`, `PinsPanel.tsx:53`, `MessageList.tsx:296`); only the forum teaches.
- **Few shortcuts, no help sheet.** Exist: Ctrl+K, Ctrl+E, Esc (reply/edit/settings), viewer/player
  keys, PTT. Missing: Alt+↑/↓ channel, Alt+Shift+↑/↓ unread, ↑ to edit last, Esc mark read/jump to
  present, type-to-focus composer, Ctrl+F search, Ctrl+/ help, mute/deafen. Palette lacks
  Mark as read / Leave voice.
- **No roving tabindex** in channel tree, DMs, members, gallery tiles; `role="toolbar"` without
  arrow keys (`voice/CallControls.tsx:29,63`).
- **Reduced motion** covers only vaul (`styles.css:196`); `.message-flash` and Radix
  dialog/sheet/popover animations aren't covered; durations 75–500ms, no token.
- **Sidebar row heights differ**: DM ~56px (`DMList.tsx:38`), channel ~32px
  (`sidebar/ChannelTree.tsx:392`), member two-line (`MemberList.tsx:77`).
- No `<h1>` in the shell (channel name is `<h2>`, `ChannelView.tsx:121`); message scroller not
  focusable (`MessageList.tsx:280`); gallery Filter lacks `aria-pressed`/count
  (`gallery/GalleryView.tsx:117`).
- Footer username truncates at 1440px ("desk_a…"); server icon falls back to clipped text "Spac".

## P3 — polish

- 45 raw `<button>`s across ~25 files; 4 raw range inputs despite `ui/slider.tsx`.
- Off-scale type: `text-[13px]` ×22, `[15px]` ×9, `[16px]` ×7, `[10px]` ×7, `[11px]` ×6.
- Desktop drawer rows hand-rolled (`desktop/src/ServerDrawer.tsx:21`); Remove server overrides
  `AlertDialogAction` with inline destructive classes (`desktop/src/Chrome.tsx:82`).
- Missing `loading="lazy"`: album covers, profile banners, emoji table, viewer thumbnails.
- "Set a status" hint hover-only (`ProfileStrip.tsx:39`).

## Patterns & systemic issues

- Layout is fixed-width columns with single-breakpoint hides; nothing adapts between 768 and 1200px
  and nothing caps above 1600px.
- Keyboard path relies on hover reveals and Radix defaults; focus return was never designed.
- Two theming worlds: web app (server theme + palette) vs Tauri chrome (bundled defaults).
- Type, loading and empty states lack shared primitives.

## Positives

- Tokens everywhere; zero Tailwind palette colours outside `components/ui`; hex only as data.
- Icon buttons labelled consistently; `role="log"`, `nav`, `main`, `aside` landmarks present.
- Message grouping logic solid (author, <5 min, breaks on reply/day/unread); clear day and
  New-messages dividers.
- Top bars a consistent 56px across web views.
- Tauri TopBar well built (shadcn buttons, 44×32 window controls, drag region, SR badge text);
  offline page with backoff and `role=alert`; AddServerDialog accessible.
- Side panel replaces the member list rather than stacking a third column; emoji picker windowed.

## Recommended actions

1. **[P0] `/impeccable adapt`** — desktop shell between 768 and 1200px: collapsible member list,
   panel overlay rules, header that degrades (search → icon).
2. **[P0/P1] `/impeccable harden`** — keyboard path: focusable messages, focus return, side-panel
   focus/Esc, skip link, keyboard routes to right-click actions, live region.
3. **[P1] `/impeccable layout`** — reading width cap, unified chrome (Tauri + web top bars), settings
   shell, sidebar row rhythm, grouped-message hover time.
4. **[P1] `/impeccable optimize`** — virtualize messages/members/gallery; scroll-based paging.
5. **[P1] `/impeccable colorize`** — border/input and focus-ring contrast tokens; offline rows;
   destructive; pass server theme to Tauri chrome.
6. **[P2] `/impeccable typeset`** — collapse arbitrary sizes onto a scale.
7. **[P2] `/impeccable onboard`** — skeletons and teaching empty states.
8. **[P2] `/impeccable animate`** — motion tokens, reduced-motion coverage.
9. **`/impeccable polish`** — final pass; re-audit at 820, 1440 and 2560px, target ≥ 17/20.

## Re-audit after Phase 3

Date: 2026-10-14
Method: same as above. Headless Playwright walkthrough of the dev web server (signed in as `desk_audit`) at 820×700,
1440×900 and 2560×1200, measuring layout in the DOM, driving the keyboard path (Tab → skip link → Enter → row →
Enter → Esc), and recomputing token contrast; plus code greps for virtualization, `Loading…`, arbitrary type
sizes and reduced-motion coverage. The seeded channel only holds short messages, so the 80ch cap was confirmed in
code and its unit test (`MessageList.tsx:831`, `styles.test.ts`), not by measuring a long line. Tauri-only
behaviour (window buttons, drag, drawer, chrome theming) is not covered here; see the manual checklist in the
task 28 report.

### Health score

| # | Dimension | Before | After | Key finding |
|---|---|---|---|---|
| 1 | Accessibility | 2 | 3 | Skip link, focusable rows, Enter opens actions, focus returns to the row, `h1` per view, shortcut sheet (Ctrl+/) all verified live. Remaining: border contrast, `muted-foreground` on `secondary` 3.66:1 |
| 2 | Performance | 2 | 4 | Messages, members and gallery virtualized (grep); 13-21 rows in the DOM, no "Load older" button after scrolling to the top |
| 3 | Responsive (desktop widths) | 2 | 4 | 820px: chat column 820 (sidebar is a sheet), header and list overflow 0, no sideways scroll at any width; prose capped at 80ch, composer 608/763/1883px |
| 4 | Theming | 3 | 3 | Input border now 3.20:1 (card) / 3.49:1 (background), ring 8.1:1, destructive 5.09:1. Decorative `--border` still 1.70/1.85:1; chrome theming unverified without the Tauri window |
| 5 | Anti-patterns | 3 | 3 | Type scale mostly tokenized (computed sizes 15/13.125/11.25/11px); `Loading…` text still in 10 files; a few arbitrary sizes left (`text-[16px]` ×5, `[9px]` ×1) |
| | **Total** | **12/20** | **17/20** | **Good, meets the ≥17 target** |

### What is fixed

- P0 chat column crush, member list toggle, and unreachable grouped-message actions: all gone (820px measured, rows tabbable).
- Skip link present at all three widths; keyboard path reaches a row, Enter opens the menu, Esc returns focus to the row.
- Line length capped; no sideways scroll or header overflow at 820, 1440 or 2560.
- Virtualization and scroll-based paging; shortcut sheet and channel/unread shortcuts (e2e covered).
- Input and focus-ring contrast above 3:1; destructive above 4.5:1.

### Remaining findings

- **P2** `--border` (#424242) is 1.70:1 on card and 1.85:1 on background. Acceptable for decorative dividers; component borders should use `--input`.
- **P2** `muted-foreground` on `--secondary` is 3.66:1 (below 4.5:1 for small text).
- **P2** `Loading…` text remains in 10 files; skeletons exist only in some (DMList, forum, gallery).
- **P3** Footer username truncates at 1440 and 2560 (`desk_audit`: 57px box, 63px content).
- **P3** Arbitrary type sizes left: `text-[16px]` ×5, `[17px]` ×2, `[9px]` ×1, plus display sizes.
- **Unverified** Tauri window behaviour, chrome theming, macOS traffic lights, older-server fallback.
