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
