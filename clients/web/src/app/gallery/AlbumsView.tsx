import type { Album } from "@datrope/core";
import { Globe, Images, Lock, Plus, Users } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { attachmentImage } from "@/lib/sized-image";
import { cn } from "@/lib/utils";
import { displayName, useApp } from "../../session";
import { TopBar } from "../TopBar";
import { AlbumDialog } from "./AlbumDialog";
import { groupAlbums, useAlbums } from "./albums";
import { viewChip, viewChipActive } from "./GalleryView";

/** The gallery's Albums view: mine, then other people's albums shared with the server. */
export function AlbumsView() {
  const { albums, loading, error } = useAlbums();
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  const { yours, server } = groupAlbums(albums);
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background" aria-label="Albums">
      <TopBar actions={<Button size="sm" onClick={() => setCreating(true)}><Plus /> New album</Button>}>
        <Images className="size-4 flex-none text-muted-foreground" aria-hidden />
        <h2 className="flex-none">Gallery</h2>
        <div role="group" aria-label="Gallery view" className="ml-2 flex gap-1.5">
          <Button variant="outline" size="sm" asChild className={viewChip}><Link to="/gallery">All files</Link></Button>
          <Button variant="outline" size="sm" asChild className={cn(viewChip, viewChipActive)}>
            <Link to="/gallery/albums" aria-current="page">Albums</Link>
          </Button>
        </div>
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ErrorText error={error} />
        {loading && albums.length === 0 ? <p className="m-0 p-8 text-center text-sm text-muted-foreground">Loading…</p>
          : albums.length === 0 ? (
            <div className="grid justify-items-center gap-3 p-8 text-center">
              <p className="m-0 text-sm font-semibold">Make your first album</p>
              <p className="m-0 text-sm text-muted-foreground">Collect files from any channel, or upload straight into it.</p>
              <Button size="sm" onClick={() => setCreating(true)}><Plus /> New album</Button>
            </div>
          ) : (
            <div className="grid gap-6">
              {yours.length > 0 && <AlbumGrid label="Yours" albums={yours} />}
              {server.length > 0 && <AlbumGrid label="On the server" albums={server} />}
            </div>
          )}
      </div>
      {creating && <AlbumDialog onClose={() => setCreating(false)} onSaved={(a) => nav(`/gallery/albums/${a.id}`)} />}
    </main>
  );
}

function AlbumGrid({ label, albums }: { label: string; albums: Album[] }) {
  return (
    <section aria-label={label}>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</h3>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-0">
        {albums.map((a) => <li key={a.id}><AlbumCard album={a} /></li>)}
      </ul>
    </section>
  );
}

function AlbumCard({ album: a }: { album: Album }) {
  const owner = useApp((s) => s.server?.members?.[a.owner_id]?.user);
  const Icon = a.visibility === "server" ? Globe : Lock;
  const collaborators = a.member_ids?.length ?? 0;
  const who = collaborators > 0 ? `${owner ? displayName(owner) : "Someone"} + ${collaborators}` : owner ? displayName(owner) : "";
  return (
    <Link to={`/gallery/albums/${a.id}`} className="group grid gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="grid aspect-square place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground">
        {a.cover ? <img {...attachmentImage(a.cover, 240, { cover: true })} alt="" className="size-full object-cover group-hover:brightness-110" />
          : <Images className="size-8" aria-hidden />}
      </span>
      <span className="truncate text-sm font-semibold text-foreground">{a.title}</span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Icon className="size-3" aria-label={a.visibility === "server" ? "Everyone on the server" : "Only collaborators"} />
        {collaborators > 0 && <Users className="size-3" aria-hidden />}
        <span className="truncate">{who} · {a.item_count} {a.item_count === 1 ? "file" : "files"}</span>
      </span>
    </Link>
  );
}
