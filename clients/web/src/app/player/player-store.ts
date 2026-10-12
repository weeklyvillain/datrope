import type { PlaylistItem } from "@datrope/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { client, displayName } from "../../session";
import { itemAuthor, type GalleryItem } from "../gallery/items";
import { channelTag } from "../gallery/FileTile";
import { shownAuthor } from "../message-author";
import { advance, back, EMPTY, enqueue, moveTo, removeAt, shuffleUpcoming, start, type Queue, type Repeat, type Track } from "./queue";

type PlayerState = { queue: Queue; playing: boolean; repeat: Repeat; shuffle: boolean; volume: number; notice?: string; seq: number };
// `seq` bumps whenever playback should (re)start from the top, even when the queue object is unchanged (repeat one).

export const playerStore = createStore<PlayerState>(() => ({ queue: EMPTY, playing: false, repeat: "off", shuffle: false, volume: 1, seq: 0 }));
export const usePlayer = <T,>(select: (s: PlayerState) => T): T => useStore(playerStore, select);

const set = (patch: Partial<PlayerState>) => playerStore.setState(patch);
const get = () => playerStore.getState();
const bump = () => get().seq + 1;
// Tracks that failed in a row; once every queued track has failed, stop instead of skipping forever (repeat all).
let fails = 0;

export const player = {
  play(list: Track[], at = 0, shuffle = false) {
    const tracks = enqueue(EMPTY, list).tracks; // a playlist can hold the same file twice
    let q: Queue;
    if (shuffle) {
      const pick = Math.floor(Math.random() * tracks.length);
      q = shuffleUpcoming(start([tracks[pick], ...tracks.filter((_, i) => i !== pick)]));
    } else {
      q = start(tracks, Math.max(tracks.findIndex((t) => t.key === list[at]?.key), 0));
    }
    fails = 0;
    set({ queue: q, playing: q.index >= 0, shuffle, notice: undefined, seq: bump() });
  },
  add(tracks: Track[]) {
    const wasEmpty = get().queue.index < 0;
    if (wasEmpty) fails = 0;
    set({ queue: enqueue(get().queue, tracks), ...(wasEmpty ? { playing: true, seq: bump() } : {}) });
  },
  toggle() { if (get().queue.index >= 0) set({ playing: !get().playing }); },
  setPlaying(playing: boolean) { if (get().queue.index >= 0) set({ playing }); },
  /** The current track began playing. */
  started() { fails = 0; },
  next() {
    fails = 0;
    const r = get().repeat === "one" ? "off" : get().repeat; // Next always moves on
    const q = advance(get().queue, r);
    set(q ? { queue: q, playing: true, seq: bump(), notice: undefined } : { playing: false, notice: undefined });
  },
  prev() { fails = 0; if (get().queue.index >= 0) set({ queue: back(get().queue), playing: true, seq: bump(), notice: undefined }); },
  ended() {
    fails = 0;
    const q = advance(get().queue, get().repeat);
    set(q ? { queue: q, playing: true, seq: bump(), notice: undefined } : { playing: false, notice: undefined });
  },
  /** The current track could not load (gone, or no longer readable): note it and move on. */
  failed() {
    const cur = get().queue.tracks[get().queue.index];
    const q = advance(get().queue, get().repeat === "one" ? "off" : get().repeat);
    fails++;
    const more = q && q.index !== get().queue.index && fails < get().queue.tracks.length;
    set({ notice: cur ? `Couldn't play ${cur.title}. Skipped.` : undefined, ...(more ? { queue: q, playing: true, seq: bump() } : { playing: false }) });
  },
  remove(i: number) { const q = removeAt(get().queue, i); set({ queue: q, playing: q.index >= 0 && get().playing }); },
  move(from: number, to: number) { set({ queue: moveTo(get().queue, from, to) }); },
  setRepeat(repeat: Repeat) { set({ repeat }); },
  toggleShuffle() {
    const on = !get().shuffle;
    set({ shuffle: on, ...(on ? { queue: shuffleUpcoming(get().queue) } : {}) });
  },
  setVolume(volume: number) { set({ volume }); },
  clear() { set({ queue: EMPTY, playing: false, notice: undefined }); },
};

export function trackFromItem(it: GalleryItem, author?: string): Track {
  const tag = channelTag(it);
  // an album upload has no message: name its uploader from the server's members
  const uploader = it.message ? undefined : itemAuthor(it, client.store.getState().server?.members);
  const by = author ?? (it.message ? displayName(shownAuthor(it.message)) : uploader ? displayName(uploader) : "");
  return {
    key: `file:${it.attachment.id}`, title: it.attachment.filename,
    subtitle: [tag && `#${tag}`, by].filter(Boolean).join(" · "),
    src: client.url(it.attachment.url), channelId: it.message?.channel_id, attachmentId: it.attachment.id,
  };
}

/** A playlist item the browser can play (files and library uploads); links play only in voice. */
export function trackFromPlaylistItem(it: PlaylistItem, channelName?: string): Track | null {
  if (it.source === "file" && it.attachment_id) {
    return { key: `file:${it.attachment_id}`, title: it.title, subtitle: channelName ? `#${channelName}` : "",
      src: client.url(`/api/attachments/${it.attachment_id}`), attachmentId: it.attachment_id, channelId: it.channel_id ?? undefined };
  }
  if (it.source === "upload" && it.track_id) {
    return { key: `upload:${it.track_id}`, title: it.title, subtitle: it.artist ?? "", src: client.libraryAudioUrl(it.track_id), cover: it.cover ? client.url(it.cover) : undefined };
  }
  return null;
}
