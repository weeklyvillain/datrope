# Desktop UX

Date: 2026-10-14
Status: approved design, pending plan
Audit: `docs/superpowers/specs/2026-10-14-desktop-ux-audit.md` (12/20, `/impeccable audit`)
Product context: `PRODUCT.md` (friend groups; cozy, quick, unfussy; WCAG 2.2 AA)
Companion: `docs/superpowers/specs/2026-10-12-mobile-ux-design.md` (phone layout; unchanged by this spec)
Mockups: shown in chat on 2026-10-14 (A classic tuned, B unified inspector, C focus); **A chosen**.

## Goal

Make the desktop experience (web client at ≥ 768 px with a fine pointer, and the Tauri desktop app)
hold up at every window size and from the keyboard, with one coherent set of chrome. Fixes and
polish: the layout stays recognisably the same (direction A). Scope: every audit finding, P0–P3.

- Narrow (snapped, 768–1279 px) windows keep a usable chat column; wide windows keep readable lines.
- Every action is reachable by keyboard; focus is never lost; screen readers get concise output.
- The desktop app shows one title bar, not two, and its bundled screens follow the server's theme.
- Long sessions stay fast: messages, members and gallery are virtualized.

Out of scope: the phone layout (< 768 px), resizable panels, a unified right "inspector" (direction
B), an icon-strip/centred layout (direction C), new product features beyond keyboard shortcuts and
the shortcut sheet.

## Definitions

- **Desktop layout**: viewport ≥ 768 px (`!useIsMobile()`, `hooks/use-mobile.ts`). All rules below
  apply only there; the phone shell is untouched.
- **W**: viewport width. Tiers: **wide** W ≥ 1280, **medium** 1024 ≤ W < 1280, **narrow**
  768 ≤ W < 1024.
- **Slide-over**: a right-side shadcn `Sheet` over the chat (not beside it). **Left sheet**: the
  same from the left.
- **Shell bar**: the desktop app's own 32 px title bar (`clients/desktop/src/TopBar.tsx`).
  **Page bar**: the web app's 56 px `TopBar` (`app/TopBar.tsx`).

Paths are relative to `clients/web/src/` unless prefixed with `desktop/` (= `clients/desktop/`).

## Phase 1 — Window layout and keyboard

### 1.1 Layout tiers

| Tier | Channel sidebar | Member list / side panel | Page bar |
|---|---|---|---|
| wide | docked, 240 px | docked beside chat (240 px / 360 px) when open | search box 260 px; all buttons |
| medium | docked | hidden by default; opens as a slide-over | search box 200 px |
| narrow | collapsed; a **Channels** button at the left of the page bar opens it as a left sheet | slide-over | search becomes an icon button; Threads, Pins, Inbox move into a `⋯` overflow menu |

- New hook `hooks/use-layout-tier.ts` returns `"wide" | "medium" | "narrow"` from `matchMedia`
  queries (≥ 1280, ≥ 1024), alongside `useIsMobile`.
- The side panel still replaces the member list when docked (`ChannelView.tsx:157-165`); in slide-over
  tiers only one slide-over is open at a time (opening one closes the other).
- **Members toggle on desktop**: drop `md:hidden` on the Members button (`ChannelView.tsx:99`). State
  `membersOpen` persisted in `localStorage` per device (wrapped in try/catch), default `true`. In the
  wide tier it decides docked vs hidden; in medium/narrow it opens the slide-over and is not
  persisted as "open" (slide-overs always start closed).
- **Title never vanishes**: the page bar title gets `min-w-[12ch]` with truncation beyond; the
  button group and search shrink or move into `⋯` first. The message list never scrolls
  horizontally (`min-w-0` on the chat column; `overflow-x-hidden` on the scroller; embeds and code
  blocks scroll inside themselves).
- `SearchBox` (`app/search/SearchBox.tsx:50`) width follows the tier; in narrow it is an icon button
  that opens the search side panel with the input focused.
- Slide-overs and the left sheet use shadcn `Sheet` (already present) and therefore Radix focus
  management: focus moves in on open, returns to the trigger on close, Esc closes, Tab is contained.
  The existing `max-[900px]:fixed` overlay in `side-panel/SidePanel.tsx:23` is replaced by this rule.
- History: slide-overs and the left sheet use `hooks/use-history-layer.ts` as on phones, so browser
  back closes them.

### 1.2 Wide screens

- Message text blocks (`.message-content` paragraphs, lists, quotes) get `max-w-[80ch]`. Rows, hover
  backgrounds, embeds, attachments, and the composer stay full width.
- Forum post bodies and the welcome page get the same 80ch cap on prose.

### 1.3 Message list keyboard model

- The message scroller is one Tab stop: a roving tabindex over `<article>` rows
  (`MessageList.tsx:474`). The last-focused (default: newest) message holds `tabIndex=0`; others
  `-1`. Every message, including grouped continuations, is focusable.
- Keys on a focused message:

  | Key | Action |
  |---|---|
  | ↑ / ↓ | previous / next message |
  | Home / End | oldest / newest loaded message |
  | Enter | open the message actions menu (same items as the context menu) |
  | R | reply |
  | E | edit (own messages) |
  | T | start / open thread |
  | P | pin / unpin (with permission) |
  | + | open the reaction picker |
  | Delete | delete (own or with permission), opens the confirm dialog |
  | Shift+F10 / ContextMenu | context menu |
  | Esc | return focus to the composer |

  Letter keys act only when the message row itself has focus (not a child control) and no modifier
  is held.
- A focused message shows its `MessageToolbar` (`group-focus-within` already covers it once the row
  is focusable) with a visible focus ring on the row.
- Messages that can't be acted on (deleted, failed, system) are focusable but their action keys are
  no-ops; failed messages keep their retry button.

### 1.4 Focus return

- Delete → Cancel: focus returns to the message row. Delete → Confirm: focus moves to the next
  message, else the previous, else the composer.
- Edit end (Esc or save, `MessageList.tsx:537-547`): focus returns to the message row.
- Context menus (`MessageList.tsx:599`, `sidebar/ChannelTree.tsx:404`, `ServerSidebar.tsx:120`,
  `MemberList.tsx:89`, `sidebar/CategoryHeader.tsx:57`): drop the blanket
  `onCloseAutoFocus={e => e.preventDefault()}`; prevent only when closing because an item opened a
  dialog or moved focus itself (e.g. Reply focuses the composer).
- Side panel (`side-panel/SidePanel.tsx`): on open, focus the panel heading (`tabIndex=-1`); on close,
  return focus to the opener (stored when opening); Esc closes when focus is inside the panel.

### 1.5 Shell landmarks and lists

- Skip links as the first focusable elements in `AppShell.tsx`: "Skip to messages" (focuses the
  roving message) and "Skip to composer". Visible on focus only.
- The channel name heading becomes `<h1>` (`ChannelView.tsx:121`, `DMView`, gallery, forum,
  settings headers); panel titles stay `<h2>`.
- Channel tree (`sidebar/ChannelTree.tsx`): ARIA `tree` / `treeitem` / `group` with roving focus.
  ↑/↓ move, → expands a category or moves into it, ← collapses or moves to the parent, Enter opens,
  Home/End first/last. The row's gear button stays a separate control reachable via Tab from the
  focused row (Radix-style "Tab into row actions" is not used; the gear is also in the row's
  `⋯`/context menu).
- DM list, member list, gallery tiles: roving focus with ↑/↓ (lists) or arrow keys (grid); Enter
  opens; the row's `⋯` menu is reachable with Shift+F10 or Tab.
- `voice/CallControls.tsx:29,63`: implement roving focus with ←/→ to match `role="toolbar"`.

### 1.6 Keyboard routes to right-click-only actions

- Message actions menu (Enter or toolbar `⋯`): add Copy text and Add to album
  (`MessageList.tsx:606-614`).
- Channel row `⋯` menu (and the tree's Shift+F10): Mark as read, Copy link, Move up/down
  (`ChannelTree.tsx:405-421`).
- Member row: Copy user ID in the profile popover's `⋯` (`MemberList.tsx:97`).

### 1.7 Screen reader output

- The message log (`MessageList.tsx:280`) gets `aria-live="off"`; a separate visually hidden
  `role="status"` region announces new incoming messages (not own, not history loads) as one line:
  `"{author}: {first 100 chars of plain text}"`, plus `"and N more"` when several arrive within
  1 s. Muted channels and channels not in view are not announced.
- Each `<article>` gets `aria-labelledby` pointing at a hidden summary `"{author}, {time}"` and
  `aria-describedby` at its text; reactions, edited marker and embeds stay reachable inside but are
  not part of the name.

### 1.8 Contrast tokens (`styles.css`)

- `--input` (form control borders) raised to ≥ 3:1 against `--card` and `--background`
  (≈ `#6b6b6b`); `--border` stays for dividers.
- Focus ring: solid `--ring` (drop `/50`) in `components/ui/button.tsx` and every component that
  uses `ring-ring/50`.
- `--destructive` lightened to reach ≥ 4.5:1 on `--card` and `--popover`.
- Offline member rows: `text-muted-foreground` on name and secondary line instead of `opacity-50`
  (`MemberList.tsx:77`); avatar keeps reduced opacity.
- `text-muted-foreground` is not placed on `--secondary`; where it is today, use `--foreground`.
- `styles.test.ts` asserts the token pairs above.

## Phase 2 — Desktop app chrome and messages

### 2.1 Merged title bar (Tauri)

- **Capability handshake**: the web app calls a new bridge method `desktop.claimTitleBar()` →
  command `desktop_title_bar { claimed: true }` once the shell is mounted in desktop layout. The shell
  then hides the shell bar for that server webview (its page rect becomes the whole window). When the
  page goes to phone layout (window < 768 px) it releases (`claimed: false`). Servers whose web app
  never claims keep today's layout, so older servers keep working.
- Shell bar stays for: no servers yet, add-server/remove dialogs (Full mode), offline pages, and any
  server that hasn't claimed.
- **Page bar in the desktop app** (`app/TopBar.tsx`, only when `desktop` is non-null and claimed):
  - Left: Servers button (opens the drawer) with the other-servers badge. The shell emits
    `desktop://others-badge { unread, mentions }` to server webviews; badge text for screen readers
    as today (`desktop/src/TopBar.tsx`).
  - Right: Update button when the shell emits `desktop://update-ready`, then Minimize,
    Maximize/Restore, Close (44 × 32 visual, full bar height hit area, red hover on Close), hidden on
    macOS.
  - Empty bar regions are a drag region: `pointerdown` (primary button, not on an interactive
    element) → `desktop_start_drag`; `dblclick` → `desktop_window { action: "toggle_maximize" }`.
  - macOS: 72 px left inset; traffic lights repositioned to the vertical centre of the 56 px bar
    (`traffic_light_position`), restored when the shell bar is shown.
- **Commands** (Rust, `desktop/src-tauri/src/commands.rs`), allowed for `server-*` webviews via a new
  capability, rate-limited with the existing `RateLimiter`:
  - `desktop_window { action: "minimize" | "toggle_maximize" | "close" }` (close keeps today's
    close-to-tray behaviour);
  - `desktop_start_drag`;
  - `desktop_title_bar { claimed: bool }`;
  - `desktop_set_theme { tokens: Record<string, string> }` (see 2.2).
  Server webviews do **not** get `core:window:*` permissions.
- **Maximized state**: the shell emits `desktop://maximized { maximized }` so the page bar shows
  Restore vs Maximize.
- **Drawer**: when the selected server has claimed, the drawer rect is full height from y = 0
  (`drawer_rect` in `shell.rs` takes the bar height as a parameter) and the drawer page gets a
  header row ("Servers" title + close button, 56 px).
- `layout_rects` in `shell.rs` takes the bar height (0 or 32) for the selected server; unit tests
  cover both.
- Removed from the shell bar: current server name and icon (still in the web sidebar header).

### 2.2 Theme sync to bundled screens

- The web app reads its resolved token values (the `:root` custom properties listed in
  `styles.css`, after `useTheme`/`usePalette`) and sends them with `desktop_set_theme` on load and
  whenever theme or palette changes. Values are validated in Rust (allowlisted token names, CSS
  colour syntax only, ≤ 64 entries).
- The shell forwards the selected server's tokens to the chrome, drawer, picker and offline webviews
  (`desktop://theme`), which set them on `document.documentElement.style`. Switching servers
  re-applies that server's tokens; servers that never send keep the bundled defaults.

### 2.3 Virtualized lists (`react-virtuoso`)

- Add `react-virtuoso` (exact version) to `clients/web/package.json`.
- **Message list** (`MessageList.tsx`): `Virtuoso` over the flattened item list (messages, day
  dividers, unread divider) with `firstItemIndex` for prepends, `followOutput` (smooth only when the
  user was at the bottom), `initialTopMostItemIndex` for the unread marker or a jump target, and
  `atTopStateChange`/`atBottomStateChange` for loading. Grouping (`:302`), highlight flash and
  jump-to-message keep their logic but work over items/indices.
  - The phone ResizeObserver pin-to-bottom (mobile spec 1.4) is replaced by Virtuoso's
    `followOutput`; the phone keyboard behaviour must stay identical.
  - Roving focus (1.3): the focused index is tracked in state; arrow keys call `scrollIntoView`
    on the target index before focusing. The focused item is kept rendered via `increaseViewportBy`
    and by not moving focus to an unrendered index.
- **Member list** (`MemberList.tsx:63-77`): `GroupedVirtuoso` with sticky group headers.
- **Gallery** (`gallery/GalleryView.tsx:206-216`): `VirtuosoGrid` replacing the sentinel.
- Emoji picker keeps its own windowing.

### 2.4 Scroll-based paging

- "Load older messages" / "Load newer" buttons (`MessageList.tsx:287,338`) are removed. Older loads
  start when the top is within one viewport; newer loads likewise at the bottom when not at present.
- While loading: 3 skeleton rows (avatar circle, name bar, two text bars) at that edge.
- When not at present: a "Jump to present" pill above the composer (Esc in chat does the same).
- Load errors: an inline "Couldn't load older messages. Retry" row at that edge.

### 2.5 Timestamps

- Group heads: `Today 08:33`, `Yesterday 21:10`, `9 Oct 2026 08:33` (locale-aware via
  `Intl.DateTimeFormat`, 24/12 h from locale). Tooltip and `<time dateTime>` carry the full date
  and time.
- Grouped continuation rows show `HH:MM` in the empty gutter (`MessageList.tsx:502`) on hover or
  focus, `text-muted-foreground`, caption size.
- Helper `lib/message-time.ts` with tests (today, yesterday, older, midnight boundaries, locale).

### 2.6 Lazy images

- `loading="lazy"` on album covers (`gallery/AlbumsView.tsx:77`), profile banners
  (`people/ProfileCard.tsx:73`), the emoji table (`server-settings/Emoji.tsx:120,167`) and viewer
  thumbnails (`attachments/ImageViewer.tsx:232`).

## Phase 3 — Polish and shortcuts

### 3.1 Shortcuts

| Shortcut | Action |
|---|---|
| Alt+↑ / Alt+↓ | previous / next channel (sidebar order, DMs within Messages) |
| Alt+Shift+↑ / ↓ | previous / next channel with unread |
| ↑ in empty composer | edit your last message in this channel |
| Esc in chat (no reply/edit/autocomplete open) | mark channel read and jump to present |
| Ctrl/Cmd+F | open search with the channel filter preset |
| Ctrl/Cmd+Shift+M | toggle mute |
| Ctrl/Cmd+Shift+D | toggle deafen |
| Ctrl/Cmd+/ | shortcut sheet |
| printable key with focus on nothing editable | focus the composer and insert the key |

- One registry `lib/shortcuts.ts` (id, keys, label, handler scope) drives the handlers, the
  shortcut sheet (a `Dialog` grouped by Navigation, Messages, Voice), tooltip key hints
  (`Kbd` component from shadcn), and palette entries.
- Shortcuts don't fire while an input, textarea, contenteditable, or open dialog/menu has focus,
  except Esc and Ctrl+K handling that already exists.
- Command palette (`palette/CommandPalette.tsx`) gains Mark as read, Leave voice, Toggle members,
  Keyboard shortcuts.
- Not active on touch-only devices or in the phone layout.

### 3.2 One settings layout

- User settings moves from `settings/UserSettingsDialog.tsx` to a full page using the server
  settings layout (`server-settings/ServerSettings.tsx`: 260 px nav, 860 px content, Esc and Back to
  chat). Extract the shared layout as `components/settings-layout.tsx`.
- Desktop route `/settings/:section`; existing entry points (profile strip gear, palette, `/you`
  redirect from the mobile spec) navigate there. Phone `/you` is unchanged.
- "Back to chat" uses `Button` (`ServerSettings.tsx:191`).

### 3.3 Loading and empty states

- Fetch shadcn `skeleton` and `empty`. Content-area "Loading…" text (29 places, e.g.
  `MessageList.tsx:269`, `gallery/MusicView.tsx:75`) becomes skeletons shaped like the content;
  `Spinner` remains for in-button and inline busy states.
- Shared empty states via `Empty` (icon, headline naming the space, one line, optional action) for:
  no DMs, no threads, no pins, empty channel (first message invitation), no search results, empty
  gallery / albums / playlists, no custom emoji. Copy is plain and friendly, e.g. "No pinned
  messages yet. Pin one from its menu to keep it here."

### 3.4 Type scale

- Tokens in `styles.css` `@theme inline`: `--text-caption` 11px, `--text-meta` 12px, `--text-ui`
  13px, `--text-body` 15px, `--text-title` 16px, `--text-heading` 20px (with line heights).
  Utilities `text-caption` … `text-heading`.
- Replace arbitrary sizes (`text-[10px]`…`text-[16px]`, ~51 uses) with the scale; 10 px uses become
  11 px. Phone `text-base` input rule (mobile spec 1.2) stays.

### 3.5 Motion

- Tokens `--dur-fast` 120ms, `--dur-base` 180ms, `--dur-slow` 240ms, `--ease-out`
  `cubic-bezier(0.22, 1, 0.36, 1)`; slide-overs and sheets use base.
- One `@media (prefers-reduced-motion: reduce)` block: Radix `data-state` animations (dialog, sheet,
  popover, dropdown, tooltip) become a fade at fast duration or none; `.message-flash` becomes a
  static highlight that fades; smooth scrolling off.

### 3.6 Component vocabulary and small fixes

- 45 raw `<button>`s → `Button` / `ToggleGroup`; 4 raw `type="range"` → `Slider`
  (`settings/AvatarCropDialog.tsx:84`, `voice/PersonMenu.tsx:62`, `voice/SoundboardPanel.tsx:233`,
  `voice/StageView.tsx:60`), keeping the AGENTS.md Slider `aria-label` rule.
- Sidebar rhythm: channel rows 32 px; DM and member rows 44 px with 32 px avatars
  (`DMList.tsx:38,43`, `MemberList.tsx:77`).
- Profile strip: full display name in a tooltip; status line doesn't squeeze the name; "Set a status"
  visible on `focus-visible` as well as hover (`ProfileStrip.tsx:39`).
- Server icon fallback shows initials, not clipped alt text (sidebar header).
- Gallery Filter button: `aria-pressed` and an active-filter count (`gallery/GalleryView.tsx:117`).
- Desktop: drawer rows (`desktop/src/ServerDrawer.tsx:21`) share row styles (hover, focus ring,
  44 px); Remove server uses `buttonVariants({ variant: "destructive" })`
  (`desktop/src/Chrome.tsx:82`).

## Architecture notes

- New in `clients/web/src`: `hooks/use-layout-tier.ts`, `hooks/use-roving-focus.ts` (lists, tree,
  toolbar), `lib/message-time.ts`, `lib/shortcuts.ts`, `components/settings-layout.tsx`,
  `components/shortcut-sheet.tsx`, `app/WindowControls.tsx` (desktop-app page-bar controls), shadcn
  `skeleton`, `empty`, `kbd`.
- `desktop.ts` gains `claimTitleBar`, `releaseTitleBar`, `windowAction`, `startDrag`, `setTheme`, and
  listeners for `others-badge`, `update-ready`, `maximized`.
- `clients/desktop`: new capability file for `server-*` window commands; `shell.rs` per-server bar
  height; drawer header; theme forwarding; `TopBar.tsx` unchanged apart from being hidden for
  claimed servers.
- Per AGENTS.md: fetch shadcn components before building, tokens only, dark-only, stable accessible
  names, `React.forwardRef` for `asChild` triggers, keep the local Button/Slider/Tooltip changes.

## Error handling and edge cases

- Resizing across tiers keeps state: an open docked member list becomes closed (slide-overs start
  closed); an open side panel becomes a slide-over with the same content.
- Crossing 768 px swaps to the phone shell as today; the page releases the title bar first, so the
  shell bar reappears.
- A server webview that claims and then crashes/reloads: the shell resets the claim on navigation
  start and waits for a new claim.
- Drag on a maximized window restores it under the cursor (Tauri default behaviour of
  `start_dragging`).
- Invalid theme payloads are dropped whole; the bundled defaults stay.
- Virtualized jump to a message not loaded: load around it (existing jump logic), then
  `scrollToIndex` with `align: "center"`.
- Shortcuts with IME composition active (`event.isComposing`) are ignored.
- Reduced motion also disables the smooth scroll on "Jump to present".

## Testing

- **Vitest**: `use-layout-tier` thresholds; `use-roving-focus` (arrow keys, Home/End, tree expand/
  collapse); message key handling and focus-return order; `message-time` formats; shortcut registry
  (scope, editable targets, IME); theme token validation shape; `styles.test.ts` contrast pairs.
- **Rust**: `layout_rects` and `drawer_rect` with bar height 0 and 32; theme payload validation;
  window action parsing.
- **Playwright** (desktop projects added at 820×700, 1100×800, 1440×900):
  - 820: Channels button opens the left sheet; title visible; no horizontal scroll in the message
    list; search icon opens search.
  - 1100: Members opens a slide-over; Esc closes it and focus returns to the button.
  - 1440: Members toggle hides/shows the docked list and persists across reload.
  - Keyboard only: skip link → messages; ↓ to a grouped continuation; R replies; Delete → Cancel
    returns focus to the message; side panel opens, Esc closes, focus returns.
  - Scrolling up loads older messages (no button); Jump to present appears and works.
  - Existing desktop and phone projects keep passing; tests that assumed all messages in the DOM
    scroll first.
- **Manual (desktop app)**: Windows — drag, double-click maximize, window buttons, close to tray,
  Servers drawer from the page bar, an older server falling back to the shell bar, theme sync to
  drawer/dialogs; macOS — traffic light position and fallback.
- **Re-audit**: `/impeccable audit` at 820, 1440 and 2560 px after each phase; target ≥ 17/20 after
  Phase 3.
