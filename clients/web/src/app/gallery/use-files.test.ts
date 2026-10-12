import type { FileItem } from "@datrope/core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTER } from "./filter";
vi.mock("../../session", () => ({ client: {}, errorText: String, useApp: () => ({}) }));

import { dropMessage, mergeHead, paramsFor, patchThread } from "./use-files";

const it_ = (att: string, msg = `m${att}`) => ({ attachment: { id: att }, message: { id: msg } }) as unknown as FileItem;
const ids = (xs: FileItem[]) => xs.map((x) => x.attachment.id);

describe("mergeHead", () => {
  it("puts new files first and keeps one copy of each", () => {
    expect(ids(mergeHead([it_("5"), it_("4"), it_("3")], [it_("7"), it_("6"), it_("5"), it_("4")]))).toEqual(["7", "6", "5", "4", "3"]);
  });
  it("takes the fresh copy of a file already shown", () => {
    const fresh = { ...it_("5"), kind: "audio" } as FileItem;
    expect(mergeHead([it_("5")], [fresh])[0]).toBe(fresh);
  });
});

describe("dropMessage", () => {
  it("removes every file of a deleted message", () => {
    expect(ids(dropMessage([it_("1", "m"), it_("2", "m"), it_("3")], "m"))).toEqual(["3"]);
  });
  it("keeps album uploads, which have no message", () => {
    const upload = { attachment: { id: "u" }, uploader_id: "u1" } as unknown as FileItem;
    expect(ids(dropMessage([upload, it_("1", "m")], "m"))).toEqual(["u"]);
  });
});

describe("patchThread", () => {
  it("sets the thread on every file of its parent message and leaves the rest alone", () => {
    const thread = { id: "t", name: "t", message_count: 1, participants: [] };
    const cur = [it_("1", "m"), it_("2", "m"), it_("3")];
    const out = patchThread(cur, { channel_id: "c", message_id: "m", thread } as never);
    expect(out.map((x) => x.message?.thread)).toEqual([thread, thread, undefined]);
    expect(out[2]).toBe(cur[2]);
  });
  it("leaves album uploads alone", () => {
    const upload = { attachment: { id: "u" }, uploader_id: "u1" } as unknown as FileItem;
    expect(patchThread([upload], { channel_id: "c", message_id: "m", thread: {} } as never)[0]).toBe(upload);
  });
});

describe("paramsFor", () => {
  it("pins the channel in channel scope and maps the filter", () => {
    expect(paramsFor({ kind: "channel", channelId: "c1" }, { ...DEFAULT_FILTER, kind: "audio", channels: ["x"], q: " riff " }))
      .toEqual({ kinds: ["audio"], channels: ["c1"], q: "riff", uploader: undefined });
    expect(paramsFor({ kind: "global" }, DEFAULT_FILTER)).toEqual({ kinds: undefined, channels: undefined, q: undefined, uploader: undefined });
  });

  it("does not filter an album by channel", () => {
    expect(paramsFor({ kind: "album", albumId: "7" }, { ...DEFAULT_FILTER, channels: ["1"] }).channels).toBeUndefined();
  });
});
