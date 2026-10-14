import { useEffect, useState } from "react";
import { TIER_QUERIES, tierFor, type LayoutTier } from "@/lib/layout-tier";

const current = (): LayoutTier => (typeof window === "undefined" ? "wide" : tierFor(window.innerWidth));

/** The window's layout tier; follows resizing (one listener per breakpoint, not per resize event). */
export function useLayoutTier(): LayoutTier {
  const [tier, setTier] = useState(current);
  useEffect(() => {
    const mqs = Object.values(TIER_QUERIES).map((q) => window.matchMedia?.(q)).filter((m): m is MediaQueryList => !!m);
    const on = () => setTier(current());
    on();
    for (const m of mqs) m.addEventListener("change", on);
    return () => { for (const m of mqs) m.removeEventListener("change", on); };
  }, []);
  return tier;
}
