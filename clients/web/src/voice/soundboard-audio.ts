import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { routeToOutput } from "./output";

/** Soundboard clips never play longer than this, whatever the file says. */
export const MAX_CLIP_MS = 5000;

/** How long a tile shows who played what. */
export const RECENT_MS = 3000;

export type PlayEvent = { channel_id: string; user_id: string; sound_id: string };

/** Whether this device plays a soundboard event: it's for my call, I'm not deafened and I haven't muted the player. */
export function shouldPlay(
  event: PlayEvent,
  me: { channelId?: string; deafened: boolean },
  mutedForMe: Record<string, boolean>,
): boolean {
  return event.channel_id === me.channelId && !me.deafened && !mutedForMe[event.user_id];
}

/** Seconds of a clip to play: its length, at most 5 s. */
export function clipSeconds(durationMs: number): number {
  return Math.min(durationMs, MAX_CLIP_MS) / 1000;
}

const live = new Set<HTMLAudioElement>();

function release(el: HTMLAudioElement) {
  if (!live.delete(el)) return;
  el.pause();
  el.removeAttribute("src");
  el.load();
}

/** Stops and releases every clip that is playing (deafen, leaving the call). */
export function stopAllClips() {
  for (const el of [...live]) release(el);
}

/** Warms the HTTP cache so the first play starts quickly. Clips are never decoded ahead of time; failures are ignored. */
export function preload(urls: string[]) {
  for (const u of urls) {
    fetch(u, { priority: "low" } as RequestInit).then((r) => r.body?.cancel()).catch(() => undefined);
  }
}

/**
 * Plays a clip through an audio element (streamed, so memory stays bounded whatever the file holds) at `volumePct`
 * (0-100) of full volume, for at most `durationMs` (and never over 5 s). Returns a function that stops it early.
 */
export function playClip(url: string, volumePct: number, durationMs = MAX_CLIP_MS): () => void {
  const el = new Audio(url);
  el.preload = "auto";
  el.volume = Math.min(100, Math.max(0, volumePct)) / 100;
  live.add(el);
  routeToOutput(el);
  const timer = setTimeout(() => release(el), clipSeconds(durationMs) * 1000);
  const done = () => { clearTimeout(timer); release(el); };
  el.addEventListener("ended", done);
  el.addEventListener("error", done);
  el.play().catch(done); // autoplay blocked or unplayable: ignore
  return done;
}
export type RecentPlays = Record<string, { soundId: string; until: number }>;

/** Who played a sound in the last 3 s, by user ID. */
export const recentPlays = createStore<RecentPlays>(() => ({}));

export function recordPlay(userId: string, soundId: string) {
  const until = Date.now() + RECENT_MS;
  recentPlays.setState({ [userId]: { soundId, until } });
  setTimeout(() => {
    if (recentPlays.getState()[userId]?.until !== until) return; // a newer play replaced it
    const { [userId]: _, ...rest } = recentPlays.getState();
    recentPlays.setState(rest, true);
  }, RECENT_MS);
}

/** The sound this person just played, for 3 s. */
export function useRecentPlay(userId: string): { soundId: string; until: number } | undefined {
  return useStore(recentPlays, (s) => s[userId]);
}
