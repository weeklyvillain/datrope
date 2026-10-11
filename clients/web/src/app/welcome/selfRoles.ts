import type { Role } from "@datrope/core";

/** The roles members can give themselves, senior first (as in the role list). */
export function pickableRoles(roles: Record<string, Role>): Role[] {
  return Object.values(roles).filter((r) => r.self_assignable).sort((a, b) => b.position - a.position);
}
