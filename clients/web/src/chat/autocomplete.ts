export type Trigger = { kind: "emoji" | "mention"; query: string; start: number };

const MENTION = /(?:^|[\s(])@([A-Za-z0-9_.-]{2,})$/;
const EMOJI = /(?:^|\s):([A-Za-z0-9_+-]{2,})$/;

/** The `@mention` or `:emoji` being typed just before the caret, if any. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(lineStart, caret);
  // Inside an unclosed inline code span.
  if ((line.match(/`/g)?.length ?? 0) % 2 === 1) return null;
  for (const [kind, re] of [["mention", MENTION], ["emoji", EMOJI]] as const) {
    const m = re.exec(line);
    if (m) return { kind, query: m[1], start: caret - m[1].length - 1 };
  }
  return null;
}

/** Items whose key contains the query (ignoring case): prefix matches first, then
 *  substring matches, shorter keys first within each; at most 8. */
export function rank<T extends { key: string }>(query: string, items: T[]): T[] {
  const q = query.toLowerCase();
  return items
    .map((item) => ({ item, at: item.key.toLowerCase().indexOf(q) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => Number(a.at > 0) - Number(b.at > 0) || a.item.key.length - b.item.key.length)
    .slice(0, 8)
    .map((x) => x.item);
}
