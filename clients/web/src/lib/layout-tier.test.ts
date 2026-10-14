import { describe, expect, it } from "vitest";
import { tierFor } from "./layout-tier";

describe("tierFor", () => {
  it("maps widths to tiers at 768, 1024 and 1280", () => {
    expect(tierFor(375)).toBe("phone");
    expect(tierFor(767)).toBe("phone");
    expect(tierFor(768)).toBe("narrow");
    expect(tierFor(1023)).toBe("narrow");
    expect(tierFor(1024)).toBe("medium");
    expect(tierFor(1279)).toBe("medium");
    expect(tierFor(1280)).toBe("wide");
    expect(tierFor(2560)).toBe("wide");
  });
});
