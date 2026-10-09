import type { Embed } from "@datrope/core";

/** The text preview card of a message's first link. */
export function LinkPreview({ embed }: { embed: Embed }) {
  return (
    <div className="mt-1.5 grid max-w-[460px] grid-cols-[4px_minmax(0,1fr)] overflow-hidden rounded-lg border bg-card">
      <span className="bg-muted" />
      <div className="grid gap-0.5 px-3 py-2.5">
        {embed.site && <span className="text-xs text-muted-foreground">{embed.site}</span>}
        <a href={embed.url} target="_blank" rel="noopener noreferrer" className="font-semibold wrap-anywhere">{embed.title || embed.url}</a>
        {embed.description && <p className="m-0 line-clamp-3 text-sm text-muted-foreground">{embed.description}</p>}
      </div>
    </div>
  );
}
