import { Perm, canPost, hasPerm } from "@datrope/core";
import { Images, Play, Upload } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { client, displayName, errorText, useApp, usePerms } from "../../session";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { shownAuthor } from "../message-author";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Toggle } from "@/components/ui/toggle";
import { useChannelFeed } from "@/hooks/use-channel-feed";
import { useWindowFocus } from "@/hooks/use-window-focus";
import { cn } from "@/lib/utils";
import { Topic } from "../ChannelView";
import { SearchPanel } from "../search/SearchPanel";
import { TopBar } from "../TopBar";
import { closePanel, openPanel, panelStore, usePanel } from "../side-panel/panel";
import { ThreadPanel } from "../side-panel/ThreadPanel";
import { GalleryItemPanel } from "./GalleryItemPanel";
import { galleryItems, itemTitle, sections, type GalleryFilter, type GalleryItem } from "./items";
import { EmojiText } from "@/chat/EmojiText";
import { EmptyView } from "../EmptyView";
import { UploadDialog } from "./UploadDialog";

const chip = "h-7 rounded-full px-3 text-[13px] font-normal text-muted-foreground data-[state=on]:border-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground";
const note = "m-0 p-8 text-center text-sm text-muted-foreground";
const KINDS = [["all", "All"], ["photo", "Photos"], ["video", "Videos"]] as const;

/** A gallery: a grid of photos and videos, newest first; an item opens in the side panel. */
export function GalleryView({ channelId }: { channelId: string }) {
  const ch = useApp((s) => s.channels[channelId]);
  const list = useApp((s) => s.messages[channelId]);
  const perms = usePerms(channelId);
  const panel = usePanel((s) => s.panel);
  const loadError = useChannelFeed(channelId);
  const uploaderId = useId();
  const [kind, setKind] = useState<GalleryFilter["kind"]>("all");
  const [uploader, setUploader] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [moreError, setMoreError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    // A thread, a post, a gallery item or the threads list belongs to its channel; a profile (and search) stays open.
    // A thread opened from a search result is opened along with its parent channel, so it stays.
    const p = panelStore.getState().panel;
    if (p?.kind === "threads" || p?.kind === "post" || p?.kind === "media" || (p?.kind === "thread" && p.parentId !== channelId)) closePanel();
  }, [channelId]);

  // Pending uploads show once the server has them, so every tile has a real message ID.
  const confirmed = useMemo(() => (list?.items ?? []).filter((m) => !m.pending), [list]);
  const everything = useMemo(() => galleryItems(confirmed, { kind: "all", uploader: null }), [confirmed]);
  const shown = useMemo(() => galleryItems(confirmed, { kind, uploader }), [confirmed, kind, uploader]);
  const groups = useMemo(() => sections(shown, new Date()), [shown]);
  const uploaders = useMemo(() => {
    const seen = new Map<string, string>();
    for (const it of everything) if (it.message.author) seen.set(it.message.author.id, displayName(it.message.author));
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [everything]);

  // Seeing the gallery marks it read: its newest item is at the top.
  const newest = confirmed.at(-1)?.id;
  const detached = !!list?.hasNewer;
  const focused = useWindowFocus();
  useEffect(() => {
    if (newest && !detached && focused) client.ack(channelId, newest).catch(() => undefined);
  }, [channelId, newest, detached, focused]);

  if (!ch) return <EmptyView>This channel is not available.</EmptyView>;
  const canUpload = canPost(ch, perms) && hasPerm(perms, Perm.AttachFiles);
  const selected = panel?.kind === "media" ? panel : undefined;
  const loadMore = () => {
    setLoadingMore(true);
    setMoreError(undefined);
    client.loadOlder(channelId).catch((e) => setMoreError(errorText(e))).finally(() => setLoadingMore(false));
  };

  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-background" aria-label={ch.name}>
        <TopBar actions={canUpload && <Button size="sm" onClick={() => setUploading(true)}><Upload /> Upload</Button>}>
          <Images className="size-4 flex-none text-muted-foreground" aria-hidden />
          <h2 className="flex-none"><EmojiText text={ch.name} /></h2>
          {ch.topic && <Topic channelId={channelId} name={ch.name} topic={ch.topic} canEdit={hasPerm(perms, Perm.ManageChannels)} />}
        </TopBar>

        <div className="flex flex-none flex-wrap items-center gap-2 border-b px-4 py-3">
          <div role="group" aria-label="Show" className="flex gap-1.5">
            {KINDS.map(([k, label]) => (
              <Toggle key={k} variant="outline" size="sm" className={chip} pressed={kind === k} onPressedChange={() => setKind(k)}>{label}</Toggle>
            ))}
          </div>
          <span className="flex-1" />
          <label htmlFor={uploaderId} className="text-[13px] text-muted-foreground">Uploaded by</label>
          <NativeSelect id={uploaderId} size="sm" value={uploader ?? ""} onChange={(e) => setUploader(e.target.value || null)}>
            <NativeSelectOption value="">Anyone</NativeSelectOption>
            {uploaders.map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
          </NativeSelect>
          <span className="text-[13px] text-muted-foreground">{shown.length === 1 ? "1 item" : `${shown.length} items`}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loadError ? <div className="p-4"><ErrorText error={loadError} /></div>
            : !list ? <p className={note}>Loading…</p>
            : (
              <div className="grid content-start gap-6 p-4">
                {everything.length === 0 ? <p className={note}>No photos or videos yet.</p>
                  : shown.length === 0 ? <p className={note}>No items match.</p>
                  : groups.map((g) => (
                    <section key={g.label} aria-label={g.label}>
                      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.label}</h3>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
                        {g.items.map((it) => (
                          <Tile key={it.attachment.id} item={it}
                            selected={selected?.attachmentId === it.attachment.id}
                            onOpen={() => openPanel({ kind: "media", messageId: it.message.id, attachmentId: it.attachment.id })} />
                        ))}
                      </div>
                    </section>
                  ))}
                {list.hasMore && (
                  <div className="grid justify-items-center gap-2">
                    <Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>Load more</Button>
                    <ErrorText error={moreError} />
                  </div>
                )}
              </div>
            )}
        </div>
      </main>
      {selected ? (
        <GalleryItemPanel key={selected.attachmentId} channelId={channelId} messageId={selected.messageId}
          attachmentId={selected.attachmentId} items={shown} onClose={closePanel} />
      ) : panel?.kind === "thread" ? (
        <ThreadPanel key={panel.threadId} threadId={panel.threadId} parentChannelId={channelId} onClose={closePanel} />
      ) : panel?.kind === "search" ? (
        <SearchPanel />
      ) : null}
      {uploading && <UploadDialog channelId={channelId} onClose={() => setUploading(false)} />}
    </>
  );
}

function Tile({ item, selected, onOpen }: { item: GalleryItem; selected: boolean; onOpen: () => void }) {
  const { attachment: a, message: m } = item;
  return (
    <button type="button" onClick={onOpen}
      aria-label={`${item.kind === "video" ? "Video" : "Photo"}: ${itemTitle(item)}, by ${displayName(shownAuthor(m))}`}
      className={cn("relative aspect-square overflow-hidden rounded-md bg-muted outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-primary")}>
      {item.kind === "video" && !a.thumbnail_url ? (
        <video src={client.url(a.url)} preload="metadata" muted playsInline className="pointer-events-none size-full object-cover" />
      ) : (
        <img src={client.url(a.thumbnail_url ?? a.url)} alt="" loading="lazy" className="size-full object-cover" />
      )}
      <UserAvatar user={shownAuthor(m)} size="xs" className="absolute bottom-1.5 left-1.5" />
      {item.kind === "video" && (
        <span className="absolute right-1.5 bottom-1.5 inline-flex h-5 items-center rounded bg-background/85 px-1.5 text-foreground" aria-hidden>
          <Play className="size-2.5 fill-current" />
        </span>
      )}
    </button>
  );
}