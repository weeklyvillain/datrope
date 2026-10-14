/** How much of the layout viewport the on-screen keyboard covers, in px. */
export function keyboardInset(innerHeight: number, vv: { height: number; offsetTop: number } | null): number {
  if (!vv) return 0;
  return Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
}
