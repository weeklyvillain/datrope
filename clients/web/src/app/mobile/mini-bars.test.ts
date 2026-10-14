import { describe, expect, it } from "vitest";
import { miniBarLayout } from "./mini-bars";

describe("miniBarLayout", () => {
  const call = { channelId: "v1", status: "connected" as const };
  it("shows nothing with no call and no music", () => {
    expect(miniBarLayout({ voice: { status: "idle" }, music: false, compact: false, pathname: "/" })).toBe("none");
  });
  it("shows the voice bar while in a call, connecting or reconnecting", () => {
    expect(miniBarLayout({ voice: call, music: false, compact: false, pathname: "/" })).toBe("voice");
    expect(miniBarLayout({ voice: { ...call, status: "connecting" }, music: false, compact: true, pathname: "/" })).toBe("voice");
    expect(miniBarLayout({ voice: { ...call, status: "reconnecting" }, music: false, compact: true, pathname: "/" })).toBe("voice");
  });
  it("hides the voice bar on that call's own screen", () => {
    expect(miniBarLayout({ voice: call, music: false, compact: true, pathname: "/channels/v1" })).toBe("none");
    expect(miniBarLayout({ voice: call, music: true, compact: true, pathname: "/channels/v1" })).toBe("music");
    expect(miniBarLayout({ voice: call, music: false, compact: true, pathname: "/channels/v2" })).toBe("voice");
  });
  it("shows the music bar alone", () => {
    expect(miniBarLayout({ voice: { status: "idle" }, music: true, compact: true, pathname: "/channels/x" })).toBe("music");
  });
  it("stacks both on tab roots and shares one row on pushed screens", () => {
    expect(miniBarLayout({ voice: call, music: true, compact: false, pathname: "/" })).toBe("stack");
    expect(miniBarLayout({ voice: call, music: true, compact: true, pathname: "/channels/t" })).toBe("row");
  });
});
