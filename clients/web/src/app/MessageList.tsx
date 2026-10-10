import { ApiError, compareIds, unwrap, type Attachment, type ClientMessage, type ReplyRef } from "@datrope/core";
import { Fragment, forwardRef, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { Copy, MessageSquare, MessageSquarePlus, Pencil, Pin, PinOff, Reply, Trash2 } from "lucide-react";
import { client, displayName, errorText, formatBytes, outranksUser, roleColor, useApp } from "../session";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { useMessageAuthor } from "@/hooks/use-message-author";
import { useWindowFocus } from "@/hooks/use-window-focus";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/chat/Markdown";
import { Reactions, useBriefError } from "@/chat/Reactions";
import { PollCard } from "@/chat/PollCard";
import { cn } from "@/lib/utils";
import { LinkPreview } from "./LinkPreview";
import { WebhookAvatar } from "@/components/webhook-avatar";
import { WebhookBadge, WebhookPopover } from "./WebhookAuthor";
import { WebhookEmbeds } from "./WebhookEmbed";
import { ProfilePopover } from "./people/ProfilePopover";
import { MessageToolbar } from "./MessageToolbar";
import { ReplyQuote } from "./ReplyQuote";
import { ThreadSummary } from "./ThreadSummary";
import { clearPendingJump, usePendingJump } from "./jump";
import { firstUnreadIndex, idTime } from "./unread";
import { authorKey } from "./message-author";
import { GuestBadge } from "@/components/guest-badge";
import { AudioPlayer } from "./attachments/AudioPlayer";
import { GifMedia } from "./attachments/GifMedia";
import { ImageViewer } from "./attachments/ImageViewer";
import { VideoPlayer } from "./attachments/VideoPlayer";
import { fitBox, mediaKind, showable } from "./attachments/media";

/** A plain button that forwards its ref, for use as a popover trigger. */
const NameButton = forwardRef<HTMLButtonElement, ComponentProps<"button">>((props, ref) => <button ref={ref} type="button" {...props} />);
NameButton.displayName = "NameButton";

const FIVE_MINUTES = 5 * 60 * 1000;
const timeOnly = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
const shortDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** The message being replied to, shared by a channel's message list and composer. */
export type ReplyState = { replyTo: ReplyRef | null; setReplyTo(r: ReplyRef | null): void };

/** "Today", "Yesterday", or null for older days. */
function relativeDay(d: Date): string | null {
  const day = new Date();
  if (d.toDateString() === day.toDateString()) return "Today";
  day.setDate(day.getDate() - 1);
  return d.toDateString() === day.toDateString() ? "Yesterday" : null;
}
const dayLabel = (d: Date) => relativeDay(d) ?? shortDate.format(d);
export function stamp(d: Date) {
  const day = relativeDay(d);
  return day ? `${day} at ${timeOnly.format(d)}` : dateTime.format(d);
}

/** Scrolls to a message and flashes it. When it is not loaded, loads up to 2 older pages, then a
 *  window around it (a detached window when it is far back). Returns false when it does not exist;
 *  other load errors are thrown. */
export async function jumpTo(channelId: string, messageId: string): Promise<boolean> {
  const find = () => document.getElementById(`message-${messageId}`);
  // Older pages can only hold it when it is older than the oldest loaded message.
  const older = () => {
    const list = client.store.getState().messages[channelId];
    const oldest = list?.items.find((m) => !m.pending)?.id;
    return !!list?.hasMore && !!oldest && compareIds(messageId, oldest) < 0;
  };
  for (let page = 0; !find() && page < 2 && older(); page++) {
    await client.loadOlder(channelId);
    await nextFrame(); // let React render the page
  }
  if (!find()) {
    try {
      await client.loadAround(channelId, messageId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return false; // deleted
      throw e;
    }
    await nextFrame();
    await nextFrame();
  }
  const el = find();
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("message-flash");
  void el.offsetWidth; // restart the animation if it is still running
  el.classList.add("message-flash");
  setTimeout(() => el.classList.remove("message-flash"), 1500);
  return true;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const readMarker = (channelId: string) => client.store.getState().readStates[channelId]?.lastReadId;

export function MessageList({ channelId, canManage, canReply, canReact, reply, canCreateThread = false, onOpenThread, unreadLine = true, variant = "chat" }: {
  channelId: string;
  canManage: boolean;
  canReply: boolean;
  /** May add new reactions (ADD_REACTIONS); joining an existing one needs only READ_HISTORY. */
  canReact: boolean;
  reply: ReplyState;
  /** May start threads here (CREATE_THREADS + SEND_MESSAGES in a text channel). */
  canCreateThread?: boolean;
  /** Opens a thread; without it, messages show no thread summary or thread actions. */
  onOpenThread?: (threadId: string) => void;
  /** Shows the "New messages" line and the jump bar. Reaching the bottom marks the channel read either way. */
  unreadLine?: boolean;
  /** "cards" puts every message in its own card (an announcement feed): never grouped, with its title above the text. */
  variant?: "chat" | "cards";
}) {
  const list = useApp((s) => s.messages[channelId]);
  const meId = useApp((s) => s.me?.id);
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [jumpError, setJumpError] = useState<string>();
  const pendingJump = usePendingJump(channelId);
  const [jumping, setJumping] = useState(false);
  const [bottomVisible, setBottomVisible] = useState(false);
  const [dividerAbove, setDividerAbove] = useState(false);
  const focused = useWindowFocus();
  // The read marker as it was when the channel was opened, so acking does not move the line.
  const [mark, setMark] = useState(() => ({ channelId, id: readMarker(channelId) }));
  if (mark.channelId !== channelId) setMark({ channelId, id: readMarker(channelId) });
  // Whether no line showed at the last render. Messages that arrive while no line shows, the bottom
  // is in view and the window has focus are read at once, so they get no line.
  const noLine = useRef(false);
  const stick = useRef(true); // scrolled to the bottom
  const opened = useRef<string>();

  const items = list?.items ?? [];
  const detached = !!list?.hasNewer; // a window of older messages: nothing is marked read
  const lastId = items.at(-1)?.id;
  const lastConfirmed = items.filter((m) => !m.pending).at(-1)?.id;
  const oldestId = items.find((m) => !m.pending)?.id;
  let markId = mark.channelId === channelId ? mark.id : readMarker(channelId);
  if (!detached && noLine.current && bottomVisible && focused && lastConfirmed && (!markId || compareIds(lastConfirmed, markId) > 0)) markId = lastConfirmed;
  const unreadAt = unreadLine && list ? firstUnreadIndex(items, markId, meId) : -1;
  // The first unread message is older than the loaded page.
  const olderUnread = unreadLine && !!list?.hasMore && (!markId || (!!oldestId && compareIds(markId, oldestId) < 0));
  const since = unreadAt >= 0 && !olderUnread ? new Date(items[unreadAt]!.created_at)
    : markId ? idTime(markId) : items[0] ? new Date(items[0].created_at) : undefined;

  const measure = () => {
    const d = divider.current?.getBoundingClientRect(), r = scroller.current?.getBoundingClientRect();
    setDividerAbove(!!d && !!r && d.bottom < r.top);
  };

  useLayoutEffect(() => {
    noLine.current = unreadAt < 0 && !olderUnread;
    if (markId !== mark.id) setMark({ channelId, id: markId });
    measure();
  });

  // Opening scrolls the "New messages" line near the top, or else to the bottom. Later, a new last
  // message keeps you at the bottom if you were there, and always scrolls there when it is your own.
  // A detached window never scrolls to the bottom.
  useLayoutEffect(() => {
    if (!list) return;
    if (opened.current !== channelId) {
      opened.current = channelId;
      if (divider.current) {
        divider.current.scrollIntoView({ block: "start" });
        return;
      }
    } else if (!stick.current && items.at(-1)?.author?.id !== meId) return;
    if (list.hasNewer) return;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [channelId, !!list, lastId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A jump asked for by openMessage (search, inbox, notifications) runs once the messages are loaded.
  useEffect(() => {
    if (!pendingJump || !list) return;
    clearPendingJump();
    setJumpError(undefined);
    jumpTo(channelId, pendingJump).then((found) => {
      if (!found) setJumpError("That message is no longer available.");
    }, (e) => setJumpError(errorText(e)));
  }, [pendingJump, !!list]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!jumpError) return;
    const t = setTimeout(() => setJumpError(undefined), 4000);
    return () => clearTimeout(t);
  }, [jumpError]);

  useEffect(() => {
    const el = bottom.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setBottomVisible(!!e?.isIntersecting), { root: scroller.current });
    io.observe(el);
    return () => io.disconnect();
  }, [!!list]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reaching the bottom while the window has focus marks the channel read.
  useEffect(() => {
    if (!detached && lastConfirmed && bottomVisible && focused) client.ack(channelId, lastConfirmed).catch(() => undefined);
  }, [channelId, lastConfirmed, bottomVisible, focused, detached]);

  const markRead = () => {
    if (!lastConfirmed || detached) return;
    setMark({ channelId, id: lastConfirmed });
    client.ack(channelId, lastConfirmed).catch(() => undefined);
  };

  // Loads older pages (at most 5) until the first unread message is loaded, then scrolls to the line,
  // or to the oldest loaded message when it is further back still.
  const jumpToUnread = async () => {
    setJumping(true);
    try {
      let found = false;
      for (let page = 0; ; page++) {
        const loaded = client.store.getState().messages[channelId];
        const oldest = loaded?.items.find((m) => !m.pending)?.id;
        found = !loaded?.hasMore || (!!markId && !!oldest && compareIds(oldest, markId) <= 0);
        if (found || page >= 5) break;
        await client.loadOlder(channelId);
        await nextFrame(); // let React render the page
      }
      const target = (found && divider.current) || scroller.current?.querySelector("article");
      target?.scrollIntoView({ block: "start" });
    } finally {
      setJumping(false);
    }
  };

  if (!list) return <div className="grid flex-1 place-items-center overflow-y-auto p-8 text-center text-muted-foreground">Loading…</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!detached && (dividerAbove || olderUnread) && (
        <div className="mx-4 flex shrink-0 items-center gap-1 rounded-b-lg bg-primary py-1 pl-3 pr-1 text-sm text-primary-foreground shadow-md">
          <span className="min-w-0 flex-1 truncate font-medium">New messages{since && ` since ${stamp(since)}`}</span>
          <Button size="sm" variant="ghost" className="h-7 hover:bg-primary-foreground/15 hover:text-primary-foreground" disabled={jumping}
            onClick={() => void jumpToUnread()}>Jump to first unread</Button>
          <Button size="sm" variant="ghost" className="h-7 hover:bg-primary-foreground/15 hover:text-primary-foreground" onClick={markRead}>Mark as read</Button>
        </div>
      )}
      <div ref={scroller} className="flex flex-1 flex-col gap-0.5 overflow-y-auto pb-2 pt-4" role="log" aria-label="Messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
          measure();
        }}>
        {list.hasMore && (
          <Button variant="outline" className="mx-4" disabled={loadingOlder} onClick={async () => {
            setLoadingOlder(true);
            try {
              await client.loadOlder(channelId);
            } finally {
              setLoadingOlder(false);
            }
          }}>{loadingOlder ? "Loading…" : "Load older messages"}</Button>
        )}
        {list.items.length === 0 && <p className="grid min-h-full place-items-center p-8 text-center text-muted-foreground">No messages yet. Say hi!</p>}
        {list.items.map((m, i) => {
          const prev = list.items[i - 1];
          const day = new Date(m.created_at);
          const newDay = !prev || new Date(prev.created_at).toDateString() !== day.toDateString();
          // A reply, and the first unread message, always start a group, so they show their header.
          const grouped = variant === "chat" && !!prev && !newDay && !m.reply_to && i !== unreadAt && authorKey(prev) === authorKey(m) && !prev.deleted &&
            Date.parse(m.created_at) - Date.parse(prev.created_at) < FIVE_MINUTES;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="flex items-center gap-3 px-4 pb-1 pt-3 text-xs font-semibold text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />{dayLabel(day)}<span className="h-px flex-1 bg-border" />
                </div>
              )}
              {i === unreadAt && (
                <div ref={divider} role="separator" aria-label="New messages"
                  className="flex scroll-mt-2 items-center gap-2 px-4 pb-0.5 pt-2.5 text-xs font-semibold text-destructive">
                  <span className="h-px flex-1 bg-destructive" />New messages
                </div>
              )}
              {variant === "cards" ? (
                <Card className="w-[calc(100%-2rem)] max-w-3xl gap-0 self-center py-0">
                  <MessageRow m={m} grouped={false} mine={!!meId && m.author?.id === meId} mentioned={!!meId && !!m.mentions?.includes(meId)}
                    canManage={canManage} canReply={canReply} canReact={canReact} reply={reply}
                    canCreateThread={canCreateThread} onOpenThread={onOpenThread} card />
                </Card>
              ) : (
                <MessageRow m={m} grouped={grouped} mine={!!meId && m.author?.id === meId} mentioned={!!meId && !!m.mentions?.includes(meId)}
                  canManage={canManage} canReply={canReply} canReact={canReact} reply={reply}
                  canCreateThread={canCreateThread} onOpenThread={onOpenThread} />
              )}
            </Fragment>
          );
        })}
        {list.hasNewer && (
          <Button variant="outline" className="mx-4 mt-2" disabled={loadingNewer} onClick={async () => {
            setLoadingNewer(true);
            try {
              await client.loadNewer(channelId);
            } finally {
              setLoadingNewer(false);
            }
          }}>{loadingNewer ? "Loading…" : "Load newer messages"}</Button>
        )}
        <div ref={bottom} className="h-px shrink-0" />
      </div>
      {list.hasNewer && (
        <div className="mx-4 flex shrink-0 items-center gap-1 rounded-t-lg bg-secondary py-1 pl-3 pr-1 text-sm text-secondary-foreground shadow-md">
          <span className="min-w-0 flex-1 truncate font-medium">You're viewing older messages</span>
          <Button size="sm" variant="ghost" className="h-7" disabled={jumping} onClick={async () => {
            setJumping(true);
            try {
              await client.loadLatest(channelId);
              await nextFrame(); // let React render the page
              bottom.current?.scrollIntoView({ block: "end" });
            } finally {
              setJumping(false);
            }
          }}>Jump to present</Button>
        </div>
      )}
      {jumpError && <div className="shrink-0 px-4"><ErrorText error={jumpError} /></div>}
    </div>
  );
}

function MessageRow({ m, grouped, mine, mentioned, canManage, canReply, canReact, reply, canCreateThread, onOpenThread, card = false }: {
  m: ClientMessage; grouped: boolean; mine: boolean; mentioned: boolean; canManage: boolean; canReply: boolean; canReact: boolean;
  reply: ReplyState; canCreateThread: boolean; onOpenThread?: (threadId: string) => void; card?: boolean;
}) {
  // Deleting someone else's server message also needs me to outrank them; DMs have no hierarchy.
  // A voice channel's side chat has no pins panel, so no pinning there.
  const canPin = useApp((s) => {
    const type = s.channels[m.channel_id]?.type;
    return type !== "voice" && (canManage || type === "dm");
  });
  // A webhook message has no author to outrank: MANAGE_MESSAGES is enough.
  const canDelete = useApp((s) => mine || (canManage && (s.channels[m.channel_id]?.type === "dm" || !m.author || outranksUser(s, m.author.id))));
  const color = useApp((s) => (s.channels[m.channel_id]?.type === "dm" || !m.author ? undefined : roleColor(s.server, m.author.id)));
  const [profileOpen, setProfileOpen] = useState(false);
  const avatarRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [titleDraft, setTitleDraft] = useState(m.title ?? "");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [reactError, showReactError] = useBriefError();
  const path = { params: { path: { id: m.channel_id, messageID: m.id } } };
  const author = useMessageAuthor(m);
  const hook = m.author ? undefined : m.webhook; // posted by a webhook: no profile, a WEBHOOK badge
  const name = displayName(author);
  const replyTo = m.reply_to;

  const save = async () => {
    // Only announcement cards carry a title.
    const title = card ? titleDraft.trim() : undefined;
    const titleChanged = title !== undefined && title !== (m.title ?? "");
    if (draft === m.content && !titleChanged) {
      setEditing(false);
      return;
    }
    try {
      await unwrap(client.api.PATCH("/api/channels/{id}/messages/{messageID}", { ...path, body: { content: draft, ...(titleChanged && { title }) } }));
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const remove = async () => {
    setConfirming(false);
    try {
      await unwrap(client.api.DELETE("/api/channels/{id}/messages/{messageID}", path));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const thread = m.thread;
  const openThread = !onOpenThread ? undefined
    : thread ? () => onOpenThread(thread.id)
    : canCreateThread ? () => void client.createThread(m.channel_id, m.id).then((t) => onOpenThread(t.id), (e) => setError(errorText(e)))
    : undefined;
  const jump = async (id: string) => {
    setError(undefined);
    try {
      if (!(await jumpTo(m.channel_id, id))) setError("That message is no longer available.");
    } catch (e) {
      setError(errorText(e));
    }
  };

  const replyAuthor = m.author; // nobody replies to a webhook message: nobody can post in its channel
  const onReply = canReply && replyAuthor ? () => reply.setReplyTo({ id: m.id, author: replyAuthor, content: m.content, deleted: false }) : undefined;
  // Polls cannot be edited (the server answers POLL_NOT_EDITABLE).
  const onEdit = mine && !m.poll ? () => { setDraft(m.content); setTitleDraft(m.title ?? ""); setEditing(true); } : undefined;
  const onPin = canPin ? () => void (m.pinned ? client.unpin(m.channel_id, m.id) : client.pin(m.channel_id, m.id)).catch((e) => setError(errorText(e))) : undefined;
  const onDelete = canDelete ? () => setConfirming(true) : undefined;
  const actionable = !m.pending && !m.deleted && !editing;
  // Radix skips its menu (and its preventDefault) while the trigger is disabled, so links, media and
  // selected text keep the native menu: decide on pointerdown, which precedes contextmenu.
  const [nativeMenu, setNativeMenu] = useState(false);

  return (
    <ContextMenu modal={false}>
    <ContextMenuTrigger asChild disabled={!actionable || nativeMenu}>
    <article id={`message-${m.id}`}
      onPointerDownCapture={(e) => setNativeMenu(!!(e.target as HTMLElement).closest("a, img, video, audio") || !!window.getSelection()?.toString())}
      className={cn("group relative grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 px-4",
        card ? "rounded-xl py-4" : grouped ? "py-0.5" : "mt-2 pb-0.5 pt-1",
        mentioned ? "border-l-2 border-primary bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] pl-3.5" : !card && "hover:bg-card/50")}>
      {replyTo && <ReplyQuote reply={replyTo} onJump={() => void jump(replyTo.id)} />}
      {grouped ? <span /> : (
        <button ref={avatarRef} type="button" tabIndex={-1} aria-hidden className="size-10 self-start justify-self-start rounded-full" onClick={() => setProfileOpen((o) => !o)}>
          {hook ? <WebhookAvatar avatarUrl={hook.avatar_url} size="lg" /> : <UserAvatar user={author} size="lg" />}
        </button>
      )}
      <div className="min-w-0">
        {!grouped && (
          <header className="flex items-baseline gap-2">
            {hook ? (
              <WebhookPopover webhook={hook} open={profileOpen} onOpenChange={setProfileOpen}
                onInteractOutside={(e) => avatarRef.current?.contains(e.target as Node) && e.preventDefault()}>
                <NameButton className="font-semibold hover:underline">{name}</NameButton>
              </WebhookPopover>
            ) : (
              <ProfilePopover userId={author.id} fallback={m.author} open={profileOpen} onOpenChange={setProfileOpen}
                onInteractOutside={(e) => avatarRef.current?.contains(e.target as Node) && e.preventDefault()}>
                <NameButton className="font-semibold hover:underline" style={{ color }}>{name}</NameButton>
              </ProfilePopover>
            )}
            {hook ? <WebhookBadge /> : m.author && <GuestBadge user={m.author} />}
            <time className="text-xs text-muted-foreground" dateTime={m.created_at}>{stamp(new Date(m.created_at))}</time>
            {m.pinned && <Pin className="size-3 self-center text-muted-foreground" aria-label="Pinned" role="img" />}
            {m.edited_at && <span className="text-xs text-muted-foreground">(edited)</span>}
          </header>
        )}
        {card && m.title && !m.deleted && !editing && <h3 className="mb-1 mt-1 text-lg font-semibold tracking-normal text-foreground normal-case wrap-anywhere">{m.title}</h3>}
        {m.deleted ? (
          <p className="m-0 whitespace-pre-wrap text-muted-foreground wrap-anywhere"><em>Message deleted</em></p>
        ) : editing ? (
          <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
            {card && (
              <Input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} maxLength={100} aria-label="Edit title"
                placeholder="Title" className="mb-2"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setEditing(false);
                  }
                }} />
            )}
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={4000} aria-label="Edit message" autoFocus
              onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void save();
                }
              }} />
            <p className="mt-1 text-xs text-muted-foreground">
              Escape to <Button variant="link" className="h-auto p-0 text-xs" onClick={() => setEditing(false)}>cancel</Button>
              {" · "}Enter to <Button type="submit" variant="link" className="h-auto p-0 text-xs">save</Button>
            </p>
          </form>
        ) : m.content || m.edited_at ? (
          <div className={cn("wrap-anywhere", m.pending && "opacity-60")}>
            <Markdown text={m.content} mentions={m.pending ? undefined : m.mentions ?? undefined} />
            {/* Grouped rows have no header, so "(edited)" follows the text. */}
            {grouped && m.edited_at && <span className="edited text-xs text-muted-foreground"> (edited)</span>}
          </div>
        ) : null}
        {!m.deleted && m.poll && <PollCard message={m} poll={m.poll} canEnd={mine || canManage} />}
        {!m.deleted && <Attachments items={m.attachments ?? []} />}
        {!m.deleted && m.embeds && m.embeds.length > 0 && <WebhookEmbeds embeds={m.embeds} />}
        {!m.deleted && !editing && m.embed && <LinkPreview embed={m.embed} />}
        {!m.deleted && <Reactions message={m} canAdd={canReact} />}
        {thread && openThread && <div><ThreadSummary summary={thread} onOpen={openThread} /></div>}
        {m.failed && <ErrorText error="Not sent." />}
        <ErrorText error={error} />
        <ErrorText error={reactError} />
      </div>
      {actionable && (
        <MessageToolbar
          onReact={canReact ? (emoji) => void client.react(m.channel_id, m.id, emoji).catch(showReactError) : undefined}
          onReply={onReply}
          onThread={openThread} hasThread={!!thread}
          onEdit={onEdit}
          onPin={onPin}
          pinned={m.pinned}
          onDelete={onDelete} />
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-[480px]" onContextMenu={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Delete message?</DialogTitle>
          </DialogHeader>
          <div className="max-h-[40vh] overflow-y-auto rounded-lg border bg-background px-3 py-2 wrap-anywhere">
            <div className="flex items-baseline gap-2">
              <strong className="font-semibold" style={{ color }}>{name}{hook ? <WebhookBadge /> : m.author && <GuestBadge user={m.author} />}</strong>
              <span className="text-xs text-muted-foreground">{stamp(new Date(m.created_at))}</span>
            </div>
            <Markdown text={m.content} mentions={m.mentions ?? undefined} />
            {m.poll && <p className="m-0 text-sm text-muted-foreground">Poll: {m.poll.question}</p>}
            {(m.attachments?.length ?? 0) > 0 && (
              <p className="m-0 text-sm text-muted-foreground">
                {m.attachments!.length === 1 ? "1 attachment" : `${m.attachments!.length} attachments`}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void remove()}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
    </ContextMenuTrigger>
    <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
      {onReply && <ContextMenuItem onSelect={onReply}><Reply />Reply</ContextMenuItem>}
      {openThread && (thread
        ? <ContextMenuItem onSelect={openThread}><MessageSquare />Open thread</ContextMenuItem>
        : <ContextMenuItem onSelect={openThread}><MessageSquarePlus />Create thread</ContextMenuItem>)}
      {onEdit && <ContextMenuItem onSelect={onEdit}><Pencil />Edit message</ContextMenuItem>}
      {onPin && <ContextMenuItem onSelect={onPin}>{m.pinned ? <><PinOff />Unpin message</> : <><Pin />Pin message</>}</ContextMenuItem>}
      {m.content && <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(m.content).catch(() => undefined)}><Copy />Copy text</ContextMenuItem>}
      {onDelete && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onDelete}><Trash2 />Delete message</ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
    </ContextMenu>
  );
}

/** Images beyond this many are reached through the viewer. */
const MAX_TILES = 4;

/** An image thumbnail that opens the viewer; modified clicks still open the original in a new tab. */
function ImageLink({ image: a, onOpen, className, more = 0, width, height }:
  { image: Attachment; onOpen: () => void; className: string; more?: number; width?: number; height?: number }) {
  return (
    <a href={client.url(a.url)} target="_blank" rel="noopener noreferrer"
      className="relative block overflow-hidden rounded-lg border bg-card"
      onClick={(e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onOpen();
      }}>
      <img className={cn("block cursor-zoom-in transition-opacity hover:opacity-90", className)}
        src={client.url(a.thumbnail_url || a.url)} alt={a.filename} loading="lazy" width={width} height={height} />
      {more > 0 && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 text-2xl font-semibold text-foreground">
          +{more}
        </span>
      )}
    </a>
  );
}

export function Attachments({ items }: { items: Attachment[] }) {
  const [viewing, setViewing] = useState<number | null>(null);
  if (items.length === 0) return null;
  const images = items.filter(showable);
  const others = items.filter((a) => !showable(a));
  const tiles = images.slice(0, MAX_TILES);
  const hidden = images.length - tiles.length;
  return (
    <div className="mt-1 flex flex-col items-start gap-2">
      {images.length === 1 && (
        <ImageLink image={images[0]} onOpen={() => setViewing(0)}
          className="h-auto max-w-full" {...fitBox(images[0].width, images[0].height)} />
      )}
      {/* Several images share one row of square tiles; the last tile counts any that do not fit. */}
      {images.length > 1 && (
        <div className="grid w-[480px] max-w-full gap-1" style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}>
          {tiles.map((a, i) => (
            <ImageLink key={a.id} image={a} onOpen={() => setViewing(i)} className="aspect-square size-full object-cover"
              more={i === tiles.length - 1 ? hidden : 0} />
          ))}
        </div>
      )}
      {images.length > 0 && <ImageViewer images={images} index={viewing} onIndexChange={setViewing} />}
      {others.map((a) => {
        if (a.gif) return <GifMedia key={a.id} attachment={a} />; // an MP4, or a GIF image too big to inline
        const kind = mediaKind(a);
        if (kind === "audio") return <AudioPlayer key={a.id} attachment={a} />;
        if (kind === "video") return <VideoPlayer key={a.id} attachment={a} />;
        return (
          <a key={a.id} className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-foreground no-underline" href={client.url(a.url)} download={a.filename}>
            <span aria-hidden="true">📎</span>
            <span>{a.filename}</span>
            <span className="text-muted-foreground">{formatBytes(a.size)}</span>
          </a>
        );
      })}
    </div>
  );
}
