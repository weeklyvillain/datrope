import type { PlaylistItem } from "@datrope/core";
import { trackFromPlaylistItem } from "../player/player-store";
import type { Track } from "../player/queue";

/** The tracks your own player can play: channel files and library uploads (links play only in voice). */
export function playableTracks(items: PlaylistItem[], channelName: (id?: string) => string | undefined): Track[] {
  return items.map((it) => trackFromPlaylistItem(it, channelName(it.channel_id ?? undefined))).filter((t): t is Track => t !== null);
}
