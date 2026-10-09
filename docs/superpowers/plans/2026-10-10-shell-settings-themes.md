# Shell, Settings Modal, Context Menus, Themes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship six web-client changes:
- a top bar with search and inbox on every view
- user settings as a sectioned modal
- a one-click server settings gear
- right-click menus on channels, categories, messages and members
- voice sounds scoped to my own room
- 10 dark Slack themes

**Architecture:** All changes are in `clients/web`, with no backend changes.
- New small modules: `src/theme/*` (theme data, pure token mapping, localStorage pref), `app/settings/settings-store.ts` (modal open state), `app/TopBar.tsx`, `components/ui/context-menu.tsx`.
- Existing views swap their hand-written headers for `TopBar`.
- Existing action callbacks are reused by the new context menus.

**Tech Stack:** React 18, zustand 5 (vanilla stores + `useStore`), shadcn/ui (new-york, `radix-ui` umbrella package), Tailwind v4 tokens in `src/styles.css`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-10-shell-settings-themes-design.md`

## Global Constraints

- **Never commit** (AGENTS.md §5). Each task ends by staging its files with `git add`; the user commits.
- Dark-only app: no `dark:` classes, no `.dark`. Colours come from tokens in `src/styles.css`. Theme hex values live only in `src/theme/themes.ts`.
- shadcn first. `Button` defaults to `type="button"`. React 18: wrap a component in `forwardRef` (or use `RefButton` from `@/components/ref-button`) before using it as an `asChild` child of a trigger that needs a ref.
- Keep existing accessible names. The Playwright spec selects by role and name.
- Permission rules stay as they are: `canSettings = isAdmin || SETTINGS_PERMS.some(...)` in `ServerSidebar.tsx`.
- Tooling on this machine:
  - Run from `clients/web`: `pnpm test` (vitest) and `pnpm typecheck`.
  - The Write/Edit tools may be blocked on project files. If so, write in the scratchpad and `cp`, or use a Bash heredoc.
  - D: is exFAT, so `pnpm dlx shadcn add` may fail. Use the AGENTS.md fallback (fetch `https://ui.shadcn.com/r/styles/new-york-v4/<name>.json`).
- Dev servers: use `preview_start` with names from `.claude/launch.json` (datrope-server on :8081, datrope-web). Voice needs the `datrope-dev-livekit` container.

---

### Task 1: Theme data, token mapping and preference

**Files:**
- Create: `clients/web/src/theme/themes.ts`, `clients/web/src/theme/themes.test.ts`
- Create: `clients/web/src/theme/prefs.ts`, `clients/web/src/theme/prefs.test.ts`
- Create: `clients/web/src/hooks/use-theme.ts`
- Modify: `clients/web/src/hooks/use-palette.ts` (skip unless default theme)
- Modify: `clients/web/src/styles.css` (new tokens `--topbar`, `--topbar-foreground`, `--mention`)
- Modify: `clients/web/src/app/AppShell.tsx` (call `useTheme()`)
- Modify: `clients/web/src/app/InboxButton.tsx:45` (badge `bg-destructive` → `bg-mention`)

**Interfaces:**
- Produces:
  - `type ThemeId`, `DEFAULT_THEME: ThemeId` ("datrope"), `THEME_IDS: ThemeId[]`
  - `THEMES: Record<ThemeId, { label: string; colors: SlackColors }>`
  - `themeVars(c: SlackColors): Record<string, string>`
  - `useThemeId(): ThemeId`, `setTheme(id: ThemeId): void`, `sanitize(raw: unknown): ThemeId` (prefs)
  - `useTheme(): void`
  - Tailwind utilities `bg-topbar`, `text-topbar-foreground`, `bg-mention`

- [ ] **Step 1: Write the failing tests**

`clients/web/src/theme/themes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEMES, THEME_IDS, themeVars } from "./themes";

const TOKENS = [
  "--background", "--foreground", "--card", "--card-foreground", "--popover", "--popover-foreground",
  "--primary", "--primary-foreground", "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
  "--accent", "--accent-foreground", "--border", "--input", "--ring", "--sidebar", "--sidebar-foreground",
  "--online", "--mention", "--topbar", "--topbar-foreground",
];

describe("themes", () => {
  it("has the default plus 10 themes with unique labels", () => {
    expect(THEME_IDS[0]).toBe(DEFAULT_THEME);
    expect(THEME_IDS).toHaveLength(11);
    expect(new Set(THEME_IDS.map((id) => THEMES[id].label)).size).toBe(11);
  });

  it("maps every theme onto every token", () => {
    for (const id of THEME_IDS) {
      const vars = themeVars(THEMES[id].colors);
      expect(Object.keys(vars).sort()).toEqual([...TOKENS].sort());
      for (const v of Object.values(vars)) expect(v).not.toBe("");
    }
  });

  it("uses the Slack colours directly where they map 1:1", () => {
    const vars = themeVars(THEMES.gotham.colors);
    expect(vars["--sidebar"]).toBe("#0a0f14");
    expect(vars["--primary"]).toBe("#265360");
    expect(vars["--topbar"]).toBe("#10151b");
    expect(vars["--background"]).toBe("color-mix(in srgb, #0a0f14 45%, #131313)");
  });
});
```

`clients/web/src/theme/prefs.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { sanitize } from "./prefs";

describe("theme pref", () => {
  it("keeps a known theme", () => {
    expect(sanitize("gotham")).toBe("gotham");
  });

  it("falls back to the default for anything else", () => {
    expect(sanitize(undefined)).toBe("datrope");
    expect(sanitize("nope")).toBe("datrope");
    expect(sanitize("toString")).toBe("datrope");
    expect(sanitize(3)).toBe("datrope");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd clients/web && pnpm test -- src/theme`
Expected: FAIL, "Failed to resolve import ./themes" / "./prefs".

- [ ] **Step 3: Implement `themes.ts`**

The colours come from slackthemes.net/mishaor (lowercased). "datrope" mirrors `styles.css` and is never applied as overrides; its colours are only for the swatch.

```ts
/** A Slack sidebar theme: the ten colours slackthemes.net shares. */
export type SlackColors = {
  column_bg: string; menu_bg: string; active_item: string; active_item_text: string; hover_item: string;
  text_color: string; active_presence: string; mention_badge: string; top_nav_bg: string; top_nav_text: string;
};

/** "datrope" is styles.css itself; the rest are dark themes from slackthemes.net (mishaor). */
export const THEMES = {
  datrope: { label: "Datrope", colors: { column_bg: "#0d0d0d", menu_bg: "#1c1c1c", active_item: "#2ecc71", active_item_text: "#131313", hover_item: "#2a2a2a", text_color: "#bdc3c7", active_presence: "#2ecc71", mention_badge: "#e74c3c", top_nav_bg: "#1c1c1c", top_nav_text: "#bdc3c7" } },
  drund: { label: "Drund", colors: { column_bg: "#181818", menu_bg: "#202020", active_item: "#99cb3f", active_item_text: "#ffffff", hover_item: "#202020", text_color: "#ffffff", active_presence: "#99cb3f", mention_badge: "#f7124e", top_nav_bg: "#202020", top_nav_text: "#ffffff" } },
  rubyconf: { label: "RubyConf", colors: { column_bg: "#100e0e", menu_bg: "#c10800", active_item: "#ffb400", active_item_text: "#ffffff", hover_item: "#242121", text_color: "#ffffff", active_presence: "#ff2b22", mention_badge: "#ff2b22", top_nav_bg: "#c10800", top_nav_text: "#ffffff" } },
  "material-dark-indigo": { label: "Material Dark Indigo", colors: { column_bg: "#212121", menu_bg: "#212121", active_item: "#3f51b5", active_item_text: "#ffffff", hover_item: "#3f51b5", text_color: "#ffffff", active_presence: "#3f51b5", mention_badge: "#3f51b5", top_nav_bg: "#212121", top_nav_text: "#ffffff" } },
  ega: { label: "EGA", colors: { column_bg: "#0000aa", menu_bg: "#00aaaa", active_item: "#ff55ff", active_item_text: "#ffffff", hover_item: "#00aaaa", text_color: "#ffffff", active_presence: "#c0c0c0", mention_badge: "#ff00ff", top_nav_bg: "#00aaaa", top_nav_text: "#ffffff" } },
  xunit: { label: "xUnit.net", colors: { column_bg: "#162c16", menu_bg: "#444a47", active_item: "#663333", active_item_text: "#ffffff", hover_item: "#995050", text_color: "#ffffff", active_presence: "#e0e066", mention_badge: "#db6668", top_nav_bg: "#444a47", top_nav_text: "#ffffff" } },
  awa: { label: "AWA", colors: { column_bg: "#222222", menu_bg: "#333333", active_item: "#444444", active_item_text: "#ffffff", hover_item: "#333333", text_color: "#ffffff", active_presence: "#38978d", mention_badge: "#fc7459", top_nav_bg: "#333333", top_nav_text: "#ffffff" } },
  "stark-contrast": { label: "Stark Contrast", colors: { column_bg: "#000000", menu_bg: "#a51c24", active_item: "#ffffff", active_item_text: "#0320ff", hover_item: "#a5a5a5", text_color: "#ffffff", active_presence: "#ffffff", mention_badge: "#ffff00", top_nav_bg: "#a51c24", top_nav_text: "#ffffff" } },
  gotham: { label: "Gotham", colors: { column_bg: "#0a0f14", menu_bg: "#10151b", active_item: "#265360", active_item_text: "#d4ebe9", hover_item: "#d26939", text_color: "#9bd1ce", active_presence: "#edb54b", mention_badge: "#c33027", top_nav_bg: "#10151b", top_nav_text: "#9bd1ce" } },
  "wild-cherry": { label: "Wild Cherry", colors: { column_bg: "#2b1f32", menu_bg: "#ffb86c", active_item: "#e15d97", active_item_text: "#ffffff", hover_item: "#4a1386", text_color: "#ffffff", active_presence: "#35ba66", mention_badge: "#0aacc5", top_nav_bg: "#ffb86c", top_nav_text: "#ffffff" } },
  "georgia-tech": { label: "Georgia Tech", colors: { column_bg: "#00254c", menu_bg: "#15467a", active_item: "#eeb211", active_item_text: "#ffffff", hover_item: "#eeb211", text_color: "#ffffff", active_presence: "#c59353", mention_badge: "#007bff", top_nav_bg: "#15467a", top_nav_text: "#ffffff" } },
} satisfies Record<string, { label: string; colors: SlackColors }>;

export type ThemeId = keyof typeof THEMES;
export const DEFAULT_THEME: ThemeId = "datrope";
export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

/** The app's tokens for a Slack theme: the sidebar and accents as given, the main area a dark tint of the sidebar. */
export function themeVars(c: SlackColors): Record<string, string> {
  const bg = `color-mix(in srgb, ${c.column_bg} 45%, #131313)`;
  const surface = `color-mix(in srgb, ${bg} 94%, white)`;
  const line = `color-mix(in srgb, ${c.text_color} 18%, ${bg})`;
  const hover = `color-mix(in srgb, ${c.hover_item} 30%, ${bg})`;
  return {
    "--background": bg,
    "--foreground": c.text_color,
    "--card": surface,
    "--card-foreground": c.text_color,
    "--popover": surface,
    "--popover-foreground": c.text_color,
    "--primary": c.active_item,
    "--primary-foreground": c.active_item_text,
    "--secondary": line,
    "--secondary-foreground": c.text_color,
    "--muted": hover,
    "--muted-foreground": `color-mix(in srgb, ${c.text_color} 62%, ${bg})`,
    "--accent": hover,
    "--accent-foreground": c.text_color,
    "--border": line,
    "--input": line,
    "--ring": c.active_item,
    "--sidebar": c.column_bg,
    "--sidebar-foreground": c.text_color,
    "--online": c.active_presence,
    "--mention": c.mention_badge,
    "--topbar": c.top_nav_bg,
    "--topbar-foreground": c.top_nav_text,
  };
}
```

- [ ] **Step 4: Implement `prefs.ts`**

It follows `notify/prefs.ts`.

```ts
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { DEFAULT_THEME, THEMES, type ThemeId } from "./themes";

const KEY = "datrope.theme";

/** A known theme ID, else the default. */
export function sanitize(raw: unknown): ThemeId {
  return typeof raw === "string" && Object.hasOwn(THEMES, raw) ? (raw as ThemeId) : DEFAULT_THEME;
}

function load(): ThemeId {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? DEFAULT_THEME : sanitize(JSON.parse(raw));
  } catch {
    return DEFAULT_THEME; // unavailable or unreadable: the choice then lasts for this session
  }
}

const themePref = createStore<{ theme: ThemeId }>(() => ({ theme: load() }));

themePref.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s.theme));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
});

export const useThemeId = () => useStore(themePref, (s) => s.theme);
export const setTheme = (theme: ThemeId) => themePref.setState({ theme });

// Another tab picked a theme: follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) themePref.setState({ theme: load() });
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd clients/web && pnpm test -- src/theme`
Expected: PASS (5 tests).

- [ ] **Step 6: Add the tokens to `styles.css`**

In `:root`, after `--sidebar-foreground`:
```css
  --topbar: var(--card);
  --topbar-foreground: var(--card-foreground);
  --mention: var(--destructive);
```
In `@theme inline`, after `--color-sidebar-foreground`:
```css
  --color-topbar: var(--topbar);
  --color-topbar-foreground: var(--topbar-foreground);
  --color-mention: var(--mention);
```

- [ ] **Step 7: `use-theme.ts`, palette gate, AppShell, inbox badge**

`clients/web/src/hooks/use-theme.ts`:
```ts
import { useEffect } from "react";
import { useThemeId } from "@/theme/prefs";
import { DEFAULT_THEME, THEMES, themeVars } from "@/theme/themes";

/** Applies my theme's tokens on <html>; the default theme is styles.css itself. */
export function useTheme() {
  const id = useThemeId();
  useEffect(() => {
    if (id === DEFAULT_THEME) return;
    const vars = themeVars(THEMES[id].colors);
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.removeProperty(k);
    };
  }, [id]);
}
```

`use-palette.ts` becomes:
```ts
import { useEffect } from "react";
import { PALETTES } from "@/lib/palettes";
import { useApp } from "@/session";
import { useThemeId } from "@/theme/prefs";
import { DEFAULT_THEME } from "@/theme/themes";

/** Applies the server's palette: --primary and --ring follow its accent (--online stays green). A picked theme wins. */
export function usePalette() {
  const palette = useApp((s) => s.server?.server.palette);
  const themed = useThemeId() !== DEFAULT_THEME;
  useEffect(() => {
    if (!palette || themed) return;
    const root = document.documentElement.style;
    const { accent } = PALETTES[palette] ?? PALETTES.emerald;
    root.setProperty("--primary", accent);
    root.setProperty("--ring", accent);
    return () => {
      root.removeProperty("--primary");
      root.removeProperty("--ring");
    };
  }, [palette, themed]);
}
```

`AppShell.tsx`: import `useTheme` from `@/hooks/use-theme` and call `useTheme();` right after `usePalette();`.

`InboxButton.tsx:45`: replace `bg-destructive` with `bg-mention` in the badge span (keep `text-destructive-foreground`).

- [ ] **Step 8: Verify**

Run: `cd clients/web && pnpm typecheck && pnpm test`
Expected: no type errors; all tests pass.

- [ ] **Step 9: Stage**

```bash
git add clients/web/src/theme clients/web/src/hooks/use-theme.ts clients/web/src/hooks/use-palette.ts clients/web/src/styles.css clients/web/src/app/AppShell.tsx clients/web/src/app/InboxButton.tsx
```

---

### Task 2: User settings modal with sections and Appearance

**Files:**
- Create: `clients/web/src/app/settings/settings-store.ts`, `clients/web/src/app/settings/settings-store.test.ts`
- Create: `clients/web/src/app/settings/UserSettingsDialog.tsx`
- Create: `clients/web/src/app/settings/SessionsSettings.tsx` (moved out of `UserSettings.tsx`)
- Create: `clients/web/src/app/settings/AppearanceSettings.tsx`
- Delete: `clients/web/src/app/settings/UserSettings.tsx`
- Modify: `clients/web/src/router.tsx:7,25`
- Modify: `clients/web/src/app/AppShell.tsx` (render `<UserSettingsDialog/>`)
- Modify: `clients/web/src/app/ProfileStrip.tsx:72-80` (gear becomes a button)
- Modify: `clients/web/src/app/people/ProfileCard.tsx` ("Edit profile" opens the modal)
- Modify: `clients/web/src/app/server-settings/ServerSettings.tsx:65` (`export const NAV`)
- Modify: `clients/web/e2e/chat.spec.ts:367,386`

**Interfaces:**
- Consumes: `THEMES`, `THEME_IDS`, `ThemeId` (Task 1); `useThemeId`, `setTheme` (Task 1 prefs).
- Produces:
  - `type SettingsSection = "profile" | "sessions" | "notifications" | "appearance"`
  - `openSettings(section?: SettingsSection): void`, `closeSettings(): void`, `showSection(section: SettingsSection): void`
  - `useSettings<T>(select: (s: { open: boolean; section: SettingsSection }) => T): T`
  - `settingsStore`
  - `NAV` exported from `ServerSettings.tsx`

- [ ] **Step 1: Write the failing store test**

`settings-store.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { closeSettings, openSettings, settingsStore, showSection } from "./settings-store";

describe("settings store", () => {
  beforeEach(() => settingsStore.setState({ open: false, section: "profile" }));

  it("opens on the profile by default", () => {
    openSettings();
    expect(settingsStore.getState()).toEqual({ open: true, section: "profile" });
  });

  it("opens on a section, switches, and closes keeping the section", () => {
    openSettings("appearance");
    showSection("sessions");
    closeSettings();
    expect(settingsStore.getState()).toEqual({ open: false, section: "sessions" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd clients/web && pnpm test -- settings-store`
Expected: FAIL, cannot resolve `./settings-store`.

- [ ] **Step 3: Implement `settings-store.ts`**

```ts
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type SettingsSection = "profile" | "sessions" | "notifications" | "appearance";
type SettingsState = { open: boolean; section: SettingsSection };

/** Whether the "Your settings" modal is open, and on which section. */
export const settingsStore = createStore<SettingsState>(() => ({ open: false, section: "profile" }));

export const openSettings = (section: SettingsSection = "profile") => settingsStore.setState({ open: true, section });
export const closeSettings = () => settingsStore.setState({ open: false });
export const showSection = (section: SettingsSection) => settingsStore.setState({ section });

export function useSettings<T>(select: (s: SettingsState) => T): T {
  return useStore(settingsStore, select);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd clients/web && pnpm test -- settings-store`
Expected: PASS.

- [ ] **Step 5: Extract `SessionsSettings.tsx`**

Move the Sessions card and its state verbatim from `UserSettings.tsx` (lines 1-62 of the current file):

```tsx
import { unwrap, type Session } from "@datrope/core";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { client, errorText } from "../../session";

/** My signed-in devices: sign one out, or this one. */
export function SessionsSettings() {
  const [sessions, setSessions] = useState<Session[]>();
  const [error, setError] = useState<string>();

  const loadSessions = () => unwrap(client.api.GET("/api/sessions")).then((v) => setSessions(v ?? [])).catch((e) => setError(errorText(e)));
  useEffect(() => { void loadSessions(); }, []);

  return (
    <Card role="region" aria-label="Sessions" className="gap-3 p-4">
      <h3>Signed-in devices</h3>
      <ErrorText error={error} />
      <Table>
        <TableBody>
          {sessions?.map((s) => (
            <TableRow key={s.id}>
              <TableCell>{s.device_name}{s.current && <strong> (this device)</strong>}</TableCell>
              <TableCell className="text-muted-foreground">last used {new Date(s.last_used_at).toLocaleString()}</TableCell>
              <TableCell>{!s.current && (
                <Button variant="outline" onClick={() => unwrap(client.api.DELETE("/api/sessions/{id}", { params: { path: { id: s.id } } }))
                  .then(loadSessions).catch((e) => setError(errorText(e)))}>Sign out</Button>
              )}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Button variant="destructive" onClick={async () => {
        try {
          await unwrap(client.api.POST("/api/auth/logout"));
        } catch (e) {
          setError(errorText(e));
          return;
        }
        client.disconnect();
        window.location.assign("/login");
      }}>Sign out of this device</Button>
    </Card>
  );
}
```

- [ ] **Step 6: `AppearanceSettings.tsx`**

Each card's swatch shows the theme's own colours via inline `style`. The data lives in `theme/themes.ts`, so no hex is written in this component.

```tsx
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { setTheme, useThemeId } from "@/theme/prefs";
import { THEMES, THEME_IDS, type ThemeId } from "@/theme/themes";

/** Theme picker: a card per theme with a small preview of its sidebar, accent and hover colours. */
export function AppearanceSettings() {
  const theme = useThemeId();
  return (
    <section aria-label="Theme" className="grid gap-3">
      <p className="text-sm text-muted-foreground">Themes stay on this device. Dark themes from slackthemes.net.</p>
      <RadioGroup aria-label="Theme" value={theme} onValueChange={(v) => setTheme(v as ThemeId)}
        className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {THEME_IDS.map((id) => {
          const { label, colors: c } = THEMES[id];
          return (
            <Label key={id} htmlFor={`theme-${id}`}
              className="grid cursor-pointer gap-2 rounded-lg border p-2.5 font-normal hover:bg-accent has-[[data-state=checked]]:border-primary">
              <span aria-hidden className="flex h-14 overflow-hidden rounded-md border">
                <span className="grid w-1/3 content-start gap-1 p-1.5" style={{ background: c.column_bg }}>
                  <span className="h-1.5 rounded-sm" style={{ background: c.text_color, opacity: 0.6 }} />
                  <span className="h-1.5 rounded-sm" style={{ background: c.active_item }} />
                  <span className="h-1.5 rounded-sm" style={{ background: c.hover_item }} />
                </span>
                <span className="flex-1" style={{ background: `color-mix(in srgb, ${c.column_bg} 45%, #131313)` }}>
                  <span className="block h-3" style={{ background: c.top_nav_bg }} />
                </span>
              </span>
              <span className="flex items-center gap-2">
                <RadioGroupItem id={`theme-${id}`} value={id} />
                {label}
              </span>
            </Label>
          );
        })}
      </RadioGroup>
    </section>
  );
}
```

If the reviewer objects to the `#131313` literal here, use `themeVars(c)["--background"]` instead (same value, no literal).

- [ ] **Step 7: Export `NAV` from `ServerSettings.tsx`**

Line 65: `const NAV = ...` → `export const NAV = ...` (no other change).

- [ ] **Step 8: `UserSettingsDialog.tsx`**

```tsx
import { Bell, MonitorSmartphone, Palette, Settings, User, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useApp } from "../../session";
import { NAV } from "../server-settings/ServerSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { NotificationSettings } from "./NotificationSettings";
import { ProfileSettings } from "./ProfileSettings";
import { SessionsSettings } from "./SessionsSettings";
import { closeSettings, showSection, useSettings, type SettingsSection } from "./settings-store";

type Group = "Account" | "App";
const GROUPS: Group[] = ["Account", "App"];
const SECTIONS: { id: SettingsSection; label: string; group: Group; icon: LucideIcon; body: () => ReactNode }[] = [
  { id: "profile", label: "My profile", group: "Account", icon: User, body: () => <ProfileSettings /> },
  { id: "sessions", label: "Sessions", group: "Account", icon: MonitorSmartphone, body: () => <SessionsSettings /> },
  { id: "notifications", label: "Notifications", group: "App", icon: Bell, body: () => <NotificationSettings /> },
  { id: "appearance", label: "Appearance", group: "App", icon: Palette, body: () => <AppearanceSettings /> },
];

/** "Your settings": a modal with a section nav on the left, like server settings. */
export function UserSettingsDialog() {
  const open = useSettings((s) => s.open);
  const section = useSettings((s) => s.section);
  const isAdmin = useApp((s) => !!s.me?.is_admin);
  const nav = useNavigate();
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeSettings()}>
      <DialogContent aria-describedby={undefined}
        className="grid h-[85vh] max-h-[760px] grid-cols-[220px_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[1000px]">
        <DialogTitle className="sr-only">Your settings</DialogTitle>
        <nav aria-label="Settings sections" className="flex min-h-0 flex-col overflow-y-auto border-r bg-sidebar px-2 pt-1 pb-2">
          {GROUPS.map((g) => (
            <div key={g}>
              <div className="px-2.5 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</div>
              {SECTIONS.filter((s) => s.group === g).map((s) => {
                const Icon = s.icon;
                const active = s.id === current.id;
                return (
                  <button key={s.id} type="button" aria-current={active ? "page" : undefined} onClick={() => showSection(s.id)}
                    className={cn(NAV, "w-full hover:bg-accent hover:text-foreground", active && "bg-accent text-foreground")}>
                    <Icon className="size-4 flex-none" aria-hidden />{s.label}
                  </button>
                );
              })}
            </div>
          ))}
          {isAdmin && (
            <button type="button" onClick={() => { closeSettings(); nav("/server-settings"); }}
              className={cn(NAV, "mt-auto w-full hover:bg-accent hover:text-foreground")}>
              <Settings className="size-4 flex-none" aria-hidden />Server settings
            </button>
          )}
        </nav>
        <section aria-label={current.label} className="grid min-h-0 content-start gap-4 overflow-y-auto p-6">
          <h2>{current.label}</h2>
          {current.body()}
        </section>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 9: Wire the entry points**

`router.tsx`:
- Replace `import { UserSettings } from "./app/settings/UserSettings";` with `import { SettingsRedirect } from "./app/settings/SettingsRedirect";`
- Replace the route element with `{ path: "settings", element: <SettingsRedirect /> },`

Create `clients/web/src/app/settings/SettingsRedirect.tsx`:
```tsx
import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { openSettings } from "./settings-store";

/** /settings (old links): opens the settings modal over the app. */
export function SettingsRedirect() {
  useEffect(() => openSettings(), []);
  return <Navigate to="/" replace />;
}
```

`AppShell.tsx`: import `UserSettingsDialog` from `./settings/UserSettingsDialog` and render `<UserSettingsDialog />` next to `<NotificationListener />`.

`ProfileStrip.tsx` lines 72-80 become:
```tsx
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex">
            <Button variant="ghost" size="icon-sm" aria-label="Your settings" className="text-muted-foreground hover:text-foreground"
              onClick={() => openSettings()}>
              <Settings />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Your settings</TooltipContent>
      </Tooltip>
```
Then:
- Add `import { openSettings } from "./settings/settings-store";`.
- Remove the now-unused `Link` import and `buttonVariants`. Keep `Button`.
- Remove `cn` if nothing else uses it (check with `grep -n "cn(" ProfileStrip.tsx`).

`ProfileCard.tsx`, the "Edit profile" `onClick`:
```tsx
onClick={() => { onAction?.(); openSettings("profile"); }}
```
Add `import { openSettings } from "../settings/settings-store";`. Keep `useNavigate` (used by `message`).

Delete `clients/web/src/app/settings/UserSettings.tsx`.

- [ ] **Step 10: Update e2e**

`e2e/chat.spec.ts:367`:
```ts
  await alice.getByRole("button", { name: "Your settings" }).click();
```
Before line 386 (`await alice.getByRole("link", { name: "general" }).click();`), insert:
```ts
  await alice.keyboard.press("Escape"); // closes the settings modal
```
Then add, right after that Escape line:
```ts
  // Appearance: a theme re-skins the app and stays on this device.
  await alice.getByRole("button", { name: "Your settings" }).click();
  await alice.getByRole("dialog").getByRole("button", { name: "Appearance" }).click();
  await alice.getByRole("radio", { name: "Gotham" }).click();
  await expect.poll(() => alice.evaluate(() => document.documentElement.style.getPropertyValue("--sidebar"))).toBe("#0a0f14");
  await alice.getByRole("radio", { name: "Datrope" }).click();
  await alice.keyboard.press("Escape");
```

- [ ] **Step 11: Verify**

Run: `cd clients/web && pnpm typecheck && pnpm test`
Expected: clean, all pass.

Then preview (`preview_start` datrope-server + datrope-web):
- Click the gear: the modal opens on "My profile".
- Switch sections. Pick Gotham: the whole app re-skins. Reload: the theme stays.
- Visit `/settings`: the modal opens over the app.
- As admin, check "Server settings" at the bottom of the nav.
- Take a screenshot.

- [ ] **Step 12: Stage**

```bash
git add -A clients/web/src/app/settings clients/web/src/router.tsx clients/web/src/app/AppShell.tsx clients/web/src/app/ProfileStrip.tsx clients/web/src/app/people/ProfileCard.tsx clients/web/src/app/server-settings/ServerSettings.tsx clients/web/e2e/chat.spec.ts
```

---

### Task 3: Top bar with search and inbox on every view

**Files:**
- Create: `clients/web/src/app/TopBar.tsx`
- Modify: `clients/web/src/app/ChannelView.tsx:99-124` (header → TopBar)
- Modify: `clients/web/src/app/voice/VoiceChannelView.tsx:96-128` (header → TopBar)
- Modify: `clients/web/src/app/welcome/WelcomeView.tsx` (header → TopBar; search/profile side panel)

**Interfaces:**
- Consumes: `bg-topbar`, `text-topbar-foreground` (Task 1).
- Produces: `TopBar({ actions?: ReactNode; tools?: boolean; children: ReactNode })`.

- [ ] **Step 1: Create `TopBar.tsx`**

```tsx
import type { ReactNode } from "react";
import { InboxButton } from "./InboxButton";
import { SearchBox } from "./search/SearchBox";

/** A view's top bar: its title on the left, its own buttons, then the inbox and search (unless `tools` is off). */
export function TopBar({ actions, tools = true, children }: { actions?: ReactNode; tools?: boolean; children: ReactNode }) {
  return (
    <header className="flex h-14 flex-none items-center gap-2 border-b bg-topbar px-4 text-topbar-foreground">
      {children}
      <div className="ml-auto flex flex-none items-center gap-1">
        {actions}
        {tools && (
          <>
            <InboxButton />
            <SearchBox />
          </>
        )}
      </div>
    </header>
  );
}
```

- [ ] **Step 2: ChannelView**

Replace the `<header>…</header>` block (lines 99-124) with:
```tsx
        <TopBar actions={(
          <>
            {threads && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex">
                    <Button variant="ghost" size="icon-sm" aria-label="Threads" aria-pressed={panel?.kind === "threads"}
                      className={panel?.kind === "threads" ? "text-foreground" : "text-muted-foreground"}
                      onClick={() => (panel?.kind === "threads" ? closePanel() : openPanel({ kind: "threads" }))}>
                      <MessageSquare />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Threads</TooltipContent>
              </Tooltip>
            )}
            <PinsPanel channelId={channelId} onJump={(id) => void jumpTo(channelId, id).catch(() => undefined)} />
            {ch.type === "dm" && !here && inCall === 0 && (
              <Button variant="outline" size="sm" onClick={() => void voice.join(channelId)}><Phone /> Start call</Button>
            )}
          </>
        )}>
          <h2 className="flex-none">{title}</h2>
          {ch.type !== "dm" && ch.topic && <Topic channelId={channelId} name={ch.name} topic={ch.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
        </TopBar>
```
Remove the `InboxButton` and `SearchBox` imports from ChannelView and add `import { TopBar } from "./TopBar";`.

- [ ] **Step 3: VoiceChannelView**

Replace its `<header>…</header>` (lines 96-128) with:
```tsx
        <TopBar actions={(
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex">
                  <Button variant="ghost" size="icon-sm" aria-label="Grid layout" aria-pressed={layout === "grid"} disabled={!canStage}
                    className={layout === "grid" ? "text-foreground" : "text-muted-foreground"}
                    onClick={() => setLayout((l) => (l === "grid" ? "stage" : "grid"))}>
                    <LayoutGrid />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{canStage ? "Grid layout" : "Grid layout (watch a screen share for the stage)"}</TooltipContent>
            </Tooltip>
            <SoundboardButton />
            {canRead && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex">
                    <Button variant="ghost" size="icon-sm" aria-label="Channel chat" aria-pressed={chat}
                      className={chat ? "text-foreground" : "text-muted-foreground"} onClick={() => setChat((c) => !c)}>
                      <MessageSquare />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Channel chat</TooltipContent>
              </Tooltip>
            )}
          </>
        )}>
          <Volume2 className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="flex-none">{ch.name}</h2>
          {ch.topic && <Topic channelId={channelId} name={ch.name} topic={ch.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
        </TopBar>
```
Add `import { TopBar } from "../TopBar";`.

- [ ] **Step 4: WelcomeView**

- Imports: add
  ```tsx
  import { TopBar } from "../TopBar";
  import { ProfilePanel } from "../people/ProfilePanel";
  import { SearchPanel } from "../search/SearchPanel";
  import { closePanel, usePanel } from "../side-panel/panel";
  ```
- In `WelcomeView`, next to the other hooks (before the early `editing` return), add:
  ```tsx
  const profile = usePanel((s) => (s.panel?.kind === "profile" ? s.panel.userId : undefined));
  const searching = usePanel((s) => s.panel?.kind === "search");
  ```
- The return becomes a fragment: `<main>` as today, then the side panel. Its header becomes:
  ```tsx
  <>
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label={name}>
      <TopBar tools={!gated} actions={canEdit && welcome ? <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Pencil />Edit page</Button> : undefined}>
        <BookOpen className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate">{name}</h2>
      </TopBar>
      {/* …rest of main unchanged… */}
    </main>
    {!gated && (profile ? <ProfilePanel key={profile} userId={profile} onClose={closePanel} /> : searching ? <SearchPanel /> : null)}
  </>
  ```
- Keep everything inside `<main>` below the header exactly as it is.

- [ ] **Step 5: Verify**

Run: `cd clients/web && pnpm typecheck && pnpm test`
Expected: clean.

Preview:
- Text channel, DM, voice channel and welcome each show the bar with inbox + search at the right. Searching from the welcome and voice views opens results in the side panel.
- With the Gotham theme the bar uses `#10151b`.
- The e2e selectors still resolve: "Soundboard" inside `main "Lounge"`, "Pinned messages", "Threads", the `Search` textbox.
- Take a screenshot.

- [ ] **Step 6: Stage**

```bash
git add clients/web/src/app/TopBar.tsx clients/web/src/app/ChannelView.tsx clients/web/src/app/voice/VoiceChannelView.tsx clients/web/src/app/welcome/WelcomeView.tsx
```

---

### Task 4: Server settings gear in the server header

**Files:**
- Modify: `clients/web/src/app/ServerSidebar.tsx:252-295` (`ServerHeader`)

**Interfaces:** none new.

- [ ] **Step 1: Restructure the interactive branch**

Keep the non-interactive early return (`if (!canInvite && !canSettings && !canCreate) return <div className={header}>{content}</div>;`) unchanged. Replace the returned fragment's `DropdownMenu` part with:
```tsx
      <div className="flex h-14 flex-none items-center border-b">
        {/* Not modal: its items open dialogs, which a modal menu would fight for focus. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger aria-label={`${sv.name} menu`}
            className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-3.5 text-left text-foreground outline-none hover:bg-accent focus-visible:bg-accent">
            {content}
            <ChevronDown className="size-4 flex-none text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {canInvite && <DropdownMenuItem onSelect={() => setDialog("invite")}><UserPlus />Invite people</DropdownMenuItem>}
            {canSettings && <DropdownMenuItem onSelect={() => nav("/server-settings")}><Settings />Server settings</DropdownMenuItem>}
            {canCreate && <DropdownMenuItem onSelect={() => setDialog("create")}><Plus />Create channel</DropdownMenuItem>}
            {canCreate && <DropdownMenuItem onSelect={() => setDialog("category")}><FolderPlus />Create category</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        {canSettings && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex px-1.5">
                <Button variant="ghost" size="icon-sm" aria-label="Server settings" className="text-muted-foreground hover:text-foreground"
                  onClick={() => nav("/server-settings")}>
                  <Settings />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Server settings</TooltipContent>
          </Tooltip>
        )}
      </div>
```
Add imports: `Button` from `@/components/ui/button`; `Tooltip, TooltipContent, TooltipTrigger` from `@/components/ui/tooltip`. If `cn` is no longer used in this file, remove it.

- [ ] **Step 2: Verify**

Run: `cd clients/web && pnpm typecheck`
Expected: clean.

Preview:
- As admin: the gear is visible top-left and opens `/server-settings`.
- As a plain member (bob): no gear.
- e2e `openServerSettings` (the "Datrope menu" → menuitem) still works.

- [ ] **Step 3: Stage**

```bash
git add clients/web/src/app/ServerSidebar.tsx
```

---

### Task 5: Context menu component + channel and category menus

**Files:**
- Create: `clients/web/src/components/ui/context-menu.tsx` (shadcn)
- Modify: `clients/web/src/app/sidebar/ChannelTree.tsx` (`ChannelRow`, ~line 315-350)
- Modify: `clients/web/src/app/sidebar/CategoryHeader.tsx`
- Modify: `clients/web/e2e/chat.spec.ts` (channel menu check)

**Interfaces:**
- Produces from `@/components/ui/context-menu`: `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem` (supports `variant="destructive"`), `ContextMenuSeparator`.

- [ ] **Step 1: Add the component**

Run: `cd clients/web && pnpm dlx shadcn@latest add context-menu`

If that fails (exFAT):
- Fetch `https://ui.shadcn.com/r/styles/new-york-v4/context-menu.json` and write `files[0].content` to `src/components/ui/context-menu.tsx`.
- Fix the `cn` import to `@/lib/utils`.
- Ensure it imports from `radix-ui` (already a dependency).

Then strip every `dark:` class from the file (`grep -n "dark:" src/components/ui/context-menu.tsx` must print nothing).

- [ ] **Step 2: Channel row menu**

In `ChannelRow`:
- Add hooks next to the existing ones:
  ```tsx
  const nav = useNavigate();
  const lastMessageId = useApp((s) => s.readStates[id]?.lastMessageId);
  ```
- Wrap the row's `<div ref={drop.setNodeRef} …>…</div>`:
  ```tsx
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>
          {/* existing <div ref={drop.setNodeRef} …> … </div> unchanged */}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
          {unread && lastMessageId && (
            <ContextMenuItem onSelect={() => void client.ack(id, lastMessageId).catch(() => undefined)}><CheckCheck />Mark as read</ContextMenuItem>
          )}
          {ch.type === "voice" && canConnect && (
            <ContextMenuItem onSelect={() => { nav(`/channels/${id}`); void voice.join(id); }}><Phone />Join voice</ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(`${location.origin}/channels/${id}`)}><Link2 />Copy link</ContextMenuItem>
          {manageable.includes(id) && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => openSettings(id)}><Settings />Channel settings</ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
  ```
- Imports:
  - `CheckCheck, Link2, Phone` added to the lucide import
  - `useNavigate` added to the `react-router-dom` import
  - `ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger` from `@/components/ui/context-menu`

`client`, `voice`, `isUnread` and `useApp` are already imported. dnd-kit's PointerSensor only starts on the primary button, so right-click does not start a drag.

- [ ] **Step 3: Category menu**

In `CategoryHeader.tsx`, wrap the outer `<div className="group/cat …">`:
```tsx
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        {/* existing <div className="group/cat …"> … </div> unchanged */}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuItem onSelect={onToggle}><ChevronDown />{collapsed ? "Expand category" : "Collapse category"}</ContextMenuItem>
        {canManage && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onAction("create")}><Plus />Create channel</ContextMenuItem>
            <ContextMenuItem onSelect={() => onAction("rename")}><Pencil />Rename category</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onAction("delete")}><Trash2 />Delete category</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
```
Add the context-menu imports.

- [ ] **Step 4: e2e check**

In `chat.spec.ts`, right after the Escape that closes settings (Task 2 Step 10), before clicking "general":
```ts
  // Right-click a channel: its menu offers the link.
  await alice.getByRole("link", { name: "general" }).click({ button: "right" });
  await expect(alice.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await alice.keyboard.press("Escape");
```

- [ ] **Step 5: Verify**

Run: `cd clients/web && pnpm typecheck`

Preview:
- Right-click a text channel: Copy link; Mark as read when unread; Channel settings as admin.
- Right-click a voice channel: Join voice.
- Right-click a category: collapse plus manage items.
- Dialogs opened from the menu get focus.
- Drag-reorder still works.

- [ ] **Step 6: Stage**

```bash
git add clients/web/src/components/ui/context-menu.tsx clients/web/src/app/sidebar clients/web/e2e/chat.spec.ts
```

---

### Task 6: Message context menu

**Files:**
- Modify: `clients/web/src/app/MessageList.tsx:322-450` (`MessageRow`)
- Modify: `clients/web/e2e/chat.spec.ts` (message menu check)

**Interfaces:**
- Consumes: the context-menu exports (Task 5).

- [ ] **Step 1: Name the toolbar callbacks once**

In `MessageRow`, after `openThread`/`jump`, add:
```tsx
  const onReply = canReply ? () => reply.setReplyTo({ id: m.id, author: m.author, content: m.content, deleted: false }) : undefined;
  const onEdit = mine ? () => { setDraft(m.content); setEditing(true); } : undefined;
  const onPin = canPin ? () => void (m.pinned ? client.unpin(m.channel_id, m.id) : client.pin(m.channel_id, m.id)).catch((e) => setError(errorText(e))) : undefined;
  const onDelete = canDelete ? () => setConfirming(true) : undefined;
  const actionable = !m.pending && !m.deleted && !editing;
```
Use them in `<MessageToolbar>`:
- `onReply={onReply}`, `onEdit={onEdit}`, `onPin={onPin}`, `onDelete={onDelete}`
- Change its guard to `{actionable && (`

- [ ] **Step 2: Wrap the article**

```tsx
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild disabled={!actionable}>
        <article id={`message-${m.id}`} /* …unchanged… */>
          {/* …unchanged children… */}
        </article>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
        {onReply && <ContextMenuItem onSelect={onReply}><Reply />Reply</ContextMenuItem>}
        {openThread && (thread
          ? <ContextMenuItem onSelect={openThread}><MessageSquare />Open thread</ContextMenuItem>
          : <ContextMenuItem onSelect={openThread}><MessageSquarePlus />Create thread</ContextMenuItem>)}
        {onEdit && <ContextMenuItem onSelect={onEdit}><Pencil />Edit message</ContextMenuItem>}
        {onPin && <ContextMenuItem onSelect={onPin}>{m.pinned ? <><PinOff />Unpin message</> : <><Pin />Pin message</>}</ContextMenuItem>}
        {m.content && <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(m.content)}><Copy />Copy text</ContextMenuItem>}
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onDelete}><Trash2 />Delete message</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
```
The existing delete-confirm `<Dialog>` currently sits inside `<article>`. It is portalled, so it can stay where it is.

Imports: add `Copy, MessageSquare, MessageSquarePlus, Pencil, PinOff, Reply, Trash2` to the lucide import (Pin is already there; check for duplicates), and the context-menu exports.

- [ ] **Step 3: e2e check**

After the pin steps (around `chat.spec.ts:363`, where `pizzaInGeneral` exists):
```ts
  await pizzaInGeneral.click({ button: "right" });
  await expect(alice.getByRole("menuitem", { name: "Copy text" })).toBeVisible();
  await alice.keyboard.press("Escape");
```

- [ ] **Step 4: Verify**

Run: `cd clients/web && pnpm typecheck && pnpm test`

Preview:
- Right-click a message: Reply sets the reply bar; Edit opens the textarea with focus; Pin/Unpin toggles; Delete asks to confirm; Copy text copies.
- Right-click a pending or deleted message: no custom menu.
- Hovering still shows the toolbar.

- [ ] **Step 5: Stage**

```bash
git add clients/web/src/app/MessageList.tsx clients/web/e2e/chat.spec.ts
```

---

### Task 7: Member list context menu

**Files:**
- Modify: `clients/web/src/app/MemberList.tsx:52-70`

**Interfaces:**
- Consumes: the context-menu exports (Task 5); `openPanel` from `./side-panel/panel`; `client.openDM(userId): Promise<Channel>`.

- [ ] **Step 1: Add the menu**

In `MemberList`:
- Add hooks:
  ```tsx
  const meId = useApp((s) => s.me?.id);
  const nav = useNavigate();
  ```
- Wrap each `<li>`:
  ```tsx
                <ContextMenu modal={false} key={m.user.id}>
                  <ContextMenuTrigger asChild>
                    <li>{/* existing ProfilePopover + RefButton unchanged */}</li>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
                    <ContextMenuItem onSelect={() => openPanel({ kind: "profile", userId: m.user.id })}><UserRound />View profile</ContextMenuItem>
                    {m.user.id !== meId && (
                      <ContextMenuItem onSelect={() => void client.openDM(m.user.id).then((ch) => nav(`/messages/${ch.id}`), () => undefined)}>
                        <MessageCircle />Message
                      </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(m.user.id)}><Copy />Copy user ID</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
  ```
  Move the `key` from `<li>` to `<ContextMenu>`.
- Imports:
  - `useNavigate` from `react-router-dom`
  - `Copy, MessageCircle, UserRound` from `lucide-react`
  - `client` added to the `../session` import
  - `openPanel` from `./side-panel/panel`
  - the context-menu exports

`PersonMenu` (voice) is unchanged: it already opens on right-click (spec §4).

- [ ] **Step 2: Verify**

Run: `cd clients/web && pnpm typecheck`

Preview:
- Right-click a member: View profile opens the side panel; Message opens the DM; there is no Message entry on yourself.
- Left click still opens the profile popover.

- [ ] **Step 3: Stage**

```bash
git add clients/web/src/app/MemberList.tsx
```

---

### Task 8: Voice join/leave sounds only for my room

This task is investigative. Use **superpowers:systematic-debugging**. No fix without a reproduced root cause.

**Files:**
- Investigate: `clients/web/src/voice/voice.ts:76-194`, `clients/web/src/sounds.ts`
- Possible modify: `clients/web/src/voice/voice.ts` (only if a code path is found)
- Possible test: `clients/web/src/voice/voice-sounds.test.ts`

Known facts:
- One LiveKit room per channel (`server/internal/voice/livekit.go:62`).
- Every `play("join"|"leave")` call is in `voice.ts`: at lines 95, 115, 165, 169 and 190. Each one is either inside `join()`/`leave()` or guarded by `mine()`.
- `sounds.ts` only plays "dm" on its own.

- [ ] **Step 1: Reproduce**

Start `datrope-server` + `datrope-web` (and the `datrope-dev-livekit` container). Set up:
- Browser context A: alice, joined to voice channel "Lounge".
- Context B: bob, NOT in voice, viewing #general.
- Context C: a second tab of bob.

Steps:
1. With alice already in Lounge, have a third user (or alice's second account) join and leave Lounge.
2. Have bob join and leave a voice channel from tab C while tab B watches.

To tell which tab plays a sound, add a temporary `console.trace("sound", sound)` inside `play()` in `sounds.ts`. Remove it afterwards. Use `read_console_messages` per tab.

Record which tab logs a sound and its stack.

- [ ] **Step 2: Decide from the evidence**

- **The sound comes from a tab that is itself in voice** (e.g. tab C while the user looks at tab B): the behaviour is correct. Remove the trace, change no code, and report to the user that another tab or window was connected.
- **A stack shows a code path firing while `voice.store.status === "idle"` or for another room:**
  - Write a failing vitest in `voice/voice-sounds.test.ts` that drives that path with a mocked `Room` (`vi.mock("livekit-client")`), and assert `play` is not called. Mock `../sounds` with `vi.mock("../sounds", () => ({ play: vi.fn() }))`.
  - Fix the guard at the source, so the sound only plays when `this.room === room && status !== "idle"`.
  - Run the test until it passes.
- **Neither reproduces:** stop and ask the user for exact steps (which tab or device was in voice, which channel the other person joined).

- [ ] **Step 3: Verify and stage**

Run: `cd clients/web && pnpm typecheck && pnpm test`

Remove the temporary trace. Stage only real changes:
```bash
git add clients/web/src/voice
```

---

### Task 9: Full verification

- [ ] **Step 1: Unit + types**

Run: `cd clients/web && pnpm typecheck && pnpm test`
Expected: clean, all pass.

- [ ] **Step 2: e2e**

Run the Playwright suite as the repo does locally. Per memory: the e2e compose override moves LiveKit to 17881/17882 (scratchpad `compose.local-ports.yml` + `livekit.local.yaml`). Only touch project `datrope-e2e`, and run `down -v` afterwards. If the override files are gone from the scratchpad, recreate them or ask the user.

Run: `cd clients/web && pnpm e2e`
Expected: the single test passes.

- [ ] **Step 3: Visual pass**

In preview, screenshot a channel with the default theme and with Gotham:
- the settings modal on Appearance
- a message context menu
- the top bar on a voice channel

Send them to the user.

- [ ] **Step 4: Stage remaining**

Run `git status` and stage anything left from this plan. Never commit.
