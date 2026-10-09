import { Perm, hasPerm, sidebarChannelIds, voiceMembers } from "@datrope/core";
import { useDraggable } from "@dnd-kit/core";
import { HeadphoneOff, MicOff, Video } from "lucide-react";
import { useState, type PointerEventHandler, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { UserAvatar } from "@/components/user-avatar";
import { useUser } from "@/hooks/use-user";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { client, errorText, outranksUser, useApp, usePerms, userName } from "../../session";
import { useVoice } from "../../voice/voice";
import { AvatarTrigger } from "../people/AvatarTrigger";
import { AdjustedBadge, PersonMenu } from "./PersonMenu";

/** Who is in a voice channel, shown under it in the sidebar, with moderation for those allowed. */
export function VoiceMembers({ channelId, name }: { channelId: string; name: string }) {
  const members = useApp(useShallow((s) => voiceMembers(s, channelId)));
  const names = useApp(useShallow((s) => voiceMembers(s, channelId).map((v) => userName(s, v.user_id))));
  // Selectors must return stable values: IDs here, names from the (stable) channels map below.
  const otherIds = useApp(useShallow((s) => sidebarChannelIds(s)
    .filter((id) => id !== channelId && s.channels[id]?.type === "voice")));
  const channels = useApp((s) => s.channels);
  const above = useApp(useShallow((s) => voiceMembers(s, channelId).map((v) => outranksUser(s, v.user_id))));
  const meId = useApp((s) => s.me?.id);
  const speaking = useVoice((v) => (v.channelId === channelId ? v.speaking : NOBODY));
  const perms = usePerms(channelId);
  const [error, setError] = useState<string>();
  if (members.length === 0) return null;
  const canMute = hasPerm(perms, Perm.MuteMembers);
  const canMove = hasPerm(perms, Perm.MoveMembers);
  const act = (p: Promise<unknown>) => p.then(() => setError(undefined), (e: unknown) => setError(errorText(e)));

  return (
    <ul className="mb-1 ml-5 list-none" aria-label={`In voice: ${name}`}>
      {members.map((v, i) => {
        const row = (
          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-sm text-muted-foreground hover:bg-accent">
            <span className="flex-1 truncate text-left">{names[i]}</span>
            {v.screen && <Badge variant="destructive" className="px-1 py-0 text-[0.6rem]">LIVE</Badge>}
            {v.camera && <Video className="size-3.5" role="img" aria-label="Camera on" />}
            {(v.self_mute || v.server_mute) && (
              <MicOff className={cn("size-3.5", v.server_mute && "text-destructive")} role="img" aria-label={v.server_mute ? "Muted by a moderator" : "Muted"} />
            )}
            {v.self_deaf && <HeadphoneOff className="size-3.5" role="img" aria-label="Deafened" />}
            <AdjustedBadge userId={v.user_id} />
          </span>
        );
        // Everyone but me: right-click or "More" opens my local settings for them.
        // Those I may move can also be dragged onto another voice channel in the sidebar.
        const item = (content: ReactNode) => (
          <MemberItem key={v.user_id} userId={v.user_id} channelId={channelId} movable={v.user_id !== meId && above[i] && canMove}>
            <AvatarTrigger userId={v.user_id} name={names[i]} side="right">
              <VoiceAvatar userId={v.user_id} name={names[i]} speaking={speaking.includes(v.user_id)} />
            </AvatarTrigger>
            {v.user_id === meId ? content : (
              <PersonMenu userId={v.user_id} name={names[i]} hasCamera={!!v.camera} className="flex min-w-0 flex-1 items-center gap-0.5">{content}</PersonMenu>
            )}
          </MemberItem>
        );
        if (v.user_id === meId || !above[i] || !(canMute || canMove)) return item(row);
        return item(
            <ModMenu row={row} label={`Voice options for ${names[i]}`}>
              {canMute && (
                <DropdownMenuItem onSelect={() => act(client.serverMute(v.user_id, !v.server_mute))}>
                  {v.server_mute ? "Remove server mute" : "Server mute"}
                </DropdownMenuItem>
              )}
              {canMove && otherIds.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {otherIds.map((id) => (
                      <DropdownMenuItem key={id} onSelect={() => act(client.moveVoice(v.user_id, id))}>{channels[id]?.name}</DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {canMove && (
                <DropdownMenuItem variant="destructive" onSelect={() => act(client.disconnectVoice(v.user_id))}>Disconnect</DropdownMenuItem>
              )}
            </ModMenu>,
        );
      })}
      {error && <li className="px-2 text-xs text-destructive" role="alert">{error}</li>}
    </ul>
  );
}

/** A member's row; dragging it (pointer only) onto another voice channel moves them. Keyboard users have "Move to". */
function MemberItem({ userId, channelId, movable, children }: { userId: string; channelId: string; movable: boolean; children: ReactNode }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `vm:${userId}`, data: { from: channelId }, disabled: !movable });
  return (
    <li ref={setNodeRef} onPointerDownCapture={listeners?.onPointerDown as PointerEventHandler | undefined} className={cn("flex items-center gap-1", isDragging && "opacity-40")}>
      {children}
    </li>
  );
}

/** Moderation for a member. It opens on click rather than pointer down, so pressing the row can start a drag. */
function ModMenu({ row, label, children }: { row: ReactNode; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="w-full min-w-0 flex-1 rounded-md" aria-label={label}
        onPointerDown={(e) => e.preventDefault()} onClick={() => setOpen(true)}>{row}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function VoiceAvatar({ userId, name, speaking }: { userId: string; name: string; speaking: boolean }) {
  const user = useUser(userId);
  return (
    <UserAvatar user={user ?? { id: userId, username: name }} size="sm"
      className={cn("ring-2 ring-transparent", speaking && "ring-online")} />
  );
}

const NOBODY: string[] = [];
