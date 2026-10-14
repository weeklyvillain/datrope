/** Zoom after a pinch, scaled by how far the fingers moved apart, clamped to [min, max]. */
export function pinchZoom(startZoom: number, startDist: number, dist: number, min = 1, max = 8): number {
  if (startDist <= 0) return startZoom;
  return Math.min(max, Math.max(min, startZoom * (dist / startDist)));
}

/** What a one-finger drag at fit zoom means: page left/right, or close on a downward swipe. */
export function swipeIntent(dx: number, dy: number): "prev" | "next" | "close" | null {
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "next" : "prev";
  if (dy > 100 && dy > Math.abs(dx)) return "close";
  return null;
}
