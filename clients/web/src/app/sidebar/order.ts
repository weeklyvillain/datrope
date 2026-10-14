/** Channel IDs by sidebar group: NONE for uncategorised (without the welcome channel), else the category ID. */
export type Groups = Record<string, string[]>;

export const NONE = "none";

export function groupOf(groups: Groups, channelId: string): string | undefined {
  return Object.keys(groups).find((g) => groups[g].includes(channelId));
}

/** Moves a channel to `index` (clamped) in group `to`. Returns new groups. */
export function moveTo(groups: Groups, channelId: string, to: string, index: number): Groups {
  const next = Object.fromEntries(Object.entries(groups).map(([g, ids]) => [g, ids.filter((id) => id !== channelId)]));
  const target = next[to] ?? [];
  target.splice(Math.max(0, Math.min(index, target.length)), 0, channelId);
  next[to] = target;
  return next;
}

/** Where a channel or category goes when moved one step up (-1) or down (1) in its group. */
export function neighbourMove(ids: string[], id: string, dir: -1 | 1): { position: number } | null {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  return { position: j };
}
