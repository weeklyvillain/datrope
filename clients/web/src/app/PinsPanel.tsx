import { Perm, hasPerm, type Message } from "@datrope/core";
import { Pin, PinOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client, displayName, errorText, useApp, usePerms } from "../session";
import { Markdown } from "@/chat/Markdown";
import { ActionSheet } from "@/components/action-sheet";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { RefButton } from "@/components/ref-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Attachments } from "./MessageList";
import { shownAuthor } from "./message-author";
import { WebhookBadge } from "./WebhookAuthor";
import { ListSkeleton } from "@/components/loading-skeleton";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** Loads the channel's pins while `open`, reloading when a message here is pinned, unpinned or deleted. */
function usePins(channelId: string, open: boolean) {
  const [pins, setPins] = useState<Message[]>();
  const [error, setError] = useState<string>();
  const isDM = useApp((s) => s.channels[channelId]?.type === "dm");
  const manage = hasPerm(usePerms(channelId), Perm.ManageMessages);

  // Loads can overlap (opening, then pin events); only the newest one may set the list.
  const latest = useRef(0);
  const load = useCallback(() => {
    const n = ++latest.current;
    client.listPins(channelId).then(
      (p) => { if (n === latest.current) { setPins(p); setError(undefined); } },
      (e) => { if (n === latest.current) setError(errorText(e)); },
    );
  }, [channelId]);

  useEffect(() => {
    if (!open) return;
    setPins(undefined);
    load();
    return client.onEvent((type, data) => {
      const m = data as Message;
      if ((type === "MESSAGE_UPDATE" || type === "MESSAGE_DELETE") && m.channel_id === channelId) load();
    });
  }, [open, channelId, load]);

  return { pins, error, canUnpin: isDM || manage };
}

function PinsList({ pins, error, canUnpin, onJump }: { pins?: Message[]; error?: string; canUnpin: boolean; onJump: (messageId: string) => void }) {
  return (
    <>
      <ErrorText error={error} />
      {!pins && !error && <ListSkeleton />}
      {pins?.length === 0 && <Empty className="p-6 md:p-6"><EmptyHeader><EmptyMedia variant="icon"><Pin /></EmptyMedia><EmptyTitle>No pinned messages yet</EmptyTitle><EmptyDescription>Pin one from its menu to keep it here.</EmptyDescription></EmptyHeader></Empty>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {pins?.map((m) => <PinRow key={m.id} m={m} canUnpin={canUnpin} onJump={() => onJump(m.id)} />)}
      </ul>
    </>
  );
}

/** The header's "Pinned messages" button and the popover listing the channel's pins, newest pin first. */
export function PinsPanel({ channelId, onJump }: { channelId: string; onJump: (messageId: string) => void }) {
  const [open, setOpen] = useState(false);
  const { pins, error, canUnpin } = usePins(channelId, open);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex">
            <PopoverTrigger asChild>
              <RefButton variant="ghost" size="icon-sm" aria-label="Pinned messages" className="text-muted-foreground"><Pin /></RefButton>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>Pinned messages</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="max-h-[60vh] w-[420px] max-w-[95vw] overflow-y-auto p-2">
        <h3 className="px-2 pb-1 pt-1 text-sm font-semibold">Pinned messages</h3>
        <PinsList pins={pins} error={error} canUnpin={canUnpin} onJump={(id) => { setOpen(false); onJump(id); }} />
      </PopoverContent>
    </Popover>
  );
}

/** Phones: the same list in a bottom sheet, opened from the overflow menu. */
export function PinsSheet({ channelId, open, onOpenChange, onJump }: {
  channelId: string; open: boolean; onOpenChange: (open: boolean) => void; onJump: (messageId: string) => void;
}) {
  const { pins, error, canUnpin } = usePins(channelId, open);
  return (
    <ActionSheet open={open} onOpenChange={onOpenChange} title="Pinned messages">
      <div role="none" className="max-h-[60vh] overflow-y-auto px-1">
        <PinsList pins={pins} error={error} canUnpin={canUnpin} onJump={(id) => { onOpenChange(false); onJump(id); }} />
      </div>
    </ActionSheet>
  );
}

function PinRow({ m, canUnpin, onJump }: { m: Message; canUnpin: boolean; onJump: () => void }) {
  const [error, setError] = useState<string>();
  const author = shownAuthor(m);
  return (
    <li className="rounded-md border bg-background px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <strong className="min-w-0 truncate font-semibold">{displayName(author)}</strong>
          {!m.author && <WebhookBadge />}
        </span>
        <time className="flex-none text-xs text-muted-foreground" dateTime={m.created_at}>{dateTime.format(new Date(m.created_at))}</time>
        <Button variant="outline" size="xs" onClick={onJump}>Jump</Button>
        {canUnpin && (
          <Button variant="ghost" size="icon-sm" aria-label={`Unpin message from ${displayName(author)}, ${dateTime.format(new Date(m.created_at))}`} title="Unpin" className="text-muted-foreground"
            onClick={() => { setError(undefined); client.unpin(m.channel_id, m.id).catch((e) => setError(errorText(e))); }}>
            <PinOff />
          </Button>
        )}
      </div>
      <div className="wrap-anywhere text-sm">
        <Markdown text={m.content} mentions={m.mentions ?? undefined} />
        {m.poll && <p className="m-0 text-muted-foreground">Poll: {m.poll.question}</p>}
      </div>
      <Attachments items={m.attachments ?? []} />
      <ErrorText error={error} />
    </li>
  );
}
