import type { Channel, Role } from "./types";

/** Mirrors server/internal/perms. Bit values must stay identical. */
export const Perm = {
  ViewChannel: 1 << 0,
  SendMessages: 1 << 1,
  AttachFiles: 1 << 2,
  ReadHistory: 1 << 3,
  ConnectVoice: 1 << 4,
  Speak: 1 << 5,
  Stream: 1 << 6,
  ManageMessages: 1 << 7,
  MuteMembers: 1 << 8,
  MoveMembers: 1 << 9,
  Kick: 1 << 10,
  Ban: 1 << 11,
  CreateInvite: 1 << 12,
  ManageRoles: 1 << 13,
  ManageChannels: 1 << 14,
  ManageServer: 1 << 15,
  Admin: 1 << 16,
  AddReactions: 1 << 17,
  CreateThreads: 1 << 18,
  UseSoundboard: 1 << 19,
  ManageExpressions: 1 << 20,
  ManageWebhooks: 1 << 21,
  MentionEveryone: 1 << 22,
} as const;

// JavaScript bitwise operators work on 32 bits; revisit if flags pass bit 30.
export const ALL_PERMS = (1 << 23) - 1;
/** What a webhook channel takes from everyone, the owner included: only webhooks post there (perms.WebhookMasked). */
export const WEBHOOK_MASKED = Perm.SendMessages | Perm.AttachFiles;
export const DM_PERMS = Perm.ViewChannel | Perm.SendMessages | Perm.AttachFiles | Perm.ReadHistory |
  Perm.ConnectVoice | Perm.Speak | Perm.Stream | Perm.AddReactions | Perm.UseSoundboard;
const OVERRIDABLE = ALL_PERMS & ~Perm.Admin;

export const hasPerm = (p: number, q: number) => (p & q) === q;

/** Whether the composer may post straight into the channel. Forums take posts, not messages; announcements need MANAGE_MESSAGES. */
export function canPost(ch: Channel, perms: number): boolean {
  if (ch.type === "forum") return false;
  if (ch.type === "announcement") return hasPerm(perms, Perm.SendMessages) && hasPerm(perms, Perm.ManageMessages);
  return hasPerm(perms, Perm.SendMessages);
}

interface ServerRef {
  id: string;
  owner_id: string;
}

/** Server-level permissions. roleIds excludes @everyone. */
export function basePerms(c: ServerRef, roles: Role[], userId: string, roleIds: string[]): number {
  if (userId === c.owner_id) return ALL_PERMS;
  let p = 0;
  for (const r of roles) if (r.id === c.id || roleIds.includes(r.id)) p |= r.permissions;
  return hasPerm(p, Perm.Admin) ? ALL_PERMS : p;
}

/** Permissions in a channel, following the server's Effective(). */
export function channelPerms(c: ServerRef, roles: Role[], userId: string, roleIds: string[], ch: Channel, gated = false): number {
  if (ch.type === "dm") return DM_PERMS;
  if (gated) return ch.type === "welcome" ? Perm.ViewChannel : 0;
  let p = basePerms(c, roles, userId, roleIds);
  if (hasPerm(p, Perm.Admin)) return ALL_PERMS;
  const apply = (allow: number, deny: number) => {
    p = (p & ~(deny & OVERRIDABLE)) | (allow & OVERRIDABLE);
  };
  const overrides = ch.overrides ?? [];
  const everyone = overrides.find((o) => o.target_type === "role" && o.target_id === c.id);
  if (everyone) apply(everyone.allow, everyone.deny);
  let allow = 0;
  let deny = 0;
  for (const o of overrides) {
    if (o.target_type === "role" && o.target_id !== c.id && roleIds.includes(o.target_id)) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  apply(allow, deny);
  const mine = overrides.find((o) => o.target_type === "member" && o.target_id === userId);
  if (mine) apply(mine.allow, mine.deny);
  return hasPerm(p, Perm.ViewChannel) ? p : 0;
}
