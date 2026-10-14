import { useCallback, useEffect, useRef } from "react";
import { useChrome } from "@/app/desktop-chrome";
import { cn } from "@/lib/utils";

/** For 56 px header bands in the desktop app: marks the one at the window's left edge (macOS traffic lights) and
 *  the one at its right edge (window buttons), so they can pad themselves. */
export function useTitleBarEdges() {
  const claimed = useChrome((s) => s.claimed);
  const el = useRef<HTMLElement | null>(null);
  const update = useCallback(() => {
    const e = el.current;
    if (!e) return;
    const r = e.getBoundingClientRect();
    e.toggleAttribute("data-edge-left", claimed && r.left <= 1);
    e.toggleAttribute("data-edge-right", claimed && r.right >= window.innerWidth - 1);
  }, [claimed]);
  useEffect(() => {
    update();
    const ro = new ResizeObserver(update);
    if (el.current) ro.observe(el.current);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [update]);
  return useCallback((node: HTMLElement | null) => {
    el.current = node;
    update();
  }, [update]);
}

/** A header band's classes plus the ones that clear the window buttons (right edge) and the macOS traffic lights (left edge). */
export function useTitleBarClass(className?: string) {
  const mac = useChrome((s) => s.platform === "macos");
  return cn(className, "data-[edge-right]:pr-[calc(1rem+var(--titlebar-right,0px))]", mac && "data-[edge-left]:pl-[72px]");
}
