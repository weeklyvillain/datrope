import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

type ByUser = Record<string, { rttMs: number; at: number }>;
const FRESH_MS = 15_000;

/** The others' pings in my call (VOICE_PING), by user ID. */
export const pingStore = createStore<{ byUser: ByUser }>(() => ({ byUser: {} }));

export const applyPing = (byUser: ByUser, e: { user_id: string; rtt_ms: number }, now: number): ByUser =>
  ({ ...byUser, [e.user_id]: { rttMs: e.rtt_ms, at: now } });

export const freshPing = (byUser: ByUser, userId: string, now: number) => {
  const p = byUser[userId];
  return p && now - p.at <= FRESH_MS ? p.rttMs : undefined;
};

/** Their round trip to me through the voice server, roughly: theirs plus mine (the server's forwarding not counted). */
export const estimateToYou = (peer?: number, mine?: number) => (peer === undefined || mine === undefined ? undefined : Math.round(peer + mine));

export function usePeerPing(userId: string): number | undefined {
  return useStore(pingStore, (s) => freshPing(s.byUser, userId, Date.now()));
}

/** Shares my ping with the call every `everyMs` once it is measured. Returns a function that stops. */
export function startPingSender(getRtt: () => number | undefined, send: (ms: number) => Promise<void>, everyMs = 5000): () => void {
  const timer = setInterval(() => {
    const rtt = getRtt();
    if (rtt !== undefined) void send(Math.round(rtt)).catch(() => undefined);
  }, everyMs);
  return () => clearInterval(timer);
}
