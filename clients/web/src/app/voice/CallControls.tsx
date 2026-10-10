import { PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { voice } from "../../voice/voice";
import { SoundboardButton } from "./SoundboardPanel";
import { CameraControl, DeafenControl, MuteControl, ShareScreenControl } from "./VoicePanel";

const round = "size-12 rounded-full border bg-muted text-foreground hover:bg-secondary hover:text-foreground [&_svg:not([class*='size-'])]:size-5";
const toggle = `${round} data-[state=on]:bg-foreground data-[state=on]:text-background`;

/** The call's controls, centred under the tiles while I'm in it. */
export function CallControls() {
  return (
    <div role="toolbar" aria-label="Call controls" className="flex flex-wrap items-center justify-center gap-3 px-4 pb-4">
      <MuteControl variant="outline" className={toggle} />
      <DeafenControl variant="outline" className={toggle} />
      <CameraControl className={toggle} />
      <ShareScreenControl className={toggle} />
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
