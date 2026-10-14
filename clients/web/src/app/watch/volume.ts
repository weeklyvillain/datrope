const KEY = "datrope.watchVolume";

/** My volume for watch-together videos: mine alone, never shared with the call. */
export type WatchVolume = { volume: number; muted: boolean }; // volume 0-100

export function readVolume(): WatchVolume {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<WatchVolume> | null;
    if (v && typeof v.volume === "number") return { volume: Math.min(100, Math.max(0, v.volume)), muted: !!v.muted };
  } catch {
    // unreadable or blocked storage: the default
  }
  return { volume: 80, muted: false };
}

export function saveVolume(v: WatchVolume) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // blocked storage: the choice lasts until reload
  }
}
