import { describe, expect, it } from "vitest";
import { sanitize } from "./prefs";

describe("theme pref", () => {
  it("keeps a known theme", () => {
    expect(sanitize("gotham")).toBe("gotham");
  });

  it("falls back to the default for anything else", () => {
    expect(sanitize(undefined)).toBe("datrope");
    expect(sanitize("nope")).toBe("datrope");
    expect(sanitize("toString")).toBe("datrope");
    expect(sanitize(3)).toBe("datrope");
  });
});
