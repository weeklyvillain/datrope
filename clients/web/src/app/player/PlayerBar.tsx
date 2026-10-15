import { Music, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Toggle } from "@/components/ui/toggle";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { formatDuration } from "../attachments/media";
import { audioEngine, useAudioEngine } from "./AudioEngine";
import { player, usePlayer } from "./player-store";
import { QueuePopover } from "./QueuePopover";

export const NEXT_REPEAT = { off: "all", all: "one", one: "off" } as const;

/** The gallery's own music player on desktop: a bar at the bottom while something is queued. Phones use the mini bar and
 *  the full-screen player; the audio itself plays in `AudioEngine`. */
export function PlayerBar() {
  const queue = usePlayer((s) => s.queue);
  const playing = usePlayer((s) => s.playing);
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);
  const volume = usePlayer((s) => s.volume);
  const notice = usePlayer((s) => s.notice);
  const time = useAudioEngine((s) => s.currentTime);
  const length = useAudioEngine((s) => s.duration);
  const mobile = useIsMobile();
  const current = queue.tracks[queue.index];

  if (!current || mobile) return null;
  return (
    <section aria-label="Music player" className="flex min-h-16 flex-none items-center gap-4 border-t bg-card px-4 pb-safe">
      <div className="flex w-64 min-w-0 items-center gap-2.5">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary text-foreground" aria-hidden><Music className="size-5" /></span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{current.title}</div>
          <div className="truncate text-xs text-muted-foreground">{notice ? <span role="status">{notice}</span> : current.subtitle}</div>
        </div>
      </div>
      <div className="grid flex-1 justify-items-center gap-1">
        <div className="flex items-center gap-1">
          <Toggle size="sm" aria-label="Shuffle" pressed={shuffle} onPressedChange={() => player.toggleShuffle()} className="data-[state=on]:text-primary"><Shuffle /></Toggle>
          <Button variant="ghost" size="icon-sm" aria-label="Previous track" onClick={() => audioEngine.previous()}><SkipBack className="fill-current" /></Button>
          <Button size="icon-sm" className="rounded-full" aria-label={playing ? "Pause" : "Play"} onClick={() => player.toggle()}>
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next track" onClick={() => player.next()}><SkipForward className="fill-current" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Repeat: ${repeat}`} className={cn(repeat !== "off" && "text-primary")}
            onClick={() => player.setRepeat(NEXT_REPEAT[repeat])}>{repeat === "one" ? <Repeat1 /> : <Repeat />}</Button>
        </div>
        <div className="flex w-full max-w-xl items-center gap-2 text-xs text-muted-foreground tabular-nums">
          <span>{formatDuration(time)}</span>
          <Slider className="flex-1" min={0} max={Math.max(length, 1)} step={1} value={[time]} aria-label="Seek"
            onValueChange={([v]) => audioEngine.seek(v)} />
          <span>{formatDuration(length)}</span>
        </div>
      </div>
      <div className="flex w-64 items-center justify-end gap-2">
        <QueuePopover />
        <Volume2 className="size-4 text-muted-foreground" aria-hidden />
        <Slider className="w-24" min={0} max={1} step={0.05} value={[volume]} aria-label="Volume" onValueChange={([v]) => player.setVolume(v)} />
        <Button variant="ghost" size="icon-sm" aria-label="Close player" onClick={() => player.clear()}><X /></Button>
      </div>
    </section>
  );
}
