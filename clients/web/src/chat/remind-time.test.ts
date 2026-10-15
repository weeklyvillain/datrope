import { describe, expect, it } from "vitest";
import { dayLabels, defaultPick, menuTime, parseWhen, pickFor, pickToDate, presets, relative, whenLabel } from "./remind-time";

// Wednesday 14 Oct 2026, 14:02 local time.
const now = new Date(2026, 9, 14, 14, 2, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0);

describe("parseWhen", () => {
  it.each([
    ["20m stretch", new Date(now.getTime() + 20 * 60_000), "stretch"],
    ["2h call mom", new Date(now.getTime() + 2 * 3_600_000), "call mom"],
    ["1h30m tea", new Date(now.getTime() + 90 * 60_000), "tea"],
    ["1d x", new Date(now.getTime() + 86_400_000), "x"],
    ["14:30 standup", at(14, 14, 30), "standup"],
    ["9:05 coffee", at(15, 9, 5), "coffee"], // passed today → tomorrow
    ["14:02 now-ish", at(15, 14, 2), "now-ish"], // exactly now counts as passed
    ["tomorrow dentist", at(15, 9), "dentist"],
    ["tomorrow 9 dentist", at(15, 9), "dentist"],
    ["tomorrow 14:30 dentist", at(15, 14, 30), "dentist"],
    ["fri 13:00 release", at(16, 13), "release"],
    ["friday release", at(16, 9), "release"],
    ["wed sync", at(21, 9), "sync"], // today is Wednesday → next week
    ["mon 8 gym", at(19, 8), "gym"],
  ])("%j", (text, due, rest) => {
    expect(parseWhen(text, now)).toEqual({ due, rest });
  });

  it("keeps a missing text empty", () => expect(parseWhen("20m", now)?.rest).toBe(""));
  it.each(["", "soon do it", "0m x", "25:00 x", "9 x", "14:61 x", "tomorrow 24 x", "funday x", "99999999d x", "367d x"])("rejects %j", (text) => {
    expect(parseWhen(text, now)).toBeNull();
  });
});

describe("presets", () => {
  it("resolves each preset", () => {
    expect(presets(now).map((p) => [p.label, p.due])).toEqual([
      ["In 20 minutes", new Date(now.getTime() + 20 * 60_000)],
      ["In 1 hour", new Date(now.getTime() + 3_600_000)],
      ["In 3 hours", new Date(now.getTime() + 3 * 3_600_000)],
      ["Tomorrow", at(15, 9)],
      ["Next week", at(19, 9)], // the next Monday
    ]);
  });
  it("next week from a Monday is a week out", () =>
    expect(presets(new Date(2026, 9, 19, 8, 0)).at(-1)!.due).toEqual(at(26, 9)));
});

describe("labels", () => {
  it("whenLabel", () => {
    expect(whenLabel(at(14, 15, 4), now, "en-GB")).toBe("Today 15:04");
    expect(whenLabel(at(15, 9), now, "en-GB")).toBe("Tomorrow 09:00");
    expect(whenLabel(at(16, 13), now, "en-GB")).toBe("Fri 13:00");
    expect(whenLabel(at(30, 13, 30), now, "en-GB")).toBe("30 Oct 13:30");
    expect(whenLabel(new Date(2027, 0, 3, 9), now, "en-GB")).toBe("3 Jan 2027 09:00");
  });
  it("menuTime drops Today", () => expect(menuTime(at(14, 14, 22), now, "en-GB")).toBe("14:22"));
  it("relative", () => {
    expect(relative(new Date(now.getTime() + 5 * 60_000), now)).toBe("in 5 min");
    expect(relative(new Date(now.getTime() + (18 * 60 + 58) * 60_000), now)).toBe("in 18 h 58 min");
    expect(relative(new Date(now.getTime() + (51 * 60) * 60_000), now)).toBe("in 2 d 3 h");
    expect(relative(now, now)).toBeNull();
  });
});

describe("wheel picks", () => {
  it("defaults to the next quarter hour plus an hour", () =>
    expect(defaultPick(now)).toEqual({ day: 0, hour: 15, minute: 15 }));
  it("rolls over midnight", () =>
    expect(defaultPick(new Date(2026, 9, 14, 23, 50))).toEqual({ day: 1, hour: 1, minute: 0 }));
  it("round-trips", () => {
    expect(pickToDate(now, { day: 1, hour: 9, minute: 0 })).toEqual(at(15, 9));
    expect(pickFor(now, new Date(now.getTime() + 20 * 60_000))).toEqual({ day: 0, hour: 14, minute: 25 });
    expect(pickFor(now, at(30, 9))).toEqual({ day: 13, hour: 9, minute: 0 }); // clamped to the last day
  });
  it("labels days", () => {
    const d = dayLabels(now, "en-GB");
    expect(d).toHaveLength(14);
    expect(d.slice(0, 3)).toEqual(["Today", "Tomorrow", "Fri 16 Oct"]);
  });
});
