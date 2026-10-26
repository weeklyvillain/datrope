import type { Attachment } from "@datrope/core";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Download, Pause, Play, Volume1, Volume2, VolumeX } from "@/components/icons";
import { client, formatBytes } from "../../session";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { formatDuration } from "./media";
import { BARS, MAX_WAVEFORM_BYTES, loadWaveform } from "./waveform";

/** Shown until the waveform is decoded, or instead of it for files too large to decode. */
const FLAT = new Array<number>(BARS).fill(0.15);

/** Plays an audio attachment over its waveform; click or drag the waveform to seek. */
export function AudioPlayer({ attachment: a }: { attachment: Attachment }) {
  const src = client.url(a.url);
  const audio = useRef<HTMLAudioElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const [bars, setBars] = useState<number[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // Decode the waveform once the player scrolls into view.
  useEffect(() => {
    const el = wave.current;
    if (!el || a.size > MAX_WAVEFORM_BYTES) return;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      loadWaveform(src).then((p) => { if (!cancelled) setBars(p); }, () => {});
    });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [src, a.size]);

  // Follow playback smoothly; timeupdate alone fires only a few times a second.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      if (audio.current) setTime(audio.current.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    if (!audio.current) return;
    audio.current.volume = volume;
    audio.current.muted = muted;
  }, [volume, muted]);

  function seek(to: number) {
    const el = audio.current;
    if (!el || !duration) return;
    el.currentTime = Math.min(duration, Math.max(0, to));
    setTime(el.currentTime);
  }

  function seekToPointer(e: PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * duration);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[e.key];
    if (step !== undefined) seek(time + step);
    else if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(duration);
    else return;
    e.preventDefault();
  }

  const progress = duration ? time / duration : 0;
  const silent = muted || volume === 0;
  const VolumeIcon = silent ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className="flex w-[400px] max-w-full flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium" title={a.filename}>{a.filename}</span>
        <span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
        <Button asChild variant="ghost" size="icon-xs" className="text-muted-foreground">
          <a href={src} download={a.filename} aria-label={`Download ${a.filename}`} title="Download"><Download /></a>
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <Button size="icon-sm" className="shrink-0 rounded-full" aria-label={playing ? "Pause" : "Play"}
          onClick={() => { const el = audio.current; if (el) void (el.paused ? el.play() : el.pause()); }}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <div ref={wave} role="slider" tabIndex={0} aria-label={`Seek ${a.filename}`}
          aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}
          aria-valuetext={`${formatDuration(time)} of ${formatDuration(duration)}`}
          className="flex h-10 min-w-0 flex-1 cursor-pointer touch-none items-center gap-px rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onKeyDown={onKeyDown}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekToPointer(e); }}
          onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seekToPointer(e); }}>
          {(bars ?? FLAT).map((v, i) => (
            <span key={i} style={{ height: `${Math.max(8, v * 100)}%` }}
              className={cn("flex-1 rounded-full transition-colors", (i + 0.5) / BARS <= progress ? "bg-primary" : "bg-muted-foreground/40")} />
          ))}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatDuration(time)} / {formatDuration(duration)}
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <RefButton variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" aria-label="Volume"><VolumeIcon /></RefButton>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="flex w-56 items-center gap-2 p-2">
            <Button variant="ghost" size="icon-xs" aria-label={silent ? "Unmute" : "Mute"}
              onClick={() => { if (silent) { setMuted(false); if (volume === 0) setVolume(1); } else setMuted(true); }}>
              <VolumeIcon />
            </Button>
            <Slider className="flex-1" min={0} max={1} step={0.05} value={[muted ? 0 : volume]} aria-label={`Volume of ${a.filename}`}
              onValueChange={([v]) => { setVolume(v ?? 1); setMuted(false); }} />
            <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{Math.round((muted ? 0 : volume) * 100)}%</span>
          </PopoverContent>
        </Popover>
      </div>
      <audio ref={audio} src={src} preload="metadata"
        onDurationChange={(e) => { const d = e.currentTarget.duration; setDuration(Number.isFinite(d) ? d : 0); }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={(e) => { setPlaying(false); setTime(e.currentTarget.duration); }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
    </div>
  );
}
