/** Whether the mic is open: by loudness (voice activity) or while a key is held (push to talk). No Web Audio here. */

export type GateSettings = { mode: "vad" | "ptt"; auto: boolean; thresholdDb: number };
export type GateInput = GateSettings & { levelDb: number; nowMs: number; pttDown: boolean };

export const VAD_HOLD_MS = 300; // keeps word endings
export const PTT_RELEASE_MS = 200;
const SILENCE_DB = -100;
const AUTO_MARGIN_DB = 15;
const AUTO_MIN_DB = -70;
const AUTO_MAX_DB = -20;
const FALL_MS = 50; // the noise floor follows quiet quickly...
const RISE_MS = 10_000; // ...and loud slowly, so speech doesn't drag it up

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function createGate() {
  let floor: number | undefined;
  let lastMs: number | undefined;
  let activeMs = -Infinity;

  const thresholdDb = (s: Pick<GateSettings, "auto" | "thresholdDb">) =>
    s.auto ? clamp((floor ?? SILENCE_DB) + AUTO_MARGIN_DB, AUTO_MIN_DB, AUTO_MAX_DB) : s.thresholdDb;

  return {
    /** Takes the latest level (dBFS) and returns whether the mic is open. */
    update(i: GateInput): boolean {
      const level = Number.isFinite(i.levelDb) ? Math.max(SILENCE_DB, i.levelDb) : SILENCE_DB;
      const dt = lastMs === undefined ? 0 : Math.max(0, i.nowMs - lastMs);
      lastMs = i.nowMs;
      if (floor === undefined) floor = level;
      else floor += (level - floor) * (1 - Math.exp(-dt / (level < floor ? FALL_MS : RISE_MS)));
      const active = i.mode === "ptt" ? i.pttDown : level >= thresholdDb(i);
      if (active) activeMs = i.nowMs;
      return i.nowMs - activeMs < (i.mode === "ptt" ? PTT_RELEASE_MS : VAD_HOLD_MS);
    },
    /** The threshold in use: the manual one, or the noise floor plus a margin. */
    thresholdDb,
  };
}
