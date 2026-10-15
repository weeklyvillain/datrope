import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { DEFAULT_THEME, THEMES, type ThemeId } from "./themes";

/** A built-in theme, or "custom:<id>" for one of my custom themes. */
export type ThemePref = ThemeId | `custom:${string}`;

const KEY = "datrope.theme";

/** A known theme ID or a custom theme reference, else the default. */
export function sanitize(raw: unknown): ThemePref {
  if (typeof raw !== "string") return DEFAULT_THEME;
  if (/^custom:.+/.test(raw)) return raw as ThemePref;
  return Object.hasOwn(THEMES, raw) ? (raw as ThemeId) : DEFAULT_THEME;
}

function load(): ThemePref {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? DEFAULT_THEME : sanitize(JSON.parse(raw));
  } catch {
    return DEFAULT_THEME; // unavailable or unreadable: the choice then lasts for this session
  }
}

const themePref = createStore<{ theme: ThemePref }>(() => ({ theme: load() }));

themePref.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s.theme));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
});

export const useThemeId = () => useStore(themePref, (s) => s.theme);
export const setTheme = (theme: ThemePref) => themePref.setState({ theme });
export const themePrefNow = () => themePref.getState().theme;

// Another tab picked a theme: follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) themePref.setState({ theme: load() });
  });
}
