import { Track, type Room } from "livekit-client";

export type Rating = "good" | "ok" | "poor" | "unknown";
export type Sample = { rttMs?: number; lossPct?: number; jitterMs?: number };
export type Quality = Sample & { rating: Rating };
/** One entry of an RTCStatsReport. */
export type Stat = { type: string; id: string; [k: string]: unknown };
/** packetsLost / packetsReceived per inbound-rtp ID, from the previous poll. */
export type Counters = Map<string, { lost: number; received: number }>;

export const UNKNOWN: Quality = { rating: "unknown" };

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isAudio = (s: Stat) => s.kind === "audio" || s.mediaType === "audio";
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : undefined);

/**
 * One measurement from WebRTC stats: the round trip to the voice server, plus loss and jitter of my audio as the
 * server reports it (while I send) or of the audio I receive (otherwise; loss is counted since the last poll).
 */
export function readSample(stats: Stat[], prev: Counters): { sample: Sample; counters: Counters } {
  const sample: Sample = {};
  const counters: Counters = new Map();
  const pair = stats.find((s) => s.type === "candidate-pair" && (s.nominated === true || s.selected === true)
    && s.state === "succeeded" && num(s.currentRoundTripTime));
  if (pair) sample.rttMs = (pair.currentRoundTripTime as number) * 1000;

  const remote = stats.filter((s) => s.type === "remote-inbound-rtp" && isAudio(s));
  if (remote.length) {
    const lost = max(remote.map((s) => s.fractionLost).filter(num));
    const jitter = max(remote.map((s) => s.jitter).filter(num));
    const rtt = max(remote.map((s) => s.roundTripTime).filter(num));
    if (lost !== undefined) sample.lossPct = lost * 100;
    if (jitter !== undefined) sample.jitterMs = jitter * 1000;
    if (sample.rttMs === undefined && rtt !== undefined) sample.rttMs = rtt * 1000;
    return { sample, counters };
  }

  let lost = 0;
  let received = 0;
  const jitters: number[] = [];
  for (const s of stats) {
    if (s.type !== "inbound-rtp" || !isAudio(s) || !num(s.packetsLost) || !num(s.packetsReceived)) continue;
    counters.set(s.id, { lost: s.packetsLost, received: s.packetsReceived });
    if (num(s.jitter)) jitters.push(s.jitter);
    const before = prev.get(s.id);
    if (!before) continue;
    lost += Math.max(0, s.packetsLost - before.lost);
    received += Math.max(0, s.packetsReceived - before.received);
  }
  if (lost + received > 0) sample.lossPct = (lost / (lost + received)) * 100;
  const jitter = max(jitters);
  if (jitter !== undefined) sample.jitterMs = jitter * 1000;
  return { sample, counters };
}

// [good below, ok below]; anything higher is poor.
export const LIMITS: Record<keyof Sample, [number, number]> = { rttMs: [100, 250], lossPct: [1, 5], jitterMs: [20, 50] };
const RATINGS = ["good", "ok", "poor"] as const;
export const HISTORY = 30; // samples kept for the connection panel (one per second)

/** One metric against LIMITS. */
export function metricRating(key: keyof Sample, v: number): "good" | "ok" | "poor" {
  const [good, ok] = LIMITS[key];
  return v < good ? "good" : v < ok ? "ok" : "poor";
}

/** `history` plus `s`, cut to the last HISTORY samples (a new array: it goes into the store). */
export const pushHistory = <T,>(history: T[], s: T): T[] => [...history, s].slice(-HISTORY);

/** Rates the connection from the last three samples (averaged, so one spike doesn't flip it); the worst metric wins. */
export function rate(samples: Sample[]): Quality {
  const recent = samples.slice(-3);
  const q: Quality = { rating: "unknown" };
  let worst = -1;
  for (const key of Object.keys(LIMITS) as (keyof Sample)[]) {
    const values = recent.map((s) => s[key]).filter(num);
    if (!values.length) continue;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    q[key] = avg;
    const [good, ok] = LIMITS[key];
    worst = Math.max(worst, avg < good ? 0 : avg < ok ? 1 : 2);
  }
  if (worst >= 0) q.rating = RATINGS[worst];
  return q;
}

/**
 * Measures my connection to the voice server every `everyMs` while in a call, and keeps the last HISTORY samples.
 * Returns a function that stops.
 */
export function watchQuality(room: Room, onQuality: (q: Quality, history: Sample[]) => void, everyMs = 1000): () => void {
  let stopped = false;
  let prev: Counters = new Map();
  let all: Sample[] = [];
  const poll = async () => {
    const tracks: Track[] = [];
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (mic) tracks.push(mic);
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) if (pub.track) tracks.push(pub.track);
    }
    const reports = await Promise.all(tracks.map((t) => t.getRTCStatsReport().catch(() => undefined)));
    if (stopped) return;
    const stats = reports.flatMap((r) => (r ? ([...r.values()] as Stat[]) : []));
    const { sample, counters } = readSample(stats, prev);
    prev = counters;
    all = pushHistory(all, sample);
    onQuality(rate(all.slice(-3)), all);
  };
  const tick = () => void poll().catch(() => undefined); // stats are best effort: never an error in the UI
  const timer = setInterval(tick, everyMs);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
