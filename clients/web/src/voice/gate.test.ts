import { describe, expect, it } from "vitest";
import { createGate, PTT_RELEASE_MS, VAD_HOLD_MS, type GateSettings } from "./gate";

const manual: GateSettings = { mode: "vad", auto: false, thresholdDb: -50 };
const auto: GateSettings = { mode: "vad", auto: true, thresholdDb: -50 };
const ptt: GateSettings = { mode: "ptt", auto: false, thresholdDb: -50 };

/** Feeds `levelDb` every 20 ms from `fromMs` up to (not including) `toMs`; returns the last decision. */
function feed(gate: ReturnType<typeof createGate>, s: GateSettings, levelDb: number, fromMs: number, toMs: number, pttDown = false) {
  let open = false;
  for (let t = fromMs; t < toMs; t += 20) open = gate.update({ ...s, levelDb, nowMs: t, pttDown });
  return open;
}

describe("gate", () => {
  it("opens at the manual threshold", () => {
    expect(createGate().update({ ...manual, levelDb: -50, nowMs: 0, pttDown: false })).toBe(true);
    expect(createGate().update({ ...manual, levelDb: -51, nowMs: 0, pttDown: false })).toBe(false);
  });

  it("holds voice activity open for 300 ms after the last loud moment", () => {
    const g = createGate();
    g.update({ ...manual, levelDb: -30, nowMs: 0, pttDown: false });
    expect(g.update({ ...manual, levelDb: -90, nowMs: VAD_HOLD_MS - 20, pttDown: false })).toBe(true);
    expect(g.update({ ...manual, levelDb: -90, nowMs: VAD_HOLD_MS, pttDown: false })).toBe(false);
  });

  it("follows push to talk, ignoring the level, and closes 200 ms after release", () => {
    const g = createGate();
    expect(g.update({ ...ptt, levelDb: -100, nowMs: 0, pttDown: true })).toBe(true);
    expect(g.update({ ...ptt, levelDb: 0, nowMs: 100, pttDown: true })).toBe(true);
    expect(g.update({ ...ptt, levelDb: 0, nowMs: 100 + PTT_RELEASE_MS - 20, pttDown: false })).toBe(true);
    expect(g.update({ ...ptt, levelDb: 0, nowMs: 100 + PTT_RELEASE_MS, pttDown: false })).toBe(false);
    expect(createGate().update({ ...ptt, levelDb: 0, nowMs: 0, pttDown: false })).toBe(false);
  });

  it("auto ignores a steady background and opens for speech", () => {
    const g = createGate();
    expect(feed(g, auto, -60, 0, 5000)).toBe(false); // a fan
    expect(g.thresholdDb(auto)).toBeCloseTo(-45, 0);
    expect(g.update({ ...auto, levelDb: -30, nowMs: 5000, pttDown: false })).toBe(true);
  });

  it("auto adapts when the background gets louder", () => {
    const g = createGate();
    feed(g, auto, -80, 0, 2000);
    expect(feed(g, auto, -50, 2000, 62_000)).toBe(false); // a minute of a louder fan: not speech any more
  });

  it("clamps the auto threshold", () => {
    const g = createGate();
    feed(g, auto, -100, 0, 1000);
    expect(g.thresholdDb(auto)).toBe(-70);
    feed(g, auto, -5, 1000, 200_000);
    expect(g.thresholdDb(auto)).toBe(-20);
    expect(g.thresholdDb(manual)).toBe(-50);
  });

  it("treats silence and NaN as -100 dB", () => {
    const g = createGate();
    expect(g.update({ ...auto, levelDb: -Infinity, nowMs: 0, pttDown: false })).toBe(false);
    expect(g.update({ ...auto, levelDb: Number.NaN, nowMs: 20, pttDown: false })).toBe(false);
    expect(g.thresholdDb(auto)).toBe(-70);
  });
});
