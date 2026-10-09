import { describe, expect, it } from "vitest";
import { PERM_GROUPS, PERM_LABELS } from "./permLabels";

describe("PERM_GROUPS", () => {
  it("puts every permission in exactly one group, with a description", () => {
    expect(PERM_GROUPS.map((g) => g.title)).toEqual(["General", "Text", "Voice", "Moderation", "Server"]);
    const grouped = PERM_GROUPS.flatMap((g) => g.flags);
    expect([...grouped].sort((a, b) => a - b)).toEqual(PERM_LABELS.map((p) => p.flag).sort((a, b) => a - b));
    for (const p of PERM_LABELS) expect(p.description).toMatch(/\S/);
  });
});
