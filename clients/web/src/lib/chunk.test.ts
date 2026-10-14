import { describe, expect, it } from "vitest";
import { chunk } from "./chunk";
describe("chunk", () => {
  it("splits into rows", () => expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]));
  it("treats size < 1 as 1", () => expect(chunk([1, 2], 0)).toEqual([[1], [2]]));
  it("handles empty input", () => expect(chunk([], 3)).toEqual([]));
});
