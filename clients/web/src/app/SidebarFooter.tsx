import { isGated } from "@datrope/core";
import { useApp } from "../session";
import { ProfileStrip } from "./ProfileStrip";
import { VoicePanel } from "./voice/VoicePanel";

/** The bottom of the sidebar, on the card surface: the voice panel (while in a call) and the profile strip. */
export function SidebarFooter() {
  const gated = useApp(isGated);
  return (
    <div className="flex-none">
      {!gated && <VoicePanel />}
      <ProfileStrip />
    </div>
  );
}
