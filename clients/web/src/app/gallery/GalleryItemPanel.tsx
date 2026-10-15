import { Perm, hasPerm, type Message } from "@datrope/core";
import { ChevronLeft, ChevronRight, Download, Maximize2, SendHorizontal, X } from "@/components/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { client, displayName, formatBytes, roleColor, useApp, usePerms } from "../../session";
import { Markdown } from "@/chat/Markdown";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { BareButton } from "@/components/bare-button";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { channelTag, useItemAuthor } from "./FileTile";
import { itemTitle, type GalleryItem } from "./items";
import { extension, KIND_SINGULAR } from "./kinds";
import { enterAction, isTouchOnly } from "@/lib/touch";
import { attachmentImage } from "@/lib/sized-image";
import { ListSkeleton } from "@/components/loading-skeleton";

/** In comments nobody replies to a single message. */
const NO_REPLY: ReplyState = { replyTo: null, setReplyTo: () => undefined };
const MAX_LENGTH = 4000;
/** Stands in for the item while it is missing, so the author hook is called unconditionally. */
const EMPTY_ITEM = {
  attachment: { id: "", filename: "", content_type: "", size: 0, url: "", inline: false },
  kind: "other", uploader_id: "", created_at: "",
} as GalleryItem;
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** The full-screen frame: the media fills the left, the details and comments slide in on the right (below on phones). */
function Lightbox({ label, onClose, media, children }: { label: string; onClose: () => void; media: ReactNode; children: ReactNode }) {
  // Button doesn't forward refs (React 18), so the close control is a BareButton with Button's styling.
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  return (
    <div role="dialog" aria-modal="true" aria-label={label}
      data-lightbox className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm md:flex-row">
      <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center p-4 md:p-10">{media}</div>
      <aside className="flex max-h-[55%] min-h-0 flex-none flex-col border-t bg-card animate-in slide-in-from-bottom md:max-h-none md:w-[380px] md:border-t-0 md:border-l md:slide-in-from-right motion-reduce:animate-none">
        <div className="flex flex-none items-center justify-end gap-1 px-2 pt-2">
          <BareButton ref={close} aria-label="Close details" title="Close details" onClick={onClose}
            className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "text-muted-foreground" })}><X /></BareButton>
        </div>
        {children}
      </aside>
    </div>
  );
}

/** A gallery item full screen: the media with stepping through `items` (the grid as shown), and beside it
 *  its uploader, caption and file details, and its comments (the message's thread, started by the first comment).
 *  `actions` adds buttons under the title (the music player's, for a track). */
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
  // The panel stays mounted while stepping (so focus stays put); per-item state resets here and via keys below.
  useEffect(() => { setViewing(null); }, [attachmentId]);

  // A deleted item closes its panel.
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  const i = items.findIndex((it) => it.attachment.id === attachmentId);
  const go = (to: number) => {
    const it = items[to];
    if (it) openPanel({ kind: "media", attachmentId: it.attachment.id });
  };
  // Escape closes and ←/→ step, from anywhere (focus may be on the body after a click on the media). Skipped when a nested
  // layer already handled the key, the target is in another dialog (the full-size viewer, a popover) or a control that uses the keys itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const dialog = t?.closest("[role=dialog]");
      if (dialog && !dialog.hasAttribute("data-lightbox")) return;
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (t?.closest("input, textarea, select, video, audio, [role=slider], [contenteditable=true]")) return;
      if (e.key === "ArrowLeft") go(i - 1);
      if (e.key === "ArrowRight") go(i + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!item || !attachment) {
    return <Lightbox label="Item" onClose={onClose} media={<ListSkeleton className="w-full max-w-md" />}><span /></Lightbox>;
  }
  const kind = item.kind;
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

  const media = (
    <>
      {kind === "video" ? <div className="w-full max-w-5xl"><VideoPlayer key={attachment.id} attachment={attachment} /></div>
        : kind === "image" ? <img key={attachment.id} {...attachmentImage(attachment, 1600)} alt={attachment.filename} className="max-h-full max-w-full rounded-sm object-contain" />
        : kind === "audio" ? <div className="w-full max-w-md"><AudioPlayer key={attachment.id} attachment={attachment} /></div>
        : (
          <div className="grid justify-items-center gap-2 rounded-lg bg-card p-8">
            <span className="grid h-16 w-13 place-items-end justify-center rounded-md bg-secondary pb-2 text-caption font-bold text-foreground" aria-hidden>{extension(attachment.filename)}</span>
            <span className="text-center text-sm font-semibold wrap-anywhere">{attachment.filename}</span>
          </div>
        )}
      {kind === "image" && <ImageViewer key={attachment.id} images={[attachment]} index={viewing} onIndexChange={setViewing} />}
      <div className="absolute top-3 right-3 flex gap-1">{actions}</div>
      {i >= 0 && (
        <>
          <Button variant="secondary" size="icon" className="absolute top-1/2 left-3 -translate-y-1/2 rounded-full" aria-label="Previous item" disabled={i === 0}
            onClick={() => go(i - 1)}><ChevronLeft /></Button>
          <Button variant="secondary" size="icon" className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full" aria-label="Next item" disabled={i === items.length - 1}
            onClick={() => go(i + 1)}><ChevronRight /></Button>
          <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-2.5 py-0.5 text-xs text-muted-foreground tabular-nums">{i + 1} of {items.length}</span>
        </>
      )}
    </>
  );

  return (
    <Lightbox label={`${KIND_SINGULAR[kind]} details`} onClose={onClose} media={media}>
      <div className="max-h-[60%] flex-none overflow-y-auto border-b">
        <h2 className="m-0 px-4 text-sm font-semibold">{itemTitle({ message, attachment })}</h2>
        {extraActions && <div className="mx-4 mt-2 flex flex-wrap gap-2">{extraActions}</div>}
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
        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 px-4 py-3 text-ui">
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
      ) : <Comments key={attachment.id} channelId={channelId} message={message} perms={perms} />)}
    </Lightbox>
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
      <div className="flex items-end gap-1.5 rounded-lg border bg-background p-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring">
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