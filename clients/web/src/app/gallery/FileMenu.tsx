import { Download, ExternalLink, Images, ListPlus, MoreHorizontal, Play, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { client, errorText } from "../../session";
import { openMessage } from "../jump";
import { player, trackFromItem } from "../player/player-store";
import { AddToAlbumItems } from "./AddToAlbum";
import { addAll } from "./albums";
import { AlbumDialog } from "./AlbumDialog";
import { AddToPlaylistItems, NewPlaylistDialog } from "./AddToPlaylist";
import { audioRun, type GalleryItem } from "./items";

const playFrom = (items: GalleryItem[], item: GalleryItem) => {
  const { run, at } = audioRun(items, item);
  player.play(run.map((it) => trackFromItem(it)), at);
};

/** A new playlist made from a file's menu starts with that file; if adding it fails, say so. */
function NewPlaylistWith({ item, onClose }: { item: GalleryItem; onClose: () => void }) {
  const [phase, setPhase] = useState<"form" | "adding" | { failed: string }>("form");
  if (phase === "form") {
    return <NewPlaylistDialog onClose={onClose} onCreated={(id) => {
      setPhase("adding"); // closes the form, so Create can't make a second playlist
      client.addToPlaylist(id, { attachment_id: item.attachment.id })
        .then(onClose, (e) => setPhase({ failed: errorText(e) }));
    }} />;
  }
  if (phase === "adding") return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Playlist created</DialogTitle>
          <DialogDescription>The playlist was made, but {item.attachment.filename} couldn't be added to it.</DialogDescription>
        </DialogHeader>
        <p role="status" className="m-0 text-sm text-destructive">{phase.failed}</p>
        <DialogFooter><Button onClick={onClose}>OK</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Says why a file couldn't be added to an album. */
function AlbumAddFailed({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Couldn't add to album</DialogTitle>
          <DialogDescription>The file wasn't added.</DialogDescription>
        </DialogHeader>
        <p role="alert" className="m-0 text-sm text-destructive">{message}</p>
        <DialogFooter><Button onClick={onClose}>OK</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The "…" menu on a file: play, queue and add to a playlist (audio), go to its message, download. */
export function FileMenu({ item, items, extra }: { item: GalleryItem; items: GalleryItem[]; extra?: ReactNode }) {
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [newAlbum, setNewAlbum] = useState(false);
  const [albumError, setAlbumError] = useState<string>();
  const audio = item.kind === "audio";
  const library = !item.attachment.album_id; // an album upload can't join a playlist or another album
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <RefButton variant="secondary" size="icon-sm" aria-label={`More for ${item.attachment.filename}`}><MoreHorizontal /></RefButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {audio && <DropdownMenuItem onSelect={() => playFrom(items, item)}><Play />Play</DropdownMenuItem>}
          {audio && <DropdownMenuItem onSelect={() => player.add([trackFromItem(item)])}><ListPlus />Add to queue</DropdownMenuItem>}
          {audio && library && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Plus />Add to playlist</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                <AddToPlaylistItems attachmentId={item.attachment.id} onNew={() => setCreating(true)} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {library && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Images />Add to album</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                <AddToAlbumItems attachmentId={item.attachment.id} onNew={() => setNewAlbum(true)} onError={setAlbumError} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {item.message && item.channel && (
            <DropdownMenuItem onSelect={() => void openMessage(nav, item.channel!, item.message!.id)}><ExternalLink />Go to message</DropdownMenuItem>
          )}
          {extra}
          <DropdownMenuItem asChild><a href={client.url(item.attachment.url)} download={item.attachment.filename}><Download />Download</a></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {creating && <NewPlaylistWith item={item} onClose={() => setCreating(false)} />}
      {newAlbum && <AlbumDialog onClose={() => setNewAlbum(false)}
        onSaved={(a) => { setNewAlbum(false); void addAll(a.id, [item.attachment.id]).then((m) => m && setAlbumError(m)); }} />}
      {albumError && <AlbumAddFailed message={albumError} onClose={() => setAlbumError(undefined)} />}
    </>
  );
}

/** A track's buttons in its details panel: play, queue, add to a playlist. */
export function TrackActions({ item, items }: { item: GalleryItem; items: GalleryItem[] }) {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => playFrom(items, item)}><Play className="fill-current" />Play</Button>
      <Button size="sm" variant="outline" onClick={() => player.add([trackFromItem(item)])}><ListPlus />Add to queue</Button>
      {!item.attachment.album_id && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <RefButton size="sm" variant="outline"><Plus />Add to playlist</RefButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <AddToPlaylistItems attachmentId={item.attachment.id} onNew={() => setCreating(true)} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {creating && <NewPlaylistWith item={item} onClose={() => setCreating(false)} />}
    </>
  );
}
