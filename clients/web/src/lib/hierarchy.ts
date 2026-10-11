import { hasPerm, type Role } from "@datrope/core";

/**
 * Mirrors the server's role hierarchy (server/internal/communities/hierarchy.go):
 * the highest position among roles that carry authority; self-assignable roles grant none.
 */
export function myRank(server: { owner_id: string }, roles: Role[], userId: string, roleIds: string[]): number {
  if (userId === server.owner_id) return Infinity;
  return roles.filter((r) => roleIds.includes(r.id) && !r.self_assignable).reduce((max, r) => Math.max(max, r.position), 0);
}

/** Whether a member of this rank may edit the role (@everyone's permissions are handled by the caller). */
export function canEditRole(rank: number, role: Role): boolean {
  return role.position > 0 && role.position < rank;
}

export function outranks(mine: number, theirs: number): boolean {
  return mine > theirs;
}

/** Whether I may edit, delete or hand out the role: it is below me and I hold every permission it grants. */
export function canManageRole(rank: number, perms: number, role: Role): boolean {
  return canEditRole(rank, role) && hasPerm(perms, role.permissions);
}
