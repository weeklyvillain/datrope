import { describe, expect, it } from "vitest";
import { dayShift, findTimes, resolveTime, zoneOffsetMinutes } from "./time-mention";

const hm = (s: string) => findTimes(s).map((t) => [s.slice(t.index, t.index + t.length), t.hour, t.minute, t.zone]);

describe("findTimes", () => {
  it("finds 12-hour times", () => {
    expect(hm("gaming @ 9pm")).toEqual([["9pm", 21, 0, undefined]]);
    expect(hm("at 9 PM?")).toEqual([["9 PM", 21, 0, undefined]]);
    expect(hm("9:30pm or 9.30 am")).toEqual([["9:30pm", 21, 30, undefined], ["9.30 am", 9, 30, undefined]]);
    expect(hm("12am and 12pm")).toEqual([["12am", 0, 0, undefined], ["12pm", 12, 0, undefined]]);
    expect(hm("7 p.m.")).toEqual([["7 p.m.", 19, 0, undefined]]);
  });
  it("finds 24-hour times with a colon", () => {
    expect(hm("kl 21:00")).toEqual([["21:00", 21, 0, undefined]]);
    expect(hm("from 9:05 to 23:59")).toEqual([["9:05", 9, 5, undefined], ["23:59", 23, 59, undefined]]);
  });
  it("reads a zone written after the time", () => {
    expect(hm("9pm CET")).toEqual([["9pm CET", 21, 0, "CET"]]);
    expect(hm("21:00 UTC+2")).toEqual([["21:00 UTC+2", 21, 0, "UTC+2"]]);
    expect(hm("10:30 GMT-5:30")).toEqual([["10:30 GMT-5:30", 10, 30, "GMT-5:30"]]);
  });
  it("matches zones in uppercase only", () => {
    expect(findTimes("meet at 9am west gate")[0]!.zone).toBeUndefined();
    expect(findTimes("9pm cet")[0]!.zone).toBeUndefined();
    expect(findTimes("9 PM CET")[0]!.zone).toBe("CET");
  });
  it("ignores things that are not times", () => {
    for (const s of ["at 9", "costs 12.50", "won 3:2", "10:30:15", "24:00", "9:60", "13pm", "0pm", "v1.2.3", "a9pm", "ratio 16:9"])
      expect(findTimes(s), s).toEqual([]);
  });
});

describe("zoneOffsetMinutes", () => {
  const winter = Date.UTC(2026, 0, 15, 12);
  const summer = Date.UTC(2026, 6, 15, 12);
  it("knows IANA zones with DST", () => {
    expect(zoneOffsetMinutes("Europe/Stockholm", winter)).toBe(60);
    expect(zoneOffsetMinutes("Europe/Stockholm", summer)).toBe(120);
    expect(zoneOffsetMinutes("America/New_York", winter)).toBe(-300);
  });
  it("knows abbreviations and fixed offsets", () => {
    expect(zoneOffsetMinutes("CET", summer)).toBe(60); // an abbreviation is fixed, whatever the season
    expect(zoneOffsetMinutes("PDT", winter)).toBe(-420);
    expect(zoneOffsetMinutes("UTC+5:30", winter)).toBe(330);
    expect(zoneOffsetMinutes("GMT", winter)).toBe(0);
  });
  it("range-checks fixed offsets", () => {
    expect(zoneOffsetMinutes("UTC+15", winter)).toBeNull();
    expect(zoneOffsetMinutes("UTC+99", winter)).toBeNull();
    expect(zoneOffsetMinutes("UTC+14", winter)).toBe(840);
    expect(zoneOffsetMinutes("UTC-12", winter)).toBe(-720);
    expect(zoneOffsetMinutes("UTC+5:75", winter)).toBeNull();
  });
  it("returns null for unknown zones", () => expect(zoneOffsetMinutes("Mars/Base", winter)).toBeNull());
});

describe("resolveTime", () => {
  const t = (s: string) => findTimes(s)[0]!;
  it("uses the sender's zone and their calendar date", () => {
    // Sent 2026-03-10 18:00 UTC = 19:00 in Stockholm; "9pm" is 21:00 Stockholm = 20:00 UTC that day.
    expect(resolveTime(t("9pm"), "2026-03-10T18:00:00Z", "Europe/Stockholm")?.toISOString()).toBe("2026-03-10T20:00:00.000Z");
  });
  it("uses the sender's date even when UTC is already the next day", () => {
    // 23:30 in Los Angeles on 10 March is 06:30 UTC on 11 March; "9pm" is 9pm on the 10th in LA (PDT, -7).
    expect(resolveTime(t("9pm"), "2026-03-11T06:30:00Z", "America/Los_Angeles")?.toISOString()).toBe("2026-03-11T04:00:00.000Z");
  });
  it("applies DST for that date", () => {
    expect(resolveTime(t("12:00"), "2026-07-01T08:00:00Z", "Europe/Stockholm")?.toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(resolveTime(t("12:00"), "2026-01-01T08:00:00Z", "Europe/Stockholm")?.toISOString()).toBe("2026-01-01T11:00:00.000Z");
  });
  it("prefers a written zone over the sender's", () =>
    expect(resolveTime(t("9pm EST"), "2026-03-10T18:00:00Z", "Europe/Stockholm")?.toISOString()).toBe("2026-03-11T02:00:00.000Z"));
  it("gives up on an invalid date", () => expect(resolveTime(t("9pm"), "garbage", "Europe/Stockholm")).toBeNull());
  it("gives up on an out-of-range offset", () => expect(resolveTime(t("9pm UTC+15"), "2026-03-10T18:00:00Z", "Europe/Stockholm")).toBeNull());
  it("gives up without any zone", () => expect(resolveTime(t("9pm"), "2026-03-10T18:00:00Z", undefined)).toBeNull());
});

describe("dayShift", () => {
  it("is 0 when both see the same date", () => expect(dayShift("2026-03-10T20:00:00Z", "Europe/Stockholm", "America/Los_Angeles")).toBe(0)); // 21:00 vs 13:00
  it("is +1 when it is already tomorrow for the reader", () => expect(dayShift("2026-03-11T04:00:00Z", "America/Los_Angeles", "Europe/Stockholm")).toBe(1)); // 21:00 LA = 05:00 Stockholm
  it("is -1 when it is still yesterday for the reader", () => expect(dayShift("2026-03-11T00:00:00Z", "Europe/Stockholm", "America/Los_Angeles")).toBe(-1)); // 01:00 vs 17:00
  it("is 0 for an invalid date", () => expect(dayShift("garbage", "PDT", "UTC+1")).toBe(0));
  it("works with abbreviations and offsets", () => expect(dayShift("2026-03-11T04:00:00Z", "PDT", "UTC+1")).toBe(1));
});
