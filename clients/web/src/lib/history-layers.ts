export type HistoryLike = {
  push(state: unknown, url?: string): void;
  replace(state: unknown, url?: string): void;
  back(): void;
  current(): unknown;
};
export type Layers = {
  /** Opens a layer as a history entry. Re-opening an open id only swaps its onClose. */
  open(id: string, onClose: () => void, url?: string): void;
  /** UI close: removes the layer, calls onClose now, and pops its entry if it is the top one. */
  close(id: string): void;
  /** Unmount: like close, but without calling onClose. */
  dispose(id: string): void;
  /** Feed every popstate here. Closes the layers whose id the landed entry no longer lists. */
  popped(state: unknown): void;
  depth(): number;
  /** Is the current history entry a layer? Navigate with `replace` then, so Back has no dead step. */
  onTop(): boolean;
  /** Is `id` the top layer of the current entry? */
  isTop(id: string): boolean;
};

const KEY = "datropeLayer";
type Entry = { id: string; onClose: () => void };
type Queued = Entry & { url?: string };

const isObj = (s: unknown): s is Record<string, unknown> => !!s && typeof s === "object";
/** The chain of open layer ids recorded in a history state (empty when it is not a layer entry). */
const idsOf = (state: unknown): string[] => {
  const v = isObj(state) ? state[KEY] : undefined;
  return isObj(v) && Array.isArray(v.ids) ? (v.ids as string[]) : [];
};

/** `state` without the layer record, other keys (the router's idx/key/usr) kept; used when a reload lands on a layer entry. */
export function stripLayer(state: unknown): unknown {
  if (!isObj(state) || !(KEY in state)) return state;
  const { [KEY]: _drop, ...rest } = state;
  return rest;
}

/** Phone layers (panels, sheets, full-screen screens) as history entries, so Back closes the top one. */
export function createLayers(h: HistoryLike): Layers {
  const stack: Entry[] = [];
  const queued: Queued[] = [];
  let pendingBacks = 0;

  const push = (e: Queued) => {
    stack.push({ id: e.id, onClose: e.onClose });
    const prev = h.current();
    h.push({ ...(isObj(prev) ? prev : {}), [KEY]: { ids: stack.map((s) => s.id) } }, e.url);
  };
  /** Takes `id` out of the stack/queue; true when it was in the stack. Pops its entry when it tops the current one. */
  const remove = (id: string): Entry | undefined => {
    const q = queued.findIndex((e) => e.id === id);
    if (q >= 0) queued.splice(q, 1);
    const at = stack.findIndex((e) => e.id === id);
    if (at < 0) return undefined;
    const [entry] = stack.splice(at, 1);
    const ids = idsOf(h.current());
    if (ids[ids.length - 1] === id) {
      pendingBacks++;
      h.back();
    }
    return entry;
  };

  return {
    open(id, onClose, url) {
      const at = stack.findIndex((e) => e.id === id);
      if (at >= 0) { stack[at].onClose = onClose; return; }
      const q = queued.find((e) => e.id === id);
      if (q) { q.onClose = onClose; q.url = url; return; }
      if (pendingBacks > 0) { queued.push({ id, onClose, url }); return; }
      push({ id, onClose, url });
    },
    close(id) {
      remove(id)?.onClose();
    },
    dispose(id) {
      remove(id);
    },
    popped(state) {
      if (pendingBacks > 0) {
        if (--pendingBacks === 0) for (const e of queued.splice(0)) push(e);
        return;
      }
      const ids = idsOf(state);
      for (let i = stack.length - 1; i >= 0; i--) {
        if (ids.includes(stack[i].id)) continue;
        stack.splice(i, 1)[0].onClose();
      }
    },
    depth: () => stack.length,
    onTop: () => idsOf(h.current()).length > 0,
    isTop: (id) => { const ids = idsOf(h.current()); return ids[ids.length - 1] === id; },
  };
}
