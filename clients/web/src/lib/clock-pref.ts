import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** 12- or 24-hour clock for times in messages; auto follows the locale. Kept on this device. */
export type ClockPref = "auto" | "12" | "24";

const KEY = "datrope.clock";
const storage = (): Storage | undefined => {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
};
const read = (): ClockPref => {
  try {
    const v = storage()?.getItem(KEY);
    return v === "12" || v === "24" ? v : "auto";
  } catch {
    return "auto";
  }
};

export const clockStore = createStore<{ pref: ClockPref }>(() => ({ pref: read() }));
export const getClockPref = () => clockStore.getState().pref;
export function setClockPref(pref: ClockPref) {
  clockStore.setState({ pref });
  try { storage()?.setItem(KEY, pref); } catch { /* private mode: this session only */ }
}
export const useClockPref = () => useStore(clockStore, (s) => s.pref);
