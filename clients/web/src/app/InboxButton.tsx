import { channelRef, type MentionItem } from "@datrope/core";
import { AtSign } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { client, displayName, dmName, errorText, roleColor, useApp } from "../session";
import { Markdown } from "@/chat/Markdown";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { useUser } from "@/hooks/use-user";
import { openMessage } from "./jump";
import { stamp } from "./MessageList";

/** The header's "Inbox" button: an unread count badge, and a popover listing the messages that mention me. */
export function InboxButton() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const unread = useApp((s) => s.mentions.unread);
  const items = useApp((s) => s.mentions.items);
  const hasMore = useApp((s) => s.mentions.hasMore);
  const navigate = useNavigate();

  const run = (p: Promise<unknown>) => p.then(() => setError(undefined), (e) => setError(errorText(e)));
  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) void run(client.loadMentions());
  };
  const label = unread > 0 ? `Inbox, ${unread > 99 ? "99+" : unread} unread` : "Inbox";

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex">
            <PopoverTrigger asChild>
              <RefButton variant="ghost" size="icon-sm" aria-label="Inbox" aria-expanded={open} aria-describedby={unread > 0 ? "inbox-unread" : undefined}
                className={open ? "relative text-foreground" : "relative text-muted-foreground"}>
                <AtSign />
                {unread > 0 && <span id="inbox-unread" className="sr-only">{unread > 99 ? "99+" : unread} unread</span>}
                {unread > 0 && (
                  <span aria-hidden className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-mention px-1 text-[10px] font-semibold leading-4 text-mention-foreground">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </RefButton>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="max-h-[70vh] w-[420px] max-w-[95vw] overflow-y-auto p-0" aria-label="Inbox">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h3 className="m-0 text-[15px] font-semibold normal-case text-foreground">Mentions</h3>
          <Button variant="ghost" size="sm" disabled={unread === 0} onClick={() => void run(client.markMentionsRead())}>Mark all read</Button>
        </div>
        {error && <div className="px-4 pt-2"><ErrorText error={error} /></div>}
        {items.map((item) => (
          <InboxItem key={item.message.id} item={item} onJump={() => {
            openMessage(navigate, item.channel, item.message.id);
            setOpen(false);
          }} />
        ))}
        {items.length === 0 && !error && <p className="m-0 p-6 text-center text-sm text-muted-foreground">Nobody has mentioned you yet.</p>}
        {hasMore && (
          <div className="p-2 text-center">
            <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => {
              setLoadingMore(true);
              void run(client.loadOlderMentions()).finally(() => setLoadingMore(false));
            }}>{loadingMore ? "Loading…" : "Load older"}</Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function InboxItem({ item, onJump }: { item: MentionItem; onJump: () => void }) {
  const m = item.message;
  // A thread mention that arrived live has no parent yet (threads are not in READY): fetch the thread, which stores it.
  const orphan = item.channel.type === "thread" && !item.channel.parent_id;
  useEffect(() => {
    if (orphan && !client.store.getState().channels[item.channel.id]) client.getChannel(item.channel.id).catch(() => undefined);
  }, [orphan, item.channel.id]);
  const resolved = useApp((s) => (orphan && s.channels[item.channel.id] ? channelRef(s, item.channel.id) : undefined));
  const where = resolved ?? item.channel;
  const place = useApp((s) => (where.type === "dm" ? (s.channels[where.id] ? dmName(s.channels[where.id], s.me?.id) : "Direct message") : undefined));
  const author = useUser(m.author.id, m.author) ?? m.author;
  const color = useApp((s) => (where.type === "dm" ? undefined : roleColor(s.server, m.author.id)));
  const text = where.type === "dm" ? place
    : where.type === "thread" ? `# ${where.parent_name ?? ""} · thread${where.name ? ` "${where.name}"` : ""}`
    : `# ${where.name}`;
  return (
    <div className="border-b px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        {item.unread && <span role="img" aria-label="Unread" className="size-2 flex-none rounded-full bg-destructive" />}
        <span className="min-w-0 flex-1 truncate">{text}</span>
        <Button variant="outline" size="xs" aria-label={`Jump to message from ${displayName(author)}`} onClick={onJump}>Jump</Button>
      </div>
      <div className="flex gap-2.5">
        <UserAvatar user={author} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold" style={{ color }}>{displayName(author)}</span>
            <time className="flex-none text-xs text-muted-foreground" dateTime={m.created_at}>{stamp(new Date(m.created_at))}</time>
          </div>
          <div className="line-clamp-3 text-sm wrap-anywhere">
            <Markdown text={m.content} inline mentions={m.mentions ?? undefined} />
          </div>
        </div>
      </div>
    </div>
  );
}
