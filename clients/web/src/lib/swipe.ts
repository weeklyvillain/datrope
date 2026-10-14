export function createSwipe(o: { threshold?: number; lock?: number; max?: number } = {}) {
  const threshold = o.threshold ?? 64, lock = o.lock ?? 10, max = o.max ?? 96;
  let x0 = 0, y0 = 0, axis: "x" | "y" | null = null, dx = 0;
  return {
    down(x: number, y: number) { x0 = x; y0 = y; axis = null; dx = 0; },
    move(x: number, y: number) {
      const ddx = x - x0, ddy = y - y0;
      if (!axis && Math.max(Math.abs(ddx), Math.abs(ddy)) >= lock) axis = Math.abs(ddx) > Math.abs(ddy) ? "x" : "y";
      dx = axis === "x" ? Math.min(max, Math.max(0, ddx)) : 0;
      return { dx, axis };
    },
    up() { const hit = axis === "x" && dx >= threshold; axis = null; dx = 0; return hit; },
  };
}
