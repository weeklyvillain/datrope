import type { Attachment, Message } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { galleryItems, isMedia, isMediaFile, sections } from "./items";

let seq = 0;
const file = (content_type: string, filename = `f${++seq}`): Attachment =>
  ({ id: `a${++seq}`, channel_id: "c", content_type, filename, inline: true, size: 1, url: `/f/${seq}` });
const msg = (id: string, at: string, author: string, attachments: Attachment[], o: Partial<Message> = {}): Message =>
  ({ id, channel_id: "c", content: "", created_at: at, deleted: false, pinned: false, mentions: null, reactions: null,
    author: { id: author, username: author } as Message["author"], attachments, ...o });

const photoA = file("image/png", "a.png");
const photoB = file("image/jpeg", "b.jpg");
const clip = file("video/mp4", "clip.mp4");
const notes = file("text/plain", "notes.txt");
// Oldest first, as the store keeps them.
const messages = [
  msg("1", "2026-09-01T10:00:00", "alice", [photoA, photoB]),
  msg("2", "2026-09-02T10:00:00", "bob", [clip, notes]),
  msg("3", "2026-09-03T10:00:00", "bob", [file("image/png")], { deleted: true }),
];
const ids = (xs: { attachment: Attachment }[]) => xs.map((x) => x.attachment.filename);

describe("isMedia", () => {
  it("accepts images and videos only", () => {
    expect(isMedia("image/webp")).toBe(true);
    expect(isMedia("video/quicktime")).toBe(true);
    expect(isMedia("audio/mpeg")).toBe(false);
    expect(isMedia("text/plain")).toBe(false);
  });
});

describe("galleryItems", () => {
  const all = { kind: "all" as const, uploader: null };

  it("gives one item per media attachment, newest first, skipping deleted messages", () => {
    expect(ids(galleryItems(messages, all))).toEqual(["clip.mp4", "a.png", "b.jpg"]);
  });

  it("marks photos and videos", () => {
    expect(galleryItems(messages, all).map((x) => x.kind)).toEqual(["video", "photo", "photo"]);
  });

  it("filters by kind", () => {
    expect(ids(galleryItems(messages, { kind: "photo", uploader: null }))).toEqual(["a.png", "b.jpg"]);
    expect(ids(galleryItems(messages, { kind: "video", uploader: null }))).toEqual(["clip.mp4"]);
  });

  it("filters by uploader", () => {
    expect(ids(galleryItems(messages, { kind: "all", uploader: "alice" }))).toEqual(["a.png", "b.jpg"]);
    expect(ids(galleryItems(messages, { kind: "photo", uploader: "bob" }))).toEqual([]);
  });
});

describe("sections", () => {
  const now = new Date("2026-10-10T12:00:00");
  const at = (when: string) => galleryItems([msg(when, when, "alice", [file("image/png", when)])], { kind: "all", uploader: null })[0];

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

describe("isMediaFile", () => {
  it("trusts the browser's type when it has one", () => {
    expect(isMediaFile({ type: "image/png", name: "a.txt" })).toBe(true);
    expect(isMediaFile({ type: "text/plain", name: "a.png" })).toBe(false);
  });
  it("falls back to the extension when the browser reports no type", () => {
    expect(isMediaFile({ type: "", name: "clip.MKV" })).toBe(true);
    expect(isMediaFile({ type: "", name: "photo.jpeg" })).toBe(true);
    expect(isMediaFile({ type: "", name: "notes" })).toBe(false);
    expect(isMediaFile({ type: "", name: "IMG_1.heic" })).toBe(false); // the server can't recognise HEIC
  });
});
