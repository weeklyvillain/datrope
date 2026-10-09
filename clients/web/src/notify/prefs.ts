import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type NotifyLevel = "all" | "mentions" | "nothing";
/** Notification settings that stay on this device. */
export type NotifyPrefs = { enabled: boolean; level: NotifyLevel };

const KEY = "datrope.notifyPrefs";
const defaults: NotifyPrefs = { enabled: false, level: "mentions" };
const levels: readonly unknown[] = ["all", "mentions", "nothing"];

/** Keeps each valid stored field and falls back to the default for the rest. */
export function sanitize(raw: unknown): NotifyPrefs {
  if (!raw || typeof raw !== "object") return defaults;
  const p = raw as Record<string, unknown>;
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : defaults.enabled,
    level: levels.includes(p.level) ? (p.level as NotifyLevel) : defaults.level,
  };
}

function load(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? defaults : sanitize(JSON.parse(raw));
  } catch {
    return defaults; // unavailable or unreadable: settings then last for this session
  }
}

export const notifyPrefs = createStore<NotifyPrefs>(() => load());

notifyPrefs.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
});

export function useNotifyPrefs<T>(selector: (p: NotifyPrefs) => T): T {
  return useStore(notifyPrefs, selector);
}

export const setNotifyEnabled = (on: boolean) => notifyPrefs.setState({ enabled: on });
export const setNotifyLevel = (level: NotifyLevel) => notifyPrefs.setState({ level });

// Another tab changed the settings: follow it, so a switch turned off there stops notifications here.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) notifyPrefs.setState(load());
  });
}
