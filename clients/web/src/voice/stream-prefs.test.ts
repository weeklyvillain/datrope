import { beforeEach, describe, expect, it, vi } from "vitest";
import { encoding, saveStreamPrefs, streamPrefs, withMode } from "./stream-prefs";

// Vitest runs in Node (no jsdom here): a tiny in-memory localStorage.
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

describe("stream prefs", () => {
  beforeEach(() => {
    data.clear();
    streamPrefs.setState(streamPrefs.getInitialState(), true);
  });

  it("defaults to game mode at 1080p60 with audio", () => {
    expect(streamPrefs.getState()).toEqual({ mode: "game", resolution: 1080, fps: 60, audio: true });
  });

  it("encodes each preset", () => {
    const game = { mode: "game", audio: true } as const;
    expect(encoding({ ...game, resolution: 720, fps: 30 }).maxBitrate).toBe(3_000_000);
    expect(encoding({ ...game, resolution: 720, fps: 60 }).maxBitrate).toBe(4_500_000);
    expect(encoding({ ...game, resolution: 1080, fps: 30 }).maxBitrate).toBe(5_000_000);
    expect(encoding({ ...game, resolution: 1080, fps: 60 })).toEqual({
      width: 1920, height: 1080, fps: 60, maxBitrate: 10_000_000,
      contentHint: "motion", degradationPreference: "maintain-framerate",
    });
    expect(encoding({ ...game, resolution: 720, fps: 30 })).toMatchObject({ width: 1280, height: 720, fps: 30 });
  });

  it("keeps text sharp in detail mode", () => {
    expect(encoding({ mode: "detail", resolution: 1080, fps: 30, audio: false })).toMatchObject({
      contentHint: "detail", degradationPreference: "maintain-resolution",
    });
  });

  it("applies a mode's defaults and keeps audio", () => {
    expect(withMode({ mode: "game", resolution: 720, fps: 60, audio: false }, "detail"))
      .toEqual({ mode: "detail", resolution: 1080, fps: 30, audio: false });
    expect(withMode({ mode: "detail", resolution: 720, fps: 30, audio: true }, "game"))
      .toEqual({ mode: "game", resolution: 1080, fps: 60, audio: true });
  });

  it("saves to this device", () => {
    saveStreamPrefs({ mode: "detail", resolution: 720, fps: 30, audio: false });
    expect(JSON.parse(localStorage.getItem("datrope.streamPrefs")!)).toEqual({ mode: "detail", resolution: 720, fps: 30, audio: false });
  });

  it("ignores tampered storage", async () => {
    localStorage.setItem("datrope.streamPrefs", '{"mode":"cinema","resolution":1440,"fps":30,"audio":"yes"}');
    vi.resetModules();
    const fresh = await import("./stream-prefs");
    expect(fresh.streamPrefs.getState()).toEqual({ mode: "game", resolution: 1080, fps: 30, audio: true });
    localStorage.setItem("datrope.streamPrefs", "not json");
    vi.resetModules();
    expect((await import("./stream-prefs")).streamPrefs.getState()).toEqual({ mode: "game", resolution: 1080, fps: 60, audio: true });
  });
});
