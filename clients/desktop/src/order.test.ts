import { describe, expect, it } from "vitest";
import { mentionLabel, moveId, otherServersBadge, serverInitials } from "./order";

describe("moveId", () => {
  it("moves an id to where another one was", () => {
    expect(moveId(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveId(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });
  it("leaves the order alone for unknown or identical ids", () => {
    expect(moveId(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(moveId(["a", "b"], "x", "a")).toEqual(["a", "b"]);
  });
});

describe("serverInitials", () => {
  it("uses up to two initials, falling back to the host", () => {
    expect(serverInitials("Friends of Datrope")).toBe("FO");
    expect(serverInitials("chat.example.com")).toBe("C");
    expect(serverInitials("  ")).toBe("?");
  });
});

describe("otherServersBadge", () => {
  const s = (id: string, unread: boolean, mentions: number) => ({ id, unread, mentions });
  it("sums mentions and unread of every server but the selected one", () => {
    const servers = [s("a", true, 5), s("b", true, 2), s("c", false, 0), s("d", true, 1)];
    expect(otherServersBadge(servers, "a")).toEqual({ unread: true, mentions: 3 });
  });
  it("is quiet when only the selected server has news", () => {
    expect(otherServersBadge([s("a", true, 4), s("b", false, 0)], "a")).toEqual({ unread: false, mentions: 0 });
    expect(otherServersBadge([s("a", true, 4)], "a")).toEqual({ unread: false, mentions: 0 });
  });
  it("counts every server when none is selected", () => {
    expect(otherServersBadge([s("a", false, 2), s("b", false, 0)], null)).toEqual({ unread: true, mentions: 2 });
  });
});

describe("mentionLabel", () => {
  it("caps at 99+", () => {
    expect(mentionLabel(3)).toBe("3");
    expect(mentionLabel(120)).toBe("99+");
  });
});
