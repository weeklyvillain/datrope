import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** Voice settings that stay on this device and are never sent. Missing entries mean the default. */
export type VoicePrefs = {
  volume: Record<string, number>; // user ID → percent, 0–200 (default 100)
  mutedForMe: Record<string, boolean>;
  hideVideo: Record<string, boolean>;
  screenVolume: Record<string, number>; // sharer's user ID → percent, 0–200 (default 100)
  soundboardVolume: number; // percent, 0–100
  favourites: string[]; // sound IDs
};

const KEY = "datrope.voicePrefs";

const defaults: VoicePrefs = { volume: {}, mutedForMe: {}, hideVideo: {}, screenVolume: {}, soundboardVolume: 60, favourites: [] };

const clamp = (n: number, max: number) => Math.min(max, Math.max(0, Math.round(n)));

/** Keeps the entries of a stored map whose values pass `keep`, mapped by `fix`. */
function entries<T>(v: unknown, keep: (x: unknown) => x is T, fix: (x: T) => T = (x) => x): Record<string, T> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v)) if (keep(x)) out[k] = fix(x);
  return out;
}

const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isBool = (x: unknown): x is boolean => typeof x === "boolean";

function load(): VoicePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return defaults;
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== "object") return defaults;
    const pct = (x: number) => clamp(x, 200);
    return {
      volume: entries(p.volume, isNumber, pct),
      mutedForMe: entries(p.mutedForMe, isBool),
      hideVideo: entries(p.hideVideo, isBool),
      screenVolume: entries(p.screenVolume, isNumber, pct),
      soundboardVolume: isNumber(p.soundboardVolume) ? clamp(p.soundboardVolume, 100) : defaults.soundboardVolume,
      favourites: Array.isArray(p.favourites) ? p.favourites.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return defaults; // unavailable or unreadable: settings then last for this session
  }
}

export const voicePrefs = createStore<VoicePrefs>(() => load());

voicePrefs.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
});

/** Subscribes a component to part of this device's voice settings. */
export function useVoicePrefs<T>(selector: (p: VoicePrefs) => T): T {
  return useStore(voicePrefs, selector);
}

/** Sets a value in a per-user map, dropping it when it's the default. */
function put<K extends "volume" | "mutedForMe" | "hideVideo" | "screenVolume">(
  key: K, userId: string, value: VoicePrefs[K][string], fallback: VoicePrefs[K][string],
) {
  const { [userId]: _, ...rest } = voicePrefs.getState()[key];
  voicePrefs.setState({ [key]: value === fallback ? rest : { ...rest, [userId]: value } });
}

export function setVolume(userId: string, pct: number) {
  put("volume", userId, clamp(pct, 200), 100);
}

export function setMutedForMe(userId: string, on: boolean) {
  put("mutedForMe", userId, on, false);
}

export function setHideVideo(userId: string, on: boolean) {
  put("hideVideo", userId, on, false);
}

export function setScreenVolume(userId: string, pct: number) {
  put("screenVolume", userId, clamp(pct, 200), 100);
}

export function setSoundboardVolume(pct: number) {
  voicePrefs.setState({ soundboardVolume: clamp(pct, 100) });
}

export function toggleFavourite(soundId: string) {
  const { favourites } = voicePrefs.getState();
  voicePrefs.setState({ favourites: favourites.includes(soundId) ? favourites.filter((x) => x !== soundId) : [...favourites, soundId] });
}

/** Whether I changed someone's volume or muted them for me (shown as a badge). */
export function isAdjusted(prefs: VoicePrefs, userId: string): boolean {
  return (prefs.volume[userId] ?? 100) !== 100 || !!prefs.mutedForMe[userId];
}
