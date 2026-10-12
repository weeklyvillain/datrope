import type { FilesParams, Message, ThreadUpdate } from "@datrope/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { client, errorText, useApp } from "../../session";
import type { GalleryFilter } from "./filter";
import type { GalleryItem } from "./items";

export type GalleryScope = { kind: "global" } | { kind: "channel"; channelId: string };

const PAGE = 50;

export function paramsFor(scope: GalleryScope, f: GalleryFilter): FilesParams {
  const q = f.q.trim();
  return {
    kinds: f.kind === "all" ? undefined : [f.kind],
    channels: scope.kind === "channel" ? [scope.channelId] : f.channels.length ? f.channels : undefined,
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
  return current.filter((c) => c.message.id !== messageId);
}

/** A thread started or changed on a message: its files carry the new summary. */
export function patchThread(current: GalleryItem[], d: ThreadUpdate): GalleryItem[] {
  return current.map((c) => (c.message.id === d.message_id ? { ...c, message: { ...c.message, thread: d.thread } } : c));
}

/** Pages through /api/files for a scope and filter; a message with files sent, edited or deleted
 *  in a channel this scope covers refetches the first page. */
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

  useEffect(() => {
    const g = ++gen.current;
    setLoading(true);
    setError(undefined);
    client.files({ ...JSON.parse(debouncedKey), limit: PAGE })
      .then((p) => { if (g === gen.current) { setItems(p.items ?? []); setCursor(p.next_cursor ?? undefined); } })
      .catch((e) => { if (g === gen.current) setError(errorText(e)); })
      .finally(() => { if (g === gen.current) setLoading(false); });
  }, [debouncedKey]);

  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    const g = gen.current;
    setLoading(true);
    setError(undefined);
    client.files({ ...JSON.parse(debouncedKey), before: cursor, limit: PAGE })
      .then((p) => { if (g === gen.current) { setItems((cur) => [...cur, ...(p.items ?? [])]); setCursor(p.next_cursor ?? undefined); } })
      .catch((e) => { if (g === gen.current) setError(errorText(e)); })
      .finally(() => { if (g === gen.current) setLoading(false); });
  }, [cursor, loading, debouncedKey]);

  useEffect(() => client.onEvent((type, data) => {
    if (type === "MESSAGE_DELETE") {
      setItems((cur) => dropMessage(cur, (data as { id: string }).id));
      return;
    }
    if (type === "THREAD_UPDATE") {
      setItems((cur) => patchThread(cur, data as ThreadUpdate));
      return;
    }
    if (type !== "MESSAGE_CREATE" && type !== "MESSAGE_UPDATE") return;
    const m = data as Message;
    if (!m.attachments?.length) return;
    const ch = channels[m.channel_id];
    const home = ch?.type === "thread" ? ch.parent_channel_id : m.channel_id;
    if (scope.kind === "channel" && home !== scope.channelId && m.channel_id !== scope.channelId) return;
    if (ch?.type === "dm") return;
    const g = gen.current;
    client.files({ ...JSON.parse(debouncedKey), limit: PAGE })
      .then((p) => { if (g === gen.current) setItems((cur) => mergeHead(cur, p.items ?? [])); })
      .catch(() => undefined);
  }), [channels, scope, debouncedKey]);

  return { items, hasMore: !!cursor, loading, error, loadMore };
}
