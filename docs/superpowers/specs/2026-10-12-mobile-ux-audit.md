# Mobile UX audit (375px, touch)

Date: 2026-10-12
Method: `/impeccable audit` — live walkthrough of a seeded dev instance at 375×812 (mobile emulation),
measured hit targets in the DOM, plus two code sweeps (touch/hover affordances; layout/keyboard).
Paths are relative to `clients/web/src/`.

## Health score

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 2 | Message actions unreachable by touch; reactor names only in tooltips |
| 2 | Performance | 3 | Not a mobile bottleneck; precache ~3 MB |
| 3 | Responsive | 1 | 30–32px targets everywhere, Enter-only newline, no keyboard/safe-area handling, broken forum rows |
| 4 | Theming | 4 | Tokens used consistently, dark-only |
| 5 | Anti-patterns | 3 | Calm, familiar product UI; desktop patterns squeezed onto phone (tab strips, tables) |
| | **Total** | **13/20** | **Acceptable — significant work needed** |

Anti-patterns verdict: not AI slop. It reads as a careful desktop app that shrinks rather than a phone app.

## P0 — blocks a task on phones

1. **No way to add the first reaction.** `MessageToolbar` (`app/MessageToolbar.tsx:27`) is `hidden` until
   `group-hover`/`group-focus-within`; never shown on touch. Long-press menu (`app/MessageList.tsx:552-574`)
   has Reply/Thread/Edit/Pin/Copy/Album/Delete but **no React**; the `+` pill (`chat/Reactions.tsx:46`) only
   exists once a reaction exists. Long-press itself is undiscoverable.
2. **Multi-line messages impossible.** Enter sends, Shift+Enter is newline (`Composer.tsx:294`,
   `MessageList.tsx:483`, `gallery/GalleryItemPanel.tsx:223`); phone keyboards' Return sends.
3. **Music player can't be closed or seeked on phones.** `player/PlayerBar.tsx:72-78` hides close, seek,
   queue, prev, shuffle, repeat, volume below md.
4. **Forum post list unreadable.** `forum/PostRow.tsx:16` fixed columns leave ~47px for titles.
5. **Gallery tile actions invisible.** `gallery/FileTile.tsx:87,91` (play, add to queue/playlist/album,
   go to message, download) are `opacity-0 group-hover`.
6. **Push-to-talk mode silences phone users.** Key-only (`voice/ptt.ts`); no on-screen talk button.

## P1 — major difficulty / WCAG 2.2 AA

- **Touch targets 24–32px** across TopBar, Composer (attach/code/emoji/send 30px measured; cancel reply,
  remove file 24px), ProfileStrip/VoicePanel, sidebar gear/category `…` (24px), reaction pills (26px),
  SidePanel close, media players. `components/ui/button.tsx` sizes top out at 40px.
- **iOS input zoom**: composer measured 15px live; `CommandInput`, `NativeSelect` (15 uses), WelcomeEditor
  (13px), Emoji/Soundboard rename, snippet filename are `text-sm`.
- **Keyboard**: no `visualViewport` / `interactive-widget`; message list doesn't stay pinned to bottom
  when keyboard opens or composer grows (`MessageList.tsx:179-190`); PlayerBar sits below composer.
- **Back button**: panels/sheets/dialogs don't push history (`side-panel/panel.ts`); Android back changes
  channel with the panel still open, or exits the app.
- **Hidden actions**: category `…` (`sidebar/CategoryHeader.tsx:38`), playlist track options
  (`voice/PlaylistsTab.tsx:258`, the only reorder fallback), video volume and controls while playing
  (`attachments/VideoPlayer.tsx:107-145`).
- **Info only in tooltips**: who reacted (`chat/Reactions.tsx:73`), connection stats, disabled reasons
  (soundboard, playlist, role editor).
- **Drag-only ordering**: channel/category order (`sidebar/ChannelTree.tsx:93-99`, PointerSensor only,
  competes with scroll); queue reorder unreachable on phone.
- **Screen share offered where unsupported** (`voice/VoicePanel.tsx:105-122`, no `getDisplayMedia` gate).
- **Command palette** has no touch entry (`palette/CommandPalette.tsx:48-56`).

## P2 — annoyance, workaround exists

- Settings (user + server) use horizontally scrolling tab strips; current section can be off-screen
  (seen live on Server settings → Members).
- Admin tables scroll sideways instead of reflowing (Members, Bans, Invites, SignUps, Sessions).
- Gallery header crushed at 375px (title "G…", tabs truncated); forum filter row orphans "Sort".
- Fixed-width popovers barely fit (EmojiPicker 352px with autofocus → keyboard, Soundboard 22rem,
  ProfilePopover 300px side=right, Queue w-80).
- Dialogs without `max-h` can be pushed off-screen by the keyboard (GoLive, 7TV, Poll, delete confirm).
- No `overscroll-behavior`; scroll chaining can rubber-band / pull-to-refresh.
- Channel rows are `<a>`: iOS long-press shows link preview instead of the context menu.
- Safe areas: none; deferred `viewport-fit=cover` needs insets on TopBar, composer, PlayerBar, sheets,
  side panels, full-screen dialogs, toasts, call controls.

## P3 — polish

- Image viewer: no pinch-zoom (single-pointer pan only).
- Fullscreen silently fails on iOS in StageView.
- Albums/playlists grids drop to 1 column at 375px (could be 2).

## What works

- Drawer navigation (`mobile-nav.tsx`) and full-screen side panels for threads/search/posts.
- Settings dialogs go full-screen on phones; dialogs respect `max-w-[calc(100%-2rem)]`.
- `pointer-coarse:opacity-100` already used in four places — the right pattern, just not everywhere.
- Gallery/music grids at 2 columns; emoji picker fits; call controls 48px.
- Consistent tokens, calm dark identity, stable accessible names.

## After (2026-10-13)

Re-audit after the mobile UX plan (`docs/superpowers/plans/2026-10-12-mobile-ux.md`), same method:
375×812, touch emulation, seeded instance, DOM measurements on 13 routes, plus Playwright on Pixel 7
and iPhone 14 profiles (16/16 passing).

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 3 | All controls ≥44px on touch (pills/switch via hit-area expanders); who-reacted reachable; stable names. Voice/real-device checks still manual |
| 2 | Performance | 3 | Unchanged; sheets lazy-render content; precache ~3 MB |
| 3 | Responsive | 4 | Tab-bar shell, full-screen stacks, safe areas, keyboard pinning, 16px inputs, no horizontal overflow on any route |
| 4 | Theming | 4 | Tokens only; literal px for touch sizes (root font is 15px) |
| 5 | Anti-patterns | 4 | Reads as a phone app; desktop unchanged |
| | **Total** | **18/20** | **Excellent — minor polish** |

All P0s from the original audit are fixed (first reaction via long-press sheet, multi-line on phone
keyboards, player close/seek via mini bar + full player, readable forum rows, visible gallery tile
actions, hold-to-talk for push-to-talk).

Remaining:
- Reaction pill hit-area expander is covered below by the next row (above works).
- Voice on phones (mini bar, call screen, hold-to-talk) is correct by construction only; no LiveKit in the audit instance.
- Image viewer gestures (pinch, swipe, double-tap) verified by code trace only.
- Spec 2.5 "speaker view on tap" on the phone call screen not built (Grid/Stage switch in ⋯ instead).

## Manual device checks

- [ ] iOS standalone (notched iPhone): top bar and tab bar clear of the notch and home indicator; status bar readable over the top bar
- [ ] iOS: tap the composer → keyboard opens, composer sits on the keyboard, top bar stays, last message visible; no zoom on focus anywhere
- [ ] iOS: edge swipe-back closes a thread panel, then returns to the channel list
- [ ] Android installed: Back closes sheet → panel → screen in that order; no pull-to-refresh inside lists
- [ ] Long-press a message (both platforms): our sheet opens, no OS text-selection/callout; long-press a link/image keeps the native menu
- [ ] Wide code block in a message scrolls sideways on Android (message rows use `touch-action: pan-y`)
- [ ] Image viewer: pinch-zoom, swipe between images, swipe down closes, double-tap zooms
- [ ] Voice: join from a phone, mini bar appears, call screen controls in one row, hold-to-talk transmits in PTT mode, screen-share control absent
- [ ] Music: mini bar above tab bar and above composer; full player seek/close; Back closes the player
