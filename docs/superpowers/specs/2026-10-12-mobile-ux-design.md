# Mobile UX

Date: 2026-10-12
Status: approved design, pending plan
Audit: `docs/superpowers/specs/2026-10-12-mobile-ux-audit.md` (13/20, `/impeccable audit`)
Product context: `PRODUCT.md` (friend groups; cozy, quick, unfussy; WCAG 2.2 AA)
Mockups: shown in chat on 2026-10-12 (message action sheet and swipe-to-reply; navigation A/B, B chosen;
You tab and voice/music mini bars; forum rows and gallery)

## Goal

Make the installed PWA feel native on phones across every view, not just usable. Scope "B": every
view gets the full phone treatment, including server settings, gallery, music and voice.

- No feature hides behind hover, right-click, drag or a keyboard shortcut.
- Phone navigation is a bottom tab bar with full-screen stacks; back always closes the top layer.
- Touch targets meet 44×44 px on touch devices; iOS never zooms on input focus.
- The app draws edge to edge, respects notches and the home indicator, and keeps the composer on
  top of the on-screen keyboard.

Desktop and mouse use (`pointer: fine`, ≥768 px) stays as it is: hover toolbar, sidebar, tab strips,
tables, Enter to send.

Out of scope: native apps, offline data, new features that do not exist on desktop (except the
on-screen push-to-talk button and Move up/down, which replace keyboard/drag-only interactions),
landscape-specific layouts beyond "nothing breaks", tablets beyond the existing ≥768 px desktop
layout.

## Definitions

- **Phone layout**: viewport < 768 px (existing `useIsMobile`, `hooks/use-mobile.ts`).
- **Touch**: `(pointer: coarse)`. Sizing and visibility rules key off touch (Tailwind
  `pointer-coarse:`), layout keys off phone width. A touch laptop at desktop width gets bigger
  targets but the desktop layout.

## Phase 1 — Foundation

Everything later builds on this. No visible redesign yet beyond sizes.

### 1.1 Touch sizing

- `components/ui/button.tsx`, `toggle.tsx`: under `pointer-coarse:`, every `icon*` size gets a 44 px
  hit area (`min-h-11 min-w-11`); text sizes `xs`/`sm`/default get `min-h-11`. Visual size of the
  glyph may stay smaller; the hit area grows (padding or an `after:` inset expander for buttons that
  sit in dense rows such as reaction pills and tile `⋯`).
- Rows: sidebar channel rows, voice member rows, list rows in sheets and settings get `min-h-11`
  under `pointer-coarse:`.
- Reaction pills: 44 px tall hit area on touch (visual 32 px).
- Keep the local `Button` changes listed in AGENTS.md.

### 1.2 Inputs

- 16 px text on phones for every text entry: `CommandInput` (`components/ui/command.tsx:73`),
  `NativeSelect` (`components/ui/native-select.tsx:19`), Composer textarea (measured 15 px live) and
  snippet filename (`app/Composer.tsx:192`), WelcomeEditor (`app/welcome/WelcomeEditor.tsx:122`),
  emoji/soundboard rename, webhook URL field. Pattern: `text-base md:text-sm` as in `input.tsx`.

### 1.3 Edge to edge and safe areas

- `index.html`: `viewport-fit=cover`, `interactive-widget=resizes-content`, status bar style
  `black-translucent`. (Supersedes the PWA spec's interim `default`.)
- Tokens in `styles.css` `@theme inline`: `--safe-top/right/bottom/left` =
  `env(safe-area-inset-*, 0px)`, with utilities `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe`.
- Applied to: top bars (TopBar, SidePanel header, full-screen dialog headers), bottom bars (tab bar,
  composer, mini bars when no tab bar, call controls), sheets (`components/ui/sheet.tsx` per side),
  full-screen dialogs (UserSettingsDialog, ImageViewer), toasts (`AppShell.tsx:80`), sticky save bars
  (RoleEditor). Padding goes on the bar itself, so bars grow into the inset; no padding on `body`
  (that overflowed full-height layouts; see PWA spec).
- Auth pages and NotAMember use `min-h-dvh` with safe padding instead of `min-h-screen`.

### 1.4 Keyboard

- Android: `interactive-widget=resizes-content` makes `dvh` shrink with the keyboard.
- iOS: `hooks/use-visual-viewport.ts` sets `--keyboard-inset` from
  `window.innerHeight - visualViewport.height - visualViewport.offsetTop` on `resize`/`scroll`;
  the app shell subtracts it (`h-[calc(100dvh-var(--keyboard-inset,0px))]`) so the composer sits on
  the keyboard and the top bar stays put.
- `MessageList` keeps the bottom pinned when its scroll container resizes while the user was at the
  bottom (ResizeObserver on the scroller), covering keyboard open, composer growth, reply bar and
  attachment chips.
- Dialogs get `max-h-[calc(100dvh-2rem-var(--keyboard-inset,0px))] overflow-y-auto` in the base
  `DialogContent`.
- EmojiPicker does not autofocus its search on touch (the keyboard would cover the grid).

### 1.5 Enter key

- Touch devices without a hardware keyboard: Return inserts a newline; the Send button sends.
  Rule, evaluated at keydown: touch-only = `matchMedia("(pointer: coarse)").matches &&
  !matchMedia("(any-pointer: fine)").matches`. Touch-only → plain Enter inserts a newline.
  Otherwise (mouse, trackpad, or a touch device with a fine pointer attached) Enter sends and
  Shift+Enter inserts a newline, as today. Ctrl/Cmd+Enter sends in both cases.
- Applies to Composer, message edit (`MessageList.tsx:483`) and gallery comments
  (`GalleryItemPanel.tsx:223`). `enterKeyHint="send"` stays off on touch (so the key reads "return").

### 1.6 Back button and history

- Every layered phone surface is a history entry: side panels (`side-panel/panel.ts` gets a
  `?panel=` search param instead of store-only state), sheets (action sheet, members, profile,
  reactors), full-screen dialogs (settings), the full-screen player and call screen.
- Helper `hooks/use-history-layer.ts`: `open()` pushes a state entry tagged with the layer id;
  `popstate` with that tag gone closes the layer; closing via UI calls `history.back()` when the top
  entry is ours. Desktop uses the same helper (harmless: back closes a panel there too).

### 1.7 Scrolling and touch behaviour

- `overscroll-behavior-y: contain` on every scroll container (message list, sidebar/lists, sheets,
  settings, gallery); `overscroll-behavior: none` on `html, body`.
- Message rows: `-webkit-touch-callout: none` and `select-none` on touch only while long-pressing
  (selection still possible via Copy text); channel rows: `-webkit-touch-callout: none`.
- `touch-action: pan-y` on message rows (horizontal swipe-to-reply handled by us).

### 1.8 Hover-only and tooltip-only content

- All `opacity-0 group-hover` action buttons get `pointer-coarse:opacity-100` (existing pattern):
  gallery FileTile play and `⋯` (`gallery/FileTile.tsx:87,91`), category `⋯`
  (`sidebar/CategoryHeader.tsx:38`), playlist track `⋯` (`voice/PlaylistsTab.tsx:258`).
- VideoPlayer: on touch, tap toggles controls visibility (not play/pause); controls auto-hide after
  3 s of playback; volume slider always shown when controls are.
- Tooltip-only information gets a touch path: who reacted (long-press pill → reactors sheet,
  Phase 2), connection stats (tap the indicator → popover), disabled reasons (render the reason as
  inline helper text under the control on touch).

### 1.9 Ordering without drag

- Channel tree and playlist: "Move up" / "Move down" items in the existing context and `⋯` menus.
- dnd-kit: add `TouchSensor` with `{ delay: 300, tolerance: 8 }` and keep PointerSensor for mouse;
  drag handles get `touch-action: none` only on the handle, never the whole row.

## Phase 2 — Phone shell and chat

### 2.1 Navigation: bottom tab bar

Phone layout replaces the drawer (`app/mobile-nav.tsx`) with a bottom tab bar (60 px + safe bottom):
**Server**, **Messages**, **Mentions**, **You**. Unread/mention badges on Server and Messages,
count on Mentions.

| Tab | Route (phone) | Root screen |
|---|---|---|
| Server | `/` | Server header (name, icon, menu) + channel tree (current `ServerSidebar` content), Gallery entry, voice members under voice channels |
| Messages | `/messages` | DM list |
| Mentions | `/mentions` | Mentions inbox (today a popover, `InboxButton.tsx`) as a page |
| You | `/you`, `/you/:section` | Profile + status header, settings list; sections open full-screen |

- Opening a channel, DM, gallery, album, forum post or settings section pushes a full-screen screen
  with a top bar back arrow. The tab bar is hidden on pushed screens and shown on tab roots.
- Desktop routes are unchanged. On desktop `/` still redirects to the last channel; on phones `/` is
  the Server tab root. `/mentions` and `/you` on desktop redirect to the current channel and open
  the inbox popover / settings dialog respectively.
- iOS edge swipe-back works through history (Phase 1.6); no custom edge gesture.
- Server settings on phones: `/server-settings` is a list of sections (grouped as today), each
  section full-screen; replaces the horizontal tab strip. User settings likewise under `/you`.

### 2.2 Conversation top bar

- 48 px + safe top: back arrow (44 px), channel/DM name (tap → channel info sheet: topic, pins,
  members, threads, notification level, settings), Search (44 px), `⋮` overflow (Threads, Pins,
  Members, Leave group).
- Desktop TopBar unchanged.

### 2.3 Message actions

- **Long-press (500 ms) on a message** opens a bottom action sheet (shadcn `Drawer`/vaul if
  available, else `Sheet side="bottom"`): quick reactions row (6 frequent/recent emoji + "more"
  opening the full picker in the sheet), then Reply, Start thread / Open thread, Edit (own),
  Copy text, Pin/Unpin, Add to album (when it has images), Delete (own or with permission), 48 px
  rows. The pressed message is shown above the sheet, lifted.
- **Swipe right** on a message past 64 px sets it as the reply target, with a reply icon revealed
  behind it and a light haptic (`navigator.vibrate(10)` where supported). Vertical scroll wins if
  the gesture starts vertical.
- The existing right-click `ContextMenu` stays for mouse; on touch Radix's long-press menu is
  replaced by the sheet.
- **Reactions**: tapping a pill toggles it; long-pressing opens a sheet listing who reacted per
  emoji. The add-reaction pill is shown on touch only when reactions exist (as today); the first
  reaction comes from the action sheet.
- Hover toolbar (`MessageToolbar`) is unchanged on `pointer: fine`.

### 2.4 Composer

- 44 px attach, emoji, send buttons; the textarea is a rounded field at 16 px; code-block button
  moves into the attach menu on phones (attach menu: Upload file, Code snippet, GIF, Poll).
- Reply/edit banner with a 44 px cancel; attachment chips with 44 px remove targets.
- Mention autocomplete renders above the composer within the visual viewport.

### 2.5 Voice and music on phones

- **Mini bars** above the tab bar (or above the composer on pushed screens): voice bar (channel,
  participant count, mute, disconnect) and music bar (title, play/pause, close). When both are
  active on a pushed screen they collapse into one 56 px row (voice left, music right).
- Tap voice bar → full-screen call screen: 2-column video grid, speaker view on tap, call controls
  48 px in one row with overflow `⋯` for less common controls, chat as a pushed screen.
- Tap music bar → full-screen player: art, title, seek, prev/play/next, shuffle/repeat, queue (with
  Move up/down), close. Replaces the trimmed `PlayerBar` on phones.
- Screen share hidden when `navigator.mediaDevices.getDisplayMedia` is missing.
- Push-to-talk on touch: a large hold-to-talk button in the call screen and on the voice mini bar
  (pointerdown → talk, pointerup/cancel → stop). Keyboard PTT unchanged.
- Fullscreen button hidden where `requestFullscreen` is unavailable (iOS).

## Phase 3 — Remaining surfaces

- **Forum** (`forum/ForumView.tsx`, `PostRow.tsx`): two-line rows on phones (title; tag, author,
  replies, age); search and sort behind a filter button opening a sheet; floating "New post" button
  (48 px + safe bottom).
- **Gallery** (`gallery/*`): compact header (back, title, search, filter), full-width segmented
  control (All files / Albums / Music), type chips in one horizontally scrollable row, channel and
  uploader filters in a filter sheet; 2-column grid; tile `⋯` visible on touch, long-press → action
  sheet with the same actions; albums and playlists grids at 2 columns (`minmax(150px,1fr)`).
- **Image viewer**: pinch-zoom and double-tap zoom via pointer events (two pointers), swipe
  left/right between images, swipe down to close; toolbar buttons 44 px.
- **Admin tables** (Members, Bans, Invites, SignUps, Sessions): on phones render as stacked rows
  (primary line, secondary line, `⋯` actions) instead of a sideways-scrolling table.
- **Roles editor**: list → full-screen editor on phones; sticky save bar with safe bottom.
- **Popovers with fixed widths** (EmojiPicker, Soundboard, ProfilePopover, QueuePopover): render as
  bottom sheets on phones.
- **Command palette**: reachable from the phone search screen ("Commands" entry) and from the Server
  header menu.
- **Welcome page**: `px-4` on phones; channel cards 1 column (unchanged), editor already stacks.
- **Announcements**: unchanged beyond Phase 1/2.

## Architecture notes

- New shared pieces (all in `clients/web/src`):
  - `hooks/use-history-layer.ts` — history-backed open/close for layers.
  - `hooks/use-visual-viewport.ts` — `--keyboard-inset`.
  - `hooks/use-long-press.ts` — 500 ms, cancels on move > 8 px or scroll; exposes handlers for rows.
  - `hooks/use-swipe-reply.ts` — horizontal swipe with threshold and axis lock.
  - `components/action-sheet.tsx` — bottom sheet built on shadcn `Drawer` (vaul) if added via the
    CLI, otherwise `Sheet side="bottom"`; 48 px rows, safe bottom, history layer.
  - `app/mobile/` — `TabBar.tsx`, `MobileShell.tsx` (tab roots vs pushed screens), `ScreenHeader.tsx`
    (back + title + actions), `MiniBars.tsx`, `CallScreen.tsx`, `PlayerScreen.tsx`,
    `MentionsPage.tsx`, `YouPage.tsx`, `SettingsList.tsx`.
- `AppShell.tsx` picks `MobileShell` on phone layout; existing views (ChannelView, DMView, gallery,
  forum, settings sections) render inside it unchanged where possible, with phone-only branches for
  their headers.
- Per AGENTS.md: fetch shadcn components before building (`drawer`, `toggle-group` if needed), use
  tokens only, dark-only, keep accessible names stable, `React.forwardRef` for `asChild` triggers.
- Accessible names of existing controls stay; new controls get explicit labels ("Back", "Open
  channel info", "More actions", "Hold to talk", tab names).

## Error handling and edge cases

- Long-press vs scroll: long-press cancels on > 8 px movement or scroll start; swipe-reply locks to
  the first dominant axis.
- Messages that can't be acted on (deleted, failed, system) open no sheet; failed messages keep
  their retry affordance.
- History layers survive reload as plain routes for screens and `?panel=` for panels; sheets do not
  survive reload (they close).
- Rotation/resize across 768 px swaps shells without losing the current route.
- Hardware keyboard on a touch device (iPad with keyboard): `any-pointer: fine` keeps Enter to send.
- Reduced motion: sheet/screen transitions become fades; swipe follows the finger without a
  spring-back animation.

## Testing

- **Vitest**: `use-long-press`, `use-swipe-reply` (thresholds, axis lock, cancel), `use-history-layer`
  (push/pop/close order), Enter-key rule, keyboard-inset computation, admin rows render, tab routing
  (phone `/` vs desktop `/`).
- **Playwright** projects added: `iPhone 14` and `Pixel 7` device emulation:
  - tab bar navigation and badges; opening a channel hides the tab bar; back returns to the tab root
  - long-press a message → action sheet → add first reaction; long-press a pill → reactors
  - swipe right → replying banner
  - Return inserts a newline on touch; Send sends a multi-line message
  - browser back closes the thread panel before changing route
  - server settings list → section → back
  - forum rows readable (title fully visible for a short title), gallery tile `⋯` visible
  - a size check: key controls (tab bar items, top bar buttons, composer buttons, sheet rows) have
    bounding boxes ≥ 44 × 44
  - desktop project unchanged (existing suite passes)
- **Manual** (real devices): iOS standalone and Android installed app — safe areas on notch and
  home indicator, keyboard open/close with composer pinned, swipe-back, pinch-zoom, hold-to-talk,
  mini bars, no input zoom.
- **Re-audit**: `/impeccable audit` at 375 px after each phase; target ≥ 17/20 after Phase 3.
