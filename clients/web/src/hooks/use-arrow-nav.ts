import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { nextIndex } from "@/lib/roving";

/** Roving focus over `selector` inside `ref`: one item is in the tab order; arrows, Home and End move between items.
 *  `companions` are a row's own buttons (beside its item, in the same parent): only the roving row's stay tabbable.
 *  The container may mount later or change (a list rendered only once it has rows): the keys follow it. */
export function useArrowNav(ref: RefObject<HTMLElement>, selector: string,
  opts: { orientation?: "vertical" | "horizontal" | "grid"; columns?: () => number; companions?: string } = {}) {
  const { orientation, companions } = opts;
  const columnsRef = useRef(opts.columns);
  columnsRef.current = opts.columns;
  const [root, setRoot] = useState<HTMLElement | null>(null);
  // Every render: a ref doesn't say when it changes. Sets state only when the element did, so it settles at once.
  useLayoutEffect(() => { // eslint-disable-line react-hooks/exhaustive-deps
    if (ref.current !== root) setRoot(ref.current);
  });
  useEffect(() => {
    if (!root) return;
    const items = () => [...root.querySelectorAll<HTMLElement>(selector)];
    // The last item that held focus or the roving stop; survives re-renders while it stays in the list.
    let stop: HTMLElement | null = null;
    const settle = (active?: HTMLElement) => {
      const all = items();
      const remembered = stop && stop.isConnected && all.includes(stop) ? stop : null;
      const current = active ?? remembered ?? all.find((el) => el.getAttribute("aria-current") === "page") ?? all[0];
      stop = current ?? null;
      for (const el of all) el.tabIndex = el === current ? 0 : -1;
      if (companions) {
        for (const el of root.querySelectorAll<HTMLElement>(companions)) el.tabIndex = current && el.parentElement?.contains(current) ? 0 : -1;
      }
    };
    settle();
    const onFocus = (e: FocusEvent) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(selector);
      if (t && root.contains(t)) settle(t);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      const all = items();
      const i = all.indexOf(e.target as HTMLElement);
      if (i < 0) return; // keys inside an item's own controls are theirs
      const n = nextIndex(e.key, i, all.length, orientation, columnsRef.current?.() ?? 1);
      if (n === null) return;
      e.preventDefault();
      all[n]?.focus();
    };
    const mo = new MutationObserver(() => settle());
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    root.addEventListener("focusin", onFocus);
    root.addEventListener("keydown", onKey);
    return () => { mo.disconnect(); root.removeEventListener("focusin", onFocus); root.removeEventListener("keydown", onKey); };
  }, [root, selector, orientation, companions]);
}
