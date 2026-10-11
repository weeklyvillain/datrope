const NAME = /^[A-Za-z0-9_]{2,32}$/;

/** A valid emoji name suggested from a file name. */
export function nameFromFile(filename: string): string {
  const base = filename.replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  if (!base) return "emoji";
  return base.length < 2 ? base.padEnd(2, "_") : base;
}

/** A valid emoji name suggested from a 7TV emote name; keeps its case (pepeLaugh). */
export function nameFromEmote(name: string): string {
  const base = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  if (!base) return "emote";
  return base.length < 2 ? base.padEnd(2, "_") : base;
}

/** The emote set ID in a 7TV link (https://7tv.app/emote-sets/<id>) or a bare ID, or null. */
export function sevenTVSetId(input: string): string | null {
  const s = input.trim();
  const id = /\/emote-sets\/([0-9A-Za-z]{24,26})(?:[/?#]|$)/.exec(s)?.[1] ?? s;
  return /^[0-9A-Za-z]{24,26}$/.test(id) ? id : null;
}

/** One error per tile (or null): bad name, clash with an existing emoji, or clash between tiles. */
export function validateNames(tiles: { name: string }[], existing: string[]): (string | null)[] {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const counts = new Map<string, number>();
  for (const t of tiles) counts.set(t.name.toLowerCase(), (counts.get(t.name.toLowerCase()) ?? 0) + 1);
  return tiles.map((t) => {
    const key = t.name.toLowerCase();
    if (!NAME.test(t.name)) return "Use letters, digits and _ (2–32)";
    if (taken.has(key)) return "Already used";
    if ((counts.get(key) ?? 0) > 1) return "Duplicate name";
    return null;
  });
}
