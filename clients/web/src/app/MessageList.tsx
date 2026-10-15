import { ApiError, compareIds, mentionsMe, myRoleIds, unwrap, type Attachment, type ClientMessage, type ReplyRef } from "@datrope/core";
import { useShallow } from "zustand/react/shallow";
import { forwardRef, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Virtuoso, type ScrollerProps, type VirtuosoHandle } from "react-virtuoso";
import { AlarmClock, Copy, Hand, Images, LogOut, MessageSquare, MessageSquarePlus, Pencil, Pin, PinOff, Reply, Trash2 } from "lucide-react";
import { client, displayName, errorText, outranksUser, roleColor, useApp } from "../session";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { useMessageAuthor } from "@/hooks/use-message-author";
import { useWindowFocus } from "@/hooks/use-window-focus";
import { MessageAnnouncer } from "./MessageAnnouncer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/chat/Markdown";
import { Reactions, useBriefError } from "@/chat/Reactions";
import { PollCard } from "@/chat/PollCard";
import { WheelCard } from "@/chat/WheelCard";
import { parseWheel } from "@/chat/wheel";
import { cn } from "@/lib/utils";
import { messageKeyAction, type MessageKey } from "@/lib/message-keys";
import { buildItems, indexOfMessage, navTarget, neighbourRow, prependedCount, type Item } from "@/lib/message-items";
import { shouldKeepFocus } from "@/lib/focus";
import { clockTime, fullStamp, headStamp } from "@/lib/message-time";
import { useLongPress } from "@/hooks/use-long-press";
import { useSwipeReply } from "@/hooks/use-swipe-reply";
import { recordEmoji } from "@/chat/recent-emoji";
import { EmojiPicker, reactionKey } from "@/chat/EmojiPicker";
import { KEEP_TOUCH_DEFAULT, canLongPress, enterAction, isTouchOnly } from "@/lib/touch";
import { useLatch } from "@/hooks/use-latch";
import { AddToAlbumContextItems, AddToAlbumMenuItems } from "./gallery/AddToAlbum";
import { LinkPreview } from "./LinkPreview";
import { InlinePlayer } from "./InlinePlayer";
import { firstPlayer } from "@/lib/players";
import { WebhookAvatar } from "@/components/webhook-avatar";
import { WebhookBadge, WebhookPopover } from "./WebhookAuthor";
import { WebhookEmbeds } from "./WebhookEmbed";
import { ProfilePopover } from "./people/ProfilePopover";
import { MessageToolbar } from "./MessageToolbar";
import { MessageSheet } from "./MessageSheet";
import { messageActions } from "./message-actions";
import { RemindMenuItems } from "./reminders/RemindMenuItems";
import { ReminderDialog } from "./reminders/ReminderDialog";
import { isSystemDM } from "./reminders/reminders";
import { ReminderCard } from "./reminders/ReminderCard";
import { SystemBadge } from "./reminders/SystemBadge";
import { ReplyQuote } from "./ReplyQuote";
import { ThreadSummary } from "./ThreadSummary";
import { clearPendingJump, usePendingJump } from "./jump";
import { firstUnreadIndex, idTime } from "./unread";
import { GuestBadge } from "@/components/guest-badge";
import { AudioPlayer } from "./attachments/AudioPlayer";
import { CodeFileAttachment, isCodeFile } from "./attachments/CodeFile";
import { FileChip } from "./attachments/FileChip";
import { GifMedia } from "./attachments/GifMedia";
import { ImageViewer } from "./attachments/ImageViewer";
import { clearEditRequest, onEditLast, onEditRequest, onPresent, requestEdit } from "./chat-events";
import { VideoPlayer } from "./attachments/VideoPlayer";
import { MemberRoleIcon } from "@/components/role-icon";
import { fitBox, mediaKind, showable } from "./attachments/media";
import { attachmentImage } from "@/lib/sized-image";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

/** A plain button that forwards its ref, for use as a popover trigger. */
const NameButton = forwardRef<HTMLButtonElement, ComponentProps<"button">>((props, ref) => <button ref={ref} type="button" {...props} />);
NameButton.displayName = "NameButton";

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

/** Focuses a message row by id (and scrolls it into view). */
export function focusRow(scroller: HTMLElement | null, id: string) {
  const el = scroller?.querySelector<HTMLElement>(`#message-${CSS.escape(id)}`);
  el?.focus({ preventScroll: true });
  el?.scrollIntoView({ block: "nearest" });
}
/** The composer that goes with the list `from` is in (a thread's or post's own box), else the channel's. */
const composer = (from?: Element | null) => {
  for (let el = from?.parentElement; el; el = el.parentElement) {
    const box = el.querySelector<HTMLTextAreaElement>("textarea[role=combobox]");
    if (box) return box;
  }
  return document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
};

/** Each mounted list, by channel: what jumpTo and "Jump to present" scroll with. */
export const listApi = new Map<string, { scrollToId(id: string): boolean; scrollToBottom(): void }>();
/** Virtuoso's firstItemIndex starts here and drops by the number of items each older page prepends. */
const START = 1_000_000;

/** Scrolls to a message and flashes it. When it is not loaded, loads up to 2 older pages, then a
 *  window around it (a detached window when it is far back). Returns false when it does not exist;
 *  other load errors are thrown. */
export async function jumpTo(channelId: string, messageId: string): Promise<boolean> {
  const loaded = () => client.store.getState().messages[channelId]?.items.some((m) => m.id === messageId) ?? false;
  // Older pages can only hold it when it is older than the oldest loaded message.
  const older = () => {
    const list = client.store.getState().messages[channelId];
    const oldest = list?.items.find((m) => !m.pending)?.id;
    return !!list?.hasMore && !!oldest && compareIds(messageId, oldest) < 0;
  };
  for (let page = 0; !loaded() && page < 2 && older(); page++) await client.loadOlder(channelId);
  if (!loaded()) {
    try {
      await client.loadAround(channelId, messageId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return false; // deleted
      throw e;
    }
  }
  await nextFrame(); // let React render the page
  if (!listApi.get(channelId)?.scrollToId(messageId)) return false;
  // The row renders once the list has scrolled to it. A list that is still settling (just opened, rows
  // being measured) can land elsewhere, so ask again until the row is in view.
  const find = () => document.getElementById(`message-${messageId}`);
  const shown = () => {
    const el = find(), log = el?.closest<HTMLElement>("[role=log]");
    if (!el || !log) return false;
    const r = el.getBoundingClientRect(), v = log.getBoundingClientRect();
    return r.bottom > v.top && r.top < v.bottom;
  };
  for (let i = 1; i <= 30 && !shown(); i++) {
    await nextFrame();
    if (i % 5 === 0 && !shown()) listApi.get(channelId)?.scrollToId(messageId);
  }
  const el = find();
  if (!el) return false;
  el.classList.remove("message-flash");
  void el.offsetWidth; // restart the animation if it is still running
  el.classList.add("message-flash");
  setTimeout(() => el.classList.remove("message-flash"), 1500);
  return true;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const readMarker = (channelId: string) => client.store.getState().readStates[channelId]?.lastReadId;

/** What the list's header and footer show. */
type ListContext = { loadingOlder: boolean; olderError?: string; retryOlder(): void; loadingNewer: boolean; newerError?: string; retryNewer(): void; emptyTitle: string };

/** The scroller Virtuoso renders: the message log landmark. Not a tab stop itself: the rows are. */
const LogScroller = forwardRef<HTMLDivElement, ScrollerProps & { context: ListContext; className?: string }>(
  ({ context: _context, tabIndex: _tabIndex, className, ...props }, ref) => (
    <div {...props} ref={ref} role="log" aria-label="Messages" aria-live="off" className={cn("overflow-x-hidden overscroll-y-contain", className)} />
  ),
);
LogScroller.displayName = "LogScroller";

function ListHeader({ context }: { context: ListContext }) {
  if (context.loadingOlder) return <SkeletonRows />;
  if (context.olderError) return <RetryRow what="older" error={context.olderError} onRetry={context.retryOlder} />;
  return <div className="h-4" />;
}

function ListFooter({ context }: { context: ListContext }) {
  if (context.loadingNewer) return <SkeletonRows />;
  if (context.newerError) return <RetryRow what="newer" error={context.newerError} onRetry={context.retryNewer} />;
  return <div className="h-2" />;
}

function EmptyList({ context }: { context: ListContext }) {
  return (
    <Empty className="min-h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Hand /></EmptyMedia>
        <EmptyTitle>{context.emptyTitle}</EmptyTitle>
        <EmptyDescription>Say hi!</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const listComponents = { Scroller: LogScroller, Header: ListHeader, Footer: ListFooter, EmptyPlaceholder: EmptyList };

/** Placeholder rows while a page of history loads. */
function SkeletonRows({ className }: { className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cn("grid gap-4 px-4 py-3", className)}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="grid content-start gap-2 pt-1">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RetryRow({ what, error, onRetry }: { what: "older" | "newer"; error: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground">
      Couldn't load {what} messages.<Button variant="link" className="h-auto p-0" onClick={onRetry}>Retry</Button>
      <span className="sr-only">{error}</span>
    </div>
  );
}

function DayDivider({ date }: { date: Date }) {
  return (
    <div className="flex items-center gap-3 px-4 pb-1 pt-3 text-xs font-semibold text-muted-foreground">
      <span className="h-px flex-1 bg-border" />{dayLabel(date)}<span className="h-px flex-1 bg-border" />
    </div>
  );
}

function UnreadDivider() {
  return (
    <div data-unread-line role="separator" aria-label="New messages"
      className="flex items-center gap-2 px-4 pb-0.5 pt-2.5 text-xs font-semibold text-destructive">
      <span className="h-px flex-1 bg-destructive" />New messages
    </div>
  );
}

export function MessageList({ channelId, canManage, canReply, canReact, reply, canCreateThread = false, onOpenThread, unreadLine = true, variant = "chat", emptyTitle = "No messages yet" }: {
  channelId: string;
  /** Heading of the empty list. */
  emptyTitle?: string;
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
  const roleIds = useApp(useShallow(myRoleIds));
  const vref = useRef<VirtuosoHandle>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const [tabId, setTabId] = useState<string>();
  const rowItems = list?.items.filter((m) => m.kind !== "member_leave");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [newerError, setNewerError] = useState<string>();
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
  // What the view is held on until you scroll: the "New messages" line it opened at, or a message jumped to.
  // Rows that grow after being measured (media, fonts) would otherwise push it away.
  const anchor = useRef<"line" | { id: string } | null>(null);
  const hasNewer = useRef(false); // the ResizeObserver reads the current value, not its closure
  hasNewer.current = !!list?.hasNewer;

  const items = list?.items ?? [];
  const detached = !!list?.hasNewer; // a window of older messages: nothing is marked read
  const lastConfirmed = items.filter((m) => !m.pending).at(-1)?.id;
  const oldestId = items.find((m) => !m.pending)?.id;
  let markId = mark.channelId === channelId ? mark.id : readMarker(channelId);
  if (!detached && noLine.current && bottomVisible && focused && lastConfirmed && (!markId || compareIds(lastConfirmed, markId) > 0)) markId = lastConfirmed;
  const unreadAt = unreadLine && list ? firstUnreadIndex(items, markId, meId) : -1;
  // The first unread message is older than the loaded page.
  const olderUnread = unreadLine && !!list?.hasMore && (!markId || (!!oldestId && compareIds(markId, oldestId) < 0));
  const since = unreadAt >= 0 && !olderUnread ? new Date(items[unreadAt]!.created_at)
    : markId ? idTime(markId) : items[0] ? new Date(items[0].created_at) : undefined;

  const rows = useMemo(() => (list ? buildItems(list.items, { unreadAt, variant }) : []), [list, unreadAt, variant]);
  // Older pages prepend items: firstItemIndex drops by as many, so the rows in view stay put.
  const baseRef = useRef<{ channelId: string; rows: Item[]; base: number }>();
  const prevBase = baseRef.current?.channelId === channelId ? baseRef.current : undefined;
  const base = !prevBase ? START : prevBase.rows === rows ? prevBase.base : prevBase.base - prependedCount(prevBase.rows, rows);
  baseRef.current = { channelId, rows, base };
  const unreadIndex = rows.findIndex((i) => i.kind === "unread");
  const range = useRef({ startIndex: 0, endIndex: 0 });
  const [rendered, setRendered] = useState<{ startIndex: number; endIndex: number }>();
  // The roving tab stop: the row last focused, else the last row. Rows outside the rendered range are not in
  // the DOM, so then the last rendered row takes the stop and Tab still reaches the list.
  const wanted = tabId && rowItems?.some((m) => m.id === tabId) ? tabId : rowItems?.at(-1)?.id;
  const renderedRows = rendered
    ? rows.slice(rendered.startIndex - base, rendered.endIndex - base + 1).flatMap((it) => (it.kind === "message" && it.m.kind !== "member_leave" ? [it.m.id] : []))
    : [];
  const tabbable = !wanted || renderedRows.length === 0 || renderedRows.includes(wanted) ? wanted : renderedRows.at(-1);
  // What the scroll listener and the callbacks below read: the current values, not their closures.
  const latest = useRef({ rows, base, unreadIndex });
  latest.current = { rows, base, unreadIndex };

  // Whether the "New messages" line is above the view: measured when it is rendered, else by index.
  const measure = () => {
    const { base, unreadIndex } = latest.current;
    const d = scroller.current?.querySelector("[data-unread-line]")?.getBoundingClientRect(), r = scroller.current?.getBoundingClientRect();
    setDividerAbove(d && r ? d.bottom < r.top : unreadIndex >= 0 && unreadIndex + base < range.current.startIndex);
  };

  // Scrolls back to what the view is held on; false when nothing is held.
  const reanchor = () => {
    const a = anchor.current, { rows, unreadIndex } = latest.current;
    const i = a === "line" ? unreadIndex : a ? indexOfMessage(rows, a.id) : -1;
    if (i < 0) return false;
    vref.current?.scrollToIndex({ index: i, align: a === "line" ? "start" : "center" });
    return true;
  };

  useLayoutEffect(() => {
    noLine.current = unreadAt < 0 && !olderUnread;
    if (markId !== mark.id) setMark({ channelId, id: markId });
    measure();
  });

  useEffect(() => {
    listApi.set(channelId, {
      scrollToId: (id) => {
        const i = indexOfMessage(latest.current.rows, id);
        if (i < 0) return false;
        anchor.current = { id }; // a jump wins over the "New messages" line
        stick.current = false;
        vref.current?.scrollToIndex({ index: i, align: "center", behavior: "auto" });
        return true;
      },
      scrollToBottom: () => {
        anchor.current = null;
        stick.current = true;
        vref.current?.scrollToIndex({ index: "LAST", align: "end" });
      },
    });
    return () => { listApi.delete(channelId); };
  }, [channelId]);

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

  // The keyboard or a reply bar resizing the scroller keeps the bottom pinned while stuck.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const held = anchor.current;
    if (!(held && held !== "line" && indexOfMessage(latest.current.rows, held.id) >= 0)) anchor.current = latest.current.unreadIndex >= 0 ? "line" : null;
    const release = () => { anchor.current = null; };
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const t of inputs) el.addEventListener(t, release, { passive: true });
    // Virtuoso reports the bottom a little later; a scroll is judged at once, before any rows grow.
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      measure();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    let height = el.clientHeight;
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (el.clientHeight === height) return; // the first call only reports the initial size
      // Judged by where the bottom was before the resize: `stick` can lag behind a scroll that just happened.
      const rest = el.scrollHeight - el.scrollTop;
      const wasAtBottom = rest - height < 32 || rest - el.clientHeight < 32;
      height = el.clientHeight;
      if (!reanchor() && wasAtBottom && !hasNewer.current) vref.current?.scrollToIndex({ index: "LAST", align: "end" });
    });
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      for (const t of inputs) el.removeEventListener(t, release);
      ro?.disconnect();
    };
  }, [channelId, !!list]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reaching the bottom while the window has focus marks the channel read.
  useEffect(() => {
    if (!detached && lastConfirmed && bottomVisible && focused) client.ack(channelId, lastConfirmed).catch(() => undefined);
  }, [channelId, lastConfirmed, bottomVisible, focused, detached]);

  const markRead = () => {
    if (!lastConfirmed || detached) return;
    setMark({ channelId, id: lastConfirmed });
    client.ack(channelId, lastConfirmed).catch(() => undefined);
  };

  // Esc in a chat (use-shortcuts): mark read and jump to the newest message.
  const present = useRef(() => {});
  present.current = () => {
    markRead();
    if (list?.hasNewer) void client.loadLatest(channelId).then(() => listApi.get(channelId)?.scrollToBottom()).catch(() => undefined);
    else listApi.get(channelId)?.scrollToBottom();
  };
  useEffect(() => onPresent(channelId, () => present.current()), [channelId]);
  // ↑ in an empty message box: edit my last message.
  useEffect(() => {
    const off = onEditLast(channelId, () => {
      const items = latest.current.rows;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== "message" || !meId || it.m.author?.id !== meId || it.m.deleted || it.m.poll || it.m.pending) continue;
        listApi.get(channelId)?.scrollToId(it.m.id);
        requestEdit(it.m.id);
        return;
      }
    });
    return () => { off(); clearEditRequest(); };
  }, [channelId, meId]);

  const loadOlder = async () => {
    if (!list?.hasMore || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(undefined);
    try {
      await client.loadOlder(channelId);
    } catch (e) {
      setOlderError(errorText(e));
    } finally {
      setLoadingOlder(false);
    }
  };
  const loadNewer = async () => {
    if (!list?.hasNewer || loadingNewer) return;
    setLoadingNewer(true);
    setNewerError(undefined);
    try {
      await client.loadNewer(channelId);
    } catch (e) {
      setNewerError(errorText(e));
    } finally {
      setLoadingNewer(false);
    }
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
      }
      await nextFrame(); // let React render the page
      const line = latest.current.unreadIndex;
      anchor.current = found && line >= 0 ? "line" : null;
      stick.current = false;
      vref.current?.scrollToIndex({ index: found && line >= 0 ? line : 0, align: "start" });
    } finally {
      setJumping(false);
    }
  };

  // Row callbacks take the row's id and only read refs, so they stay the same and memoized rows skip re-rendering.
  const onRowFocus = useCallback((id: string) => setTabId(id), []);
  // Arrow keys, Home and End walk the rows by index, so they reach rows outside the rendered range.
  const navigate = useCallback((fromId: string, act: "prev" | "next" | "first" | "last") => {
    const t = navTarget(latest.current.rows, fromId, act);
    const target = latest.current.rows[t];
    if (target?.kind !== "message") return;
    // A rendered row (in view or in the overscan) takes focus at once, so held keys never lag behind.
    if (scroller.current?.querySelector(`#message-${CSS.escape(target.m.id)}`)) focusRow(scroller.current, target.m.id);
    else vref.current?.scrollIntoView({ index: t, behavior: "auto", done: () => focusRow(scroller.current, target.m.id) });
  }, []);
  const neighbour = useCallback((id: string) => neighbourRow(latest.current.rows, id)?.id, []);

  const context: ListContext = { loadingOlder, olderError, retryOlder: () => void loadOlder(), loadingNewer, newerError, retryNewer: () => void loadNewer(), emptyTitle };
  const row = (m: ClientMessage, grouped: boolean) => (
    <MessageRow m={m} grouped={grouped} mine={!!meId && m.author?.id === meId} mentioned={!!meId && mentionsMe(m, meId, roleIds)}
      canManage={canManage} canReply={canReply} canReact={canReact} reply={reply}
      canCreateThread={canCreateThread} onOpenThread={onOpenThread} card={variant === "cards"}
      tabbable={m.id === tabbable} onRowFocus={onRowFocus} onNavigate={navigate} neighbour={neighbour} />
  );

  if (!list) return <div className="flex-1 overflow-y-auto"><SkeletonRows /></div>;
  const last = rows.at(-1);
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
      <Virtuoso<Item, ListContext>
        key={channelId}
        ref={vref}
        className="min-h-0 flex-1"
        data={rows}
        context={context}
        firstItemIndex={base}
        initialTopMostItemIndex={unreadIndex >= 0 ? { index: unreadIndex, align: "start" } : { index: Math.max(0, rows.length - 1), align: "end" }}
        // A new last message keeps you at the bottom if you were there, and always scrolls there when it
        // is your own. A detached window never scrolls to the bottom.
        followOutput={(atBottom) => {
          if (list.hasNewer || !(atBottom || (last?.kind === "message" && !!meId && last.m.author?.id === meId))) return false;
          anchor.current = null; // following new messages to the bottom lets go of any held line or message
          stick.current = true;
          return "auto";
        }}
        atBottomThreshold={32}
        // Rows measured (or grown, e.g. media loading) keep the held line or message in place, or else the
        // bottom when you are there.
        totalListHeightChanged={() => {
          if (!reanchor() && stick.current && !hasNewer.current) vref.current?.scrollToIndex({ index: "LAST", align: "end" });
        }}
        atBottomStateChange={(b) => {
          stick.current = b;
          setBottomVisible(b);
        }}
        startReached={() => void loadOlder()}
        endReached={() => void loadNewer()}
        rangeChanged={(r) => {
          range.current = r;
          setRendered(r);
          measure();
        }}
        increaseViewportBy={{ top: 800, bottom: 400 }}
        computeItemKey={(_, it) => it.key}
        scrollerRef={(el) => { scroller.current = el instanceof HTMLElement ? el : null; }}
        components={listComponents}
        itemContent={(_, it) => (
          // The padding keeps row margins inside the item, where Virtuoso measures them.
          <div className="py-px">
            {it.kind === "day" ? <DayDivider date={it.date} />
              : it.kind === "unread" ? <UnreadDivider />
              : it.m.kind === "member_leave" ? (
                <p className="m-0 flex items-center gap-2 px-4 pb-0.5 pt-2 text-sm text-muted-foreground">
                  <LogOut className="size-4 flex-none" aria-hidden />
                  <span><span className="font-semibold text-foreground">{it.m.author && displayName(it.m.author)}</span> left the group.</span>
                  <time className="text-xs" dateTime={it.m.created_at}>{stamp(new Date(it.m.created_at))}</time>
                </p>
              ) : variant === "cards" ? (
                <Card className="mx-auto w-[calc(100%-2rem)] max-w-3xl gap-0 py-0">{row(it.m, false)}</Card>
              ) : row(it.m, it.grouped)}
          </div>
        )}
      />
      <MessageAnnouncer channelId={channelId} />
      {list.hasNewer && (
        <div className="mx-4 flex shrink-0 items-center gap-1 rounded-t-lg bg-secondary py-1 pl-3 pr-1 text-sm text-secondary-foreground shadow-md">
          <span className="min-w-0 flex-1 truncate font-medium">You're viewing older messages</span>
          <Button size="sm" variant="ghost" className="h-7" disabled={jumping} onClick={async () => {
            setJumping(true);
            try {
              await client.loadLatest(channelId);
              await nextFrame(); // let React render the page
              listApi.get(channelId)?.scrollToBottom();
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

function MessageRowView({ m, grouped, mine, mentioned, canManage, canReply, canReact, reply, canCreateThread, onOpenThread, card = false, tabbable, onRowFocus, onNavigate, neighbour }: {
  m: ClientMessage; grouped: boolean; mine: boolean; mentioned: boolean; canManage: boolean; canReply: boolean; canReact: boolean;
  reply: ReplyState; canCreateThread: boolean; onOpenThread?: (threadId: string) => void; card?: boolean;
  tabbable: boolean; onRowFocus: (id: string) => void;
  /** Moves focus to the row a navigation key leads to. */
  onNavigate: (id: string, act: "prev" | "next" | "first" | "last") => void;
  /** The id of the row to focus once this one is deleted. */
  neighbour: (id: string) => string | undefined;
}) {
  // Deleting someone else's server message also needs me to outrank them; DMs have no hierarchy.
  // A voice channel's side chat has no pins panel, so no pinning there.
  const canPin = useApp((s) => {
    const type = s.channels[m.channel_id]?.type;
    return type !== "voice" && !isSystemDM(s.channels[m.channel_id]) && (canManage || type === "dm");
  });
  // A webhook message has no author to outrank: MANAGE_MESSAGES is enough.
  const canDelete = useApp((s) => mine || (canManage && (s.channels[m.channel_id]?.type === "dm" || !m.author || outranksUser(s, m.author.id))));
  const color = useApp((s) => (s.channels[m.channel_id]?.type === "dm" || !m.author ? undefined : roleColor(s.server, m.author.id)));
  const [profileOpen, setProfileOpen] = useState(false);
  const avatarRef = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState(false);
  const stopEditing = () => { setEditing(false); requestAnimationFrame(() => row.current?.focus({ preventScroll: true })); };
  const [draft, setDraft] = useState(m.content);
  const [titleDraft, setTitleDraft] = useState(m.title ?? "");
  const [confirming, setConfirming] = useState(false);
  const [reminding, setReminding] = useState(false);
  const canRemind = useApp((s) => !isSystemDM(s.channels[m.channel_id])) && !m.kind;
  const channelName = useApp((s) => (s.channels[m.channel_id]?.type === "dm" ? undefined : s.channels[m.channel_id]?.name));
  const isDM = useApp((s) => s.channels[m.channel_id]?.type === "dm");
  const [error, setError] = useState<string>();
  const [reactError, showReactError] = useBriefError();
  const [albumError, showAlbumError] = useBriefError();
  const path = { params: { path: { id: m.channel_id, messageID: m.id } } };
  const author = useMessageAuthor(m);
  const hook = m.author ? undefined : m.webhook; // posted by a webhook: no profile, a WEBHOOK badge
  const name = displayName(author);
  const replyTo = m.reply_to;
  const playable = useMemo(() => (m.deleted ? undefined : firstPlayer(m.content, window.location.hostname)), [m.content, m.deleted]);
  // An edited spin is shown as text with "(edited)", so a changed winner can't pass for a real spin.
  const wheel = useMemo(() => (m.deleted || m.edited_at ? null : parseWheel(m.content)), [m.content, m.deleted, m.edited_at]);

  const save = async () => {
    // Only announcement cards carry a title.
    const title = card ? titleDraft.trim() : undefined;
    const titleChanged = title !== undefined && title !== (m.title ?? "");
    if (draft === m.content && !titleChanged) {
      stopEditing();
      return;
    }
    try {
      await unwrap(client.api.PATCH("/api/channels/{id}/messages/{messageID}", { ...path, body: { content: draft, ...(titleChanged && { title }) } }));
      stopEditing();
    } catch (e) {
      setError(errorText(e));
    }
  };
  // Set once Delete is confirmed: focus then goes to a neighbour, so the dialog's close mustn't put it back on this row.
  const confirmed = useRef(false);
  const remove = async () => {
    confirmed.current = true;
    setConfirming(false);
    const next = neighbour(m.id);
    const list = row.current?.parentElement;
    try {
      await unwrap(client.api.DELETE("/api/channels/{id}/messages/{messageID}", path));
      requestAnimationFrame(() => ((next && document.getElementById(`message-${next}`)) || composer(list))?.focus());
    } catch (e) {
      confirmed.current = false;
      setError(errorText(e));
      row.current?.focus();
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
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  useEffect(() => onEditRequest(m.id, () => onEditRef.current?.()), [m.id]);
  const onPin = canPin ? () => void (m.pinned ? client.unpin(m.channel_id, m.id) : client.pin(m.channel_id, m.id)).catch((e) => setError(errorText(e))) : undefined;
  const onDelete = canDelete ? () => { confirmed.current = false; setConfirming(true); } : undefined;
  const actionable = !m.pending && !m.deleted && !editing;
  // Radix skips its menu (and its preventDefault) while the trigger is disabled, so links, media and
  // selected text keep the native menu: decide on pointerdown, which precedes contextmenu.
  const [nativeMenu, setNativeMenu] = useState(false);
  // Phones: long-press opens a bottom sheet, swipe right replies.
  const [sheet, setSheet] = useState(false);
  const [picker, setPicker] = useState(false);
  // Touch-only sheets mount on first open (a closed vaul drawer still listens to the window), never without touch.
  const touchy = canLongPress();
  const sheetMounted = useLatch(sheet);
  const pickerMounted = useLatch(picker);
  const acts = messageActions(m, {
    reply: !!onReply, react: canReact, thread: !!openThread && canCreateThread, hasThread: !!thread && !!openThread, edit: !!onEdit,
    pin: !!onPin, pinned: m.pinned, album: (m.attachments?.length ?? 0) > 0 && !isDM, remind: canRemind, delete: !!onDelete,
  });
  const lastTouch = useRef(false);
  const inRow = (e: { currentTarget: Element; target: EventTarget }) => e.currentTarget.contains(e.target as Node);
  const press = useLongPress(() => {
    swipe.cancel(); // hold-then-drag must not also reply
    setSheet(true);
  }, touchy && !!acts?.length && !nativeMenu && !editing);
  const swipe = useSwipeReply(() => onReply?.(), !!onReply && actionable && !editing);
  const react = (emoji: string) => {
    recordEmoji(emoji);
    void client.react(m.channel_id, m.id, emoji).catch(showReactError);
  };

  return (
    <>
    <ContextMenu modal={false}>
    <ContextMenuTrigger asChild disabled={!actionable || nativeMenu || isTouchOnly()}>
    <article id={`message-${m.id}`} ref={row} data-message-row tabIndex={tabbable ? 0 : -1}
      aria-labelledby={`message-${m.id}-name message-${m.id}-time`}
      aria-describedby={!m.deleted && !editing && (m.content || m.edited_at) ? `message-${m.id}-text` : undefined}
      onFocus={(e) => { if (e.target === e.currentTarget) onRowFocus(m.id); }}
      onPointerDownCapture={(e) => setNativeMenu(!!(e.target as HTMLElement).closest("a, img, video, audio") || !!window.getSelection()?.toString())}
      onPointerDown={(e) => {
        if (!inRow(e)) return;
        // Touch and pen never use Radix's own long-press menu: our sheet handles them.
        lastTouch.current = e.pointerType !== "mouse";
        // Links and media keep the browser's own long-press menu; fields and buttons keep focus, caret and clicks.
        if (lastTouch.current && !editing && !(e.target as HTMLElement).closest(KEEP_TOUCH_DEFAULT)) e.preventDefault();
        press.onPointerDown(e);
        swipe.handlers.onPointerDown(e);
      }}
      onPointerMove={(e) => { if (!inRow(e)) return; press.onPointerMove(e); swipe.handlers.onPointerMove(e); }}
      onPointerUp={(e) => { if (!inRow(e)) return; press.onPointerUp(e); swipe.handlers.onPointerUp(e); }}
      onPointerCancel={(e) => { if (!inRow(e)) return; press.onPointerCancel(); swipe.handlers.onPointerCancel(); }}
      onClickCapture={(e) => { if (inRow(e)) press.onClickCapture(e); }}
      onContextMenu={(e) => {
        if (!inRow(e)) return;
        if (lastTouch.current && !nativeMenu) e.preventDefault(); // Windows touch long-press: no Radix menu
        press.onContextMenu(e);
      }}
      onKeyDown={(e) => {
        lastTouch.current = false;
        const act = messageKeyAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing }, e.target === e.currentTarget);
        if (!act) return;
        const nav = act === "prev" || act === "next" || act === "first" || act === "last";
        const run: Record<MessageKey, (() => void) | undefined> = {
          prev: undefined, next: undefined, first: undefined, last: undefined,
          menu: () => e.currentTarget.querySelector<HTMLElement>("[data-message-menu]")?.click(),
          reply: onReply, edit: onEdit, thread: openThread, pin: onPin,
          react: () => e.currentTarget.querySelector<HTMLElement>("[data-message-react]")?.click(),
          delete: onDelete,
          composer: () => composer(row.current)?.focus(),
        };
        // A deleted, pending or failed message (or one being edited) only lets focus move on.
        if (!nav && act !== "composer" && !actionable) return;
        const fn = nav ? () => onNavigate(m.id, act) : run[act];
        if (!fn) return;
        e.preventDefault();
        fn();
      }}
      style={{ transform: swipe.offset ? `translateX(${swipe.offset}px)` : undefined }}
      className={cn("group relative grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 px-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring touch-pan-y pointer-coarse:[-webkit-touch-callout:none]",
        swipe.offset === 0 && "motion-safe:transition-transform",
        card ? "rounded-xl py-4" : grouped ? "py-0.5" : "mt-2 pb-0.5 pt-1",
        mentioned ? "border-l-2 border-primary bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] pl-3.5" : !card && "hover:bg-card/50")}>
      {swipe.offset > 0 && <Reply aria-hidden className="absolute left-2 top-1/2 size-5 -translate-x-[calc(100%+0.5rem)] -translate-y-1/2 text-muted-foreground" style={{ opacity: Math.min(1, swipe.offset / 64) }} />}
      {replyTo && <ReplyQuote reply={replyTo} onJump={() => void jump(replyTo.id)} />}
      {grouped ? (
        <span className="flex min-w-0 justify-end">
          <span id={`message-${m.id}-name`} className="sr-only">{name}</span>
          <span id={`message-${m.id}-time`} className="sr-only">{stamp(new Date(m.created_at))}</span>
          <time aria-hidden dateTime={m.created_at} title={fullStamp(new Date(m.created_at))}
            className="invisible self-start whitespace-nowrap pt-0.5 text-right text-caption text-muted-foreground group-hover:visible group-focus-within:visible">
            {clockTime(new Date(m.created_at))}
          </time>
        </span>
      ) : (
        <button ref={avatarRef} type="button" tabIndex={-1} aria-hidden className="size-10 self-start justify-self-start rounded-full" onClick={() => !m.author?.system && setProfileOpen((o) => !o)}>
          {hook ? <WebhookAvatar avatarUrl={hook.avatar_url} size="lg" /> : <UserAvatar user={author} size="lg" />}
        </button>
      )}
      <div className="min-w-0">
        {!grouped && (
          <header className="flex items-baseline gap-2">
            {hook ? (
              <WebhookPopover webhook={hook} open={profileOpen} onOpenChange={setProfileOpen}
                onInteractOutside={(e) => avatarRef.current?.contains(e.target as Node) && e.preventDefault()}>
                <NameButton id={`message-${m.id}-name`} className="font-semibold hover:underline">{name}</NameButton>
              </WebhookPopover>
            ) : m.author?.system ? (
              <span id={`message-${m.id}-name`} className="font-semibold">{name}</span>
            ) : (
              <ProfilePopover userId={author.id} fallback={m.author} open={profileOpen} onOpenChange={setProfileOpen}
                onInteractOutside={(e) => avatarRef.current?.contains(e.target as Node) && e.preventDefault()}>
                <NameButton id={`message-${m.id}-name`} className="font-semibold hover:underline" style={{ color }}>{name}</NameButton>
              </ProfilePopover>
            )}
            {m.author && <MemberRoleIcon userId={m.author.id} className="self-center" />}
            {hook ? <WebhookBadge /> : m.author?.system ? <SystemBadge /> : m.author && <GuestBadge user={m.author} />}
            <time id={`message-${m.id}-time`} className="text-xs text-muted-foreground" dateTime={m.created_at} title={fullStamp(new Date(m.created_at))}>{headStamp(new Date(m.created_at))}</time>
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
                    stopEditing();
                  }
                }} />
            )}
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={4000} aria-label="Edit message" autoFocus
              enterKeyHint={isTouchOnly() ? "enter" : undefined}
              onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  stopEditing();
                } else if (enterAction({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }, isTouchOnly()) === "send") {
                  e.preventDefault();
                  void save();
                }
              }} />
            {isTouchOnly() ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Return adds a line · tap <Button type="submit" variant="link" className="h-auto p-0 text-xs">save</Button>
                {" or "}<Button variant="link" className="h-auto p-0 text-xs" onClick={stopEditing}>cancel</Button>
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Escape to <Button variant="link" className="h-auto p-0 text-xs" onClick={stopEditing}>cancel</Button>
                {" · "}Enter to <Button type="submit" variant="link" className="h-auto p-0 text-xs">save</Button>
              </p>
            )}
          </form>
        ) : m.reminder ? (
          <div id={`message-${m.id}-text`}><ReminderCard info={m.reminder} /></div>
        ) : wheel ? (
          <div id={`message-${m.id}-text`}>
            <span className="sr-only">{m.content}</span>
            <WheelCard id={m.id} wheel={wheel} createdAt={m.created_at} pending={m.pending} />
          </div>
        ) : m.content || m.edited_at ? (
          <div id={`message-${m.id}-text`} className={cn("wrap-anywhere max-w-[80ch]", m.pending && "opacity-60")}>
            <Markdown text={m.content} mentions={m.pending ? undefined : m.mentions ?? undefined} roles={m.pending ? undefined : m.mention_roles ?? undefined} everyone={!!m.mention_everyone} />
            {/* Grouped rows have no header, so "(edited)" follows the text. */}
            {grouped && m.edited_at && <span className="edited text-xs text-muted-foreground"> (edited)</span>}
          </div>
        ) : null}
        {!m.deleted && m.poll && <PollCard message={m} poll={m.poll} canEnd={mine || canManage} />}
        {!m.deleted && <Attachments items={m.attachments ?? []} />}
        {!m.deleted && m.embeds && m.embeds.length > 0 && <WebhookEmbeds embeds={m.embeds} />}
        {!m.deleted && !editing && playable && <InlinePlayer player={playable.player} url={playable.url} embed={m.embed?.url === playable.url ? m.embed : undefined} />}
        {!m.deleted && !editing && m.embed && m.embed.url !== playable?.url && <LinkPreview embed={m.embed} />}
        {!m.deleted && <Reactions message={m} canAdd={canReact} />}
        {thread && openThread && <div><ThreadSummary summary={thread} onOpen={openThread} /></div>}
        {m.failed && <ErrorText error="Not sent." />}
        <ErrorText error={error} />
        <ErrorText error={reactError} />
        <ErrorText error={albumError} />
      </div>
      {actionable && (
        <MessageToolbar
          onReact={canReact ? (emoji) => void client.react(m.channel_id, m.id, emoji).catch(showReactError) : undefined}
          onReply={onReply}
          onThread={openThread} hasThread={!!thread}
          onEdit={onEdit}
          onPin={onPin}
          pinned={m.pinned}
          onCopy={m.content ? () => void navigator.clipboard?.writeText(m.content).catch(() => undefined) : undefined}
          albumItems={(m.attachments?.length ?? 0) > 0 && !isDM && !m.pending
            ? <AddToAlbumMenuItems attachmentIds={m.attachments!.map((a) => a.id)} onError={showAlbumError} />
            : undefined}
          remindItems={canRemind ? <RemindMenuItems message={m} kind="dropdown" onCustom={() => setReminding(true)} /> : undefined}
          onDelete={onDelete} />
      )}
      {canReact && touchy && pickerMounted && <EmojiPicker open={picker} onOpenChange={setPicker} onPick={(v) => react(reactionKey(v))} />}
    </article>
    </ContextMenuTrigger>
    <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => {
      e.preventDefault();
      const a = document.activeElement;
      if (!a?.matches("input, textarea, select, [contenteditable]:not([contenteditable=false])") && !shouldKeepFocus(a, row.current, document.body)) row.current?.focus({ preventScroll: true });
    }}>
      {onReply && <ContextMenuItem onSelect={onReply}><Reply />Reply</ContextMenuItem>}
      {openThread && (thread
        ? <ContextMenuItem onSelect={openThread}><MessageSquare />Open thread</ContextMenuItem>
        : <ContextMenuItem onSelect={openThread}><MessageSquarePlus />Create thread</ContextMenuItem>)}
      {onEdit && <ContextMenuItem onSelect={onEdit}><Pencil />Edit message</ContextMenuItem>}
      {onPin && <ContextMenuItem onSelect={onPin}>{m.pinned ? <><PinOff />Unpin message</> : <><Pin />Pin message</>}</ContextMenuItem>}
      {m.content && <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(m.content).catch(() => undefined)}><Copy />Copy text</ContextMenuItem>}
      {canRemind && (
        <ContextMenuSub>
          <ContextMenuSubTrigger><AlarmClock />Remind me</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-60"><RemindMenuItems message={m} kind="context" onCustom={() => setReminding(true)} /></ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {(m.attachments?.length ?? 0) > 0 && !isDM && !m.pending && (
        <ContextMenuSub>
          <ContextMenuSubTrigger><Images />Add to album</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-56">
            <AddToAlbumContextItems attachmentIds={m.attachments!.map((a) => a.id)} onError={showAlbumError} />
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {onDelete && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onDelete}><Trash2 />Delete message</ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
    </ContextMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-[480px]" onContextMenu={(e) => e.stopPropagation()}
          onCloseAutoFocus={(e) => { e.preventDefault(); if (!confirmed.current && row.current?.isConnected) row.current.focus({ preventScroll: true }); }}>
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
      {reminding && <ReminderDialog onClose={() => setReminding(false)}
        // The menu item that opened it is gone: back to the row, like the delete dialog.
        onCloseAutoFocus={(e) => { e.preventDefault(); if (row.current?.isConnected) row.current.focus({ preventScroll: true }); }}
        message={{ id: m.id, channel_id: m.channel_id, authorName: name, excerpt: m.content, channelName }} />}
      {touchy && sheetMounted && !!acts?.length && (
        <MessageSheet open={sheet} onOpenChange={setSheet} message={m} actions={acts} hasThread={!!thread} pinned={m.pinned}
          onReact={react} onMoreReactions={() => setPicker(true)}
          onReply={() => onReply?.()} onThread={() => openThread?.()} onEdit={() => onEdit?.()}
          onCopy={() => void navigator.clipboard?.writeText(m.content).catch(() => undefined)}
          onPin={() => onPin?.()} onAlbumError={showAlbumError} onRemind={() => setReminding(true)} onDelete={() => onDelete?.()}
          preview={(
            <div className="mx-4 mb-1 max-h-24 overflow-hidden rounded-lg border bg-background px-3 py-2 text-sm wrap-anywhere">
              <strong className="font-semibold" style={{ color }}>{name}</strong>
              <p className="m-0 line-clamp-2 text-muted-foreground">{m.content || ((m.attachments?.length ?? 0) > 0 ? "Attachment" : "")}</p>
            </div>
          )} />
      )}
    </>
  );
}
/** A row re-renders only when its message or props change, not whenever the list scrolls. */
const MessageRow = memo(MessageRowView);

/** Images beyond this many are reached through the viewer. */
const MAX_TILES = 4;

/** An image thumbnail that opens the viewer; modified clicks still open the original in a new tab. */
function ImageLink({ image: a, onOpen, className, more = 0, width, height, cover = false }:
  { image: Attachment; onOpen: () => void; className: string; more?: number; width?: number; height?: number; cover?: boolean }) {
  return (
    <a href={client.url(a.url)} target="_blank" rel="noopener noreferrer"
      className="relative block overflow-hidden rounded-lg border bg-card"
      onClick={(e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onOpen();
      }}>
      <img className={cn("block cursor-zoom-in transition-opacity hover:opacity-90", className)}
        {...attachmentImage(a, Math.max(width ?? 240, height ?? 240), { cover })} alt={a.filename} loading="lazy" width={width} height={height} />
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
              cover more={i === tiles.length - 1 ? hidden : 0} />
          ))}
        </div>
      )}
      {images.length > 0 && <ImageViewer images={images} index={viewing} onIndexChange={setViewing} />}
      {others.map((a) => {
        if (a.gif) return <GifMedia key={a.id} attachment={a} />; // an MP4, or a GIF image too big to inline
        const kind = mediaKind(a);
        if (kind === "audio") return <AudioPlayer key={a.id} attachment={a} />;
        if (kind === "video") return <VideoPlayer key={a.id} attachment={a} />;
        if (isCodeFile(a)) return <CodeFileAttachment key={a.id} attachment={a} />;
        return <FileChip key={a.id} attachment={a} />;
      })}
    </div>
  );
}
