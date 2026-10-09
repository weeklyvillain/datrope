import { useEffect } from "react";
import { PALETTES } from "@/lib/palettes";
import { useApp } from "@/session";

/** Applies the server's palette: --primary and --ring follow its accent (--online stays green). */
export function usePalette() {
  const palette = useApp((s) => s.server?.server.palette);
  useEffect(() => {
    if (!palette) return;
    const root = document.documentElement.style;
    const { accent } = PALETTES[palette] ?? PALETTES.emerald;
    root.setProperty("--primary", accent);
    root.setProperty("--ring", accent);
    return () => {
      root.removeProperty("--primary");
      root.removeProperty("--ring");
    };
  }, [palette]);
}
