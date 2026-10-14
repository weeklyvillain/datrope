import { Perm, hasPerm } from "@datrope/core";
import { Ellipsis, LayoutGrid, Monitor, PhoneOff, ScreenShare, ScreenShareOff, Volume2 } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ActionSheet, ActionSheetItem } from "@/components/action-sheet";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { canShareScreen } from "@/lib/media-support";
import { usePerms } from "../../session";
import { useVoice, voice } from "../../voice/voice";
import { HoldToTalk } from "../mobile/HoldToTalk";
import { GoLiveDialog } from "./GoLiveDialog";
import { SoundboardButton, SoundboardSheet, useSoundboardAccess } from "./SoundboardPanel";
import { CameraControl, DeafenControl, MuteControl, ShareScreenControl } from "./VoicePanel";
import type { VoiceLayout } from "./VoiceStage";

const round = "size-12 rounded-full border bg-muted text-foreground hover:bg-secondary hover:text-foreground [&_svg:not([class*='size-'])]:size-5";
const toggle = `${round} data-[state=on]:bg-foreground data-[state=on]:text-background`;

/** The call's grid/stage switch, for the phone's ⋯ menu (desktop has it in the top bar). */
export type LayoutControl = { layout: VoiceLayout; canStage: boolean; toggle: () => void };

/** The call's controls, centred under the tiles while I'm in it. */
export function CallControls({ layout }: { layout?: LayoutControl }) {
  const phone = useIsMobile();
  if (phone) return <PhoneCallControls layout={layout} />;
  return (
    <div role="toolbar" aria-label="Call controls" className="flex flex-wrap items-center justify-center gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <MuteControl variant="outline" className={toggle} />
      <DeafenControl variant="outline" className={toggle} />
      <CameraControl className={toggle} />
      {canShareScreen() && <ShareScreenControl className={toggle} />}
      <SoundboardButton side="top" className={round} />
      <span className="h-7 w-px bg-border" aria-hidden />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="destructive" aria-label="Disconnect" className="h-12 w-16 rounded-full [&_svg:not([class*='size-'])]:size-5"
            onClick={() => voice.leave()}><PhoneOff /></Button>
        </TooltipTrigger>
        <TooltipContent>Leave voice</TooltipContent>
      </Tooltip>
    </div>
  );
}

const phoneRound = "size-[48px] flex-none rounded-full border bg-muted text-foreground hover:bg-secondary hover:text-foreground [&_svg:not([class*='size-'])]:size-5";
const phoneToggle = `${phoneRound} data-[state=on]:bg-foreground data-[state=on]:text-background`;

/** Phones: one row of 48 px buttons (and hold to talk); the less common controls (soundboard, screen share, layout) under ⋯. */
function PhoneCallControls({ layout }: { layout?: LayoutControl }) {
  const v = useVoice(useShallow((x) => ({ channelId: x.channelId, screen: x.screen })));
  const canStream = hasPerm(usePerms(v.channelId), Perm.Stream);
  const soundboard = useSoundboardAccess();
  const [more, setMore] = useState(false);
  const [sounds, setSounds] = useState(false);
  const [goLive, setGoLive] = useState(false);
  const pick = (run: () => void) => () => {
    setMore(false);
    run();
  };
  return (
    <div role="toolbar" aria-label="Call controls" className="flex flex-nowrap items-center justify-center gap-2 px-2 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <MuteControl variant="outline" className={phoneToggle} />
      <DeafenControl variant="outline" className={phoneToggle} />
      <CameraControl className={phoneToggle} />
      <HoldToTalk />
      <Button variant="ghost" size="icon" aria-label="More call controls" className={phoneRound} onClick={() => setMore(true)}><Ellipsis /></Button>
      <Button variant="destructive" size="icon" aria-label="Disconnect" className="size-[48px] flex-none rounded-full [&_svg:not([class*='size-'])]:size-5"
        onClick={() => voice.leave()}><PhoneOff /></Button>
      <ActionSheet open={more} onOpenChange={setMore} title="More call controls">
        <ActionSheetItem icon={<Volume2 />} disabled={!!soundboard.reason} onSelect={pick(() => setSounds(true))}>
          {soundboard.reason ? `Soundboard: ${soundboard.reason}` : "Soundboard"}
        </ActionSheetItem>
        {canShareScreen() && (
          <ActionSheetItem icon={v.screen ? <ScreenShareOff /> : <ScreenShare />} disabled={!canStream}
            onSelect={pick(() => (v.screen ? void voice.stopScreen() : setGoLive(true)))}>
            {v.screen ? "Stop sharing" : "Share screen"}
          </ActionSheetItem>
        )}
        {layout && (
          <ActionSheetItem icon={layout.layout === "grid" ? <Monitor /> : <LayoutGrid />} disabled={!layout.canStage} onSelect={pick(layout.toggle)}>
            {!layout.canStage ? "Grid layout (stage needs a watched screen share)" : layout.layout === "grid" ? "Stage layout" : "Grid layout"}
          </ActionSheetItem>
        )}
      </ActionSheet>
      <SoundboardSheet open={sounds} onOpenChange={setSounds} />
      {goLive && <GoLiveDialog onClose={() => setGoLive(false)} />}
    </div>
  );
}
