import type { Channel } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { inGallery, liveIds, sourceSummary, sourcesChanged } from "./sources";

const ch = (id: string, extra: Partial<Channel> = {}) => ({ id, name: id, type: "gallery", ...extra }) as Channel;

describe("inGallery", () => {
  it("always holds the gallery's own posts", () => {
    expect(inGallery(ch("g", { gallery_sources: "none" }), "g")).toBe(true);
    expect(inGallery(ch("g", { gallery_sources: "none" }), "x")).toBe(false);
  });
  it("holds every channel with all, and the picked ones with selected", () => {
    expect(inGallery(ch("g", { gallery_sources: "all" }), "x")).toBe(true);
    expect(inGallery(ch("g", { gallery_sources: "selected", source_channel_ids: ["a"] }), "a")).toBe(true);
    expect(inGallery(ch("g", { gallery_sources: "selected", source_channel_ids: ["a"] }), "b")).toBe(false);
  });
});

describe("sourceSummary", () => {
  const channels = { a: ch("a", { name: "memes", type: "text" }), b: ch("b", { name: "builds", type: "text" }) };
  it("says where files come from", () => {
    expect(sourceSummary(ch("g", { gallery_sources: "none" }), channels)).toBe("");
    expect(sourceSummary(ch("g", { gallery_sources: "all" }), channels)).toBe("from all channels");
    expect(sourceSummary(ch("g", { gallery_sources: "selected", source_channel_ids: ["a"] }), channels)).toBe("posts here + #memes");
    expect(sourceSummary(ch("g", { gallery_sources: "selected", source_channel_ids: ["a", "b", "gone"] }), channels)).toBe("posts here + 2 channels");
    expect(sourceSummary(ch("g", { gallery_sources: "selected", source_channel_ids: ["gone"] }), channels)).toBe("");
  });
});

describe("liveIds and sourcesChanged", () => {
  const channels = { a: ch("a", { type: "text" }), b: ch("b", { type: "text" }) };
  it("drops ids of channels that no longer exist", () => {
    expect(liveIds(["a", "gone", "b"], channels)).toEqual(["a", "b"]);
    expect(liveIds(undefined, channels)).toEqual([]);
  });
  it("sees a change in mode or in the picked set only", () => {
    const g = ch("g", { gallery_sources: "selected", source_channel_ids: ["a", "gone"] });
    expect(sourcesChanged(g, { mode: "selected", ids: ["a"] }, channels)).toBe(false);
    expect(sourcesChanged(g, { mode: "selected", ids: ["a", "b"] }, channels)).toBe(true);
    expect(sourcesChanged(g, { mode: "all", ids: [] }, channels)).toBe(true);
    expect(sourcesChanged(ch("g", { gallery_sources: "all" }), { mode: "all", ids: [] }, channels)).toBe(false);
    expect(sourcesChanged(ch("g"), { mode: "none", ids: [] }, channels)).toBe(false);
  });
});
