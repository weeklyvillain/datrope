import { describe, expect, it } from "vitest";
import { findTrigger, rank } from "./autocomplete";

describe("composer autocomplete", () => {
  it.each([
    ["hi @bo", 6, { kind: "mention", query: "bo", start: 3 }],
    ["@a", 2, null], // one character after @ is not enough
    ["mail a@b", 8, null],
    ["nice :par", 9, { kind: "emoji", query: "par", start: 5 }],
    ["time 10:30", 10, null],
    ["done :parrot: ", 14, null],
    ["`@bob", 5, null],
  ])("%s", (text, caret, want) => {
    expect(findTrigger(text as string, caret as number)).toEqual(want);
  });

  it("ranks prefix matches first, then shorter keys", () => {
    const items = ["sparrow", "parrot", "party_parrot", "pa"].map((key) => ({ key }));
    expect(rank("par", items).map((i) => i.key)).toEqual(["parrot", "party_parrot", "sparrow"]);
  });
});
