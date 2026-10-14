import { describe, expect, it } from "vitest";
import { justify, ratio } from "./justify";

const sq = { width: 100, height: 100 };

describe("ratio", () => {
  it("is 1:1 without dimensions and clamped to 0.5–3", () => {
    expect(ratio({})).toBe(1);
    expect(ratio({ width: 0, height: 0 })).toBe(1);
    expect(ratio({ width: 1000, height: 10 })).toBe(3);
    expect(ratio({ width: 10, height: 1000 })).toBe(0.5);
  });
});

describe("justify", () => {
  it("is empty for no boxes or no width", () => {
    expect(justify([], 400)).toEqual([]);
    expect(justify([sq], 0)).toEqual([]);
  });

  it("closes a row once it would be no taller than the target, filling the width exactly", () => {
    const rows = justify([sq, sq, sq, sq], 400, 180, 4);
    expect(rows[0].start).toBe(0);
    expect(rows[0].end).toBe(3);
    expect(rows[0].height).toBeCloseTo((400 - 8) / 3);
    const widths = [0, 1, 2].map(() => rows[0].height * 1);
    expect(widths.reduce((a, b) => a + b, 0) + 8).toBeCloseTo(400);
  });

  it("leaves the last row at the target height", () => {
    const rows = justify([sq, sq, sq, sq], 400, 180, 4);
    expect(rows[1]).toEqual({ start: 3, end: 4, height: 180 });
  });

  it("treats a file without dimensions as square", () => {
    expect(justify([{}, {}, {}], 400, 180, 4)[0].end).toBe(3);
  });
});
