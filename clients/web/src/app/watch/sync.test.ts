import { describe, expect, it } from "vitest";
import { DRIFT_S, describeAction, expectedPosition, formatTime, reconcile } from "./sync";

const yt = { kind: "youtube", paused: false, position: 10, updated_at: 1_000_000, last_action: "play" } as const;

describe("expectedPosition", () => {
  it("adds the time since the update while playing, on the server's clock", () => {
    expect(expectedPosition(yt, 1_004_000, 0)).toBe(14);
    expect(expectedPosition(yt, 1_002_000, 2_000)).toBe(14); // my clock is 2 s behind
    expect(expectedPosition(yt, 1_006_000, -2_000)).toBe(14); // 2 s ahead
  });
  it("stays put while paused, never goes back before the update, and is the position for live", () => {
    expect(expectedPosition({ ...yt, paused: true }, 1_009_000, 0)).toBe(10);
    expect(expectedPosition(yt, 999_000, 0)).toBe(10);
    expect(expectedPosition({ ...yt, kind: "twitch_live", position: 0 }, 1_009_000, 0)).toBe(0);
  });
});

describe("reconcile", () => {
  const sample = { time: 14, playing: true, duration: 600 };
  it("leaves a player in step alone", () => {
    expect(reconcile(yt, sample, 14)).toEqual({});
    expect(reconcile(yt, { ...sample, time: 14 + DRIFT_S }, 14)).toEqual({});
  });
  it("seeks past the drift threshold", () => {
    expect(reconcile(yt, { ...sample, time: 10 }, 14)).toEqual({ seek: 14 });
    expect(reconcile({ ...yt, kind: "twitch_vod" }, { ...sample, time: 30 }, 14)).toEqual({ seek: 14 });
  });
  it("never seeks a live stream", () => {
    expect(reconcile({ ...yt, kind: "twitch_live" }, { ...sample, time: 500 }, 0)).toEqual({});
  });
  it("matches play and pause", () => {
    expect(reconcile({ ...yt, paused: true }, sample, 14)).toEqual({ pause: true });
    expect(reconcile(yt, { ...sample, playing: false }, 14)).toEqual({ play: true });
  });
  it("does nothing once the video is over, instead of restarting it", () => {
    expect(reconcile(yt, { time: 600, playing: false, duration: 600 }, 640)).toEqual({});
    // a player slightly ahead of the server reaches the end first: leave it ended, do not restart it
    expect(reconcile(yt, { time: 599.6, playing: false, duration: 600 }, 599)).toEqual({});
    // but an ended player follows a seek back
    expect(reconcile(yt, { time: 600, playing: false, duration: 600 }, 0)).toEqual({ seek: 0, play: true });
    expect(reconcile(yt, { time: 600, playing: false, duration: 600 }, 300)).toEqual({ seek: 300, play: true });
    expect(reconcile(yt, { time: 0, playing: false, duration: 0 }, 4)).toEqual({ seek: 4, play: true }); // duration unknown yet
  });
});

describe("formatTime", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(61.9)).toBe("1:01");
    expect(formatTime(3723)).toBe("1:02:03");
  });
});

describe("describeAction", () => {
  it("says who did what", () => {
    expect(describeAction({ ...yt, last_action: "start" }, "Anna")).toBe("Anna started this");
    expect(describeAction({ ...yt, last_action: "play" }, "Anna")).toBe("Anna resumed");
    expect(describeAction({ ...yt, last_action: "pause" }, "bob")).toBe("bob paused");
    expect(describeAction({ ...yt, last_action: "seek", position: 761 }, "Max")).toBe("Max skipped to 12:41");
  });
});
