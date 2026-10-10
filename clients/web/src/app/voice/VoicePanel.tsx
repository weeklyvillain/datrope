import { Perm, hasPerm } from "@datrope/core";
import { PhoneOff, ScreenShare, ScreenShareOff, Video, VideoOff } from "lucide-react";
import type { ComponentProps } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { dmName, useApp, usePerms } from "../../session";
import { ConnectionQuality } from "./ConnectionQuality";
import { SoundboardButton } from "./SoundboardPanel";
import { useVoice, voice } from "../../voice/voice";

const STATUS = { connecting: "Connecting…", connected: "Voice connected", reconnecting: "Reconnecting…" } as const;

/** Voice status and controls at the bottom of the sidebar, while in a call (or after it failed). */
export function VoicePanel() {
  const v = useVoice(useShallow((x) => ({
    channelId: x.channelId, status: x.status, error: x.error, camera: x.camera, screen: x.screen,
  })));
  const ch = useApp((s) => (v.channelId ? s.channels[v.channelId] : undefined));
  const me = useApp((s) => s.me);
  const perms = usePerms(v.channelId);
  if (v.status === "idle" && !v.error) return null;

  const canStream = hasPerm(perms, Perm.Stream);
  const where = !ch ? "" : ch.type === "dm" ? dmName(ch, me?.id) : ch.name;
  const href = !ch ? "/" : ch.type === "dm" ? `/messages/${ch.id}` : `/channels/${ch.id}`;
  return (
    <section className="grid gap-2 border-t bg-card px-3 py-2.5" aria-label="Voice">
      {v.status === "idle" ? (
        <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <span className="flex-1">{v.error}</span>
          <Button variant="ghost" size="xs" onClick={() => voice.dismiss()}>Dismiss</Button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-semibold", v.status === "connected" ? "text-online" : "text-idle")} role="status">
                {STATUS[v.status]}
              </p>
              <Link to={href} aria-label={`Go to ${where}`} className="block truncate text-xs text-muted-foreground">{where}</Link>
            </div>
            {v.status === "connected" && <ConnectionQuality />}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Disconnect" className="text-destructive hover:text-destructive"
                  onClick={() => voice.leave()}><PhoneOff /></Button>
              </TooltipTrigger>
              <TooltipContent>Leave voice</TooltipContent>
            </Tooltip>
          </div>
          {v.error && <p className="text-xs text-destructive" role="alert">{v.error}</p>}
          <div className="grid grid-cols-2 gap-1.5">
            <Control label="Camera" tip={v.camera ? "Turn camera off" : "Turn camera on"} pressed={v.camera} disabled={!canStream}
              onPressedChange={() => void voice.toggleCamera()}>
              {v.camera ? <Video /> : <VideoOff />}
            </Control>
            <Control label="Share screen" tip={v.screen ? "Stop sharing" : "Share your screen"} pressed={v.screen} disabled={!canStream}
              onPressedChange={() => void voice.toggleScreen()}>
              {v.screen ? <ScreenShareOff /> : <ScreenShare />}
            </Control>
          </div>
          <SoundboardButton labelled side="top" />
        </>
      )}
    </section>
  );
}

/** A toggle button with a tooltip. `label` is its accessible name; `tip` says what clicking does. */
export function Control({ label, tip, className, ...props }: ComponentProps<typeof Toggle> & { label: string; tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex">
          <Toggle aria-label={label} variant="outline" size="sm" className={cn("w-full", className)} {...props} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
