import type { FilesParams, Message, ThreadUpdate } from "@datrope/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { client, errorText, useApp } from "../../session";
import type { GalleryFilter } from "./filter";
import type { GalleryItem } from "./items";
import { inGallery } from "./sources";

export type GalleryScope = { kind: "gallery"; channelId: string } | { kind: "album"; albumId: string; galleryId: string };

const PAGE = 50;

export function paramsFor(scope: GalleryScope, f: GalleryFilter): FilesParams {
  const q = f.q.trim();
  return {
    ...(scope.kind === "gallery" && { gallery: scope.channelId }),
    kinds: f.kind === "all" ? undefined : [f.kind],
    channels: scope.kind === "gallery" && f.channels.length ? f.channels : undefined,
    q: q || undefined,
    uploader: f.uploader ?? undefined,
  };
}

/** The first page fetched again, merged over what is shown: new files first, one copy each. */
export function mergeHead(current: GalleryItem[], head: GalleryItem[]): GalleryItem[] {
  const fresh = new Map(head.map((h) => [h.attachment.id, h]));
  return [...head, ...current.filter((c) => !fresh.has(c.attachment.id))];
}

export function dropMessage(current: GalleryItem[], messageId: string): GalleryItem[] {
  return current.filter((c) => c.message?.id !== messageId);
}

/** A message update marked some of its files expired: they leave the wall. */
export function dropExpired(current: GalleryItem[], m: Message): GalleryItem[] {
  const gone = new Set((m.attachments ?? []).filter((a) => a.expired).map((a) => a.id));
  return gone.size ? current.filter((c) => !gone.has(c.attachment.id)) : current;
}

/** A thread started or changed on a message: its files carry the new summary. */
export function patchThread(current: GalleryItem[], d: ThreadUpdate): GalleryItem[] {
  return current.map((c) => (c.message?.id === d.message_id && c.message ? { ...c, message: { ...c.message, thread: d.thread } } : c));
}

/** Pages through /api/files for a scope and filter; a message with files sent, edited or deleted
 *  in a channel this gallery shows refetches the first page. */
export function useFiles(scope: GalleryScope, f: GalleryFilter) {
  const params = paramsFor(scope, f);
  const key = JSON.stringify(params);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const gen = useRef(0);
  const channels = useApp((s) => s.channels);

  // Any filter change waits 250 ms before fetching, so typing in the search box doesn't fetch per keystroke.
  const [debouncedKey, setDebouncedKey] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(key), 250);
    return () => clearTimeout(t);
  }, [key]);

  const fetchPage = useCallback((p: FilesParams) =>
    scope.kind === "album" ? client.albumFiles(scope.albumId, p) : client.files(p), [scope]);

  useEffect(() => {
    const g = ++gen.current;
    setLoading(true);
    setError(undefined);
    fetchPage({ ...JSON.parse(debouncedKey), limit: PAGE })
      .then((p) => { if (g === gen.current) { setItems(p.items ?? []); setCursor(p.next_cursor ?? undefined); } })
      .catch((e) => { if (g === gen.current) setError(errorText(e)); })
      .finally(() => { if (g === gen.current) setLoading(false); });
  }, [debouncedKey, fetchPage]);

  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    const g = gen.current;
    setLoading(true);
    setError(undefined);
    fetchPage({ ...JSON.parse(debouncedKey), before: cursor, limit: PAGE })
      .then((p) => { if (g === gen.current) { setItems((cur) => [...cur, ...(p.items ?? [])]); setCursor(p.next_cursor ?? undefined); } })
      .catch((e) => { if (g === gen.current) setError(errorText(e)); })
      .finally(() => { if (g === gen.current) setLoading(false); });
  }, [cursor, loading, debouncedKey, fetchPage]);

  useEffect(() => client.onEvent((type, data) => {
    if (type === "MESSAGE_DELETE") {
      setItems((cur) => dropMessage(cur, (data as { id: string }).id));
      return;
    }
    if (type === "THREAD_UPDATE") {
      setItems((cur) => patchThread(cur, data as ThreadUpdate));
      return;
    }
    if (type === "MESSAGE_UPDATE") setItems((cur) => dropExpired(cur, data as Message));
    if (scope.kind === "album") {
      if (type === "ALBUM_ITEMS_UPDATE" && (data as { album_id: string }).album_id === scope.albumId) {
        const g = ++gen.current; // also drops any in-flight page that would append onto the replaced list
        fetchPage({ ...JSON.parse(debouncedKey), limit: PAGE })
          .then((p) => { if (g === gen.current) { setItems(p.items ?? []); setCursor(p.next_cursor ?? undefined); } })
          .catch(() => undefined);
      }
      return;
    }
    if (type !== "MESSAGE_CREATE" && type !== "MESSAGE_UPDATE") return;
    const m = data as Message;
    if (!m.attachments?.length) return;
    const ch = channels[m.channel_id];
    if (ch?.type === "dm") return;
    const home = ch?.type === "thread" ? ch.parent_channel_id ?? m.channel_id : m.channel_id;
    const gallery = channels[scope.channelId];
    if (!gallery || !inGallery(gallery, home)) return;
    const g = gen.current;
    fetchPage({ ...JSON.parse(debouncedKey), limit: PAGE })
      .then((p) => { if (g === gen.current) setItems((cur) => mergeHead(cur, p.items ?? [])); })
      .catch(() => undefined);
  }), [channels, scope, debouncedKey, fetchPage]);

  return { items, hasMore: !!cursor, loading, error, loadMore };
}
