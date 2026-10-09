import { Perm, hasPerm, type Role } from "@datrope/core";
import { useMemo } from "react";
import { canManageRole, myRank, outranks } from "@/lib/hierarchy";
import { useApp, useMyRank, usePerms } from "@/session";

/** The roles of a member that I may remove (`removable`, a subset of `held`) or add, by the same rules as Server settings → Members. */
export function useAssignableRoles(userId: string): { held: Role[]; addable: Role[]; removable: Role[]; canEdit: boolean; above: boolean } {
  const sv = useApp((s) => s.server);
  const meId = useApp((s) => s.me?.id);
  const rank = useMyRank();
  const perms = usePerms();
  const roleIds = sv?.members[userId]?.role_ids;
  return useMemo(() => {
    // Roles highest first, without @everyone.
    const ranked = Object.values(sv?.roles ?? {}).filter((r) => r.id !== sv?.server.id).sort((a, b) => b.position - a.position);
    const assignable = hasPerm(perms, Perm.ManageRoles) ? ranked.filter((r) => canManageRole(rank, perms, r)) : [];
    const ids = roleIds ?? [];
    const held = ranked.filter((r) => ids.includes(r.id));
    const owner = userId === sv?.server.owner_id;
    const above = !!sv && outranks(rank, myRank(sv.server, ranked, userId, ids));
    const canEdit = !!sv?.members[userId] && !owner && assignable.length > 0 && (userId === meId || above);
    const addable = assignable.filter((r) => !ids.includes(r.id));
    return { held, addable, removable: held.filter((r) => assignable.includes(r)), canEdit, above };
  }, [sv, roleIds, userId, meId, rank, perms]);
}
