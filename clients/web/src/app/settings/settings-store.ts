import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { MOBILE_QUERY } from "@/hooks/use-mobile";

export type SettingsSection = "profile" | "connections" | "sessions" | "notifications" | "voice" | "appearance";
type SettingsState = { open: boolean; section: SettingsSection; notice?: string };

/** Whether the "Your settings" modal is open, and on which section. */
export const settingsStore = createStore<SettingsState>(() => ({ open: false, section: "profile" }));

/** Phones open settings as a page; MobileShell registers its navigate here (and clears it while the rules gate blocks /you). */
export let settingsNavigate: ((path: string) => void) | null = null;
export const setSettingsNavigate = (f: ((path: string) => void) | null) => { settingsNavigate = f; };

export const openSettings = (section: SettingsSection = "profile", notice?: string) => {
  if (settingsNavigate && typeof window !== "undefined" && window.matchMedia?.(MOBILE_QUERY).matches) {
    settingsStore.setState({ section, notice });
    settingsNavigate(`/you/${section}`);
  } else settingsStore.setState({ open: true, section, notice });
};
export const closeSettings = () => settingsStore.setState({ open: false, notice: undefined });
export const closeNotice = () => settingsStore.setState({ notice: undefined });
export const showSection = (section: SettingsSection) => settingsStore.setState({ section });

export function useSettings<T>(select: (s: SettingsState) => T): T {
  return useStore(settingsStore, select);
}
