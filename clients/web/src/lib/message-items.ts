import type { ClientMessage } from "@datrope/core";
import { authorKey } from "@/app/message-author";
import type { MessageKey } from "./message-keys";

export type Item =
  | { kind: "day"; key: string; date: Date }
  | { kind: "unread"; key: "unread" }
  | { kind: "message"; key: string; m: ClientMessage; grouped: boolean };

const FIVE_MINUTES = 5 * 60 * 1000;

/** The rows of a message list: day dividers, the "New messages" line, and messages with their grouping
 *  (same author, under five minutes, not a reply, not after the unread line or a system/deleted message).
 *  A message is keyed by its nonce when it has one, so a pending row keeps its key (and focus) when confirmed. */
export function buildItems(messages: ClientMessage[], { unreadAt, variant }: { unreadAt: number; variant: "chat" | "cards" }): Item[] {
  const out: Item[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const day = new Date(m.created_at);
    const newDay = !prev || new Date(prev.created_at).toDateString() !== day.toDateString();
    if (newDay) out.push({ kind: "day", key: `day-${day.toDateString()}`, date: day });
    if (i === unreadAt) out.push({ kind: "unread", key: "unread" });
    const grouped = variant === "chat" && !!prev && !newDay && !m.reply_to && i !== unreadAt && authorKey(prev) === authorKey(m)
      && !prev.deleted && !prev.kind && !m.kind && Date.parse(m.created_at) - Date.parse(prev.created_at) < FIVE_MINUTES;
    out.push({ kind: "message", key: m.nonce || m.id, m, grouped });
  });
  return out;
}

const firstMessageKey = (items: Item[]) => items.find((it) => it.kind === "message")?.key;

/** How many items now sit above the message that used to be first (older history was loaded). Anchored on
 *  the first message, not the first item: a day divider keeps its key when older messages of that day arrive. */
export function prependedCount(prev: Item[] | undefined, items: Item[]): number {
  const key = prev && firstMessageKey(prev);
  if (!key) return 0;
  const before = prev.findIndex((it) => it.key === key);
  const after = items.findIndex((it) => it.key === key);
  return after < 0 ? 0 : Math.max(0, after - before);
}

export const indexOfMessage = (items: Item[], id: string) => items.findIndex((it) => it.kind === "message" && it.m.id === id);

/** Indexes of the focusable message rows (not dividers or system messages). */
const rowIndexes = (items: Item[]) => items.flatMap((it, i) => (it.kind === "message" && !it.m.kind ? [i] : []));

/** The item index a navigation key leads to from message `id`, or -1 when `id` is not a row. */
export function navTarget(items: Item[], id: string, act: Extract<MessageKey, "prev" | "next" | "first" | "last">): number {
  const rows = rowIndexes(items);
  const pos = rows.indexOf(indexOfMessage(items, id));
  if (pos < 0) return -1;
  const j = act === "prev" ? pos - 1 : act === "next" ? pos + 1 : act === "first" ? 0 : rows.length - 1;
  return rows[Math.max(0, Math.min(rows.length - 1, j))]!;
}

/** The row to focus after deleting message `id`: the next row, else the previous one. */
export function neighbourRow(items: Item[], id: string): ClientMessage | undefined {
  const rows = rowIndexes(items);
  const pos = rows.indexOf(indexOfMessage(items, id));
  const i = pos < 0 ? undefined : rows[pos + 1] ?? rows[pos - 1];
  const it = i === undefined ? undefined : items[i];
  return it?.kind === "message" ? it.m : undefined;
}
