import type { State } from "@datrope/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { isUnread } from "../session";
import { isUnreadType } from "./channel-types";

/** What the desktop rail shows for this server: a dot for unread channels, a count of mentions and unread DMs. */
export function badgeFor(s: Pick<State, "readStates" | "channels" | "dmIds" | "mentions">): { unread: boolean; mentions: number } {
  const dms = s.dmIds.filter((id) => isUnread(s.readStates[id])).length;
  const unread = Object.entries(s.readStates).some(([id, rs]) => isUnreadType(s.channels[id]?.type) && isUnread(rs));
  return { unread: unread || dms > 0, mentions: s.mentions.unread + dms };
}

/** The global push-to-talk key to hold registered: only during a call with push to talk on. */
export function pttKeyFor(mode: "vad" | "ptt", code: string, inCall: boolean): string | null {
  return inCall && mode === "ptt" ? code : null;
}

/** Why the global push-to-talk key couldn't be registered (shown in voice settings). */
export const desktopPtt = createStore<{ error: string | null }>(() => ({ error: null }));
export const useDesktopPttError = () => useStore(desktopPtt, (s) => s.error);
