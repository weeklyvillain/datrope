import type { FileItem } from "@datrope/core";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../session", () => ({ client: {}, displayName: (u: { name: string }) => u.name, formatBytes: String }));
vi.mock("../message-author", () => ({ shownAuthor: (m: { author: unknown }) => m.author }));

import { channelTag, discToken, tileLabel } from "./FileTile";

const item = (over: Partial<FileItem["channel"]> = {}, kind: FileItem["kind"] = "image") => ({
  kind,
  attachment: { id: "a1", filename: "cat.png" },
  message: { id: "m1", content: "", author: { name: "Ada" } },
  channel: { id: "c1", name: "art", type: "gallery", ...over },
}) as unknown as FileItem;

describe("channelTag", () => {
  it("is the channel's name", () => {
    expect(channelTag(item())).toBe("art");
  });
  it("is the parent's name for a thread", () => {
    expect(channelTag(item({ id: "t1", name: "a thread", type: "thread", parent_id: "c1", parent_name: "art" }))).toBe("art");
  });
});

describe("discToken", () => {
  it("picks one of the eight avatar tokens, the same each time", () => {
    expect(discToken("123")).toMatch(/^var\(--avatar-[1-8]\)$/);
    expect(discToken("123")).toBe(discToken("123"));
  });
});

describe("tileLabel", () => {
  it("names the kind, title and uploader", () => {
    expect(tileLabel(item(), false)).toBe("Photo: cat.png, by Ada");
  });
  it("adds the channel in the global gallery", () => {
    expect(tileLabel(item({}, "audio"), true)).toBe("Track: cat.png, by Ada, in #art");
  });
});
