import { describe, expect, it } from "vitest";
import { nextIndex } from "./roving";

describe("nextIndex", () => {
  it("moves vertically and clamps (no wrap)", () => {
    expect(nextIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextIndex("ArrowDown", 2, 3)).toBe(2);
    expect(nextIndex("ArrowUp", 0, 3)).toBe(0);
    expect(nextIndex("Home", 2, 3)).toBe(0);
    expect(nextIndex("End", 0, 3)).toBe(2);
  });
  it("ignores keys of the other axis", () => {
    expect(nextIndex("ArrowLeft", 1, 3)).toBeNull();
    expect(nextIndex("ArrowDown", 1, 3, "horizontal")).toBeNull();
    expect(nextIndex("ArrowRight", 1, 3, "horizontal")).toBe(2);
  });
  it("moves by rows in a grid", () => {
    expect(nextIndex("ArrowDown", 1, 10, "grid", 4)).toBe(5);
    expect(nextIndex("ArrowDown", 8, 10, "grid", 4)).toBe(8);
    expect(nextIndex("ArrowRight", 3, 10, "grid", 4)).toBe(4);
  });
  it("handles an empty list and unknown keys", () => {
    expect(nextIndex("ArrowDown", 0, 0)).toBeNull();
    expect(nextIndex("a", 0, 3)).toBeNull();
  });
});
