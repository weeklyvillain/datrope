import { useLayoutEffect } from "react";
import { useThemeId } from "@/theme/prefs";
import { DEFAULT_THEME, THEMES, themeVars } from "@/theme/themes";

/** Applies my theme's tokens on <html>; the default theme is styles.css itself. */
export function useTheme() {
  const id = useThemeId();
  useLayoutEffect(() => {
    if (id === DEFAULT_THEME) return;
    const vars = themeVars(THEMES[id].colors);
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.removeProperty(k);
    };
  }, [id]);
}
