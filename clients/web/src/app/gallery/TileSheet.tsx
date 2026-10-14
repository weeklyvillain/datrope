import { Perm, hasPerm } from "@datrope/core";
import { Check, Images, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ActionSheet, ActionSheetItem } from "@/components/action-sheet";
import { client, errorText, useApp, usePerms } from "../../session";
import { useAlbumLabel } from "./AddToAlbum";
import { useAlbumsForFile } from "./albums";
import { fileActions, NewPlaylistWith } from "./FileMenu";
import type { GalleryItem } from "./items";

type View = "menu" | "playlist" | "album";

function AlbumRows({ item, onError }: { item: GalleryItem; onError: (m: string) => void }) {
  const { albums, loading, reload } = useAlbumsForFile(item.attachment.id);
  const label = useAlbumLabel();
  return (
    <>
      {loading && albums.length === 0 && <ActionSheetItem disabled onSelect={() => undefined}>Loading…</ActionSheetItem>}
      {!loading && albums.length === 0 && <ActionSheetItem disabled onSelect={() => undefined}>No albums here yet</ActionSheetItem>}
      {albums.map((a) => (
        <ActionSheetItem key={a.id} icon={a.contains ? <Check /> : <span />}
          onSelect={() => void (a.contains ? client.removeFromAlbum(a.id, item.attachment.id) : client.addToAlbum(a.id, item.attachment.id))
            .then(reload, (e) => { onError(errorText(e)); reload(); })}>{label(a)}</ActionSheetItem>
      ))}
    </>
  );
}

function PlaylistRows({ item, onNew, onDone, onError }: { item: GalleryItem; onNew: () => void; onDone: () => void; onError: (m: string) => void }) {
  const playlists = useApp((s) => s.playlists);
  const meId = useApp((s) => s.me?.id);
  const canManage = hasPerm(usePerms(), Perm.ManageExpressions);
  useEffect(() => {
    if (!playlists) void client.loadPlaylists().catch((e) => onError(errorText(e)));
  }, [playlists, onError]);
  const editable = Object.values(playlists ?? {}).filter((p) => canManage || p.created_by === meId).sort((a, b) => a.title.localeCompare(b.title));
  return (
    <>
      {editable.length === 0 && <ActionSheetItem disabled onSelect={() => undefined}>No playlists you can change</ActionSheetItem>}
      {editable.map((p) => (
        <ActionSheetItem key={p.id} onSelect={() => void client.addToPlaylist(p.id, { attachment_id: item.attachment.id }).then(onDone, (e) => onError(errorText(e)))}>{p.title}</ActionSheetItem>
      ))}
      <ActionSheetItem icon={<Plus />} onSelect={onNew}>New playlist</ActionSheetItem>
    </>
  );
}

/** Touch version of a tile's "..." menu, opened by long-pressing the tile. */
export function TileSheet({ item, items, onClose }: { item: GalleryItem | null; items: GalleryItem[]; onClose: () => void }) {
  const nav = useNavigate();
  const [view, setView] = useState<View>("menu");
  const [dialog, setDialog] = useState<"playlist">();
  const [error, setError] = useState<string>();
  const onError = useCallback((m: string) => setError(m), []);
  useEffect(() => { if (item) { setView("menu"); setError(undefined); } }, [item]);
  if (!item) return null;
  const done = () => { setDialog(undefined); onClose(); };
  const acts = fileActions(item, items, nav);
  const act = (id: string) => {
    const a = acts.find((x) => x.id === id);
    return a && <ActionSheetItem key={a.id} icon={a.icon} onSelect={() => { onClose(); a.onSelect(); }}>{a.label}</ActionSheetItem>;
  };
  return (
    <>
      <ActionSheet open={!dialog} onOpenChange={(o) => !o && onClose()}
        title={view === "menu" ? "File actions" : view === "playlist" ? "Add to playlist" : "Add to album"}
        header={<p className="m-0 truncate px-4 pt-1 pb-2 text-sm text-muted-foreground">{item.attachment.filename}</p>}>
        {error && <p role="alert" className="m-0 px-3 py-2 text-sm text-destructive">{error}</p>}
        {view === "menu" ? (
          <>
            {act("play")}
            {act("queue")}
            {item.kind === "audio" && <ActionSheetItem icon={<Plus />} onSelect={() => setView("playlist")}>Add to playlist</ActionSheetItem>}
            <ActionSheetItem icon={<Images />} onSelect={() => setView("album")}>Add to album</ActionSheetItem>
            {act("message")}
            {act("download")}
          </>
        ) : view === "playlist" ? (
          <PlaylistRows item={item} onNew={() => setDialog("playlist")} onDone={onClose} onError={onError} />
        ) : (
          <AlbumRows item={item} onError={onError} />
        )}
      </ActionSheet>
      {dialog === "playlist" && <NewPlaylistWith item={item} onClose={done} />}
    </>
  );
}
