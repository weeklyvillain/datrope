import type { PlaylistDetail } from "@datrope/core";
import { ArrowLeft, Play, Shuffle, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSubmit } from "@/hooks/use-submit";
import { addedSummary, totalLength, trackCount } from "@/lib/music";
import { cn } from "@/lib/utils";
import { useVoice } from "../../voice/voice";
import { client, errorText, useApp } from "../../session";
import { player } from "../player/player-store";
import { Cover } from "../voice/MusicBits";
import { clock } from "../voice/MusicPanel";
import { playableTracks } from "./playlist-tracks";

/** One playlist: play it in your own player, or queue it on the bot in the voice channel you're in. */
export function PlaylistDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const summary = useApp((s) => s.playlists?.[id]);
  const channels = useApp((s) => s.channels);
  const voiceId = useVoice((v) => (v.status === "connected" ? v.channelId : undefined));
  const voiceName = useApp((s) => (voiceId ? s.channels[voiceId]?.name : undefined));
  const [detail, setDetail] = useState<PlaylistDetail>();
  const [error, setError] = useState<string>();
  const send = useSubmit();
  const [notice, setNotice] = useState<string>();

  // Reload when the playlist changes (MUSIC_PLAYLIST_UPDATE keeps the summary current).
  useEffect(() => {
    let live = true;
    setError(undefined);
    client.playlist(id).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [id, summary]);

  if (error) return <ErrorText error={error} />;
  if (!detail) return <p className="m-0 p-8 text-center text-sm text-muted-foreground">Loading…</p>;
  const name = (cid?: string) => (cid ? channels[cid]?.name : undefined);
  const tracks = playableTracks(detail.items ?? [], name);
  const inVoice = () => void send.run(async () => {
    setNotice(undefined);
    const r = await client.queueMusic(voiceId!, { playlist_id: id });
    setNotice(addedSummary("Queued", { count: r.tracks?.length ?? 0, skipped: r.skipped, dropped: r.dropped, unreadable: r.skipped_unreadable }));
  });
  const voiceButton = (
    <Button size="sm" variant="outline" disabled={!voiceId || send.busy} onClick={inVoice}>
      <Volume2 />{voiceId ? `Play in voice · ${voiceName ?? "voice"}` : "Play in voice"}
    </Button>
  );

  return (
    <section aria-label={detail.title} className="grid gap-4">
      <div className="flex items-end gap-4">
        <Cover src={detail.cover} className="size-28 flex-none" />
        <div className="grid min-w-0 gap-1">
          <Button variant="ghost" size="sm" className="w-fit px-1 text-muted-foreground" onClick={onBack}><ArrowLeft />Playlists</Button>
          <h3 className="m-0 truncate text-2xl font-bold normal-case tracking-normal text-foreground">{detail.title}</h3>
          <p className="m-0 text-sm text-muted-foreground">
            {trackCount(detail.count)}{detail.duration ? ` · ${totalLength(detail.duration)}` : ""}
            {detail.hidden > 0 && ` · ${detail.hidden} ${detail.hidden === 1 ? "track" : "tracks"} hidden`}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" disabled={!tracks.length} onClick={() => player.play(tracks)}><Play className="fill-current" />Play</Button>
            <Button size="sm" variant="outline" disabled={!tracks.length} onClick={() => player.play(tracks, 0, true)}><Shuffle />Shuffle</Button>
            {voiceId ? voiceButton : (
              <Tooltip><TooltipTrigger asChild><span tabIndex={0}>{voiceButton}</span></TooltipTrigger><TooltipContent>Join a voice channel first</TooltipContent></Tooltip>
            )}
          </div>
          {!voiceId && <p className="m-0 text-xs text-muted-foreground pointer-fine:hidden">Join a voice channel first</p>}
          {notice && <p role="status" className="m-0 text-sm text-muted-foreground">{notice}</p>}
          <ErrorText error={send.error} />
        </div>
      </div>
      <Table aria-label="Tracks">
        <TableHeader><TableRow><TableHead className="w-10">#</TableHead><TableHead>Title</TableHead><TableHead>From</TableHead><TableHead className="text-right">Length</TableHead></TableRow></TableHeader>
        <TableBody>
          {(detail.items ?? []).map((it, i) => {
            const voiceOnly = it.source === "link";
            return (
              <TableRow key={it.id} className={cn(voiceOnly && "opacity-50")}>
                <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                <TableCell>{it.title}{it.artist && <span className="text-xs text-muted-foreground"> · {it.artist}</span>}</TableCell>
                <TableCell><span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {voiceOnly ? "Voice only" : it.source === "upload" ? "Library" : `#${name(it.channel_id ?? undefined) ?? "channel"}`}
                </span></TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{it.duration ? clock(it.duration) : ""}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
