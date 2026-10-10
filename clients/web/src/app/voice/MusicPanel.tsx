import { Perm, hasPerm, unwrap, type LibraryTrack, type MusicState } from "@datrope/core";
import { ListMusic, Pause, Play, SkipForward, Square, Trash2, Upload, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { useSubmit } from "@/hooks/use-submit";
import { BrandIcon } from "@/lib/brand-icons";
import { cn } from "@/lib/utils";
import { client, useApp, usePerms, userName } from "../../session";
import { useVoice } from "../../voice/voice";
import { setVolume, useVoicePrefs } from "../../voice/prefs";

/** m:ss or h:mm:ss. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Where the current track is now: the server's position plus the time since it was sent, while playing. */
function usePosition(state: MusicState | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const [received, setReceived] = useState(() => Date.now());
  useEffect(() => {
    const t = Date.now(); // a new state from the server: count from now
    setReceived(t);
    setNow(t);
  }, [state]);
  const playing = !!state?.current && !state.paused;
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [playing]);
  if (!state?.current) return 0;
  const pos = state.position + (playing ? Math.max(0, now - received) / 1000 : 0);
  return state.current.duration ? Math.min(pos, state.current.duration) : pos;
}

/** A voice channel's music bot: what plays, the controls, the queue, and adding songs. */
export function MusicPanel({ channelId }: { channelId: string }) {
  const state = useApp((s) => s.music[channelId]);
  const here = useVoice((v) => v.channelId === channelId && v.status === "connected");
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState(false);
  const queryId = useId();
  const { busy, error, run } = useSubmit();
  const position = usePosition(state);
  const botVolume = useVoicePrefs((p) => (state?.bot_id ? p.volume[state.bot_id] ?? 100 : 100));

  useEffect(() => {
    void client.loadMusic(channelId).catch(() => undefined);
  }, [channelId]);

  if (!state) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!state.enabled) {
    return <p className="p-4 text-sm text-muted-foreground">The music bot is not set up on this server. An admin needs voice and ffmpeg on the server.</p>;
  }
  const act = (action: "pause" | "resume" | "skip" | "stop") => void run(() => client.controlMusic(channelId, action));
  const cur = state.current;
  const queue = state.queue ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      {!here && <p role="note" className="m-0 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">Join the voice channel to add songs and control the music.</p>}

      <section aria-label="Now playing" className="grid gap-2 rounded-lg border bg-card p-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{cur ? (state.paused ? "Paused" : "Now playing") : "Nothing playing"}</span>
        {cur ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {cur.source === "youtube" ? <BrandIcon slug="youtube" className="size-4 flex-none text-muted-foreground" /> : <ListMusic className="size-4 flex-none text-muted-foreground" aria-hidden />}
              {cur.url ? <a href={cur.url} target="_blank" rel="noopener noreferrer" className="truncate font-semibold">{cur.title}</a>
                : <span className="truncate font-semibold">{cur.title}</span>}
            </div>
            <span className="text-xs text-muted-foreground">Added by <Who userId={cur.requested_by} /></span>
            <div className="grid gap-1">
              <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Track progress"
                aria-valuemin={0} aria-valuemax={cur.duration || undefined} aria-valuenow={Math.floor(position)}>
                <div className="h-full bg-primary" style={{ width: cur.duration ? `${(position / cur.duration) * 100}%` : "0%" }} />
              </div>
              <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
                <span>{clock(position)}</span><span>{cur.duration ? clock(cur.duration) : "–:––"}</span>
              </div>
            </div>
            <div className="flex items-center gap-1" role="toolbar" aria-label="Music controls">
              {state.paused
                ? <Button size="icon-sm" aria-label="Resume" disabled={!here || busy} onClick={() => act("resume")}><Play /></Button>
                : <Button size="icon-sm" aria-label="Pause" disabled={!here || busy} onClick={() => act("pause")}><Pause /></Button>}
              <Button size="icon-sm" variant="outline" aria-label="Skip" disabled={!here || busy} onClick={() => act("skip")}><SkipForward /></Button>
              <Button size="icon-sm" variant="outline" aria-label="Stop and clear the queue" disabled={!here || busy} onClick={() => act("stop")}><Square /></Button>
              {state.bot_id && (
                <div className="ml-2 flex min-w-0 flex-1 items-center gap-2">
                  <Slider className="flex-1" min={0} max={200} step={5} value={[botVolume]} aria-label="Music volume, just for you"
                    onValueChange={([v]) => state.bot_id && setVolume(state.bot_id, v ?? 100)} />
                  <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{botVolume}%</span>
                </div>
              )}
            </div>
          </>
        ) : <span className="text-sm text-muted-foreground">Add a song below to start the music bot.</span>}
      </section>

      <form className="grid gap-2" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await client.queueMusic(channelId, { query: query.trim() });
          setQuery("");
        });
      }}>
        <label htmlFor={queryId} className="text-sm font-medium">Add a song</label>
        <div className="flex gap-2">
          <Input id={queryId} value={query} maxLength={300} disabled={!here || !state.youtube}
            placeholder={state.youtube ? "YouTube link or search" : "YouTube is not set up here"} onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit" disabled={!here || busy || !query.trim() || !state.youtube}>{busy ? "Adding…" : "Add"}</Button>
        </div>
        <Button variant="outline" size="sm" className="w-fit" onClick={() => setLibrary(true)}><ListMusic />Music library</Button>
      </form>
      <ErrorText error={error} />

      <section aria-label="Queue" className="grid gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Up next · {queue.length}</h3>
        <ol className="grid list-none gap-1">
          {queue.map((t, i) => (
            <li key={t.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <span className="w-5 flex-none text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-sm">{t.title}</span>
                <span className="truncate text-xs text-muted-foreground"><Who userId={t.requested_by} />{t.duration ? ` · ${clock(t.duration)}` : ""}</span>
              </span>
              {here && (
                <Button variant="ghost" size="icon-xs" aria-label={`Remove ${t.title} from the queue`} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                  onClick={() => void run(() => client.unqueueMusic(channelId, t.id))}><X /></Button>
              )}
            </li>
          ))}
          {queue.length === 0 && <li className="px-2 text-sm text-muted-foreground">The queue is empty.</li>}
        </ol>
      </section>
      {library && <LibraryDialog channelId={channelId} canQueue={here} onClose={() => setLibrary(false)} />}
    </div>
  );
}

/** Someone's display name. */
function Who({ userId }: { userId: string }) {
  return <>{useApp((s) => userName(s, userId))}</>;
}

/** The server's uploaded tracks: queue one, upload more, delete your own. */
function LibraryDialog({ channelId, canQueue, onClose }: { channelId: string; canQueue: boolean; onClose: () => void }) {
  const [tracks, setTracks] = useState<LibraryTrack[]>();
  const [filter, setFilter] = useState("");
  const meId = useApp((s) => s.me?.id);
  const canManage = hasPerm(usePerms(), Perm.ManageExpressions);
  const canUpload = hasPerm(usePerms(), Perm.AttachFiles);
  const fileId = useId();
  const { busy, error, run } = useSubmit();
  const load = () => run(async () => setTracks(await unwrap(client.api.GET("/api/server/music")) ?? []));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shown = (tracks ?? []).filter((t) => t.title.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[80vh] overflow-hidden sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Music library</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Input aria-label="Filter tracks" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {canUpload && (
            <Button variant="outline" disabled={busy} onClick={() => document.getElementById(fileId)?.click()}><Upload />Upload</Button>
          )}
          <input id={fileId} type="file" hidden accept="audio/*" aria-label="Choose an audio file" onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void run(async () => {
              const t = await client.uploadMusic(f);
              setTracks((l) => [...(l ?? []), t].sort((a, b) => a.title.localeCompare(b.title)));
            });
          }} />
        </div>
        <ul className="grid max-h-[50vh] list-none gap-1 overflow-y-auto" aria-label="Tracks">
          {shown.map((t) => (
            <li key={t.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {t.duration > 0 && <span className="text-xs tabular-nums text-muted-foreground">{clock(t.duration)}</span>}
              <Button size="icon-xs" variant="secondary" aria-label={`Queue ${t.title}`} disabled={!canQueue || busy}
                onClick={() => void run(async () => { await client.queueMusic(channelId, { track_id: t.id }); })}><Play /></Button>
              {(canManage || t.uploaded_by === meId) && (
                <Button size="icon-xs" variant="ghost" aria-label={`Delete ${t.title}`} disabled={busy}
                  onClick={() => void run(async () => {
                    await unwrap(client.api.DELETE("/api/server/music/{trackID}", { params: { path: { trackID: t.id } } }));
                    setTracks((l) => l?.filter((x) => x.id !== t.id));
                  })}><Trash2 /></Button>
              )}
            </li>
          ))}
          {tracks && shown.length === 0 && (
            <li className={cn("px-2 text-sm text-muted-foreground")}>{tracks.length ? "No tracks match." : "No tracks yet. Upload MP3, Ogg, FLAC, WAV or M4A files up to 30 MB."}</li>
          )}
        </ul>
        {!canQueue && <p className="m-0 text-xs text-muted-foreground">Join the voice channel to queue tracks.</p>}
        <ErrorText error={error} />
      </DialogContent>
    </Dialog>
  );
}
