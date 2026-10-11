import { compareIds } from "@datrope/core";
import { describe, expect, it, vi } from "vitest";
import { badgeFor, pttKeyFor } from "./desktop-sync";

// The real session module needs a browser (location); only its unread rule matters here.
vi.mock("../session", () => ({
  isUnread: (rs?: { lastReadId?: string; lastMessageId?: string }) =>
    !!rs?.lastMessageId && (!rs.lastReadId || compareIds(rs.lastMessageId, rs.lastReadId) > 0),
}));

const ch = (type: string) => ({ type }) as never;

describe("badgeFor", () => {
  it("counts unread mentions plus unread DMs", () => {
    const b = badgeFor({
      channels: { t1: ch("text"), v1: ch("voice"), d1: ch("dm"), d2: ch("dm") },
      dmIds: ["d1", "d2"],
      readStates: {
        t1: { lastMessageId: "5", lastReadId: "4" },
        d1: { lastMessageId: "9", lastReadId: "8" },
        d2: { lastMessageId: "3", lastReadId: "3" },
      },
      mentions: { items: [], unread: 2, hasMore: false, loaded: true },
    } as never);
    expect(b).toEqual({ unread: true, mentions: 3 });
  });

  it("is quiet when everything is read", () => {
    const b = badgeFor({ channels: { t1: ch("text") }, dmIds: [], readStates: { t1: { lastMessageId: "5", lastReadId: "5" } },
      mentions: { items: [], unread: 0, hasMore: false, loaded: true } } as never);
    expect(b).toEqual({ unread: false, mentions: 0 });
  });

  it("ignores channel types without unread state (voice)", () => {
    const b = badgeFor({ channels: { v1: ch("voice") }, dmIds: [], readStates: { v1: { lastMessageId: "5" } },
      mentions: { items: [], unread: 0, hasMore: false, loaded: true } } as never);
    expect(b.unread).toBe(false);
  });
});

describe("pttKeyFor", () => {
  it("registers the key only in a call with push to talk on", () => {
    expect(pttKeyFor("ptt", "F8", true)).toBe("F8");
    expect(pttKeyFor("ptt", "F8", false)).toBeNull();
    expect(pttKeyFor("vad", "F8", true)).toBeNull();
  });
});
