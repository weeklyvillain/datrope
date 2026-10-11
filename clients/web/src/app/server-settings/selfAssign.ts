import { selfAssignSafe, type Role } from "@datrope/core";

/** Why a role can't be self-assignable (mirrors the server's checks), or null if it can. */
export function selfAssignBlocker(role: Role, everyone: boolean, permissions: number): string | null {
  if (everyone) return "Every member already has @everyone.";
  if (role.is_guest) return "The Guest role is given by guest links only.";
  if (!selfAssignSafe(permissions)) return "Roles members pick themselves can't grant moderation, admin or mention permissions.";
  return null;
}
