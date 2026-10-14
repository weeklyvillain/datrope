import { describe, expect, it } from "vitest";
import { visibleSections } from "./sections-meta";

describe("visibleSections", () => {
  it("guests do not get sessions or connections", () => {
    const ids = visibleSections({ guest: true, admin: false }).map((s) => s.id);
    expect(ids).not.toContain("sessions"); expect(ids).not.toContain("connections");
    expect(ids).toContain("notifications");
  });
  it("members get every section in order", () =>
    expect(visibleSections({ guest: false, admin: false }).map((s) => s.id))
      .toEqual(["profile", "connections", "sessions", "notifications", "voice", "appearance"]));
});
