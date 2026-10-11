import { sparklinePoints } from "@/lib/system";

const W = 120;
const H = 32;

/** A small line of the last ten minutes. Decorative: the figure next to it carries the value. */
export function Sparkline({ values, max }: { values: number[]; max: number }) {
  const points = sparklinePoints(values, max, W, H);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-full text-primary" preserveAspectRatio="none" aria-hidden>
      {points && <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
