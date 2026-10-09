import { describe, expect, it } from "vitest";
import { splitHighlights } from "./highlight";

describe("splitHighlights", () => {
  it("marks whole words, ignoring case", () => {
    expect(splitHighlights("I have Wingspan and wingspans", ["wingspan"])).toEqual([
      { text: "I have ", mark: false },
      { text: "Wingspan", mark: true },
      { text: " and wingspans", mark: false },
    ]);
  });

  it("marks several terms and letters beyond ASCII", () => {
    expect(splitHighlights("Café board, board-game", ["board", "café"]).filter((p) => p.mark).map((p) => p.text))
      .toEqual(["Café", "board", "board"]);
  });

  it("leaves text alone without terms", () => {
    expect(splitHighlights("hello", [])).toEqual([{ text: "hello", mark: false }]);
    expect(splitHighlights("a+b (c)", ["+", "("])).toEqual([{ text: "a+b (c)", mark: false }]);
  });
});
