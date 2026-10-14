import { useMemo, useRef } from "react";
import type { PointerEvent, MouseEvent } from "react";
import { claimEvent, createLongPress } from "@/lib/long-press";

const claimed = new WeakSet<object>();

/** Put on a nested control's (or its portalled menu's) onPointerDown so an enclosing long-press target ignores presses that start inside it. */
export const claimLongPress = (e: PointerEvent) => { claimEvent(claimed, e.nativeEvent); };

/** Long-press for touch and pen; mouse keeps its right-click menu. */
export function useLongPress(onLongPress: () => void, enabled = true) {
  const cb = useRef(onLongPress);
  cb.current = onLongPress;
  const suppress = useRef(false);
  const lp = useMemo(() => createLongPress({ onLongPress: () => { navigator.vibrate?.(10); cb.current(); } }), []);
  const touch = (e: PointerEvent) => enabled && e.pointerType !== "mouse";
  return {
    onPointerDown: (e: PointerEvent) => {
      suppress.current = false;
      // A nested target (reaction pill in a message) claims the event first; outer targets skip.
      if (touch(e) && claimEvent(claimed, e.nativeEvent)) lp.down(e.clientX, e.clientY);
    },
    onPointerMove: (e: PointerEvent) => { if (touch(e)) lp.move(e.clientX, e.clientY); },
    onPointerUp: (e: PointerEvent) => { if (touch(e)) suppress.current = lp.up(); },
    onPointerCancel: () => lp.cancel(),
    onClickCapture: (e: MouseEvent) => { if (suppress.current) { e.preventDefault(); e.stopPropagation(); suppress.current = false; } },
    onContextMenu: (e: MouseEvent) => {
      if (enabled && (e.nativeEvent as globalThis.PointerEvent).pointerType !== "mouse" && window.matchMedia("(pointer: coarse)").matches) {
        e.preventDefault();
        // Android sends contextmenu (~400 ms) and may pointercancel before our timer: fire now.
        if (lp.fire()) suppress.current = true;
      }
    },
  };
}
