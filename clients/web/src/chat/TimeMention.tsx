import { Clock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClockPref } from "@/lib/clock-pref";
import { clockTime } from "@/lib/message-time";
import { dayShift } from "@/lib/time-mention";

/** A time someone wrote, shown in my zone and clock; the tooltip shows what they wrote and in which zone. */
export function TimeMention({ iso, src, zone, written }: { iso: string; src: string; zone?: string; written?: boolean }) {
  const pref = useClockPref();
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || zone === mine) return <span className="time-mention">{src}</span>; // my own zone: nothing to convert
  const shift = dayShift(iso, zone, mine);
  const label = `${clockTime(new Date(iso), undefined, pref)}${shift > 0 ? " +1d" : shift < 0 ? " −1d" : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={iso} tabIndex={0} aria-label={`${label} your time (${written ? src : `${src} ${zone}`})`}
          className="time-mention inline-flex items-baseline gap-0.5 rounded bg-accent px-1 font-medium text-foreground">
          <Clock aria-hidden className="size-3 self-center text-muted-foreground" />
          {label}
        </time>
      </TooltipTrigger>
      <TooltipContent>{written ? src : `${src} in ${zone}`}</TooltipContent>
    </Tooltip>
  );
}
