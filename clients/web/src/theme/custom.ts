import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { DEFAULT_SURFACES, deriveTheme, normalizeHex, readableAccent } from "@/lib/color";
import { setTheme, themePrefNow, useThemeId, type ThemePref } from "./prefs";
import { DEFAULT_THEME, THEMES, themeVars, type ThemeId } from "./themes";

/** A theme I made from one colour (spec: custom colors §4). Kept on this device. */
export type CustomTheme = { id: string; name: string; seed: string; ownAccent: boolean };

export const MAX_CUSTOM_THEMES = 12;
const KEY = "datrope.customThemes";

/** Valid themes only: unique id, a 1–32 character name, a hex seed; at most MAX_CUSTOM_THEMES. */
export function sanitizeList(raw: unknown): CustomTheme[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomTheme[] = [];
  for (const t of raw) {
    if (out.length === MAX_CUSTOM_THEMES) break;
    if (!t || typeof t !== "object") continue;
    const { id, name, seed, ownAccent } = t as Record<string, unknown>;
    const n = typeof name === "string" ? name.trim().slice(0, 32) : "";
    const hex = typeof seed === "string" ? normalizeHex(seed) : undefined;
    if (typeof id !== "string" || !id || !n || !hex || out.some((o) => o.id === id)) continue;
    out.push({ id, name: n, seed: hex, ownAccent: ownAccent === true });
  }
  return out;
}

function load(): CustomTheme[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? [] : sanitizeList(JSON.parse(raw));
  } catch {
    return [];
  }
}

const customThemes = createStore<{ list: CustomTheme[] }>(() => ({ list: load() }));

customThemes.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s.list));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
});

// The active custom theme went away (deleted here or in another tab): back to the default.
customThemes.subscribe(({ list }) => {
  const pref = themePrefNow();
  if (pref.startsWith("custom:") && !list.some((o) => customPref(o.id) === pref)) setTheme(DEFAULT_THEME);
});

export const useCustomThemes = () => useStore(customThemes, (s) => s.list);

export const customPref = (id: string): ThemePref => `custom:${id}`;
export const newThemeId = () => Math.random().toString(36).slice(2, 10);

/** Adds the theme, or replaces the one with its id. False when adding would pass the limit (another tab may have filled it). */
export function saveCustomTheme(t: CustomTheme): boolean {
  const { list } = customThemes.getState();
  const exists = list.some((o) => o.id === t.id);
  if (!exists && list.length >= MAX_CUSTOM_THEMES) return false;
  customThemes.setState({ list: exists ? list.map((o) => (o.id === t.id ? t : o)) : [...list, t] });
  return true;
}

export function removeCustomTheme(id: string) {
  customThemes.setState(({ list }) => ({ list: list.filter((o) => o.id !== id) }));
}

/** What the active theme sets: its tokens (none for the default), whether it owns the accent, and the surfaces a server accent must read on. */
export type ResolvedTheme = { vars?: Record<string, string>; ownsAccent: boolean; surfaces?: string[] };

export function resolveTheme(pref: ThemePref, list: CustomTheme[]): ResolvedTheme {
  if (pref === DEFAULT_THEME) return { ownsAccent: false };
  if (!pref.startsWith("custom:")) return { vars: themeVars(THEMES[pref as ThemeId].colors), ownsAccent: true };
  const t = list.find((o) => customPref(o.id) === pref);
  if (!t) return { ownsAccent: false };
  const vars = deriveTheme(t.seed, { ownAccent: t.ownAccent });
  return { vars, ownsAccent: t.ownAccent, surfaces: [vars["--background"]!, vars["--sidebar"]!, vars["--card"]!] };
}

/**
 * Every token to set on <html>: the theme's (when `withTheme`) and the server accent, made readable on the theme's
 * surfaces, unless the theme brings its own. One map, so one effect owns it and neither part can undo the other.
 */
export function activeVars(theme: ResolvedTheme, accent: string | undefined, withTheme: boolean): Record<string, string> {
  const out = withTheme ? { ...theme.vars } : {};
  if (accent && !theme.ownsAccent) {
    const { primary, primaryForeground } = readableAccent(accent, theme.surfaces ?? DEFAULT_SURFACES);
    Object.assign(out, { "--primary": primary, "--primary-foreground": primaryForeground, "--ring": primary });
  }
  return out;
}

export function useActiveTheme() {
  const pref = useThemeId();
  const list = useCustomThemes();
  return useMemo(() => resolveTheme(pref, list), [pref, list]);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) customThemes.setState({ list: load() });
  });
}
