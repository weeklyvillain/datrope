import { ApiError } from "@datrope/core";
import { DisconnectReason } from "livekit-client";

/** The call this tab was in, kept in sessionStorage so a reload (or a dropped connection) can join it again. */
export interface Resume {
  userId: string; // who was in the call: another account signing in to this tab must not rejoin it
  channelId: string;
  muted: boolean;
  deafened: boolean;
  at: number; // Date.now() when saved; refreshed as the page goes away, so a tab restored much later does not rejoin
}

const KEY = "voice.resume";
const MAX_AGE_MS = 120_000;

export function saveResume(s: Pick<Storage, "setItem">, r: Resume) {
  try {
    s.setItem(KEY, JSON.stringify(r));
  } catch {
    // Storage full or blocked: a reload just won't rejoin.
  }
}

export function loadResume(s: Pick<Storage, "getItem">, now = Date.now()): Resume | null {
  try {
    const v: unknown = JSON.parse(s.getItem(KEY) ?? "null");
    if (!v || typeof v !== "object") return null;
    const r = v as Resume;
    if (typeof r.userId !== "string" || typeof r.channelId !== "string") return null;
    if (typeof r.at !== "number" || now - r.at > MAX_AGE_MS) return null; // a closed tab restored later: no hot mic
    return { userId: r.userId, channelId: r.channelId, muted: r.muted === true, deafened: r.deafened === true, at: r.at };
  } catch {
    return null;
  }
}

export function clearResume(s: Pick<Storage, "removeItem">) {
  try {
    s.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

/**
 * What to do with a saved call as the session comes up. The gateway marks itself ready before READY sets `me`,
 * so wait for both; then rejoin only the same user's call.
 */
export function resumeDecision(s: { connection: string; me?: { id: string } | null }, r: Resume): "wait" | "join" | "drop" {
  if (s.connection !== "ready" || !s.me) return "wait";
  return s.me.id === r.userId ? "join" : "drop";
}

const DELAYS = [1000, 2000, 5000, 10000, 15000];
const GIVE_UP_MS = 120_000;

/** How long to wait before rejoin attempt `attempt` (1-based), or null once we have tried for two minutes. */
export function retryDelay(attempt: number, elapsedMs: number): number | null {
  if (elapsedMs >= GIVE_UP_MS) return null;
  return DELAYS[Math.min(attempt, DELAYS.length) - 1]!;
}

const FINAL = new Set<DisconnectReason>([
  DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason.DUPLICATE_IDENTITY, DisconnectReason.ROOM_DELETED,
  DisconnectReason.USER_REJECTED,
]);

/** A disconnect we must not undo by rejoining: kicked, joined elsewhere, channel gone. */
export const terminalReason = (reason: DisconnectReason | undefined) => reason !== undefined && FINAL.has(reason);

/** A join failure that retrying cannot fix: the server said no (no permission, channel gone, full). Timeouts and rate limits pass. */
export const terminalJoinError = (e: unknown) =>
  e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
