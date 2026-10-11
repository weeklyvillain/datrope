/** Moves `active` to the position of `over` (drag and drop in the server drawer). */
export function moveId(ids: string[], active: string, over: string): string[] {
  const from = ids.indexOf(active);
  const to = ids.indexOf(over);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Up to two initials for a server without an icon. A host like "chat.example.com" gives "C". */
export function serverInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words.slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

export const mentionLabel = (n: number) => (n > 99 ? "99+" : String(n));

/** What the Servers (☰) button shows: a dot when any other server has news, and the other servers' mentions. */
export function otherServersBadge(
  servers: { id: string; unread: boolean; mentions: number }[],
  selected: string | null,
): { unread: boolean; mentions: number } {
  const others = servers.filter((s) => s.id !== selected);
  const mentions = others.reduce((n, s) => n + s.mentions, 0);
  return { unread: mentions > 0 || others.some((s) => s.unread), mentions };
}
