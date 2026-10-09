import { Perm, hasPerm, myChannelPerms, type State } from "@datrope/core";
import { BookOpen, Hash, Volume2 } from "lucide-react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { Spoiler } from "@/chat/Markdown";
import { remarkChat, type ChatOptions } from "@/chat/remarkChat";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useApp } from "@/session";
import { parseChannelCards, type WelcomeBlock } from "./channelCards";

/** True for relative URLs and absolute ones on this origin (uploaded page images live under /api/server/images/). */
function sameOrigin(src: string | undefined): boolean {
  if (!src) return false;
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** react-markdown passes the syntax-tree node as a prop; keep it off the DOM element. */
function domProps<P extends ExtraProps>(p: P): Omit<P, "node"> {
  const q = { ...p };
  delete q.node;
  return q;
}

// ||Spoilers|| only: with no emoji or users to look up, :shortcodes: and @names stay text.
const SPOILERS: ChatOptions = { custom: new Map(), shortcodes: null, users: new Map() };

// Token-styled Markdown elements. No raw HTML: react-markdown escapes it unless rehype-raw is added.
const components: Components = {
  h1: (p) => <h1 {...domProps(p)} className="mt-6 mb-2 text-2xl font-bold first:mt-0" />,
  h2: (p) => <h2 {...domProps(p)} className="mt-6 mb-2 text-xl font-semibold first:mt-0" />,
  h3: (p) => <h3 {...domProps(p)} className="mt-5 mb-2 text-lg font-semibold first:mt-0" />,
  h4: (p) => <h4 {...domProps(p)} className="mt-4 mb-1 font-semibold first:mt-0" />,
  p: (p) => <p {...domProps(p)} className="my-3 max-w-[68ch]" />,
  a: (p) => <a {...domProps(p)} className="text-primary hover:underline" target="_blank" rel="noreferrer" />,
  ul: (p) => <ul {...domProps(p)} className="my-3 list-disc space-y-1 pl-6 marker:text-muted-foreground" />,
  ol: (p) => <ol {...domProps(p)} className="my-3 list-decimal space-y-1 pl-6 marker:text-muted-foreground" />,
  blockquote: (p) => <blockquote {...domProps(p)} className="my-3 border-l-4 border-border pl-4 text-muted-foreground" />,
  hr: () => <hr className="my-6 border-border" />,
  pre: (p) => <pre {...domProps(p)} className="my-3 overflow-x-auto rounded-md border bg-muted p-3 text-sm [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0" />,
  code: (p) => <code {...domProps(p)} className={cn("rounded border bg-muted px-1 py-px font-mono text-[0.9em]", p.className)} />,
  table: (p) => <div className="my-3 overflow-x-auto"><table {...domProps(p)} className="w-full border-collapse text-sm" /></div>,
  th: (p) => <th {...domProps(p)} className="border border-border bg-muted px-3 py-1.5 text-left font-semibold" />,
  td: (p) => <td {...domProps(p)} className="border border-border px-3 py-1.5" />,
  span: ({ className, children, ...p }) =>
    className === "spoiler" ? <Spoiler>{children}</Spoiler> : <span {...domProps(p)} className={className}>{children}</span>,
  img: ({ src, alt, ...p }) =>
    sameOrigin(src) ? <img src={src} alt={alt ?? ""} {...domProps(p)} className="my-2 inline-block max-h-96 max-w-full rounded-md border" /> : null,
};

/** A welcome page: Markdown blocks plus grids of channel cards. In the editor preview the cards don't navigate. */
export function WelcomeMarkdown({ markdown, preview = false }: { markdown: string; preview?: boolean }) {
  const groups: Array<{ kind: "markdown"; text: string } | { kind: "cards"; cards: Extract<WelcomeBlock, { kind: "card" }>[] }> = [];
  for (const b of parseChannelCards(markdown)) {
    const last = groups.at(-1);
    if (b.kind === "markdown") groups.push(b);
    else if (last?.kind === "cards") last.cards.push(b);
    else groups.push({ kind: "cards", cards: [b] });
  }
  return (
    <div className="min-w-0 leading-relaxed text-foreground">
      {groups.map((g, i) =>
        g.kind === "markdown" ? (
          <Markdown key={i} remarkPlugins={[remarkGfm, [remarkChat, SPOILERS]]} components={components}>{g.text}</Markdown>
        ) : (
          <div key={i} className="my-3 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
            {g.cards.map((c, j) => <ChannelCard key={j} name={c.name} description={c.description} preview={preview} />)}
          </div>
        ),
      )}
    </div>
  );
}

const ICONS = { welcome: BookOpen, text: Hash, voice: Volume2, dm: Hash, thread: Hash } as const;

/** The visible server channel with this name, if any. */
function findChannel(s: State, name: string): string | undefined {
  return s.server?.channelIds.find((id) => s.channels[id]?.name === name && hasPerm(myChannelPerms(s, id), Perm.ViewChannel));
}

function ChannelCard({ name, description, preview }: { name: string; description: string; preview: boolean }) {
  const id = useApp((s) => findChannel(s, name));
  const type = useApp((s) => (id ? s.channels[id]?.type : undefined));
  const Icon = type ? ICONS[type] : Hash;
  const body = (
    <Card className={cn("grid h-full grid-cols-[16px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-0.5 rounded-lg p-3 shadow-none",
      !id && "opacity-60", id && !preview && "transition-colors hover:bg-accent")}>
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      <span className="truncate font-semibold">#{name}</span>
      <span className="col-start-2 text-sm text-muted-foreground">{id ? description : "Channel not found"}</span>
    </Card>
  );
  if (!id || preview) return body;
  return <Link to={`/channels/${id}`} className="rounded-lg text-foreground no-underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{body}</Link>;
}
