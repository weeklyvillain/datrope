import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type SettingsSection = "profile" | "sessions" | "notifications" | "appearance";
type SettingsState = { open: boolean; section: SettingsSection };

/** Whether the "Your settings" modal is open, and on which section. */
export const settingsStore = createStore<SettingsState>(() => ({ open: false, section: "profile" }));

export const openSettings = (section: SettingsSection = "profile") => settingsStore.setState({ open: true, section });
export const closeSettings = () => settingsStore.setState({ open: false });
export const showSection = (section: SettingsSection) => settingsStore.setState({ section });

export function useSettings<T>(select: (s: SettingsState) => T): T {
  return useStore(settingsStore, select);
}
