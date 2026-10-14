import type { Album } from "@datrope/core";
import { useCallback, useEffect, useState } from "react";
import { client, errorText } from "../../session";

/** Add files to an album; resolves with a message when any failed, or nothing when all were added. */
export async function addAll(albumId: string, attachmentIds: string[]): Promise<string> {
  const results = await Promise.allSettled(attachmentIds.map((id) => client.addToAlbum(albumId, id)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length === 0) return "";
  const why = errorText(failed[0].reason);
  return attachmentIds.length === 1 ? why : `${failed.length} of ${attachmentIds.length} files weren't added to the album: ${why}`;
}

/** Keeps a list of albums fresh: refetched on any album event. */
function useAlbumList(load: () => Promise<Album[]>) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    setError(undefined);
    load().then(setAlbums, (e) => setError(errorText(e))).finally(() => setLoading(false));
  }, [load]);
  useEffect(reload, [reload]);
  useEffect(() => client.onEvent((type) => {
    if (type === "ALBUM_UPDATE" || type === "ALBUM_DELETE" || type === "ALBUM_ITEMS_UPDATE") reload();
  }), [reload]);
  return { albums, loading, error, reload };
}

/** A gallery's albums I can see, each with its deck. */
export function useGalleryAlbums(galleryId: string) {
  return useAlbumList(useCallback(() => client.galleryAlbums(galleryId), [galleryId]));
}

/** The albums I can add this file to, each saying whether it holds it. */
export function useAlbumsForFile(attachmentId: string) {
  return useAlbumList(useCallback(() => client.albumsForFile(attachmentId), [attachmentId]));
}
