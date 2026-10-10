// Pure helpers for the GIF picker (app/GifDialog.tsx).
import { ApiError } from "@datrope/core";

/** Splits items into columns, each into the column that is currently shortest
 *  (by height / width, so a column's width doesn't matter). Order is kept within a column. */
export function masonry<T extends { width: number; height: number }>(items: T[], columns: number): T[][] {
  const cols: T[][] = Array.from({ length: columns }, () => []);
  const heights: number[] = Array.from({ length: columns }, () => 0);
  for (const item of items) {
    const i = heights.indexOf(Math.min(...heights));
    cols[i]!.push(item);
    heights[i] = heights[i]! + (item.width > 0 && item.height > 0 ? item.height / item.width : 1);
  }
  return cols;
}

/** items followed by the ones in more that are not already listed. */
export function appendUnique<T extends { id: string }>(items: T[], more: T[]): T[] {
  const seen = new Set(items.map((x) => x.id));
  return [...items, ...more.filter((x) => !seen.has(x.id) && !!seen.add(x.id))];
}

/** Tickets for requests whose answers may arrive out of order: only the newest is used. */
export function requestTickets() {
  let newest = 0;
  return {
    /** A ticket for a request that replaces everything before it (a new search). */
    renew: () => ++newest,
    /** A ticket for a request that continues the newest one (its next page). */
    current: () => newest,
    isNewest: (ticket: number) => ticket === newest,
  };
}

/** What to say when storing the picked GIF fails. */
export function attachError(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Please try again.";
  if (e.code === "TOO_LARGE") return "That GIF is too big to post here. Try another one.";
  if (e.code === "RATE_LIMITED") return "You're sending GIFs too fast. Wait a moment and try again.";
  if (e.code === "GIF_PROVIDER_ERROR") return "Couldn't reach Klipy. Try again.";
  return e.message;
}
