import { DropdownMenuCheckboxItem, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { client, errorText, useApp } from "../../session";
import { addAll, useAlbumsForFile } from "./albums";

/** "Lofoten · #photos": albums are named with their gallery, since a file can be in several galleries. */
export function useAlbumLabel() {
  const channels = useApp((s) => s.channels);
  return (a: { title: string; gallery_id: string }) => `${a.title} · #${channels[a.gallery_id]?.name ?? "gallery"}`;
}

/** Albums I can add one file to, as checkboxes: ticking adds it, unticking takes it out. */
export function AddToAlbumItems({ attachmentId, onError }: { attachmentId: string; onError: (message: string) => void }) {
  const { albums, loading, reload } = useAlbumsForFile(attachmentId);
  const label = useAlbumLabel();
  return (
    <>
      {loading && albums.length === 0 && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
      {!loading && albums.length === 0 && <DropdownMenuItem disabled>No albums here yet</DropdownMenuItem>}
      {albums.map((a) => (
        <DropdownMenuCheckboxItem key={a.id} checked={!!a.contains} onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => void (on ? client.addToAlbum(a.id, attachmentId) : client.removeFromAlbum(a.id, attachmentId)).then(reload, (e) => { onError(errorText(e)); reload(); })}>
          {label(a)}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

/** A message's files into one of my albums, from its right-click menu. Its files share a channel, so the first one decides. */
export function AddToAlbumContextItems({ attachmentIds, onError }: { attachmentIds: string[]; onError: (message: string) => void }) {
  const { albums, loading } = useAlbumsForFile(attachmentIds[0]);
  const label = useAlbumLabel();
  return (
    <>
      {!loading && albums.length === 0 && <ContextMenuItem disabled>No albums here yet</ContextMenuItem>}
      {albums.map((a) => (
        <ContextMenuItem key={a.id} onSelect={() => void addAll(a.id, attachmentIds).then((m) => m && onError(m))}>{label(a)}</ContextMenuItem>
      ))}
    </>
  );
}
