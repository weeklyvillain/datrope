import { Play, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { BrandIcon } from "@/lib/brand-icons";
import type { Player } from "@/lib/players";
import { cn } from "@/lib/utils";

/**
 * A YouTube, Twitch or Spotify link as a player. Nothing loads from the site until someone presses
 * play, so just reading a message never reaches it.
 */
export function InlinePlayer({ player, url, title }: { player: Player; url: string; title?: string }) {
  const [playing, setPlaying] = useState(false);
  const name = title || url;
  if (!playing) {
    return (
      <div className="mt-1.5 flex max-w-[460px] items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
        <BrandIcon slug={player.icon} className="size-6 flex-none text-muted-foreground" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-xs text-muted-foreground">{player.site}</span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="truncate font-semibold">{name}</a>
        </div>
        <Button size="sm" variant="secondary" aria-label={`Play ${player.label} from ${player.site}`} onClick={() => setPlaying(true)}>
          <Play />Play
        </Button>
      </div>
    );
  }
  const fixed = typeof player.shape === "number";
  return (
    <div className={cn("relative mt-1.5 overflow-hidden rounded-lg border bg-card",
      player.shape === "vertical" ? "aspect-[9/16] w-[min(100%,280px)]" : fixed ? "w-full max-w-[460px]" : "aspect-video w-full max-w-[560px]")}
      style={fixed ? { height: player.shape as number } : undefined}>
      <iframe src={player.src} title={`${player.site}: ${name}`} className="size-full border-0"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write" allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox" />
      <Button size="icon-xs" variant="secondary" aria-label="Close player" className="absolute right-1.5 top-1.5 opacity-80 hover:opacity-100"
        onClick={() => setPlaying(false)}><X /></Button>
    </div>
  );
}
