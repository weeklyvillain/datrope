import type { Attachment, Message } from "@datrope/core";

export type GalleryItem = { message: Message; attachment: Attachment; kind: "photo" | "video" };
export type GalleryFilter = { kind: "all" | "photo" | "video"; uploader: string | null };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const month = new Intl.DateTimeFormat("en", { month: "long" });

/** Whether a gallery accepts this file type: photos and videos only. */
export function isMedia(contentType: string): boolean {
  return contentType.startsWith("image/") || contentType.startsWith("video/");
}

// Photo and video extensions the server recognises, for files the browser reports no type for.
const MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "mp4", "m4v", "mov", "webm", "mkv"]);

/** Whether a picked file is a photo or video: its type, or its extension when the browser gives no type. */
export function isMediaFile(file: { type: string; name: string }): boolean {
  if (file.type) return isMedia(file.type);
  return MEDIA_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() ?? "");
}

/** One item per photo or video in `messages` (oldest first, as the store keeps them), newest first.
 *  Deleted messages are skipped; `uploader` is a user ID. */
export function galleryItems(messages: Message[], f: GalleryFilter): GalleryItem[] {
  const items: GalleryItem[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.deleted || (f.uploader !== null && message.author?.id !== f.uploader)) continue;
    for (const attachment of message.attachments ?? []) {
      if (!isMedia(attachment.content_type)) continue;
      const kind = attachment.content_type.startsWith("video/") ? "video" : "photo";
      if (f.kind === "all" || f.kind === kind) items.push({ message, attachment, kind });
    }
  }
  return items;
}

/** Groups newest-first items: the last 7 days under "This week", older ones by month
 *  ("September", or "September 2025" when it is not this year). */
export function sections(items: GalleryItem[], now: Date): { label: string; items: GalleryItem[] }[] {
  const out: { label: string; items: GalleryItem[] }[] = [];
  for (const item of items) {
    const at = new Date(item.message.created_at);
    const label = now.getTime() - at.getTime() < WEEK_MS ? "This week"
      : at.getFullYear() === now.getFullYear() ? month.format(at) : `${month.format(at)} ${at.getFullYear()}`;
    const last = out.at(-1);
    if (last?.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

/** The caption's first line, or the file name. */
export function itemTitle(it: GalleryItem): string {
  return it.message.content.split("\n")[0].trim() || it.attachment.filename;
}
