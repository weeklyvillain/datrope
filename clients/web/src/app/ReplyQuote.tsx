import type { ReplyRef } from "@datrope/core";
import { Reply } from "lucide-react";
import { displayName } from "../session";

/** The line above a reply: the original's author and first line. Clicking it jumps to the original. */
export function ReplyQuote({ reply, onJump }: { reply: ReplyRef; onJump: () => void }) {
  return (
    <button type="button" onClick={onJump}
      className="col-start-2 mb-0.5 flex min-w-0 items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground">
      <Reply className="size-3.5 flex-none" aria-hidden="true" />
      {reply.deleted ? (
        <em>Original message deleted</em>
      ) : (
        <>
          <span className="flex-none font-semibold text-foreground">{displayName(reply.author)}</span>
          <span className="truncate">{reply.content.split("\n")[0]}</span>
        </>
      )}
    </button>
  );
}
