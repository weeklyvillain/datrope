import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { MOBILE_QUERY } from "@/hooks/use-mobile";

export type SettingsSection = "profile" | "connections" | "sessions" | "notifications" | "voice" | "appearance";
type SettingsState = { section: SettingsSection; notice?: string };

/** The section "Your settings" was last opened on, and a notice to show there (e.g. after linking an account). */
export const settingsStore = createStore<SettingsState>(() => ({ section: "profile" }));

/** Settings open as a page: /you/:section on phones (MobileShell registers its navigate, and clears it while the rules gate blocks /you), /settings/:section on desktop (AppShell). */
export let settingsNavigate: ((path: string) => void) | null = null;
export const setSettingsNavigate = (f: ((path: string) => void) | null) => { settingsNavigate = f; };

/** While the rules gate blocks /you, phones use /settings too (AppShell sets this). */
let gated = false;
export const setSettingsGated = (g: boolean) => { gated = g; };

export const openSettings = (section: SettingsSection = "profile", notice?: string) => {
  settingsStore.setState({ section, notice });
  if (!settingsNavigate) return;
  const phone = typeof window !== "undefined" && window.matchMedia?.(MOBILE_QUERY).matches;
  settingsNavigate(phone && !gated ? `/you/${section}` : `/settings/${section}`);
};
export const closeNotice = () => settingsStore.setState({ notice: undefined });

export function useSettings<T>(select: (s: SettingsState) => T): T {
  return useStore(settingsStore, select);
}
