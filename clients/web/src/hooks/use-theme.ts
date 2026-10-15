import { useLayoutEffect, useMemo } from "react";
import { useApp } from "@/session";
import { activeVars, useActiveTheme } from "@/theme/custom";

/** Applies my theme's tokens and the server accent (readable on my theme) on <html>; the default theme is styles.css itself. */
export function useTheme() {
  useApplyColors(useApp((s) => s.server?.server.accent_color), true);
}

/** The auth pages: only the server's accent, unless my theme brings its own. */
export function useApplyAccent(hex?: string) {
  useApplyColors(hex, false);
}

function useApplyColors(accent: string | undefined, withTheme: boolean) {
  const theme = useActiveTheme();
  const vars = useMemo(() => activeVars(theme, accent, withTheme), [theme, accent, withTheme]);
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.removeProperty(k);
    };
  }, [vars]);
}
