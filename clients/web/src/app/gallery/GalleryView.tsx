import { Perm, canPost, hasPerm } from "@datrope/core";
import { FilterX, Images, Search, SlidersHorizontal, Upload, X } from "@/components/icons";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { client, displayName, isUnread, useApp, usePerms } from "../../session";
import { ErrorText } from "@/components/error-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { useElementWidth } from "@/hooks/use-element-width";
import { useIsMobile } from "@/hooks/use-mobile";
import { useWindowFocus } from "@/hooks/use-window-focus";
import { EmojiText } from "@/chat/EmojiText";
import { Topic } from "../ChannelView";
import { NoAccess } from "../../pages/errors";
import { SearchPanel } from "../search/SearchPanel";
import { RemindersPanel } from "../reminders/RemindersPanel";
import { ScreenHeader } from "../mobile/ScreenHeader";
import { TopBar } from "../TopBar";
import { closePanel, openPanel, panelStore, usePanel } from "../side-panel/panel";
import { ThreadPanel } from "../side-panel/ThreadPanel";
import { player, trackFromItem } from "../player/player-store";
import { AlbumDecks } from "./AlbumDecks";
import { ChannelFilter } from "./ChannelFilter";
import { FileMenu, TrackActions } from "./FileMenu";
import { FileTile } from "./FileTile";
import { DEFAULT_FILTER, filterParams, parseFilter, type GalleryFilter } from "./filter";
import { GalleryFilterSheet, GallerySegments } from "./GalleryFilterSheet";
import { GalleryItemPanel } from "./GalleryItemPanel";
import { audioRun, itemHome, sections, type GalleryItem } from "./items";
import { KIND_LABELS, KIND_ORDER } from "./kinds";
import { MusicView } from "./MusicView";
import { sourceSummary } from "./sources";
import { TileSheet } from "./TileSheet";
import { UploadDialog } from "./UploadDialog";
import { useFiles, type GalleryScope } from "./use-files";
import { Wall } from "./Wall";
import { GridSkeleton } from "@/components/loading-skeleton";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { BareButton } from "@/components/bare-button";

const chip = "h-7 rounded-full px-3 text-ui font-normal text-muted-foreground data-[state=on]:border-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground";

const openItem = (it: GalleryItem) =>
  openPanel({ kind: "media", attachmentId: it.attachment.id });

/** A gallery channel's files, newest first, or one of its albums' files. */
export function GalleryView({ scope: given, header, menuExtra, canUploadHere, onUpload }: {
  scope: GalleryScope;
  header?: ReactNode; // replaces the title row (albums)
  menuExtra?: (item: GalleryItem) => ReactNode; // more tile-menu items (Remove from album)
  canUploadHere?: boolean; // albums decide upload rights themselves
  onUpload?: () => void;
}) {
  const channelId = given.kind === "gallery" ? given.channelId : given.galleryId;
  const albumId = given.kind === "album" ? given.albumId : undefined;
  // useFiles resubscribes when the scope changes identity, so keep one object per gallery or album.
  const scope = useMemo<GalleryScope>(() => (albumId ? { kind: "album", albumId, galleryId: channelId } : { kind: "gallery", channelId }), [channelId, albumId]);
  const ch = useApp((s) => s.channels[channelId]);
  const channels = useApp((s) => s.channels);
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
  const [wallRef, wallWidth] = useElementWidth<HTMLDivElement>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterCountId = useId();
  const [sheetItem, setSheetItem] = useState<GalleryItem | null>(null);
  const hasSources = !!ch && ch.gallery_sources !== "none";
  const showTag = (it: GalleryItem) => itemHome(it) !== channelId; // tiles name the channel a file came from
  const summary = ch && !header ? sourceSummary(ch, channels) : "";

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

  if (!ch) return <NoAccess inShell />;
  const canUpload = canPost(ch, perms) && hasPerm(perms, Perm.AttachFiles);
  const selected = panel?.kind === "media" ? panel : undefined;
  const filtered = filter.kind !== "all" || filter.q.trim() !== "" || filter.uploader !== null || filter.channels.length > 0;
  const count = `${files.items.length}${files.hasMore ? "+" : ""} ${files.items.length === 1 && !files.hasMore ? "item" : "items"}`;
  const music = filter.kind === "audio";
  const playFrom = (it: GalleryItem) => {
    const { run, at } = audioRun(files.items, it);
    player.play(run.map((it) => trackFromItem(it)), at);
  };

  const activeFilters = (filter.uploader !== null ? 1 : 0) + filter.channels.length;
  const phoneTools = (
    <>
      <Button variant="ghost" size="icon" aria-label="Search files" aria-pressed={searchOpen || !!filter.q} onClick={() => setSearchOpen((o) => !o)}><Search /></Button>
      <Button variant="ghost" size="icon" aria-label="Filter files" aria-describedby={activeFilters > 0 ? filterCountId : undefined} aria-pressed={filterOpen}
        onClick={() => setFilterOpen(true)} className={cn("relative", activeFilters > 0 && "text-primary")}>
        <SlidersHorizontal />
        {activeFilters > 0 && <Badge className="absolute -top-0.5 -right-0.5 h-4 min-w-4 justify-center px-1 text-caption" aria-hidden>{activeFilters}</Badge>}
        {activeFilters > 0 && <span id={filterCountId} className="sr-only">{activeFilters} active {activeFilters === 1 ? "filter" : "filters"}</span>}
      </Button>
    </>
  );

  const searchBox = (
    <>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input value={filter.q} onChange={(e) => setFilter({ q: e.target.value })} placeholder="Search files" aria-label="Search files"
        className="h-8 pr-8 pl-8" />
      {filter.q && (
        <BareButton aria-label="Clear search" onClick={() => setFilter({ q: "" })}
          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="size-4" /></BareButton>
      )}
    </>
  );
  const showToggles = (
    <>
      <Toggle variant="outline" size="sm" className={chip} pressed={filter.kind === "all"} onPressedChange={() => setFilter({ kind: "all", view: "tracks", playlist: null })}>All</Toggle>
      {KIND_ORDER.map((k) => (
        <Toggle key={k} variant="outline" size="sm" className={chip} pressed={filter.kind === k}
          onPressedChange={() => setFilter({ kind: k, view: "tracks", playlist: null })}>{KIND_LABELS[k]}</Toggle>
      ))}
    </>
  );

  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col bg-background" aria-label={scope.kind === "album" ? "Album" : ch.name}>
        {mobile && !header ? (
          <ScreenHeader title={<EmojiText text={ch.name} />}
            actions={<>
              {canUpload && <Button variant="ghost" size="icon" aria-label="Upload" onClick={() => setUploading(true)}><Upload /></Button>}
              {phoneTools}
            </>} />
        ) : (
          <TopBar actions={header ? <>{!mobile && <div className="relative w-56">{searchBox}</div>}{canUploadHere && <Button size="sm" onClick={onUpload}><Upload /> Upload</Button>}{mobile && phoneTools}</>
            : <><div className="relative w-56">{searchBox}</div>{canUpload && <Button size="sm" onClick={() => setUploading(true)}><Upload /> Upload</Button>}</>}>
            {header ? header : (<>
            <Images className="size-4 flex-none text-muted-foreground" aria-hidden />
            <h1 className="flex-none"><EmojiText text={ch.name} /></h1>
            {summary && <span className="truncate text-sm text-muted-foreground">{summary}</span>}
            {ch.topic && <Topic channelId={ch.id} name={ch.name} topic={ch.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
            </>)}
          </TopBar>
        )}
        {mobile && !header && (
          <GallerySegments value={music ? "music" : "files"} onFiles={() => setFilter({ kind: "all", view: "tracks", playlist: null })}
            onMusic={() => setFilter({ kind: "audio", view: "tracks", playlist: null })} />
        )}

        {mobile && (
          <div className="flex flex-none flex-col items-stretch gap-2 border-b px-4 py-3">
            {(searchOpen || filter.q) && <div className="relative w-full">{searchBox}</div>}
            <div role="group" aria-label="Show" className="-mx-4 flex flex-nowrap gap-1.5 overflow-x-auto overscroll-x-contain px-4 [&>*]:flex-none">{showToggles}</div>
          </div>
        )}

        <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-y-contain", !mobile && "pb-24")}>
          {scope.kind === "gallery" && !music && <AlbumDecks galleryId={channelId} />}
          {music ? <MusicView filter={filter} setFilter={setFilter} files={files} global={hasSources} menuExtra={menuExtra} />
            : files.error && files.items.length === 0 ? <div className="p-4"><ErrorText error={files.error} /></div>
            : files.loading && files.items.length === 0 ? <GridSkeleton className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2 p-4" />
            : files.items.length === 0 ? (
              filtered ? (
                <Empty><EmptyHeader><EmptyMedia variant="icon"><FilterX /></EmptyMedia><EmptyTitle>No files match</EmptyTitle></EmptyHeader>
                  <EmptyContent><Button variant="outline" size="sm" onClick={() => setParams(filterParams(DEFAULT_FILTER), { replace: true })}>Clear filters</Button></EmptyContent>
                </Empty>
              ) : <Empty><EmptyHeader><EmptyMedia variant="icon"><Images /></EmptyMedia><EmptyTitle>No files yet</EmptyTitle><EmptyDescription>{hasSources ? "Files shared in its channels show up here." : "Upload files to fill this gallery."}</EmptyDescription></EmptyHeader></Empty>

            ) : (
              <div className="grid content-start gap-6 px-2 pt-2 pb-4">
                <div ref={wallRef} aria-hidden className="h-0" />
                {groups.map((g) => (
                  <section key={g.label} aria-label={g.label}>
                    <h3 className="mx-2 mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.label}</h3>
                    <Wall items={g.items} width={wallWidth} render={(it, size) => (
                      <FileTile key={it.attachment.id} item={it} size={size} global={showTag(it)} playing={false}
                        selected={selected?.attachmentId === it.attachment.id} onOpen={() => openItem(it)}
                        onPlay={it.kind === "audio" ? () => playFrom(it) : undefined} onLongPress={mobile ? () => setSheetItem(it) : undefined} menu={<FileMenu item={it} items={files.items} extra={menuExtra?.(it)} />} />
                    )} />
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

        {!mobile && (
          <div role="toolbar" aria-label="Filters"
            className="absolute inset-x-0 bottom-4 z-10 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:flex-none rounded-full border bg-popover/95 p-1.5 shadow-lg backdrop-blur">
            <div role="group" aria-label="Show" className="flex flex-none gap-1">{showToggles}</div>
            {hasSources && <ChannelFilter value={filter.channels} onChange={(channels) => setFilter({ channels })} />}
            <NativeSelect id={uploaderId} size="sm" aria-label="Uploaded by" value={filter.uploader ?? ""} onChange={(e) => setFilter({ uploader: e.target.value || null })}
              className="h-7 rounded-full">
              <NativeSelectOption value="">Anyone</NativeSelectOption>
              {uploaders.map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
            </NativeSelect>
            <span className="flex-none px-2 text-ui text-muted-foreground">{count}</span>
          </div>
        )}
      </main>
      {selected ? (
        <GalleryItemPanel attachmentId={selected.attachmentId} items={files.items} onClose={closePanel}
          actions={(it) => it.kind === "audio" && <TrackActions item={it} items={files.items} />} />
      ) : panel?.kind === "thread" ? (
        <ThreadPanel key={panel.threadId} threadId={panel.threadId} parentChannelId={panel.parentId ?? channelId} onClose={closePanel} />
      ) : panel?.kind === "reminders" ? (
        <RemindersPanel onClose={closePanel} />
      ) : panel?.kind === "search" ? (
        <SearchPanel />
      ) : null}
      {mobile && <GalleryFilterSheet open={filterOpen} onOpenChange={setFilterOpen} filter={filter} setFilter={setFilter} global={hasSources} uploaders={uploaders} />}
      {mobile && <TileSheet item={sheetItem} items={files.items} onClose={() => setSheetItem(null)} />}
      {uploading && <UploadDialog target={{ channelId }} onClose={() => setUploading(false)} />}
    </>
  );
}

