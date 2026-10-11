import { describe, expect, it } from "vitest";
import { mentionsMe } from "./mentions";

describe("mentionsMe", () => {
  it("is true for a direct mention, @everyone, or a role I hold", () => {
    expect(mentionsMe({ mentions: ["1"] }, "1", [])).toBe(true);
    expect(mentionsMe({ mention_everyone: true }, "1", [])).toBe(true);
    expect(mentionsMe({ mention_roles: ["9"] }, "1", ["8", "9"])).toBe(true);
  });
  it("is false otherwise", () => {
    expect(mentionsMe({ mentions: ["2"], mention_roles: ["9"] }, "1", ["8"])).toBe(false);
    expect(mentionsMe({ mentions: null, mention_roles: null }, "1", ["8"])).toBe(false);
  });
});
