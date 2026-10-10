import { beforeEach, describe, expect, it } from "vitest";

// Vitest runs in Node (no jsdom here): a tiny in-memory localStorage, set before the store loads.
const data = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k),
  clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null,
  get length() {
    return data.size;
  },
} as Storage;

const { audioDefaults, audioPrefs, captureOptions, chainOptions, loadAudioPrefs, setNoise, setVadThreshold } = await import("./audio-prefs");

describe("audio prefs", () => {
  beforeEach(() => {
    audioPrefs.setState(audioDefaults, true);
    data.clear();
  });

  it("starts with the defaults", () => {
    expect(loadAudioPrefs()).toEqual(audioDefaults);
    expect(audioDefaults.pttKey).toEqual({ code: "Backquote", label: "`" });
  });

  it("keeps good fields and drops bad ones", () => {
    data.set("datrope.audioPrefs", JSON.stringify({
      inputDeviceId: "mic-2", outputDeviceId: 7, mode: "ptt", vadAuto: "yes", vadThresholdDb: -250,
      pttKey: { label: "F" }, noise: "loud",
    }));
    expect(loadAudioPrefs()).toEqual({ ...audioDefaults, inputDeviceId: "mic-2", mode: "ptt", vadThresholdDb: -100 });
    data.set("datrope.audioPrefs", "null");
    expect(loadAudioPrefs()).toEqual(audioDefaults);
    data.set("datrope.audioPrefs", "{oops");
    expect(loadAudioPrefs()).toEqual(audioDefaults);
  });

  it("clamps the threshold and saves changes", () => {
    setVadThreshold(12.4);
    expect(audioPrefs.getState().vadThresholdDb).toBe(0);
    setNoise("enhanced");
    expect(JSON.parse(data.get("datrope.audioPrefs")!).noise).toBe("enhanced");
  });

  it("asks for the saved device as ideal, not exact", () => {
    expect(captureOptions({ ...audioDefaults, inputDeviceId: "mic-2" }).deviceId).toEqual({ ideal: "mic-2" });
    expect(captureOptions(audioDefaults).deviceId).toBeUndefined();
  });

  it("uses the browser's noise suppression only for Standard", () => {
    expect(captureOptions(audioDefaults)).toMatchObject({ noiseSuppression: true, echoCancellation: true, autoGainControl: true });
    expect(captureOptions({ ...audioDefaults, noise: "enhanced" }).noiseSuppression).toBe(false);
    expect(captureOptions({ ...audioDefaults, noise: "off" }).noiseSuppression).toBe(false);
  });

  it("maps prefs to processor options", () => {
    expect(chainOptions({ ...audioDefaults, mode: "ptt", vadAuto: false, vadThresholdDb: -42, noise: "enhanced" }))
      .toEqual({ mode: "ptt", auto: false, thresholdDb: -42, enhanced: true });
  });
});
