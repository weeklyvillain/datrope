import { useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { createSwipe } from "@/lib/swipe";

/** True when the touch started inside a horizontally scrollable element (a code block), below `row`. */
function startsInHorizontalScroller(e: PointerEvent): boolean {
  const row = e.currentTarget as Element;
  let el = e.target as Element | null;
  while (el && el !== row) {
    if (el.scrollWidth > el.clientWidth) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Swipe a message to the right to reply (touch only). The row needs `touch-action: pan-y` so the browser
 * does not claim horizontal pans. `cancel()` aborts the swipe (e.g. when a long-press fires).
 */
export function useSwipeReply(onReply: () => void, enabled: boolean) {
  const [offset, setOffset] = useState(0);
  const cb = useRef(onReply);
  cb.current = onReply;
  const s = useMemo(() => createSwipe(), []);
  // Gestures that began in a horizontal scroller belong to it, not to the swipe.
  const ignored = useRef(false);
  const on = (e: PointerEvent) => enabled && e.pointerType === "touch";
  return {
    offset,
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        if (!on(e)) return;
        ignored.current = startsInHorizontalScroller(e);
        if (!ignored.current) s.down(e.clientX, e.clientY);
      },
      onPointerMove: (e: PointerEvent) => { if (on(e) && !ignored.current) setOffset(s.move(e.clientX, e.clientY).dx); },
      onPointerUp: (e: PointerEvent) => {
        if (!on(e) || ignored.current) { ignored.current = false; return; }
        if (s.up()) { navigator.vibrate?.(10); cb.current(); }
        setOffset(0);
      },
      onPointerCancel: () => { ignored.current = false; s.up(); setOffset(0); },
    },
    cancel: () => { ignored.current = true; s.up(); setOffset(0); },
  };
}
