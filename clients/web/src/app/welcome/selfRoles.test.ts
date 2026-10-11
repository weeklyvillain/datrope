import type { Role } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { pickableRoles } from "./selfRoles";

const role = (id: string, self_assignable: boolean, position: number) =>
  ({ id, name: id, permissions: 0, position, hoist: false, self_assignable, mentionable: false, description: "" }) as Role;

describe("pickableRoles", () => {
  it("lists self-assignable roles, senior first", () => {
    expect(pickableRoles({ a: role("a", true, 1), b: role("b", false, 2), c: role("c", true, 3) }).map((r) => r.id)).toEqual(["c", "a"]);
  });
});
