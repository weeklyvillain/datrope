import { Perm, type Role } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { selfAssignBlocker } from "./selfAssign";

const role = { id: "2", name: "Raiders", permissions: 0, position: 1, hoist: false, self_assignable: false, mentionable: false, description: "" } as Role;

describe("selfAssignBlocker", () => {
  it("allows a role without power", () => expect(selfAssignBlocker(role, false, Perm.AttachFiles)).toBeNull());
  it("blocks @everyone, the Guest role and roles with power", () => {
    expect(selfAssignBlocker(role, true, 0)).toMatch(/everyone/);
    expect(selfAssignBlocker({ ...role, is_guest: true }, false, 0)).toMatch(/Guest/);
    expect(selfAssignBlocker(role, false, Perm.Kick)).toMatch(/moderation/);
  });
});
