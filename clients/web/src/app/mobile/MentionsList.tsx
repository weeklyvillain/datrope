import { channelRef, type MentionItem } from "@datrope/core";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { client, displayName, dmName, errorText, roleColor, useApp } from "../../session";
import { Markdown } from "@/chat/Markdown";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import { WebhookAvatar } from "@/components/webhook-avatar";
import { useMessageAuthor } from "@/hooks/use-message-author";
import { openMessage } from "../jump";
import { stamp } from "../MessageList";
import { WebhookBadge } from "../WebhookAuthor";

/** The messages that mention me: header with "Mark all read", items, "Load older". Shared by the inbox popover and the Mentions page. */
export function MentionsList({ onJump, title = true }: { onJump?: () => void; title?: boolean }) {
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const unread = useApp((s) => s.mentions.unread);
  const items = useApp((s) => s.mentions.items);
  const hasMore = useApp((s) => s.mentions.hasMore);
  const navigate = useNavigate();
  const run = (p: Promise<unknown>) => p.then(() => setError(undefined), (e) => setError(errorText(e)));
  // PopoverContent unmounts on close, so the popover reloads on every open.
  useEffect(() => { void run(client.loadMentions()); }, []);
  return (
    <>
      <div className={`flex items-center border-b px-4 py-2.5 ${title ? "justify-between" : "justify-end"}`}>
        {title && <h3 className="m-0 text-body font-semibold normal-case text-foreground">Mentions</h3>}
        <Button variant="ghost" size="sm" disabled={unread === 0} onClick={() => void run(client.markMentionsRead())}>Mark all read</Button>
      </div>
      {error && <div className="px-4 pt-2"><ErrorText error={error} /></div>}
      {items.map((item) => (
        <InboxItem key={item.message.id} item={item} onJump={() => {
          openMessage(navigate, item.channel, item.message.id);
          onJump?.();
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
    </>
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
  const author = useMessageAuthor(m);
  const color = useApp((s) => (where.type === "dm" || !m.author ? undefined : roleColor(s.server, m.author.id)));
  const text = where.type === "dm" ? place
    : where.type === "thread" ? `# ${where.parent_name ?? ""} · thread${where.name ? ` "${where.name}"` : ""}`
    : `# ${where.name}`;
  return (
    <div className="min-h-11 border-b px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        {item.unread && <span role="img" aria-label="Unread" className="size-2 flex-none rounded-full bg-destructive" />}
        <span className="min-w-0 flex-1 truncate">{text}</span>
        <Button variant="outline" size="xs" aria-label={`Jump to message from ${displayName(author)}`} onClick={onJump}>Jump</Button>
      </div>
      <div className="flex gap-2.5">
        {m.author ? <UserAvatar user={author} size="md" /> : <WebhookAvatar avatarUrl={m.webhook?.avatar_url} size="md" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold" style={{ color }}>{displayName(author)}</span>
            {!m.author && <WebhookBadge />}
            <time className="flex-none text-xs text-muted-foreground" dateTime={m.created_at}>{stamp(new Date(m.created_at))}</time>
          </div>
          <div className="line-clamp-3 text-sm wrap-anywhere">
            <Markdown text={m.content} inline mentions={m.mentions ?? undefined} roles={m.mention_roles ?? undefined} everyone={!!m.mention_everyone} />
          </div>
        </div>
      </div>
    </div>
  );
}
