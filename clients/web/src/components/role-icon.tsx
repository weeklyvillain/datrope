import type { Role, ServerState } from "@datrope/core";
import { useApp } from "@/session";
import { cn } from "@/lib/utils";
import { sizedImage } from "@/lib/sized-image";

/** The icon a member shows: their highest role that has one. */
export function topIconRole(sv: ServerState | null | undefined, userId: string): Role | undefined {
  const ids = sv?.members[userId]?.role_ids ?? [];
  return Object.values(sv?.roles ?? {})
    .filter((r) => (r.icon_emoji || r.icon_url) && ids.includes(r.id))
    .sort((a, b) => b.position - a.position)[0];
}

/** A role's icon: its uploaded image or its emoji (Unicode or custom); nothing if it has none. */
export function RoleIcon({ role, className }: { role: Role; className?: string }) {
  const custom = useApp((s) => (role.icon_emoji?.startsWith("custom:") ? s.emoji[role.icon_emoji.slice(7)] : undefined));
  const box = cn("inline-block size-4 flex-none object-contain align-[-0.15em]", className);
  if (role.icon_url) return <img {...sizedImage(role.icon_url, 24)} alt={role.name} title={role.name} className={box} />;
  if (custom) return <img {...sizedImage(custom.url, 24)} alt={role.name} title={role.name} className={box} />;
  if (!role.icon_emoji || role.icon_emoji.startsWith("custom:")) return null;
  return <span role="img" aria-label={role.name} title={role.name} className={cn("inline-block flex-none text-sm leading-none", className)}>{role.icon_emoji}</span>;
}

/** The icon of a member's highest role with one, if any. */
export function MemberRoleIcon({ userId, className }: { userId: string; className?: string }) {
  const role = useApp((s) => topIconRole(s.server, userId));
  return role ? <RoleIcon role={role} className={className} /> : null;
}
