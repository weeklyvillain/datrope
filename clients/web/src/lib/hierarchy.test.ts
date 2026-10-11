import { describe, expect, it } from "vitest";
import { canEditRole, canManageRole, myRank, outranks } from "./hierarchy";

const server = { id: "1", owner_id: "10" };
const roles = [
  { id: "1", name: "@everyone", position: 0, permissions: 0, hoist: false, self_assignable: false, mentionable: false, description: "" },
  { id: "2", name: "Helper", position: 1, permissions: 0, hoist: false, self_assignable: false, mentionable: false, description: "" },
  { id: "3", name: "Mod", position: 2, permissions: 0, hoist: false, self_assignable: false, mentionable: false, description: "" },
];

describe("hierarchy", () => {
  it("ranks by highest role, owner on top", () => {
    expect(myRank(server, roles, "10", [])).toBe(Infinity);
    expect(myRank(server, roles, "20", ["2", "3"])).toBe(2);
    expect(myRank(server, roles, "30", [])).toBe(0);
  });

  it("ignores self-assignable roles", () => {
    const pick = { ...roles[2], id: "4", position: 3, self_assignable: true };
    expect(myRank(server, [...roles, pick], "20", ["2", "4"])).toBe(1);
  });

  it("edits only roles below", () => {
    expect(canEditRole(2, roles[1])).toBe(true);
    expect(canEditRole(2, roles[2])).toBe(false);
    expect(canEditRole(Infinity, roles[2])).toBe(true);
  });

  it("moderates only lower ranks", () => {
    expect(outranks(2, 1)).toBe(true);
    expect(outranks(1, 1)).toBe(false);
    expect(outranks(Infinity, 5)).toBe(true);
  });
});

describe("canManageRole", () => {
  it("needs the rank and every permission the role grants", () => {
    const kick = { ...roles[1], permissions: 1024 };
    expect(canManageRole(2, 1024 | 1, kick)).toBe(true);
    expect(canManageRole(2, 1, kick)).toBe(false);
    expect(canManageRole(1, 1024, kick)).toBe(false);
  });
});
