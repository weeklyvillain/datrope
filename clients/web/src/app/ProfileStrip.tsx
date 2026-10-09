import { Perm, hasPerm, type PresenceStatus } from "@datrope/core";
import { HeadphoneOff, Headphones, Mic, MicOff, Settings } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSubmit } from "@/hooks/use-submit";
import { choosePresence, client, displayName, errorText, signOut, useApp, usePerms } from "../session";
import { useVoice, voice } from "../voice/voice";
import { openSettings } from "./settings/settings-store";
import { Control } from "./voice/VoicePanel";

const DOT: Record<PresenceStatus, string> = { online: "online", idle: "idle", invisible: "offline" };

/** Me, at the bottom of the sidebar: presence and custom status, mute, deafen and settings. */
export function ProfileStrip() {
  const me = useApp((s) => s.me);
  const presence = useApp((s) => s.presence);
  const v = useVoice(useShallow((x) => ({ channelId: x.channelId, status: x.status, muted: x.muted, deafened: x.deafened })));
  const serverMuted = useApp((s) => !!(s.me && s.voice[s.me.id]?.server_mute));
  const inVoice = v.status !== "idle" && !!v.channelId;
  const voicePerms = usePerms(inVoice ? v.channelId : undefined);
  const [editing, setEditing] = useState(false);
  if (!me) return null;
  // In a call, muting follows the channel's SPEAK permission and server mute; outside one it is a saved choice.
  const canSpeak = !inVoice || (hasPerm(voicePerms, Perm.Speak) && !serverMuted);
  const name = displayName(me);

  return (
    <section className="flex items-center gap-1 border-t bg-card px-3 py-2.5" aria-label="You">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger className="group -my-1 -ml-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1 text-left outline-none hover:bg-accent focus-visible:bg-accent">
          <UserAvatar user={me} size="md" status={DOT[presence]} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-foreground">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {me.custom_status || <span className="opacity-0 group-hover:opacity-100">Set a status</span>}
            </span>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuRadioGroup value={presence} onValueChange={(p) => choosePresence(p as PresenceStatus)}>
            <DropdownMenuRadioItem value="online">Online</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="idle">Idle</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="invisible">Invisible</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setEditing(true)}>Edit status…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => signOut().catch((e: unknown) => window.alert(errorText(e)))}>
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Control label="Mute" tip={serverMuted && inVoice ? "Muted by a moderator" : v.muted ? "Unmute" : "Mute"} variant="default" className="text-muted-foreground"
        pressed={v.muted || !canSpeak} disabled={!canSpeak} onPressedChange={(on) => void voice.setMuted(on)}>
        {v.muted || !canSpeak ? <MicOff className="text-destructive" /> : <Mic />}
      </Control>
      <Control label="Deafen" tip={v.deafened ? "Undeafen" : "Deafen"} variant="default" className="text-muted-foreground" pressed={v.deafened}
        onPressedChange={(on) => void voice.setDeafened(on)}>
        {v.deafened ? <HeadphoneOff className="text-destructive" /> : <Headphones />}
      </Control>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex">
            <Button variant="ghost" size="icon-sm" aria-label="Your settings" className="text-muted-foreground hover:text-foreground"
              onClick={() => openSettings()}>
              <Settings />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Your settings</TooltipContent>
      </Tooltip>
      {editing && <EditStatusDialog current={me.custom_status} onClose={() => setEditing(false)} />}
    </section>
  );
}

function EditStatusDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const [status, setStatus] = useState(current);
  const { busy, error, run } = useSubmit();
  const save = (custom_status: string) => run(async () => {
    await client.updateMe({ custom_status });
    onClose();
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Edit status</DialogTitle>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          void save(status.trim());
        }}>
          <Input aria-label="Status" placeholder="What are you up to?" value={status} maxLength={80} autoFocus
            onChange={(e) => setStatus(e.target.value)} />
          <ErrorText error={error} />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => void save("")}>Clear</Button>
            <Button type="submit" disabled={busy}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
