import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAdjusted, setMutedForMe, setSoundboardVolume, setVolume, toggleFavourite, voicePrefs } from "./prefs";

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

describe("voice prefs", () => {
  beforeEach(() => voicePrefs.setState(voicePrefs.getInitialState(), true));

  it("clamps and forgets the default volume", () => {
    setVolume("u1", 250);
    expect(voicePrefs.getState().volume.u1).toBe(200);
    setVolume("u1", 100);
    expect("u1" in voicePrefs.getState().volume).toBe(false);
    setSoundboardVolume(150);
    expect(voicePrefs.getState().soundboardVolume).toBe(100);
  });

  it("knows who was adjusted", () => {
    expect(isAdjusted(voicePrefs.getState(), "u1")).toBe(false);
    setMutedForMe("u1", true);
    expect(isAdjusted(voicePrefs.getState(), "u1")).toBe(true);
  });

  it("toggles favourites", () => {
    toggleFavourite("s1");
    toggleFavourite("s2");
    toggleFavourite("s1");
    expect(voicePrefs.getState().favourites).toEqual(["s2"]);
  });

  it("saves to this device", () => {
    setVolume("u2", 150);
    expect(JSON.parse(localStorage.getItem("datrope.voicePrefs")!).volume).toEqual({ u2: 150 });
  });

  it("ignores tampered storage", async () => {
    localStorage.setItem("datrope.voicePrefs", '{"volume":{"a":999,"b":"x","c":null,"d":50,"e":1e999},"mutedForMe":{"a":"yes","b":true},'
      + '"hideVideo":[1],"screenVolume":{"a":-5},"soundboardVolume":1e9,"favourites":["s",3]}');
    vi.resetModules();
    const fresh = await import("./prefs");
    expect(fresh.voicePrefs.getState()).toEqual({
      volume: { a: 200, d: 50 }, mutedForMe: { b: true }, hideVideo: {}, screenVolume: { a: 0 }, soundboardVolume: 100, favourites: ["s"],
    });
  });
});
