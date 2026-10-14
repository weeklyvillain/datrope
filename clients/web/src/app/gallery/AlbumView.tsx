import { Perm, hasPerm, type Album } from "@datrope/core";
import { ArrowLeft, Globe, Lock, LogOut, Settings, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorText } from "@/components/error-text";
import { useSubmit } from "@/hooks/use-submit";
import { useBriefError } from "@/chat/Reactions";
import { useIsMobile } from "@/hooks/use-mobile";
import { EmptyView } from "../EmptyView";
import { UserAvatar } from "@/components/user-avatar";
import { client, errorText, useApp, usePerms } from "../../session";
import { AlbumDialog } from "./AlbumDialog";
import { GalleryView } from "./GalleryView";
import type { GalleryItem } from "./items";
import { UploadDialog } from "./UploadDialog";

/** A confirmation before something destructive; shows the failure and stays open when it fails. */
function Confirm({ title, body, label, onConfirm, onClose, destructive = true }: {
  title: string; body: ReactNode; label: string; onConfirm: () => Promise<void>; onClose: () => void; destructive?: boolean;
}) {
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={destructive ? "destructive" : "default"} disabled={busy} onClick={() => void run(onConfirm)}>{label}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One album: the gallery grid over its files, with its settings, upload and leave actions. */
export function AlbumView({ albumId }: { albumId: string }) {
  const [album, setAlbum] = useState<Album>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removing, setRemoving] = useState<GalleryItem>(); // an album upload: removing it deletes it
  const [actionError, showActionError] = useBriefError();
  const nav = useNavigate();
  const mobile = useIsMobile();
  const me = useApp((s) => s.me?.id);
  const members = useApp((s) => s.server?.members);
  const canModerate = hasPerm(usePerms(), Perm.ManageMessages);

  useEffect(() => {
    let live = true;
    const load = () => client.album(albumId).then((a) => live && setAlbum(a), (e) => live && setError(errorText(e)));
    void load();
    const off = client.onEvent((type, data) => {
      const d = data as { id?: string };
      if (type === "ALBUM_UPDATE" && d.id === albumId) void load();
      // Turning an album private is announced as a delete to everyone but its members: look again before leaving.
      if (type === "ALBUM_DELETE" && d.id === albumId) {
        client.album(albumId).then((a) => live && setAlbum(a), () => live && nav("/gallery/albums"));
      }
    });
    return () => { live = false; off(); };
  }, [albumId, nav]);

  if (error) return <EmptyView>{error}</EmptyView>;
  if (!album) return <EmptyView>Loading…</EmptyView>;
  const canEdit = album.role === "owner" || album.role === "collaborator";
  const Icon = album.visibility === "server" ? Globe : Lock;
  const leave = (a: Album, user: string) =>
    client.removeAlbumMember(a.id, user).then(
      () => client.album(a.id).then(setAlbum, () => nav("/gallery/albums")),
      showActionError,
    );
  const header = (
    <>
      {!mobile && <Button variant="ghost" size="icon-sm" asChild aria-label="Back to albums"><Link to="/gallery/albums"><ArrowLeft /></Link></Button>}
      <h2 className="flex-none">{album.title}</h2>
      <Icon className="size-4 flex-none text-muted-foreground" aria-label={album.visibility === "server" ? "Everyone on the server" : "Only collaborators"} />
      <span className="flex -space-x-1.5" aria-label="Collaborators">
        {[album.owner_id, ...(album.member_ids ?? [])].map((u) => {
          const user = members?.[u]?.user;
          return user && <UserAvatar key={u} user={user} size="xs" />;
        })}
      </span>
      <span className="flex-1" />
      {album.role === "owner" && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Settings /> Album settings</Button>}
      {album.role === "collaborator" && me && (
        <Button size="sm" variant="outline" onClick={() => album.visibility === "private" ? setLeaving(true) : void leave(album, me)}>
          <LogOut /> Leave album
        </Button>
      )}
      {album.visibility === "server" && album.role !== "owner" && canModerate && (
        <Button size="sm" variant="outline" className="border-destructive text-destructive hover:text-destructive" onClick={() => setDeleting(true)}>
          <Trash2 /> Delete album
        </Button>
      )}
      <ErrorText error={actionError} />
    </>
  );
  return (
    <>
      <GalleryView scope={{ kind: "album", albumId }} header={header} canUploadHere={canEdit} onUpload={() => setUploading(true)}
        menuExtra={canEdit ? (it) => it.attachment.album_id ? (
          <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(it)}><Trash2 />Delete from album</DropdownMenuItem>
        ) : (
          <DropdownMenuItem variant="destructive" onSelect={() => void client.removeFromAlbum(albumId, it.attachment.id).catch(showActionError)}>
            <Trash2 />Remove from album
          </DropdownMenuItem>
        ) : undefined} />
      {editing && <AlbumDialog album={album} onClose={() => setEditing(false)} onSaved={(a) => { setAlbum(a); setEditing(false); }}
        onDeleted={() => nav("/gallery/albums")} />}
      {leaving && me && (
        <Confirm title="Leave this album?" body="You will lose access to this album and its files until someone adds you again."
          label="Leave album" destructive={false} onClose={() => setLeaving(false)}
          onConfirm={async () => { await client.removeAlbumMember(album.id, me); nav("/gallery/albums"); }} />
      )}
      {deleting && (
        <Confirm title="Delete this album?" body="This deletes the album and the files uploaded to it, for everyone."
          label="Delete album" onClose={() => setDeleting(false)}
          onConfirm={async () => { await client.deleteAlbum(album.id); nav("/gallery/albums"); }} />
      )}
      {removing && (
        <Confirm title="Delete this file?" body={`${removing.attachment.filename} was uploaded to this album. Removing it deletes it for everyone.`}
          label="Delete" onClose={() => setRemoving(undefined)}
          onConfirm={async () => { await client.removeFromAlbum(albumId, removing.attachment.id); setRemoving(undefined); }} />
      )}
      {uploading && <UploadDialog target={{ albumId }} onClose={() => setUploading(false)} />}
    </>
  );
}
