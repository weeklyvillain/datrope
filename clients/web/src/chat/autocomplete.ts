import type { Role } from "@datrope/core";

export type Trigger = { kind: "emoji" | "mention" | "command"; query: string; start: number };

const MENTION = /(?:^|[\s(])@([A-Za-z0-9_.-]{2,})$/;
const EMOJI = /(?:^|\s):([A-Za-z0-9_+-]{2,})$/;
// A slash command's name, typed at the very start of the message.
const COMMAND = /^\/([A-Za-z]*)$/;

/** The `/command`, `@mention` or `:emoji` being typed just before the caret, if any. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const command = COMMAND.exec(text.slice(0, caret));
  if (command) return { kind: "command", query: command[1]!, start: 0 };
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

/** Roles I may ping here, senior first: mentionable ones, or all but @everyone with MENTION_ROLES. */
export function pingableRoles(roles: Role[], everyoneId: string, canPingAny: boolean): Role[] {
  return roles.filter((r) => r.id !== everyoneId && (canPingAny || r.mentionable)).sort((a, b) => b.position - a.position);
}
