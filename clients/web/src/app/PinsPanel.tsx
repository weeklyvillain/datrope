import { Perm, hasPerm, type Message } from "@datrope/core";
import { Pin, PinOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client, displayName, errorText, useApp, usePerms } from "../session";
import { Markdown } from "@/chat/Markdown";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { RefButton } from "@/components/ref-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Attachments } from "./MessageList";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** The header's "Pinned messages" button and the popover listing the channel's pins, newest pin first. */
export function PinsPanel({ channelId, onJump }: { channelId: string; onJump: (messageId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pins, setPins] = useState<Message[]>();
  const [error, setError] = useState<string>();
  const isDM = useApp((s) => s.channels[channelId]?.type === "dm");
  const manage = hasPerm(usePerms(channelId), Perm.ManageMessages);
  const canUnpin = isDM || manage;

  // Loads can overlap (opening, then pin events); only the newest one may set the list.
  const latest = useRef(0);
  const load = useCallback(() => {
    const n = ++latest.current;
    client.listPins(channelId).then(
      (p) => { if (n === latest.current) { setPins(p); setError(undefined); } },
      (e) => { if (n === latest.current) setError(errorText(e)); },
    );
  }, [channelId]);

  // Reload when the panel opens, and while open when a message here is pinned, unpinned or deleted.
  useEffect(() => {
    if (!open) return;
    setPins(undefined);
    load();
    return client.onEvent((type, data) => {
      const m = data as Message;
      if ((type === "MESSAGE_UPDATE" || type === "MESSAGE_DELETE") && m.channel_id === channelId) load();
    });
  }, [open, channelId, load]);

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
        <ErrorText error={error} />
        {!pins && !error && <p className="m-0 p-4 text-center text-sm text-muted-foreground">Loading…</p>}
        {pins?.length === 0 && <p className="m-0 p-4 text-center text-sm text-muted-foreground">No pinned messages yet.</p>}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {pins?.map((m) => (
            <PinRow key={m.id} m={m} canUnpin={canUnpin} onJump={() => { setOpen(false); onJump(m.id); }} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function PinRow({ m, canUnpin, onJump }: { m: Message; canUnpin: boolean; onJump: () => void }) {
  const [error, setError] = useState<string>();
  return (
    <li className="rounded-md border bg-background px-3 py-2">
      <div className="flex items-center gap-2">
        <strong className="min-w-0 flex-1 truncate font-semibold">{displayName(m.author)}</strong>
        <time className="flex-none text-xs text-muted-foreground" dateTime={m.created_at}>{dateTime.format(new Date(m.created_at))}</time>
        <Button variant="outline" size="xs" onClick={onJump}>Jump</Button>
        {canUnpin && (
          <Button variant="ghost" size="icon-sm" aria-label={`Unpin message from ${displayName(m.author)}, ${dateTime.format(new Date(m.created_at))}`} title="Unpin" className="text-muted-foreground"
            onClick={() => { setError(undefined); client.unpin(m.channel_id, m.id).catch((e) => setError(errorText(e))); }}>
            <PinOff />
          </Button>
        )}
      </div>
      <div className="wrap-anywhere text-sm">
        <Markdown text={m.content} mentions={m.mentions ?? undefined} />
      </div>
      <Attachments items={m.attachments ?? []} />
      <ErrorText error={error} />
    </li>
  );
}
