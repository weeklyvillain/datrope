import { SignalHigh, SignalLow, SignalMedium, SignalZero, type AnimatedIcon } from "@/components/icons";
import { RefButton } from "@/components/ref-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isTouchOnly } from "@/lib/touch";
import type { Rating } from "../../voice/stats";
import { useVoice } from "../../voice/voice";

const LOOK: Record<Rating, { icon: AnimatedIcon; color: string; word: string }> = {
  good: { icon: SignalHigh, color: "text-online hover:text-online", word: "good" },
  ok: { icon: SignalMedium, color: "text-idle hover:text-idle", word: "okay" },
  poor: { icon: SignalLow, color: "text-destructive hover:text-destructive", word: "poor" },
  unknown: { icon: SignalZero, color: "text-muted-foreground", word: "measuring" },
};

/** Signal bars for my connection to the voice server; the tooltip has the numbers. */
export function ConnectionQuality() {
  const q = useVoice((v) => v.quality);
  const look = LOOK[q.rating];
  const Icon = look.icon;
  const ping = q.rttMs === undefined ? "" : `, ${Math.round(q.rttMs)} ms ping`;
  const details = [
    q.rttMs !== undefined && `Ping ${Math.round(q.rttMs)} ms`,
    q.lossPct !== undefined && `Packet loss ${q.lossPct.toFixed(1)} %`,
    q.jitterMs !== undefined && `Jitter ${Math.round(q.jitterMs)} ms`,
  ].filter(Boolean).join(" · ");
  const button = (
    <RefButton variant="ghost" size="icon-sm" aria-label={`Connection quality: ${look.word}${ping}`} className={look.color}>
      <Icon />
    </RefButton>
  );
  if (isTouchOnly()) {
    return (
      <Popover>
        <PopoverTrigger asChild>{button}</PopoverTrigger>
        <PopoverContent className="w-auto p-3 text-sm">
          <p className="m-0">{details || "Measuring…"}</p>
          <p className="m-0 text-xs text-muted-foreground">Connection to the voice server</p>
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>
        <p>{details || "Measuring…"}</p>
        <p className="text-xs opacity-80">Connection to the voice server</p>
      </TooltipContent>
    </Tooltip>
  );
}
