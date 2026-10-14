import type { ThreadListItem } from "@datrope/core";
import { MessageSquare } from "lucide-react";
import { displayName } from "../../session";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/user-avatar";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { timeAgo } from "../threads";

/** One post in a forum's list: title, excerpt, tags and author; people, replies and last activity. */
export function PostRow({ post, selected, onOpen }: { post: ThreadListItem; selected: boolean; onOpen: () => void }) {
  const { channel, summary } = post;
  const replies = summary.message_count - 1; // the post body is the first message
  const mobile = useIsMobile();
  if (mobile) {
    return (
      <li className="border-b">
        <button type="button" onClick={onOpen} aria-current={selected || undefined}
          className={cn("min-h-[44px] w-full px-4 py-3 text-left outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
            selected && "bg-accent hover:bg-accent")}>
          <span className="line-clamp-2 font-medium">{channel.name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {(channel.tags ?? []).map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
            {post.author && <span>{displayName(post.author)}</span>}
            <span>{replies === 1 ? "1 reply" : `${Math.max(replies, 0)} replies`}</span>
            {summary.last_message_at && <span>{timeAgo(summary.last_message_at)}</span>}
          </span>
        </button>
      </li>
    );
  }
  return (
    <li className="border-b">
      <button type="button" onClick={onOpen} aria-current={selected || undefined}
        className={cn("grid w-full grid-cols-[minmax(0,1fr)_72px_80px_96px] items-center gap-4 px-4 py-3 text-left outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
          selected && "bg-accent hover:bg-accent")}>
        <span className="min-w-0">
          <span className="block truncate font-semibold">{channel.name}</span>
          {post.excerpt && <span className="mt-0.5 block truncate text-sm text-muted-foreground">{post.excerpt}</span>}
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
            {(channel.tags ?? []).map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
            {post.author && <span>by {displayName(post.author)}</span>}
          </span>
        </span>
        <span className="flex justify-end">
          {(summary.participants ?? []).slice(0, 3).map((u, i) => (
            <UserAvatar key={u.id} user={u} size="xs" className={cn("ring-2", selected ? "ring-accent" : "ring-background", i > 0 && "-ml-1.5")} />
          ))}
        </span>
        <span className="flex items-center justify-end gap-1.5 text-sm text-muted-foreground">
          {replies > 0
            ? <><MessageSquare className="size-3.5" aria-hidden />{replies}<span className="sr-only">{replies === 1 ? " reply" : " replies"}</span></>
            : <span className="text-[13px]">No replies</span>}
        </span>
        <span className="text-right text-[13px] text-muted-foreground">{summary.last_message_at ? timeAgo(summary.last_message_at) : ""}</span>
      </button>
    </li>
  );
}
