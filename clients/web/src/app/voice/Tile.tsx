import { Eye, EyeOff, HeadphoneOff, MicOff, Settings2 } from "@/components/icons";
import { useState, type ReactNode, type Ref } from "react";
import { UserAvatar, type AvatarSize } from "@/components/user-avatar";
import { useUser } from "@/hooks/use-user";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useApp, userName } from "../../session";
import { useVoicePrefs } from "../../voice/prefs";
import { voice, type VideoTile } from "../../voice/voice";
import { AvatarTrigger } from "../people/AvatarTrigger";
import { AdjustedBadge, PersonMenu } from "./PersonMenu";
import { StreamMenuContent } from "./StreamMenu";
import { TrackVideo } from "./TrackVideo";

export type TileSize = "large" | "strip" | "grid";

const box: Record<TileSize, string> = {
  large: "size-full min-h-0",
  strip: "h-full aspect-video shrink-0",
  grid: "aspect-video",
};
const avatar: Record<TileSize, AvatarSize> = { large: "xl", strip: "lg", grid: "xl" };

/**
 * One person's tile: their camera, or their avatar when the camera is off or hidden; or a screen share (with a
 * "Watch" prompt until I watch it). `chip` is a corner slot; `children` are overlays (stage controls).
 */
export function Tile({ userId, tile, size, speaking = false, watching = false, chip, rootRef, children }: {
  userId: string;
  tile?: VideoTile;
  size: TileSize;
  speaking?: boolean;
  watching?: boolean; // I'm watching this person's screen share
  chip?: ReactNode;
  rootRef?: Ref<HTMLDivElement>;
  children?: ReactNode;
}) {
  const name = useApp((s) => userName(s, userId));
  const person = useUser(userId);
  const me = useApp((s) => s.me?.id === userId);
  const state = useApp((s) => s.voice[userId]);
  const hidden = useVoicePrefs((p) => !!state?.camera && !tile?.local && !!p.hideVideo[userId]);
  const hideSet = useVoicePrefs((p) => !!p.hideVideo[userId]);
  const screen = tile?.source === "screen";
  const prompt = screen && !tile.local && !tile.track && !watching;
  const wrapped = !screen && !me; // camera and avatar tiles have a person menu

  const card = (
    <div ref={rootRef} className={cn(
      "relative grid select-none place-items-center overflow-hidden rounded-xl border bg-card",
      wrapped ? "size-full" : box[size],
      speaking && !screen && "border-transparent ring-3 ring-primary",
    )}>
      {tile?.track ? (
        <TrackVideo track={tile.track} mirror={tile.local && tile.source === "camera"} />
      ) : prompt ? (
        <div className="grid justify-items-center gap-2 px-2 text-center">
          <p className={cn("text-sm", size === "strip" && "text-xs")}>{name} is sharing their screen</p>
          <Button variant="outline" size="sm" onClick={() => voice.watch(userId, true)}><Eye /> Watch</Button>
        </div>
      ) : screen ? (
        <p className="text-sm text-muted-foreground">Loading {name}'s screen...</p>
      ) : (
        <div className="grid justify-items-center gap-1">
          <AvatarTrigger userId={userId} name={name}>
            <UserAvatar user={person ?? { id: userId, username: name }} size={avatar[size]} />
          </AvatarTrigger>
          {hidden && size !== "strip" && <p className="text-sm text-muted-foreground">Video hidden</p>}
        </div>
      )}
      {!prompt && (
        <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded bg-background/80 px-2 py-0.5 text-xs">
          {!screen && tile?.track ? (
            <AvatarTrigger userId={userId} name={name} className="min-w-0 truncate rounded-sm hover:underline">{me ? `${name} (you)` : name}</AvatarTrigger>
          ) : (
            <span className="truncate">{screen ? `${name}'s screen` : me ? `${name} (you)` : name}</span>
          )}
          {!screen && (state?.self_mute || state?.server_mute) && (
            <MicOff className={cn("size-3.5 flex-none", state.server_mute && "text-destructive")} role="img"
              aria-label={state.server_mute ? "Muted by a moderator" : "Muted"} />
          )}
          {!screen && state?.self_deaf && <HeadphoneOff className="size-3.5 flex-none" role="img" aria-label="Deafened" />}
          {!screen && !me && <AdjustedBadge userId={userId} className="flex-none" />}
        </span>
      )}
      {screen && !tile.local && watching && size !== "large" && (
        <Button className="absolute right-2 top-2" variant="secondary" size="xs" onClick={() => voice.watch(userId, false)}>
          <EyeOff /> Stop watching
        </Button>
      )}
      {screen && tile.local && <MyStreamButton />}
      {chip && <div className="absolute left-2 top-2 empty:hidden">{chip}</div>}
      {children}
    </div>
  );
  if (!wrapped) return card;
  return (
    <PersonMenu userId={userId} name={name} hasCamera={!!state?.camera || hideSet} className={box[size]} moreClassName="absolute right-2 top-2 bg-background/80">
      {card}
    </PersonMenu>
  );
}

/** Stream settings on my own screen tile. */
function MyStreamButton() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <RefButton className="absolute right-2 top-2" variant="secondary" size="icon-sm" aria-label="Stream settings">
          <Settings2 />
        </RefButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72"><StreamMenuContent onDone={() => setOpen(false)} /></PopoverContent>
    </Popover>
  );
}
