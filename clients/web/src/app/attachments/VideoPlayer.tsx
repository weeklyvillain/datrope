import type { Attachment } from "@datrope/core";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Download, Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { client } from "../../session";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { formatDuration } from "./media";

const RATES = [1, 1.25, 1.5, 2, 0.5];
const IDLE_MS = 2000;

/** Plays a video attachment with its own controls, which fade out while it plays and the pointer rests. */
export function VideoPlayer({ attachment: a }: { attachment: Attachment }) {
  const src = client.url(a.url);
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const idle = useRef<ReturnType<typeof setTimeout>>();
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => { document.removeEventListener("fullscreenchange", onChange); clearTimeout(idle.current); };
  }, []);

  // Follow playback smoothly; timeupdate alone fires only a few times a second.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      if (video.current) setTime(video.current.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  /** Shows the controls, hiding them again once the pointer has rested a while. */
  function wake() {
    setActive(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => setActive(false), IDLE_MS);
  }

  function toggle() {
    const v = video.current;
    if (v) void (v.paused ? v.play() : v.pause());
  }

  function seek(to: number) {
    const v = video.current;
    if (!v || !duration) return;
    v.currentTime = Math.min(duration, Math.max(0, to));
    setTime(v.currentTime);
  }

  function setLevel(level: number) {
    const v = video.current;
    if (!v) return;
    v.volume = level;
    v.muted = level === 0;
  }

  function toggleMute() {
    const v = video.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 1;
  }

  function cycleRate() {
    const v = video.current;
    if (v) v.playbackRate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // the controls handle their own keys
    if (e.key === " " || e.key === "k") toggle();
    else if (e.key === "ArrowLeft") seek(time - 5);
    else if (e.key === "ArrowRight") seek(time + 5);
    else if (e.key === "m") toggleMute();
    else if (e.key === "f") toggleFullscreen();
    else return;
    e.preventDefault();
    wake();
  }

  const shown = !playing || active;
  const level = muted ? 0 : volume;
  return (
    <div ref={box} tabIndex={0} role="group" aria-label={`Video ${a.filename}`}
      className={cn("group/video relative overflow-hidden bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring",
        fullscreen ? "flex h-full w-full items-center justify-center" : "w-[400px] max-w-full rounded-lg border",
        !shown && "cursor-none")}
      onKeyDown={onKeyDown} onPointerMove={wake} onPointerLeave={() => setActive(false)}>
      <video ref={video} src={src} preload="metadata" playsInline
        className={cn("block w-full object-contain", fullscreen ? "h-full" : "aspect-video")}
        onClick={toggle} onDoubleClick={toggleFullscreen}
        onPlay={() => { setPlaying(true); setStarted(true); wake(); }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => { const d = e.currentTarget.duration; setDuration(Number.isFinite(d) ? d : 0); }}
        onVolumeChange={(e) => { setVolume(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
        onRateChange={(e) => setRate(e.currentTarget.playbackRate)} />

      {!playing && (
        <Button aria-label="Play video" onClick={toggle}
          className={cn("absolute top-1/2 left-1/2 size-14 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-lg transition-transform hover:scale-105 [&_svg:not([class*='size-'])]:size-6",
            started && "opacity-80")}>
          <Play className="translate-x-px fill-current" />
        </Button>
      )}

      <div className={cn("absolute inset-x-0 top-0 truncate bg-linear-to-b from-background/80 to-transparent px-3 pt-2 pb-6 text-sm font-medium transition-opacity",
        shown ? "opacity-100" : "pointer-events-none opacity-0")}>
        {a.filename}
      </div>

      <div className={cn("absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-linear-to-t from-background/90 to-transparent px-3 pt-8 pb-1.5 transition-opacity",
        shown ? "opacity-100" : "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100")}>
        <Slider aria-label="Seek" min={0} max={duration || 1} step={Math.max(0.1, duration / 100)} value={[time]} disabled={!duration}
          onValueChange={([t]) => seek(t)} className="[&_[data-slot=slider-thumb]]:size-3" />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (k)" : "Play (k)"} onClick={toggle}>
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </Button>
          <div className="group/volume flex items-center">
            <Button variant="ghost" size="icon-sm" aria-label={level === 0 ? "Unmute" : "Mute"} title="Mute (m)" onClick={toggleMute}>
              {level === 0 ? <VolumeX /> : <Volume2 />}
            </Button>
            <Slider aria-label="Volume" min={0} max={1} step={0.05} value={[level]} onValueChange={([v]) => setLevel(v)}
              className="w-0 opacity-0 transition-all group-focus-within/volume:mr-2 group-focus-within/volume:w-16 group-focus-within/volume:opacity-100 group-hover/volume:mr-2 group-hover/volume:w-16 group-hover/volume:opacity-100 [&_[data-slot=slider-thumb]]:size-3" />
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(time)} / {formatDuration(duration)}</span>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" className="h-8 w-11 px-0 text-xs tabular-nums" aria-label={`Playback speed ${rate}x`} title="Playback speed" onClick={cycleRate}>
            {rate}×
          </Button>
          <Button asChild variant="ghost" size="icon-sm" className="text-foreground">
            <a href={src} download={a.filename} aria-label={`Download ${a.filename}`} title="Download"><Download /></a>
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={fullscreen ? "Exit full screen" : "Full screen"} title="Full screen (f)" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize /> : <Maximize />}
          </Button>
        </div>
      </div>
    </div>
  );
}
