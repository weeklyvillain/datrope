import type { EmbedField, WebhookEmbed } from "@datrope/core";
import { Markdown } from "@/chat/Markdown";
import { cn } from "@/lib/utils";
import { client } from "@/session";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Rows of fields: up to three inline fields share a row; a field that is not inline has a row of its own. */
export function fieldRows(fields: EmbedField[]): EmbedField[][] {
  const rows: EmbedField[][] = [];
  for (const field of fields) {
    const last = rows.at(-1);
    if (field.inline && last && last.length < 3 && last.every((x) => x.inline)) last.push(field);
    else rows.push([field]);
  }
  return rows;
}

/** The embed's accent colour as CSS, or undefined for the default border colour. */
export function embedColor(color: number | undefined): string | undefined {
  return color === undefined ? undefined : `#${color.toString(16).padStart(6, "0")}`;
}

/** The rich embeds a webhook posted with a message (not the link preview). */
export function WebhookEmbeds({ embeds }: { embeds: WebhookEmbed[] }) {
  return (
    <div className="mt-1.5 grid gap-1.5">
      {embeds.map((e, i) => <WebhookEmbedCard key={i} embed={e} />)}
    </div>
  );
}

/** One embed, Discord-style: author, title, description, fields, thumbnail, image and footer. Only the accent is not a token. */
export function WebhookEmbedCard({ embed: e }: { embed: WebhookEmbed }) {
  const accent = embedColor(e.color);
  const rows = fieldRows(e.fields ?? []);
  return (
    <div className="grid max-w-[520px] grid-cols-[4px_minmax(0,1fr)] overflow-hidden rounded-lg border bg-card">
      <span className={cn(!accent && "bg-border")} style={accent ? { background: accent } : undefined} />
      <div className={cn("grid px-3 py-2.5", e.thumbnail && "grid-cols-[minmax(0,1fr)_auto] gap-x-4")}>
        <div className="grid min-w-0 content-start gap-1">
          {e.author && (
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              {e.author.icon_url && <img src={client.url(e.author.icon_url)} alt="" className="size-6 flex-none rounded-full" />}
              {e.author.url
                ? <a href={e.author.url} target="_blank" rel="noopener noreferrer" className="truncate text-foreground">{e.author.name}</a>
                : <span className="truncate">{e.author.name}</span>}
            </div>
          )}
          {e.title && (e.url
            ? <a href={e.url} target="_blank" rel="noopener noreferrer" className="font-semibold wrap-anywhere">{e.title}</a>
            : <span className="font-semibold wrap-anywhere">{e.title}</span>)}
          {e.description && <div className="text-sm wrap-anywhere"><Markdown text={e.description} mentions={[]} /></div>}
          {rows.map((row, i) => (
            <div key={i} className="mt-1 grid gap-x-4 gap-y-1" style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}>
              {row.map((field, j) => (
                <div key={j} className="min-w-0 text-sm">
                  <div className="font-semibold wrap-anywhere">{field.name}</div>
                  <div className="wrap-anywhere"><Markdown text={field.value} mentions={[]} /></div>
                </div>
              ))}
            </div>
          ))}
        </div>
        {e.thumbnail && <img src={client.url(e.thumbnail.url)} alt="" loading="lazy" className="size-20 rounded-md object-cover" />}
        {e.image && <img src={client.url(e.image.url)} alt="" loading="lazy" className="col-span-full mt-2 max-h-[300px] max-w-full rounded-md object-contain" />}
        {(e.footer || e.timestamp) && (
          <div className="col-span-full mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            {e.footer?.icon_url && <img src={client.url(e.footer.icon_url)} alt="" className="size-5 rounded-full" />}
            {e.footer?.text && <span className="wrap-anywhere">{e.footer.text}</span>}
            {e.footer?.text && e.timestamp && <span aria-hidden>•</span>}
            {e.timestamp && <time dateTime={e.timestamp}>{when.format(new Date(e.timestamp))}</time>}
          </div>
        )}
      </div>
    </div>
  );
}
