/** Where an arrow/Home/End key moves focus in a list of `count` items, or null when the key doesn't move it. */
export function nextIndex(key: string, current: number, count: number,
  orientation: "vertical" | "horizontal" | "grid" = "vertical", columns = 1): number | null {
  if (count === 0) return null;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const v = orientation !== "horizontal", h = orientation !== "vertical";
  const row = orientation === "grid" ? columns : 1;
  if (v && key === "ArrowDown") return current + row < count ? current + row : current;
  if (v && key === "ArrowUp") return current - row >= 0 ? current - row : current;
  if (h && key === "ArrowRight") return clamp(current + 1);
  if (h && key === "ArrowLeft") return clamp(current - 1);
  return null;
}
