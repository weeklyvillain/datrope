import { describe, expect, it, vi } from "vitest";
import { clipSeconds, recentPlays, recordPlay, shouldPlay } from "./soundboard-audio";

const event = { channel_id: "c1", user_id: "u2", sound_id: "s1" };
const me = { channelId: "c1", deafened: false };

describe("shouldPlay", () => {
  it("plays a sound from my call", () => expect(shouldPlay(event, me, {})).toBe(true));
  it("ignores another channel", () => expect(shouldPlay({ ...event, channel_id: "c2" }, me, {})).toBe(false));
  it("ignores it when I'm in no call", () => expect(shouldPlay(event, { deafened: false }, {})).toBe(false));
  it("ignores it while I'm deafened", () => expect(shouldPlay(event, { ...me, deafened: true }, {})).toBe(false));
  it("ignores a player I muted", () => expect(shouldPlay(event, me, { u2: true })).toBe(false));
});

describe("clipSeconds", () => {
  it("keeps short clips whole", () => expect(clipSeconds(1200)).toBe(1.2));
  it("caps at 5 s", () => expect(clipSeconds(9000)).toBe(5));
});

describe("recordPlay", () => {
  it("shows a play for 3 s, and a newer play keeps its own 3 s", () => {
    vi.useFakeTimers();
    try {
      recordPlay("u1", "a");
      vi.advanceTimersByTime(2000);
      recordPlay("u1", "b");
      vi.advanceTimersByTime(1500); // the first timer fired: it must not clear the newer play
      expect(recentPlays.getState().u1?.soundId).toBe("b");
      vi.advanceTimersByTime(1500);
      expect(recentPlays.getState().u1).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
