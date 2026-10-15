import type { WatchState } from "@datrope/core";

/** How far a player may drift from the shared position before it is seeked back (seconds). */
export const DRIFT_S = 1.5;

type Clocked = Pick<WatchState, "kind" | "paused" | "position" | "updated_at" | "waiting">;

/** Paused, or waiting for someone's player to load: either way the shared position holds. */
export function held(st: Pick<WatchState, "paused" | "waiting">): boolean {
  return st.paused || st.waiting.length > 0;
}

/** Where playback should be now (seconds): the server's position, plus the time since on the server's clock while it runs. */
export function expectedPosition(st: Clocked, nowMs: number, offsetMs: number): number {
  if (held(st) || st.kind === "twitch_live") return st.position;
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

/** Seconds loaded ahead before a waited-for player counts as ready. */
export const READY_AHEAD_S = 3;
/** How long a player must stall before the room waits for it (ms). */
export const STALL_MS = 750;
/** How long before an unanswered report is sent again (ms). */
export const RESEND_MS = 2000;

/** What a player says about loading. `loadedAhead` is undefined when the player cannot tell. */
export type Load = { time: number; duration: number; buffering: boolean; loadedAhead: number | undefined };

export function isReady(l: Load): boolean {
  if (l.buffering) return false;
  if (l.loadedAhead === undefined) return true;
  if (l.duration > 0 && l.time >= l.duration - 1) return true;
  return l.loadedAhead >= READY_AHEAD_S;
}

/** What has been reported for a seq: `sent` is the last value sent. */
export type Tracker = { seq: number; stallSince?: number; sent?: boolean; sentAt?: number };
export type ReportInput = { seq: number; now: number; buffering: boolean; ready: boolean; waitingOnMe: boolean; held: boolean };

/** Whether to tell the server I am loading (true) or ready (false): a stall once it lasts STALL_MS; ready once per seq
 * (which also tells the server I have a player) and again after a stall. Resent every RESEND_MS while the server has not caught up. */
export function nextReport(t: Tracker, i: ReportInput): { tracker: Tracker; send?: boolean } {
  const tr: Tracker = t.seq === i.seq ? t : { seq: i.seq };
  const resend = i.now - (tr.sentAt ?? 0) >= RESEND_MS;
  if (i.ready) {
    if (tr.sent !== false || (i.waitingOnMe && resend)) return { tracker: { seq: i.seq, sent: false, sentAt: i.now }, send: false };
    return { tracker: { ...tr, stallSince: undefined } };
  }
  if (i.held || !i.buffering) return { tracker: { ...tr, stallSince: undefined } };
  const since = tr.stallSince ?? i.now;
  if (i.now - since >= STALL_MS && (tr.sent !== true || resend)) return { tracker: { seq: i.seq, stallSince: since, sent: true, sentAt: i.now }, send: true };
  return { tracker: { ...tr, stallSince: since } };
}

/** For players without a buffering event: stalled when the time moved under 0.25 s across a second of meant-to-be playing. */
export function stallDetector() {
  let last: { time: number; at: number } | undefined;
  let stalled = false;
  return (paused: boolean, time: number, now: number): boolean => {
    if (paused) {
      last = undefined;
      stalled = false;
      return false;
    }
    if (!last) {
      last = { time, at: now };
      return false;
    }
    if (now - last.at < 1000) return stalled;
    stalled = time - last.time < 0.25;
    last = { time, at: now };
    return stalled;
  };
}

/** The wait line: "Waiting for Anna, Bo…", or "Loading…" when the room waits only for me; "" when it waits for nobody. */
export function describeWaiting(waiting: readonly string[], meId: string | undefined, name: (id: string) => string): string {
  if (!waiting.length) return "";
  const others = waiting.filter((u) => u !== meId);
  return others.length ? `Waiting for ${others.map(name).join(", ")}…` : "Loading…";
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
