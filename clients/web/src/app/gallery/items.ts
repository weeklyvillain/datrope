import type { Attachment, FileItem, Message } from "@datrope/core";

/** A gallery tile: a file from /api/files. */
export type GalleryItem = FileItem;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const month = new Intl.DateTimeFormat("en", { month: "long" });

/** Groups newest-first items: the last 7 days under "This week", older ones by month
 *  ("September", or "September 2025" when it is not this year). */
export function sections<T extends { message: Message }>(items: T[], now: Date): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
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
export function itemTitle(it: { message: Message; attachment: Attachment }): string {
  return it.message.content.split("\n")[0].trim() || it.attachment.filename;
}

/** The audio files of a list (a list can briefly hold the previous filter's files). */
export const audioOnly = (items: GalleryItem[]) => items.filter((i) => i.kind === "audio");

/** What plays when one file is played from a list: the list's audio files, from that one. */
export function audioRun(items: GalleryItem[], item: GalleryItem): { run: GalleryItem[]; at: number } {
  const run = audioOnly(items);
  return { run, at: Math.max(0, run.indexOf(item)) };
}
