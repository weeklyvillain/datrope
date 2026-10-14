import { AtSign } from "lucide-react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useApp } from "../session";
import { RefButton } from "@/components/ref-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MentionsList } from "./mobile/MentionsList";

/** Whether the inbox popover is open (the /mentions route opens it on desktop). */
export const inboxStore = createStore<{ open: boolean }>(() => ({ open: false }));

/** The header's "Inbox" button: an unread count badge, and a popover listing the messages that mention me. */
export function InboxButton() {
  const open = useStore(inboxStore, (s) => s.open);
  const setOpen = (o: boolean) => inboxStore.setState({ open: o });
  const unread = useApp((s) => s.mentions.unread);
  const onOpenChange = (o: boolean) => setOpen(o);
  const label = unread > 0 ? `Inbox, ${unread > 99 ? "99+" : unread} unread` : "Inbox";

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex">
            <PopoverTrigger asChild>
              <RefButton variant="ghost" size="icon-sm" aria-label="Inbox" aria-expanded={open} aria-describedby={unread > 0 ? "inbox-unread" : undefined}
                className={open ? "relative text-foreground" : "relative text-muted-foreground"}>
                <AtSign />
                {unread > 0 && <span id="inbox-unread" className="sr-only">{unread > 99 ? "99+" : unread} unread</span>}
                {unread > 0 && (
                  <span aria-hidden className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-mention px-1 text-caption font-semibold leading-4 text-mention-foreground">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </RefButton>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="max-h-[70vh] w-[420px] max-w-[95vw] overflow-y-auto p-0" aria-label="Inbox">
        <MentionsList onJump={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
