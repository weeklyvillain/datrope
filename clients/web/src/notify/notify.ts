import { mentionsMe } from "@datrope/core";
import type { NotifyPrefs } from "./prefs";

export interface NotifyInput {
  message: { author?: { id: string }; mentions?: string[] | null; mention_roles?: string[] | null; mention_everyone?: boolean; channel_id: string; deleted?: boolean };
  meId: string | undefined;
  myRoleIds: readonly string[];
  isDM: boolean;
  prefs: NotifyPrefs;
  permission: NotificationPermission | "unsupported";
  hidden: boolean; // document.visibilityState === "hidden"
  openChannelIds: string[]; // the conversation on screen and an open thread
}

/** Whether a new message deserves a system notification (spec M8; mockup Inbox.html 5). */
export function shouldNotify(i: NotifyInput): boolean {
  if (!i.meId || i.message.author?.id === i.meId || i.message.deleted) return false;
  if (!i.prefs.enabled || i.permission !== "granted" || i.prefs.level === "nothing") return false;
  if (i.prefs.level === "mentions" && !i.isDM && !mentionsMe(i.message, i.meId, i.myRoleIds)) return false;
  return i.hidden || !i.openChannelIds.includes(i.message.channel_id);
}

/** The name a notification shows: a webhook is labelled, so it cannot pass for a person. */
export function notificationAuthor(name: string, webhook: boolean): string {
  return webhook ? `${name} (webhook)` : name;
}

export function notificationTitle(author: string, where: { type: string; name: string; parent_name?: string }): string {
  if (where.type === "dm") return `${author} (direct message)`;
  const name = where.type === "thread" ? where.parent_name || where.name : where.name;
  return name ? `${author} in #${name}` : `${author} in a thread`;
}

const MAX = 120;

/** The message as plain text, cut to 120 characters. */
export function notificationBody(content: string, attachments: number): string {
  const text = content
    .replace(/\|\|[\s\S]+?\|\|/g, "(spoiler)")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(^|[\s(])([*_])([^*_\n]+)\2(?=$|[\s).,!?:;])/g, "$1$3")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return attachments === 0 ? "" : attachments === 1 ? "Sent a file" : `Sent ${attachments} files`;
  const chars = Array.from(text);
  return chars.length <= MAX ? text : chars.slice(0, MAX - 1).join("") + "…";
}

const CLAIMED_CAP = 200;

/** Claims a message for notifying: returns the updated list of claimed IDs, or null when another tab already claimed it. */
export function claimMessage(claimed: string[], id: string): string[] | null {
  if (claimed.includes(id)) return null;
  return [...claimed, id].slice(-CLAIMED_CAP);
}
