import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** What the side panel shows: nothing, the threads list, a thread, a forum post, a gallery item, or search. */
export type Panel =
  | null
  | { kind: "threads" }
  | { kind: "thread"; threadId: string; parentId?: string } // parentId: kept open when that channel opens
  | { kind: "post"; postId: string; forumId: string } // forumId: kept open when that forum opens
  | { kind: "media"; channelId: string; messageId: string; attachmentId: string }
  | { kind: "search" };

type PanelState = { panel: Panel; query: string; profile: string | null }; // profile: whose full profile is in the drawer

export const panelStore = createStore<PanelState>(() => ({ panel: null, query: "", profile: null }));

export function usePanel<T>(select: (s: PanelState) => T): T {
  return useStore(panelStore, select);
}

export const openPanel = (p: Panel) => panelStore.setState({ panel: p });
export const closePanel = () => panelStore.setState({ panel: null });
export const setSearchQuery = (q: string) => panelStore.setState({ query: q });
/** Opens someone's full profile in the drawer, over whatever the side panel shows. */
export const openProfile = (userId: string) => panelStore.setState({ profile: userId });
export const closeProfile = () => panelStore.setState({ profile: null });
