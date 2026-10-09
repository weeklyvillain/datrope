import { describe, expect, it } from "vitest";
import { nameFromFile, validateNames } from "./emojiNames";

describe("emoji names", () => {
  it.each([
    ["Party Parrot.png", "party_parrot"],
    ["IMG_2041.GIF", "img_2041"],
    ["a.png", "a_"],
    ["---.webp", "emoji"],
    ["very-long-name-that-keeps-going-forever.png", "very_long_name_that_keeps_going_"],
  ])("%s", (file, want) => expect(nameFromFile(file)).toBe(want));

  it("flags bad, taken and duplicate names", () => {
    expect(validateNames([{ name: "ok_1" }, { name: "Taken" }, { name: "dup" }, { name: "DUP" }, { name: "x y" }], ["taken"]))
      .toEqual([null, "Already used", "Duplicate name", "Duplicate name", "Use letters, digits and _ (2–32)"]);
  });
});
