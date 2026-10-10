import type { AudioCaptureOptions } from "livekit-client";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { GateSettings } from "./gate";

export type InputMode = "vad" | "ptt";
export type NoiseMode = "off" | "standard" | "enhanced";
/** A push-to-talk key: `code` is matched (whatever the keyboard layout), `label` is shown. */
export type PttKey = { code: string; label: string };

/** How this device captures and plays call audio. Stays on this device and is never sent. */
export type AudioPrefs = {
  inputDeviceId: string; // "default": the system's choice
  outputDeviceId: string;
  mode: InputMode;
  vadAuto: boolean;
  vadThresholdDb: number; // -100..0, used when vadAuto is off
  pttKey: PttKey;
  noise: NoiseMode;
};

/** What the mic processor runs with (see mic-processor.ts). */
export type ChainOptions = GateSettings & { enhanced: boolean };

const KEY = "datrope.audioPrefs";

export const audioDefaults: AudioPrefs = {
  inputDeviceId: "default", outputDeviceId: "default", mode: "vad", vadAuto: true, vadThresholdDb: -50,
  pttKey: { code: "Backquote", label: "`" }, noise: "standard",
};

const clampDb = (n: number) => Math.min(0, Math.max(-100, Math.round(n)));
const text = (x: unknown, fallback: string) => (typeof x === "string" && x !== "" ? x : fallback);
const oneOf = <T extends string>(x: unknown, values: readonly T[], fallback: T): T => (values.includes(x as T) ? (x as T) : fallback);

function pttKey(x: unknown): PttKey {
  const k = x as Partial<PttKey> | null;
  return k && typeof k === "object" && typeof k.code === "string" && k.code !== "" && typeof k.label === "string"
    ? { code: k.code, label: k.label }
    : audioDefaults.pttKey;
}

/** Reads the saved settings, keeping each valid field and defaulting the rest. */
export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return audioDefaults;
    const p = JSON.parse(raw) as Record<string, unknown> | null;
    if (!p || typeof p !== "object") return audioDefaults;
    return {
      inputDeviceId: text(p.inputDeviceId, audioDefaults.inputDeviceId),
      outputDeviceId: text(p.outputDeviceId, audioDefaults.outputDeviceId),
      mode: oneOf(p.mode, ["vad", "ptt"] as const, audioDefaults.mode),
      vadAuto: typeof p.vadAuto === "boolean" ? p.vadAuto : audioDefaults.vadAuto,
      vadThresholdDb: typeof p.vadThresholdDb === "number" && Number.isFinite(p.vadThresholdDb)
        ? clampDb(p.vadThresholdDb) : audioDefaults.vadThresholdDb,
      pttKey: pttKey(p.pttKey),
      noise: oneOf(p.noise, ["off", "standard", "enhanced"] as const, audioDefaults.noise),
    };
  } catch {
    return audioDefaults; // unavailable or unreadable: settings then last for this session
  }
}

export const audioPrefs = createStore<AudioPrefs>(() => loadAudioPrefs());

audioPrefs.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
});

/** Subscribes a component to part of this device's audio settings. */
export function useAudioPrefs<T>(selector: (p: AudioPrefs) => T): T {
  return useStore(audioPrefs, selector);
}

export const setInputDevice = (inputDeviceId: string) => audioPrefs.setState({ inputDeviceId });
export const setOutputDevice = (outputDeviceId: string) => audioPrefs.setState({ outputDeviceId });
export const setInputMode = (mode: InputMode) => audioPrefs.setState({ mode });
export const setVadAuto = (vadAuto: boolean) => audioPrefs.setState({ vadAuto });
export const setVadThreshold = (db: number) => audioPrefs.setState({ vadThresholdDb: clampDb(db) });
export const setPttKey = (pttKey: PttKey) => audioPrefs.setState({ pttKey });
export const setNoise = (noise: NoiseMode) => audioPrefs.setState({ noise });

/**
 * Microphone constraints. The device is "ideal", so a missing one falls back to the default instead of failing;
 * the browser's own noise suppression is only on for Standard (Enhanced replaces it with RNNoise).
 */
export function captureOptions(p: AudioPrefs): AudioCaptureOptions {
  return {
    deviceId: p.inputDeviceId === "default" ? undefined : { ideal: p.inputDeviceId },
    noiseSuppression: p.noise === "standard",
    echoCancellation: true,
    autoGainControl: true,
  };
}

export function chainOptions(p: AudioPrefs): ChainOptions {
  return { mode: p.mode, auto: p.vadAuto, thresholdDb: p.vadThresholdDb, enhanced: p.noise === "enhanced" };
}
