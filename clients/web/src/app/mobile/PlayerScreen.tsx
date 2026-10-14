import { ChevronDown, Music, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, X } from "lucide-react";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { Slider } from "@/components/ui/slider";
import { Toggle } from "@/components/ui/toggle";
import { useHistoryLayer } from "@/hooks/use-history-layer";
import { cn } from "@/lib/utils";
import { formatDuration } from "../attachments/media";
import { audioEngine, useAudioEngine } from "../player/AudioEngine";
import { NEXT_REPEAT } from "../player/PlayerBar";
import { player, usePlayer } from "../player/player-store";
import { TrackMenu } from "../player/QueuePopover";

const screen = createStore<{ open: boolean }>(() => ({ open: false }));
/** Opens the full-screen player (from the music mini bar). */
export const openPlayerScreen = () => screen.setState({ open: true });
const closePlayerScreen = () => screen.setState({ open: false });

const transport = "size-[48px] rounded-full [&_svg:not([class*='size-'])]:size-6";

/** The phone's full-screen music player, mounted once in the phone shell. A history layer: Back closes it. */
export function PlayerScreen() {
  const open = useStore(screen, (s) => s.open);
  const hasTrack = usePlayer((s) => s.queue.index >= 0);
  const shown = open && hasTrack;
  useHistoryLayer("player", shown, closePlayerScreen);
  useEffect(() => { if (open && !hasTrack) closePlayerScreen(); }, [open, hasTrack]); // the queue ran out or was cleared
  return (
    <Drawer open={shown} onOpenChange={(o) => !o && closePlayerScreen()}>
      <DrawerContent className="h-dvh px-safe pt-safe pb-safe data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:max-h-dvh data-[vaul-drawer-direction=bottom]:rounded-none data-[vaul-drawer-direction=bottom]:border-t-0">
        <DrawerTitle className="sr-only">Music player</DrawerTitle>
        <DrawerDescription className="sr-only">The playing track, its controls and the queue.</DrawerDescription>
        {shown && <Body />}
      </DrawerContent>
    </Drawer>
  );
}

function Body() {
  const queue = usePlayer((s) => s.queue);
  const playing = usePlayer((s) => s.playing);
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);
  const notice = usePlayer((s) => s.notice);
  const time = useAudioEngine((s) => s.currentTime);
  const length = useAudioEngine((s) => s.duration);
  const current = queue.tracks[queue.index];
  const upNext = queue.tracks.slice(queue.index + 1);
  if (!current) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between px-2 pt-1">
        <Button variant="ghost" size="icon" aria-label="Hide player" className="size-[44px]" onClick={closePlayerScreen}><ChevronDown /></Button>
        <Button variant="ghost" size="icon" aria-label="Close player" className="size-[44px]" onClick={() => player.clear()}><X /></Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-4">
        <div className="mx-auto mt-2 grid size-[192px] flex-none place-items-center overflow-hidden rounded-xl bg-secondary text-muted-foreground" aria-hidden>
          {current.cover ? <img src={current.cover} alt="" className="size-full object-cover" /> : <Music className="size-16" />}
        </div>
        <div className="mt-6 min-w-0 text-center">
          <h2 className="truncate text-lg font-semibold">{current.title}</h2>
          <p className="truncate text-sm text-muted-foreground">{notice ? <span role="status">{notice}</span> : current.subtitle}</p>
        </div>
        <div className="mt-5 grid gap-1.5" data-vaul-no-drag>
          <Slider min={0} max={Math.max(length, 1)} step={1} value={[time]} aria-label="Seek" className="py-3"
            onValueChange={([v]) => audioEngine.seek(v)} />
          <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>{formatDuration(time)}</span>
            <span>{formatDuration(length)}</span>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <Toggle aria-label="Shuffle" pressed={shuffle} onPressedChange={() => player.toggleShuffle()} className={cn(transport, "data-[state=on]:text-primary")}><Shuffle /></Toggle>
          <Button variant="ghost" size="icon" aria-label="Previous track" className={transport} onClick={() => audioEngine.previous()}><SkipBack className="fill-current" /></Button>
          <Button size="icon" aria-label={playing ? "Pause" : "Play"} className={transport} onClick={() => player.toggle()}>
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Next track" className={transport} onClick={() => player.next()}><SkipForward className="fill-current" /></Button>
          <Button variant="ghost" size="icon" aria-label={`Repeat: ${repeat}`} className={cn(transport, repeat !== "off" && "text-primary")}
            onClick={() => player.setRepeat(NEXT_REPEAT[repeat])}>{repeat === "one" ? <Repeat1 /> : <Repeat />}</Button>
        </div>
        <section aria-label="Queue" className="mt-6">
          <h3 className="m-0 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Up next · {upNext.length}</h3>
          <ol className="m-0 grid list-none gap-0.5 p-0">
            {upNext.map((t, i) => (
              <li key={t.key} className="flex min-h-[48px] items-center gap-2 rounded-md">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body">{t.title}</span>
                  {t.subtitle && <span className="block truncate text-xs text-muted-foreground">{t.subtitle}</span>}
                </span>
                <TrackMenu track={t} index={queue.index + 1 + i} first={i === 0} last={i === upNext.length - 1} className="size-[44px]" />
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
