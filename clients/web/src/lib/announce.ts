import { compareIds } from "@datrope/core";

/** A message's text as one short spoken line: no Markdown, no spoilers, at most `max` characters. */
export function plainPreview(markdown: string, max = 100): string {
  const s = markdown
    .replace(/\|\|[\s\S]*?\|\|/g, "spoiler")
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/<@[!&]?\d+>/g, "@mention")
    .replace(/```[\s\S]*?```/g, "code")
    .replace(/[*_~`>#]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : max)}…`;
}

/** What the status region says for messages that arrived together. */
export function announcement(batch: { author: string; text: string }[]): string {
  const first = batch[0];
  if (!first) return "";
  const line = `${first.author}: ${first.text || "attachment"}`;
  return batch.length > 1 ? `${line}, and ${batch.length - 1} more` : line;
}

/** New messages from others since `mark` (a high-water mark of confirmed ids), plus the updated mark. */
export function freshMessages<T extends { id: string; pending?: boolean; kind?: unknown; author?: { id: string } | null }>(
  items: T[],
  mark: string | undefined,
  meId: string | undefined,
): { fresh: T[]; mark: string | undefined } {
  const confirmed = items.filter((m) => !m.pending);
  let next = mark;
  for (const m of confirmed) if (next === undefined || compareIds(m.id, next) > 0) next = m.id;
  if (mark === undefined) return { fresh: [], mark: next };
  const fresh = confirmed.filter((m) => compareIds(m.id, mark) > 0 && !m.kind && m.author && m.author.id !== meId);
  return { fresh, mark: next };
}

/** Where the announcer stands in a channel: the high-water mark, and whether the list was a detached window. */
export type AnnounceState = { mark: string; detached: boolean };

/**
 * One look at a channel's loaded list: the messages to announce and the next state (undefined until seeded).
 * The first look seeds the mark without announcing; an empty channel seeds below every id, so its first message
 * is announced. While detached (`hasNewer`) nothing is announced, and coming back to the present re-seeds the mark
 * instead of announcing the backlog that was loaded on the way.
 */
export function announceStep<T extends { id: string; pending?: boolean; kind?: unknown; author?: { id: string } | null }>(
  list: { items: T[]; hasMore: boolean; hasNewer?: boolean },
  prev: AnnounceState | undefined,
  meId: string | undefined,
): { fresh: T[]; state: AnnounceState | undefined } {
  const detached = !!list.hasNewer;
  if (!prev || (prev.detached && !detached)) {
    // A list created only by a pending send (nothing loaded yet) has no mark and more to load: stay unseeded.
    const mark = freshMessages(list.items, prev?.mark, meId).mark ?? (list.hasMore ? undefined : "0");
    return { fresh: [], state: mark === undefined ? undefined : { mark, detached } };
  }
  const r = freshMessages(list.items, prev.mark, meId);
  return { fresh: detached ? [] : r.fresh, state: { mark: r.mark ?? prev.mark, detached } };
}
