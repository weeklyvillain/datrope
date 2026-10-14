import { describe, expect, it } from "vitest";
import { messageActions } from "./message-actions";

const all = { reply: true, react: true, thread: true, hasThread: false, edit: true, pin: true, pinned: false, album: true, delete: true };

describe("messageActions", () => {
  it("lists everything for a normal message", () =>
    expect(messageActions({ content: "hi", attachments: [{}] }, all)).toEqual(["react", "reply", "thread", "edit", "copy", "pin", "album", "delete"]));
  it("image-only messages have no Copy", () =>
    expect(messageActions({ content: "", attachments: [{}] }, all)).not.toContain("copy"));
  it("system, deleted and pending messages open nothing", () => {
    expect(messageActions({ content: "x", kind: "member_leave" }, all)).toBeNull();
    expect(messageActions({ content: "x", deleted: true }, all)).toBeNull();
    expect(messageActions({ content: "x", pending: true }, all)).toBeNull();
  });
  it("respects permissions", () =>
    expect(messageActions({ content: "x" }, { ...all, react: false, edit: false, delete: false, album: false }))
      .toEqual(["reply", "thread", "copy", "pin"]));
  it("offers no thread row when I cannot open or create one", () =>
    expect(messageActions({ content: "x" }, { ...all, thread: false, hasThread: false })).not.toContain("thread"));
  it("offers nothing but an empty list when no permissions apply", () =>
    expect(messageActions({ content: "" }, { reply: false, react: false, thread: false, hasThread: false, edit: false, pin: false, pinned: false, album: false, delete: false })).toEqual([]));
});
