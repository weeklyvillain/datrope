import type { Attachment, Message } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { audioOnly, audioRun, itemTitle, sections, type GalleryItem } from "./items";

let seq = 0;
const file = (content_type: string, filename = `f${++seq}`): Attachment =>
  ({ id: `a${++seq}`, channel_id: "c", content_type, filename, inline: true, size: 1, url: `/f/${seq}` });
const msg = (id: string, at: string, author: string, attachments: Attachment[], o: Partial<Message> = {}): Message =>
  ({ id, channel_id: "c", content: "", created_at: at, deleted: false, pinned: false, mentions: null, mention_roles: null, reactions: null,
    author: { id: author, username: author } as Message["author"], attachments, ...o });

describe("sections", () => {
  const now = new Date("2026-10-10T12:00:00");
  const at = (when: string) => ({
    attachment: file("image/png", when), message: msg(when, when, "alice", []), channel: { id: "c", type: "text", name: "general" }, kind: "image", created_at: when,
  }) as GalleryItem;

  it("puts the last 7 days under This week and older items under their month", () => {
    const items = [at("2026-10-04T13:00:00"), at("2026-10-03T11:00:00"), at("2026-09-30T09:00:00"), at("2026-09-02T09:00:00")];
    const got = sections(items, now);
    expect(got.map((s) => s.label)).toEqual(["This week", "October", "September"]);
    expect(got.map((s) => s.items.length)).toEqual([1, 1, 2]);
  });

  it("adds the year to months of another year", () => {
    const got = sections([at("2026-01-05T09:00:00"), at("2025-12-30T09:00:00"), at("2025-09-01T09:00:00")], now);
    expect(got.map((s) => s.label)).toEqual(["January", "December 2025", "September 2025"]);
  });

  it("gives no sections for no items", () => {
    expect(sections([], now)).toEqual([]);
  });
});

describe("audioRun", () => {
  const it_ = (kind: GalleryItem["kind"]) => ({ attachment: file("x/y"), message: msg("m", "2026-10-01T00:00:00", "alice", []),
    channel: { id: "c", type: "text", name: "general" }, kind }) as GalleryItem;

  it("plays the audio files only, starting at the chosen one", () => {
    const [a1, img, a2, a3] = [it_("audio"), it_("image"), it_("audio"), it_("audio")];
    expect(audioRun([a1, img, a2, a3], a2)).toEqual({ run: [a1, a2, a3], at: 1 });
  });

  it("keeps only the audio files, in order", () => {
    const [a1, img, doc, a2] = [it_("audio"), it_("image"), it_("document"), it_("audio")];
    expect(audioOnly([a1, img, doc, a2])).toEqual([a1, a2]);
  });

  it("starts at the top when the chosen file is not audio", () => {
    const [a1, img] = [it_("audio"), it_("image")];
    expect(audioRun([a1, img], img)).toEqual({ run: [a1], at: 0 });
  });
});

describe("album uploads", () => {
  const upload = { attachment: file("image/png", "beach.png"), kind: "image", uploader_id: "u1", created_at: "2026-10-09T10:00:00" } as GalleryItem;

  it("are sectioned by upload time", () => {
    expect(sections([upload], new Date("2026-10-10T12:00:00")).map((s) => s.label)).toEqual(["This week"]);
  });

  it("are titled by file name", () => {
    expect(itemTitle(upload)).toBe("beach.png");
  });
});
