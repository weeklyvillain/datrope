import type { Message, PublicUser, WebhookAuthor } from "@datrope/core";

/** Who a message shows as: its author, or the webhook that posted it. Shaped for UserAvatar and displayName. */
export type ShownAuthor = { id: string; username: string; display_name: string; avatar_url?: string };

type Authored = Pick<Message, "author" | "webhook">;

const UNKNOWN: ShownAuthor = { id: "", username: "unknown", display_name: "Unknown" };

/** A webhook as a message author. Its ID is prefixed so it never matches a user's. */
export function webhookAuthor(w: WebhookAuthor): ShownAuthor {
  return { id: `webhook:${w.id ?? w.name}`, username: w.name, display_name: w.name, avatar_url: w.avatar_url };
}

/** The author to show: `live` (the user's current profile) when known, else the message's snapshot, or its webhook. */
export function shownAuthor(m: Authored | undefined, live?: PublicUser): ShownAuthor {
  if (m?.author) return live ?? m.author;
  return m?.webhook ? webhookAuthor(m.webhook) : UNKNOWN;
}

/** Consecutive messages with the same key share one header: the same user, or the same webhook under the same name. */
export function authorKey(m: Authored): string {
  return m.author ? `user:${m.author.id}` : `webhook:${m.webhook?.id ?? ""}:${m.webhook?.name ?? ""}`;
}
