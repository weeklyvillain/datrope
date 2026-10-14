import { Perm, hasPerm, type Message } from "@datrope/core";
import { ChevronLeft, ChevronRight, Download, Images, Maximize2, SendHorizontal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { client, displayName, formatBytes, roleColor, useApp, usePerms } from "../../session";
import { Markdown } from "@/chat/Markdown";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useChannelFeed } from "@/hooks/use-channel-feed";
import { useSubmit } from "@/hooks/use-submit";
import { AudioPlayer } from "../attachments/AudioPlayer";
import { ImageViewer } from "../attachments/ImageViewer";
import { Composer } from "../Composer";
import { VideoPlayer } from "../attachments/VideoPlayer";
import { MessageList, type ReplyState } from "../MessageList";
import { openMessage } from "../jump";
import { openPanel } from "../side-panel/panel";
import { SidePanel } from "../side-panel/SidePanel";
import { channelTag, useItemAuthor } from "./FileTile";
import { itemTitle, type GalleryItem } from "./items";
import { extension, KIND_SINGULAR } from "./kinds";
import { enterAction, isTouchOnly } from "@/lib/touch";
import { attachmentImage } from "@/lib/sized-image";

/** In comments nobody replies to a single message. */
const NO_REPLY: ReplyState = { replyTo: null, setReplyTo: () => undefined };
const MAX_LENGTH = 4000;
/** Stands in for the item while it is missing, so the author hook is called unconditionally. */
const EMPTY_ITEM = {
  attachment: { id: "", filename: "", content_type: "", size: 0, url: "", inline: false },
  kind: "other", uploader_id: "", created_at: "",
} as GalleryItem;
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** A gallery item in the side panel: a large preview, stepping through `items` (the grid as shown),
 *  its uploader, caption and file details, and its comments (the message's thread, started by the first comment).
 *  `actions` adds buttons under the preview (the music player's, for a track). */
export function GalleryItemPanel({ attachmentId, items, onClose, actions: extra }: {
  attachmentId: string; items: GalleryItem[]; onClose: () => void; actions?: (item: GalleryItem) => ReactNode;
}) {
  const nav = useNavigate();
  const item = items.find((it) => it.attachment.id === attachmentId);
  const channelId = item?.message?.channel_id ?? "";
  // The store's copy is fresher (thread counts, edits) when the channel is loaded.
  const stored = useApp((s) => (item?.message ? s.messages[channelId]?.items.find((m) => m.id === item.message!.id) : undefined));
  const message = stored ?? item?.message;
  const attachment = item?.attachment;
  const author = useItemAuthor(item ?? EMPTY_ITEM);
  const color = useApp((s) => (message?.author ? roleColor(s.server, message.author.id) : undefined));
  const perms = usePerms(channelId || undefined);
  const [viewing, setViewing] = useState<number | null>(null);
  const gone = !item || !!message?.deleted;

  // A deleted item closes its panel.
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  if (!item || !attachment) {
    return (
      <SidePanel title="Item" icon={<Images />} closeLabel="Close details" onClose={onClose}>
        <p className="m-0 p-4 text-center text-sm text-muted-foreground">Loading…</p>
      </SidePanel>
    );
  }
  const kind = item.kind;
  const i = items.findIndex((it) => it.attachment.id === attachmentId);
  const go = (to: number) => {
    const it = items[to];
    if (it) openPanel({ kind: "media", attachmentId: it.attachment.id });
  };
  const url = client.url(attachment.url);
  const tabbed = kind === "video" || attachment.content_type.split(";")[0].trim() === "application/pdf";
  const where = item.channel;
  const openWhere = () => { if (where && message) void openMessage(nav, where, message.id); };
  const extraActions = extra?.(item);
  const actions = (
    <>
      {kind === "image" ? (
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Open full size" title="Open full size"
          onClick={() => setViewing(0)}><Maximize2 /></Button>
      ) : tabbed && (
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
    <SidePanel title={itemTitle({ message, attachment })} label={`${KIND_SINGULAR[kind]} details`}
      closeLabel="Close details" icon={<Images />} actions={actions} onClose={onClose}>
      <div className="max-h-[60%] flex-none overflow-y-auto border-b">
        <div className="mx-4 mt-4 overflow-hidden rounded-md bg-muted">
          {kind === "video" ? <VideoPlayer key={attachment.id} attachment={attachment} />
            : kind === "image" ? (
              <img {...attachmentImage(attachment, 512)} alt={attachment.filename}
                className="aspect-[4/3] w-full object-contain" />
            ) : kind === "audio" ? <AudioPlayer key={attachment.id} attachment={attachment} />
            : (
              <div className="grid justify-items-center gap-2 p-6">
                <span className="grid h-16 w-13 place-items-end justify-center rounded-md bg-secondary pb-2 text-[11px] font-bold text-foreground" aria-hidden>
                  {extension(attachment.filename)}
                </span>
                <span className="text-center text-sm font-semibold wrap-anywhere">{attachment.filename}</span>
              </div>
            )}
        </div>
        {kind === "image" && <ImageViewer images={[attachment]} index={viewing} onIndexChange={setViewing} />}
        {extraActions && <div className="mx-4 mt-2 flex flex-wrap gap-2">{extraActions}</div>}
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
              <time className="text-xs text-muted-foreground" dateTime={item.created_at}>{timeFormat.format(new Date(item.created_at))}</time>
            </div>
            {message && where && (
              <Link to={`/channels/${where.parent_id || where.id}`} className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                onClick={(e) => { e.preventDefault(); openWhere(); }}>in #{channelTag(item)}</Link>
            )}
            {message?.content && <div className="text-sm wrap-anywhere"><Markdown text={message.content} mentions={message.mentions ?? undefined} /></div>}
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
      {message && where && (where.type === "thread" ? (
        // Threads can't hold threads of their own: a file posted in one is discussed there.
        <section aria-label="Comments" className="flex min-h-0 flex-1 flex-col">
          <p className="m-0 px-4 py-3 text-sm text-muted-foreground">
            Comments are in the thread:{" "}
            <Link to={`/channels/${where.parent_id || where.id}`} className="hover:text-foreground hover:underline"
              onClick={(e) => { e.preventDefault(); openWhere(); }}>#{channelTag(item)}</Link>
          </p>
        </section>
      ) : <Comments channelId={channelId} message={message} perms={perms} />)}
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
          enterKeyHint={isTouchOnly() ? "enter" : undefined}
          onKeyDown={(e) => {
            if (enterAction({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }, isTouchOnly()) === "send") {
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