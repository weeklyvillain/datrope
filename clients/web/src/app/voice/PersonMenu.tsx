import { EyeOff, MoreHorizontal, Volume1, VolumeX } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { isAdjusted, setHideVideo, setMutedForMe, setVolume, useVoicePrefs } from "../../voice/prefs";

/**
 * Wraps a person's tile or row: right-click, or the "More" button, opens their volume, "Mute for me" and
 * "Hide video" — settings that stay on this device. Don't use it for yourself.
 */
export function PersonMenu({ userId, name, hasCamera, className, moreClassName, children }: {
  userId: string;
  name: string;
  hasCamera: boolean;
  className?: string;
  moreClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className={cn("group/person relative", className)} onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}>
          {children}
          <PopoverTrigger asChild>
            <RefButton variant="ghost" size="icon-xs" aria-label={`More options for ${name}`}
              className={cn("opacity-0 focus-visible:opacity-100 group-hover/person:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100", moreClassName)}>
              <MoreHorizontal />
            </RefButton>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent align="end" className="w-64 p-2" aria-label={name}>
        <PersonSettings userId={userId} name={name} hasCamera={hasCamera} />
      </PopoverContent>
    </Popover>
  );
}

function PersonSettings({ userId, name, hasCamera }: { userId: string; name: string; hasCamera: boolean }) {
  const volume = useVoicePrefs((p) => p.volume[userId] ?? 100);
  const muted = useVoicePrefs((p) => !!p.mutedForMe[userId]);
  const hidden = useVoicePrefs((p) => !!p.hideVideo[userId]);
  const adjusted = useVoicePrefs((p) => isAdjusted(p, userId));
  const muteId = useId();
  const hideId = useId();
  return (
    <div className="grid gap-1">
      <div className="grid gap-2 px-2.5 pb-2.5 pt-1.5">
        <div className="flex items-center justify-between">
          <span className="font-semibold">{name}'s volume</span>
          <span className="text-sm tabular-nums text-muted-foreground">{volume}%</span>
        </div>
        <Slider min={0} max={200} step={5} value={[volume]} aria-label={`Volume for ${name}, just for you`}
            onValueChange={([x]) => setVolume(userId, x)} />
        <span className="text-xs text-muted-foreground">Only you hear this change.</span>
      </div>
      <Separator />
      <div className="flex items-center justify-between rounded-md px-2.5 py-2">
        <Label htmlFor={muteId} className="font-normal"><VolumeX className="size-4" /> Mute for me</Label>
        <Switch id={muteId} checked={muted} onCheckedChange={(on) => setMutedForMe(userId, on)} />
      </div>
      {hasCamera && (
        <div className="flex items-center justify-between rounded-md px-2.5 py-2">
          <Label htmlFor={hideId} className="font-normal"><EyeOff className="size-4" /> Hide video</Label>
          <Switch id={hideId} checked={hidden} onCheckedChange={(on) => setHideVideo(userId, on)} />
        </div>
      )}
      {adjusted && (
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => {
          setVolume(userId, 100);
          setMutedForMe(userId, false);
          setHideVideo(userId, false);
        }}>Reset</Button>
      )}
    </div>
  );
}

/** The small badge on a tile or row when I changed this person's volume or muted them for me. */
export function AdjustedBadge({ userId, className }: { userId: string; className?: string }) {
  const muted = useVoicePrefs((p) => !!p.mutedForMe[userId]);
  const adjusted = useVoicePrefs((p) => isAdjusted(p, userId));
  if (!adjusted) return null;
  const Icon = muted ? VolumeX : Volume1;
  return <Icon className={cn("size-3.5", className)} role="img" aria-label={muted ? "Muted for you" : "Volume changed"} />;
}
