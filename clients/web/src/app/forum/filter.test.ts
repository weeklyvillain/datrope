import type { ThreadListItem } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { filterPosts } from "./filter";

const EPOCH = 1767225600000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const idAt = (ms: number) => String(BigInt(ms - EPOCH) << 22n);

const post = (title: string, o: { at: number; last?: number; count?: number; tags?: string[]; excerpt?: string }): ThreadListItem => ({
  channel: { id: idAt(T0 + o.at), name: title, tags: o.tags ?? [] } as unknown as ThreadListItem["channel"],
  summary: { id: idAt(T0 + o.at), name: title, message_count: o.count ?? 1, participants: [],
    ...(o.last !== undefined ? { last_message_at: new Date(T0 + o.last).toISOString() } : {}) },
  ...(o.excerpt ? { excerpt: o.excerpt } : {}),
});

const soundboard = post("Soundboard for voice", { at: 1000, last: 9000, count: 13, tags: ["Feature"], excerpt: "Short clips like the airhorn" });
const linux = post("Screen share is black on Linux", { at: 3000, count: 8, tags: ["Bug"], excerpt: "Wayland shows a black frame" });
const calendar = post("Shared calendar", { at: 2000, count: 1, tags: ["Feature", "Done"] });
const all = [soundboard, linux, calendar];
const titles = (xs: ThreadListItem[]) => xs.map((x) => x.channel.name);

describe("filterPosts", () => {
  const f = { query: "", tag: null, sort: "activity" as const };

  it("matches the query against the title, ignoring case", () => {
    expect(titles(filterPosts(all, { ...f, query: "SOUNDBOARD" }))).toEqual(["Soundboard for voice"]);
  });

  it("matches the query against the excerpt", () => {
    expect(titles(filterPosts(all, { ...f, query: "wayland" }))).toEqual(["Screen share is black on Linux"]);
  });

  it("keeps only posts with the tag", () => {
    expect(titles(filterPosts(all, { ...f, tag: "Feature" }))).toEqual(["Soundboard for voice", "Shared calendar"]);
    expect(titles(filterPosts(all, { ...f, tag: "Done" }))).toEqual(["Shared calendar"]);
  });

  it("sorts by latest activity", () => {
    expect(titles(filterPosts(all, f))).toEqual(["Soundboard for voice", "Screen share is black on Linux", "Shared calendar"]);
  });

  it("sorts newest first by ID", () => {
    expect(titles(filterPosts(all, { ...f, sort: "newest" }))).toEqual(["Screen share is black on Linux", "Shared calendar", "Soundboard for voice"]);
  });

  it("sorts by most replies", () => {
    expect(titles(filterPosts(all, { ...f, sort: "replies" }))).toEqual(["Soundboard for voice", "Screen share is black on Linux", "Shared calendar"]);
  });

  it("does not change the input", () => {
    const input = [calendar, soundboard];
    filterPosts(input, { ...f, sort: "replies" });
    expect(input).toEqual([calendar, soundboard]);
  });
});
