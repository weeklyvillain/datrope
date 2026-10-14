import { Bell, Hash, Megaphone, MessageSquare, Pin, Settings, User, Users } from "lucide-react";
import { Markdown } from "@/chat/Markdown";
import { EmojiText } from "@/chat/EmojiText";
import { ActionSheet, ActionSheetItem } from "@/components/action-sheet";
import { useLayerNavigate } from "@/hooks/use-history-layer";
import { dmName, useApp } from "../../session";

/** The phone's channel info: name, topic, and shortcuts to the channel's panels and settings. A row is hidden when its handler is missing. */
export function ChannelInfoSheet({ channelId, kind, open, onOpenChange, onPins, onMembers, onThreads, onSettings }: {
  channelId: string; kind: "chat" | "announcement"; open: boolean; onOpenChange: (open: boolean) => void;
  onPins: () => void; onMembers?: () => void; onThreads?: () => void; onSettings?: () => void;
}) {
  const ch = useApp((s) => s.channels[channelId]);
  const meId = useApp((s) => s.me?.id);
  const navigate = useLayerNavigate();
  if (!ch) return null;
  const dm = ch.type === "dm";
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  const Icon = dm ? User : kind === "announcement" ? Megaphone : Hash;
  return (
    <ActionSheet open={open} onOpenChange={onOpenChange} title="Channel info" header={(
      <div className="px-5 pb-2 pt-1">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Icon className="size-5 flex-none text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">{dm ? dmName(ch, meId) : <EmojiText text={ch.name} />}</span>
        </div>
        {!dm && ch.topic && <div className="mt-1 max-h-32 overflow-y-auto break-words text-sm text-muted-foreground"><Markdown text={ch.topic} /></div>}
      </div>
    )}>
      <ActionSheetItem icon={<Pin />} onSelect={run(onPins)}>Pinned messages</ActionSheetItem>
      {onMembers && <ActionSheetItem icon={<Users />} onSelect={run(onMembers)}>Members</ActionSheetItem>}
      {onThreads && <ActionSheetItem icon={<MessageSquare />} onSelect={run(onThreads)}>Threads</ActionSheetItem>}
      {/* Leaving the channel screen unmounts this sheet, which drops its history layer. */}
      <ActionSheetItem icon={<Bell />} onSelect={() => navigate("/you/notifications")}>
        <span className="flex min-w-0 flex-1 flex-col">
          Notifications
          <span className="text-xs text-muted-foreground">Uses your device setting</span>
        </span>
      </ActionSheetItem>
      {onSettings && <ActionSheetItem icon={<Settings />} onSelect={run(onSettings)}>Channel settings</ActionSheetItem>}
    </ActionSheet>
  );
}
