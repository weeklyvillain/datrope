import { ApiError } from "@datrope/core";
import { DisconnectReason } from "livekit-client";
import { describe, expect, it } from "vitest";
import { clearResume, loadResume, resumeDecision, retryDelay, saveResume, terminalJoinError, terminalReason } from "./resume";

function storage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe("resume storage", () => {
  it("round-trips and clears", () => {
    const s = storage();
    expect(loadResume(s)).toBeNull();
    saveResume(s, { userId: "7", channelId: "42", muted: true, deafened: false, at: 1000 });
    expect(loadResume(s, 1000)).toEqual({ userId: "7", channelId: "42", muted: true, deafened: false, at: 1000 });
    clearResume(s);
    expect(loadResume(s)).toBeNull();
  });
  it("ignores garbage", () => {
    const s = storage();
    s.setItem("voice.resume", "{nope");
    expect(loadResume(s)).toBeNull();
    s.setItem("voice.resume", JSON.stringify({ userId: "7", channelId: 5 }));
    expect(loadResume(s)).toBeNull();
  });
  it("rejects an entry without a user", () => {
    const s = storage();
    s.setItem("voice.resume", JSON.stringify({ channelId: "42", muted: false, deafened: false }));
    expect(loadResume(s)).toBeNull();
    s.setItem("voice.resume", JSON.stringify({ userId: 7, channelId: "42" }));
    expect(loadResume(s)).toBeNull();
  });
  it("rejects an entry older than two minutes (a tab restored hours later)", () => {
    const s = storage();
    saveResume(s, { userId: "7", channelId: "42", muted: false, deafened: false, at: 1000 });
    expect(loadResume(s, 1000 + 120_000)).not.toBeNull();
    expect(loadResume(s, 1000 + 120_001)).toBeNull();
    s.setItem("voice.resume", JSON.stringify({ userId: "7", channelId: "42" })); // no timestamp: from before this check
    expect(loadResume(s)).toBeNull();
  });
});

describe("retryDelay", () => {
  it("backs off 1, 2, 5, 10, 15, 15 … seconds", () =>
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelay(n, 0))).toEqual([1000, 2000, 5000, 10000, 15000, 15000, 15000]));
  it("gives up after two minutes", () => expect(retryDelay(9, 120_000)).toBeNull());
});

describe("terminal", () => {
  it("does not retry kicks, duplicates or closed rooms", () => {
    for (const r of [DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason.DUPLICATE_IDENTITY, DisconnectReason.ROOM_DELETED, DisconnectReason.USER_REJECTED])
      expect(terminalReason(r)).toBe(true);
  });
  it("retries network trouble and page-leave disconnects", () => {
    for (const r of [undefined, DisconnectReason.SIGNAL_CLOSE, DisconnectReason.SERVER_SHUTDOWN, DisconnectReason.CLIENT_INITIATED, DisconnectReason.CONNECTION_TIMEOUT])
      expect(terminalReason(r)).toBe(false);
  });
  it("treats 4xx join refusals as final and 5xx/network as retryable", () => {
    expect(terminalJoinError(new ApiError(403, "MISSING_PERMISSION", "no"))).toBe(true);
    expect(terminalJoinError(new ApiError(404, "NOT_FOUND", "gone"))).toBe(true);
    expect(terminalJoinError(new ApiError(503, "X", "down"))).toBe(false);
    expect(terminalJoinError(new ApiError(408, "TIMEOUT", "slow"))).toBe(false);
    expect(terminalJoinError(new ApiError(429, "RATE_LIMITED", "slow down"))).toBe(false);
    expect(terminalJoinError(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("resumeDecision", () => {
  const r = { userId: "7", channelId: "42", muted: false, deafened: false, at: 0 };
  it("waits while the gateway is not ready, and while READY has not set me yet", () => {
    expect(resumeDecision({ connection: "connecting", me: null }, r)).toBe("wait");
    expect(resumeDecision({ connection: "ready", me: null }, r)).toBe("wait"); // connection flips before me arrives
  });
  it("joins for the same user once me arrives", () => expect(resumeDecision({ connection: "ready", me: { id: "7" } }, r)).toBe("join"));
  it("drops another user's call", () => expect(resumeDecision({ connection: "ready", me: { id: "8" } }, r)).toBe("drop"));
});
