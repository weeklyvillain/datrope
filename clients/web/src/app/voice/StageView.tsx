import { EyeOff, Maximize, Volume2 } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { canFullscreen } from "@/lib/media-support";
import { cn } from "@/lib/utils";
import { useApp, userName } from "../../session";
import { setScreenVolume, useVoicePrefs } from "../../voice/prefs";
import { voice } from "../../voice/voice";
import { entryKey, type Entry } from "./GridView";
import { Tile, type TileSize } from "./Tile";

/** Whether `e` is a screen share of someone else that I'm watching. */
export const isWatchedScreen = (e: Entry, watching: string[]) =>
  e.tile?.source === "screen" && !e.tile.local && watching.includes(e.userId);

/** The shared video or the first watched screen share large, everyone else (and other watched shares) in a strip below. */
export function StageView({ entries, speaking, watching, chip, bot, watch, compact }: {
  entries: Entry[];
  speaking: string[];
  watching: string[];
  chip?: (e: Entry) => ReactNode;
  bot?: (size: TileSize) => ReactNode; // the music bot's tile, while it is in the call
  watch?: (size: TileSize) => ReactNode; // the shared video, while one is on: it takes the stage
  compact?: boolean;
}) {
  const main = watch ? undefined : entries.find((e) => isWatchedScreen(e, watching));
  const rest = entries.filter((e) => e !== main);
  const ref = useRef<HTMLDivElement>(null);
  if (!main && !watch) return null;
  const fullscreen = () => {
    // Denied: nothing to do. Unsupported (iPhone Safari): no button.
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else ref.current?.requestFullscreen?.()?.catch(() => {});
  };
  return (
    <div className={cn("grid gap-3", compact ? "h-[40vh] min-h-56 grid-rows-[minmax(0,1fr)_5rem]" : "h-full min-h-96 grid-rows-[minmax(0,1fr)_8rem]")}>
      {main ? (
        <Tile key={entryKey(main)} userId={main.userId} tile={main.tile} size="large" watching rootRef={ref} chip={chip?.(main)}>
          <div className="absolute right-2.5 top-2.5 flex gap-1.5">
            {canFullscreen() && <Button variant="secondary" size="icon-sm" aria-label="Full screen" onClick={fullscreen}><Maximize /></Button>}
            <Button variant="secondary" size="sm" onClick={() => voice.watch(main.userId, false)}><EyeOff /> Stop watching</Button>
          </div>
          <ScreenAudio userId={main.userId} />
        </Tile>
      ) : watch?.("large")}
      <div className="flex min-h-0 gap-3 overflow-x-auto py-1">
        {rest.map((e) => (
          <Tile key={entryKey(e)} userId={e.userId} tile={e.tile} size="strip" speaking={speaking.includes(e.userId)}
            watching={watching.includes(e.userId)} chip={chip?.(e)} />
        ))}
        {bot?.("strip")}
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
      <Slider min={0} max={200} step={5} value={[volume]} aria-label={`Volume of ${name}'s screen audio`}
            onValueChange={([x]) => setScreenVolume(userId, x)} className="w-24" />
    </div>
  );
}
