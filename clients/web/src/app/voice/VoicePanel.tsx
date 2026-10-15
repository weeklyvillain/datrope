import { Perm, hasPerm } from "@datrope/core";
import { HeadphoneOff, Headphones, Mic, MicOff, PhoneOff, ScreenShare, ScreenShareOff, Video, VideoOff } from "lucide-react";
import { useRef, useState, type ComponentProps } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { keyLabel, shortcutKeys, type ShortcutId } from "@/lib/shortcuts";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { canShareScreen } from "@/lib/media-support";
import { cn } from "@/lib/utils";
import { dmName, useApp, usePerms } from "../../session";
import { ConnectionQuality } from "./ConnectionQuality";
import { GoLiveDialog } from "./GoLiveDialog";
import { SoundboardButton } from "./SoundboardPanel";
import { StreamMenuContent } from "./StreamMenu";
import { isAFKChannel, liveAFKId } from "../../voice/afk";
import { nativeScreenAvailable } from "../../voice/native-screen";
import { streamPrefs } from "../../voice/stream-prefs";
import { useVoice, voice } from "../../voice/voice";

const STATUS = { connecting: "Connecting…", connected: "Voice connected", reconnecting: "Reconnecting…" } as const;

/** Voice status and controls at the bottom of the sidebar, while in a call (or after it failed). */
export function VoicePanel() {
  const v = useVoice(useShallow((x) => ({ channelId: x.channelId, status: x.status, error: x.error, retry: x.retry, notice: x.notice })));
  const ch = useApp((s) => (v.channelId ? s.channels[v.channelId] : undefined));
  const me = useApp((s) => s.me);
  if (v.status === "idle" && !v.error) return null;

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
                {v.status === "reconnecting" && v.retry ? `Disconnected · reconnecting… (attempt ${v.retry})` : STATUS[v.status]}
              </p>
              <Link to={href} aria-label={`Go to ${where}`} className="block truncate text-xs text-muted-foreground">{where}</Link>
              {v.notice && <p className="text-xs text-muted-foreground" role="status">{v.notice}</p>}
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
          <div className={cn("grid gap-1.5", canShareScreen() && "grid-cols-2")}>
            <CameraControl />
            {canShareScreen() && <ShareScreenControl />}
          </div>
          <SoundboardButton labelled side="top" />
        </>
      )}
    </section>
  );
}

type ControlStyle = Pick<ComponentProps<typeof Toggle>, "className" | "variant" | "size">;

/** My microphone. In a call, muting follows the channel's SPEAK permission and server mute; outside one it is a saved choice. */
/** Whether a channel is its server's AFK channel (while that is set and exists). Nobody talks or shares there. */
const useIsAFK = (channelId: string | undefined) =>
  useApp((s) => isAFKChannel(liveAFKId(s.server?.server.afk_channel_id ?? undefined, s.channels), channelId));

const AFK_NO_SHARE = "Nobody can share in the AFK channel";

export function MuteControl(style: ControlStyle) {
  const v = useVoice(useShallow((x) => ({ channelId: x.channelId, status: x.status, muted: x.muted })));
  const serverMuted = useApp((s) => !!(s.me && s.voice[s.me.id]?.server_mute));
  const afk = useIsAFK(v.channelId);
  const inVoice = v.status !== "idle" && !!v.channelId;
  const perms = usePerms(inVoice ? v.channelId : undefined);
  const canSpeak = !inVoice || (hasPerm(perms, Perm.Speak) && !serverMuted && !afk);
  return (
    <Control label="Mute" shortcut="mute" tip={serverMuted && inVoice ? "Muted by a moderator" : afk && inVoice ? "Nobody can talk in the AFK channel" : v.muted ? "Unmute" : "Mute"} {...style}
      pressed={v.muted || !canSpeak} disabled={!canSpeak} onPressedChange={(on) => void voice.setMuted(on)}>
      {v.muted || !canSpeak ? <MicOff className="text-destructive" /> : <Mic />}
    </Control>
  );
}

export function DeafenControl(style: ControlStyle) {
  const deafened = useVoice((x) => x.deafened);
  return (
    <Control label="Deafen" shortcut="deafen" tip={deafened ? "Undeafen" : "Deafen"} {...style} pressed={deafened}
      onPressedChange={(on) => void voice.setDeafened(on)}>
      {deafened ? <HeadphoneOff className="text-destructive" /> : <Headphones />}
    </Control>
  );
}

export function CameraControl({ variant = "outline", size = "sm", ...style }: ControlStyle) {
  const v = useVoice(useShallow((x) => ({ channelId: x.channelId, camera: x.camera })));
  const afk = useIsAFK(v.channelId);
  const canStream = hasPerm(usePerms(v.channelId), Perm.Stream) && !afk;
  return (
    <Control label="Camera" tip={afk ? AFK_NO_SHARE : v.camera ? "Turn camera off" : "Turn camera on"} variant={variant} size={size} {...style}
      pressed={v.camera} disabled={!canStream} onPressedChange={() => void voice.toggleCamera()}>
      {v.camera ? <Video /> : <VideoOff />}
    </Control>
  );
}

/** Go Live when not sharing; the stream settings menu while sharing. */
export function ShareScreenControl({ variant = "outline", size = "sm", ...style }: ControlStyle) {
  const v = useVoice(useShallow((x) => ({ channelId: x.channelId, status: x.status, screen: x.screen })));
  const afk = useIsAFK(v.channelId);
  const canStream = hasPerm(usePerms(v.channelId), Perm.Stream) && !afk;
  const [goLive, setGoLive] = useState(false);
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  if (menu && !v.screen) setMenu(false); // stopped elsewhere (browser bar, tile menu): don't reopen on the next Go Live
  if (goLive && v.status === "idle") setGoLive(false); // the call ended under the dialog: don't pop it up on the next join
  return (
    <>
      <Popover open={menu && v.screen} onOpenChange={setMenu}>
        <PopoverAnchor asChild>
          <div ref={anchor} className="flex">
            <Control label="Share screen" tip={afk ? AFK_NO_SHARE : v.screen ? "Stream settings" : "Share your screen"} variant={variant} size={size} {...style}
              pressed={v.screen} aria-haspopup="dialog" aria-expanded={v.screen ? menu : goLive}
              disabled={!canStream} onPressedChange={() => {
                if (v.screen) setMenu((m) => !m);
                // The desktop app's picker chooses the quality along with the source.
                else if (nativeScreenAvailable()) void voice.startScreen(streamPrefs.getState());
                else setGoLive(true);
              }}>
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
      {goLive && <GoLiveDialog onClose={() => setGoLive(false)} />}
    </>
  );
}

/** A toggle button with a tooltip. `label` is its accessible name; `tip` says what clicking does. */
export function Control({ label, tip, shortcut, className, ...props }: ComponentProps<typeof Toggle> & { label: string; tip: string; shortcut?: ShortcutId }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex">
          <Toggle aria-label={label} variant="outline" size="sm" className={cn("w-full", className)} {...props} />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {tip}
        {shortcut && <KbdGroup className="ml-2">{shortcutKeys(shortcut).map((k) => <Kbd key={k}>{keyLabel(k)}</Kbd>)}</KbdGroup>}
      </TooltipContent>
    </Tooltip>
  );
}
