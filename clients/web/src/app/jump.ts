import { channelRef, type ChannelRef } from "@datrope/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { client } from "../session";
import { openPanel } from "./side-panel/panel";

type Pending = { channelId: string; messageId: string } | null;
const pending = createStore<{ jump: Pending }>(() => ({ jump: null }));

export const usePendingJump = (channelId: string) =>
  useStore(pending, (s) => (s.jump?.channelId === channelId ? s.jump.messageId : undefined));
export const clearPendingJump = () => pending.setState({ jump: null });

/** Opens the conversation a message is in and asks its message list to jump there.
 *  A thread opens in the side panel of its parent channel. */
export async function openMessage(navigate: (to: string) => void, where: ChannelRef, messageId: string) {
  if (where.type === "thread" && !where.parent_id) {
    // A thread I have not seen yet is not in the store: fetch it (which stores it) to learn its parent.
    // If that fails there is nowhere sensible to go.
    try {
      await client.getChannel(where.id);
    } catch {
      return;
    }
    where = channelRef(client.store.getState(), where.id);
    if (!where.parent_id) return;
  }
  if (where.type === "thread" && where.parent_id) {
    navigate(`/channels/${where.parent_id}`);
    openPanel({ kind: "thread", threadId: where.id, parentId: where.parent_id });
  } else {
    navigate(where.type === "dm" ? `/messages/${where.id}` : `/channels/${where.id}`);
  }
  pending.setState({ jump: { channelId: where.id, messageId } });
}
