import { describe, expect, it } from "vitest";
import { ALL_PERMS, DM_PERMS, Perm, basePerms, canPost, channelPerms, hasPerm } from "./perms";
import type { Channel, Role } from "./types";

const community = { id: "100", owner_id: "1" };
const everyone: Role = { id: "100", name: "@everyone", position: 0, hoist: false,
  permissions: Perm.ViewChannel | Perm.SendMessages | Perm.ReadHistory };
const mods: Role = { id: "200", name: "Mods", position: 1, hoist: false, permissions: Perm.Kick };
const roles = [everyone, mods];

function channel(overrides: Channel["overrides"]): Channel {
  return { id: "300", type: "text", name: "general", position: 0, topic: "", overrides, tags: [], require_tag: false };
}

describe("perms", () => {
  it("matches the Go flag values", () => {
    expect(Perm.ViewChannel).toBe(1);
    expect(Perm.Admin).toBe(1 << 16);
    expect(ALL_PERMS).toBe((1 << 22) - 1);
    expect(Perm.ManageWebhooks).toBe(1 << 21);
    expect(Perm.ManageServer).toBe(1 << 15);
    expect(Perm.AddReactions).toBe(1 << 17);
    expect(Perm.CreateThreads).toBe(1 << 18);
    expect(Perm.UseSoundboard).toBe(1 << 19);
    expect(Perm.ManageExpressions).toBe(1 << 20);
  });

  it("base is the OR of roles; owner and admin get everything", () => {
    expect(basePerms(community, roles, "2", ["200"])).toBe(everyone.permissions | Perm.Kick);
    expect(basePerms(community, roles, "1", [])).toBe(ALL_PERMS);
    const admin = { ...mods, permissions: Perm.Admin };
    expect(basePerms(community, [everyone, admin], "2", ["200"])).toBe(ALL_PERMS);
  });

  it("applies overrides in order: @everyone, roles, member", () => {
    const deny = channel([{ target_type: "role", target_id: "100", allow: 0, deny: Perm.SendMessages }]);
    expect(hasPerm(channelPerms(community, roles, "2", [], deny), Perm.SendMessages)).toBe(false);

    const roleAllow = channel([
      { target_type: "role", target_id: "100", allow: 0, deny: Perm.SendMessages },
      { target_type: "role", target_id: "200", allow: Perm.SendMessages, deny: 0 },
    ]);
    expect(hasPerm(channelPerms(community, roles, "2", ["200"], roleAllow), Perm.SendMessages)).toBe(true);

    const memberDeny = channel([
      { target_type: "role", target_id: "200", allow: Perm.SendMessages, deny: 0 },
      { target_type: "member", target_id: "2", allow: 0, deny: Perm.SendMessages },
    ]);
    expect(hasPerm(channelPerms(community, roles, "2", ["200"], memberDeny), Perm.SendMessages)).toBe(false);
  });

  it("no view means nothing; DMs are fixed", () => {
    const hidden = channel([{ target_type: "role", target_id: "100", allow: 0, deny: Perm.ViewChannel }]);
    expect(channelPerms(community, roles, "2", [], hidden)).toBe(0);
    expect(DM_PERMS & Perm.ManageMessages).toBe(0);
    expect(hasPerm(DM_PERMS, Perm.AddReactions)).toBe(true);
    expect(hasPerm(DM_PERMS, Perm.UseSoundboard)).toBe(true);
  });

  it("a gated member sees only the welcome channel", () => {
    const welcome: Channel = { id: "301", type: "welcome", name: "welcome", position: -1, topic: "", overrides: [], tags: [], require_tag: false };
    expect(channelPerms(community, roles, "2", [], welcome, true)).toBe(Perm.ViewChannel);
    expect(channelPerms(community, roles, "2", [], channel([]), true)).toBe(0);
    expect(channelPerms(community, roles, "2", [], channel([]))).not.toBe(0);
  });
});

describe("canPost", () => {
  const of = (type: Channel["type"]): Channel => ({ ...channel([]), type });
  const send = Perm.SendMessages;
  const both = Perm.SendMessages | Perm.ManageMessages;
  it("is never true for a forum", () => expect(canPost(of("forum"), ALL_PERMS)).toBe(false));
  it("needs send and manage-messages for an announcement", () => {
    expect(canPost(of("announcement"), send)).toBe(false);
    expect(canPost(of("announcement"), Perm.ManageMessages)).toBe(false);
    expect(canPost(of("announcement"), both)).toBe(true);
  });
  it("needs send for the other types", () => {
    for (const t of ["text", "gallery", "dm"] as const) {
      expect(canPost(of(t), send)).toBe(true);
      expect(canPost(of(t), 0)).toBe(false);
    }
  });
});
