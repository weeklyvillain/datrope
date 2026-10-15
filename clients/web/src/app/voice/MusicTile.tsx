import { ListMusic, Music, Pause, Play, Repeat, Repeat1, SkipForward } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/utils";
import { client, useApp } from "../../session";
import { useVoice } from "../../voice/voice";
import { clock, usePosition } from "./MusicPanel";
import type { TileSize } from "./Tile";
import { sizedImage } from "@/lib/sized-image";

const box: Record<TileSize, string> = {
  large: "size-full min-h-0",
  strip: "h-full aspect-video shrink-0",
  grid: "aspect-video",
};

/** The music bot's tile in the call while it is in the channel: what plays, play/pause and skip, and the queue. */
export function MusicTile({ channelId, size, speaking = false, onOpen }: {
  channelId: string;
  size: TileSize;
  speaking?: boolean;
  onOpen?: () => void; // opens the music panel (queue, adding songs)
}) {
  const state = useApp((s) => s.music[channelId]);
  const here = useVoice((v) => v.channelId === channelId && v.status === "connected");
  const position = usePosition(state);
  const { busy, run } = useSubmit();
  if (!state?.bot_id) return null;
  const cur = state.current;
  const strip = size === "strip";
  const act = (action: "pause" | "resume" | "skip") => void run(() => client.controlMusic(channelId, action));

  return (
    <section aria-label="Music bot" className={cn(
      "relative grid place-items-center overflow-hidden rounded-xl border bg-card",
      box[size],
      speaking && "border-transparent ring-3 ring-primary",
    )}>
      {cur?.cover && ( // the cover, blurred and dimmed behind everything
        <>
          <img {...sizedImage(cur.cover, 80)} alt="" className="absolute inset-0 size-full scale-110 object-cover blur-xl" />
          <span className="absolute inset-0 bg-card/80" aria-hidden />
        </>
      )}
      <div className={cn("relative grid w-full justify-items-center gap-2 px-4 text-center", strip && "gap-1 px-2")}>
        {cur?.cover ? (
          <img {...sizedImage(cur.cover, 80)} alt="" className={cn("rounded-md object-cover shadow-md", strip ? "size-8" : "size-20")} />
        ) : (
          <span className={cn("grid place-items-center rounded-full bg-primary text-primary-foreground", strip ? "size-8" : "size-16")}>
            <Music className={strip ? "size-4" : "size-7"} aria-hidden />
          </span>
        )}
        <div className="grid w-full">
          <p className={cn("w-full truncate font-semibold", strip ? "text-xs" : "text-sm")}>{cur ? cur.title : "Nothing playing"}</p>
          {cur?.artist && !strip && <p className="w-full truncate text-xs text-muted-foreground">{cur.artist}</p>}
          {cur && state.loading && (
            <p className={cn("flex w-full items-center justify-center gap-1.5 text-muted-foreground", strip ? "text-caption" : "text-xs")}>
              <Spinner className="size-3" aria-hidden />Loading…
            </p>
          )}
        </div>
        {cur && !strip && (
          <div className="grid w-full max-w-64 gap-1">
            <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Track progress"
              aria-valuemin={0} aria-valuemax={cur.duration || undefined} aria-valuenow={Math.floor(position)}>
              <div className="h-full bg-primary" style={{ width: cur.duration ? `${(position / cur.duration) * 100}%` : "0%" }} />
            </div>
            <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
              <span>{clock(position)}</span><span>{cur.duration ? clock(cur.duration) : "–:––"}</span>
            </div>
          </div>
        )}
        {!strip && (
          <div className="flex items-center gap-1" role="toolbar" aria-label="Music bot controls">
            {cur && (state.paused
              ? <Button size="icon-sm" aria-label="Resume" disabled={!here || busy} onClick={() => act("resume")}><Play /></Button>
              : <Button size="icon-sm" aria-label="Pause" disabled={!here || busy || state.loading} onClick={() => act("pause")}><Pause /></Button>)}
            {cur && <Button size="icon-sm" variant="outline" aria-label="Skip" disabled={!here || busy} onClick={() => act("skip")}><SkipForward /></Button>}
            {onOpen && <Button size="sm" variant="outline" onClick={onOpen}><ListMusic />Queue{state.queue?.length ? ` · ${state.queue.length}` : ""}</Button>}
          </div>
        )}
      </div>
      <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-background/80 px-2 py-0.5 text-xs">
        Music{cur && (state.loading ? " · loading" : state.paused ? " · paused" : "")}
        {state.repeat === "all" && <Repeat className="size-3" role="img" aria-label="Repeating the queue" />}
        {state.repeat === "one" && <Repeat1 className="size-3" role="img" aria-label="Repeating this song" />}
      </span>
    </section>
  );
}
