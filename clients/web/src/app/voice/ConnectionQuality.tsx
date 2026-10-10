import { SignalHigh, SignalLow, SignalMedium, SignalZero, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Rating } from "../../voice/stats";
import { useVoice } from "../../voice/voice";

const LOOK: Record<Rating, { icon: LucideIcon; color: string; word: string }> = {
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Connection quality: ${look.word}${ping}`} className={look.color}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{details || "Measuring…"}</p>
        <p className="text-xs opacity-80">Connection to the voice server</p>
      </TooltipContent>
    </Tooltip>
  );
}
