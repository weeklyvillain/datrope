import type { Attachment, FileItem, Message, PublicUser } from "@datrope/core";
import { shownAuthor, type ShownAuthor } from "../message-author";

/** A gallery tile: a file from /api/files or an album. */
export type GalleryItem = FileItem;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const month = new Intl.DateTimeFormat("en", { month: "long" });

/** Groups newest-first items by upload time: the last 7 days under "This week", older ones by month
 *  ("September", or "September 2025" when it is not this year). */
export function sections<T extends { created_at: string }>(items: T[], now: Date): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const at = new Date(item.created_at);
    const label = now.getTime() - at.getTime() < WEEK_MS ? "This week"
      : at.getFullYear() === now.getFullYear() ? month.format(at) : `${month.format(at)} ${at.getFullYear()}`;
    const last = out.at(-1);
    if (last?.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

/** The caption's first line, or the file name. */
export function itemTitle(it: { message?: Message | null; attachment: Attachment }): string {
  return it.message?.content.split("\n")[0].trim() || it.attachment.filename;
}

/** Who shared a file: the message's shown author, or the member who uploaded it. */
export function itemAuthor(it: GalleryItem, members?: Record<string, { user: PublicUser }>): ShownAuthor | undefined {
  return it.message ? shownAuthor(it.message) : members?.[it.uploader_id]?.user;
}

/** The channel a file was posted in, a thread's file counting as its parent's. */
export function itemHome(it: GalleryItem): string | undefined {
  return it.channel ? it.channel.parent_id || it.channel.id : undefined;
}

/** The audio files of a list (a list can briefly hold the previous filter's files). */
export const audioOnly = (items: GalleryItem[]) => items.filter((i) => i.kind === "audio");

/** What plays when one file is played from a list: the list's audio files, from that one. */
export function audioRun(items: GalleryItem[], item: GalleryItem): { run: GalleryItem[]; at: number } {
  const run = audioOnly(items);
  return { run, at: Math.max(0, run.indexOf(item)) };
}
