import type { WatchState } from "@datrope/core";

/** How far a player may drift from the shared position before it is seeked back (seconds). */
export const DRIFT_S = 1.5;

type Clocked = Pick<WatchState, "kind" | "paused" | "position" | "updated_at">;

/** Where playback should be now (seconds): the server's position, plus the time since on the server's clock while playing. */
export function expectedPosition(st: Clocked, nowMs: number, offsetMs: number): number {
  if (st.paused || st.kind === "twitch_live") return st.position;
  return st.position + Math.max(0, nowMs + offsetMs - st.updated_at) / 1000;
}

/** What a player reports. `duration` is 0 while unknown. */
export type Sample = { time: number; playing: boolean; duration: number };

/** What a player must do to match the shared state. */
export type Fix = { seek?: number; play?: true; pause?: true };

export function reconcile(st: Pick<WatchState, "kind" | "paused">, sample: Sample, expected: number): Fix {
  // Past the end: the video is over for everyone; seeking and playing would only restart it.
  if (st.kind !== "twitch_live" && sample.duration > 0 && expected >= sample.duration) return {};
  // A player a little ahead of the server reaches the end first (and stops); do not restart it.
  if (st.kind !== "twitch_live" && sample.duration > 0 && sample.time >= sample.duration - DRIFT_S && sample.time - expected <= DRIFT_S) return {};
  const fix: Fix = {};
  if (st.kind !== "twitch_live" && Math.abs(sample.time - expected) > DRIFT_S) fix.seek = expected;
  if (st.paused && sample.playing) fix.pause = true;
  if (!st.paused && !sample.playing) fix.play = true;
  return fix;
}

/** 61 → "1:01", 3723 → "1:02:03". */
export function formatTime(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The toast for someone else's last action: "Anna paused". */
export function describeAction(st: Pick<WatchState, "last_action" | "position">, name: string): string {
  switch (st.last_action) {
    case "start": return `${name} started this`;
    case "play": return `${name} resumed`;
    case "pause": return `${name} paused`;
    case "seek": return `${name} skipped to ${formatTime(st.position)}`;
  }
}
