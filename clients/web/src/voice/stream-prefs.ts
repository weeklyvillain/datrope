import { createStore } from "zustand/vanilla";

export type StreamMode = "game" | "detail";

/** What I send when I share my screen. Kept on this device; the dialog opens with the last ones used. */
export interface StreamSettings {
  mode: StreamMode;
  resolution: 720 | 1080;
  fps: 30 | 60;
  audio: boolean;
}

/** What the browser and LiveKit need for one set of stream settings. */
export interface StreamEncoding {
  width: number;
  height: number;
  fps: 30 | 60;
  maxBitrate: number; // bits per second
  contentHint: "motion" | "detail";
  degradationPreference: RTCDegradationPreference;
}

const KEY = "datrope.streamPrefs";

const MODE_DEFAULTS: Record<StreamMode, Pick<StreamSettings, "resolution" | "fps">> = {
  game: { resolution: 1080, fps: 60 },
  detail: { resolution: 1080, fps: 30 },
};

const defaults: StreamSettings = { mode: "game", ...MODE_DEFAULTS.game, audio: true };

const BITRATE: Record<StreamSettings["resolution"], Record<StreamSettings["fps"], number>> = {
  720: { 30: 3_000_000, 60: 4_500_000 },
  1080: { 30: 5_000_000, 60: 10_000_000 },
};

export function encoding(s: StreamSettings): StreamEncoding {
  const game = s.mode === "game";
  return {
    width: s.resolution === 1080 ? 1920 : 1280,
    height: s.resolution,
    fps: s.fps,
    maxBitrate: BITRATE[s.resolution][s.fps],
    // Game: under pressure lose resolution, keep fps. Detail: keep text sharp, lose fps.
    contentHint: game ? "motion" : "detail",
    degradationPreference: game ? "maintain-framerate" : "maintain-resolution",
  };
}

/** Switches mode and takes that mode's resolution and fps; audio stays as it was. */
export function withMode(s: StreamSettings, mode: StreamMode): StreamSettings {
  return { ...s, mode, ...MODE_DEFAULTS[mode] };
}

function load(): StreamSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return defaults;
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== "object") return defaults;
    return {
      mode: p.mode === "game" || p.mode === "detail" ? p.mode : defaults.mode,
      resolution: p.resolution === 720 || p.resolution === 1080 ? p.resolution : defaults.resolution,
      fps: p.fps === 30 || p.fps === 60 ? p.fps : defaults.fps,
      audio: typeof p.audio === "boolean" ? p.audio : defaults.audio,
    };
  } catch {
    return defaults; // unavailable or unreadable: settings then last for this session
  }
}

export const streamPrefs = createStore<StreamSettings>(() => load());

streamPrefs.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private window): kept in memory only.
  }
});

export function saveStreamPrefs(s: StreamSettings) {
  streamPrefs.setState(s, true);
}
