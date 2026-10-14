import { LogOut, SquarePen } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { UserAvatar } from "@/components/user-avatar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { dmName, initials, isUnread, useApp } from "../session";
import { LeaveGroupDialog } from "./dialogs/LeaveGroupDialog";
import { NewDMDialog } from "./dialogs/NewDMDialog";

/** The Messages tab: "New message" and the conversations, newest first. */
export function DMList({ activeId }: { activeId?: string }) {
  const dmIds = useApp((s) => s.dmIds);
  const channels = useApp((s) => s.channels);
  const readStates = useApp((s) => s.readStates);
  const presences = useApp((s) => s.presences);
  const meId = useApp((s) => s.me?.id);
  const [picking, setPicking] = useState(false);
  const [leaving, setLeaving] = useState<string>();

  return (
    <>
      <div className="px-2 pt-2 pb-1">
        <Button variant="outline" size="sm" className="w-full" onClick={() => setPicking(true)}><SquarePen />New message</Button>
      </div>
      <ul className="grid min-h-0 flex-1 list-none content-start gap-0.5 overflow-y-auto overscroll-y-contain px-2 pt-1 pb-2" aria-label="Conversations">
        {dmIds.map((id) => {
          const ch = channels[id];
          const name = dmName(ch, meId);
          const others = ch?.participants?.filter((p) => p.id !== meId) ?? [];
          const unread = isUnread(readStates[id]);
          const active = id === activeId;
          const row = (
            <li key={id}>
              <Link to={`/messages/${id}`} aria-current={active ? "page" : undefined}
                className={cn("flex items-center gap-2.5 rounded-md p-2 text-foreground no-underline hover:bg-accent", active && "bg-accent")}>
                <span className="relative flex-none">
                  {others.length === 1 && !ch?.group ? (
                    <UserAvatar user={others[0]} size="lg" status={presences[others[0].id] ?? "offline"} ringClassName="ring-sidebar" />
                  ) : (
                    <Avatar className="size-10">
                      <AvatarFallback className="text-sm font-semibold text-foreground">{initials(name)}</AvatarFallback>
                    </Avatar>
                  )}
                </span>
                <span className={cn("min-w-0 flex-1 truncate", unread && "font-semibold")}>{name}</span>
                {unread && <span className="size-2 flex-none rounded-full bg-foreground" role="img" aria-label="Unread" />}
              </Link>
            </li>
          );
          return !ch?.group ? row : (
            <ContextMenu modal={false} key={id}>
              <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
              <ContextMenuContent className="w-52">
                <ContextMenuItem variant="destructive" onSelect={() => setLeaving(id)}><LogOut />Leave group</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {dmIds.length === 0 && <li className="p-2 text-sm text-muted-foreground">No conversations yet.</li>}
      </ul>
      {picking && <NewDMDialog onClose={() => setPicking(false)} />}
      {leaving && <LeaveGroupDialog channelId={leaving} onClose={() => setLeaving(undefined)} />}
    </>
  );
}
