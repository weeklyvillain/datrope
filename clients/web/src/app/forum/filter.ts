import type { ThreadListItem } from "@datrope/core";
import { byActivity } from "../threads";

export type PostSort = "activity" | "newest" | "replies";

/** A forum's posts matching the search (title or excerpt, any case) and tag, in the chosen order.
 *  Ties keep latest activity first. */
export function filterPosts(items: ThreadListItem[], f: { query: string; tag: string | null; sort: PostSort }): ThreadListItem[] {
  const q = f.query.trim().toLowerCase();
  const kept = items.filter((p) =>
    (!q || p.channel.name.toLowerCase().includes(q) || (p.excerpt ?? "").toLowerCase().includes(q)) &&
    (!f.tag || (p.channel.tags ?? []).includes(f.tag)));
  const sorted = byActivity(kept);
  if (f.sort === "newest") return sorted.sort((a, b) => (BigInt(b.channel.id) > BigInt(a.channel.id) ? 1 : BigInt(b.channel.id) < BigInt(a.channel.id) ? -1 : 0));
  if (f.sort === "replies") return sorted.sort((a, b) => b.summary.message_count - a.summary.message_count);
  return sorted;
}
