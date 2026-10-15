import type { WatchState } from "@datrope/core";

/** An embedded player we drive ourselves; its own controls are hidden. */
export interface WatchPlayer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  currentTime(): number;
  duration(): number; // 0 while unknown, and for live streams
  live(): boolean; // a live stream: there is no position to seek to
  playing(): boolean; // playing or buffering towards playing
  buffering(): boolean; // meant to be playing but stalled
  loadedAhead(): number | undefined; // seconds loaded past currentTime; undefined when the player cannot tell
  setVolume(volume: number): void; // 0-100
  setMuted(muted: boolean): void;
  destroy(): void;
}

export interface PlayerEvents {
  onReady(): void;
  onPlaying(): void; // the video started playing (any gate the site put up has been passed)
  onError(message: string): void;
}

/** Builds a player inside `mount`, an element the caller created for it (players replace it). */
export type CreatePlayer = (mount: HTMLElement, st: WatchState, start: number, events: PlayerEvents) => Promise<WatchPlayer>;
