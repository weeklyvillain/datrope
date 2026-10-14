export function createLongPress(o: {
  delay?: number; tolerance?: number; onLongPress: () => void;
  schedule?: (fn: () => void, ms: number) => unknown; cancel?: (t: unknown) => void;
}) {
  const delay = o.delay ?? 500, tol = o.tolerance ?? 8;
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = o.cancel ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown = null, x = 0, y = 0, fired = false;
  const stop = () => { if (timer !== null) clear(timer); timer = null; };
  return {
    down(px: number, py: number) {
      stop(); x = px; y = py; fired = false;
      timer = schedule(() => { timer = null; fired = true; o.onLongPress(); }, delay);
    },
    move(px: number, py: number) { if (Math.hypot(px - x, py - y) > tol) stop(); },
    up() { stop(); const f = fired; fired = false; return f; },
    /** Fire a still-pending press now (Android sends contextmenu before our timer). False if already fired or idle. */
    fire() {
      if (timer === null) return false;
      stop(); fired = true; o.onLongPress(); return true;
    },
    cancel() { stop(); fired = false; },
  };
}

/** Marks an event as claimed; false if it already was. The innermost long-press target claims first (React bubbles inner to outer). */
export function claimEvent(claimed: WeakSet<object>, ev: object): boolean {
  if (claimed.has(ev)) return false;
  claimed.add(ev);
  return true;
}
