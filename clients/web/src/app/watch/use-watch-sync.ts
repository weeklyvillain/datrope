import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../session";
import { createPlayer } from "./players";
import type { WatchPlayer } from "./players/types";
import { expectedPosition, reconcile } from "./sync";

const TICK_MS = 2000;
const AUTOPLAY_GRACE_MS = 1500;

/** Mounts the player for a channel's watch inside `host` and keeps it in step with the server's state. Without `enabled` there is no player. */
export function useWatchSync(channelId: string, host: RefObject<HTMLDivElement>, enabled: boolean) {
  const st = useApp((s) => s.watch[channelId] ?? null);
  const offset = useApp((s) => s.serverOffset);
  const [player, setPlayer] = useState<WatchPlayer>();
  const [error, setError] = useState<string>();
  const [blocked, setBlocked] = useState(false);
  const [started, setStarted] = useState(false); // the current video has played at least once
  const stRef = useRef(st);
  stRef.current = st;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  // A new player per video; play, pause and seek reuse it.
  const url = st?.url;
  useEffect(() => {
    const el = host.current;
    const cur = stRef.current;
    if (!enabled || !el || !cur) return;
    let gone = false;
    let ready = false;
    let made: WatchPlayer | undefined;
    setError(undefined);
    setBlocked(false);
    setStarted(false);
    const mount = document.createElement("div"); // the player replaces it; React never owns it
    el.appendChild(mount);
    createPlayer(mount, cur, expectedPosition(cur, Date.now(), offsetRef.current), {
      onReady: () => {
        ready = true;
        if (made && !gone) setPlayer(made);
      },
      onPlaying: () => {
        if (gone) return;
        setStarted(true);
        setBlocked(false); // playing after all, e.g. once Twitch's gate was clicked through
      },
      onError: (m) => {
        if (!gone) setError(m);
      },
    }).then((p) => {
      made = p;
      if (gone) p.destroy();
      else if (ready) setPlayer(p);
    }, () => {
      if (!gone) setError("The player could not load.");
    });
    return () => {
      gone = true;
      made?.destroy();
      el.replaceChildren();
      setPlayer(undefined);
    };
  }, [url, host, enabled]);

  // Match the shared state now and every tick; seek only past the drift threshold.
  useEffect(() => {
    if (!player || blocked) return;
    const timers: number[] = [];
    const tick = () => {
      const cur = stRef.current;
      if (!cur) return;
      const expected = expectedPosition(cur, Date.now(), offsetRef.current);
      // A live YouTube stream sits at the live edge: nothing to seek to, like Twitch live.
      const fix = reconcile({ kind: player.live() ? "twitch_live" : cur.kind, paused: cur.paused }, { time: player.currentTime(), playing: player.playing(), duration: player.duration() }, expected);
      if (fix.seek !== undefined) player.seek(fix.seek);
      if (fix.pause) player.pause();
      if (fix.play) {
        player.play();
        timers.push(window.setTimeout(() => {
          if (stRef.current && !stRef.current.paused && !player.playing()) setBlocked(true); // the browser blocked autoplay
        }, AUTOPLAY_GRACE_MS));
      }
    };
    tick();
    const interval = window.setInterval(tick, TICK_MS);
    return () => {
      window.clearInterval(interval);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [player, blocked, st]);

  /** "Click to sync": a click is the gesture the browser wants before playing with sound. */
  const unblock = () => {
    if (!stRef.current?.paused) player?.play();
    setBlocked(false);
  };

  // Twitch can open on a gate (mature content) that only a click inside its player clears; until the video first
  // plays, clicks go through to it.
  const open = st?.kind !== "youtube" && !started;

  return { st, player, error, blocked, unblock, open };
}
