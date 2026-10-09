import { Perm, hasPerm, sidebarChannelIds, voiceMembers } from "@datrope/core";
import { HeadphoneOff, MicOff, Video } from "lucide-react";
import { useState, type ReactNode } from "react";
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
        const item = (content: ReactNode) => (
          <li key={v.user_id} className="flex items-center gap-1">
            <AvatarTrigger userId={v.user_id} name={names[i]} side="right">
              <VoiceAvatar userId={v.user_id} name={names[i]} speaking={speaking.includes(v.user_id)} />
            </AvatarTrigger>
            {v.user_id === meId ? content : (
              <PersonMenu userId={v.user_id} name={names[i]} hasCamera={!!v.camera} className="flex min-w-0 flex-1 items-center gap-0.5">{content}</PersonMenu>
            )}
          </li>
        );
        if (v.user_id === meId || !above[i] || !(canMute || canMove)) return item(row);
        return item(
            <DropdownMenu>
              <DropdownMenuTrigger className="w-full min-w-0 flex-1 rounded-md" aria-label={`Voice options for ${names[i]}`}>{row}</DropdownMenuTrigger>
              <DropdownMenuContent align="start">
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
              </DropdownMenuContent>
            </DropdownMenu>,
        );
      })}
      {error && <li className="px-2 text-xs text-destructive" role="alert">{error}</li>}
    </ul>
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
