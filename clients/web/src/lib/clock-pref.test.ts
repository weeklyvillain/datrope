import { describe, expect, it } from "vitest";
import { getClockPref, setClockPref } from "./clock-pref";
import { clockTime, fullStamp } from "./message-time";

describe("clock preference", () => {
  const d = new Date(Date.UTC(2026, 0, 1, 21, 5));
  it("defaults to auto, which follows the locale", () => {
    expect(getClockPref()).toBe("auto");
    expect(clockTime(d, "en-US", "auto")).toMatch(/PM/);
    expect(clockTime(d, "sv-SE", "auto")).not.toMatch(/PM/);
  });
  it("forces a 12- or 24-hour clock", () => {
    expect(clockTime(d, "sv-SE", "12")).toMatch(/PM|em/i);
    expect(clockTime(d, "en-US", "24")).not.toMatch(/PM/);
  });
  it("applies the clock to the full stamp", () => {
    expect(fullStamp(d, "en-US", "24")).not.toMatch(/AM|PM/);
    expect(fullStamp(d, "sv-SE", "12")).toMatch(/PM|em/i);
  });
  it("remembers the choice for this session even without storage", () => {
    setClockPref("24");
    expect(getClockPref()).toBe("24");
    setClockPref("auto");
  });
});
