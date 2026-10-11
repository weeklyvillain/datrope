import { describe, expect, it } from "vitest";
import { nameFromEmote, nameFromFile, sevenTVSetId, validateNames } from "./emojiNames";

describe("emoji names", () => {
  it.each([
    ["Party Parrot.png", "party_parrot"],
    ["IMG_2041.GIF", "img_2041"],
    ["a.png", "a_"],
    ["---.webp", "emoji"],
    ["very-long-name-that-keeps-going-forever.png", "very_long_name_that_keeps_going_"],
  ])("%s", (file, want) => expect(nameFromFile(file)).toBe(want));

  it.each([
    ["pepeLaugh", "pepeLaugh"],
    ["D:", "D_"],
    ["catJAM!!", "catJAM"],
    [":)", "emote"],
  ])("7TV %s", (name, want) => expect(nameFromEmote(name)).toBe(want));

  it.each([
    ["01J9MMS2R800036CR40E1041ED", "01J9MMS2R800036CR40E1041ED"],
    [" https://7tv.app/emote-sets/01J9MMS2R800036CR40E1041ED ", "01J9MMS2R800036CR40E1041ED"],
    ["https://7tv.app/emote-sets/60ae958e229664e8667aea38?tab=emotes", "60ae958e229664e8667aea38"],
    ["https://7tv.app/users/01FE9DRF000009TR6M9N941CYW", null],
    ["pepe", null],
  ])("set ID from %s", (input, want) => expect(sevenTVSetId(input)).toBe(want));

  it("flags bad, taken and duplicate names", () => {
    expect(validateNames([{ name: "ok_1" }, { name: "Taken" }, { name: "dup" }, { name: "DUP" }, { name: "x y" }], ["taken"]))
      .toEqual([null, "Already used", "Duplicate name", "Duplicate name", "Use letters, digits and _ (2–32)"]);
  });
});
