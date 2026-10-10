const GAP = 12; // FitGrid's gap-3
const MIN_WIDTH = 160;

/** The widest 16:9 tile that fits `n` tiles into `w` × `h`, over every column count; never narrower than MIN_WIDTH (then it scrolls). */
export function fitWidth(n: number, w: number, h: number) {
  let best = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    best = Math.max(best, Math.min((w - GAP * (cols - 1)) / cols, ((h - GAP * (rows - 1)) / rows) * 16 / 9));
  }
  return Math.max(Math.floor(best), Math.min(MIN_WIDTH, w));
}
