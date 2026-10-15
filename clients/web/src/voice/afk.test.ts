import { describe, expect, it } from "vitest";
import { isActive, isAFKChannel, liveAFKId, shouldGoAFK } from "./afk";

const base = { now: 1_000_000, lastActive: 1_000_000 - 901_000, timeoutS: 900, channelId: "5", afkChannelId: "9", status: "connected", tried: false };

describe("shouldGoAFK", () => {
  it("fires after the timeout of silence", () => expect(shouldGoAFK(base)).toBe(true));
  it("waits until the timeout", () => expect(shouldGoAFK({ ...base, lastActive: base.now - 899_000 })).toBe(false));
  it("never without an AFK channel, outside a call, or while already there", () => {
    expect(shouldGoAFK({ ...base, afkChannelId: undefined })).toBe(false);
    expect(shouldGoAFK({ ...base, status: "reconnecting" })).toBe(false);
    expect(shouldGoAFK({ ...base, channelId: "9" })).toBe(false);
  });
  it("tries once per channel join", () => expect(shouldGoAFK({ ...base, tried: true })).toBe(false));
});

describe("isAFKChannel", () => {
  it("matches the server's AFK channel", () => {
    expect(isAFKChannel("9", "9")).toBe(true);
    expect(isAFKChannel("9", "5")).toBe(false);
    expect(isAFKChannel(undefined, "5")).toBe(false);
  });
});

describe("liveAFKId", () => {
  it("is the AFK channel while it exists", () => expect(liveAFKId("9", { "9": {} })).toBe("9"));
  it("is unset when the channel was deleted or never set", () => {
    expect(liveAFKId("9", { "5": {} })).toBeUndefined();
    expect(liveAFKId(undefined, { "9": {} })).toBeUndefined();
    expect(liveAFKId("", { "9": {} })).toBeUndefined();
  });
});

describe("isActive", () => {
  const quiet = { deafened: false, speaking: false, camera: false, screen: false };
  it("counts speaking, unless deafened", () => {
    expect(isActive(quiet)).toBe(false);
    expect(isActive({ ...quiet, speaking: true })).toBe(true);
    expect(isActive({ ...quiet, deafened: true, speaking: true })).toBe(false);
  });
  it("always counts a camera or a screen share", () => {
    expect(isActive({ ...quiet, screen: true })).toBe(true);
    expect(isActive({ ...quiet, deafened: true, camera: true })).toBe(true);
  });
});
