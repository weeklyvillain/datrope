import { errorText } from "../../session";

export type SearchState<T> = { found: T[] | null; error: string }; // found is null when there is no query

/** Debounced note search: only the newest query's answer counts, so slow responses never show stale results. */
export function createNoteSearch<T>({ list, delay, onChange }: {
  list: (q: string) => Promise<T[]>; delay: number; onChange: (s: SearchState<T>) => void;
}) {
  let query = "";
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: SearchState<T> = { found: null, error: "" };
  const emit = (s: SearchState<T>) => { state = s; onChange(s); };
  const start = () => {
    clearTimeout(timer);
    const mine = ++seq;
    if (!query) {
      emit({ found: null, error: "" });
      return;
    }
    if (state.error) emit({ ...state, error: "" }); // results stay until the new ones arrive
    timer = setTimeout(() => list(query).then(
      (found) => { if (mine === seq) emit({ found, error: "" }); },
      (e: unknown) => { if (mine === seq) emit({ found: null, error: errorText(e) }); },
    ), delay);
  };
  return {
    set(q: string) {
      const next = q.trim();
      const changed = next !== query;
      query = next;
      if (changed) start();
    },
    /** The list changed: ask again for the current query. */
    refresh: () => { if (query) start(); },
    dispose: () => { clearTimeout(timer); seq++; },
  };
}
