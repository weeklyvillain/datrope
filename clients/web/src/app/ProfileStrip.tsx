import type { PresenceStatus } from "@datrope/core";
import { Settings } from "@/components/icons";
import { useId, useRef, useState } from "react";
import { EmojiInsertButton } from "@/chat/EmojiInsertButton";
import { EmojiText } from "@/chat/EmojiText";
import { RichInput, type RichInputHandle } from "@/chat/RichInput";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSubmit } from "@/hooks/use-submit";
import { choosePresence, client, displayName, errorText, signOut, useApp } from "../session";
import { openSettings } from "./settings/settings-store";
import { DeafenControl, MuteControl } from "./voice/VoicePanel";

const DOT: Record<PresenceStatus, string> = { online: "online", idle: "idle", invisible: "offline" };

/** Me, at the bottom of the sidebar: presence and custom status, mute, deafen and settings. */
export function ProfileStrip() {
  const me = useApp((s) => s.me);
  const presence = useApp((s) => s.presence);
  const [editing, setEditing] = useState(false);
  if (!me) return null;
  const name = displayName(me);

  return (
    <section className="flex items-center gap-1 border-t bg-card px-3 py-2.5" aria-label="You">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger className="group -my-1 -ml-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1 text-left outline-none hover:bg-accent focus-visible:bg-accent">
          <UserAvatar user={me} size="md" status={DOT[presence]} />
          <span className="min-w-0 flex-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{name}</span>
              </TooltipTrigger>
              <TooltipContent side="top">{name}</TooltipContent>
            </Tooltip>
            <span className="block truncate text-xs text-muted-foreground">
              {me.custom_status ? <EmojiText text={me.custom_status} /> : <span className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">Set a status</span>}
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
      <MuteControl variant="default" className="text-muted-foreground" />
      <DeafenControl variant="default" className="text-muted-foreground" />
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

/** Limits a status to 80 characters (code points), as the server does. */
const limit = (v: string) => Array.from(v).slice(0, 80).join("");

export function EditStatusDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const [status, setStatus] = useState(current);
  const fieldId = useId();
  const statusRef = useRef<RichInputHandle>(null);
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
          <div className="flex items-center gap-1">
            <RichInput ref={statusRef} id={fieldId} aria-label="Status" placeholder="What are you up to?" value={status} autoFocus singleLine variant="input" maxLength={80} lengthUnit="codepoint"
              onChange={(v) => setStatus(limit(v))} />
            <EmojiInsertButton field={statusRef} value={status} onChange={(v) => setStatus(limit(v))} />
          </div>
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
