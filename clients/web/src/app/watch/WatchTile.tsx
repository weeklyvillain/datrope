import { ArrowLeftRight, Pause, Play, Square, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/utils";
import { client, useApp, userName } from "../../session";
import { useVoice } from "../../voice/voice";
import type { TileSize } from "../voice/Tile";
import { describeAction, expectedPosition, formatTime } from "./sync";
import { useWatchSync } from "./use-watch-sync";
import { readVolume, saveVolume } from "./volume";
import { WatchDialog } from "./WatchDialog";

const box: Record<TileSize, string> = {
  large: "size-full min-h-0",
  strip: "h-full aspect-video shrink-0",
  grid: "aspect-video",
};

const TOAST_MS = 3000;

/** Re-renders every second while `on`, for the time display. */
function useTicker(on: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [on]);
}

/** The call's shared video: the embedded player under our own controls, in step with everyone in the call. */
export function WatchTile({ channelId, size }: { channelId: string; size: TileSize }) {
  const host = useRef<HTMLDivElement>(null);
  const here = useVoice((v) => v.channelId === channelId && v.status === "connected");
  const { st, player, error, blocked, unblock } = useWatchSync(channelId, host, here);
  const meId = useApp((s) => s.me?.id);
  const offset = useApp((s) => s.serverOffset);
  const actor = useApp((s) => (st ? userName(s, st.last_actor) : ""));
  const [vol, setVol] = useState(readVolume);
  const [changing, setChanging] = useState(false);
  const [scrub, setScrub] = useState<number>(); // while the position slider is dragged
  const [toast, setToast] = useState<string>();
  const { busy, error: actError, run } = useSubmit();
  useTicker(!!st && !st.paused);

  // Someone else's action, said for a few seconds. A late title does not change updated_at, so it does not re-toast.
  const note = st && st.last_actor !== meId ? describeAction(st, actor) : undefined;
  const stamp = st?.updated_at;
  useEffect(() => {
    if (!note) return;
    setToast(note);
    const t = window.setTimeout(() => setToast(undefined), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [note, stamp]);

  useEffect(() => {
    player?.setVolume(vol.volume);
    player?.setMuted(vol.muted);
    saveVolume(vol);
  }, [player, vol]);

  if (!st) return null;
  const live = st.kind === "twitch_live";
  const strip = size === "strip";
  const dur = player?.duration() ?? 0;
  const pos = Math.min(expectedPosition(st, Date.now(), offset), dur || Infinity);
  const act = (fn: () => Promise<void>) => void run(fn);
  const toggle = () => act(() => (st.paused ? client.watchPlay(channelId) : client.watchPause(channelId)));

  return (
    <section aria-label="Watch together" className={cn("group relative overflow-hidden rounded-xl border bg-sidebar", box[size])}>
      <div ref={host} className="absolute inset-0 [&>*]:size-full [&_iframe]:size-full" />
      {/* Covers the embed: its own controls would change playback for me alone. */}
      <div className="absolute inset-0" aria-hidden />
      <div className="absolute left-2.5 top-2.5 flex max-w-[70%] items-center gap-1.5">
        {live && <Badge variant="destructive">LIVE</Badge>}
        {!strip && <span className="truncate rounded-md bg-background/80 px-2 py-0.5 text-xs text-foreground">{st.title || st.url}</span>}
      </div>
      {/* Always mounted so screen readers announce the text changes. */}
      <p role="status" className={cn(
        !toast || strip ? "sr-only" : "absolute right-2.5 top-2.5 rounded-md border bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-md",
      )}>{strip ? "" : toast}</p>
      {!here && (
        <div className="absolute inset-0 grid place-content-center justify-items-center gap-2 bg-sidebar p-4 text-center">
          {live && <Badge variant="destructive">LIVE</Badge>}
          <p className="max-w-full truncate text-sm font-medium text-foreground">{st.title || st.url}</p>
          <p className="text-xs text-muted-foreground">Join the call to watch together.</p>
        </div>
      )}
      {blocked && (
        <Button variant="ghost" onClick={unblock} className="absolute inset-0 h-auto rounded-none bg-background/70 text-foreground hover:bg-background/60">
          <Play className="size-5" aria-hidden />Click to sync
        </Button>
      )}
      {error && (
        <div role="alert" className="absolute inset-0 grid place-content-center justify-items-center gap-2 bg-background/90 p-4 text-center text-sm">
          <p>{error}</p>
          {here && <Button size="sm" variant="outline" onClick={() => setChanging(true)}>Change video</Button>}
        </div>
      )}
      {strip ? (
        <Button size="icon-sm" className="absolute bottom-1.5 left-1.5" aria-label={st.paused ? "Play" : "Pause"} disabled={!here || busy} onClick={toggle}>
          {st.paused ? <Play /> : <Pause />}
        </Button>
      ) : (
        <div role="toolbar" aria-label="Watch controls" className={cn(
          "absolute inset-x-0 bottom-0 grid gap-2 bg-gradient-to-t from-background/95 to-transparent px-3 pb-2.5 pt-8 transition-opacity",
          st.paused ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
        )}>
          {!live && dur > 0 && (
            <Slider aria-label="Position" min={0} max={dur} step={1} value={[scrub ?? pos]} disabled={!here}
              onValueChange={([v = 0]) => setScrub(v)}
              onValueCommit={([v = 0]) => {
                setScrub(undefined);
                act(() => client.watchSeek(channelId, v));
              }} />
          )}
          <div className="flex items-center gap-2">
            <Button size="icon-sm" aria-label={st.paused ? "Play" : "Pause"} disabled={!here || busy} onClick={toggle}>
              {st.paused ? <Play /> : <Pause />}
            </Button>
            {live
              ? <span className="text-xs font-semibold text-destructive">LIVE</span>
              : <span className="text-xs tabular-nums text-muted-foreground">{formatTime(scrub ?? pos)}{dur > 0 && ` / ${formatTime(dur)}`}</span>}
            {st.paused && st.last_action === "pause" && <span className="truncate text-xs text-muted-foreground">Paused by {actor}</span>}
            <span className="flex-1" />
            <Button size="icon-sm" variant="ghost" aria-label={vol.muted ? "Unmute video" : "Mute video"}
              onClick={() => setVol((v) => ({ ...v, muted: !v.muted }))}>
              {vol.muted ? <VolumeX /> : <Volume2 />}
            </Button>
            <Slider aria-label="Video volume" className="w-20" min={0} max={100} step={5} value={[vol.muted ? 0 : vol.volume]}
              onValueChange={([v = 0]) => setVol({ volume: v, muted: false })} />
            <Button size="sm" variant="outline" disabled={!here} onClick={() => setChanging(true)}><ArrowLeftRight />Change</Button>
            <Button size="sm" variant="outline" disabled={!here || busy} onClick={() => act(() => client.stopWatch(channelId))}><Square />Stop</Button>
          </div>
          <ErrorText error={actError} />
        </div>
      )}
      {changing && <WatchDialog channelId={channelId} initialUrl={st.url} onClose={() => setChanging(false)} />}
    </section>
  );
}
