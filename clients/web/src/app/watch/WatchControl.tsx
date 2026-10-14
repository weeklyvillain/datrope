import { Tv } from "lucide-react";
import { useState } from "react";
import { useApp } from "../../session";
import { useVoice } from "../../voice/voice";
import { Control } from "../voice/VoicePanel";
import { WatchDialog } from "./WatchDialog";

/** The call control that starts a video for everyone in my voice channel, or changes what is on. */
export function WatchControl({ className }: { className?: string }) {
  const channelId = useVoice((v) => (v.status === "idle" ? undefined : v.channelId ?? undefined));
  const voiceChannel = useApp((s) => !!channelId && s.channels[channelId]?.type === "voice");
  const current = useApp((s) => (channelId ? s.watch[channelId] ?? null : null));
  const [open, setOpen] = useState(false);
  if (!channelId || !voiceChannel) return null; // DM calls have no watch-together
  return (
    <>
      <Control label="Watch together" tip={current ? "Change what everyone watches" : "Watch together"} className={className}
        pressed={!!current} onPressedChange={() => setOpen(true)}>
        <Tv />
      </Control>
      {open && <WatchDialog channelId={channelId} initialUrl={current?.url} onClose={() => setOpen(false)} />}
    </>
  );
}
