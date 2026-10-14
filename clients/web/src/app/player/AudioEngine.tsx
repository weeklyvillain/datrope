import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { player, usePlayer } from "./player-store";

type EngineState = { currentTime: number; duration: number };

const engineStore = createStore<EngineState>(() => ({ currentTime: 0, duration: 0 }));
let element: HTMLAudioElement | null = null;

/** The playing track's position and length, and seeking it. Both the desktop bar and the phone player read it. */
export const audioEngine = {
  store: engineStore,
  seek(t: number) { if (element) element.currentTime = t; },
  /** Previous: back to the start of this track once it has played a few seconds, else the previous track. */
  previous() { if (element && element.currentTime > 3) element.currentTime = 0; else player.prev(); },
};
export const useAudioEngine = <T,>(select: (s: EngineState) => T): T => useStore(engineStore, select);

/** The music player's one audio element for the whole app (mounted once in the app shell), and the OS media keys. */
export function AudioEngine() {
  const queue = usePlayer((s) => s.queue);
  const playing = usePlayer((s) => s.playing);
  const volume = usePlayer((s) => s.volume);
  const seq = usePlayer((s) => s.seq);
  const audio = useRef<HTMLAudioElement | null>(null);
  const current = queue.tracks[queue.index];

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    if (playing) el.play().catch(() => undefined);
    else el.pause();
  }, [playing, current?.key]);
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume]);
  // A replayed track (repeat one, a lone track on repeat all, Previous at the top) leaves the queue unchanged, so restart on `seq`.
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = 0;
    el.play().catch(() => undefined);
  }, [seq]);
  useEffect(() => { if (!current) engineStore.setState({ currentTime: 0, duration: 0 }); }, [current]);

  // OS media keys and the now-playing card.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!current) { navigator.mediaSession.metadata = null; return; }
    navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: current.subtitle });
    navigator.mediaSession.setActionHandler("play", () => player.setPlaying(true));
    navigator.mediaSession.setActionHandler("pause", () => player.setPlaying(false));
    navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
    navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
  }, [current]);

  if (!current) return null;
  return (
    <audio ref={(el) => { audio.current = el; element = el; }} src={current.src} preload="auto"
      onTimeUpdate={(e) => engineStore.setState({ currentTime: e.currentTarget.currentTime })}
      onDurationChange={(e) => engineStore.setState({ duration: e.currentTarget.duration })}
      onPlaying={() => player.started()} onEnded={() => player.ended()} onError={() => player.failed()} />
  );
}
