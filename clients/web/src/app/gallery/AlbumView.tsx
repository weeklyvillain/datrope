import { Perm, canPost, hasPerm, type Album } from "@datrope/core";
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
import { errorKind } from "@/lib/error-kind";
import { NoAccess, NotFound } from "../../pages/errors";
import { EmptyView } from "../EmptyView";
import { UserAvatar } from "@/components/user-avatar";
import { client, errorText, useApp, usePerms } from "../../session";
import { AlbumDialog } from "./AlbumDialog";
import { GalleryView } from "./GalleryView";
import { UploadDialog } from "./UploadDialog";
import { ListSkeleton } from "@/components/loading-skeleton";

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
export function AlbumView({ galleryId, albumId }: { galleryId: string; albumId: string }) {
  const [album, setAlbum] = useState<Album>();
  const [error, setError] = useState<unknown>();
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, showActionError] = useBriefError();
  const nav = useNavigate();
  const mobile = useIsMobile();
  const me = useApp((s) => s.me?.id);
  const members = useApp((s) => s.server?.members);
  const canModerate = hasPerm(usePerms(), Perm.ManageMessages);
  const gallery = useApp((s) => s.channels[galleryId]);
  const galleryPerms = usePerms(galleryId);

  useEffect(() => {
    let live = true;
    const load = () => client.album(albumId).then((a) => live && setAlbum(a), (e: unknown) => live && setError(e));
    void load();
    const off = client.onEvent((type, data) => {
      const d = data as { id?: string };
      if (type === "ALBUM_UPDATE" && d.id === albumId) void load();
      // Turning an album private is announced as a delete to everyone but its members: look again before leaving.
      if (type === "ALBUM_DELETE" && d.id === albumId) {
        client.album(albumId).then((a) => live && setAlbum(a), () => live && nav(`/channels/${galleryId}`));
      }
    });
    return () => { live = false; off(); };
  }, [albumId, galleryId, nav]);

  if (error) {
    const kind = errorKind(error);
    if (kind === "not-found") return <NotFound inShell />;
    if (kind === "no-access") return <NoAccess inShell />;
    return <EmptyView>{errorText(error)}</EmptyView>;
  }
  if (!album) return <EmptyView><ListSkeleton className="w-full max-w-md" /></EmptyView>;
  const canEdit = album.role === "owner" || album.role === "collaborator";
  const canUpload = canEdit && !!gallery && canPost(gallery, galleryPerms) && hasPerm(galleryPerms, Perm.AttachFiles);
  const Icon = album.visibility === "gallery" ? Globe : Lock;
  const leave = (a: Album, user: string) =>
    client.removeAlbumMember(a.id, user).then(
      () => client.album(a.id).then(setAlbum, () => nav(`/channels/${galleryId}`)),
      showActionError,
    );
  const header = (
    <>
      {!mobile && <Button variant="ghost" size="icon-sm" asChild aria-label="Back to gallery"><Link to={`/channels/${galleryId}`}><ArrowLeft /></Link></Button>}
      <Link to={`/channels/${galleryId}`} className="flex-none text-muted-foreground hover:text-foreground">#{gallery?.name ?? "gallery"}</Link>
      <span className="text-muted-foreground" aria-hidden>/</span>
      <h1 className="flex-none">{album.title}</h1>
      <Icon className="size-4 flex-none text-muted-foreground" aria-label={album.visibility === "gallery" ? "Everyone in this gallery" : "Only collaborators"} />

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
      {album.visibility === "gallery" && album.role !== "owner" && canModerate && (
        <Button size="sm" variant="outline" className="border-destructive text-destructive hover:text-destructive" onClick={() => setDeleting(true)}>
          <Trash2 /> Delete album
        </Button>
      )}
      <ErrorText error={actionError} />
    </>
  );
  return (
    <>
      <GalleryView scope={{ kind: "album", albumId, galleryId }} header={header} canUploadHere={canUpload} onUpload={() => setUploading(true)}
        menuExtra={canEdit ? (it) => (
          <DropdownMenuItem variant="destructive" onSelect={() => void client.removeFromAlbum(albumId, it.attachment.id).catch(showActionError)}>
            <Trash2 />Remove from album
          </DropdownMenuItem>
        ) : undefined} />
      {editing && <AlbumDialog album={album} onClose={() => setEditing(false)} onSaved={(a) => { setAlbum(a); setEditing(false); }}
        onDeleted={() => nav(`/channels/${galleryId}`)} />}
      {leaving && me && (
        <Confirm title="Leave this album?" body="You will lose access to this album and its files until someone adds you again."
          label="Leave album" destructive={false} onClose={() => setLeaving(false)}
          onConfirm={async () => { await client.removeAlbumMember(album.id, me); nav(`/channels/${galleryId}`); }} />
      )}
      {deleting && (
        <Confirm title="Delete this album?" body="This deletes the album for everyone. Its files stay where they were posted."
          label="Delete album" onClose={() => setDeleting(false)}
          onConfirm={async () => { await client.deleteAlbum(album.id); nav(`/channels/${galleryId}`); }} />
      )}
      {uploading && <UploadDialog target={{ channelId: galleryId, albumId }} onClose={() => setUploading(false)} />}
    </>
  );
}
