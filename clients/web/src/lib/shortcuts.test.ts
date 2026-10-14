import { describe, expect, it } from "vitest";
import { isEditableTarget, isTypeToFocus, matchShortcut } from "./shortcuts";

const k = (key: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...m,
});

describe("matchShortcut", () => {
  it("matches navigation keys", () => {
    expect(matchShortcut(k("ArrowUp", { altKey: true }), false)).toBe("channel-prev");
    expect(matchShortcut(k("ArrowDown", { altKey: true }), false)).toBe("channel-next");
    expect(matchShortcut(k("ArrowUp", { altKey: true, shiftKey: true }), false)).toBe("unread-prev");
    expect(matchShortcut(k("ArrowDown", { altKey: true, shiftKey: true }), false)).toBe("unread-next");
  });
  it("uses Ctrl off macOS and Cmd on macOS", () => {
    expect(matchShortcut(k("f", { ctrlKey: true }), false)).toBe("search");
    expect(matchShortcut(k("f", { metaKey: true }), true)).toBe("search");
    expect(matchShortcut(k("f", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(k("M", { ctrlKey: true, shiftKey: true }), false)).toBe("mute");
    expect(matchShortcut(k("D", { ctrlKey: true, shiftKey: true }), false)).toBe("deafen");
    expect(matchShortcut(k("/", { ctrlKey: true }), false)).toBe("sheet");
    expect(matchShortcut(k("/", { ctrlKey: true, shiftKey: true }), false)).toBe("sheet");
    expect(matchShortcut(k("?", { ctrlKey: true }), false)).toBe("sheet");
    expect(matchShortcut({ ...k("-", { ctrlKey: true }), code: "Slash" }, false)).toBeNull();
  });
  it("ignores IME composition and stray modifiers", () => {
    expect(matchShortcut(k("f", { ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(matchShortcut(k("f", { ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});

describe("type to focus", () => {
  it("only for printable keys without modifiers outside fields", () => {
    expect(isTypeToFocus(k("a"), { tagName: "BODY" })).toBe(true);
    expect(isTypeToFocus(k("a", { ctrlKey: true }), { tagName: "BODY" })).toBe(false);
    expect(isTypeToFocus(k("Enter"), { tagName: "BODY" })).toBe(false);
    expect(isTypeToFocus(k(" "), { tagName: "BODY" })).toBe(false);
    expect(isTypeToFocus(k("a"), { tagName: "INPUT" })).toBe(false);
    expect(isTypeToFocus(k("a"), { tagName: "DIV", isContentEditable: true })).toBe(false);
    expect(isTypeToFocus(k("a", { isComposing: true }), { tagName: "BODY" })).toBe(false);
  });
  it("skips controls that use keys themselves", () => {
    const inside = (sel: string) => ({ tagName: "SPAN", closest: (s: string) => (s.includes(sel) ? {} : null) });
    for (const sel of ["[role=slider]", "[role=tab]", "[role=option]", "[role=menuitem]", "video"]) expect(isTypeToFocus(k("a"), inside(sel))).toBe(false);
  });
  it("knows editable targets", () => {
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
  });
  it("skips message rows, whose letters are row actions", () => {
    expect(isTypeToFocus(k("r"), { tagName: "DIV", closest: (s: string) => (s.includes("[data-message-row]") ? {} : null) })).toBe(false);
  });
});
