import type { ThreadListItem } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { byActivity, repliesText, timeAgo } from "./threads";

const now = Date.parse("2026-10-09T12:00:00Z");
const ago = (s: number) => new Date(now - s * 1000).toISOString();
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

describe("timeAgo", () => {
  it("says now under a minute", () => {
    expect(timeAgo(ago(30), now)).toBe(rtf.format(0, "second"));
  });
  it("picks the largest whole unit", () => {
    expect(timeAgo(ago(10 * 60), now)).toBe(rtf.format(-10, "minute"));
    expect(timeAgo(ago(3 * 3600), now)).toBe(rtf.format(-3, "hour"));
    expect(timeAgo(ago(2 * 86400), now)).toBe(rtf.format(-2, "day"));
    expect(timeAgo(ago(14 * 86400), now)).toBe(rtf.format(-2, "week"));
  });
});

describe("repliesText", () => {
  it("counts replies", () => {
    expect(repliesText(1)).toBe("1 reply");
    expect(repliesText(4)).toBe("4 replies");
  });
});

const EPOCH = 1767225600000;
const idAt = (ms: number) => String(BigInt(ms - EPOCH) << 22n);
const item = (createdMs: number, lastMs?: number): ThreadListItem => ({
  channel: { id: idAt(createdMs), name: String(createdMs) } as ThreadListItem["channel"],
  summary: { id: idAt(createdMs), name: "", message_count: lastMs ? 1 : 0, participants: [],
    ...(lastMs ? { last_message_at: new Date(lastMs).toISOString() } : {}) },
});

describe("byActivity", () => {
  it("orders by last reply, or creation when there is none, newest first", () => {
    const t0 = Date.parse("2026-10-01T00:00:00Z");
    const old = item(t0, t0 + 5000);
    const fresh = item(t0 + 3000);
    const quiet = item(t0 + 1000);
    expect(byActivity([quiet, old, fresh]).map((t) => t.channel.name)).toEqual([old, fresh, quiet].map((t) => t.channel.name));
  });
});
