import { Perm, hasPerm } from "@datrope/core";
import { PhoneOff, ScreenShare, ScreenShareOff, Video, VideoOff } from "lucide-react";
import { useRef, useState, type ComponentProps } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { dmName, useApp, usePerms } from "../../session";
import { ConnectionQuality } from "./ConnectionQuality";
import { GoLiveDialog } from "./GoLiveDialog";
import { SoundboardButton } from "./SoundboardPanel";
import { StreamMenuContent } from "./StreamMenu";
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
  const [goLive, setGoLive] = useState(false);
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  if (menu && !v.screen) setMenu(false); // stopped elsewhere (browser bar, tile menu): don't reopen on the next Go Live
  if (goLive && v.status === "idle") setGoLive(false); // the call ended under the dialog: don't pop it up on the next join
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
            <Popover open={menu && v.screen} onOpenChange={setMenu}>
              <PopoverAnchor asChild>
                <div ref={anchor} className="flex">
                  <Control label="Share screen" tip={v.screen ? "Stream settings" : "Share your screen"} pressed={v.screen}
                    aria-haspopup="dialog" aria-expanded={v.screen ? menu : goLive}
                    disabled={!canStream} onPressedChange={() => (v.screen ? setMenu((m) => !m) : setGoLive(true))}>
                    {v.screen ? <ScreenShareOff /> : <ScreenShare />}
                  </Control>
                </div>
              </PopoverAnchor>
              <PopoverContent side="top" className="w-72"
                // The anchor is the button that toggles the menu: a click on it is not an outside click.
                onInteractOutside={(e) => anchor.current?.contains(e.target as Node) && e.preventDefault()}
                onCloseAutoFocus={(e) => {
                  e.preventDefault(); // no trigger to return to: focus the button instead of the page
                  anchor.current?.querySelector("button")?.focus();
                }}>
                <StreamMenuContent onDone={() => setMenu(false)} />
              </PopoverContent>
            </Popover>
          </div>
          {goLive && <GoLiveDialog onClose={() => setGoLive(false)} />}
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
