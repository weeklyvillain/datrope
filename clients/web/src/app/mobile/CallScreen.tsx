import { MessageSquare, Music, Volume2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { EmojiText } from "@/chat/EmojiText";
import { useHistoryLayer } from "@/hooks/use-history-layer";
import type { LayoutControl } from "../voice/CallControls";
import { VoiceStage } from "../voice/VoiceStage";
import { ScreenHeader } from "./ScreenHeader";

type Side = "chat" | "music" | null;

/** A voice channel on phones: header (back, name, chat, music), the call in two columns, one row of controls.
 *  Chat and music open full-screen over it as a layer: Back closes them. */
export function CallScreen({ channelId, name, canRead, side, onSide, layout, panel }: {
  channelId: string;
  name: string;
  canRead: boolean;
  side: Side;
  onSide: (side: Side) => void;
  layout: LayoutControl;
  panel: ReactNode; // the open side panel (chat, music or search), full-screen on phones
}) {
  useHistoryLayer("call-panel", side !== null, () => onSide(null));
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-background" aria-label={name}>
        <ScreenHeader
          title={<span className="flex min-w-0 items-center gap-1.5"><Volume2 className="size-4 flex-none text-muted-foreground" aria-hidden /><span className="truncate"><EmojiText text={name} /></span></span>}
          actions={(
            <>
              <Button variant="ghost" size="icon" aria-label="Music" aria-pressed={side === "music"} onClick={() => onSide(side === "music" ? null : "music")}><Music /></Button>
              {canRead && (
                <Button variant="ghost" size="icon" aria-label="Channel chat" aria-pressed={side === "chat"} onClick={() => onSide(side === "chat" ? null : "chat")}><MessageSquare /></Button>
              )}
            </>
          )} />
        <VoiceStage channelId={channelId} layout={layout.layout} layoutControl={layout} inviteTo={name} onOpenMusic={() => onSide("music")} />
      </main>
      {panel}
    </>
  );
}
