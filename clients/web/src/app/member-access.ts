import { Perm, channelPerms, hasPerm, type Channel, type Member, type Role } from "@datrope/core";

/** Whether member `m` can see channel `ch`: the same rule as the server's ViewChannel check, rules gate included. */
export function canView(
  sv: { server: { id: string; owner_id: string; rules_gate?: boolean }; roles: Record<string, Role> },
  m: Pick<Member, "user" | "role_ids" | "accepted_rules_at">,
  ch: Channel,
): boolean {
  const gated = !!sv.server.rules_gate && sv.server.owner_id !== m.user.id && !m.accepted_rules_at;
  return hasPerm(channelPerms(sv.server, Object.values(sv.roles), m.user.id, m.role_ids ?? [], ch, gated), Perm.ViewChannel);
}
