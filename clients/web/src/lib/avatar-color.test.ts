import { describe, expect, it } from "vitest";
import { avatarColor, avatarColorIndex } from "./avatar-color";

describe("avatar colour", () => {
  it("is stable and one of the eight tokens", () => {
    expect(avatarColor("1234567890")).toBe(avatarColor("1234567890"));
    expect(avatarColor("42")).toMatch(/^var\(--avatar-[1-8]\)$/);
  });

  it("spreads snowflake-like IDs over the palette", () => {
    // Snowflakes made in different milliseconds often end in the same bits.
    const ids = Array.from({ length: 64 }, (_, i) => String((BigInt(i + 1) << 22n) + 1767225600000n));
    expect(new Set(ids.map(avatarColorIndex)).size).toBeGreaterThanOrEqual(6);
  });
});
