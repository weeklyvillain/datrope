import { Perm, hasPerm } from "@datrope/core";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { totalLength, trackCount } from "@/lib/music";
import { client, displayName, useApp, usePerms } from "../../session";
import { Cover } from "../voice/MusicBits";
import { NewPlaylistDialog } from "../voice/PlaylistsTab";
import type { GalleryFilter } from "./filter";
import { PlaylistDetailView } from "./PlaylistDetailView";

const chip = "h-7 rounded-full px-3 text-[13px] font-normal text-muted-foreground data-[state=on]:border-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground";

/** Music → Playlists: every playlist on the server, and the open playlist's detail. */
export function PlaylistsGrid({ filter, setFilter }: { filter: GalleryFilter; setFilter: (p: Partial<GalleryFilter>) => void }) {
  const playlists = useApp((s) => s.playlists);
  const members = useApp((s) => s.server?.members);
  const meId = useApp((s) => s.me?.id);
  const canCreate = hasPerm(usePerms(), Perm.AttachFiles);
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (!playlists) void client.loadPlaylists().catch(() => undefined); }, [playlists]);

  if (filter.playlist) return <PlaylistDetailView key={filter.playlist} id={filter.playlist} onBack={() => setFilter({ playlist: null })} />;
  const list = Object.values(playlists ?? {}).filter((p) => !mine || p.created_by === meId).sort((a, b) => a.title.localeCompare(b.title));
  const by = (id?: string | null) => (id === meId ? "you" : id && members?.[id] ? displayName(members[id].user) : "someone");
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-1.5" role="group" aria-label="Playlists shown">
        <Toggle variant="outline" size="sm" className={chip} pressed={!mine} onPressedChange={() => setMine(false)}>All</Toggle>
        <Toggle variant="outline" size="sm" className={chip} pressed={mine} onPressedChange={() => setMine(true)}>Mine</Toggle>
        <span className="flex-1" />
        {canCreate && <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus />New playlist</Button>}
      </div>
      {list.length === 0 ? <p className="m-0 p-8 text-center text-sm text-muted-foreground">{playlists ? "No playlists yet." : "Loading…"}</p> : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 p-0">
          {list.map((p) => (
            <li key={p.id}>
              <button type="button" aria-label={`Open ${p.title}`} onClick={() => setFilter({ playlist: p.id })}
                className="grid w-full gap-2 rounded-md border bg-card p-2.5 text-left hover:bg-accent">
                <Cover src={p.cover} className="aspect-square size-auto w-full" />
                <span className="truncate text-sm font-semibold">{p.title}</span>
                <span className="truncate text-xs text-muted-foreground">{trackCount(p.count)}{p.duration ? ` · ${totalLength(p.duration)}` : ""} · {by(p.created_by)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {creating && <NewPlaylistDialog onClose={() => setCreating(false)} onCreated={(id: string) => { setCreating(false); setFilter({ playlist: id }); }} />}
    </div>
  );
}
