import type { Message } from "@datrope/core";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { menuTime, presets } from "@/chat/remind-time";
import { setReminder } from "./reminders";

/** The "Remind me" submenu: presets with their times, then Custom…. */
export function RemindMenuItems({ message, kind, onCustom }: { message: Message; kind: "dropdown" | "context"; onCustom: () => void }) {
  const Item = kind === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
  const now = new Date();
  return (
    <>
      {presets(now).map((p) => (
        <Item key={p.label} onSelect={() => void setReminder({ due_at: p.due.toISOString(), channel_id: message.channel_id, message_id: message.id }).catch(() => undefined)}>
          {p.label}<span className="ml-auto pl-4 text-xs text-muted-foreground">{menuTime(p.due, now)}</span>
        </Item>
      ))}
      <Separator />
      <Item onSelect={onCustom}>Custom…</Item>
    </>
  );
}
