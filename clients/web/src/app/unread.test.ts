import { describe, expect, it } from "vitest";
import { firstUnreadIndex } from "./unread";

const m = (id: string, author = "2", pending = false) => ({ id, author: { id: author }, pending });

describe("firstUnreadIndex", () => {
  it.each([
    [[m("10"), m("11"), m("12")], "10", "1", 1],
    [[m("10"), m("11", "1"), m("12")], "10", "1", 2], // my own message is not "new"
    [[m("10"), m("11")], "11", "1", -1],
    [[m("10"), m("11")], undefined, "1", 0],
    [[m("9"), m("100")], "99", "1", 1], // numeric order, not string order
    [[m("10"), m("11", "2", true)], "10", "1", -1], // pending is ignored
  ])("case %#", (items, lastRead, me, want) => {
    expect(firstUnreadIndex(items, lastRead as string | undefined, me)).toBe(want);
  });
});
