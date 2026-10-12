import type { AuditChange, AuditEntry, PublicUser } from "@datrope/core";
import { PERM_LABELS } from "@/permLabels";

/** A piece of an audit log sentence; `strong` marks a name. */
export type Part = string | { strong: string };

const s = (strong: string): Part => ({ strong });

/** What an entry says happened, without the actor: "banned Bob". */
export function describe(e: AuditEntry, users: Record<string, PublicUser>): Part[] {
  const d = e.details;
  const user = e.target_id && users[e.target_id];
  const target = s(user ? user.display_name || user.username : "an unknown user");
  const name = d.name ?? "";
  const ch = d.channel ? s(`#${d.channel.name}`) : undefined;
  const inCh = ch ? [" in ", ch] : [];
  const overrideFor = d.role ? s(`@${d.role.name}`) : target;
  switch (e.action) {
    case "member.kick": return ["kicked ", target];
    case "member.ban": return ["banned ", target];
    case "member.unban": return ["unbanned ", target];
    case "member.role_add": return ["gave ", target, " the role ", s(d.role?.name ?? "")];
    case "member.role_remove": return ["took the role ", s(d.role?.name ?? ""), " from ", target];
    case "voice.move": return ["moved ", target, " from ", s(d.from?.name ?? ""), " to ", s(d.to?.name ?? "")];
    case "voice.disconnect": return ["disconnected ", target, " from ", s(d.channel?.name ?? "")];
    case "voice.mute": return ["server muted ", target, " in ", s(d.channel?.name ?? "")];
    case "voice.unmute": return ["server unmuted ", target, " in ", s(d.channel?.name ?? "")];
    case "channel.create": return ["created the channel ", s(`#${name}`)];
    case "channel.update": {
      const moved = d.changes?.length === 1 && d.changes[0].field === "category" ? d.changes[0] : undefined;
      if (moved) return moved.new ? ["moved ", s(`#${name}`), " to ", s(moved.new)] : ["moved ", s(`#${name}`), " out of ", s(moved.old)];
      return ["updated the channel ", s(`#${name}`)];
    }
    case "channel.delete": return ["deleted the channel ", s(`#${name}`)];
    case "channel.override_update": return ["changed permissions for ", overrideFor, ...inCh];
    case "channel.override_delete": return ["removed the permission override for ", overrideFor, ...inCh];
    case "category.create": return ["created the category ", s(name)];
    case "category.update": return ["updated the category ", s(name)];
    case "category.delete": return ["deleted the category ", s(name)];
    case "alert.create": return ["added the alert ", s(name), ...inCh];
    case "alert.delete": return ["removed the alert ", s(name), ...inCh];
    case "webhook.create": return ["created the webhook ", s(name), ...inCh];
    case "webhook.update": return ["updated the webhook ", s(name), ...inCh];
    case "webhook.delete": return ["deleted the webhook ", s(name), ...inCh];
    case "message.delete": return name ? ["deleted the post ", s(name), " by ", target, ...inCh] : ["deleted a message by ", target, ...inCh];
    case "message.pin": return user ? ["pinned a message by ", target, ...inCh] : ["pinned a message", ...inCh];
    case "message.unpin": return user ? ["unpinned a message by ", target, ...inCh] : ["unpinned a message", ...inCh];
    case "role.create": return ["created the role ", s(name)];
    case "role.update": return ["updated the role ", s(name)];
    case "role.delete": return ["deleted the role ", s(name)];
    case "server.update": return ["updated the server"];
    case "welcome.update": return ["updated the welcome page"];
    case "invite.create": return ["created the invite ", s(name)];
    case "invite.delete": return ["deleted the invite ", s(name)];
    case "emoji.create": return ["added the emoji ", s(`:${name}:`)];
    case "emoji.update": return ["updated the emoji ", s(`:${name}:`)];
    case "emoji.delete": return ["deleted the emoji ", s(`:${name}:`)];
    case "sound.create": return ["added the sound ", s(name)];
    case "sound.update": return ["updated the sound ", s(name)];
    case "sound.delete": return ["deleted the sound ", s(name)];
  }
  return [e.action];
}

const FIELDS: Record<string, string> = {
  require_tag: "Require a tag",
  self_assignable: "Self-assignable",
  rules_gate: "Rules gate",
  welcome_page: "Page",
  allow: "Allowed",
  deny: "Denied",
};

const label = (field: string) => FIELDS[field] ?? field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " ");

function flagNames(mask: number): string[] {
  return PERM_LABELS.filter((p) => (mask & p.flag) === p.flag).map((p) => p.label);
}

/** One changed field as a line: "Name: old → new". Masks list the flags added and removed. */
export function changeText(c: AuditChange): string {
  if (c.field === "permissions" || c.field === "allow" || c.field === "deny") {
    const before = Number(c.old), after = Number(c.new);
    const added = flagNames(after & ~before).map((n) => `+${n}`);
    const removed = flagNames(before & ~after).map((n) => `−${n}`);
    return `${label(c.field)}: ${[...added, ...removed].join(", ") || "no change"}`;
  }
  if (!c.old && !c.new) return `${label(c.field)} changed`;
  const show = (v: string) => (v === "true" ? "on" : v === "false" ? "off" : v === "" ? "none" : v);
  return `${label(c.field)}: ${show(c.old)} → ${show(c.new)}`;
}

/** The detail lines under an entry: a ban reason, then the changes. A plain category move has none. */
export function detailLines(e: AuditEntry): string[] {
  const lines = e.details.reason ? [`Reason: ${e.details.reason}`] : [];
  const cs = e.details.changes ?? [];
  if (e.action === "channel.update" && cs.length === 1 && cs[0].field === "category") return lines;
  return [...lines, ...cs.map(changeText)];
}
