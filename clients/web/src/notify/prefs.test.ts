import { describe, expect, it } from "vitest";
import { sanitize } from "./prefs";

describe("notification prefs", () => {
  it("defaults to off and mentions", () => {
    expect(sanitize(undefined)).toEqual({ enabled: false, level: "mentions" });
    expect(sanitize("nonsense")).toEqual({ enabled: false, level: "mentions" });
  });

  it("keeps valid values and drops the rest", () => {
    expect(sanitize({ enabled: true, level: "all" })).toEqual({ enabled: true, level: "all" });
    expect(sanitize({ enabled: "yes", level: "loud" })).toEqual({ enabled: false, level: "mentions" });
  });
});
