import { describe, expect, it } from "vitest";
import { DRIFT_S, describeAction, describeWaiting, expectedPosition, formatTime, held, isReady, nextReport, reconcile, stallDetector } from "./sync";

const yt = { kind: "youtube", paused: false, position: 10, updated_at: 1_000_000, last_action: "play", waiting: [] as string[] } as const;

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

describe("held", () => {
  it("is paused, or waiting for anyone", () => {
    expect(held(yt)).toBe(false);
    expect(held({ ...yt, paused: true })).toBe(true);
    expect(held({ ...yt, waiting: ["11"] })).toBe(true);
  });
  it("freezes the expected position while waiting", () => {
    expect(expectedPosition({ ...yt, waiting: ["11"] }, 1_009_000, 0)).toBe(10);
  });
});

describe("isReady", () => {
  const l = { time: 10, duration: 600, buffering: false, loadedAhead: 3 };
  it("needs READY_AHEAD_S loaded and no buffering", () => {
    expect(isReady(l)).toBe(true);
    expect(isReady({ ...l, loadedAhead: 2.9 })).toBe(false);
    expect(isReady({ ...l, buffering: true })).toBe(false);
  });
  it("is ready near the end, and when the player cannot tell (Twitch, live)", () => {
    expect(isReady({ ...l, time: 599.2, loadedAhead: 0.8 })).toBe(true);
    expect(isReady({ ...l, loadedAhead: undefined })).toBe(true);
    expect(isReady({ ...l, loadedAhead: undefined, buffering: true })).toBe(false);
  });
});

describe("nextReport", () => {
  const base = { seq: 5, now: 0, buffering: false, ready: false, waitingOnMe: false, held: false };
  it("reports a stall only after STALL_MS, once", () => {
    let r = nextReport({ seq: 5 }, { ...base, buffering: true });
    expect(r.send).toBeUndefined();
    r = nextReport(r.tracker, { ...base, buffering: true, now: 500 });
    expect(r.send).toBeUndefined();
    r = nextReport(r.tracker, { ...base, buffering: true, now: 750 });
    expect(r.send).toBe(true);
    r = nextReport(r.tracker, { ...base, buffering: true, now: 1250 });
    expect(r.send).toBeUndefined();
  });
  it("forgets a short blip", () => {
    let r = nextReport({ seq: 5 }, { ...base, buffering: true });
    r = nextReport(r.tracker, { ...base, now: 500 });
    r = nextReport(r.tracker, { ...base, buffering: true, now: 1000 });
    expect(r.send).toBeUndefined();
  });
  it("does not report stalls while the room is held", () => {
    let r = nextReport({ seq: 5 }, { ...base, buffering: true, held: true });
    r = nextReport(r.tracker, { ...base, buffering: true, held: true, now: 2000 });
    expect(r.send).toBeUndefined();
  });
  it("reports ready when the room waits for me", () => {
    let r = nextReport({ seq: 5 }, { ...base, waitingOnMe: true, held: true });
    expect(r.send).toBeUndefined();
    r = nextReport(r.tracker, { ...base, waitingOnMe: true, held: true, ready: true, now: 500 });
    expect(r.send).toBe(false);
    r = nextReport(r.tracker, { ...base, waitingOnMe: true, held: true, ready: true, now: 1000 });
    expect(r.send).toBeUndefined();
  });
  it("resends after RESEND_MS when the server has not caught up", () => {
    let r = nextReport({ seq: 5 }, { ...base, waitingOnMe: true, ready: true });
    expect(r.send).toBe(false);
    r = nextReport(r.tracker, { ...base, waitingOnMe: true, ready: true, now: 2000 });
    expect(r.send).toBe(false);
    let s = nextReport({ seq: 5 }, { ...base, buffering: true });
    s = nextReport(s.tracker, { ...base, buffering: true, now: 750 });
    expect(s.send).toBe(true);
    s = nextReport(s.tracker, { ...base, buffering: true, now: 2750 });
    expect(s.send).toBe(true);
  });
  it("says ready once per seq even when nobody waits for me, so the server knows I have a player", () => {
    let r = nextReport({ seq: 5 }, { ...base, ready: true });
    expect(r.send).toBe(false);
    r = nextReport(r.tracker, { ...base, ready: true, now: 5000 });
    expect(r.send).toBeUndefined(); // not waited for: no resend
    r = nextReport(r.tracker, { ...base, buffering: true, now: 5500 });
    r = nextReport(r.tracker, { ...base, buffering: true, now: 6250 });
    expect(r.send).toBe(true);
    r = nextReport(r.tracker, { ...base, ready: true, now: 7000 });
    expect(r.send).toBe(false); // ready again after a stall, even though excused viewers are never waited for
  });
  it("starts over on a new seq", () => {
    let r = nextReport({ seq: 5 }, { ...base, waitingOnMe: true, ready: true });
    expect(r.send).toBe(false);
    r = nextReport(r.tracker, { ...base, seq: 6, waitingOnMe: true, ready: true, now: 100 });
    expect(r.send).toBe(false);
    expect(r.tracker.seq).toBe(6);
  });
});

describe("stallDetector", () => {
  it("is stalled when time moves under 0.25 s across a second of playing", () => {
    const d = stallDetector();
    expect(d(false, 10, 0)).toBe(false);
    expect(d(false, 10.1, 500)).toBe(false); // under a second: keep the last answer
    expect(d(false, 10.1, 1000)).toBe(true);
    expect(d(false, 11.1, 2000)).toBe(false);
  });
  it("is never stalled while paused, and starts over after", () => {
    const d = stallDetector();
    d(false, 10, 0);
    expect(d(true, 10, 1000)).toBe(false);
    expect(d(false, 10, 1500)).toBe(false);
  });
});

describe("describeWaiting", () => {
  const names: Record<string, string> = { "10": "Anna", "11": "Bo" };
  const name = (id: string) => names[id] ?? id;
  it("names others, says Loading when only me, empty when nobody", () => {
    expect(describeWaiting([], "10", name)).toBe("");
    expect(describeWaiting(["10"], "10", name)).toBe("Loading…");
    expect(describeWaiting(["10", "11"], "10", name)).toBe("Waiting for Bo…");
    expect(describeWaiting(["10", "11"], "12", name)).toBe("Waiting for Anna, Bo…");
  });
});
