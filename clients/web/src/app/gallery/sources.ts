import type { Channel } from "@datrope/core";

/** Does a gallery show files posted in this channel (a thread counts as its parent)? */
export function inGallery(gallery: Channel, homeId: string): boolean {
  if (homeId === gallery.id) return true;
  if (gallery.gallery_sources === "all") return true;
  return gallery.gallery_sources === "selected" && (gallery.source_channel_ids ?? []).includes(homeId);
}

/** The top bar's note on where a gallery's files come from; "" for a gallery of its own posts. */
export function sourceSummary(ch: Channel, channels: Record<string, Channel | undefined>): string {
  if (ch.gallery_sources === "all") return "from all channels";
  if (ch.gallery_sources !== "selected") return "";
  const known = (ch.source_channel_ids ?? []).map((id) => channels[id]).filter((c): c is Channel => !!c);
  if (known.length === 0) return "";
  return known.length === 1 ? `posts here + #${known[0].name}` : `posts here + ${known.length} channels`;
}

/** The picked source ids that still name a known channel (a deleted channel's id lingers on the gallery until it is next updated). */
export function liveIds(ids: string[] | null | undefined, channels: Record<string, Channel | undefined>): string[] {
  return (ids ?? []).filter((id) => !!channels[id]);
}

/** Did the sources change from the gallery's current ones? Dead ids on the gallery are ignored. */
export function sourcesChanged(ch: Channel, next: { mode: string; ids: string[] }, channels: Record<string, Channel | undefined>): boolean {
  if ((ch.gallery_sources ?? "none") !== next.mode) return true;
  if (next.mode !== "selected") return false;
  const cur = liveIds(ch.source_channel_ids, channels);
  return cur.length !== next.ids.length || next.ids.some((id) => !cur.includes(id));
}
