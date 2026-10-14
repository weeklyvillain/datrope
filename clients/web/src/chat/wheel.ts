// /wheel: picks one of the given options and posts it as plain text, which WheelCard
// recognises and animates. Clients that don't (search, previews) still read the text.
import type { CommandResult } from "./commands";

const PREFIX = "🎡 Spun the wheel: ";
const ARROW = " → ";
const USAGE = "Usage: /wheel <option, option, …>";
const MIN = 2;
const MAX = 20;
const MAX_OPTION = 50;

// Characters that Markdown or remarkChat would turn into formatting, escaped so the text shows as typed.
const escape = (s: string) => s.replace(/[\\`*_~|[\]<>]/g, "\\$&");
const unescape = (s: string) => s.replace(/\\([\\`*_~|[\]<>])/g, "$1");

/** Splits on commas and new lines. `rand(max)` returns an integer in [0, max). */
export function wheel(args: string, rand: (max: number) => number): CommandResult {
  const options = args.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (options.length < MIN) return { error: USAGE };
  if (options.length > MAX) return { error: `A wheel takes ${MIN}–${MAX} options` };
  if (options.some((o) => o.length > MAX_OPTION)) return { error: `Each option can be at most ${MAX_OPTION} characters` };
  if (options.some((o) => o.includes("→"))) return { error: "Options can't contain →" };
  const shown = options.map(escape);
  return { send: `${PREFIX}${shown.join(", ")}${ARROW}**${shown[rand(options.length)]}**` };
}

export type Wheel = { options: string[]; winner: number };

/** The wheel in a message's content, or null when the content is anything but exactly what /wheel sends. */
export function parseWheel(content: string): Wheel | null {
  if (!content.startsWith(PREFIX) || !content.endsWith("**")) return null;
  const body = content.slice(PREFIX.length, -2);
  const at = body.indexOf(`${ARROW}**`);
  if (at < 0) return null;
  const raw = body.slice(0, at).split(", ");
  const rawWinner = body.slice(at + ARROW.length + 2);
  if (raw.length < MIN || raw.length > MAX || raw.some((o) => !o.trim())) return null;
  const winner = raw.indexOf(rawWinner);
  if (winner < 0) return null;
  return { options: raw.map(unescape), winner };
}

// Reel geometry in rem, matching WheelCard's tiles (w-32, gap-2).
const TILE = 8;
const STEP = TILE + 0.5;
const LEAD = 30; // at least this many tiles race past before the winner

export type ReelLayout = { tiles: number[]; winnerTile: number; start: number; end: number };

/** The reel's tiles (option indexes) and where the marker sits at the start and end, in rem from the strip's left.
 * `jitter` in [0, 1) moves the stop point inside the winning tile so it doesn't always land dead centre. */
export function reelLayout(wheel: Wheel, jitter: number): ReelLayout {
  const n = wheel.options.length;
  const winnerTile = Math.ceil(LEAD / n) * n + wheel.winner;
  const tiles = Array.from({ length: winnerTile + 4 }, (_, i) => i % n);
  const centre = (i: number) => i * STEP + TILE / 2;
  return { tiles, winnerTile, start: centre(2), end: centre(winnerTile) + (jitter - 0.5) * TILE * 0.7 };
}
