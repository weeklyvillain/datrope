import type { ClientMessage } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { buildItems, indexOfMessage, navTarget, neighbourRow, prependedCount } from "./message-items";

const msg = (id: string, author: string, at: string, extra: Partial<ClientMessage> = {}) =>
  ({ id, channel_id: "c", content: id, created_at: at, author: { id: author, username: author }, ...extra }) as unknown as ClientMessage;

describe("buildItems", () => {
  const a = msg("1", "u1", "2026-10-14T08:00:00Z");
  const b = msg("2", "u1", "2026-10-14T08:03:00Z");
  const c = msg("3", "u1", "2026-10-14T08:09:00Z");
  const d = msg("4", "u2", "2026-10-14T08:10:00Z");
  const e = msg("5", "u2", "2026-10-15T08:10:00Z");

  it("adds a day divider before the first message of each day", () => {
    const items = buildItems([a, e], { unreadAt: -1, variant: "chat" });
    expect(items.map((i) => i.kind)).toEqual(["day", "message", "day", "message"]);
  });
  it("groups the same author within five minutes", () => {
    const items = buildItems([a, b, c, d], { unreadAt: -1, variant: "chat" }).filter((i) => i.kind === "message");
    expect(items.map((i) => i.kind === "message" && i.grouped)).toEqual([false, true, false, false]);
  });
  it("breaks groups at replies, the unread line and system messages", () => {
    const reply = msg("2", "u1", "2026-10-14T08:01:00Z", { reply_to: { id: "1" } as never });
    expect(buildItems([a, reply], { unreadAt: -1, variant: "chat" }).filter((i) => i.kind === "message").map((i) => i.kind === "message" && i.grouped)).toEqual([false, false]);
    const items = buildItems([a, b], { unreadAt: 1, variant: "chat" });
    expect(items.map((i) => i.kind)).toEqual(["day", "message", "unread", "message"]);
    expect(items.at(-1)).toMatchObject({ grouped: false });
    const left = msg("1", "u1", "2026-10-14T08:00:00Z", { kind: "member_leave" } as never);
    expect(buildItems([left, b], { unreadAt: -1, variant: "chat" }).at(-1)).toMatchObject({ grouped: false });
  });
  it("never groups cards", () => {
    expect(buildItems([a, b], { unreadAt: -1, variant: "cards" }).at(-1)).toMatchObject({ grouped: false });
  });
  it("keys a pending message and its confirmed copy alike, so the row is not remounted", () => {
    const pending = msg("pending:n1", "u1", "2026-10-14T08:03:00Z", { nonce: "n1", pending: true });
    const confirmed = msg("9", "u1", "2026-10-14T08:03:00Z", { nonce: "n1" });
    const key = (m: ClientMessage) => buildItems([a, m], { unreadAt: -1, variant: "chat" }).at(-1)!.key;
    expect(key(pending)).toBe(key(confirmed));
    expect(key(b)).toBe("2"); // history carries no nonce
  });
});

describe("prependedCount", () => {
  const m3 = msg("3", "u1", "2026-10-14T09:00:00Z");
  const before = buildItems([m3], { unreadAt: -1, variant: "chat" });
  it("counts items added above the previous first message, on the same day", () => {
    const after = buildItems([msg("1", "u2", "2026-10-14T08:00:00Z"), m3], { unreadAt: -1, variant: "chat" });
    expect(prependedCount(before, after)).toBe(1);
  });
  it("counts the day dividers of older days", () => {
    const after = buildItems([msg("1", "u2", "2026-10-13T08:00:00Z"), m3], { unreadAt: -1, variant: "chat" });
    expect(prependedCount(before, after)).toBe(2);
  });
  it("is 0 without a previous list or when the first message is gone", () => {
    const after = buildItems([msg("1", "u2", "2026-10-14T08:00:00Z"), m3], { unreadAt: -1, variant: "chat" });
    expect(prependedCount(undefined, after)).toBe(0);
    expect(prependedCount(before, buildItems([msg("7", "u1", "2026-10-14T10:00:00Z")], { unreadAt: -1, variant: "chat" }))).toBe(0);
  });
});

describe("indexOfMessage", () => {
  it("finds a message's item index", () => {
    const items = buildItems([msg("1", "u1", "2026-10-14T08:00:00Z")], { unreadAt: -1, variant: "chat" });
    expect(indexOfMessage(items, "1")).toBe(1);
    expect(indexOfMessage(items, "x")).toBe(-1);
  });
});

describe("navTarget and neighbourRow", () => {
  // day, 1, unread, leave (system, not a row), 2, day, 3
  const items = buildItems([
    msg("1", "u1", "2026-10-14T08:00:00Z"),
    msg("L", "u2", "2026-10-14T08:01:00Z", { kind: "member_leave" } as never),
    msg("2", "u1", "2026-10-14T08:02:00Z"),
    msg("3", "u1", "2026-10-15T08:00:00Z"),
  ], { unreadAt: 1, variant: "chat" });
  const id = (i: number) => { const it = items[i]; return it?.kind === "message" ? it.m.id : undefined; };

  it("skips dividers and system messages", () => {
    expect(id(navTarget(items, "1", "next"))).toBe("2");
    expect(id(navTarget(items, "2", "prev"))).toBe("1");
    expect(id(navTarget(items, "2", "next"))).toBe("3");
  });
  it("stops at the ends and jumps to the first and last rows", () => {
    expect(id(navTarget(items, "1", "prev"))).toBe("1");
    expect(id(navTarget(items, "3", "next"))).toBe("3");
    expect(id(navTarget(items, "2", "first"))).toBe("1");
    expect(id(navTarget(items, "1", "last"))).toBe("3");
    expect(navTarget(items, "x", "next")).toBe(-1);
  });
  it("picks the next row, else the previous one, as a deleted row's neighbour", () => {
    expect(neighbourRow(items, "2")?.id).toBe("3");
    expect(neighbourRow(items, "3")?.id).toBe("2");
    expect(neighbourRow(buildItems([msg("1", "u1", "2026-10-14T08:00:00Z")], { unreadAt: -1, variant: "chat" }), "1")).toBeUndefined();
  });
  it("treats reminders as rows: they carry a card and actions", () => {
    const reminders = buildItems([
      msg("R1", "sys", "2026-10-14T08:00:00Z", { kind: "reminder" } as never),
      msg("R2", "sys", "2026-10-14T08:01:00Z", { kind: "reminder" } as never),
    ], { unreadAt: -1, variant: "chat" });
    const rid = (i: number) => { const it = reminders[i]; return it?.kind === "message" ? it.m.id : undefined; };
    expect(rid(navTarget(reminders, "R1", "next"))).toBe("R2");
    expect(rid(navTarget(reminders, "R2", "first"))).toBe("R1");
    expect(neighbourRow(reminders, "R2")?.id).toBe("R1");
  });
});
