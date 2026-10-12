import { LayoutGrid, List, Play, Shuffle } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { displayName, useApp } from "../../session";
import { openPanel } from "../side-panel/panel";
import { player, trackFromItem, usePlayer } from "../player/player-store";
import { channelTag, FileTile } from "./FileTile";
import { FileMenu } from "./FileMenu";
import type { GalleryFilter } from "./filter";
import { audioOnly, itemAuthor, type GalleryItem } from "./items";
import { PlaylistsGrid } from "./PlaylistsGrid";
import type { useFiles } from "./use-files";

const LAYOUT_KEY = "gallery.music.layout";
const readLayout = (): "grid" | "list" => { try { return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; } };
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** Music: the tracks as tiles or a list, with Play all and Shuffle; in the global gallery, the playlists too. */
export function MusicView({ filter, setFilter, files, global, menuExtra }: {
  filter: GalleryFilter; setFilter: (p: Partial<GalleryFilter>) => void;
  files: ReturnType<typeof useFiles>; global: boolean; menuExtra?: (item: GalleryItem) => ReactNode;
}) {
  const [layout, setLayout] = useState(readLayout);
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* private mode */ } }, [layout]);
  const view = global ? filter.view : "tracks"; // playlists live in the global gallery only
  const playingKey = usePlayer((s) => s.queue.tracks[s.queue.index]?.key);
  // Until the Music page arrives, files can still hold the previous filter's files: show and play only audio.
  const items = useMemo(() => audioOnly(files.items), [files.items]);
  const members = useApp((s) => s.server?.members);
  const tracks = items.map((it) => {
    const author = itemAuthor(it, members);
    return trackFromItem(it, author && displayName(author));
  });
  const filtered = filter.q.trim() !== "" || filter.uploader !== null || filter.channels.length > 0;
  const open = (i: number) => {
    const it = items[i];
    openPanel({ kind: "media", attachmentId: it.attachment.id });
  };

  return (
    <div className="grid content-start gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {global && (
          <Tabs value={filter.view} onValueChange={(v) => setFilter({ view: v as GalleryFilter["view"], playlist: null })}>
            <TabsList><TabsTrigger value="tracks">Tracks</TabsTrigger><TabsTrigger value="playlists">Playlists</TabsTrigger></TabsList>
          </Tabs>
        )}
        {view === "tracks" && (
          <>
            <Button size="sm" disabled={!tracks.length} onClick={() => player.play(tracks)}><Play className="fill-current" />Play all</Button>
            <Button size="sm" variant="outline" disabled={!tracks.length} onClick={() => player.play(tracks, 0, true)}><Shuffle />Shuffle</Button>
            <span className="flex-1" />
            <ToggleGroup type="single" variant="outline" size="sm" value={layout} onValueChange={(v) => v && setLayout(v as "grid" | "list")} aria-label="Layout">
              <ToggleGroupItem value="grid" aria-label="Grid"><LayoutGrid /></ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List"><List /></ToggleGroupItem>
            </ToggleGroup>
          </>
        )}
      </div>

      {view === "playlists" ? (
        <PlaylistsGrid filter={filter} setFilter={setFilter} />
      ) : files.error && !items.length ? <ErrorText error={files.error} />
        : !items.length && !files.loading && filtered ? (
          <div className="grid justify-items-center gap-3 p-8">
            <p className="m-0 text-sm text-muted-foreground">No files match.</p>
            <Button variant="outline" size="sm" onClick={() => setFilter({ q: "", uploader: null, channels: [] })}>Clear filters</Button>
          </div>
        )
        : !items.length ? <p className="m-0 p-8 text-center text-sm text-muted-foreground">{files.loading ? "Loading…" : "No music yet."}</p>
        : layout === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
            {items.map((it, i) => (
              <FileTile key={it.attachment.id} item={it} global={global} selected={false} playing={playingKey === `file:${it.attachment.id}`}
                onOpen={() => open(i)} onPlay={() => player.play(tracks, i)} menu={<FileMenu item={it} items={items} extra={menuExtra?.(it)} />} />
            ))}
          </div>
        ) : (
          <Table aria-label="Tracks">
            <TableHeader><TableRow>
              <TableHead className="w-10">#</TableHead><TableHead>Title</TableHead>{global && <TableHead>Channel</TableHead>}
              <TableHead>Uploaded by</TableHead><TableHead>Added</TableHead><TableHead className="w-10" />
            </TableRow></TableHeader>
            <TableBody>
              {items.map((it, i) => {
                const cur = playingKey === `file:${it.attachment.id}`;
                return (
                  <TableRow key={it.attachment.id} className={cn(cur && "bg-primary/10")} onDoubleClick={() => player.play(tracks, i)}>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" aria-label={`Play ${it.attachment.filename}`} onClick={() => player.play(tracks, i)}>
                        {cur ? <span className="text-primary">♪</span> : <span className="text-muted-foreground tabular-nums">{i + 1}</span>}
                      </Button>
                    </TableCell>
                    <TableCell><button type="button" className={cn("text-left", cur && "font-semibold text-primary")} onClick={() => open(i)}>{it.attachment.filename}</button></TableCell>
                    {global && <TableCell>{channelTag(it) && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">#{channelTag(it)}</span>}</TableCell>}
                    <TableCell>{displayName(itemAuthor(it, members) ?? { username: "unknown", display_name: "Unknown" })}</TableCell>
                    <TableCell className="text-muted-foreground">{dateFmt.format(new Date(it.created_at))}</TableCell>
                    <TableCell><FileMenu item={it} items={items} extra={menuExtra?.(it)} /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      {view === "tracks" && files.hasMore && (
        <div className="grid justify-items-center gap-2">
          <Button variant="outline" size="sm" disabled={files.loading} onClick={files.loadMore}>Load more</Button>
          {items.length > 0 && <ErrorText error={files.error} />}
        </div>
      )}
    </div>
  );
}
