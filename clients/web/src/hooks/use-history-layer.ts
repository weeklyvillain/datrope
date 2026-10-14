import { useEffect, useRef } from "react";
import { useNavigate, type NavigateOptions, type To } from "react-router-dom";
import { createLayers, stripLayer } from "@/lib/history-layers";

// Without a window (unit tests) layers still track open/close; they just have no history entries.
const hist = () => (typeof window === "undefined" ? undefined : window.history);

export const layers = createLayers({
  push: (s, url) => hist()?.pushState(s, "", url),
  replace: (s, url) => hist()?.replaceState(s, "", url),
  back: () => hist()?.back(),
  current: () => hist()?.state,
});
if (typeof window !== "undefined") {
  // A reload can land on a layer entry whose layers no longer exist: forget them, or the first Back does nothing.
  const state = window.history.state;
  if (stripLayer(state) !== state) window.history.replaceState(stripLayer(state), "");
  window.addEventListener("popstate", (e) => layers.popped(e.state));
}

/** While `open`, the layer owns a history entry: Back calls onClose; closing in the UI pops the entry. */
export function useHistoryLayer(id: string, open: boolean, onClose: () => void) {
  const cb = useRef(onClose);
  cb.current = onClose;
  const mounted = useRef(false);
  // Declared first so on unmount it runs before the layer effect's cleanup.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!open) return;
    layers.open(id, () => cb.current());
    return () => (mounted.current ? layers.close(id) : layers.dispose(id));
  }, [id, open]);
}

/** `navigate` for links inside a layer (the phone drawer): replaces the layer's entry instead of stacking on it. */
export function useLayerNavigate() {
  const navigate = useNavigate();
  return (to: To, opts?: NavigateOptions) => navigate(to, { ...opts, replace: opts?.replace ?? layers.onTop() });
}
