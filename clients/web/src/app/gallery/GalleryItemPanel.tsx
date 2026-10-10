import { Perm, hasPerm, type Message } from "@datrope/core";
import { ChevronLeft, ChevronRight, Download, Images, Maximize2, SendHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { client, displayName, formatBytes, roleColor, useApp, usePerms } from "../../session";
import { Markdown } from "@/chat/Markdown";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useChannelFeed } from "@/hooks/use-channel-feed";
import { useSubmit } from "@/hooks/use-submit";
import { useMessageAuthor } from "@/hooks/use-message-author";
import { ImageViewer } from "../attachments/ImageViewer";
import { Composer } from "../Composer";
import { VideoPlayer } from "../attachments/VideoPlayer";
import { MessageList, type ReplyState } from "../MessageList";
import { openPanel } from "../side-panel/panel";
import { SidePanel } from "../side-panel/SidePanel";
import { itemTitle, type GalleryItem } from "./items";

/** In comments nobody replies to a single message. */
const NO_REPLY: ReplyState = { replyTo: null, setReplyTo: () => undefined };
const MAX_LENGTH = 4000;
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** A gallery item in the side panel: a large preview, stepping through `items` (the grid as shown),
 *  its uploader, caption and file details, and its comments (the message's thread, started by the first comment). */
export function GalleryItemPanel({ channelId, messageId, attachmentId, items, onClose }: {
  channelId: string; messageId: string; attachmentId: string; items: GalleryItem[]; onClose: () => void;
}) {
  const message = useApp((s) => s.messages[channelId]?.items.find((m) => m.id === messageId));
  const loaded = useApp((s) => !!s.messages[channelId]);
  const attachment = message?.attachments?.find((a) => a.id === attachmentId);
  const author = useMessageAuthor(message);
  const color = useApp((s) => (message?.author ? roleColor(s.server, message.author.id) : undefined));
  const perms = usePerms(channelId);
  const [viewing, setViewing] = useState<number | null>(null);
  const gone = loaded && (!message || message.deleted || !attachment);

  // A deleted item closes its panel.
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  if (!message || !attachment) {
    return (
      <SidePanel title="Item" icon={<Images />} closeLabel="Close details" onClose={onClose}>
        <p className="m-0 p-4 text-center text-sm text-muted-foreground">Loading…</p>
      </SidePanel>
    );
  }
  const kind = attachment.content_type.startsWith("video/") ? "video" : "photo";
  const i = items.findIndex((it) => it.attachment.id === attachmentId);
  const go = (to: number) => {
    const it = items[to];
    if (it) openPanel({ kind: "media", messageId: it.message.id, attachmentId: it.attachment.id });
  };
  const url = client.url(attachment.url);
  const actions = (
    <>
      {kind === "photo" ? (
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Open full size" title="Open full size"
          onClick={() => setViewing(0)}><Maximize2 /></Button>
      ) : (
        <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground">
          <a href={url} target="_blank" rel="noreferrer" aria-label="Open full size" title="Open full size"><Maximize2 /></a>
        </Button>
      )}
      <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground">
        <a href={url} download={attachment.filename} aria-label="Download" title="Download"><Download /></a>
      </Button>
    </>
  );

  return (
    <SidePanel title={itemTitle({ message, attachment, kind })} label={kind === "video" ? "Video details" : "Photo details"}
      closeLabel="Close details" icon={<Images />} actions={actions} onClose={onClose}>
      <div className="max-h-[60%] flex-none overflow-y-auto border-b">
        <div className="mx-4 mt-4 overflow-hidden rounded-md bg-muted">
          {kind === "video" ? <VideoPlayer key={attachment.id} attachment={attachment} /> : (
            <img src={client.url(attachment.thumbnail_url ?? attachment.url)} alt={attachment.filename}
              className="aspect-[4/3] w-full object-contain" />
          )}
        </div>
        {kind === "photo" && <ImageViewer images={[attachment]} index={viewing} onIndexChange={setViewing} />}
        {i >= 0 && (
          <div className="mx-4 mt-2 flex items-center justify-between">
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Previous item" disabled={i === 0}
              onClick={() => go(i - 1)}><ChevronLeft /></Button>
            <span className="text-xs text-muted-foreground tabular-nums">{i + 1} of {items.length}</span>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Next item" disabled={i === items.length - 1}
              onClick={() => go(i + 1)}><ChevronRight /></Button>
          </div>
        )}
        <div className="flex gap-2.5 border-b px-4 pt-2 pb-3">
          <UserAvatar user={author} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <strong className="font-semibold" style={{ color }}>{displayName(author)}</strong>
              <time className="text-xs text-muted-foreground" dateTime={message.created_at}>{timeFormat.format(new Date(message.created_at))}</time>
            </div>
            {message.content && <div className="text-sm wrap-anywhere"><Markdown text={message.content} mentions={message.mentions ?? undefined} /></div>}
          </div>
        </div>
        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 px-4 py-3 text-[13px]">
          <dt className="text-muted-foreground">File</dt>
          <dd className="m-0 truncate">{attachment.filename} · {formatBytes(attachment.size)}</dd>
          {attachment.width && attachment.height ? (
            <>
              <dt className="text-muted-foreground">Size</dt>
              <dd className="m-0">{attachment.width} × {attachment.height}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <Comments channelId={channelId} message={message} perms={perms} />
    </SidePanel>
  );
}

/** The item's comments: the replies in its message's thread, written in the app's composer once the thread exists;
 *  the first comment goes through a small box that starts the thread. */
function Comments({ channelId, message, perms }: { channelId: string; message: Message; perms: number }) {
  const [created, setCreated] = useState<string>();
  const threadId = message.thread?.id ?? created;
  const count = message.thread?.message_count ?? 0;
  const canSend = hasPerm(perms, Perm.SendMessages);
  return (
    <section aria-label="Comments" className="flex min-h-0 flex-1 flex-col">
      <h3 className="m-0 flex-none px-4 pt-3 pb-1 text-xs font-normal text-muted-foreground">
        {count === 0 ? "Comments" : count === 1 ? "1 comment" : `${count} comments`}
      </h3>
      {threadId ? (
        <>
          <CommentList threadId={threadId} perms={perms} />
          <Composer key={threadId} channelId={threadId} canSend={canSend} canAttach={hasPerm(perms, Perm.AttachFiles)}
            placeholder="Comment" label="Comment" reply={NO_REPLY} />
        </>
      ) : (
        <>
          <p className="m-0 flex-1 px-4 py-2 text-sm text-muted-foreground">No comments yet.</p>
          {canSend && hasPerm(perms, Perm.CreateThreads) ? <FirstComment channelId={channelId} messageId={message.id} onThread={setCreated} />
            : <p className="m-0 flex-none px-4 pb-4 text-sm text-muted-foreground">You can't comment here.</p>}
        </>
      )}
    </section>
  );
}

function CommentList({ threadId, perms }: { threadId: string; perms: number }) {
  const loadError = useChannelFeed(threadId);
  if (loadError) return <div className="flex-1 p-4"><ErrorText error={loadError} /></div>;
  return (
    <MessageList channelId={threadId} canManage={hasPerm(perms, Perm.ManageMessages)} canReply={false}
      canReact={hasPerm(perms, Perm.AddReactions)} reply={NO_REPLY} unreadLine={false} />
  );
}

/** The first comment starts the item's thread, then sends; from then on the composer takes over
 *  (a send that fails shows there, as a failed message). */
function FirstComment({ channelId, messageId, onThread }: {
  channelId: string; messageId: string; onThread: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const { busy, error, run } = useSubmit();
  const submit = () => {
    const content = text.trim();
    if (!content || busy) return;
    void run(async () => {
      const id = (await client.createThread(channelId, messageId)).id;
      onThread(id);
      await client.send(id, content);
    });
  };
  return (
    <form className="flex-none px-3 pt-2 pb-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="flex items-end gap-1.5 rounded-lg border bg-background p-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <Textarea className="max-h-[30vh] min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-1 py-1.5 shadow-none focus-visible:ring-0"
          value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment" aria-label="Comment" maxLength={MAX_LENGTH} rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }} />
        <Button type="submit" variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Send" title="Send"
          disabled={busy || !text.trim()}><SendHorizontal /></Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}