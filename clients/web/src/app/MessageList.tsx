import { compareIds, unwrap, type Attachment, type ClientMessage, type ReplyRef } from "@datrope/core";
import { Fragment, forwardRef, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { Pin } from "lucide-react";
import { client, displayName, errorText, formatBytes, outranksUser, roleColor, useApp } from "../session";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { useUser } from "@/hooks/use-user";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/chat/Markdown";
import { Reactions, useBriefError } from "@/chat/Reactions";
import { cn } from "@/lib/utils";
import { LinkPreview } from "./LinkPreview";
import { ProfilePopover } from "./people/ProfilePopover";
import { MessageToolbar } from "./MessageToolbar";
import { ReplyQuote } from "./ReplyQuote";
import { ThreadSummary } from "./ThreadSummary";
import { firstUnreadIndex, idTime } from "./unread";

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
function stamp(d: Date) {
  const day = relativeDay(d);
  return day ? `${day} at ${timeOnly.format(d)}` : dateTime.format(d);
}

/** Scrolls to a message and flashes it, loading up to 5 older pages to find it.
 *  Returns false when it is not found. */
export async function jumpTo(channelId: string, messageId: string): Promise<boolean> {
  for (let page = 0; ; page++) {
    const el = document.getElementById(`message-${messageId}`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("message-flash");
      void el.offsetWidth; // restart the animation if it is still running
      el.classList.add("message-flash");
      setTimeout(() => el.classList.remove("message-flash"), 1500);
      return true;
    }
    if (page >= 5 || !client.store.getState().messages[channelId]?.hasMore) return false;
    await client.loadOlder(channelId);
    await nextFrame(); // let React render the page
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

function useWindowFocus() {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const update = () => setFocused(document.hasFocus());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return focused;
}

const readMarker = (channelId: string) => client.store.getState().readStates[channelId]?.lastReadId;

export function MessageList({ channelId, canManage, canReply, canReact, reply, canCreateThread = false, onOpenThread, unreadLine = true }: {
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
}) {
  const list = useApp((s) => s.messages[channelId]);
  const meId = useApp((s) => s.me?.id);
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
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
  const lastId = items.at(-1)?.id;
  const lastConfirmed = items.filter((m) => !m.pending).at(-1)?.id;
  const oldestId = items.find((m) => !m.pending)?.id;
  let markId = mark.channelId === channelId ? mark.id : readMarker(channelId);
  if (noLine.current && bottomVisible && focused && lastConfirmed && (!markId || compareIds(lastConfirmed, markId) > 0)) markId = lastConfirmed;
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
  useLayoutEffect(() => {
    if (!list) return;
    if (opened.current !== channelId) {
      opened.current = channelId;
      if (divider.current) {
        divider.current.scrollIntoView({ block: "start" });
        return;
      }
    } else if (!stick.current && items.at(-1)?.author.id !== meId) return;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [channelId, !!list, lastId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = bottom.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setBottomVisible(!!e?.isIntersecting), { root: scroller.current });
    io.observe(el);
    return () => io.disconnect();
  }, [!!list]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reaching the bottom while the window has focus marks the channel read.
  useEffect(() => {
    if (lastConfirmed && bottomVisible && focused) client.ack(channelId, lastConfirmed).catch(() => undefined);
  }, [channelId, lastConfirmed, bottomVisible, focused]);

  const markRead = () => {
    if (!lastConfirmed) return;
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
      {(dividerAbove || olderUnread) && (
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
          const grouped = !!prev && !newDay && !m.reply_to && i !== unreadAt && prev.author.id === m.author.id && !prev.deleted &&
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
              <MessageRow m={m} grouped={grouped} mine={m.author.id === meId} mentioned={!!meId && !!m.mentions?.includes(meId)}
                canManage={canManage} canReply={canReply} canReact={canReact} reply={reply}
                canCreateThread={canCreateThread} onOpenThread={onOpenThread} />
            </Fragment>
          );
        })}
        <div ref={bottom} className="h-px shrink-0" />
      </div>
    </div>
  );
}

function MessageRow({ m, grouped, mine, mentioned, canManage, canReply, canReact, reply, canCreateThread, onOpenThread }: {
  m: ClientMessage; grouped: boolean; mine: boolean; mentioned: boolean; canManage: boolean; canReply: boolean; canReact: boolean;
  reply: ReplyState; canCreateThread: boolean; onOpenThread?: (threadId: string) => void;
}) {
  // Deleting someone else's server message also needs me to outrank them; DMs have no hierarchy.
  // A voice channel's side chat has no pins panel, so no pinning there.
  const canPin = useApp((s) => {
    const type = s.channels[m.channel_id]?.type;
    return type !== "voice" && (canManage || type === "dm");
  });
  const canDelete = useApp((s) => mine || (canManage && (s.channels[m.channel_id]?.type === "dm" || outranksUser(s, m.author.id))));
  const color = useApp((s) => (s.channels[m.channel_id]?.type === "dm" ? undefined : roleColor(s.server, m.author.id)));
  const [profileOpen, setProfileOpen] = useState(false);
  const avatarRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [reactError, showReactError] = useBriefError();
  const path = { params: { path: { id: m.channel_id, messageID: m.id } } };
  const author = useUser(m.author.id, m.author) ?? m.author;
  const name = displayName(author);
  const replyTo = m.reply_to;

  const save = async () => {
    if (draft === m.content) {
      setEditing(false);
      return;
    }
    try {
      await unwrap(client.api.PATCH("/api/channels/{id}/messages/{messageID}", { ...path, body: { content: draft } }));
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
    if (!(await jumpTo(m.channel_id, id))) setError("That message is too far back.");
  };

  return (
    <article id={`message-${m.id}`}
      className={cn("group relative grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 px-4",
        grouped ? "py-0.5" : "mt-2 pb-0.5 pt-1",
        mentioned ? "border-l-2 border-primary bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] pl-3.5" : "hover:bg-card/50")}>
      {replyTo && <ReplyQuote reply={replyTo} onJump={() => void jump(replyTo.id)} />}
      {grouped ? <span /> : (
        <button ref={avatarRef} type="button" tabIndex={-1} aria-hidden className="size-10 self-start justify-self-start rounded-full" onClick={() => setProfileOpen((o) => !o)}>
          <UserAvatar user={author} size="lg" />
        </button>
      )}
      <div className="min-w-0">
        {!grouped && (
          <header className="flex items-baseline gap-2">
            <ProfilePopover userId={author.id} fallback={m.author} open={profileOpen} onOpenChange={setProfileOpen}
              onInteractOutside={(e) => avatarRef.current?.contains(e.target as Node) && e.preventDefault()}>
              <NameButton className="font-semibold hover:underline" style={{ color }}>{name}</NameButton>
            </ProfilePopover>
            <time className="text-xs text-muted-foreground" dateTime={m.created_at}>{stamp(new Date(m.created_at))}</time>
            {m.pinned && <Pin className="size-3 self-center text-muted-foreground" aria-label="Pinned" role="img" />}
            {m.edited_at && <span className="text-xs text-muted-foreground">(edited)</span>}
          </header>
        )}
        {m.deleted ? (
          <p className="m-0 whitespace-pre-wrap text-muted-foreground wrap-anywhere"><em>Message deleted</em></p>
        ) : editing ? (
          <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
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
        {!m.deleted && <Attachments items={m.attachments ?? []} />}
        {!m.deleted && !editing && m.embed && <LinkPreview embed={m.embed} />}
        {!m.deleted && <Reactions message={m} canAdd={canReact} />}
        {thread && openThread && <div><ThreadSummary summary={thread} onOpen={openThread} /></div>}
        {m.failed && <ErrorText error="Not sent." />}
        <ErrorText error={error} />
        <ErrorText error={reactError} />
      </div>
      {!m.pending && !m.deleted && !editing && (
        <MessageToolbar
          onReact={canReact ? (emoji) => void client.react(m.channel_id, m.id, emoji).catch(showReactError) : undefined}
          onReply={canReply ? () => reply.setReplyTo({ id: m.id, author: m.author, content: m.content, deleted: false }) : undefined}
          onThread={openThread} hasThread={!!thread}
          onEdit={mine ? () => { setDraft(m.content); setEditing(true); } : undefined}
          onPin={canPin ? () => void (m.pinned ? client.unpin(m.channel_id, m.id) : client.pin(m.channel_id, m.id)).catch((e) => setError(errorText(e))) : undefined}
          pinned={m.pinned}
          onDelete={canDelete ? () => setConfirming(true) : undefined} />
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Delete message?</DialogTitle>
          </DialogHeader>
          <div className="max-h-[40vh] overflow-y-auto rounded-lg border bg-background px-3 py-2 wrap-anywhere">
            <div className="flex items-baseline gap-2">
              <strong className="font-semibold" style={{ color }}>{name}</strong>
              <span className="text-xs text-muted-foreground">{stamp(new Date(m.created_at))}</span>
            </div>
            <Markdown text={m.content} mentions={m.mentions ?? undefined} />
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
  );
}

/** Fits an image into 400x300 without upscaling, keeping its shape. */
function fitBox(w: number, h: number) {
  const scale = Math.min(1, 400 / w, 300 / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Whether to show an image in the message: its thumbnail, or the original only
 *  when it is small (or a modest GIF), so no viewer decodes a huge image. */
function showable(a: Attachment): a is Attachment & { width: number; height: number } {
  if (!a.inline || !a.width || !a.height) return false;
  if (a.thumbnail_url) return true;
  if (a.width <= 400 && a.height <= 400) return true;
  return a.content_type === "image/gif" && a.width * a.height <= 4096 * 4096;
}

export function Attachments({ items }: { items: Attachment[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {items.map((a) => (showable(a) ? (
        <a key={a.id} href={client.url(a.url)} target="_blank" rel="noopener noreferrer">
          <img className="block h-auto max-w-full rounded-lg border bg-card" src={client.url(a.thumbnail_url || a.url)} alt={a.filename}
            loading="lazy" {...fitBox(a.width, a.height)} />
        </a>
      ) : (
        <a key={a.id} className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-foreground no-underline" href={client.url(a.url)} download={a.filename}>
          <span aria-hidden="true">📎</span>
          <span>{a.filename}</span>
          <span className="text-muted-foreground">{formatBytes(a.size)}</span>
        </a>
      )))}
    </div>
  );
}
