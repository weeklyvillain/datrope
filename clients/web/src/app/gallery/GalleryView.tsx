import { Perm, canPost, hasPerm } from "@datrope/core";
import { Images, Search, SlidersHorizontal, Upload, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { client, displayName, isUnread, useApp, usePerms } from "../../session";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useWindowFocus } from "@/hooks/use-window-focus";
import { EmojiText } from "@/chat/EmojiText";
import { Topic } from "../ChannelView";
import { EmptyView } from "../EmptyView";
import { SearchPanel } from "../search/SearchPanel";
import { ScreenHeader } from "../mobile/ScreenHeader";
import { TopBar } from "../TopBar";
import { closePanel, openPanel, panelStore, usePanel } from "../side-panel/panel";
import { ThreadPanel } from "../side-panel/ThreadPanel";
import { player, trackFromItem } from "../player/player-store";
import { ChannelFilter } from "./ChannelFilter";
import { FileMenu, TrackActions } from "./FileMenu";
import { FileTile } from "./FileTile";
import { DEFAULT_FILTER, filterParams, parseFilter, type GalleryFilter } from "./filter";
import { GalleryFilterSheet, GallerySegments } from "./GalleryFilterSheet";
import { GalleryItemPanel } from "./GalleryItemPanel";
import { audioRun, sections, type GalleryItem } from "./items";
import { KIND_LABELS, KIND_ORDER } from "./kinds";
import { MusicView } from "./MusicView";
import { TileSheet } from "./TileSheet";
import { UploadDialog } from "./UploadDialog";
import { useFiles, type GalleryScope } from "./use-files";

const chip = "h-7 rounded-full px-3 text-[13px] font-normal text-muted-foreground data-[state=on]:border-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground";
export const viewChip = "h-7 rounded-full px-3 text-[13px] font-normal text-muted-foreground";
export const viewChipActive = "border-foreground font-semibold text-foreground";
const note = "m-0 p-8 text-center text-sm text-muted-foreground";

const openItem = (it: GalleryItem) =>
  openPanel({ kind: "media", attachmentId: it.attachment.id });

/** A gallery of files, newest first: one channel's, or (global) every channel the viewer can read. */
export function GalleryView({ scope: given, header, menuExtra, canUploadHere, onUpload }: {
  scope: GalleryScope;
  header?: ReactNode; // replaces the title row (albums)
  menuExtra?: (item: GalleryItem) => ReactNode; // more tile-menu items (Remove from album)
  canUploadHere?: boolean; // albums decide upload rights themselves
  onUpload?: () => void;
}) {
  const channelId = given.kind === "channel" ? given.channelId : undefined;
  const albumId = given.kind === "album" ? given.albumId : undefined;
  // useFiles resubscribes when the scope changes identity, so keep one object per channel.
  const scope = useMemo<GalleryScope>(() => (channelId ? { kind: "channel", channelId } : albumId ? { kind: "album", albumId } : { kind: "global" }), [channelId, albumId]);
  const ch = useApp((s) => (channelId ? s.channels[channelId] : undefined));
  const perms = usePerms(channelId);
  const panel = usePanel((s) => s.panel);
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => parseFilter(params), [params]);
  const setFilter = (patch: Partial<GalleryFilter>) => setParams(filterParams({ ...filter, ...patch }), { replace: true });
  const files = useFiles(scope, filter);
  const groups = useMemo(() => sections(files.items, new Date()), [files.items]);
  const members = useApp((s) => s.server?.members);
  const uploaders = useMemo(() => Object.values(members ?? {}).map((m) => [m.user.id, displayName(m.user)] as const)
    .sort((a, b) => a[1].localeCompare(b[1])), [members]);
  const uploaderId = useId();
  const [uploading, setUploading] = useState(false);
  const mobile = useIsMobile();
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sheetItem, setSheetItem] = useState<GalleryItem | null>(null);
  const global = scope.kind === "global";
  const tags = scope.kind !== "channel"; // tiles name their channel outside a channel gallery

  useEffect(() => {
    // A thread, a post, a gallery item or the threads list belongs to its channel; a profile (and search) stays open.
    // A thread opened from a search result is opened along with its parent channel, so it stays.
    const p = panelStore.getState().panel;
    if (p?.kind === "threads" || p?.kind === "post" || p?.kind === "media" || (p?.kind === "thread" && p.parentId !== channelId)) closePanel();
  }, [channelId]);

  // Seeing a gallery channel marks it read.
  const newest = useApp((s) => (channelId ? s.readStates[channelId]?.lastMessageId : undefined));
  const lastReadId = useApp((s) => (channelId ? s.readStates[channelId]?.lastReadId : undefined));
  const focused = useWindowFocus();
  useEffect(() => {
    if (channelId && newest && focused && isUnread({ lastMessageId: newest, lastReadId })) client.ack(channelId, newest).catch(() => undefined);
  }, [channelId, newest, lastReadId, focused]);

  // Infinite scroll: load the next page when the sentinel shows.
  const sentinel = useRef<HTMLDivElement>(null);
  // A failed page waits for the Load more button, or the observer would retry in a loop.
  const { hasMore, loadMore, error } = files;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || error) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, error]);

  if (scope.kind === "channel" && !ch) return <EmptyView>This channel is not available.</EmptyView>;
  const canUpload = !!ch && canPost(ch, perms) && hasPerm(perms, Perm.AttachFiles);
  const selected = panel?.kind === "media" ? panel : undefined;
  const filtered = filter.kind !== "all" || filter.q.trim() !== "" || filter.uploader !== null || filter.channels.length > 0;
  const count = `${files.items.length}${files.hasMore ? "+" : ""} ${files.items.length === 1 && !files.hasMore ? "item" : "items"}`;
  const music = filter.kind === "audio";
  const playFrom = (it: GalleryItem) => {
    const { run, at } = audioRun(files.items, it);
    player.play(run.map((it) => trackFromItem(it)), at);
  };

  const phoneTools = (
    <>
      <Button variant="ghost" size="icon" aria-label="Search files" aria-pressed={searchOpen || !!filter.q} onClick={() => setSearchOpen((o) => !o)}><Search /></Button>
      <Button variant="ghost" size="icon" aria-label="Filter files" onClick={() => setFilterOpen(true)}
        className={cn((filter.uploader !== null || filter.channels.length > 0) && "text-primary")}><SlidersHorizontal /></Button>
    </>
  );

  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-background" aria-label={global ? "Gallery" : scope.kind === "album" ? "Album" : ch!.name}>
        {mobile && !header ? (
          <ScreenHeader title={global ? "Gallery" : <EmojiText text={ch!.name} />}
            actions={<>
              {canUpload && <Button variant="ghost" size="icon" aria-label="Upload" onClick={() => setUploading(true)}><Upload /></Button>}
              {phoneTools}
            </>} />
        ) : (
          <TopBar actions={header ? <>{canUploadHere && <Button size="sm" onClick={onUpload}><Upload /> Upload</Button>}{mobile && phoneTools}</>
            : canUpload && <Button size="sm" onClick={() => setUploading(true)}><Upload /> Upload</Button>}>
            {header ? header : (<>
            <Images className="size-4 flex-none text-muted-foreground" aria-hidden />
            {global ? (
              <>
                <h2 className="flex-none">Gallery</h2>
                <div role="group" aria-label="Gallery view" className="ml-2 flex gap-1.5">
                  <Button variant="outline" size="sm" asChild className={cn(viewChip, viewChipActive)}>
                    <Link to="/gallery" aria-current="page">All files</Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild className={viewChip}><Link to="/gallery/albums">Albums</Link></Button>
                </div>
                <span className="truncate text-sm text-muted-foreground">Files from every channel</span>
              </>
            ) : (
              <>
                <h2 className="flex-none"><EmojiText text={ch!.name} /></h2>
                {ch!.topic && <Topic channelId={ch!.id} name={ch!.name} topic={ch!.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
              </>
            )}
            </>)}
          </TopBar>
        )}
        {mobile && global && !header && (
          <GallerySegments value={music ? "music" : "files"} onFiles={() => setFilter({ kind: "all", view: "tracks", playlist: null })}
            onMusic={() => setFilter({ kind: "audio", view: "tracks", playlist: null })} />
        )}

        <div className={cn("flex flex-none items-center gap-2 border-b px-4 py-3", mobile ? "flex-col items-stretch" : "flex-wrap")}>
          {(!mobile || searchOpen || filter.q) && <div className={cn("relative", mobile ? "w-full" : "w-56")}>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={filter.q} onChange={(e) => setFilter({ q: e.target.value })} placeholder="Search files" aria-label="Search files"
              className="h-8 pr-8 pl-8" />
            {filter.q && (
              <button type="button" aria-label="Clear search" onClick={() => setFilter({ q: "" })}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
            )}
          </div>}
          <div role="group" aria-label="Show" className={cn("flex gap-1.5", mobile ? "-mx-4 flex-nowrap overflow-x-auto overscroll-x-contain px-4 [&>*]:flex-none" : "flex-wrap")}>
            <Toggle variant="outline" size="sm" className={chip} pressed={filter.kind === "all"} onPressedChange={() => setFilter({ kind: "all", view: "tracks", playlist: null })}>All</Toggle>
            {KIND_ORDER.map((k) => (
              <Toggle key={k} variant="outline" size="sm" className={chip} pressed={filter.kind === k}
                onPressedChange={() => setFilter({ kind: k, view: "tracks", playlist: null })}>{KIND_LABELS[k]}</Toggle>
            ))}
          </div>
          {!mobile && <>
            <span className="flex-1" />
            {global && <ChannelFilter value={filter.channels} onChange={(channels) => setFilter({ channels })} />}
            <label htmlFor={uploaderId} className="text-[13px] text-muted-foreground">Uploaded by</label>
            <NativeSelect id={uploaderId} size="sm" value={filter.uploader ?? ""} onChange={(e) => setFilter({ uploader: e.target.value || null })}>
              <NativeSelectOption value="">Anyone</NativeSelectOption>
              {uploaders.map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
            </NativeSelect>
            <span className="text-[13px] text-muted-foreground">{count}</span>
          </>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          {music ? <MusicView filter={filter} setFilter={setFilter} files={files} global={global} menuExtra={menuExtra} />
            : files.error && files.items.length === 0 ? <div className="p-4"><ErrorText error={files.error} /></div>
            : files.loading && files.items.length === 0 ? <p className={note}>Loading…</p>
            : files.items.length === 0 ? (
              filtered ? (
                <div className="grid justify-items-center gap-3 p-8">
                  <p className="m-0 text-sm text-muted-foreground">No files match.</p>
                  <Button variant="outline" size="sm" onClick={() => setParams(filterParams(DEFAULT_FILTER), { replace: true })}>Clear filters</Button>
                </div>
              ) : <p className={note}>No files yet.</p>
            ) : (
              <div className="grid content-start gap-6 p-4">
                {groups.map((g) => (
                  <section key={g.label} aria-label={g.label}>
                    <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.label}</h3>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
                      {g.items.map((it) => (
                        <FileTile key={it.attachment.id} item={it} global={tags} playing={false}
                          selected={selected?.attachmentId === it.attachment.id} onOpen={() => openItem(it)}
                          onPlay={it.kind === "audio" ? () => playFrom(it) : undefined} onLongPress={mobile ? () => setSheetItem(it) : undefined} menu={<FileMenu item={it} items={files.items} extra={menuExtra?.(it)} />} />
                      ))}
                    </div>
                  </section>
                ))}
                {files.hasMore && (
                  <div ref={sentinel} className="grid justify-items-center gap-2">
                    <Button variant="outline" size="sm" disabled={files.loading} onClick={files.loadMore}>Load more</Button>
                    <ErrorText error={files.error} />
                  </div>
                )}
              </div>
            )}
        </div>
      </main>
      {selected ? (
        <GalleryItemPanel key={selected.attachmentId} attachmentId={selected.attachmentId} items={files.items} onClose={closePanel}
          actions={(it) => it.kind === "audio" && <TrackActions item={it} items={files.items} />} />
      ) : panel?.kind === "thread" ? (
        <ThreadPanel key={panel.threadId} threadId={panel.threadId} parentChannelId={panel.parentId ?? channelId ?? ""} onClose={closePanel} />
      ) : panel?.kind === "search" ? (
        <SearchPanel />
      ) : null}
      {mobile && <GalleryFilterSheet open={filterOpen} onOpenChange={setFilterOpen} filter={filter} setFilter={setFilter} global={global} uploaders={uploaders} />}
      {mobile && <TileSheet item={sheetItem} items={files.items} onClose={() => setSheetItem(null)} />}
      {uploading && channelId && <UploadDialog target={{ channelId }} onClose={() => setUploading(false)} />}
    </>
  );
}
