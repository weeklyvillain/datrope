export type Box = { width?: number | null; height?: number | null };
export type Row = { start: number; end: number; height: number };

/** Width over height, 1 when unknown, kept between 0.5 and 3 so one panorama can't flatten a row. */
export function ratio(b: Box): number {
  if (!b.width || !b.height || b.width <= 0 || b.height <= 0) return 1;
  return Math.min(3, Math.max(0.5, b.width / b.height));
}

/** Packs boxes into rows `width` wide, about `target` px tall, each box keeping its aspect ratio.
 *  A row closes as soon as filling the width would make it no taller than target; full rows fill the
 *  width exactly; the last, unfinished row stays at target height. */
export function justify(boxes: Box[], width: number, target = 180, gap = 4): Row[] {
  const rows: Row[] = [];
  if (width <= 0) return rows;
  let start = 0;
  let sum = 0;
  for (let i = 0; i < boxes.length; i++) {
    sum += ratio(boxes[i]);
    const height = (width - (i - start) * gap) / sum;
    if (height <= target) {
      rows.push({ start, end: i + 1, height });
      start = i + 1;
      sum = 0;
    }
  }
  if (start < boxes.length) rows.push({ start, end: boxes.length, height: target });
  return rows;
}
