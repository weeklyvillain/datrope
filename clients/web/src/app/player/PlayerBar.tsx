import { Music, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Toggle } from "@/components/ui/toggle";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { formatDuration } from "../attachments/media";
import { player, usePlayer } from "./player-store";
import { QueuePopover } from "./QueuePopover";

const NEXT_REPEAT = { off: "all", all: "one", one: "off" } as const;

/** The gallery's own music player: one audio element for the whole app, a bar at the bottom while something is queued. */
export function PlayerBar() {
  const queue = usePlayer((s) => s.queue);
  const playing = usePlayer((s) => s.playing);
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);
  const volume = usePlayer((s) => s.volume);
  const notice = usePlayer((s) => s.notice);
  const seq = usePlayer((s) => s.seq);
  const audio = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const mobile = useIsMobile();
  const current = queue.tracks[queue.index];

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    if (playing) el.play().catch(() => undefined);
    else el.pause();
  }, [playing, current?.key]);
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume]);
  // A replayed track (repeat one, a lone track on repeat all, Previous at the top) leaves the queue unchanged, so restart on `seq`.
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = 0;
    el.play().catch(() => undefined);
  }, [seq]);

  // OS media keys and the now-playing card.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!current) { navigator.mediaSession.metadata = null; return; }
    navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: current.subtitle });
    navigator.mediaSession.setActionHandler("play", () => player.setPlaying(true));
    navigator.mediaSession.setActionHandler("pause", () => player.setPlaying(false));
    navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
    navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
  }, [current]);

  if (!current) return null;
  const prev = () => (audio.current && audio.current.currentTime > 3 ? (audio.current.currentTime = 0) : player.prev());
  return (
    <section aria-label="Music player" className="flex h-16 flex-none items-center gap-4 border-t bg-card px-4">
      <audio ref={audio} src={current.src} preload="auto"
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onDurationChange={(e) => setLength(e.currentTarget.duration)}
        onPlaying={() => player.started()} onEnded={() => player.ended()} onError={() => player.failed()} />
      <div className={cn("flex min-w-0 items-center gap-2.5", mobile ? "flex-1" : "w-64")}>
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary text-foreground" aria-hidden><Music className="size-5" /></span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{current.title}</div>
          <div className="truncate text-xs text-muted-foreground">{notice ? <span role="status">{notice}</span> : current.subtitle}</div>
        </div>
      </div>
      <div className={cn("grid flex-1 justify-items-center gap-1", mobile && "flex-none")}>
        <div className="flex items-center gap-1">
          {!mobile && <Toggle size="sm" aria-label="Shuffle" pressed={shuffle} onPressedChange={() => player.toggleShuffle()} className="data-[state=on]:text-primary"><Shuffle /></Toggle>}
          {!mobile && <Button variant="ghost" size="icon-sm" aria-label="Previous track" onClick={prev}><SkipBack className="fill-current" /></Button>}
          <Button size="icon-sm" className="rounded-full" aria-label={playing ? "Pause" : "Play"} onClick={() => player.toggle()}>
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next track" onClick={() => player.next()}><SkipForward className="fill-current" /></Button>
          {!mobile && (
            <Button variant="ghost" size="icon-sm" aria-label={`Repeat: ${repeat}`} className={cn(repeat !== "off" && "text-primary")}
              onClick={() => player.setRepeat(NEXT_REPEAT[repeat])}>{repeat === "one" ? <Repeat1 /> : <Repeat />}</Button>
          )}
        </div>
        {!mobile && (
          <div className="flex w-full max-w-xl items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <span>{formatDuration(time)}</span>
            <Slider className="flex-1" min={0} max={Math.max(length, 1)} step={1} value={[time]} aria-label="Seek"
              onValueChange={([v]) => { if (audio.current) audio.current.currentTime = v; }} />
            <span>{formatDuration(length)}</span>
          </div>
        )}
      </div>
      {!mobile && (
        <div className="flex w-64 items-center justify-end gap-2">
          <QueuePopover />
          <Volume2 className="size-4 text-muted-foreground" aria-hidden />
          <Slider className="w-24" min={0} max={1} step={0.05} value={[volume]} aria-label="Volume" onValueChange={([v]) => player.setVolume(v)} />
          <Button variant="ghost" size="icon-sm" aria-label="Close player" onClick={() => player.clear()}><X /></Button>
        </div>
      )}
    </section>
  );
}
