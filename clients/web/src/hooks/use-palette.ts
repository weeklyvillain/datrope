import { useEffect } from "react";
import { PALETTES, type Palette } from "@/lib/palettes";
import { useApp } from "@/session";
import { useThemeId } from "@/theme/prefs";
import { DEFAULT_THEME } from "@/theme/themes";

/** Applies the server's palette: --primary and --ring follow its accent (--online is left alone). A picked theme wins. */
export function usePalette() {
  useApplyPalette(useApp((s) => s.server?.server.palette));
}

/** usePalette for a palette known outside the store (the auth pages). */
export function useApplyPalette(palette?: Palette) {
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
