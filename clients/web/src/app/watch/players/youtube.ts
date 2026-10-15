import { loadScript } from "../load-script";
import type { CreatePlayer } from "./types";

type YTPlayer = {
  playVideo(): void; pauseVideo(): void; seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime?(): number; getDuration?(): number; getPlayerState?(): number; getVideoLoadedFraction?(): number;
  getVideoData?(): { isLive?: boolean };
  setVolume(volume: number): void; mute(): void; unMute(): void; destroy(): void;
};
type YTNamespace = { Player: new (el: HTMLElement, options: object) => YTPlayer };

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let api: Promise<YTNamespace> | undefined;

/** YouTube's IFrame API, loaded once. */
function youtubeApi(): Promise<YTNamespace> {
  api ??= new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const before = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      before?.();
      resolve(window.YT!);
    };
    loadScript("https://www.youtube.com/iframe_api").catch((e: unknown) => {
      api = undefined;
      reject(e);
    });
  });
  return api;
}

const ERRORS: Record<number, string> = {
  2: "This link is not a valid video.",
  5: "The video cannot play here.",
  100: "The video is private or was removed.",
  101: "The video's owner does not allow playing it here.",
  150: "The video's owner does not allow playing it here.",
};

const PLAYING = 1;
const BUFFERING = 3;

export const createYouTube: CreatePlayer = async (mount, st, start, events) => {
  const YT = await youtubeApi();
  const p = new YT.Player(mount, {
    host: "https://www.youtube-nocookie.com", // the CSP's frame-src allows this host
    videoId: st.video_id,
    width: "100%",
    height: "100%",
    playerVars: { autoplay: st.paused ? 0 : 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, start: Math.floor(start) },
    events: {
      onReady: () => events.onReady(),
      onStateChange: (e: { data: number }) => {
        if (e.data === PLAYING) events.onPlaying();
      },
      onError: (e: { data: number }) => events.onError(ERRORS[e.data] ?? "The video cannot play."),
    },
  });
  return {
    play: () => p.playVideo(),
    pause: () => p.pauseVideo(),
    seek: (s) => p.seekTo(s, true),
    currentTime: () => p.getCurrentTime?.() ?? 0,
    duration: () => p.getDuration?.() ?? 0,
    live: () => !!p.getVideoData?.().isLive,
    playing: () => {
      const s = p.getPlayerState?.();
      return s === PLAYING || s === BUFFERING;
    },
    buffering: () => p.getPlayerState?.() === BUFFERING,
    loadedAhead: () => {
      if (p.getVideoData?.().isLive) return undefined;
      const d = p.getDuration?.() ?? 0;
      return d ? Math.max(0, (p.getVideoLoadedFraction?.() ?? 0) * d - (p.getCurrentTime?.() ?? 0)) : 0;
    },
    setVolume: (v) => p.setVolume(v),
    setMuted: (m) => (m ? p.mute() : p.unMute()),
    destroy: () => p.destroy(),
  };
};
