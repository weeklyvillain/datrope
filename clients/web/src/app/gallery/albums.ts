import type { Album } from "@datrope/core";
import { useCallback, useEffect, useState } from "react";
import { client, errorText } from "../../session";

/** Albums I own or collaborate on, and other people's albums visible on the server; each keeps the server's order. */
export function groupAlbums(albums: Album[]): { yours: Album[]; server: Album[] } {
  return {
    yours: albums.filter((a) => a.role === "owner" || a.role === "collaborator"),
    server: albums.filter((a) => a.role !== "owner" && a.role !== "collaborator"),
  };
}

/** Add files to an album; resolves with a message when any failed, or nothing when all were added. */
export async function addAll(albumId: string, attachmentIds: string[]): Promise<string> {
  const results = await Promise.allSettled(attachmentIds.map((id) => client.addToAlbum(albumId, id)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length === 0) return "";
  const why = errorText(failed[0].reason);
  return attachmentIds.length === 1 ? why : `${failed.length} of ${attachmentIds.length} files weren't added to the album: ${why}`;
}

/** The albums I can see (with contains, whether each holds that file), kept fresh by album events. */
export function useAlbums(contains?: string) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    setError(undefined);
    client.albums(contains).then(setAlbums, (e) => setError(errorText(e))).finally(() => setLoading(false));
  }, [contains]);
  useEffect(reload, [reload]);
  useEffect(() => client.onEvent((type) => {
    if (type === "ALBUM_UPDATE" || type === "ALBUM_DELETE" || type === "ALBUM_ITEMS_UPDATE") reload();
  }), [reload]);
  return { albums, loading, error, reload };
}
