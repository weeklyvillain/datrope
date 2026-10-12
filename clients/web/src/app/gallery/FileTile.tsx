import { FileArchive, FileText, File as FileIcon, Hash, Music, Play } from "lucide-react";
import type { ReactNode } from "react";
import { UserAvatar } from "@/components/user-avatar";
import { attachmentImage } from "@/lib/sized-image";
import { cn } from "@/lib/utils";
import { client, displayName, formatBytes, useApp } from "../../session";
import { shownAuthor, type ShownAuthor } from "../message-author";
import { extension, KIND_SINGULAR } from "./kinds";
import { itemAuthor, itemTitle, type GalleryItem } from "./items";

/** Where a file was posted, as tagged: a thread's file shows its parent channel; undefined for album uploads. */
export function channelTag(item: GalleryItem): string | undefined {
  return item.channel ? item.channel.parent_name || item.channel.name : undefined;
}

/** A stable colour per file from the avatar palette tokens. */
export function discToken(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `var(--avatar-${(Math.abs(h) % 8) + 1})`;
}

export function tileLabel(item: GalleryItem, global: boolean, author: string): string {
  const base = `${KIND_SINGULAR[item.kind]}: ${itemTitle(item)}, by ${author}`;
  const tag = channelTag(item);
  return global && tag ? `${base}, in #${tag}` : base;
}

/** Who shared a file: the message's shown author, or for an album upload the member who uploaded it. */
export function useItemAuthor(item: GalleryItem): ShownAuthor {
  const members = useApp((s) => s.server?.members);
  return itemAuthor(item, members) ?? shownAuthor(undefined);
}

export function FileTile({ item, global, selected, playing, onOpen, onPlay, menu }: {
  item: GalleryItem; global: boolean; selected: boolean; playing: boolean;
  onOpen: () => void; onPlay?: () => void; menu?: ReactNode;
}) {
  const { attachment: a, kind } = item;
  const author = useItemAuthor(item);
  const tag = channelTag(item);
  const media = kind === "image" || kind === "video";
  return (
    <div className={cn("group relative aspect-square overflow-hidden rounded-md", media ? "bg-muted" : "border bg-card",
      (selected || playing) && "ring-2 ring-primary")}>
      <button type="button" onClick={onOpen} aria-label={tileLabel(item, global, displayName(author))}
        className="absolute inset-0 grid outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring">
        {media ? (
          kind === "video" && !a.thumbnail_url
            ? <video src={client.url(a.url)} preload="metadata" muted playsInline className="pointer-events-none size-full object-cover" />
            : <img {...attachmentImage(a, 240, { cover: true })} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <span className={cn("flex min-h-0 flex-col p-2.5 text-left", global ? "pt-9" : "pt-3")}>
            <span className="grid flex-1 place-items-center" aria-hidden>
              {kind === "audio" ? (
                <span className="grid size-16 place-items-center rounded-full text-foreground" style={{ background: discToken(a.id) }}>
                  <Music className="size-7" />
                </span>
              ) : (
                <span className="relative grid h-16 w-13 place-items-end justify-center rounded-md bg-secondary pb-2 text-[11px] font-bold text-foreground">
                  {kind === "archive" ? <FileArchive className="absolute top-2 size-5" /> : kind === "document" ? <FileText className="absolute top-2 size-5" /> : <FileIcon className="absolute top-2 size-5" />}
                  {extension(a.filename)}
                </span>
              )}
            </span>
            <span className="line-clamp-2 text-[13px] leading-tight font-semibold wrap-anywhere text-foreground">{a.filename}</span>
            <span className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {playing ? "Playing · " : ""}{formatBytes(a.size)} · {displayName(author)}
            </span>
          </span>
        )}
      </button>
      {global && tag && (
        <span className={cn("pointer-events-none absolute top-1.5 left-1.5 inline-flex h-5 max-w-[calc(100%-2.5rem)] items-center gap-0.5 rounded-full pr-2 pl-1 text-[11px] font-semibold text-foreground",
          media ? "bg-background/85" : "bg-muted")} aria-hidden>
          <Hash className="size-3 flex-none" /><span className="truncate">{tag}</span>
        </span>
      )}
      {media && <UserAvatar user={author} size="xs" className="pointer-events-none absolute bottom-1.5 left-1.5" />}
      {kind === "video" && (
        <span className="pointer-events-none absolute right-1.5 bottom-1.5 inline-flex h-5 items-center rounded bg-background/85 px-1.5 text-foreground" aria-hidden>
          <Play className="size-2.5 fill-current" />
        </span>
      )}
      {kind === "audio" && onPlay && (
        <button type="button" onClick={onPlay} aria-label={`Play ${a.filename}`}
          className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-md group-hover:opacity-100 focus-visible:opacity-100">
          <Play className="size-4 fill-current" />
        </button>
      )}
      {menu && <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">{menu}</div>}
    </div>
  );
}
