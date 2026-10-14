import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type ChromeState = {
  claimed: boolean;
  maximized: boolean;
  updateReady: boolean;
  platform: "windows" | "macos" | "linux";
  others: { unread: boolean; mentions: number };
};

/** What the desktop shell tells this page about its window: whether the page draws the title bar, and the rail's state. */
export const chromeStore = createStore<ChromeState>(() => ({
  claimed: false,
  maximized: false,
  updateReady: false,
  platform: "windows",
  others: { unread: false, mentions: 0 },
}));

export const useChrome = <T,>(select: (s: ChromeState) => T) => useStore(chromeStore, select);
