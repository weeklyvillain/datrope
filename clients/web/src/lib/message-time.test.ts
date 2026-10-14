import { describe, expect, it } from "vitest";
import { clockTime, fullStamp, headStamp } from "./message-time";

const now = new Date(2026, 9, 14, 12, 0); // 14 Oct 2026, local time
describe("headStamp", () => {
  it("says Today and Yesterday with the time", () => {
    expect(headStamp(new Date(2026, 9, 14, 8, 33), now, "en-GB")).toBe("Today 08:33");
    expect(headStamp(new Date(2026, 9, 13, 21, 10), now, "en-GB")).toBe("Yesterday 21:10");
  });
  it("gives the date for older days", () => {
    expect(headStamp(new Date(2026, 9, 9, 8, 33), now, "en-GB")).toBe("9 Oct 2026 08:33");
  });
  it("handles midnight on both sides", () => {
    expect(headStamp(new Date(2026, 9, 14, 0, 0), now, "en-GB")).toBe("Today 00:00");
    expect(headStamp(new Date(2026, 9, 13, 23, 59), now, "en-GB")).toBe("Yesterday 23:59");
  });
  it("follows the locale's clock", () => {
    expect(headStamp(new Date(2026, 9, 14, 20, 5), now, "en-US")).toMatch(/^Today 8:05\s?PM$/);
  });
});
describe("clockTime and fullStamp", () => {
  it("formats", () => {
    expect(clockTime(new Date(2026, 9, 14, 8, 4), "en-GB")).toBe("08:04");
    expect(fullStamp(new Date(2026, 9, 14, 8, 4), "en-GB")).toMatch(/14 October 2026/);
  });
});
