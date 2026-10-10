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
    ["/", 1, { kind: "command", query: "", start: 0 }],
    ["/shr", 4, { kind: "command", query: "shr", start: 0 }],
    ["/shrug hi", 9, null], // past the name: the picker closes
    ["/shrug hi", 3, { kind: "command", query: "sh", start: 0 }], // caret back inside the name
    ["hi /shr", 7, null], // only at the very start of the message
    ["a\n/shr", 6, null], // not at the start of a later line either
    ["//", 2, null], // the // escape
    ["/usr/bin", 8, null],
  ])("%s", (text, caret, want) => {
    expect(findTrigger(text as string, caret as number)).toEqual(want);
  });

  it("ranks prefix matches first, then shorter keys", () => {
    const items = ["sparrow", "parrot", "party_parrot", "pa"].map((key) => ({ key }));
    expect(rank("par", items).map((i) => i.key)).toEqual(["parrot", "party_parrot", "sparrow"]);
  });
});
