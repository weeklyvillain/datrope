import { describe, expect, it } from "vitest";
import { fitWidth } from "./fit";

describe("fitWidth", () => {
  it("gives one tile the whole space, limited by height", () => {
    expect(fitWidth(1, 1600, 450)).toBe(800); // 450 tall → 800 wide at 16:9
    expect(fitWidth(1, 800, 900)).toBe(800);
  });

  it("picks the column count with the largest tiles", () => {
    // Four in a wide, short box: one row of four beats two rows of two.
    expect(fitWidth(4, 2000, 300)).toBe(491); // (2000 - 3 * 12) / 4
    // Four in a squarish box: two by two.
    expect(fitWidth(4, 1000, 800)).toBe(494); // (1000 - 12) / 2
  });

  it("shrinks tiles as people join", () => {
    const sizes = [1, 2, 3, 5, 9].map((n) => fitWidth(n, 1200, 700));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it("stops shrinking at a minimum width, then the grid scrolls", () => {
    expect(fitWidth(100, 1200, 300)).toBe(160);
    expect(fitWidth(100, 120, 300)).toBe(120); // never wider than the box
  });
});
