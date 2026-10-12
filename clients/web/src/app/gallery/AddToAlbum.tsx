import { Plus } from "lucide-react";
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { client, errorText } from "../../session";
import { addAll, useAlbums } from "./albums";

/** Albums I can add to, as checkboxes for one file: ticking adds it, unticking takes it out. */
export function AddToAlbumItems({ attachmentId, onNew, onError }: { attachmentId: string; onNew: () => void; onError: (message: string) => void }) {
  const { albums, loading, reload } = useAlbums(attachmentId);
  const mine = albums.filter((a) => a.role === "owner" || a.role === "collaborator");
  return (
    <>
      {loading && mine.length === 0 && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
      {mine.map((a) => (
        <DropdownMenuCheckboxItem key={a.id} checked={!!a.contains} onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => void (on ? client.addToAlbum(a.id, attachmentId) : client.removeFromAlbum(a.id, attachmentId)).then(reload, (e) => { onError(errorText(e)); reload(); })}>
          {a.title}
        </DropdownMenuCheckboxItem>
      ))}
      {mine.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem onSelect={onNew}><Plus />New album</DropdownMenuItem>
    </>
  );
}

/** A message's files into one of my albums, from its right-click menu. */
export function AddToAlbumContextItems({ attachmentIds, onNew, onError }: { attachmentIds: string[]; onNew: () => void; onError: (message: string) => void }) {
  const { albums } = useAlbums();
  const mine = albums.filter((a) => a.role === "owner" || a.role === "collaborator");
  return (
    <>
      {mine.map((a) => (
        <ContextMenuItem key={a.id} onSelect={() => void addAll(a.id, attachmentIds).then((m) => m && onError(m))}>
          {a.title}
        </ContextMenuItem>
      ))}
      {mine.length > 0 && <ContextMenuSeparator />}
      <ContextMenuItem onSelect={onNew}><Plus />New album</ContextMenuItem>
    </>
  );
}
