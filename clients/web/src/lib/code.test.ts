import { describe, expect, it } from "vitest";
import { extensionForLanguage, fileExtension, shouldSnippet, snippetName, splitLines, wrapCodeBlock } from "./code";

describe("shouldSnippet", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
  it("keeps short pastes as text", () => {
    expect(shouldSnippet("const a = 1;", 4000, true)).toBe(false);
    expect(shouldSnippet("x".repeat(1500), 4000, true)).toBe(false);
    expect(shouldSnippet(lines(40), 4000, true)).toBe(false);
  });
  it("snippets long or tall pastes", () => {
    expect(shouldSnippet("x".repeat(1501), 4000, true)).toBe(true);
    expect(shouldSnippet(lines(41), 4000, true)).toBe(true);
  });
  it("snippets a paste that does not fit in the room left", () => {
    expect(shouldSnippet("x".repeat(100), 99, true)).toBe(true);
  });
  it("never snippets without the attach permission", () => {
    expect(shouldSnippet("x".repeat(5000), 10, false)).toBe(false);
  });
});

describe("wrapCodeBlock", () => {
  it("wraps a selection with the language", () => {
    expect(wrapCodeBlock("a = 1", "python", true, true)).toEqual({ value: "```python\na = 1\n```", caret: 19 });
  });
  it("puts the caret inside an empty block", () => {
    const { value, caret } = wrapCodeBlock("", "", true, true);
    expect(value).toBe("```\n\n```");
    expect(value.slice(0, caret)).toBe("```\n");
  });
  it("starts on a new line mid-line", () => {
    expect(wrapCodeBlock("x", "", false, true).value).toBe("\n```\nx\n```");
  });
  it("drops one trailing newline of the selection", () => {
    expect(wrapCodeBlock("x\n", "", true, true).value).toBe("```\nx\n```");
  });
  it("puts the closing fence on its own line when text follows the selection", () => {
    const { value, caret } = wrapCodeBlock("foo", "", true, false);
    expect(value).toBe("```\nfoo\n```\n");
    expect(caret).toBe("```\nfoo\n```".length);
  });
});

describe("file names", () => {
  it.each([
    ["typescript", "ts"], ["javascript", "js"], ["python", "py"], ["go", "go"], ["rust", "rs"],
    ["json", "json"], ["yaml", "yaml"], ["bash", "sh"], ["shell", "sh"], ["csharp", "cs"], ["cpp", "cpp"],
    ["markdown", "md"], ["xml", "xml"], ["powershell", "ps1"], ["kotlin", "kt"], ["ruby", "rb"],
    ["plaintext", "txt"], ["something-else", "txt"],
  ])("%s → .%s", (lang, ext) => expect(extensionForLanguage(lang)).toBe(ext));
  it("defaults to txt", () => expect(extensionForLanguage(undefined)).toBe("txt"));

  it.each([["main.go", "go"], ["App.TSX", "tsx"], ["Dockerfile", "dockerfile"], ["archive.tar.gz", "gz"], ["notes.txt", "txt"]])(
    "%s → %s", (name, ext) => expect(fileExtension(name)).toBe(ext));

  it("keeps a snippet name valid", () => {
    expect(snippetName("  util.ts ", "snippet.txt")).toBe("util.ts");
    expect(snippetName("   ", "snippet.txt")).toBe("snippet.txt");
    expect(snippetName("a/b\\c.ts", "snippet.txt")).toBe("a_b_c.ts");
  });
});

describe("splitLines", () => {
  it("normalises CRLF and ignores one trailing newline", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitLines("a\rb")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([""]);
  });
});
