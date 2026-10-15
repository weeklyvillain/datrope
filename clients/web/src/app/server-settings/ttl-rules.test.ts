import { describe, expect, it } from "vitest";
import { rowsError, rowsFromRules, rulesFromRows } from "./ttl-rules";

const MB = 1024 * 1024;

describe("ttl rules editor", () => {
  it("shows rules as MB and days", () =>
    expect(rowsFromRules([{ min_bytes: 500 * MB, ttl_hours: 168 }])).toEqual([{ mb: 500, days: 7 }]));
  it("saves rows as bytes and hours", () =>
    expect(rulesFromRows([{ mb: 500, days: 7 }])).toEqual([{ min_bytes: 500 * MB, ttl_hours: 168 }]));
  it("explains bad rows", () => {
    expect(rowsError([{ mb: 500, days: 7 }])).toBeNull();
    expect(rowsError([{ mb: 0, days: 7 }])).toBe("Sizes start at 1 MB.");
    expect(rowsError([{ mb: 5, days: 0 }])).toBe("Keep files at least 1 day.");
    expect(rowsError([{ mb: 5, days: 400 }])).toBe("Keep files at most 365 days.");
    expect(rowsError([{ mb: 1.5, days: 1 }])).toBe("Use whole numbers.");
    expect(rowsError([{ mb: 5, days: 1.3 }])).toBe("Use whole numbers.");
    expect(rowsError([{ mb: 5, days: 1 }, { mb: 5, days: 2 }])).toBe("Each size can have only one rule.");
    expect(rowsError(Array(6).fill({ mb: 1, days: 1 }).map((r, i) => ({ ...r, mb: i + 1 })))).toBe("At most 5 rules.");
  });
});
