/**
 * What a typed music link is:
 * - "list": a playlist, an album or a set, with no single track picked;
 * - "track-in-list": one track opened from inside a playlist (YouTube's watch?v=…&list=…);
 * - undefined: a single track, or search words.
 */
export type LinkKind = "list" | "track-in-list" | undefined;

export function linkKind(input: string): LinkKind {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  const path = u.pathname;
  if (host === "youtube.com" || host === "youtu.be") {
    if (!u.searchParams.get("list")) return undefined;
    return u.searchParams.get("v") || host === "youtu.be" ? "track-in-list" : "list";
  }
  if (host === "soundcloud.com") return /^\/[^/]+\/sets\/[^/]+/.test(path) ? "list" : undefined;
  if (host.endsWith("bandcamp.com")) return path.startsWith("/album/") ? "list" : undefined;
  if (host === "open.spotify.com") return /^\/(intl-[a-z-]+\/)?(album|playlist)\//.test(path) ? "list" : undefined;
  return undefined;
}

/** "12.3 MB" style. */
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** "1 track", "12 tracks". */
export const trackCount = (n: number) => `${n} ${n === 1 ? "track" : "tracks"}`;

/** "1 h 5 min", "12 min", "45 s": a playlist's total length. */
export function totalLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/** Names a site for screen readers and tooltips. */
export const siteNames: Record<string, string> = {
  youtube: "YouTube", soundcloud: "SoundCloud", bandcamp: "Bandcamp", vimeo: "Vimeo", spotify: "Spotify",
};

/** The summary after queueing or adding several tracks. */
export function addedSummary(verb: "Queued" | "Added", r: { count: number; skipped: number; dropped: number; unreadable?: number }): string | undefined {
  if (r.count <= 1 && !r.skipped && !r.dropped && !r.unreadable) return undefined;
  const parts = [`${verb} ${r.count} ${r.count === 1 ? "track" : "tracks"}`];
  if (r.skipped) parts.push(`${r.skipped} didn't fit`);
  if (r.dropped) parts.push(`${r.dropped} unavailable ${r.dropped === 1 ? "track was" : "tracks were"} left out`);
  if (r.unreadable) parts.push(`${r.unreadable} skipped (from a channel you can't read)`);
  return `${parts.join(", ")}.`;
}

/** The subtitle of a file item in a playlist: the channel it was shared in. */
export const fileChannelLabel = (name?: string) => `#${name ?? "channel"}`;

/** The note under a playlist's header when some items are from channels the viewer can't read. */
export const hiddenNote = (n: number): string | undefined => (n > 0 ? `${n} hidden (from channels you can't read)` : undefined);
