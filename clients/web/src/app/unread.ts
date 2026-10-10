import { compareIds } from "@datrope/core";

const ID_EPOCH = 1767225600000; // server/internal/id: 2026-01-01T00:00:00Z

/** Index of the first message newer than the read marker that is neither pending nor mine, or -1.
 *  Without a read marker every message is unread. */
export function firstUnreadIndex(
  items: { id: string; author?: { id: string }; pending?: boolean }[],
  lastReadId: string | undefined,
  meId: string | undefined,
): number {
  return items.findIndex((m) => !m.pending && (!m.author || m.author.id !== meId) && (lastReadId === undefined || compareIds(m.id, lastReadId) > 0));
}

/** When a Snowflake ID was created. */
export const idTime = (id: string) => new Date(Number(BigInt(id) >> 22n) + ID_EPOCH);
