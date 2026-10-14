import { Perm, hasPerm, type MusicPlaylist, type PlaylistDetail, type PlaylistItem } from "@datrope/core";
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, GripVertical, ListMusic, MoreHorizontal, Music, Play, Plus, Shuffle } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useSubmit } from "@/hooks/use-submit";
import { addedSummary, fileChannelLabel, hiddenNote, linkKind, totalLength, trackCount } from "@/lib/music";
import { cn } from "@/lib/utils";
import { client, useApp, usePerms } from "../../session";
import { ConfirmAction, Cover, SiteIcon } from "./MusicBits";
import { LibraryDialog, Who, clock } from "./MusicPanel";
import { ListSkeleton } from "@/components/loading-skeleton";
import { BareButton } from "@/components/bare-button";

/** May I change this playlist: I made it, or I manage expressions. */
function useCanEdit(pl?: MusicPlaylist) {
  const meId = useApp((s) => s.me?.id);
  const canManage = hasPerm(usePerms(), Perm.ManageExpressions);
  return !!pl && (canManage || pl.created_by === meId);
}

/** The server's saved playlists: play one, make one, open one to change it. */
export function PlaylistsTab({ channelId, here, queueLength }: { channelId: string; here: boolean; queueLength: number }) {
  const playlists = useApp((s) => s.playlists);
  const [open, setOpen] = useState<string>();
  const [creating, setCreating] = useState(false);
  const canCreate = hasPerm(usePerms(), Perm.AttachFiles);
  const { error, run } = useSubmit();

  useEffect(() => {
    void run(async () => { await client.loadPlaylists(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opened = open ? playlists?.[open] : undefined;
  if (opened) {
    return <PlaylistView playlist={opened} channelId={channelId} here={here} queueLength={queueLength} onBack={() => setOpen(undefined)} />;
  }
  const list = Object.values(playlists ?? {}).sort((a, b) => a.title.localeCompare(b.title));
  return (
    <section aria-label="Playlists" className="grid gap-2">
      {canCreate && <Button variant="outline" size="sm" className="w-fit" onClick={() => setCreating(true)}><Plus />New playlist</Button>}
      <ErrorText error={error} />
      {!playlists && !error && <ListSkeleton className="p-0" />}
      <ul className="grid list-none gap-1">
        {list.map((pl) => (
          <PlaylistRow key={pl.id} playlist={pl} channelId={channelId} here={here} queueLength={queueLength} onOpen={() => setOpen(pl.id)} />
        ))}
        {playlists && list.length === 0 && (
          <li className="px-2 text-sm text-muted-foreground">No playlists yet. Make one, or save the queue as one.</li>
        )}
      </ul>
      {creating && <NewPlaylistDialog onClose={() => setCreating(false)} onCreated={(id) => {
        setCreating(false);
        setOpen(id);
      }} />}
    </section>
  );
}

/** Play (append), shuffle play, and replace the queue, asking first when the queue has tracks. */
function usePlay(channelId: string, playlist: MusicPlaylist, queueLength: number) {
  const { busy, error, run } = useSubmit();
  const [notice, setNotice] = useState<string>();
  const [confirmReplace, setConfirmReplace] = useState(false);
  const play = (opts: { shuffle?: boolean; replace?: boolean }) => void run(async () => {
    const r = await client.queueMusic(channelId, { playlist_id: playlist.id, ...opts });
    setNotice(addedSummary("Queued", { count: r.tracks?.length ?? 0, skipped: r.skipped, dropped: r.dropped, unreadable: r.skipped_unreadable }));
  });
  const replace = () => (queueLength > 0 ? setConfirmReplace(true) : play({ replace: true }));
  const confirm = (
    <ConfirmAction open={confirmReplace} onOpenChange={setConfirmReplace} title="Replace the queue?" action="Replace queue"
      description={`The ${trackCount(queueLength)} waiting to play are removed and “${playlist.title}” takes their place. The current song keeps playing.`}
      onConfirm={() => play({ replace: true })} />
  );
  return { busy, error, notice, play, replace, confirm };
}

function PlaylistRow({ playlist, channelId, here, queueLength, onOpen }: {
  playlist: MusicPlaylist;
  channelId: string;
  here: boolean;
  queueLength: number;
  onOpen: () => void;
}) {
  const canEdit = useCanEdit(playlist);
  const { busy, error, notice, play, replace, confirm } = usePlay(channelId, playlist, queueLength);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const del = useSubmit();
  const canPlay = here && playlist.count > 0 && !busy;
  return (
    <li className="grid gap-1">
      <div className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent">
        <BareButton onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left" aria-label={`Open ${playlist.title}`}>
          <Cover src={playlist.cover} />
          <span className="grid min-w-0">
            <span className="truncate text-sm font-medium">{playlist.title}</span>
            <span className="truncate text-xs text-muted-foreground">{trackCount(playlist.count)}{playlist.duration ? ` · ${totalLength(playlist.duration)}` : ""}</span>
          </span>
        </BareButton>
        <Button size="icon-sm" aria-label={`Play ${playlist.title}`} disabled={!canPlay} onClick={() => play({})}><Play /></Button>
        <Button size="icon-sm" variant="outline" aria-label={`Shuffle play ${playlist.title}`} disabled={!canPlay} onClick={() => play({ shuffle: true })}><Shuffle /></Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RefButton size="icon-sm" variant="ghost" aria-label={`More for ${playlist.title}`}><MoreHorizontal /></RefButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!canPlay} onSelect={replace}>Replace queue</DropdownMenuItem>
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>Delete</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {notice && <p role="status" className="m-0 px-2 text-xs text-muted-foreground">{notice}</p>}
      <ErrorText error={error ?? del.error} />
      {confirm}
      {renaming && <RenameDialog playlist={playlist} onClose={() => setRenaming(false)} />}
      <ConfirmAction open={deleting} onOpenChange={setDeleting} title={`Delete ${playlist.title}?`} action="Delete" destructive
        description="The playlist is removed for everyone on the server. The songs in the music library stay."
        onConfirm={() => void del.run(() => client.deletePlaylist(playlist.id))} />
    </li>
  );
}

/** One playlist: its tracks in order, which its editors can add to, reorder and remove from. */
function PlaylistView({ playlist, channelId, here, queueLength, onBack }: {
  playlist: MusicPlaylist;
  channelId: string;
  here: boolean;
  queueLength: number;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<PlaylistDetail>();
  const [items, setItems] = useState<PlaylistItem[]>([]);
  const canEdit = useCanEdit(playlist);
  const youtube = useApp((s) => !!s.music[channelId]?.youtube);
  const channels = useApp((s) => s.channels);
  const { error, run } = useSubmit();
  const { busy, error: playError, notice, play, replace, confirm } = usePlay(channelId, playlist, queueLength);
  const reload = () => run(async () => {
    const d = await client.playlist(playlist.id);
    setDetail(d);
    setItems(d.items ?? []);
  });
  // The store's summary changes on every edit (an event): load the tracks again then.
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const item = items[from];
    setItems((l) => arrayMove(l, from, to));
    void run(async () => {
      try {
        await client.movePlaylistItem(playlist.id, item.id, to);
      } catch (e) {
        await reload();
        throw e;
      }
    });
  };
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    move(items.findIndex((x) => x.id === e.active.id), items.findIndex((x) => x.id === e.over?.id));
  };
  const canPlay = here && playlist.count > 0 && !busy;

  return (
    <section aria-label={playlist.title} className="grid gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="Back to playlists" onClick={onBack}><ArrowLeft /></Button>
        <Cover src={playlist.cover} />
        <span className="grid min-w-0 flex-1">
          <h3 className="truncate text-sm normal-case tracking-normal text-foreground">{playlist.title}</h3>
          <span className="truncate text-xs text-muted-foreground">
            {trackCount(playlist.count)}{playlist.duration ? ` · ${totalLength(playlist.duration)}` : ""}
            {playlist.created_by && <> · by <Who userId={playlist.created_by} /></>}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" aria-label={`Play ${playlist.title}`} disabled={!canPlay} onClick={() => play({})}><Play />Play</Button>
        <Button size="sm" variant="outline" aria-label={`Shuffle play ${playlist.title}`} disabled={!canPlay} onClick={() => play({ shuffle: true })}><Shuffle />Shuffle</Button>
        <Button size="sm" variant="outline" disabled={!canPlay} onClick={replace}>Replace queue</Button>
      </div>
      {!here && <p className="m-0 text-xs text-muted-foreground">Join the voice channel to play it.</p>}
      {notice && <p role="status" className="m-0 text-sm text-muted-foreground">{notice}</p>}
      <ErrorText error={playError} />
      {confirm}
      {hiddenNote(detail?.hidden ?? 0) && <p className="m-0 text-xs text-muted-foreground">{hiddenNote(detail?.hidden ?? 0)}</p>}
      {canEdit && <AddToPlaylist playlistId={playlist.id} youtube={youtube} />}
      <ErrorText error={error} />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((x) => x.id)} strategy={verticalListSortingStrategy}>
          <ol className="grid list-none gap-1" aria-label="Tracks">
            {items.map((it, i) => (
              <SortableItem key={it.id} item={it} channelName={it.channel_id ? channels[it.channel_id]?.name : undefined} index={i} last={i === items.length - 1} canEdit={canEdit}
                onMove={(to) => move(i, to)}
                onRemove={() => {
                  setItems((l) => l.filter((x) => x.id !== it.id));
                  void run(() => client.removePlaylistItem(playlist.id, it.id));
                }} />
            ))}
            {detail && items.length === 0 && <li className="px-2 text-sm text-muted-foreground">No tracks yet.</li>}
          </ol>
        </SortableContext>
      </DndContext>
    </section>
  );
}

function SortableItem({ item, channelName, index, last, canEdit, onMove, onRemove }: {
  item: PlaylistItem;
  channelName?: string;
  index: number;
  last: boolean;
  canEdit: boolean;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !canEdit });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("group flex items-center gap-2 rounded-md px-1 py-1.5 hover:bg-accent", isDragging && "relative z-10 bg-accent opacity-80")}>
      {canEdit ? (
        <BareButton ref={setActivatorNodeRef} {...listeners} {...attributes} aria-label={`Move ${item.title}`}
          className="flex-none cursor-grab touch-none rounded-sm text-muted-foreground opacity-60 group-hover:opacity-100 focus-visible:opacity-100">
          <GripVertical className="size-4" aria-hidden />
        </BareButton>
      ) : <span className="w-4 flex-none text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>}
      <Cover src={item.cover} className="size-8" />
      <span className="grid min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">{item.source === "file" ? <Music className="size-3.5 flex-none text-muted-foreground" aria-hidden /> : <SiteIcon site={item.site} className="text-muted-foreground" />}<span className="truncate text-sm">{item.title}</span></span>
        <span className="truncate text-xs text-muted-foreground">{[item.source === "file" ? fileChannelLabel(channelName) : item.artist, item.duration ? clock(item.duration) : ""].filter(Boolean).join(" · ")}</span>
      </span>
      {canEdit && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RefButton size="icon-xs" variant="ghost" aria-label={`Options for ${item.title}`}
              className="opacity-0 pointer-coarse:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"><MoreHorizontal /></RefButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(index - 1)}>Move up</DropdownMenuItem>
            <DropdownMenuItem disabled={last} onSelect={() => onMove(index + 1)}>Move down</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>Remove from playlist</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/** Adds a link, a search result, a whole playlist link, or a library track. */
function AddToPlaylist({ playlistId, youtube }: { playlistId: string; youtube: boolean }) {
  const [query, setQuery] = useState("");
  const [whole, setWhole] = useState(true);
  const [library, setLibrary] = useState(false);
  const [notice, setNotice] = useState<string>();
  const queryId = useId();
  const wholeId = useId();
  const { busy, error, run } = useSubmit();
  const kind = linkKind(query);
  return (
    <form className="grid gap-2" onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        const r = await client.addToPlaylist(playlistId, { query: query.trim(), playlist: kind === "list" || (kind === "track-in-list" && whole) });
        setNotice(addedSummary("Added", { count: r.added, skipped: r.skipped, dropped: r.dropped }));
        setQuery("");
      });
    }}>
      <label htmlFor={queryId} className="text-sm font-medium">Add songs</label>
      <div className="flex gap-2">
        <Input id={queryId} value={query} maxLength={500} disabled={!youtube}
          placeholder={youtube ? "Link, playlist link or search" : "Links are not set up here"} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" disabled={busy || !query.trim() || !youtube}>{busy ? "Adding…" : "Add"}</Button>
      </div>
      {kind === "track-in-list" && (
        <label htmlFor={wholeId} className="flex items-center gap-2 text-sm">
          <Checkbox id={wholeId} checked={whole} onCheckedChange={(c) => setWhole(c === true)} />
          Add the whole playlist this song is in
        </label>
      )}
      <Button variant="outline" size="sm" className="w-fit" onClick={() => setLibrary(true)}><ListMusic />Add from library</Button>
      {notice && <p role="status" className="m-0 text-sm text-muted-foreground">{notice}</p>}
      <ErrorText error={error} />
      {library && <LibraryDialog canAdd addVerb="Add" onClose={() => setLibrary(false)}
        onAdd={async (t) => { await client.addToPlaylist(playlistId, { track_id: t.id }); }} />}
    </form>
  );
}

/** A new playlist: empty, or imported from a playlist link. */
export function NewPlaylistDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const titleId = useId();
  const linkId = useId();
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>New playlist</DialogTitle>
          <DialogDescription>Anyone on the server can play it. You, and people who manage expressions, can change it.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const created = await client.createPlaylist({ title: title.trim() || undefined, from_url: link.trim() || undefined });
            onCreated(created.id);
          });
        }}>
          <label htmlFor={titleId} className="text-sm font-medium">Name</label>
          <Input id={titleId} value={title} maxLength={100} autoFocus placeholder={link.trim() ? "The imported playlist's name" : ""}
            onChange={(e) => setTitle(e.target.value)} />
          <label htmlFor={linkId} className="text-sm font-medium">Import from a link <span className="font-normal text-muted-foreground">(optional)</span></label>
          <Input id={linkId} value={link} maxLength={500} placeholder="YouTube, SoundCloud, Bandcamp or Spotify playlist"
            onChange={(e) => setLink(e.target.value)} />
          <ErrorText error={error} />
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || (!title.trim() && !link.trim())}>{busy ? (link.trim() ? "Importing…" : "Creating…") : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ playlist, onClose }: { playlist: MusicPlaylist; onClose: () => void }) {
  const [title, setTitle] = useState(playlist.title);
  const titleId = useId();
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Rename playlist</DialogTitle>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await client.renamePlaylist(playlist.id, title.trim());
            onClose();
          });
        }}>
          <label htmlFor={titleId} className="text-sm font-medium">Name</label>
          <Input id={titleId} value={title} maxLength={100} autoFocus onChange={(e) => setTitle(e.target.value)} />
          <ErrorText error={error} />
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim()}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
