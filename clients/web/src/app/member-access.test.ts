import { Perm, type Channel, type Member, type Role } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { canView } from "./member-access";

const SID = "1";
const everyone: Role = { id: SID, name: "@everyone", permissions: Perm.ViewChannel | Perm.ReadHistory | Perm.SendMessages, position: 0 } as Role;
const mods: Role = { id: "2", name: "Mods", permissions: 0, position: 1 } as Role;
const sv = (rules_gate = false) => ({ server: { id: SID, owner_id: "99", rules_gate }, roles: { [SID]: everyone, "2": mods } });
const member = (id: string, role_ids: string[] = [], accepted = true): Member =>
  ({ user: { id, username: id }, role_ids, joined_at: "", accepted_rules_at: accepted ? "2026-01-01T00:00:00Z" : undefined }) as unknown as Member;
const chan = (overrides: Channel["overrides"] = [], type = "text"): Channel => ({ id: "10", type, name: "c", overrides } as unknown as Channel);

describe("canView", () => {
  it("lets everyone see an open channel", () => expect(canView(sv(), member("a"), chan())).toBe(true));
  it("hides a channel that @everyone is denied, except for the allowed role", () => {
    const ch = chan([
      { target_type: "role", target_id: SID, allow: 0, deny: Perm.ViewChannel },
      { target_type: "role", target_id: "2", allow: Perm.ViewChannel, deny: 0 },
    ]);
    expect(canView(sv(), member("a"), ch)).toBe(false);
    expect(canView(sv(), member("b", ["2"]), ch)).toBe(true);
  });
  it("applies member overrides last", () => {
    const ch = chan([
      { target_type: "role", target_id: SID, allow: 0, deny: Perm.ViewChannel },
      { target_type: "member", target_id: "c", allow: Perm.ViewChannel, deny: 0 },
    ]);
    expect(canView(sv(), member("c"), ch)).toBe(true);
  });
  it("always shows the owner", () =>
    expect(canView(sv(), member("99"), chan([{ target_type: "role", target_id: SID, allow: 0, deny: Perm.ViewChannel }]))).toBe(true));
  it("shows gated members only in the welcome channel", () => {
    expect(canView(sv(true), member("g", [], false), chan())).toBe(false);
    expect(canView(sv(true), member("g", [], false), chan([], "welcome"))).toBe(true);
    expect(canView(sv(true), member("99", [], false), chan())).toBe(true); // the owner is never gated
  });
});
