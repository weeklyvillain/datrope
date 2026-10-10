import type { Message } from "@datrope/core";
import { shownAuthor, type ShownAuthor } from "@/app/message-author";
import { useUser } from "./use-user";

/** Who a message shows as, following its author's live profile. */
export function useMessageAuthor(m: Pick<Message, "author" | "webhook"> | undefined): ShownAuthor {
  const live = useUser(m?.author?.id ?? "");
  return shownAuthor(m, live);
}
