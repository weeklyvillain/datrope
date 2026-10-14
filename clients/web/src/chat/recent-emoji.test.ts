import { describe, expect, it } from "vitest";
import { mergeRecent, DEFAULT_QUICK } from "./recent-emoji";

describe("recent emoji", () => {
  it("moves a used emoji to the front without duplicates", () =>
    expect(mergeRecent(["👍", "🔥", "❤️"], "🔥")).toEqual(["🔥", "👍", "❤️"]));
  it("caps the list", () => expect(mergeRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]));
  it("has six defaults", () => expect(DEFAULT_QUICK).toHaveLength(6));
});
