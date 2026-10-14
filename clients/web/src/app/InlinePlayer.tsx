import type { Embed } from "@datrope/core";
import { Play, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { BrandIcon } from "@/lib/brand-icons";
import type { Player } from "@/lib/players";
import { cn } from "@/lib/utils";
import { BareButton } from "@/components/bare-button";

/**
 * A YouTube, Twitch or Spotify link as a player. The player loads only once someone presses play;
 * before that, only a YouTube link loads anything from the site (its thumbnail).
 */
export function InlinePlayer({ player, url, embed }: { player: Player; url: string; embed?: Embed }) {
  const [playing, setPlaying] = useState(false);
  const name = embed?.title || url;
  const shape = player.shape === "vertical" ? "aspect-[9/16] w-[min(100%,280px)]" : "aspect-video w-full";
  if (!playing && player.thumbnail) {
    return (
      <div className="mt-1.5 grid max-w-[460px] gap-2 rounded-lg border bg-card p-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <BrandIcon slug={player.icon} className="size-3.5 flex-none" />{player.site}
          </span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 font-semibold wrap-anywhere">{name}</a>
          {embed?.author && <span className="truncate text-sm text-muted-foreground">{embed.author}</span>}
        </div>
        <BareButton aria-label={`Play ${player.label} from ${player.site}`} onClick={() => setPlaying(true)}
          className={cn("group relative overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring", shape)}>
          <img src={player.thumbnail} alt="" loading="lazy" className="size-full object-cover" />
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-12 place-items-center rounded-full bg-background/80 text-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
              <Play className="size-5 fill-current" />
            </span>
          </span>
        </BareButton>
      </div>
    );
  }
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
      player.shape === "vertical" ? shape : fixed ? "w-full max-w-[460px]" : `${shape} max-w-[560px]`)}
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
