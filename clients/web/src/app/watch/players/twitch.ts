import { loadScript } from "../load-script";
import type { CreatePlayer } from "./types";

type TwitchPlayer = {
  play(): void; pause(): void; seek(seconds: number): void;
  getCurrentTime(): number; getDuration(): number; isPaused(): boolean;
  setVolume(volume: number): void; setMuted(muted: boolean): void;
  addEventListener(event: string, cb: () => void): void;
};
type TwitchNamespace = { Player: { new (elementId: string, options: object): TwitchPlayer; READY: string; OFFLINE: string } };

declare global {
  interface Window {
    Twitch?: TwitchNamespace;
  }
}

/** 3723 → "1h2m3s", Twitch's time format. */
const twitchTime = (seconds: number) => {
  const t = Math.floor(seconds);
  return `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s`;
};

let next = 0;

export const createTwitch: CreatePlayer = async (mount, st, start, events) => {
  await loadScript("https://embed.twitch.tv/embed/v1.js");
  const T = window.Twitch!;
  const live = st.kind === "twitch_live";
  mount.id ||= `watch-twitch-${++next}`; // Twitch's player takes an element ID
  const p = new T.Player(mount.id, {
    width: "100%",
    height: "100%",
    parent: [location.hostname],
    autoplay: !st.paused,
    muted: false,
    controls: false,
    ...(live ? { channel: st.video_id } : { video: `v${st.video_id}`, time: twitchTime(start) }),
  });
  p.addEventListener(T.Player.READY, () => events.onReady());
  if (live) p.addEventListener(T.Player.OFFLINE, () => events.onError(`${st.video_id} is offline.`));
  return {
    play: () => p.play(),
    pause: () => p.pause(),
    seek: (s) => p.seek(s),
    currentTime: () => p.getCurrentTime(),
    duration: () => (live ? 0 : p.getDuration()),
    live: () => live,
    playing: () => !p.isPaused(),
    setVolume: (v) => p.setVolume(v / 100),
    setMuted: (m) => p.setMuted(m),
    destroy: () => mount.replaceChildren(), // Twitch's player has no destroy; dropping its iframe ends it
  };
};
