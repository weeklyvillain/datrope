import { cn } from "@/lib/utils";
import { HISTORY, metricRating, type Sample } from "../../voice/stats";

const TONE = { good: "bg-online", ok: "bg-idle", poor: "bg-destructive" } as const;
const SCALE: Record<keyof Sample, number> = { rttMs: 300, lossPct: 10, jitterMs: 60 };

/** One bar per second for the last 30 s, coloured by the metric's thresholds. Decorative: the figure beside it is the value. */
export function SignalBars({ values, metric, className }: { values: (number | undefined)[]; metric: keyof Sample; className?: string }) {
  const padded = [...Array(Math.max(0, HISTORY - values.length)).fill(undefined), ...values.slice(-HISTORY)];
  return (
    <div aria-hidden className={cn("flex h-7 items-end gap-px", className)}>
      {padded.map((v, i) => (
        <i key={i} className={cn("min-w-0 flex-1 rounded-[1px]", v === undefined ? "h-1 bg-muted" : TONE[metricRating(metric, v)])}
          style={v === undefined ? undefined : { height: `${Math.max(12, Math.min(1, v / SCALE[metric]) * 100)}%` }} />
      ))}
    </div>
  );
}
