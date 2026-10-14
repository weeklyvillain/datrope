import { describe, expect, it } from "vitest";
import { NONE, groupOf, moveTo, neighbourMove } from "./order";

describe("sidebar order", () => {
  const groups = { [NONE]: ["a", "b"], c1: ["x", "y"], c2: [] };

  it("finds a channel's group", () => {
    expect(groupOf(groups, "y")).toBe("c1");
    expect(groupOf(groups, "a")).toBe(NONE);
    expect(groupOf(groups, "zz")).toBeUndefined();
  });

  it("moves inside a group", () => {
    expect(moveTo(groups, "a", NONE, 1)).toEqual({ [NONE]: ["b", "a"], c1: ["x", "y"], c2: [] });
  });

  it("moves across groups, clamping the index", () => {
    expect(moveTo(groups, "b", "c1", 0)).toEqual({ [NONE]: ["a"], c1: ["b", "x", "y"], c2: [] });
    expect(moveTo(groups, "x", "c2", 5)).toEqual({ [NONE]: ["a", "b"], c1: ["y"], c2: ["x"] });
    expect(moveTo(groups, "x", NONE, -1)).toEqual({ [NONE]: ["x", "a", "b"], c1: ["y"], c2: [] });
  });

  it("leaves the input alone", () => {
    moveTo(groups, "a", "c2", 0);
    expect(groups).toEqual({ [NONE]: ["a", "b"], c1: ["x", "y"], c2: [] });
  });
});

describe("neighbourMove", () => {
  it("moves up and down within the group", () => {
    expect(neighbourMove(["a", "b", "c"], "b", -1)).toEqual({ position: 0 });
    expect(neighbourMove(["a", "b", "c"], "b", 1)).toEqual({ position: 2 });
  });
  it("is null at the edges or for unknown ids", () => {
    expect(neighbourMove(["a", "b"], "a", -1)).toBeNull();
    expect(neighbourMove(["a", "b"], "b", 1)).toBeNull();
    expect(neighbourMove(["a"], "x", 1)).toBeNull();
  });
});
