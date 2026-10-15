import { describe, expect, it } from "vitest";
import { convertShortcodeAt, limitEdit, segments, serialize, spliceText, type MiniNode } from "./rich-text";

const custom = (n: string) => n === "parrot" || n === "blob_ok";

describe("segments", () => {
  it("splits known custom emoji into atoms and keeps the rest as text", () =>
    expect(segments("hi :Parrot: and :nope: :blob_ok:", custom)).toEqual([
      { kind: "text", text: "hi " }, { kind: "emoji", code: ":Parrot:" }, { kind: "text", text: " and :nope: " }, { kind: "emoji", code: ":blob_ok:" },
    ]));
  it("handles adjacent atoms and empty input", () => {
    expect(segments(":parrot::parrot:", custom)).toEqual([{ kind: "emoji", code: ":parrot:" }, { kind: "emoji", code: ":parrot:" }]);
    expect(segments("", custom)).toEqual([]);
  });
});

describe("convertShortcodeAt", () => {
  const codes = new Map([["smile", "😄"], ["+1", "👍"]]);
  it("replaces a just-closed unicode shortcode", () =>
    expect(convertShortcodeAt("hi :smile: there", 10, codes)).toEqual({ value: "hi 😄 there", caret: 3 + "😄".length }));
  it("ignores shortcodes not at the caret, unknown codes and custom ones", () => {
    expect(convertShortcodeAt(":smile: x", 9, codes)).toEqual({ value: ":smile: x", caret: 9 });
    expect(convertShortcodeAt(":parrot:", 8, codes)).toEqual({ value: ":parrot:", caret: 8 });
    expect(convertShortcodeAt(":smile:", 7, null)).toEqual({ value: ":smile:", caret: 7 });
  });
  it("is case-insensitive", () => expect(convertShortcodeAt(":Smile:", 7, codes).value).toBe("😄"));
  it("leaves inline code alone", () => expect(convertShortcodeAt("`:smile:", 8, codes).value).toBe("`:smile:"));
});

const t = (data: string): MiniNode => ({ nodeType: 3, nodeName: "#text", data, childNodes: [] });
const el = (name: string, kids: MiniNode[] = [], attrs: Record<string, string> = {}): MiniNode =>
  ({ nodeType: 1, nodeName: name.toUpperCase(), childNodes: kids, getAttribute: (n) => attrs[n] ?? null });

describe("serialize", () => {
  it("reads text, atoms and line breaks", () =>
    expect(serialize(el("div", [t("a "), el("img", [], { "data-emoji": ":parrot:" }), t("\nb"), el("br", [], { "data-filler": "" })]))).toBe("a :parrot:\nb"));
  it("turns a stray <br> into a newline and block elements into lines", () =>
    expect(serialize(el("div", [t("a"), el("br"), t("b"), el("div", [t("c")]), el("p", [t("d")])]))).toBe("a\nb\nc\nd"));
  it("keeps the text of stray inline elements", () =>
    expect(serialize(el("div", [el("b", [t("bold")]), el("span", [t(" x")])]))).toBe("bold x"));
  it("reads a non-breaking space as a space", () => expect(serialize(el("div", [t("a b")]))).toBe("a b"));
  it("ignores images that are not our emoji", () => expect(serialize(el("div", [el("img"), t("x")]))).toBe("x"));
  it("ignores the <br> that is the only child of a block", () => {
    expect(serialize(el("div", [t("a"), el("div", [el("br")])]))).toBe("a\n");
    expect(serialize(el("div", [el("div", [el("br")])]))).toBe("");
    expect(serialize(el("div", [t("a"), el("div", [el("br")]), el("div", [t("b")])]))).toBe("a\n\nb");
  });
  it("ignores a browser's placeholder <br> at the very end", () => {
    expect(serialize(el("div", [el("br")]))).toBe("");
    expect(serialize(el("div", [t("a"), el("br")]))).toBe("a");
  });
});

describe("spliceText", () => {
  it("replaces the selection and puts the caret after the insert", () =>
    expect(spliceText("hello world", 6, 11, "there", 4000)).toEqual({ value: "hello there", caret: 11 }));
  it("cuts to the length limit", () => expect(spliceText("abc", 3, 3, "defg", 5)).toEqual({ value: "abcde", caret: 5 }));
  it("can count the limit in code points", () =>
    expect(spliceText("ab", 2, 2, "😀😀", 3, "codepoint")).toEqual({ value: "ab😀", caret: 4 }));
  it("drops a lone high surrogate left by the cut", () =>
    expect(spliceText("", 0, 0, "ab😀", 3)).toEqual({ value: "ab", caret: 2 }));
  it("cuts the insert, not the text after it", () => {
    expect(spliceText("abcdef", 1, 1, "XYZ", 7)).toEqual({ value: "aXbcdef", caret: 2 });
    expect(spliceText("abcde", 1, 4, "XYZW", 5)).toEqual({ value: "aXYZe", caret: 4 });
  });
  it("drops a lone high surrogate at the end of the cut insert", () =>
    expect(spliceText("abc", 3, 3, "x😀", 5)).toEqual({ value: "abcx", caret: 4 }));
  it("inserts nothing when the text is already at or over the limit", () => {
    expect(spliceText("abcdef", 6, 6, "x", 4)).toEqual({ value: "abcdef", caret: 6 });
    expect(spliceText("abcd", 2, 2, "x", 4)).toEqual({ value: "abcd", caret: 2 });
  });
});

describe("limitEdit", () => {
  it("passes an edit within the limit through", () => expect(limitEdit("ab", "abc", 3, 5)).toEqual({ value: "abc", caret: 3 }));
  it("passes an edit that shortens an over-long text through", () =>
    expect(limitEdit("abcdef", "abcde", 5, 4)).toEqual({ value: "abcde", caret: 5 }));
  it("undoes a keystroke past the limit and keeps the caret where it was", () =>
    expect(limitEdit("abcde", "abXcde", 3, 5)).toEqual({ value: "abcde", caret: 2 }));
  it("cuts a longer insert (a composed word, autocorrect) to the room left", () =>
    expect(limitEdit("abc", "abHELLOc", 7, 5)).toEqual({ value: "abHEc", caret: 4 }));
  it("never splits a surrogate pair at the start of the change", () =>
    expect(limitEdit("x😀", "x😁y", 4, 3)).toEqual({ value: "x😁", caret: 3 }));
  it("can count the limit in code points, so an emoji is one", () => {
    expect(limitEdit("a😀b", "a😀Xb", 4, 3, "codepoint")).toEqual({ value: "a😀b", caret: 3 });
    expect(limitEdit("ab", "ab😀😀", 6, 3, "codepoint")).toEqual({ value: "ab😀", caret: 4 });
    expect(limitEdit("ab", "ab😀", 4, 3, "codepoint")).toEqual({ value: "ab😀", caret: 4 }); // fits: 3 code points
  });
  it("anchors at the caret next to repeated characters", () =>
    expect(limitEdit("hello", "helllo", 3, 5)).toEqual({ value: "hello", caret: 2 }));
  it("cuts an insert at the caret, not where the strings first differ", () =>
    expect(limitEdit("abc", "abXbc", 3, 4)).toEqual({ value: "abbc", caret: 2 })); // "bX" typed at 1, cut to "b"
  it("never splits a surrogate pair at the end of the change", () =>
    expect(limitEdit("a😀", "ab🈀", 2, 3)).toEqual({ value: "ab", caret: 2 })); // the whole pair is replaced; the cut insert keeps "b"
});
