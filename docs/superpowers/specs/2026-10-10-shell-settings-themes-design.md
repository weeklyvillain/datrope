# Shell, settings modal, context menus, themes — design

Date: 2026-10-10. Scope: `clients/web` only, no backend changes.

## Goals

1. A top bar per view that always carries search and the inbox.
2. User settings as a sectioned modal instead of the `/settings` page.
3. Server settings reachable in one click from the top-left server header (same perms as today).
4. Right-click menus on channels, categories, messages and people (shadcn `context-menu`).
5. Voice join/leave sounds only for the voice room I am connected to.
6. An Appearance section with 10 dark themes taken from slackthemes.net (mishaor collection).

## 1. Top bar

New `app/TopBar.tsx`: `<TopBar actions={...} tools?>{icon, title, topic}</TopBar>`.

- It renders `<header className="flex h-14 flex-none items-center gap-2 border-b bg-topbar px-4 text-topbar-foreground">`.
- Layout: `children` (left), then `actions` (view-specific buttons), then `<InboxButton/>` and `<SearchBox/>` (always, unless `tools={false}`).
- It replaces the hand-written `<header>` in `ChannelView`, `VoiceChannelView` and `WelcomeView`, and stays *inside* each view's `<main>` so e2e selectors scoped to `getByRole("main", { name })` keep working.
- `ChannelView`: Threads, Pins and "Start call" move into `actions`. InboxButton and SearchBox move out of the view (TopBar owns them).
- `VoiceChannelView`: Grid layout, Soundboard and Channel chat go into `actions`. It already renders `SearchPanel`/`ProfilePanel`.
- `WelcomeView`: "Edit page" goes into `actions`.
  - It gains the same `profile ? ProfilePanel : searching ? SearchPanel : null` side panel as the voice view.
  - `tools={!gated}`: a gated member sees no search or inbox.
- Side panels stay where they are (siblings of `<main>`), so the bar spans the main column. Server settings keep their own page and header.
- New tokens `--topbar` / `--topbar-foreground` (default `var(--card)` / `var(--card-foreground)`).

## 2. User settings modal

- `app/settings/settings-store.ts`: a zustand vanilla store `{ open: boolean; section: SettingsSection }`.
  - `SettingsSection = "profile" | "sessions" | "notifications" | "appearance"`.
  - `openSettings(section = "profile")`, `closeSettings()`, `useSettings(selector)`.
- `app/settings/UserSettingsDialog.tsx`: a shadcn `Dialog` rendered once in `AppShell`. `DialogContent` is `h-[85vh] max-w-[1000px] p-0`, a two-column grid.
- Left nav: same look as server settings (a `NAV` class string exported from `ServerSettings.tsx`). Groups:
  - "Account": My profile, Sessions
  - "App": Notifications, Appearance
  - For admins, a "Server settings" item at the bottom closes the modal and navigates to `/server-settings`.
- Right column: the section title (an `h2`) plus the section body, scrolling. The dialog title is "Your settings" (sr-only `DialogTitle`).
- Sections:
  - `ProfileSettings` and `NotificationSettings`: unchanged components.
  - `SessionsSettings`: extracted from the old `UserSettings.tsx`, same markup, region "Sessions".
  - `AppearanceSettings`: new.
- Entry points:
  - The `ProfileStrip` gear becomes a `Button` named "Your settings" calling `openSettings()`.
  - `ProfileCard`'s "Edit profile" calls `openSettings("profile")`.
  - Route `settings` becomes `<SettingsRedirect/>`, which opens the modal and does `<Navigate to="/" replace/>`.
- `UserSettings.tsx` is deleted (replaced by the dialog plus `SessionsSettings`).

## 3. Server settings entry

- `ServerHeader` (in `ServerSidebar.tsx`) gets a gear icon button "Server settings" beside the dropdown trigger. It shows only when `canSettings`, and navigates to `/server-settings`.
- The `canSettings` rule is unchanged: instance admin, or any of ManageServer, ManageRoles, Kick, Ban, ManageChannels.
- The dropdown item stays.

## 4. Context menus

Add shadcn `context-menu` (`src/components/ui/context-menu.tsx`; strip `dark:` classes). Menus reuse existing actions and permission checks only.

| Target | Items |
|---|---|
| Channel row (`ChannelTree` `ChannelRow`) | Mark as read (text and unread: `client.ack(id, readState.lastMessageId)`), Copy link (`origin + /channels/id`), Join voice (voice and `canConnect`), Channel settings (if `manageable`) |
| Category header | Collapse/Expand. If `canManage`, via the existing `onAction`: Create channel, Rename category, Delete category |
| Message row (`MessageRow`) | Same callbacks and conditions as `MessageToolbar`: Reply, Create/Open thread, Edit, Pin/Unpin, Delete. Plus Copy text. There is no "Copy message link", because the app has no message URL route |
| Member row (`MemberList`) | View profile (opens the side panel), Message (DM, not me), Copy user ID |

- Voice person (`PersonMenu`) already opens its volume/mute/hide popover on right-click, so it stays as is. Its sliders and switches don't fit menu keyboard semantics.
- All context menus use `modal={false}` and `onCloseAutoFocus={(e) => e.preventDefault()}`, so items that open dialogs or focus an editor keep focus.
- Kick, ban and role edits stay in server settings (YAGNI: their confirm dialogs live there).
- Menu item labels are new accessible names. Existing button names do not change.

## 5. Voice sounds

The code already scopes sounds to my room: one LiveKit room per channel (`server/internal/voice/livekit.go:62`) and the `mine()` guards (`voice/voice.ts:138`). The user hears sounds while not in voice, so:

1. Reproduce with two browser contexts (alice in voice, bob not) and with one browser and two tabs (tab A in voice, tab B not).
2. Find the root cause (systematic debugging) and fix it, with a unit test for whatever guard is added.
3. If the cause is another tab of the same user being connected, that tab is correctly in voice: report it to the user instead of changing behaviour.

Rule: `join`/`leave` sounds play only while `voice.store` is connected and the event belongs to that room.

## 6. Themes

`src/theme/themes.ts` holds Slack colour sets: `column_bg, menu_bg, active_item, active_item_text, hover_item, text_color, active_presence, mention_badge, top_nav_bg, top_nav_text`.

- Themes:
  - "datrope": the default, = styles.css, no overrides.
  - 10 picked at random from the 54 dark themes of slackthemes.net/mishaor: Drund, RubyConf, Material Dark Indigo, EGA, xUnit.net, AWA, Stark Contrast, Gotham, Wild Cherry, Georgia Tech. xUnit.net replaced Zebra, which equals the current default.
- `themeVars(c)` is a pure function mapping a set to CSS variables. Below, `BG` stands for the background expression, nested literally.

| Token(s) | Value |
|---|---|
| `--sidebar` / `--sidebar-foreground` | `column_bg` / `text_color` |
| `--background` (BG) | `color-mix(in srgb, column_bg 45%, #131313)` |
| `--card`, `--popover` | `color-mix(in srgb, BG 94%, white)` |
| `--foreground`, `--card-foreground`, `--popover-foreground`, `--accent-foreground`, `--secondary-foreground` | `text_color` |
| `--muted-foreground` | `color-mix(in srgb, text_color 62%, BG)` |
| `--accent`, `--muted` | `color-mix(in srgb, hover_item 30%, BG)` |
| `--border`, `--input`, `--secondary` | `color-mix(in srgb, text_color 18%, BG)` |
| `--primary`, `--ring` | `active_item` |
| `--primary-foreground` | `active_item_text` |
| `--online` | `active_presence` |
| `--mention` | `mention_badge`. A new token, default `var(--destructive)`, used by the inbox count badge |
| `--topbar` / `--topbar-foreground` | `top_nav_bg` / `top_nav_text` |

- `src/theme/prefs.ts`: localStorage `datrope.theme` (theme id), same sanitize/subscribe/storage-event pattern as `notify/prefs.ts`.
- `hooks/use-theme.ts`: applies `themeVars` on `document.documentElement.style` and removes them on change.
- `usePalette` returns early unless the theme is "datrope" (the server accent only colours the default theme).
- `AppearanceSettings`: a radio group of swatch cards. Each card shows column_bg, active_item, hover_item and text sample bars, plus its name. Selecting one applies it at once.

## Testing

- vitest:
  - `theme/themes.test.ts`: every theme yields all tokens, ids are unique, "datrope" yields none.
  - `theme/prefs.test.ts`: an unknown id sanitizes to the default.
  - `settings-store.test.ts`: open, close, section.
- e2e `chat.spec.ts`:
  - "Your settings" is a button, and the profile steps run inside the dialog. Escape closes it before clicking "general".
  - Add: open Appearance, pick "Gotham", assert `--sidebar` on `<html>`.
  - Add: right-click a message shows "Copy text", and right-click a channel shows "Copy link".
- Also run `pnpm typecheck`, `pnpm test`, and a preview check of each view.

## Out of scope

- Server-side preference sync.
- Light themes.
- Kick/ban from context menus.
- Audio device settings.
