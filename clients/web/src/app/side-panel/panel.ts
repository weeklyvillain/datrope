import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** What the side panel shows: nothing, the threads list, a thread, someone's profile, or search. */
export type Panel =
  | null
  | { kind: "threads" }
  | { kind: "thread"; threadId: string; parentId?: string } // parentId: kept open when that channel opens
  | { kind: "profile"; userId: string }
  | { kind: "search" };

type PanelState = { panel: Panel; query: string };

export const panelStore = createStore<PanelState>(() => ({ panel: null, query: "" }));

export function usePanel<T>(select: (s: PanelState) => T): T {
  return useStore(panelStore, select);
}

export const openPanel = (p: Panel) => panelStore.setState({ panel: p });
export const closePanel = () => panelStore.setState({ panel: null });
export const setSearchQuery = (q: string) => panelStore.setState({ query: q });
