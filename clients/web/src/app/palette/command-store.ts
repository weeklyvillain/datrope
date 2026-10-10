import type { Channel } from "@datrope/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

type CommandState = { open: boolean };

/** Whether the command palette (Ctrl/Cmd+K) is open. */
export const commandStore = createStore<CommandState>(() => ({ open: false }));

export const toggleCommands = () => commandStore.setState((s) => ({ open: !s.open }));
export const closeCommands = () => commandStore.setState({ open: false });

export function useCommands<T>(select: (s: CommandState) => T): T {
  return useStore(commandStore, select);
}

/** The existing one-to-one DM between me and userId, if any. */
export function findDM(dmIds: string[], channels: Record<string, Channel | undefined>, meId: string, userId: string): string | undefined {
  return dmIds.find((id) => {
    const others = channels[id]?.participants?.filter((p) => p.id !== meId) ?? [];
    return others.length === 1 && others[0].id === userId;
  });
}
