import { useEffect } from "react";
import { keyboardInset } from "@/lib/keyboard-inset";

/** Keeps --keyboard-inset in step with the on-screen keyboard (iOS overlays it; Android resizes). */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--keyboard-inset", `${keyboardInset(window.innerHeight, vv)}px`);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);
}
