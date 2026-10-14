import { AtSign, CircleUser, Hash, MessageCircle, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { isUnread, useApp } from "../../session";
import { tabFor, tabPath, type PhoneTab } from "./tabs";

const TABS: { tab: PhoneTab; name: string; icon: LucideIcon }[] = [
  { tab: "server", name: "Server", icon: Hash },
  { tab: "messages", name: "Messages", icon: MessageCircle },
  { tab: "mentions", name: "Mentions", icon: AtSign },
  { tab: "you", name: "You", icon: CircleUser },
];

/** The phone's bottom navigation: Server, Messages, Mentions, You. Tab roots only; pushed screens hide it. */
export function TabBar() {
  const current = tabFor(useLocation().pathname);
  const id = useId();
  // Server: a dot for unread channels (DMs count under Messages). Messages and Mentions: counts.
  const channelUnread = useApp((s) => Object.entries(s.readStates).some(([cid, rs]) => !s.dmIds.includes(cid) && isUnread(rs)));
  const dmUnread = useApp((s) => s.dmIds.filter((cid) => isUnread(s.readStates[cid])).length);
  const mentions = useApp((s) => s.mentions.unread);
  const counts: Record<PhoneTab, number> = { server: 0, messages: dmUnread, mentions, you: 0 };

  return (
    <nav aria-label="Tabs" className="flex min-h-[60px] flex-none border-t bg-sidebar px-safe pb-safe">
      {TABS.map(({ tab, name, icon: Icon }) => {
        const n = counts[tab];
        const dot = tab === "server" && channelUnread;
        const note = n > 0 ? `${n} unread` : dot ? "Unread" : undefined;
        return (
          // The accessible name stays the tab name; the badge is its description.
          <Link key={tab} to={tabPath[tab]} aria-label={name} aria-current={tab === current ? "page" : undefined}
            aria-describedby={note ? `${id}-${tab}` : undefined}
            className={cn("flex min-h-[60px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] no-underline",
              tab === current ? "text-foreground" : "text-muted-foreground")}>
            <span className="relative flex">
              <Icon className="size-[22px]" aria-hidden />
              {dot && <span className="absolute -top-0.5 -right-1 size-2 rounded-full bg-foreground" aria-hidden />}
              {n > 0 && (
                <span className="absolute -top-1.5 left-3.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 font-semibold text-destructive-foreground" aria-hidden>
                  {n > 99 ? "99+" : n}
                </span>
              )}
            </span>
            <span aria-hidden>{name}</span>
            {note && <span id={`${id}-${tab}`} hidden>{note}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
