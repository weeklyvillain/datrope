import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { layers } from "@/hooks/use-history-layer";
import { panelToParam } from "./panel-param";

/** What the side panel shows: nothing, the threads list, a thread, a forum post, a gallery item, or search. */
export type Panel =
  | null
  | { kind: "threads" }
  | { kind: "thread"; threadId: string; parentId?: string } // parentId: kept open when that channel opens
  | { kind: "post"; postId: string; forumId: string } // forumId: kept open when that forum opens
  | { kind: "media"; attachmentId: string }
  | { kind: "search" };

type PanelState = { panel: Panel; query: string; profile: string | null }; // profile: whose full profile is in the drawer

export const panelStore = createStore<PanelState>(() => ({ panel: null, query: "", profile: null }));

export function usePanel<T>(select: (s: PanelState) => T): T {
  return useStore(panelStore, select);
}

/** The current page's URL with `?panel=` set for `p` (or removed). */
export function urlWithPanel(p: Panel): string {
  const q = new URLSearchParams(window.location.search);
  const v = panelToParam(p);
  if (v) q.set("panel", v);
  else q.delete("panel");
  const s = q.toString();
  return window.location.pathname + (s ? `?${s}` : "") + window.location.hash;
}

const clearPanel = () => panelStore.setState({ panel: null });

/** Opens a panel as a history entry (Back closes it) and records it in `?panel=` so a reload keeps it. */
export function openPanel(p: Panel) {
  if (!p) return closePanel();
  const wasOpen = panelStore.getState().panel !== null;
  panelStore.setState({ panel: p });
  if (typeof window === "undefined") return layers.open("panel", clearPanel);
  // Swapping panels rewrites our own entry's URL; with another layer on top (the profile) that entry is not ours to touch.
  if (wasOpen && layers.isTop("panel")) window.history.replaceState(window.history.state, "", urlWithPanel(p));
  layers.open("panel", clearPanel, urlWithPanel(p));
}
export function closePanel() {
  if (panelStore.getState().panel) layers.close("panel");
  else clearPanel();
}
export const setSearchQuery = (q: string) => panelStore.setState({ query: q });
/** Opens someone's full profile in the drawer, over whatever the side panel shows. */
export const openProfile = (userId: string) => panelStore.setState({ profile: userId });
export const closeProfile = () => panelStore.setState({ profile: null });
