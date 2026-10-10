import { Perm, hasPerm, unwrap, type Library, type LibraryTrack, type MusicState, type RepeatMode } from "@datrope/core";
import { ListMusic, ListPlus, ListX, Pause, Play, Plus, Repeat, Repeat1, Shuffle, SkipForward, Square, Trash2, Upload, X } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSubmit } from "@/hooks/use-submit";
import { addedSummary, formatBytes, linkKind, type LinkKind } from "@/lib/music";
import { cn } from "@/lib/utils";
import { client, useApp, usePerms, userName } from "../../session";
import { useVoice } from "../../voice/voice";
import { setVolume, useVoicePrefs } from "../../voice/prefs";
import { ConfirmAction, Cover, SiteIcon } from "./MusicBits";
import { PlaylistsTab } from "./PlaylistsTab";

/** m:ss or h:mm:ss. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Where the current track is now: the server's position plus the time since it was sent, while playing. */
export function usePosition(state: MusicState | undefined): number {
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

const nextRepeat: Record<RepeatMode, RepeatMode> = { off: "all", all: "one", one: "off" };
const repeatHint: Record<RepeatMode, string> = {
  off: "Repeat is off", all: "Repeating the queue", one: "Repeating this song",
};

/** A voice channel's music bot: what plays and its controls, then the queue and the server's playlists. */
export function MusicPanel({ channelId }: { channelId: string }) {
  const state = useApp((s) => s.music[channelId]);
  const here = useVoice((v) => v.channelId === channelId && v.status === "connected");
  const [tab, setTab] = useState("queue");

  useEffect(() => {
    void client.loadMusic(channelId).catch(() => undefined);
  }, [channelId]);

  if (!state) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!state.enabled) {
    return <p className="p-4 text-sm text-muted-foreground">The music bot is not set up on this server. An admin needs voice and ffmpeg on the server.</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      {!here && <p role="note" className="m-0 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">Join the voice channel to add songs and control the music.</p>}
      <NowPlaying channelId={channelId} state={state} here={here} />
      <Tabs value={tab} onValueChange={setTab} className="gap-3">
        <TabsList className="w-full">
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="playlists">Playlists</TabsTrigger>
        </TabsList>
        <TabsContent value="queue" className="grid gap-4">
          <QueueTab channelId={channelId} state={state} here={here} onSaved={() => setTab("playlists")} />
        </TabsContent>
        <TabsContent value="playlists">
          <PlaylistsTab channelId={channelId} here={here} queueLength={state.queue?.length ?? 0} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function NowPlaying({ channelId, state, here }: { channelId: string; state: MusicState; here: boolean }) {
  const { busy, error, run } = useSubmit();
  const position = usePosition(state);
  const botVolume = useVoicePrefs((p) => (state.bot_id ? p.volume[state.bot_id] ?? 100 : 100));
  const act = (action: "pause" | "resume" | "skip" | "stop") => void run(() => client.controlMusic(channelId, action));
  const cur = state.current;
  return (
    <section aria-label="Now playing" className="grid gap-2 rounded-lg border bg-card p-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{cur ? (state.paused ? "Paused" : "Now playing") : "Nothing playing"}</span>
      {cur ? (
        <>
          <div className="flex min-w-0 items-center gap-3">
            <Cover src={cur.cover} className="size-12" />
            <div className="grid min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <SiteIcon site={cur.site} className="text-muted-foreground" />
                {cur.url ? <a href={cur.url} target="_blank" rel="noopener noreferrer" className="truncate font-semibold">{cur.title}</a>
                  : <span className="truncate font-semibold">{cur.title}</span>}
              </div>
              <span className="truncate text-xs text-muted-foreground">
                {cur.artist ? `${cur.artist} · ` : ""}Added by <Who userId={cur.requested_by} />
              </span>
            </div>
          </div>
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
      ) : <span className="text-sm text-muted-foreground">Add a song or play a playlist to start the music bot.</span>}
      <ErrorText error={error} />
    </section>
  );
}

/** Adding songs, the queue's own controls, and what comes next. */
function QueueTab({ channelId, state, here, onSaved }: { channelId: string; state: MusicState; here: boolean; onSaved: () => void }) {
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState(false);
  const [asked, setAsked] = useState<{ query: string; kind: Exclude<LinkKind, undefined> }>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const queryId = useId();
  const { busy, error, run } = useSubmit();
  const canCreate = hasPerm(usePerms(), Perm.AttachFiles);
  const queue = state.queue ?? [];
  const repeat: RepeatMode = state.repeat ?? "off";
  const bot = here && !!state.bot_id;

  const queueLink = (q: string, playlist: boolean) => run(async () => {
    const r = await client.queueMusic(channelId, { query: q, playlist });
    setNotice(addedSummary("Queued", { count: r.tracks?.length ?? 0, skipped: r.skipped, dropped: r.dropped }));
    setQuery("");
  });
  const submit = () => {
    const q = query.trim();
    const kind = linkKind(q);
    setNotice(undefined);
    if (kind) setAsked({ query: q, kind });
    else void queueLink(q, false);
  };

  return (
    <>
      <form className="grid gap-2" onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}>
        <label htmlFor={queryId} className="text-sm font-medium">Add a song</label>
        <div className="flex gap-2">
          <Input id={queryId} value={query} maxLength={300} disabled={!here || !state.youtube}
            placeholder={state.youtube ? "Link, playlist link or search" : "Links are not set up here"} onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit" disabled={!here || busy || !query.trim() || !state.youtube}>{busy ? "Adding…" : "Add"}</Button>
        </div>
        <Button variant="outline" size="sm" className="w-fit" onClick={() => setLibrary(true)}><ListMusic />Music library</Button>
      </form>
      <ErrorText error={error} />
      {notice && <p role="status" className="m-0 text-sm text-muted-foreground">{notice}</p>}

      <section aria-label="Queue" className="grid gap-1">
        <div className="flex items-center gap-1">
          <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Up next · {queue.length}</h3>
          <IconTip label="Shuffle queue">
            <Button variant="ghost" size="icon-sm" aria-label="Shuffle queue" disabled={!bot || busy || queue.length < 2}
              onClick={() => void run(() => client.controlMusic(channelId, "shuffle"))}><Shuffle /></Button>
          </IconTip>
          <IconTip label={repeatHint[repeat]}>
            <Toggle size="sm" aria-label={`Repeat: ${repeat}`} pressed={repeat !== "off"} disabled={!bot || busy}
              className="data-[state=on]:text-primary"
              onPressedChange={() => void run(() => client.setMusicRepeat(channelId, nextRepeat[repeat]))}>
              {repeat === "one" ? <Repeat1 /> : <Repeat />}
            </Toggle>
          </IconTip>
          {canCreate && (
            <IconTip label="Save queue as playlist">
              <Button variant="ghost" size="icon-sm" aria-label="Save queue as playlist" disabled={!state.current && queue.length === 0}
                onClick={() => setSaving(true)}><ListPlus /></Button>
            </IconTip>
          )}
          <IconTip label="Clear queue">
            <Button variant="ghost" size="icon-sm" aria-label="Clear queue" disabled={!bot || busy || queue.length === 0}
              onClick={() => setConfirmClear(true)}><ListX /></Button>
          </IconTip>
        </div>
        <ol className="grid list-none gap-1">
          {queue.map((t, i) => (
            <li key={t.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <span className="w-5 flex-none text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <Cover src={t.cover} className="size-8" />
              <span className="grid min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5"><SiteIcon site={t.site} className="text-muted-foreground" /><span className="truncate text-sm">{t.title}</span></span>
                <span className="truncate text-xs text-muted-foreground">
                  {t.artist ? `${t.artist} · ` : ""}<Who userId={t.requested_by} />{t.duration ? ` · ${clock(t.duration)}` : ""}
                </span>
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

      <ConfirmAction open={confirmClear} onOpenChange={setConfirmClear} title="Clear the queue?" action="Clear queue" destructive
        description={`This removes all ${queue.length} ${queue.length === 1 ? "track" : "tracks"} waiting to play. The current song keeps playing.`}
        onConfirm={() => void run(() => client.clearMusicQueue(channelId))} />
      {asked && (
        <PlaylistLinkDialog query={asked.query} kind={asked.kind} canSave={canCreate} onClose={() => setAsked(undefined)}
          onQueue={(all) => {
            setAsked(undefined);
            void queueLink(asked.query, all);
          }}
          onSaved={(message) => {
            setAsked(undefined);
            setQuery("");
            setNotice(message);
            onSaved();
          }} />
      )}
      {saving && <SaveQueueDialog channelId={channelId} onClose={() => setSaving(false)} onSaved={() => {
        setSaving(false);
        onSaved();
      }} />}
      {library && <LibraryDialog canAdd={here} onClose={() => setLibrary(false)}
        onAdd={async (t) => { await client.queueMusic(channelId, { track_id: t.id }); }} />}
    </>
  );
}

function IconTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="flex">{children}</span></TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A pasted playlist link: play the one song, queue all of it, or keep it as a saved playlist. */
function PlaylistLinkDialog({ query, kind, canSave, onClose, onQueue, onSaved }: {
  query: string;
  kind: Exclude<LinkKind, undefined>;
  canSave: boolean;
  onClose: () => void;
  onQueue: (all: boolean) => void;
  onSaved: (message: string) => void;
}) {
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{kind === "track-in-list" ? "This song is in a playlist" : "This is a playlist"}</DialogTitle>
          <DialogDescription>Queue its tracks now, or save them as one of the server's playlists to play again later.</DialogDescription>
        </DialogHeader>
        <ErrorText error={error} />
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {kind === "track-in-list" && <Button variant="outline" disabled={busy} onClick={() => onQueue(false)}>Play this song</Button>}
          <Button disabled={busy} onClick={() => onQueue(true)}>Queue the whole playlist</Button>
          {canSave && (
            <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
              const created = await client.createPlaylist({ from_url: query });
              onSaved(`Saved “${created.title}” with ${created.added} ${created.added === 1 ? "track" : "tracks"}.`);
            })}>{busy ? "Saving…" : "Save as playlist"}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Saves what plays and the queue as a new playlist. */
function SaveQueueDialog({ channelId, onClose, onSaved }: { channelId: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const titleId = useId();
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Save queue as playlist</DialogTitle>
          <DialogDescription>The song playing now and everything in the queue become a playlist anyone on the server can play.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const created = await client.createPlaylist({ title: title.trim() });
            await client.addToPlaylist(created.id, { from_channel: channelId });
            onSaved();
          });
        }}>
          <label htmlFor={titleId} className="text-sm font-medium">Playlist name</label>
          <Input id={titleId} value={title} maxLength={100} autoFocus onChange={(e) => setTitle(e.target.value)} />
          <ErrorText error={error} />
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim()}>{busy ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Someone's display name. */
export function Who({ userId }: { userId: string }) {
  return <>{useApp((s) => userName(s, userId))}</>;
}

/**
 * The server's uploaded tracks: add one (to the queue, or to a playlist), upload more, delete your own.
 * `onAdd` is what adding does; `addVerb` names it for the buttons.
 */
export function LibraryDialog({ canAdd, onAdd, onClose, addVerb = "Queue" }: {
  canAdd: boolean;
  onAdd: (t: LibraryTrack) => Promise<void>;
  onClose: () => void;
  addVerb?: "Queue" | "Add";
}) {
  const [lib, setLib] = useState<Library>();
  const [filter, setFilter] = useState("");
  const [added, setAdded] = useState<string>();
  const meId = useApp((s) => s.me?.id);
  const canManage = hasPerm(usePerms(), Perm.ManageExpressions);
  const canUpload = hasPerm(usePerms(), Perm.AttachFiles);
  const fileId = useId();
  const { busy, error, run } = useSubmit();
  const load = () => run(async () => setLib(await unwrap(client.api.GET("/api/server/music"))));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tracks = lib?.tracks ?? [];
  const shown = tracks.filter((t) => `${t.title} ${t.artist ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[80vh] overflow-hidden sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Music library</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Input aria-label="Filter tracks" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {canUpload && (
            <Button variant="outline" disabled={busy} onClick={() => document.getElementById(fileId)?.click()}><Upload />{busy ? "Working…" : "Upload"}</Button>
          )}
          <input id={fileId} type="file" hidden accept="audio/*" aria-label="Choose an audio file" onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void run(async () => {
              const t = await client.uploadMusic(f);
              setLib((l) => l && {
                ...l, used_bytes: l.used_bytes + t.size,
                tracks: [...(l.tracks ?? []), t].sort((a, b) => a.title.localeCompare(b.title)),
              });
            });
          }} />
        </div>
        <ul className="grid max-h-[50vh] list-none gap-1 overflow-y-auto" aria-label="Tracks">
          {shown.map((t) => (
            <li key={t.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <Cover src={t.cover} className="size-8" />
              <span className="grid min-w-0 flex-1">
                <span className="truncate">{t.title}</span>
                {t.artist && <span className="truncate text-xs text-muted-foreground">{t.artist}</span>}
              </span>
              {t.duration > 0 && <span className="text-xs tabular-nums text-muted-foreground">{clock(t.duration)}</span>}
              <Button size="icon-xs" variant="secondary" aria-label={`${addVerb} ${t.title}`} disabled={!canAdd || busy}
                onClick={() => void run(async () => {
                  await onAdd(t);
                  setAdded(`${addVerb === "Queue" ? "Queued" : "Added"} ${t.title}.`);
                })}>{addVerb === "Queue" ? <Play /> : <Plus />}</Button>
              {(canManage || t.uploaded_by === meId) && (
                <Button size="icon-xs" variant="ghost" aria-label={`Delete ${t.title}`} disabled={busy}
                  onClick={() => void run(async () => {
                    await unwrap(client.api.DELETE("/api/server/music/{trackID}", { params: { path: { trackID: t.id } } }));
                    setLib((l) => l && { ...l, used_bytes: l.used_bytes - t.size, tracks: (l.tracks ?? []).filter((x) => x.id !== t.id) });
                  })}><Trash2 /></Button>
              )}
            </li>
          ))}
          {lib && shown.length === 0 && (
            <li className={cn("px-2 text-sm text-muted-foreground")}>{tracks.length ? "No tracks match." : "No tracks yet. Upload MP3, Ogg, FLAC, WAV or M4A files up to 100 MB."}</li>
          )}
        </ul>
        {lib && (
          <div className="grid gap-1">
            <div className="h-1 overflow-hidden rounded-full bg-muted" role="meter" aria-label="Library space used"
              aria-valuemin={0} aria-valuemax={lib.limit_bytes} aria-valuenow={lib.used_bytes}>
              <div className="h-full bg-primary" style={{ width: `${Math.min(100, (lib.used_bytes / lib.limit_bytes) * 100)}%` }} />
            </div>
            <p className="m-0 text-xs text-muted-foreground">{formatBytes(lib.used_bytes)} of {formatBytes(lib.limit_bytes)} used</p>
          </div>
        )}
        {!canAdd && <p className="m-0 text-xs text-muted-foreground">{addVerb === "Queue" ? "Join the voice channel to queue tracks." : "You can't change this playlist."}</p>}
        {added && <p role="status" className="m-0 text-xs text-muted-foreground">{added}</p>}
        <ErrorText error={error} />
      </DialogContent>
    </Dialog>
  );
}
