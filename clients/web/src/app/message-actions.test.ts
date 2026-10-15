import { describe, expect, it } from "vitest";
import { messageActions } from "./message-actions";

const all = { reply: true, react: true, thread: true, hasThread: false, edit: true, pin: true, pinned: false, album: true, remind: true, delete: true, files: false };

describe("messageActions", () => {
  it("lists everything for a normal message", () =>
    expect(messageActions({ content: "hi", attachments: [{}] }, all)).toEqual(["react", "copy", "reply", "thread", "edit", "pin", "remind", "album", "delete"]));
  it("image-only messages have no Copy", () =>
    expect(messageActions({ content: "", attachments: [{}] }, all)).not.toContain("copy"));
  it("system, deleted and pending messages open nothing", () => {
    expect(messageActions({ content: "x", kind: "member_leave" }, all)).toBeNull();
    expect(messageActions({ content: "x", deleted: true }, all)).toBeNull();
    expect(messageActions({ content: "x", pending: true }, all)).toBeNull();
  });
  it("a reminder keeps React and Copy", () =>
    expect(messageActions({ content: "Reminder", kind: "reminder" }, { ...all, reply: false, thread: false, edit: false, pin: false, album: false, remind: false, delete: false })).toEqual(["react", "copy"]));
  it("respects permissions", () =>
    expect(messageActions({ content: "x" }, { ...all, react: false, edit: false, delete: false, album: false, remind: false }))
      .toEqual(["copy", "reply", "thread", "pin"]));
  it("offers Remind me only when allowed", () =>
    expect(messageActions({ content: "x" }, { ...all, remind: false })).not.toContain("remind"));
  it("offers no thread row when I cannot open or create one", () =>
    expect(messageActions({ content: "x" }, { ...all, thread: false, hasThread: false })).not.toContain("thread"));
  it("offers nothing but an empty list when no permissions apply", () =>
    expect(messageActions({ content: "" }, { reply: false, react: false, thread: false, hasThread: false, edit: false, pin: false, pinned: false, album: false, remind: false, delete: false, files: false })).toEqual([]));
  it("offers no album row when every file has expired", () => {
    expect(messageActions({ content: "x", attachments: [{ expired: true }] }, all)).not.toContain("album");
    expect(messageActions({ content: "x", attachments: [{ expired: true }, { expired: false }] }, all)).toContain("album");
  });
  it("offers file actions to whoever may manage them", () => {
    const files = [{ expires_at: "2026-10-20T00:00:00Z", keep: false, expired: false }];
    expect(messageActions({ content: "x", attachments: files }, { ...all, files: true })).toEqual(expect.arrayContaining(["keepFiles", "removeFiles"]));
    expect(messageActions({ content: "x", attachments: [{ keep: true, expired: false }] }, { ...all, files: true })).toContain("unkeepFiles");
    expect(messageActions({ content: "x", attachments: files }, { ...all, files: false })).not.toContain("removeFiles");
  });
});
