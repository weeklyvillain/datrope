import { Perm, type AuditEntry, type PublicUser } from "@datrope/core";
import { describe as group, expect, it } from "vitest";
import { changeText, describe, detailLines, type Part } from "./audit";

const bob: PublicUser = { id: "2", username: "bob", display_name: "Bob", custom_status: "" };
const users = { "2": bob };
const entry = (e: Partial<AuditEntry>): AuditEntry =>
  ({ id: "9", action: "member.kick", actor_id: "1", created_at: "2026-10-12T10:00:00Z", details: {}, ...e }) as AuditEntry;
const text = (ps: Part[]) => ps.map((p) => (typeof p === "string" ? p : `[${p.strong}]`)).join("");

group("audit log text", () => {
  it("names the target and the channels of a voice move", () => {
    const e = entry({ action: "voice.move", target_id: "2", details: { from: { id: "5", name: "Lounge" }, to: { id: "6", name: "Games" } } });
    expect(text(describe(e, users))).toBe("moved [Bob] from [Lounge] to [Games]");
  });

  it("shows a ban with its reason, and a user missing from the page as unknown", () => {
    const e = entry({ action: "member.ban", target_id: "2", details: { reason: "spam" } });
    expect(text(describe(e, users))).toBe("banned [Bob]");
    expect(detailLines(e)).toEqual(["Reason: spam"]);
    expect(text(describe(entry({ action: "member.unban", target_id: "3" }), users))).toBe("unbanned [an unknown user]");
  });

  it("reads a category change alone as a move", () => {
    const into = entry({ action: "channel.update", details: { name: "minecraft", changes: [{ field: "category", old: "", new: "Games" }] } });
    expect(text(describe(into, users))).toBe("moved [#minecraft] to [Games]");
    expect(detailLines(into)).toEqual([]);
    const out = entry({ action: "channel.update", details: { name: "minecraft", changes: [{ field: "category", old: "Games", new: "" }] } });
    expect(text(describe(out, users))).toBe("moved [#minecraft] out of [Games]");
    const both = entry({ action: "channel.update", details: { name: "mc", changes: [{ field: "name", old: "minecraft", new: "mc" }, { field: "category", old: "", new: "Games" }] } });
    expect(text(describe(both, users))).toBe("updated the channel [#mc]");
    expect(detailLines(both)).toEqual(["Name: minecraft → mc", "Category: none → Games"]);
  });

  it("names permission flags added and removed", () => {
    expect(changeText({ field: "permissions", old: String(Perm.Kick), new: String(Perm.Ban) })).toBe("Permissions: +Ban members, −Kick members");
    expect(changeText({ field: "hoist", old: "false", new: "true" })).toBe("Hoist: off → on");
    expect(changeText({ field: "icon", old: "", new: "" })).toBe("Icon changed");
  });

  it("names a role override by the role", () => {
    const e = entry({ action: "channel.override_update", details: { role: { id: "7", name: "Mods" }, channel: { id: "8", name: "general" } } });
    expect(text(describe(e, users))).toBe("changed permissions for [@Mods] in [#general]");
  });
});
