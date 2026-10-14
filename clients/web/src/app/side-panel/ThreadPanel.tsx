import { Perm, hasPerm, myThreadPerms } from "@datrope/core";
import { useEffect, useState } from "react";
import { client, displayName, errorText, roleColor, useApp } from "../../session";
import { Markdown } from "@/chat/Markdown";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { WebhookAvatar } from "@/components/webhook-avatar";
import { useMessageAuthor } from "@/hooks/use-message-author";
import { useChannelFeed } from "@/hooks/use-channel-feed";
import { Composer } from "../Composer";
import { Attachments, MessageList, type ReplyState } from "../MessageList";
import { repliesText } from "../threads";
import { WebhookBadge } from "../WebhookAuthor";
import { SidePanel } from "./SidePanel";
import { Skeleton } from "@/components/ui/skeleton";
import { ListSkeleton } from "@/components/loading-skeleton";

/** Inside a thread nobody replies to a single message. */
const NO_REPLY: ReplyState = { replyTo: null, setReplyTo: () => undefined };
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** A thread in the side panel: its parent message, its replies and a composer.
 *  A thread uses its parent channel's permissions. */
export function ThreadPanel({ threadId, parentChannelId, onClose }: { threadId: string; parentChannelId: string; onClose: () => void }) {
  const thread = useApp((s) => s.channels[threadId]);
  const parentName = useApp((s) => s.channels[parentChannelId]?.name);
  // A thread uses its parent channel's permissions, without a webhook channel's mask.
  const perms = useApp((s) => myThreadPerms(s, parentChannelId));
  const [error, setError] = useState<string>();

  // A thread I have not seen yet (e.g. opened from the threads list) is fetched once.
  useEffect(() => {
    if (!client.store.getState().channels[threadId]) client.getChannel(threadId).catch((e) => setError(errorText(e)));
  }, [threadId]);

  return (
    <SidePanel title="Thread" subtitle={parentName ? `in #${parentName}` : undefined} onClose={onClose}>
      {thread ? (
        <ThreadBody threadId={threadId} parentChannelId={parentChannelId} parentMessageId={thread.parent_message_id} perms={perms} />
      ) : error ? (
        <div className="p-4"><ErrorText error={error} /></div>
      ) : (
        <ListSkeleton />
      )}
    </SidePanel>
  );
}

function ThreadBody({ threadId, parentChannelId, parentMessageId, perms }: {
  threadId: string; parentChannelId: string; parentMessageId?: string; perms: number;
}) {
  const loadError = useChannelFeed(threadId);
  const replies = useApp((s) => s.messages[threadId]?.items.filter((m) => !m.pending && !m.deleted).length ?? 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ParentMessage channelId={parentChannelId} messageId={parentMessageId} />
      <ReplyCount channelId={parentChannelId} messageId={parentMessageId} fallback={replies} />
      {loadError ? <ErrorText error={loadError} /> : (
        <MessageList channelId={threadId} canManage={hasPerm(perms, Perm.ManageMessages)} canReply={false}
          canReact={hasPerm(perms, Perm.AddReactions)} reply={NO_REPLY} unreadLine={false} />
      )}
      <Composer channelId={threadId} canSend={hasPerm(perms, Perm.SendMessages)} canAttach={hasPerm(perms, Perm.AttachFiles)}
        placeholder="Reply in thread" label="Reply in thread" reply={NO_REPLY} />
    </div>
  );
}

/** The divider under the parent message: the summary's count, or the loaded replies when the parent is gone. */
function ReplyCount({ channelId, messageId, fallback }: { channelId: string; messageId?: string; fallback: number }) {
  const count = useApp((s) => s.messages[channelId]?.items.find((m) => m.id === messageId)?.thread?.message_count);
  return (
    <div className="flex flex-none items-center gap-3 px-4 py-2 text-xs text-muted-foreground">
      {repliesText(count ?? fallback)}<span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** The message the thread started from. If it is not loaded, up to 5 older pages of the parent channel
 *  are searched (as jumping to a reply does); if it is not there, or deleted, it says so. */
function ParentMessage({ channelId, messageId }: { channelId: string; messageId?: string }) {
  const m = useApp((s) => s.messages[channelId]?.items.find((x) => x.id === messageId));
  const loaded = useApp((s) => !!s.messages[channelId]);
  const color = useApp((s) => (m?.author ? roleColor(s.server, m.author.id) : undefined));
  const author = useMessageAuthor(m);
  const [searched, setSearched] = useState(false);
  const found = !!m;

  useEffect(() => {
    if (!messageId || found || !loaded) return;
    let stopped = false;
    void (async () => {
      try {
        for (let page = 0; page < 5 && !stopped; page++) {
          const list = client.store.getState().messages[channelId];
          if (!list?.hasMore || list.items.some((x) => x.id === messageId)) break;
          await client.loadOlder(channelId);
        }
      } catch {
        // Not fetchable: shown as deleted.
      }
      if (!stopped) setSearched(true);
    })();
    return () => {
      stopped = true;
    };
  }, [channelId, messageId, found, loaded]);

  if (!m || m.deleted) {
    const gone = !messageId || m?.deleted || searched;
    return (
      <p className="m-0 flex-none border-b px-4 py-3 text-sm text-muted-foreground">
        {gone ? <em>Original message deleted</em> : <span role="status" aria-label="Loading" className="block"><Skeleton className="h-4 w-40" /></span>}
      </p>
    );
  }
  const name = displayName(author);
  return (
    <article className="grid max-h-[40vh] flex-none grid-cols-[40px_minmax(0,1fr)] gap-x-3 overflow-y-auto border-b px-4 py-3">
      {m.author ? <UserAvatar user={author} size="lg" /> : <WebhookAvatar avatarUrl={m.webhook?.avatar_url} size="lg" />}
      <div className="min-w-0">
        <header className="flex items-baseline gap-2">
          <strong className="font-semibold" style={{ color }}>{name}</strong>
          {!m.author && <WebhookBadge />}
          <time className="text-xs text-muted-foreground" dateTime={m.created_at}>{timeFormat.format(new Date(m.created_at))}</time>
        </header>
        <div className="wrap-anywhere"><Markdown text={m.content} mentions={m.mentions ?? undefined} /></div>
        <Attachments items={m.attachments ?? []} />
      </div>
    </article>
  );
}
