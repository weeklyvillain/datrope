import { EyeOff, Maximize, Volume2 } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useApp, userName } from "../../session";
import { setScreenVolume, useVoicePrefs } from "../../voice/prefs";
import { voice } from "../../voice/voice";
import { entryKey, type Entry } from "./GridView";
import { Tile } from "./Tile";

/** Whether `e` is a screen share of someone else that I'm watching. */
export const isWatchedScreen = (e: Entry, watching: string[]) =>
  e.tile?.source === "screen" && !e.tile.local && watching.includes(e.userId);

/** The first watched screen share large, everyone else (and other watched shares) in a strip below. */
export function StageView({ entries, speaking, watching, chip, compact }: {
  entries: Entry[];
  speaking: string[];
  watching: string[];
  chip?: (e: Entry) => ReactNode;
  compact?: boolean;
}) {
  const main = entries.find((e) => isWatchedScreen(e, watching));
  const rest = entries.filter((e) => e !== main);
  const ref = useRef<HTMLDivElement>(null);
  if (!main) return null;
  const fullscreen = () => {
    // Denied or unsupported (e.g. iOS): nothing to do.
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else ref.current?.requestFullscreen?.()?.catch(() => {});
  };
  return (
    <div className={cn("grid gap-3", compact ? "h-[40vh] min-h-56 grid-rows-[minmax(0,1fr)_5rem]" : "h-[70vh] min-h-96 grid-rows-[minmax(0,1fr)_8rem]")}>
      <Tile key={entryKey(main)} userId={main.userId} tile={main.tile} size="large" watching rootRef={ref} chip={chip?.(main)}>
        <div className="absolute right-2.5 top-2.5 flex gap-1.5">
          <Button variant="secondary" size="icon-sm" aria-label="Full screen" onClick={fullscreen}><Maximize /></Button>
          <Button variant="secondary" size="sm" onClick={() => voice.watch(main.userId, false)}><EyeOff /> Stop watching</Button>
        </div>
        <ScreenAudio userId={main.userId} />
      </Tile>
      <div className="flex min-h-0 gap-3 overflow-x-auto py-1">
        {rest.map((e) => (
          <Tile key={entryKey(e)} userId={e.userId} tile={e.tile} size="strip" speaking={speaking.includes(e.userId)}
            watching={watching.includes(e.userId)} chip={chip?.(e)} />
        ))}
      </div>
    </div>
  );
}

function ScreenAudio({ userId }: { userId: string }) {
  const name = useApp((s) => userName(s, userId));
  const volume = useVoicePrefs((p) => p.screenVolume[userId] ?? 100);
  return (
    <div className="absolute bottom-2.5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-background/80 px-2.5 py-1 text-xs text-muted-foreground">
      <Volume2 className="size-3.5" aria-hidden /> Screen audio
      <input type="range" min={0} max={200} step={5} value={volume} aria-label={`Volume of ${name}'s screen audio`}
        onChange={(e) => setScreenVolume(userId, Number(e.target.value))}
        className={cn(
          "h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-muted accent-primary",
          "[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary",
          "[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary",
        )} />
    </div>
  );
}
